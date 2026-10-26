import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as socketRequest } from "node:http";
import { Readable } from "node:stream";

const ROUTE = "/v1/chat/completions";
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

export type BoundedGatewayOptions = {
  socketPath: string;
  capability: string;
  providerId: string;
  model: string;
  maxInputBytes: number;
  maxOutputTokens: number;
  maxRequests: number;
  dispatchEnabled?: boolean;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  dispatchToFilter?: TrustedEgressFilterPort;
};

export type FilterRequest = {
  readonly providerId: string;
  readonly route: "/v1/chat/completions";
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
};

/** Typed, fixed-route boundary. The filter owns destination resolution and provider credentials. */
export interface TrustedEgressFilterPort {
  dispatch(request: FilterRequest): Promise<Response>;
}

/** HTTP client for the filter's typed API; URL and route are fixed by trusted configuration. */
export function createTrustedFilterClient(options: {
  readonly host: string;
  readonly port: number;
  readonly capability: string;
  readonly fetcher?: typeof fetch;
}): TrustedEgressFilterPort {
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(options.host) || !Number.isSafeInteger(options.port) ||
      options.port < 1 || options.port > 65_535 || !options.capability) {
    throw new Error("Trusted filter endpoint and per-attempt capability are required.");
  }
  const endpoint = `http://${options.host}:${options.port}/v1/dispatch`;
  const fetcher = options.fetcher ?? fetch;
  return {
    async dispatch(request): Promise<Response> {
      if (request.route !== ROUTE || request.providerId.length > 64 || request.body.byteLength > 1024 * 1024) {
        throw new Error("Typed filter request exceeds its fixed route or bounds.");
      }
      const response = await fetcher(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${options.capability}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          providerId: request.providerId,
          route: ROUTE,
          body: Buffer.from(request.body).toString("base64"),
        }),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("Trusted filter redirects are denied.");
      }
      return response;
    },
  };
}

export function createConfiguredGateway(options: {
  readonly socketPath: string;
  readonly egressConfig: unknown;
  readonly gatewayConfig: unknown;
  readonly maxInputBytes: number;
  readonly maxOutputTokens: number;
  readonly maxRequests: number;
  readonly requestTimeoutMs?: number;
  readonly fetcher?: typeof fetch;
}): Server {
  const record = (value: unknown, keys: readonly string[], name: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
      throw new Error(`${name} configuration is invalid.`);
    }
    return value as Record<string, unknown>;
  };
  const egress = record(options.egressConfig, ["providers", "dispatch_enabled", "filterCapability"], "Egress");
  const gateway = record(options.gatewayConfig, ["dispatch_enabled", "providerId", "model", "filterHost", "filterPort"], "Gateway");
  if (!Array.isArray(egress.providers) || egress.providers.length !== 0 || egress.dispatch_enabled !== false ||
      typeof egress.filterCapability !== "string" || !/^[a-f0-9]{64}$/i.test(egress.filterCapability) ||
      typeof gateway.dispatch_enabled !== "boolean" || typeof gateway.providerId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(gateway.providerId) || typeof gateway.model !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(gateway.model) || typeof gateway.filterHost !== "string" ||
      !/^jarvis-egress-filter-[0-9a-f-]{36}$/.test(gateway.filterHost) || gateway.filterPort !== 8080) {
    throw new Error("Per-attempt gateway/filter configuration is invalid or not fail-closed.");
  }
  const dispatchToFilter = createTrustedFilterClient({
    host: gateway.filterHost,
    port: gateway.filterPort,
    capability: egress.filterCapability,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  return createBoundedGateway({
    socketPath: options.socketPath,
    capability: egress.filterCapability,
    providerId: gateway.providerId,
    model: gateway.model,
    maxInputBytes: options.maxInputBytes,
    maxOutputTokens: options.maxOutputTokens,
    maxRequests: options.maxRequests,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    dispatchEnabled: gateway.dispatch_enabled,
    dispatchToFilter,
  });
}

/** Production composition is intentionally stricter than synthetic factory tests. */
export function createProductionGateway(options: Parameters<typeof createConfiguredGateway>[0]): Server {
  const config = options.gatewayConfig;
  if (typeof config !== "object" || config === null || Array.isArray(config) ||
      (config as Record<string, unknown>).dispatch_enabled !== false) {
    throw new Error("Production gateway dispatch must remain disabled.");
  }
  return createConfiguredGateway(options);
}

function validOptions(options: BoundedGatewayOptions): void {
  if (!options.socketPath || !options.capability || !options.providerId || !options.model) {
    throw new Error("Gateway socket, per-attempt capability, fixed provider identity and model are required.");
  }
  for (const [name, value, minimum, maximum] of [
    ["maxInputBytes", options.maxInputBytes, 1, 1024 * 1024],
    ["maxOutputTokens", options.maxOutputTokens, 1, 1_000_000],
    ["maxRequests", options.maxRequests, 1, 1000],
    ["requestTimeoutMs", options.requestTimeoutMs ?? 30_000, 100, MAX_REQUEST_TIMEOUT_MS],
    ["maxResponseBytes", options.maxResponseBytes ?? 1024 * 1024, 1, 8 * 1024 * 1024],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} is outside its supported range.`);
    }
  }
}

function authorized(request: IncomingMessage, capability: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(capability);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.byteLength;
    if (length > limit) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

function sendError(response: ServerResponse, status: number, code: string): void {
  const body = Buffer.from(JSON.stringify({ error: code }));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export function createBoundedGateway(options: BoundedGatewayOptions): Server {
  validOptions(options);
  const filter = options.dispatchToFilter;
  const dispatchEnabled = options.dispatchEnabled ?? Boolean(filter);
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const responseLimit = options.maxResponseBytes ?? 1024 * 1024;
  let admittedRequests = 0;

  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, async (request, response) => {
    if (request.method !== "POST" || request.url !== ROUTE) {
      sendError(response, 404, "not_found");
      return;
    }
    if (!authorized(request, options.capability)) {
      sendError(response, 403, "attempt_capability_required");
      return;
    }
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      sendError(response, 415, "application_json_required");
      return;
    }
    if (admittedRequests >= options.maxRequests) {
      sendError(response, 429, "attempt_request_limit_reached");
      return;
    }
    if (!filter || !dispatchEnabled) {
      sendError(response, 503, "provider_dispatch_inactive");
      return;
    }

    admittedRequests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    response.on("close", () => controller.abort());
    try {
      const rawBody = await readBody(request, options.maxInputBytes);
      let value: unknown;
      try {
        value = JSON.parse(rawBody.toString("utf8")) as unknown;
      } catch {
        sendError(response, 400, "invalid_json");
        return;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        sendError(response, 400, "request_object_required");
        return;
      }
      const body = value as Record<string, unknown>;
      const hasMaxTokens = Object.hasOwn(body, "max_tokens");
      const hasMaxCompletionTokens = Object.hasOwn(body, "max_completion_tokens");
      const tokenLimit = hasMaxTokens ? body.max_tokens : body.max_completion_tokens;
      if (hasMaxTokens === hasMaxCompletionTokens || body.model !== options.model || !Number.isSafeInteger(tokenLimit) ||
          (tokenLimit as number) < 1 || (tokenLimit as number) > options.maxOutputTokens) {
        sendError(response, 400, "model_or_output_limit_rejected");
        return;
      }

      const upstreamResponse = await filter.dispatch({
        providerId: options.providerId,
        route: ROUTE,
        signal: controller.signal,
        body: new Uint8Array(rawBody),
      });
      if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
        sendError(response, 502, "provider_redirect_rejected");
        return;
      }
      if (!upstreamResponse.body) {
        sendError(response, 502, "provider_response_body_missing");
        return;
      }
      response.writeHead(upstreamResponse.status, {
        "content-type": upstreamResponse.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(upstreamResponse.headers.get("content-length") === null ? {} : {
          "content-length": upstreamResponse.headers.get("content-length")!,
        }),
      });
      const reader = upstreamResponse.body.getReader();
      let bytes = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > responseLimit) {
          controller.abort();
          response.destroy(new Error("provider_response_too_large"));
          return;
        }
        if (!response.write(Buffer.from(item.value))) {
          await new Promise<void>((resolve) => response.once("drain", resolve));
        }
      }
      response.end();
    } catch (error) {
      if (!response.headersSent) {
        sendError(response, error instanceof Error && error.message === "request_too_large" ? 413 : 502,
          error instanceof Error && error.message === "request_too_large" ? "request_too_large" : "provider_unavailable");
      } else if (!response.destroyed) {
        response.destroy();
      }
    } finally {
      clearTimeout(timer);
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = timeoutMs;
  server.keepAliveTimeout = 1_000;
  return server;
}

/** HTTP fetch transport for a loopback bridge that forwards only this fixed route to the UDS. */
export function createUnixSocketFetch(socketPath: string): typeof fetch {
  if (!socketPath) throw new Error("A Unix socket path is required.");
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== ROUTE || url.search || url.hash) {
      throw new Error("The loopback bridge transport only permits the fixed chat-completion route.");
    }
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const body = init?.body ?? (input instanceof Request ? await input.arrayBuffer() : undefined);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return new Promise<Response>((resolve, reject) => {
      const req = socketRequest({ socketPath, path: ROUTE, method, headers: Object.fromEntries(headers) }, (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        const stream = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        resolve(new Response(stream, { status: res.statusCode ?? 502, headers: responseHeaders }));
      });
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        signal?.removeEventListener("abort", abort);
      };
      req.on("error", (error) => {
        cleanup();
        reject(error);
      });
      const abort = (): void => { req.destroy(new DOMException("The request was aborted.", "AbortError")); };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      req.once("response", (response) => response.once("close", cleanup));
      if (body !== undefined && body !== null) {
        if (typeof body === "string" || body instanceof Uint8Array) req.write(body);
        else if (body instanceof ArrayBuffer) req.write(Buffer.from(body));
        else reject(new Error("The loopback transport requires a bounded buffered request body."));
      }
      req.end();
    });
  }) as typeof fetch;
}

/** Loopback-only HTTP bridge for OpenCode's HTTP provider client. */
export function createLoopbackGatewayBridge(options: {
  socketPath: string;
  capability: string;
  port: number;
  maxRequestBytes?: number;
}): Server {
  if (!options.socketPath || !options.capability || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("Bridge socket, per-attempt capability and valid loopback port are required.");
  }
  const fetchOverSocket = createUnixSocketFetch(options.socketPath);
  const requestLimit = options.maxRequestBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 1024 * 1024) {
    throw new Error("Bridge request size limit is outside its supported range.");
  }
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, async (request, response) => {
    if (request.method !== "POST" || request.url !== ROUTE) {
      sendError(response, 404, "not_found");
      return;
    }
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      sendError(response, 415, "application_json_required");
      return;
    }
    try {
      const body = await readBody(request, requestLimit);
      const controller = new AbortController();
      response.on("close", () => controller.abort());
      const upstream = await fetchOverSocket(`http://127.0.0.1${ROUTE}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.capability}`,
          "content-type": "application/json",
          accept: "text/event-stream, application/json",
        },
        body: new Uint8Array(body),
        signal: controller.signal,
      });
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      if (!upstream.body) {
        response.end();
        return;
      }
      const reader = upstream.body.getReader();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        if (!response.write(Buffer.from(item.value))) await new Promise<void>((resolve) => response.once("drain", resolve));
      }
      response.end();
    } catch (error) {
      if (!response.headersSent) {
        sendError(response, error instanceof Error && error.message === "request_too_large" ? 413 : 502,
          error instanceof Error && error.message === "request_too_large" ? "request_too_large" : "gateway_unavailable");
      } else if (!response.destroyed) {
        response.destroy();
      }
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 1_000;
  server.listen(options.port, "127.0.0.1");
  return server;
}
