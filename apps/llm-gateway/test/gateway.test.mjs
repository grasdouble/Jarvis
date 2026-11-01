import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "node:http";

import { resolveProviderCatalog } from "@jarvis/llm";
import { createBoundedGateway, createConfiguredGateway, createUnixSocketFetch } from "../dist/gateway.js";

const profile = resolveProviderCatalog({
  activeProfileId: "copilot",
  profiles: {
    copilot: { modelId: "test-model", contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities: ["chat-completions", "streaming", "cancellation", "context-budget"] },
    openai: { modelId: "other-model", contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities: ["chat-completions", "streaming", "cancellation", "context-budget"] },
  },
}).active;

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
    profile,
    maxInputBytes: 2048,
    maxOutputTokens: 64,
    maxRequests: 6,
    dispatchToFilter: { dispatch: async (input) => {
      upstreamCalls.push(input);
      return new globalThis.Response(new globalThis.ReadableStream({
        start(controller) {
          controller.enqueue(new globalThis.TextEncoder().encode("data: {\"choices\":["));
          controller.enqueue(new globalThis.TextEncoder().encode("{\"delta\":{\"content\":\"bounded reply\"}}]}\n\n"));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    } },
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
  assert.equal(upstreamCalls[0].providerId, "github-copilot");
  assert.equal(upstreamCalls[0].route, "/v1/chat/completions");
  assert.equal(Object.hasOwn(upstreamCalls[0], "url"), false);
  assert.equal(Object.hasOwn(upstreamCalls[0], "authorization"), false);
  const forwardedBody = JSON.parse(globalThis.Buffer.from(upstreamCalls[0].body).toString("utf8"));
  assert.equal(forwardedBody.max_tokens, 32);
  assert.equal(Object.hasOwn(forwardedBody, "max_completion_tokens"), false);
});

test("gateway dispatch is inactive without an explicitly wired trusted filter", async () => {
  const { createBoundedGateway, createUnixSocketFetch } = await import("../dist/gateway.js");
  const inactiveSocket = join(directory, "inactive.sock");
  const inactive = createBoundedGateway({
    socketPath: inactiveSocket,
    capability: "inactive-capability",
    profile,
    maxInputBytes: 1024,
    maxOutputTokens: 16,
    maxRequests: 2,
  });
  await new Promise((resolve) => inactive.listen(inactiveSocket, resolve));
  try {
    const send = await createUnixSocketFetch(inactiveSocket)("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer inactive-capability", "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", max_tokens: 1 }),
    });
    assert.equal(send.status, 503);
    assert.equal((await send.json()).error, "provider_dispatch_inactive");
  } finally {
    await new Promise((resolve, reject) => inactive.close((error) => error ? reject(error) : resolve()));
  }
});

test("configured gateway reaches the fixed internal filter port and forwards its disabled 503", async () => {
  const configuredSocket = join(directory, "configured-filter.sock");
  const calls = [];
  const configured = createConfiguredGateway({
    socketPath: configuredSocket,
    egressConfig: { providers: [], dispatch_enabled: false, filterCapability: "e".repeat(64) },
    gatewayConfig: {
      dispatch_enabled: true, profile,
      filterHost: "jarvis-egress-filter-00000000-0000-4000-8000-000000000251", filterPort: 8080,
    },
    maxInputBytes: 2048,
    maxOutputTokens: 64,
    maxRequests: 2,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return new globalThis.Response("{\"error\":\"provider_dispatch_inactive\"}", {
        status: 503, headers: { "content-type": "application/json" },
      });
    },
  });
  await new Promise((resolve) => configured.listen(configuredSocket, resolve));
  try {
    const response = await createUnixSocketFetch(configuredSocket)("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${"e".repeat(64)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", max_tokens: 1, messages: [{ role: "user", content: "synthetic" }] }),
    });
    assert.equal(response.status, 503);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://jarvis-egress-filter-00000000-0000-4000-8000-000000000251:8080/v1/dispatch");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.headers.authorization, `Bearer ${"e".repeat(64)}`);
  } finally {
    await new Promise((resolve, reject) => configured.close((error) => error ? reject(error) : resolve()));
  }
});

test("production-style disabled gateway configuration returns 503 without invoking the configured filter", async () => {
  const disabledSocket = join(directory, "configured-disabled.sock");
  let calls = 0;
  const configured = createConfiguredGateway({
    socketPath: disabledSocket,
    egressConfig: { providers: [], dispatch_enabled: false, filterCapability: "f".repeat(64) },
    gatewayConfig: {
      dispatch_enabled: false, profile,
      filterHost: "jarvis-egress-filter-00000000-0000-4000-8000-000000000251", filterPort: 8080,
    },
    maxInputBytes: 1024, maxOutputTokens: 8, maxRequests: 1,
    fetcher: async () => { calls += 1; return new globalThis.Response("unexpected", { status: 200 }); },
  });
  await new Promise((resolve) => configured.listen(disabledSocket, resolve));
  try {
    const response = await createUnixSocketFetch(disabledSocket)("http://127.0.0.1/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${"f".repeat(64)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", max_tokens: 1, messages: [{ role: "user", content: "synthetic" }] }),
    });
    assert.equal(response.status, 503);
    assert.equal(calls, 0);
  } finally {
    await new Promise((resolve, reject) => configured.close((error) => error ? reject(error) : resolve()));
  }
});

test("production gateway composition rejects enabled dispatch before creating a server", async () => {
  const { createProductionGateway } = await import("../dist/gateway.js");
  assert.throws(() => createProductionGateway({
    socketPath: join(directory, "must-not-start.sock"),
    egressConfig: { providers: [], dispatch_enabled: false, filterCapability: "a".repeat(64) },
    gatewayConfig: {
      dispatch_enabled: true, profile,
      filterHost: "jarvis-egress-filter-00000000-0000-4000-8000-000000000251", filterPort: 8080,
    },
    maxInputBytes: 1024, maxOutputTokens: 8, maxRequests: 1,
    fetcher: async () => new globalThis.Response("unexpected", { status: 200 }),
  }), /production.*disabled|dispatch.*disabled/i);
});

test("typed filter client fixes provider route and forwards no URL or provider credential", async () => {
  const { createTrustedFilterClient } = await import("../dist/gateway.js");
  let captured;
  const client = createTrustedFilterClient({
    host: "filter.internal",
    port: 8080,
    capability: "synthetic-attempt-capability",
    fetcher: async (url, init) => {
      captured = { url, init, payload: JSON.parse(init.body) };
      return new globalThis.Response("synthetic", { status: 200 });
    },
  });
  const response = await client.dispatch({
    providerId: "synthetic-provider", route: "/v1/chat/completions",
    body: new Uint8Array(globalThis.Buffer.from('{"model":"test-model"}')), signal: new globalThis.AbortController().signal,
  });
  assert.equal(await response.text(), "synthetic");
  assert.equal(captured.url, "http://filter.internal:8080/v1/dispatch");
  assert.equal(captured.init.redirect, "manual");
  assert.equal(captured.payload.providerId, "synthetic-provider");
  assert.equal(captured.payload.route, "/v1/chat/completions");
  assert.equal(globalThis.Buffer.from(captured.payload.body, "base64").toString(), '{"model":"test-model"}');
  assert.equal(Object.hasOwn(captured.payload, "url"), false);
  assert.equal(Object.hasOwn(captured.payload, "apiKey"), false);
  assert.equal(captured.init.headers.authorization, "Bearer synthetic-attempt-capability");
});

test("gateway refuses missing attempt capability, unknown routes and model or output-limit overrides", async () => {
  const { createUnixSocketFetch } = await import("../dist/gateway.js");
  const fetchOverSocket = createUnixSocketFetch(socketPath);
  const send = (body, token = "attempt-capability-test") => fetchOverSocket("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "synthetic" }],
      ...body,
    }),
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
    profile,
    maxInputBytes: 2048,
    maxOutputTokens: 64,
    maxRequests: 1,
    dispatchToFilter: { dispatch: async () => new globalThis.Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }) },
  });
  await new Promise((resolve) => limited.listen(secondSocket, resolve));
  const { createUnixSocketFetch } = await import("../dist/gateway.js");
  const fetchOverSocket = createUnixSocketFetch(secondSocket);
  const request = () => fetchOverSocket("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer redirect-capability", "content-type": "application/json" },
    body: JSON.stringify({ model: "test-model", max_tokens: 1, messages: [{ role: "user", content: "synthetic" }] }),
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
    profile,
    maxInputBytes: 1024,
    maxOutputTokens: 16,
    maxRequests: 1,
    dispatchToFilter: { dispatch: async () => new globalThis.Response("fixture-response", { headers: { "content-type": "text/plain" } }) },
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
      body: JSON.stringify({ model: "test-model", max_tokens: 4, messages: [{ role: "user", content: "synthetic" }] }),
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
    profile,
    maxInputBytes: 1024,
    maxOutputTokens: 16,
    maxRequests: 1,
    dispatchToFilter: { dispatch: async ({ signal }) => {
      announceStarted();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          providerAborted = true;
          announceAborted();
          reject(new globalThis.DOMException("aborted", "AbortError"));
        }, { once: true });
      });
      return globalThis.Response.json({});
    } },
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
      body: JSON.stringify({
        model: "test-model", max_tokens: 1, messages: [{ role: "user", content: "synthetic cancellation" }],
      }),
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
