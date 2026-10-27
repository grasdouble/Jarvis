import { request, type RequestOptions } from "node:https";
import type { SandboxSpec } from "./sandbox-runtime.js";
import type { SandboxManagerClient } from "./sandbox-runtime.js";

export type SandboxManagerHttpOptions = { endpoint: URL; key: string | Buffer; cert: string | Buffer; ca: string | Buffer; timeoutMs: number };

/** HTTPS-only closed-contract client. Endpoint and TLS identity are injected by trusted host configuration. */
export function createSandboxManagerHttpClient(options: SandboxManagerHttpOptions): SandboxManagerClient {
  if (options.endpoint.protocol !== "https:" || options.endpoint.username !== "" || options.endpoint.password !== "" ||
      options.endpoint.pathname !== "/" || options.endpoint.search !== "" || options.endpoint.hash !== "" ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 10_000) {
    throw new TypeError("Sandbox manager requires a root HTTPS endpoint without credentials, query, fragment, and timeout in 1..10000 ms");
  }
  const send = <T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}, validate?: (value: unknown) => T): Promise<T> => new Promise((resolve, reject) => {
    let settled = false;
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const requestOptions: RequestOptions = { protocol: "https:", hostname: options.endpoint.hostname, port: options.endpoint.port || 443,
      method, path, key: options.key, cert: options.cert, ca: options.ca, rejectUnauthorized: true, minVersion: "TLSv1.2",
      headers: { ...extraHeaders, ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) } };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    const req = request(requestOptions, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 16_384) req.destroy(); else chunks.push(chunk); });
      res.on("end", () => {
        if (settled) return;
        if (res.statusCode === 204) { settle(() => resolve(undefined as T)); return; }
        if (res.statusCode === 200 || res.statusCode === 201 || res.statusCode === 202) {
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const result = validate ? validate(parsed) : parsed as T;
            settle(() => resolve(result));
          }
          catch { settle(() => reject(new Error("Sandbox manager returned an invalid response"))); }
        } else settle(() => reject(new Error(`Sandbox manager request failed with status ${res.statusCode ?? "unknown"}`)));
      });
    });
    const deadline = setTimeout(() => {
      settle(() => {
        req.destroy();
        reject(new Error("Sandbox manager request failed"));
      });
    }, options.timeoutMs);
    req.on("error", () => settle(() => reject(new Error("Sandbox manager request failed"))));
    if (payload) req.end(payload); else req.end();
  });
  return {
    findByIdempotencyKey(spec: SandboxSpec, idempotencyKey: string): Promise<string | null> {
      return send("POST", "/v1/sandboxes/resolve", spec, { "idempotency-key": idempotencyKey }, (value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "sandboxId")) throw new Error("invalid sandbox resolution response");
        const id = (value as { sandboxId: unknown }).sandboxId;
        if (id !== null && (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) throw new Error("invalid sandbox resolution response");
        return id as string | null;
      });
    },
    create(spec: SandboxSpec, idempotencyKey: string): Promise<{ sandboxId: string }> {
      return send("POST", "/v1/sandboxes", spec, { "idempotency-key": idempotencyKey }, (value) => {
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (value === null || typeof value !== "object" || Array.isArray(value) ||
            Object.keys(value).length !== 2 || !Object.hasOwn(value, "sandboxId") || !Object.hasOwn(value, "state") ||
            typeof (value as { sandboxId?: unknown }).sandboxId !== "string" ||
            !uuid.test((value as { sandboxId: string }).sandboxId) ||
            typeof (value as { state?: unknown }).state !== "string") {
          throw new Error("invalid sandbox response");
        }
        return { sandboxId: (value as { sandboxId: string }).sandboxId };
      });
    },
    cancel(sandboxId: string, leaseEpoch: number): Promise<void> {
      if (!/^[0-9a-f-]{36}$/i.test(sandboxId) || !Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) return Promise.reject(new TypeError("Invalid sandbox cancellation identity"));
      return send("POST", `/v1/sandboxes/${sandboxId}/cancel`, { leaseEpoch });
    },
  };
}
