import { readFileSync, unlinkSync } from "node:fs";
import { createBoundedGateway } from "./gateway.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required LLM gateway setting is missing: ${name}.`);
  return value;
}

function positiveInteger(name: string, defaultValue: number): number {
  const value = process.env[name] ?? String(defaultValue);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

const socketPath = required("LLM_GATEWAY_SOCKET");
const server = createBoundedGateway({
  socketPath,
  capability: required("LLM_GATEWAY_ATTEMPT_CAPABILITY"),
  providerUrl: required("LLM_GATEWAY_PROVIDER_URL"),
  providerApiKey: readFileSync(required("LLM_GATEWAY_PROVIDER_KEY_FILE"), "utf8").trim(),
  model: required("LLM_GATEWAY_MODEL"),
  maxInputBytes: positiveInteger("LLM_GATEWAY_MAX_INPUT_BYTES", 256 * 1024),
  maxOutputTokens: positiveInteger("LLM_GATEWAY_MAX_OUTPUT_TOKENS", 4096),
  maxRequests: positiveInteger("LLM_GATEWAY_MAX_REQUESTS", 8),
  requestTimeoutMs: positiveInteger("LLM_GATEWAY_REQUEST_TIMEOUT_MS", 30_000),
});

server.listen(socketPath);
server.once("listening", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close(() => {
        try { unlinkSync(socketPath); } catch { /* Socket may already have been removed by the volume owner. */ }
        process.exit(0);
      });
    });
  }
});
