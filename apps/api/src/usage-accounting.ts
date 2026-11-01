import { chmod, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PostgresUsageAccountingStore, UsageAttribution, UsageObservation } from "@jarvis/persistence";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_HEADER_BYTES = 4 * 1024;

function reply(response: ServerResponse, status: number): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "connection": "close" });
  response.end(status === 204 ? undefined : JSON.stringify({ accepted: status < 300 }));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error("body_limit");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error("schema");
  return value as Record<string, unknown>;
}
function attribution(value: unknown): UsageAttribution {
  const record = exactObject(value, ["operationId", "taskId", "attemptId", "leaseEpoch", "dispatchAttempt", "provider", "model", "purpose"]);
  return record as unknown as UsageAttribution;
}
const usageFields = ["inputTotal", "outputTotal", "cacheReadInput", "cacheWriteInput", "reasoningOutput"] as const;
function normalizedUsage(value: unknown): UsageObservation["usage"] {
  const record = exactObject(value, ["mappingVersion", "counters", "coverage"]);
  const counters = exactObject(record.counters, usageFields);
  const coverage = exactObject(record.coverage, usageFields);
  if (typeof record.mappingVersion !== "string" || !/^[a-zA-Z0-9._:-]{1,96}$/.test(record.mappingVersion)) throw new Error("schema");
  for (const field of usageFields) {
    const count = counters[field];
    const status = coverage[field];
    if (!(status === "reported" || status === "estimated" || status === "unknown" || status === "not_supported") ||
        (count !== null && (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 2_147_483_647)) ||
        ((status === "reported" || status === "estimated") !== (count !== null))) throw new Error("schema");
  }
  return record as unknown as UsageObservation["usage"];
}
function normalizedQuota(value: unknown): UsageObservation["quota"] {
  const fields = ["requestLimit", "requestRemaining", "tokenLimit", "tokenRemaining"] as const;
  const record = exactObject(value, ["mappingVersion", "source", "provider", "observedAt", "freshness", "counters", "coverage"]);
  const counters = exactObject(record.counters, fields);
  const coverage = exactObject(record.coverage, fields);
  if (record.source !== "provider-response-header" || typeof record.provider !== "string" ||
      typeof record.mappingVersion !== "string" || !/^[a-zA-Z0-9._:-]{1,96}$/.test(record.mappingVersion) ||
      !Number.isFinite(Date.parse(String(record.observedAt))) || !["current", "stale", "unknown"].includes(String(record.freshness))) throw new Error("schema");
  for (const field of fields) {
    const count = counters[field]; const status = coverage[field];
    if (!(status === "reported" || status === "unknown" || status === "not_supported") ||
        (count !== null && (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 2_147_483_647)) ||
        ((status === "reported") !== (count !== null))) throw new Error("schema");
  }
  return record as unknown as UsageObservation["quota"];
}

/** Private API-only accounting listener. Unix-socket filesystem permissions are its transport authentication. */
export async function listenUsageAccounting(options: {
  readonly path: string;
  readonly store: PostgresUsageAccountingStore;
}): Promise<Server> {
  if (!options.path.startsWith("/") || options.path.length > 100) throw new Error("Accounting socket path must be absolute and bounded.");
  try { await unlink(options.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
        reply(response, 404); return;
      }
      try {
        const value = await body(request);
        if (request.url === "/v1/usage/intent") {
          const message = exactObject(value, ["attribution"]);
          const id = await options.store.recordIntent(attribution(message.attribution));
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ modelRequestId: id }));
          return;
        }
        if (request.url === "/v1/usage/observation") {
          const message = exactObject(value, ["attribution", "observation", "lifecycle"]);
          if (typeof message.observation !== "object" || message.observation === null || Array.isArray(message.observation)) throw new Error("schema");
          const item = message.observation as Record<string, unknown>;
          const baseKeys = ["source", "observationId", "revision", "observedAt", "freshness", "usage"];
          const actualKeys = Object.keys(item).sort().join(",");
          if (actualKeys !== baseKeys.sort().join(",") && actualKeys !== [...baseKeys, "quota"].sort().join(",")) throw new Error("schema");
          if (item.source !== "gateway") throw new Error("schema");
          const observation = { ...item, usage: normalizedUsage(item.usage), ...(item.quota === undefined ? {} : { quota: normalizedQuota(item.quota) }) } as unknown as UsageObservation;
          await options.store.recordObservation(attribution(message.attribution), observation,
            message.lifecycle as "succeeded" | "failed" | "cancelled" | "unknown");
          reply(response, 204);
          return;
        }
        if (request.url === "/v1/usage/runtime-observation") {
          const message = exactObject(value, ["dispatchId", "usage"]);
          if (typeof message.dispatchId !== "string" ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.dispatchId)) throw new Error("schema");
          await options.store.recordRuntimeObservation(message.dispatchId, normalizedUsage(message.usage));
          reply(response, 204);
          return;
        }
        if (request.url === "/v1/usage/dispatched") {
          const message = exactObject(value, ["attribution"]);
          await options.store.markDispatched(attribution(message.attribution));
          reply(response, 204);
          return;
        }
        reply(response, 404);
      } catch {
        if (!response.headersSent) reply(response, 400);
        else response.destroy();
      }
    })();
  });
  server.headersTimeout = 3_000;
  server.requestTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.path, resolve);
  });
  await chmod(options.path, 0o660);
  return server;
}
