#!/usr/bin/env node
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import process from "node:process";

const ORIGIN = "http://127.0.0.1:4096";
const MAX_INPUT_BYTES = 70 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function invalid() { throw new Error("invalid fixed relay request"); }
function exact(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) invalid();
}
function session(value) {
  if (typeof value !== "string" || !SESSION_ID.test(value)) invalid();
  return encodeURIComponent(value);
}

async function readBounded(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("OpenCode response exceeds the fixed relay limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

/** Fixed loopback mapping with a closed request union; fetch injection is only a local test seam. */
export async function dispatchFixedOpenCode(request, options = {}) {
  const password = options.password ?? process.env.OPENCODE_SERVER_PASSWORD;
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof password !== "string" || password.length === 0 || typeof fetcher !== "function") invalid();
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

  async function call(path, method = "GET", body) {
    const controller = new globalThis.AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetcher(new globalThis.URL(path, ORIGIN), {
        method, redirect: "error", signal: controller.signal,
        headers: { authorization, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await readBounded(response);
      if (!response.ok) throw new Error("OpenCode request rejected");
      return text ? JSON.parse(text) : {};
    } finally { globalThis.clearTimeout(timer); }
  }

  let result;
  switch (request?.operation) {
    case "health":
      exact(request, ["operation"]);
      result = await call("/api/info");
      if (typeof result.version !== "string") invalid();
      return { healthy: true, version: result.version };
    case "session.create":
      exact(request, ["operation", "title"]);
      if (typeof request.title !== "string" || request.title.length < 1 || request.title.length > 200) invalid();
      result = await call("/api/session", "POST", { title: request.title });
      if (!SESSION_ID.test(result.data?.id ?? "")) invalid();
      return result.data;
    case "prompt":
      exact(request, ["operation", "sessionID", "text"]);
      if (typeof request.text !== "string" || request.text.length < 1 || request.text.length > 64 * 1024) invalid();
      return call(`/api/session/${session(request.sessionID)}/prompt`, "POST", { text: request.text, resume: true });
    case "messages":
      exact(request, ["operation", "sessionID"]);
      result = await call(`/api/session/${session(request.sessionID)}/message?order=desc&limit=50`);
      if (!Array.isArray(result.data)) invalid();
      return { messages: result.data };
    case "status":
      exact(request, ["operation", "sessionID"]);
      result = await call("/api/session/status");
      return { status: result[request.sessionID]?.type ?? "idle" };
    case "cancel":
      exact(request, ["operation", "sessionID"]);
      result = await call(`/api/session/${session(request.sessionID)}/interrupt`, "POST");
      if (typeof result.interrupted !== "boolean") invalid();
      return result;
    default: invalid();
  }
}

async function runRelay() {
  if (!process.env.OPENCODE_SERVER_PASSWORD) process.exit(70);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let input = "";
  for await (const line of lines) {
    input += `${line}\n`;
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) invalid();
  }
  if (!input.endsWith("\n") || input.trim().includes("\n")) invalid();
  const result = await dispatchFixedOpenCode(JSON.parse(input));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRelay().catch(() => process.exit(1));
}
