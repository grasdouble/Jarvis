import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { resolveProviderCatalog } from "@jarvis/llm";
import { createBoundedGateway, createLoopbackGatewayBridge, createUnixSocketFetch } from "../dist/gateway.js";

let directory;
let socketPath;
let gateway;
const profile = resolveProviderCatalog({
  activeProfileId: "copilot",
  profiles: {
    copilot: { modelId: "test-model", contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities: ["chat-completions", "streaming", "cancellation", "context-budget"] },
    openai: { modelId: "other-model", contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities: ["chat-completions", "streaming", "cancellation", "context-budget"] },
  },
}).active;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "jarvis-runtime-correlation-"));
  socketPath = join(directory, "gateway.sock");
});
after(async () => {
  if (gateway) await new Promise((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("runtime usage can arrive before gateway completion and remains tied to its dispatch ID", async () => {
  const events = [];
  let completeGatewayOutcome;
  let announceGatewayOutcome;
  const gatewayOutcome = new Promise((resolve) => { announceGatewayOutcome = resolve; });
  gateway = createBoundedGateway({
    socketPath, capability: "attempt-capability", profile, maxInputBytes: 2048, maxOutputTokens: 16, maxRequests: 1,
    accounting: {
      async recordIntent() {}, async markDispatched() {},
      async recordOutcome(identity, usage) {
        await new Promise((resolve) => {
          completeGatewayOutcome = () => {
            events.push({ source: "gateway", id: identity.operationId, usage });
            resolve();
            announceGatewayOutcome();
          };
        });
      },
      async recordRuntimeObservation(id, usage) { events.push({ source: "runtime", id, usage }); },
    },
    dispatchToFilter: { dispatch: async () => Response.json({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }) },
  });
  await new Promise((resolve) => gateway.listen(socketPath, resolve));
  const unauthorized = await createUnixSocketFetch(socketPath)("http://127.0.0.1/__jarvis/usage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dispatchId: "f6a6d82b-5d4a-4dc2-b780-6d331458e108", usage: { inputTotal: 1 } }),
  });
  assert.equal(unauthorized.status, 403);
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve) => probe.close(resolve));
  const bridge = createLoopbackGatewayBridge({ socketPath, capability: "attempt-capability", port: address.port });
  try {
    await new Promise((resolve) => bridge.once("listening", resolve));
    const endpoint = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] }),
    });
    const dispatchId = response.headers.get("x-jarvis-dispatch-id");
    assert.match(dispatchId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.deepEqual(events, []);
    const runtime = await fetch(`${endpoint}/__jarvis/usage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispatchId, usage: { inputTotal: 7, outputTotal: 3 } }),
    });
    assert.equal(runtime.status, 204);
    assert.equal((await fetch(`${endpoint}/__jarvis/usage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usage: { inputTotal: 1 } }),
    })).status, 400);
    assert.equal((await fetch(`${endpoint}/__jarvis/usage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispatchId, usage: { inputTotal: 1, private_text: "must be rejected" } }),
    })).status, 400);
    assert.deepEqual(events.map(({ source, id }) => [source, id]), [["runtime", dispatchId]]);
    completeGatewayOutcome();
    await gatewayOutcome;
    assert.deepEqual(events.map(({ source, id }) => [source, id]), [["runtime", dispatchId], ["gateway", dispatchId]]);
    assert.deepEqual(events[0].usage.counters, {
      inputTotal: 7, outputTotal: 3, cacheReadInput: null, cacheWriteInput: null, reasoningOutput: null,
    });
  } finally {
    await new Promise((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
  }
});
