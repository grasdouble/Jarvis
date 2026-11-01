import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveProviderCatalog } from "../../packages/llm/dist/profiles.js";
import { listenUsageAccounting } from "../../apps/api/dist/usage-accounting.js";
import {
  createBoundedGateway,
  createLoopbackGatewayBridge,
  createUnixAccountingClient,
} from "../../apps/llm-gateway/dist/gateway.js";
import plugin from "./opencode-usage-plugin.mjs";

const profile = resolveProviderCatalog({
  activeProfileId: "openai",
  profiles: {
    copilot: { modelId: "copilot-test", contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities: ["chat-completions", "streaming", "cancellation", "context-budget"] },
    openai: { modelId: "openai-test", contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities: ["chat-completions", "streaming", "cancellation", "context-budget"] },
  },
}).active;

test("authenticated bridge and API UDS persist exact runtime ID before non-additive gateway outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-runtime-uds-"));
  const apiSocket = join(directory, "api.sock");
  const gatewaySocket = join(directory, "gateway.sock");
  const attempts = new Map();
  const observations = new Map();
  const order = [];
  let finishGateway;
  let gatewayStored;
  let runtimeStored;
  const gatewayStoredPromise = new Promise((resolve) => { gatewayStored = resolve; });
  const runtimeStoredPromise = new Promise((resolve) => { runtimeStored = resolve; });
  const store = {
    async recordIntent(identity) {
      attempts.set(identity.operationId, { ...identity, lifecycle: "prepared" });
      return randomUUID();
    },
    async markDispatched(identity) {
      const attempt = attempts.get(identity.operationId);
      assert.ok(attempt);
      assert.equal(attempt.taskId, identity.taskId);
      attempt.lifecycle = "dispatched";
    },
    async recordObservation(identity, observation, lifecycle) {
      const attempt = attempts.get(identity.operationId);
      assert.ok(attempt, "gateway outcome is bound to its own durable operation");
      assert.equal(observation.source, "gateway");
      observations.set(`${identity.operationId}:gateway`, observation);
      attempt.lifecycle = lifecycle;
      order.push("gateway");
      gatewayStored();
    },
    async recordRuntimeObservation(dispatchId, usage) {
      const attempt = attempts.get(dispatchId);
      assert.ok(attempt, "runtime IDs without a matching durable dispatch are rejected");
      const key = `${dispatchId}:runtime`;
      if (!observations.has(key)) {
        observations.set(key, usage);
        order.push("runtime");
        runtimeStored();
      }
    },
  };
  const api = await listenUsageAccounting({ path: apiSocket, store });
  const accounting = createUnixAccountingClient(apiSocket, {
    taskId: "task-301", attemptId: "attempt-301", leaseEpoch: 1,
  });
  const gateway = createBoundedGateway({
    socketPath: gatewaySocket, capability: "attempt-capability", profile,
    maxInputBytes: 4096, maxOutputTokens: 64, maxRequests: 2,
    accounting: {
      ...accounting,
      async recordOutcome(...args) {
        await new Promise((resolve) => { finishGateway = resolve; });
        await accounting.recordOutcome(...args);
      },
    },
    dispatchToFilter: { dispatch: async () => Response.json({ usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }) },
  });
  await new Promise((resolve) => gateway.listen(gatewaySocket, resolve));
  const bridge = createLoopbackGatewayBridge({ socketPath: gatewaySocket, capability: "attempt-capability", port: 4010 });
  const originalProfileId = process.env.LLM_GATEWAY_PROFILE_ID;
  process.env.LLM_GATEWAY_PROFILE_ID = "openai";
  try {
    await new Promise((resolve) => bridge.once("listening", resolve));
    const endpoint = "http://127.0.0.1:4010";
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: profile.modelId, max_tokens: 16, messages: [{ role: "user", content: "synthetic" }] }),
    });
    const dispatchId = response.headers.get("x-jarvis-dispatch-id");
    assert.match(dispatchId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(response.status, 200);
    const hooks = await plugin();
    await hooks["http.response"]({ response });
    await response.arrayBuffer();
    await runtimeStoredPromise;
    assert.equal(observations.has(`${dispatchId}:gateway`), false, "gateway outcome is deliberately still pending");
    const report = { dispatchId, usage: { inputTotal: 12, outputTotal: 4 } };
    assert.equal((await fetch(`${endpoint}/__jarvis/usage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report),
    })).status, 204);
    assert.equal((await fetch(`${endpoint}/__jarvis/usage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report),
    })).status, 204, "replayed report remains idempotent");
    assert.equal((await fetch(`${endpoint}/__jarvis/usage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dispatchId: randomUUID(), usage: { inputTotal: 999 } }),
    })).status, 400, "unmatched dispatch IDs are not associated with another request");
    assert.equal((await fetch(`${endpoint}/__jarvis/usage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dispatchId, usage: { inputTotal: "12" } }),
    })).status, 400, "non-numeric counters are rejected");
    assert.deepEqual(order, ["runtime"]);
    finishGateway();
    await gatewayStoredPromise;
    assert.deepEqual(order, ["runtime", "gateway"]);
    assert.equal(observations.get(`${dispatchId}:runtime`).counters.inputTotal, 12);
    assert.equal(observations.get(`${dispatchId}:gateway`).usage.counters.inputTotal, 12,
      "runtime evidence does not overwrite canonical gateway usage");
    assert.equal(observations.size, 2, "one dispatch has separate non-additive source observations");
  } finally {
    if (originalProfileId === undefined) delete process.env.LLM_GATEWAY_PROFILE_ID;
    else process.env.LLM_GATEWAY_PROFILE_ID = originalProfileId;
    await new Promise((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
