import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "node:http";

import { createBoundedGateway } from "../dist/gateway.js";

let directory;
let socketPath;
let gateway;
let upstreamCalls;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "jarvis-gateway-test-"));
  socketPath = join(directory, "gateway.sock");
  upstreamCalls = [];
  gateway = createBoundedGateway({
    socketPath,
    capability: "attempt-capability-test",
    providerUrl: "https://provider.invalid/v1/chat/completions",
    providerApiKey: "synthetic-provider-key",
    model: "test-model",
    maxInputBytes: 2048,
    maxOutputTokens: 64,
    maxRequests: 6,
    fetchProvider: async (url, init) => {
      upstreamCalls.push({ url: String(url), init });
      return new globalThis.Response(new globalThis.ReadableStream({
        start(controller) {
          controller.enqueue(new globalThis.TextEncoder().encode("data: {\"choices\":["));
          controller.enqueue(new globalThis.TextEncoder().encode("{\"delta\":{\"content\":\"bounded reply\"}}]}\n\n"));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  await new Promise((resolve) => gateway.listen(socketPath, resolve));
});

after(async () => {
  await new Promise((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
});

test("gateway exports a Unix-socket fetch transport for loopback HTTP bridge tests", async () => {
  const { createUnixSocketFetch } = await import("../dist/gateway.js");
  const fetchOverSocket = createUnixSocketFetch(socketPath);
  const response = await fetchOverSocket("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer attempt-capability-test", "content-type": "application/json" },
    body: JSON.stringify({ model: "test-model", max_tokens: 32, messages: [{ role: "user", content: "synthetic" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data: {"choices":[{"delta":{"content":"bounded reply"}}]}\n\n');
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, "https://provider.invalid/v1/chat/completions");
  assert.equal(upstreamCalls[0].init.headers.authorization, "Bearer synthetic-provider-key");
  const forwardedBody = JSON.parse(globalThis.Buffer.from(upstreamCalls[0].init.body).toString("utf8"));
  assert.equal(forwardedBody.max_tokens, 32);
  assert.equal(Object.hasOwn(forwardedBody, "max_completion_tokens"), false);
});

test("gateway refuses missing attempt capability, unknown routes and model or output-limit overrides", async () => {
  const { createUnixSocketFetch } = await import("../dist/gateway.js");
  const fetchOverSocket = createUnixSocketFetch(socketPath);
  const send = (body, token = "attempt-capability-test") => fetchOverSocket("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal((await send({ model: "test-model", max_tokens: 1 }, "wrong")).status, 403);
  await assert.rejects(() => fetchOverSocket("http://127.0.0.1/v1/models", { method: "POST" }), /fixed chat-completion route/);
  assert.equal((await send({ model: "attacker-model", max_tokens: 1 })).status, 400);
  assert.equal((await send({ model: "test-model", max_tokens: 65 })).status, 400);
  assert.equal((await send({ model: "test-model", max_completion_tokens: 64 })).status, 200);
  assert.equal((await send({ model: "test-model", max_completion_tokens: 65 })).status, 400);
  assert.equal((await send({ model: "test-model", max_tokens: 1, max_completion_tokens: 65 })).status, 400);
  assert.equal(upstreamCalls.length, 2);
});

test("gateway rejects redirects and enforces the per-attempt request count", async () => {
  const { createBoundedGateway } = await import("../dist/gateway.js");
  const secondSocket = join(directory, "redirect.sock");
  const limited = createBoundedGateway({
    socketPath: secondSocket,
    capability: "redirect-capability",
    providerUrl: "https://provider.invalid/v1/chat/completions",
    providerApiKey: "synthetic-provider-key",
    model: "test-model",
    maxInputBytes: 2048,
    maxOutputTokens: 64,
    maxRequests: 1,
    fetchProvider: async () => new globalThis.Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }),
  });
  await new Promise((resolve) => limited.listen(secondSocket, resolve));
  const { createUnixSocketFetch } = await import("../dist/gateway.js");
  const fetchOverSocket = createUnixSocketFetch(secondSocket);
  const request = () => fetchOverSocket("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer redirect-capability", "content-type": "application/json" },
    body: JSON.stringify({ model: "test-model", max_tokens: 1 }),
  });
  try {
    assert.equal((await request()).status, 502);
    assert.equal((await request()).status, 429);
  } finally {
    await new Promise((resolve, reject) => limited.close((error) => error ? reject(error) : resolve()));
  }
});

test("loopback HTTP bridge forwards only the fixed route over the Unix socket", async () => {
  const { createBoundedGateway, createLoopbackGatewayBridge } = await import("../dist/gateway.js");
  const bridgeSocket = join(directory, "bridge-gateway.sock");
  const provider = createBoundedGateway({
    socketPath: bridgeSocket,
    capability: "bridge-attempt-capability",
    providerUrl: "https://provider.invalid/v1/chat/completions",
    providerApiKey: "synthetic-provider-key",
    model: "test-model",
    maxInputBytes: 1024,
    maxOutputTokens: 16,
    maxRequests: 1,
    fetchProvider: async () => new globalThis.Response("fixture-response", { headers: { "content-type": "text/plain" } }),
  });
  await new Promise((resolve) => provider.listen(bridgeSocket, resolve));

  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const address = portProbe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => portProbe.close(resolve));

  const bridge = createLoopbackGatewayBridge({ socketPath: bridgeSocket, capability: "bridge-attempt-capability", port });
  try {
    await new Promise((resolve) => bridge.once("listening", resolve));
    const listening = bridge.address();
    assert.ok(listening && typeof listening === "object");
    assert.equal(listening.address, "127.0.0.1");
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ignored-client-value" },
      body: JSON.stringify({ model: "test-model", max_tokens: 4 }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "fixture-response");
  } finally {
    await new Promise((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});

test("loopback cancellation aborts the in-flight provider request", async () => {
  const { createBoundedGateway, createLoopbackGatewayBridge } = await import("../dist/gateway.js");
  const cancelSocket = join(directory, "cancel-gateway.sock");
  let announceStarted;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  let providerAborted = false;
  let announceAborted;
  const aborted = new Promise((resolve) => { announceAborted = resolve; });
  const provider = createBoundedGateway({
    socketPath: cancelSocket,
    capability: "cancel-attempt-capability",
    providerUrl: "https://provider.invalid/v1/chat/completions",
    providerApiKey: "synthetic-provider-key",
    model: "test-model",
    maxInputBytes: 1024,
    maxOutputTokens: 16,
    maxRequests: 1,
    fetchProvider: async (_url, init) => {
      announceStarted();
      await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          providerAborted = true;
          announceAborted();
          reject(new globalThis.DOMException("aborted", "AbortError"));
        }, { once: true });
      });
      return globalThis.Response.json({});
    },
  });
  await new Promise((resolve) => provider.listen(cancelSocket, resolve));
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const address = portProbe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => portProbe.close(resolve));
  const bridge = createLoopbackGatewayBridge({ socketPath: cancelSocket, capability: "cancel-attempt-capability", port });
  try {
    await new Promise((resolve) => bridge.once("listening", resolve));
    const controller = new globalThis.AbortController();
    const request = globalThis.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", max_tokens: 1 }),
    });
    await started;
    controller.abort();
    await assert.rejects(request, { name: "AbortError" });
    await aborted;
    assert.equal(providerAborted, true);
  } finally {
    await new Promise((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});
