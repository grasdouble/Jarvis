import { createServer, type Server, type ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PeerCertificate } from "node:tls";

import {
  SandboxManagerError,
  type SandboxManager,
  type SandboxSpec,
} from "./index.js";

const MAX_BODY_BYTES = 80 * 1024;
const SANDBOX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SandboxManagerServerOptions = {
  manager: SandboxManager;
  tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  authorizeClient: (certificate: PeerCertificate) => boolean;
  sweepIntervalMs?: number;
};

function send(response: ServerResponse, status: number, payload: unknown): void {
  if (status === 204) {
    response.writeHead(status, { "cache-control": "no-store" });
    response.end();
    return;
  }
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new SandboxManagerError("Content-Type must be application/json.", "INVALID_ARGUMENT");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      throw new SandboxManagerError("Request body exceeds the configured size limit.", "INVALID_ARGUMENT");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new SandboxManagerError("Request body is not valid JSON.", "INVALID_ARGUMENT");
  }
}

function leaseEpoch(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SandboxManagerError("Lease request must be an object.", "INVALID_ARGUMENT");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Number.isSafeInteger(record.leaseEpoch) || (record.leaseEpoch as number) < 1) {
    throw new SandboxManagerError("Lease request must contain only a positive leaseEpoch.", "INVALID_ARGUMENT");
  }
  return record.leaseEpoch as number;
}

function statusFor(error: unknown): number {
  if (!(error instanceof SandboxManagerError)) return 500;
  switch (error.code) {
    case "INVALID_ARGUMENT": return 400;
    case "NOT_FOUND": return 404;
    case "CONFLICT": return 409;
    case "ENGINE_ERROR": return 502;
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: SandboxManagerServerOptions,
): Promise<void> {
  try {
    const socket = request.socket as typeof request.socket & { getPeerCertificate?: () => PeerCertificate };
    const certificate = socket.getPeerCertificate?.();
    if (!certificate?.fingerprint256 || !options.authorizeClient(certificate)) {
      send(response, 403, { error: "client_not_authorized" });
      return;
    }

    const method = request.method ?? "";
    const url = new URL(request.url ?? "/", "https://sandbox-manager.invalid");
    if (url.search || url.hash) {
      send(response, 404, { error: "not_found" });
      return;
    }

    if (method === "POST" && url.pathname === "/v1/sandboxes") {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string") {
        throw new SandboxManagerError("Idempotency-Key is required.", "INVALID_ARGUMENT");
      }
      const result = await options.manager.create(await readJson(request) as SandboxSpec, idempotencyKey);
      send(response, 201, { sandboxId: result.sandboxId, state: result.state });
      return;
    }

    if (method === "POST" && url.pathname === "/v1/sandboxes/resolve") {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string") throw new SandboxManagerError("Idempotency-Key is required.", "INVALID_ARGUMENT");
      const sandboxId = await options.manager.findByIdempotencyKey(await readJson(request), idempotencyKey);
      send(response, 200, { sandboxId });
      return;
    }

    const match = /^\/v1\/sandboxes\/([0-9a-f-]{36})(?:\/(cancel|runtime))?$/.exec(url.pathname);
    if (!match || !SANDBOX_ID.test(match[1] ?? "")) {
      send(response, 404, { error: "not_found" });
      return;
    }
    const sandboxId = match[1] as string;
    const operation = match[2];

    if (method === "GET" && operation === undefined) {
      send(response, 200, await options.manager.inspect(sandboxId));
      return;
    }
    if (method === "POST" && operation === "cancel") {
      await options.manager.cancel(sandboxId, leaseEpoch(await readJson(request)));
      send(response, 202, { accepted: true });
      return;
    }
    if (method === "POST" && operation === "runtime") {
      const body = await readJson(request);
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new SandboxManagerError("Runtime request must be an object.", "INVALID_ARGUMENT");
      }
      const record = body as Record<string, unknown>;
      if (Object.keys(record).length !== 4 || !Object.hasOwn(record, "leaseEpoch") || !Object.hasOwn(record, "taskId") ||
          !Object.hasOwn(record, "attemptId") || !Object.hasOwn(record, "request")) {
        throw new SandboxManagerError("Runtime request contains unknown or missing fields.", "INVALID_ARGUMENT");
      }
      if (typeof record.taskId !== "string" || typeof record.attemptId !== "string") {
        throw new SandboxManagerError("Runtime task and attempt identities must be strings.", "INVALID_ARGUMENT");
      }
      send(response, 200, await options.manager.runtime(sandboxId, leaseEpoch({ leaseEpoch: record.leaseEpoch }), record.taskId, record.attemptId, record.request));
      return;
    }
    if (method === "DELETE" && operation === undefined) {
      await options.manager.destroy(sandboxId, leaseEpoch(await readJson(request)));
      send(response, 204, {});
      return;
    }

    send(response, 404, { error: "not_found" });
  } catch (error) {
    const status = statusFor(error);
    send(response, status, {
      error: error instanceof SandboxManagerError ? error.code.toLowerCase() : "internal_error",
      message: error instanceof SandboxManagerError ? error.message : "Sandbox-manager request failed.",
    });
  }
}

export function createSandboxManagerServer(options: SandboxManagerServerOptions): Server {
  if (typeof options.authorizeClient !== "function") {
    throw new SandboxManagerError("An explicit mutual-TLS client authorization policy is required.", "INVALID_ARGUMENT");
  }
  const server = createServer({
    ...options.tls,
    minVersion: "TLSv1.2",
    requestCert: true,
    rejectUnauthorized: true,
    maxHeaderSize: 8 * 1024,
  }, (request, response) => {
    void handle(request, response, options);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  const intervalMs = options.sweepIntervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
    throw new SandboxManagerError("Expiry sweep interval must be between 100 and 60000 ms.", "INVALID_ARGUMENT");
  }
  const timer = setInterval(() => {
    void options.manager.expire().catch(() => {
      // Cleanup failures stay scoped and are retried by a later sweep; never run a global prune.
    });
  }, intervalMs);
  timer.unref();
  server.once("close", () => clearInterval(timer));
  return server;
}
