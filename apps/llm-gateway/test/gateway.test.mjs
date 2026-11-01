import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "node:http";

import { resolveProviderCatalog } from "@jarvis/llm";
import { createBoundedGateway, createConfiguredGateway, createUnixSocketFetch, listenGatewaySocket } from "../dist/gateway.js";

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
  await new Promise((resolve) => listenGatewaySocket(gateway, socketPath).once("listening", resolve));
});

after(async () => {
  await new Promise((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
});

test("gateway UDS is group-writable for the trusted broker without world permissions", async () => {
  assert.equal((await stat(socketPath)).mode & 0o777, 0o660);
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
  const accountingEvents = [];
  const configured = createConfiguredGateway({
    socketPath: configuredSocket,
    egressConfig: { providers: [], dispatch_enabled: false, filterCapability: "e".repeat(64) },
    gatewayConfig: {
      accounting: { taskId: "00000000-0000-4000-8000-000000000001", attemptId: "00000000-0000-4000-8000-000000000002", leaseEpoch: 1 },
      dispatch_enabled: true, profile,
      filterHost: "jarvis-egress-filter-00000000-0000-4000-8000-000000000251", filterPort: 8080,
    },
    accounting: {
      recordIntent: async () => accountingEvents.push("intent"),
      markDispatched: async () => accountingEvents.push("dispatched"),
      recordOutcome: async () => accountingEvents.push("outcome"),
    },
    maxInputBytes: 2048,
    maxOutputTokens: 64,
    maxRequests: 2,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      accountingEvents.push("filter");
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
    assert.deepEqual(accountingEvents, ["intent", "dispatched", "filter", "outcome"]);
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
      accounting: { taskId: "00000000-0000-4000-8000-000000000001", attemptId: "00000000-0000-4000-8000-000000000002", leaseEpoch: 1 },
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
      accounting: { taskId: "00000000-0000-4000-8000-000000000001", attemptId: "00000000-0000-4000-8000-000000000002", leaseEpoch: 1 },
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
  await assert.rejects(() => fetchOverSocket("http://127.0.0.1/v1/models", { method: "POST" }), /fixed provider and runtime-accounting routes/);
  assert.equal((await send({ model: "attacker-model", max_tokens: 1 })).status, 400);
  assert.equal((await send({ model: "test-model", max_tokens: 65 })).status, 400);
  assert.equal((await send({ model: "test-model", max_completion_tokens: 64 })).status, 200);
  assert.equal((await send({ model: "test-model", max_completion_tokens: 65 })).status, 400);
  assert.equal((await send({ model: "test-model", max_tokens: 1, max_completion_tokens: 65 })).status, 400);
  assert.equal(upstreamCalls.length, 2);
});
test("OpenAI streaming usage is incrementally extracted while response bytes are forwarded transparently", async () => {
  const catalog = resolveProviderCatalog({
    activeProfileId: "openai",
    profiles: {
      copilot: { modelId: "test-model", contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities: ["chat-completions", "streaming", "cancellation", "context-budget"] },
      openai: { modelId: "other-model", contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities: ["chat-completions", "streaming", "cancellation", "context-budget"] },
    },
  });
  const streamSocket = join(directory, "openai-stream.sock");
  const outcomes = [];
  const events = [];
  const server = createBoundedGateway({
    socketPath: streamSocket, capability: "openai-stream-capability", profile: catalog.profiles.openai,
    maxInputBytes: 2048, maxOutputTokens: 64, maxRequests: 1,
    accounting: {
      async recordIntent() { events.push("intent"); },
      async markDispatched() { events.push("dispatched"); },
      async recordOutcome(_identity, usage, lifecycle, quota) { events.push("observation"); outcomes.push({ usage, lifecycle, quota }); },
    },
    dispatchToFilter: { dispatch: async () => {
      const body = 'data: {"choices":[{"delta":{"content":"ok"}}],"usage":null}\n\n' +
        "data: {malformed}\n\n" +
        'data: {"choices":[{"delta":{"content":"private response text"}}],"usage":{"prompt_tokens":12,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":1}},"provider_extra":"not retained"}\n\n' +
        "data: [DONE]\n\n";
      const split = [body.slice(0, 8), body.slice(8, 51), body.slice(51, 106), body.slice(106)];
      return new globalThis.Response(new ReadableStream({
        start(controller) { for (const chunk of split) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
      }), { headers: {

        "content-type": "text/event-stream",
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "93",
        "x-ratelimit-limit-tokens": "5000",
        "x-ratelimit-remaining-tokens": "4200",
      } });
    } },
  });
  await new Promise((resolve) => server.listen(streamSocket, resolve));
  try {
    const response = await createUnixSocketFetch(streamSocket)("http://127.0.0.1/v1/chat/completions", {
      method: "POST", headers: { authorization: "Bearer openai-stream-capability", "content-type": "application/json" },
      body: JSON.stringify({ model: "other-model", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] }),
    });
    assert.equal(await response.text(), 'data: {"choices":[{"delta":{"content":"ok"}}],"usage":null}\n\n' +
      "data: {malformed}\n\n" +
      'data: {"choices":[{"delta":{"content":"private response text"}}],"usage":{"prompt_tokens":12,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":1}},"provider_extra":"not retained"}\n\n' +
      "data: [DONE]\n\n");
    assert.deepEqual(events, ["intent", "dispatched", "observation"]);
    assert.equal(outcomes[0].lifecycle, "succeeded");
    assert.deepEqual(outcomes[0].usage.counters, { inputTotal: 12, outputTotal: 7, cacheReadInput: 2, cacheWriteInput: null, reasoningOutput: 1 });
    assert.doesNotMatch(JSON.stringify(outcomes[0].usage), /private response text|provider_extra|choices/);
    assert.deepEqual(outcomes[0].quota.counters, { requestLimit: 100, requestRemaining: 93, tokenLimit: 5000, tokenRemaining: 4200 });
    assert.equal(outcomes[0].quota.source, "provider-response-header");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Copilot responses retain unknown usage and quota coverage when OpenAI-shaped fields appear", async () => {
  const copilotSocket = join(directory, "copilot-unknown.sock");
  const outcomes = [];
  const server = createBoundedGateway({
    socketPath: copilotSocket, capability: "copilot-unknown-capability", profile,
    maxInputBytes: 2048, maxOutputTokens: 64, maxRequests: 1,
    accounting: {
      async recordIntent() {}, async markDispatched() {},
      async recordOutcome(_identity, usage, _lifecycle, quota) { outcomes.push({ usage, quota }); },
    },
    dispatchToFilter: { dispatch: async () => globalThis.Response.json({
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    }, { headers: { "x-ratelimit-limit-requests": "12" } }) },
  });
  await new Promise((resolve) => server.listen(copilotSocket, resolve));
  try {
    const response = await createUnixSocketFetch(copilotSocket)("http://127.0.0.1/v1/chat/completions", {
      method: "POST", headers: { authorization: "Bearer copilot-unknown-capability", "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(outcomes[0].usage.counters, { inputTotal: null, outputTotal: null, cacheReadInput: null, cacheWriteInput: null, reasoningOutput: null });
    assert.deepEqual(outcomes[0].quota.coverage, { requestLimit: "unknown", requestRemaining: "unknown", tokenLimit: "unknown", tokenRemaining: "unknown" });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
test("oversized provider responses retain reported quota while token usage remains unknown", async () => {
  const catalog = resolveProviderCatalog({
    activeProfileId: "openai",
    profiles: {
      copilot: { modelId: "copilot-model", contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities: ["chat-completions", "streaming", "cancellation", "context-budget"] },
      openai: { modelId: "oversized-model", contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities: ["chat-completions", "streaming", "cancellation", "context-budget"] },
    },
  });
  const quotaProfile = catalog.profiles.openai;
  const oversizedSocket = join(directory, "oversized-response.sock");
  let resolveOutcome;
  const recorded = new Promise((resolve) => { resolveOutcome = resolve; });
  let outcome;
  const server = createBoundedGateway({
    socketPath: oversizedSocket, capability: "oversized-response-capability", profile: quotaProfile,
    maxInputBytes: 2048, maxResponseBytes: 1, maxOutputTokens: 64, maxRequests: 1,
    accounting: {
      async recordIntent() {}, async markDispatched() {},
      async recordOutcome(_identity, usage, lifecycle, quota) { outcome = { usage, lifecycle, quota }; resolveOutcome(); },
    },
    dispatchToFilter: { dispatch: async () => new globalThis.Response("oversized synthetic response", {
      headers: {
        "content-type": "text/plain",
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "91",
      },
    }) },
  });
  await new Promise((resolve) => server.listen(oversizedSocket, resolve));
  try {
    await assert.rejects(createUnixSocketFetch(oversizedSocket)("http://127.0.0.1/v1/chat/completions", {
      method: "POST", headers: { authorization: "Bearer oversized-response-capability", "content-type": "application/json" },
      body: JSON.stringify({ model: "oversized-model", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] }),
    }), { code: "ECONNRESET" });
    await recorded;
    assert.equal(outcome.lifecycle, "unknown");
    assert.equal(outcome.usage.counters.inputTotal, null);
    assert.equal(outcome.usage.coverage.inputTotal, "unknown");
    assert.equal(outcome.quota.counters.requestLimit, 100);
    assert.equal(outcome.quota.counters.requestRemaining, 91);
    assert.equal(outcome.quota.coverage.requestRemaining, "reported");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
test("oversized SSE line disables extraction while preserving transparent response bytes", async () => {
  const catalog = resolveProviderCatalog({
    activeProfileId: "openai",
    profiles: {
      copilot: { modelId: "test-model", contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities: ["chat-completions", "streaming", "cancellation", "context-budget"] },
      openai: { modelId: "oversized-model", contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities: ["chat-completions", "streaming", "cancellation", "context-budget"] },
    },
  });
  const socket = join(directory, "oversized-sse.sock");
  const outcomes = [];
  const oversized = `data: ${"x".repeat(17 * 1024)}\n\n`;
  const body = oversized + 'data: {"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\n';
  const server = createBoundedGateway({
    socketPath: socket, capability: "oversized-capability", profile: catalog.profiles.openai,
    maxInputBytes: 2048, maxOutputTokens: 64, maxRequests: 1,
    accounting: {
      async recordIntent() {}, async markDispatched() {},
      async recordOutcome(_identity, usage) { outcomes.push(usage); },
    },
    dispatchToFilter: { dispatch: async () => new globalThis.Response(body, { headers: { "content-type": "text/event-stream" } }) },
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  try {
    const response = await createUnixSocketFetch(socket)("http://127.0.0.1/v1/chat/completions", {
      method: "POST", headers: { authorization: "Bearer oversized-capability", "content-type": "application/json" },
      body: JSON.stringify({ model: "oversized-model", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] }),
    });
    assert.equal(await response.text(), body);
    assert.equal(outcomes[0].coverage.inputTotal, "unknown");
    assert.equal(outcomes[0].counters.inputTotal, null);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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
  let capturedOutcome;
  let resolveOutcome;
  const outcomeRecorded = new Promise((resolve) => { resolveOutcome = resolve; });
  const provider = createBoundedGateway({
    socketPath: cancelSocket,
    capability: "cancel-attempt-capability",
    profile,
    maxInputBytes: 1024,
    maxOutputTokens: 16,
    maxRequests: 1,
    accounting: {
      async recordIntent() {}, async markDispatched() {},
      async recordOutcome(_identity, usage, lifecycle) { capturedOutcome = { usage, lifecycle }; resolveOutcome(); },
    },
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
    await outcomeRecorded;
    assert.equal(capturedOutcome.lifecycle, "cancelled");
    assert.deepEqual(capturedOutcome.usage.counters, { inputTotal: null, outputTotal: null, cacheReadInput: null, cacheWriteInput: null, reasoningOutput: null });
  } finally {
    await new Promise((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});
