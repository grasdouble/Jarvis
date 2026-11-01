import { chmodSync } from "node:fs";
import { estimatePreparedContextTokens, normalizeOpenAIChatUsage, resolveProviderSelection, type NormalizedUsage, type ProviderProfile, type QuotaSignals } from "@jarvis/llm";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as socketRequest } from "node:http";
import { Readable } from "node:stream";

export function listenGatewaySocket(server: Server, socketPath: string): Server {
  server.listen(socketPath);
  server.once("listening", () => chmodSync(socketPath, 0o660));
  return server;
}
const ROUTE = "/v1/chat/completions";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const UNKNOWN_USAGE: NormalizedUsage = {
  mappingVersion: "openai-chat-completions-v1",
  counters: {
    inputTotal: null,
    outputTotal: null,
    cacheReadInput: null,
    cacheWriteInput: null,
    reasoningOutput: null,
  },
  coverage: {
    inputTotal: "unknown",
    outputTotal: "unknown",
    cacheReadInput: "unknown",
    cacheWriteInput: "unknown",
    reasoningOutput: "unknown",
  },
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

export type GatewayAccountingIdentity = Readonly<{
  taskId: string;
  attemptId: string;
  leaseEpoch: number;
}>;
export type GatewayAccountingPort = Readonly<{
  recordIntent(input: {
    operationId: string;
    dispatchAttempt: number;
    provider: string;
    model: string;
    purpose: string;
  }): Promise<void>;
  markDispatched(input: {
    operationId: string;
    dispatchAttempt: number;
    provider: string;
    model: string;
    purpose: string;
  }): Promise<void>;
  recordOutcome(
    input: {
      operationId: string;
      dispatchAttempt: number;
      provider: string;
      model: string;
      purpose: string;
    },
    usage: NormalizedUsage,
    lifecycle: "succeeded" | "failed" | "cancelled" | "unknown",
    quota?: QuotaSignals,
  ): Promise<void>;
  recordRuntimeObservation?(operationId: string, usage: NormalizedUsage): Promise<void>;
}>;
export type BoundedGatewayOptions = {
  socketPath: string;
  capability: string;
  profile: ProviderProfile;
  maxInputBytes: number;
  maxOutputTokens: number;
  maxRequests: number;
  dispatchEnabled?: boolean;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  dispatchToFilter?: TrustedEgressFilterPort;
  accounting?: GatewayAccountingPort;
};
export type FilterRequest = {
  readonly providerId: string;
  readonly route: typeof ROUTE;
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
};
export interface TrustedEgressFilterPort {
  dispatch(request: FilterRequest): Promise<Response>;
}

/** Typed, fixed-route boundary. The filter owns destination resolution and provider credentials. */
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

export function createUnixAccountingClient(socketPath: string, identity: GatewayAccountingIdentity): GatewayAccountingPort {
  if (!socketPath.startsWith("/") || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(identity.taskId) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(identity.attemptId) ||
      !Number.isSafeInteger(identity.leaseEpoch) || identity.leaseEpoch < 1) {
    throw new Error("Accounting socket and task-attempt identity are required.");
  }
  const post = async (path: string, payload: unknown): Promise<unknown> => {
    const body = Buffer.from(JSON.stringify(payload));
    const { promise, resolve, reject } = deferred<unknown>();
    const req = socketRequest({
      socketPath,
      path,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": body.byteLength },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 8 * 1024) {
          req.destroy(new Error("accounting_response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const status = response.statusCode ?? 500;
        if (status < 200 || status >= 300) {
          reject(new Error("accounting_rejected"));
          return;
        }
        if (bytes === 0) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch {
          reject(new Error("accounting_response_invalid"));
        }
      });
    });
    req.setTimeout(3_000, () => req.destroy(new Error("accounting_timeout")));
    req.once("error", reject);
    req.end(body);
    return promise;
  };
  const payload = (input: {
    operationId: string;
    dispatchAttempt: number;
    provider: string;
    model: string;
    purpose: string;
  }) => ({ ...identity, ...input });
  return {
    async recordIntent(input) {
      await post("/v1/usage/intent", { attribution: payload(input) });
    },
    async markDispatched(input) {
      await post("/v1/usage/dispatched", { attribution: payload(input) });
    },
    async recordOutcome(input, usage, lifecycle, quota) {
      await post("/v1/usage/observation", {
        attribution: payload(input),
        lifecycle,
        observation: {
          source: "gateway",
          observationId: input.operationId,
          revision: 1,
          observedAt: new Date().toISOString(),
          freshness: "current",
          usage,
          ...(quota === undefined ? {} : { quota }),
        },
      });
    },
    async recordRuntimeObservation(operationId, usage) {
      await post("/v1/usage/runtime-observation", { dispatchId: operationId, usage });
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
  readonly accountingSocketPath?: string;
  readonly accounting?: GatewayAccountingPort;
}): Server {
  const record = (value: unknown, keys: readonly string[], name: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
      throw new Error(`${name} configuration is invalid.`);
    }
    return value as Record<string, unknown>;
  };
  const egress = record(options.egressConfig, ["providers", "dispatch_enabled", "filterCapability"], "Egress");
  const gateway = record(options.gatewayConfig, ["accounting", "dispatch_enabled", "profile", "filterHost", "filterPort"], "Gateway");
  if (!Array.isArray(egress.providers) || egress.providers.length !== 0 || egress.dispatch_enabled !== false ||
      typeof egress.filterCapability !== "string" || !/^[a-f0-9]{64}$/i.test(egress.filterCapability) ||
      typeof gateway.dispatch_enabled !== "boolean" || typeof gateway.filterHost !== "string" ||
      !/^jarvis-egress-filter-[0-9a-f-]{36}$/.test(gateway.filterHost) || gateway.filterPort !== 8080) {
    throw new Error("Per-attempt gateway/filter configuration is invalid or not fail-closed.");
  }
  const identity = gateway.accounting as GatewayAccountingIdentity;
  if (typeof identity !== "object" || identity === null ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(identity.taskId) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(identity.attemptId) ||
      !Number.isSafeInteger(identity.leaseEpoch) || identity.leaseEpoch < 1) {
    throw new Error("Gateway accounting attempt identity is invalid.");
  }
  let profile: ProviderProfile;
  try {
    profile = resolveProviderSelection(gateway.profile);
  } catch {
    throw new Error("Gateway selected profile is invalid.");
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
    profile,
    maxInputBytes: options.maxInputBytes,
    maxOutputTokens: options.maxOutputTokens,
    maxRequests: options.maxRequests,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    dispatchEnabled: gateway.dispatch_enabled,
    dispatchToFilter,
    accounting: options.accounting ?? createUnixAccountingClient(
      options.accountingSocketPath ?? "/run/jarvis-accounting/accounting.sock",
      identity,
    ),
  });
}

export function createProductionGateway(options: Parameters<typeof createConfiguredGateway>[0]): Server {
  const config = options.gatewayConfig;
  if (typeof config !== "object" || config === null || Array.isArray(config) ||
      (config as Record<string, unknown>).dispatch_enabled !== false) {
    throw new Error("Production gateway dispatch must remain disabled.");
  }
  return createConfiguredGateway(options);
}

function validOptions(options: BoundedGatewayOptions): void {
  if (!options.socketPath || !options.capability) {
    throw new Error("Gateway socket and per-attempt capability are required.");
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
const MAX_SSE_LINE_BYTES = 16 * 1024;
const MAX_SSE_EVENT_BYTES = 32 * 1024;
class OpenAIStreamUsageCapture {
  private readonly decoder = new TextDecoder();
  private line = "";
  private eventData: string[] = [];
  private eventBytes = 0;
  private latest: unknown;
  private disabled = false;

  push(chunk: Uint8Array): void {
    if (this.disabled) return;
    const text = this.decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
      if (!this.appendLine(text.slice(start, newline))) return;
      this.processLine();
      if (this.disabled) return;
      start = newline + 1;
    }
    this.appendLine(text.slice(start));
  }

  finish(): NormalizedUsage {
    if (!this.disabled) {
      this.appendLine(this.decoder.decode());
      if (!this.disabled && this.line !== "") this.processLine();
      this.finishEvent();
    }
    return normalizeOpenAIChatUsage(this.latest);
  }

  private appendLine(part: string): boolean {
    if (Buffer.byteLength(this.line) + Buffer.byteLength(part) > MAX_SSE_LINE_BYTES) {
      this.disable();
      return false;
    }
    this.line += part;
    return true;
  }

  private processLine(): void {
    let line = this.line;
    this.line = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "") this.finishEvent();
    else if (line.startsWith("data:")) this.addData(line.slice(5).replace(/^ /, ""));
  }

  private addData(data: string): void {
    this.eventBytes += Buffer.byteLength(data);
    if (this.eventBytes > MAX_SSE_EVENT_BYTES) { this.disable(); return; }
    this.eventData.push(data);
  }

  private finishEvent(): void {
    if (this.eventData.length) {
      const data = this.eventData.join("\n");
      if (data !== "[DONE]") {
        try {
          const value: unknown = JSON.parse(data);
          if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            const rawUsage = (value as Record<string, unknown>).usage;
            if (typeof rawUsage === "object" && rawUsage !== null && !Array.isArray(rawUsage)) {
              const fields = rawUsage as Record<string, unknown>;
              const usage: Record<string, unknown> = {};
              for (const field of ["prompt_tokens", "completion_tokens"] as const) {
                const candidate = fields[field];
                if (Number.isSafeInteger(candidate) && (candidate as number) >= 0) usage[field] = candidate;
              }
              for (const [field, source] of [["prompt_tokens_details", "cached_tokens"], ["completion_tokens_details", "reasoning_tokens"]] as const) {
                const details = fields[field];
                if (typeof details !== "object" || details === null || Array.isArray(details)) continue;
                const candidate = (details as Record<string, unknown>)[source];
                if (Number.isSafeInteger(candidate) && (candidate as number) >= 0) usage[field] = { [source]: candidate };
              }
              this.latest = { usage };
            }
          }
        } catch { /* Invalid event is not usage evidence. */ }
      }
    }
    this.eventData = [];
    this.eventBytes = 0;
  }

  private disable(): void {
    this.disabled = true;
    this.line = "";
    this.eventData = [];
    this.eventBytes = 0;
    this.latest = undefined;
  }
}
function quotaFromResponseHeaders(headers: Headers, provider: string): QuotaSignals {
  const names = ["requestLimit", "requestRemaining", "tokenLimit", "tokenRemaining"] as const;
  const headerNames = [
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
  ] as const;
  const counters: Record<typeof names[number], number | null> = {
    requestLimit: null,
    requestRemaining: null,
    tokenLimit: null,
    tokenRemaining: null,
  };
  const coverage: Record<typeof names[number], "reported" | "unknown" | "not_supported"> = {
    requestLimit: "unknown",
    requestRemaining: "unknown",
    tokenLimit: "unknown",
    tokenRemaining: "unknown",
  };
  if (provider === "openai") {
    for (let index = 0; index < names.length; index += 1) {
      const raw = headers.get(headerNames[index]!);
      if (raw !== null && /^(0|[1-9]\d{0,9})$/.test(raw) && Number(raw) <= 2_147_483_647) {
        counters[names[index]!] = Number(raw);
        coverage[names[index]!] = "reported";
      }
    }
  }
  return {
    mappingVersion: provider === "openai" ? "openai-rate-limit-headers-v1" : `${provider}-quota-unknown-v1`,
    source: "provider-response-header",
    provider,
    observedAt: new Date().toISOString(),
    freshness: "current",
    counters,
    coverage,
  };
}
function runtimeUsage(value: unknown): NormalizedUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("runtime_usage_schema");
  const record = value as Record<string, unknown>;
  const allowed = ["inputTotal", "outputTotal", "cacheReadInput", "cacheWriteInput", "reasoningOutput"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("runtime_usage_schema");
  const counters = Object.fromEntries(allowed.map((key) => {
    const item = record[key];
    if (item !== undefined && (!Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > 2_147_483_647)) {
      throw new Error("runtime_usage_schema");
    }
    return [key, item === undefined ? null : item];
  })) as NormalizedUsage["counters"];
  const coverage = Object.fromEntries(allowed.map((key) => [key, record[key] === undefined ? "unknown" : "reported"])) as NormalizedUsage["coverage"];
  return { mappingVersion: "opencode-runtime-usage-v1", counters, coverage };
}

export function createBoundedGateway(options: BoundedGatewayOptions): Server {
  validOptions(options);
  const profile = resolveProviderSelection(options.profile);
  const filter = options.dispatchToFilter;
  const dispatchEnabled = options.dispatchEnabled ?? Boolean(filter);
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const responseLimit = options.maxResponseBytes ?? 1024 * 1024;
  let admittedRequests = 0;

  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, async (request, response) => {
    if (request.method === "POST" && request.url === "/__jarvis/usage") {
      if (!authorized(request, options.capability) || request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        sendError(response, 403, "attempt_capability_required");
        return;
      }
      try {
        const message = JSON.parse((await readBody(request, 8 * 1024)).toString("utf8")) as unknown;
        if (typeof message !== "object" || message === null || Array.isArray(message) ||
            Object.keys(message).sort().join(",") !== "dispatchId,usage") throw new Error("schema");
        const report = message as { dispatchId?: unknown; usage?: unknown };
        if (typeof report.dispatchId !== "string" || !uuid.test(report.dispatchId) || !options.accounting?.recordRuntimeObservation) {
          throw new Error("correlation");
        }
        await options.accounting.recordRuntimeObservation(report.dispatchId, runtimeUsage(report.usage));
        response.writeHead(204, { "cache-control": "no-store", connection: "close" });
        response.end();
      } catch {
        sendError(response, 400, "runtime_observation_rejected");
      }
      return;
    }
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
    request.socket.once("close", () => controller.abort());
    let attribution: {
      operationId: string;
      dispatchAttempt: number;
      provider: string;
      model: string;
      purpose: string;
    } | undefined;
    let accounted = false;
    let responseQuota: QuotaSignals | undefined;
    const unknownUsage = (): NormalizedUsage => profile.providerId === "openai" ? UNKNOWN_USAGE : {
      ...UNKNOWN_USAGE,
      mappingVersion: `${profile.providerId}-usage-unknown-v1`,
      coverage: {
        inputTotal: "unknown",
        outputTotal: "unknown",
        cacheReadInput: "unknown",
        cacheWriteInput: "unknown",
        reasoningOutput: "unknown",
      },
    };
    const recordUnknown = async (lifecycle: "failed" | "cancelled" | "unknown"): Promise<void> => {
      if (attribution && options.accounting && accounted) {
        try {
          await options.accounting.recordOutcome(attribution, unknownUsage(), lifecycle, responseQuota);
        } catch {
          /* Dispatched intent remains unknown if accounting is unavailable. */
        }
      }
    };
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
      const outputLimit = hasMaxTokens ? body.max_tokens : body.max_completion_tokens;
      let contextEstimate: number;
      try {
        contextEstimate = estimatePreparedContextTokens(body.messages);
      } catch {
        sendError(response, 400, "prepared_messages_invalid");
        return;
      }
      if (hasMaxTokens === hasMaxCompletionTokens || body.model !== profile.modelId || !Number.isSafeInteger(outputLimit) ||
          (outputLimit as number) < 1 || (outputLimit as number) > options.maxOutputTokens ||
          (outputLimit as number) > profile.maxOutputTokens ||
          contextEstimate + (outputLimit as number) > profile.contextWindowTokens) {
        sendError(response, 400, "profile_or_context_budget_rejected");
        return;
      }
      if (options.accounting) {
        attribution = {
          operationId: randomUUID(),
          dispatchAttempt: 1,
          provider: profile.providerId,
          model: profile.modelId,
          purpose: "task_execution",
        };
        await options.accounting.recordIntent(attribution);
        await options.accounting.markDispatched(attribution);
        accounted = true;
      }
      const upstreamResponse = await filter.dispatch({
        providerId: profile.providerId,
        route: ROUTE,
        signal: controller.signal,
        body: new Uint8Array(rawBody),
      });
      responseQuota = quotaFromResponseHeaders(upstreamResponse.headers, profile.providerId);
      if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
        await recordUnknown("failed");
        sendError(response, 502, "provider_redirect_rejected");
        return;
      }
      if (!upstreamResponse.body) {
        await recordUnknown("failed");
        sendError(response, 502, "provider_response_body_missing");
        return;
      }
      const contentType = upstreamResponse.headers.get("content-type") ?? "application/octet-stream";
      const isJson = contentType.toLowerCase().startsWith("application/json");
      const isEventStream = contentType.toLowerCase().startsWith("text/event-stream");
      response.writeHead(upstreamResponse.status, {
        "content-type": contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(upstreamResponse.headers.get("content-length") === null ? {} : {
          "content-length": upstreamResponse.headers.get("content-length")!,
        }),
        ...(attribution === undefined ? {} : { "x-jarvis-dispatch-id": attribution.operationId }),
      });
      const reader = upstreamResponse.body.getReader();
      const captured: Buffer[] = [];
      const streamUsage = profile.providerId === "openai" && isEventStream
        ? new OpenAIStreamUsageCapture()
        : undefined;
      let bytes = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > responseLimit) {
          controller.abort();
          await recordUnknown("unknown");
          response.destroy(new Error("provider_response_too_large"));
          return;
        }
        const chunk = Buffer.from(item.value);
        if (isJson) captured.push(chunk);
        streamUsage?.push(item.value);
        if (!response.write(chunk)) {
          await new Promise<void>((resolve) => response.once("drain", resolve));
        }
      }
      response.end();
      if (attribution && options.accounting) {
        let usage = unknownUsage();
        if (streamUsage) {
          usage = streamUsage.finish();
        } else if (isJson && profile.providerId === "openai") {
          try {
            usage = normalizeOpenAIChatUsage(JSON.parse(Buffer.concat(captured, bytes).toString("utf8")) as unknown);
          } catch {
            /* Malformed usage remains unknown. */
          }
        }
        try {
          await options.accounting.recordOutcome(
            attribution,
            usage,
            upstreamResponse.status >= 400 ? "failed" : "succeeded",
            responseQuota,
          );
        } catch {
          /* The durable dispatched intent remains visible with unknown usage. */
        }
      }
    } catch (error) {
      await recordUnknown(controller.signal.aborted ? "cancelled" : "unknown");
      if (!response.headersSent) {
        sendError(response,
          error instanceof Error && error.message === "request_too_large" ? 413 : 502,
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

export function createUnixSocketFetch(socketPath: string): typeof fetch {
  if (!socketPath) throw new Error("A Unix socket path is required.");
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
        ![ROUTE, "/__jarvis/usage"].includes(url.pathname) || url.search || url.hash) {
      throw new Error("The loopback bridge transport only permits the fixed provider and runtime-accounting routes.");
    }
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const body = init?.body ?? (input instanceof Request ? await input.arrayBuffer() : undefined);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const { promise, resolve, reject } = deferred<Response>();
    const req = socketRequest({ socketPath, path: url.pathname, method, headers: Object.fromEntries(headers) }, (res) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const status = res.statusCode ?? 502;
      resolve(new Response(status === 204 || status === 304 ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, {
        status,
        headers: responseHeaders,
      }));
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
      return promise;
    }
    signal?.addEventListener("abort", abort, { once: true });
    req.once("response", (response) => response.once("close", cleanup));
    if (body !== undefined && body !== null) {
      if (typeof body === "string" || body instanceof Uint8Array) req.write(body);
      else if (body instanceof ArrayBuffer) req.write(Buffer.from(body));
      else reject(new Error("The loopback transport requires a bounded buffered request body."));
    }
    req.end();
    return promise;
  }) as typeof fetch;
}

/** Loopback-only HTTP bridge for OpenCode's HTTP provider client. */
export function createLoopbackGatewayBridge(options: {
  socketPath: string;
  capability: string;
  port: number;
  maxRequestBytes?: number;
}): Server {
  if (!options.socketPath || !options.capability || !Number.isSafeInteger(options.port) ||
      options.port < 1 || options.port > 65_535) {
    throw new Error("Bridge socket, per-attempt capability and valid loopback port are required.");
  }
  const fetchOverSocket = createUnixSocketFetch(options.socketPath);
  const requestLimit = options.maxRequestBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 1024 * 1024) {
    throw new Error("Bridge request size limit is outside its supported range.");
  }
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, async (request, response) => {
    if (request.method !== "POST" || ![ROUTE, "/__jarvis/usage"].includes(request.url ?? "")) {
      sendError(response, 404, "not_found");
      return;
    }
    const route = request.url!;
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      sendError(response, 415, "application_json_required");
      return;
    }
    try {
      const body = await readBody(request, requestLimit);
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      request.once("aborted", abort);
      request.socket.once("close", abort);
      response.on("close", () => {
        request.removeListener("aborted", abort);
        request.socket.removeListener("close", abort);
        if (!response.writableEnded) abort();
      });
      const upstream = await fetchOverSocket(`http://127.0.0.1${route}`, {
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
        ...(route === ROUTE && upstream.headers.get("x-jarvis-dispatch-id") !== null ? {
          "x-jarvis-dispatch-id": upstream.headers.get("x-jarvis-dispatch-id")!,
        } : {}),
      });
      if (!upstream.body) {
        response.end();
        return;
      }
      const reader = upstream.body.getReader();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        if (!response.write(Buffer.from(item.value))) {
          await new Promise<void>((resolve) => response.once("drain", resolve));
        }
      }
      response.end();
    } catch (error) {
      if (process.env.JARVIS_GATEWAY_BRIDGE_DIAGNOSTICS === "1") {
        const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "transport_error";
        console.error("JARVIS_LOOPBACK_BRIDGE_FAILURE", code);
      }
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
