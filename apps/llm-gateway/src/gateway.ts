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
  providerUrl: string;
  providerApiKey: string;
  model: string;
  maxInputBytes: number;
  maxOutputTokens: number;
  maxRequests: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  fetchProvider?: typeof fetch;
};

function validOptions(options: BoundedGatewayOptions): void {
  if (!options.socketPath || !options.capability || !options.providerApiKey || !options.model) {
    throw new Error("Gateway socket, per-attempt capability, fixed model and provider key are required.");
  }
  const upstream = new URL(options.providerUrl);
  if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error("Provider URL must be a fixed HTTPS endpoint without embedded credentials or query data.");
  }
  if (upstream.pathname !== ROUTE) throw new Error(`Provider URL must use the fixed ${ROUTE} route.`);
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
  const providerUrl = new URL(options.providerUrl);
  const providerFetch = options.fetchProvider ?? fetch;
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
      const tokenLimit = body.max_tokens ?? body.max_completion_tokens;
      if (body.model !== options.model || !Number.isSafeInteger(tokenLimit) ||
          (tokenLimit as number) < 1 || (tokenLimit as number) > options.maxOutputTokens) {
        sendError(response, 400, "model_or_output_limit_rejected");
        return;
      }

      const upstreamResponse = await providerFetch(providerUrl, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${options.providerApiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream, application/json",
        },
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
