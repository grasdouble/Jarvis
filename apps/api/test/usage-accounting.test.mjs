import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listenUsageAccounting } from "../dist/usage-accounting.js";

function send(socketPath, path, payload) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const body = Buffer.from(JSON.stringify(payload));
  const req = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": body.byteLength } }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
  });
  req.once("error", reject);
  req.end(body);
  return promise;
}

test("API accounting socket accepts bounded attempt events and rejects schema expansion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-accounting-"));
  const socketPath = join(directory, "accounting.sock");
  const events = [];
  const store = {
    async recordIntent(value) { events.push(["intent", value]); return "55555555-5555-4555-8555-555555555555"; },
    async markDispatched(value) { events.push(["dispatched", value]); },
    async recordObservation(attribution, observation, lifecycle) { events.push(["observation", attribution, observation, lifecycle]); },
    async recordRuntimeObservation(dispatchId, usage) { events.push(["runtime", dispatchId, usage]); },
  };
  const server = await listenUsageAccounting({ path: socketPath, store });
  const attribution = {
    operationId: "11111111-1111-4111-8111-111111111111", taskId: "22222222-2222-4222-8222-222222222222",
    attemptId: "33333333-3333-4333-8333-333333333333", leaseEpoch: 4, dispatchAttempt: 1,
    provider: "openai", model: "gpt-test", purpose: "task_execution",
  };
  try {
    assert.equal((await stat(socketPath)).mode & 0o777, 0o660);
    const intent = await send(socketPath, "/v1/usage/intent", { attribution });
    assert.equal(intent.status, 200);
    assert.equal(JSON.parse(intent.body).modelRequestId, "55555555-5555-4555-8555-555555555555");
    assert.equal((await send(socketPath, "/v1/usage/dispatched", { attribution })).status, 204);
    const usage = {
      mappingVersion: "openai-chat-completions-v1",
      counters: { inputTotal: 2000, outputTotal: 300, cacheReadInput: 1500, cacheWriteInput: null, reasoningOutput: 100 },
      coverage: { inputTotal: "reported", outputTotal: "reported", cacheReadInput: "reported", cacheWriteInput: "not_supported", reasoningOutput: "reported" },
    };
    const quota = {
      mappingVersion: "openai-rate-limit-headers-v1", source: "provider-response-header", provider: "openai",
      observedAt: "2026-11-01T12:00:00.000Z", freshness: "current",
      counters: { requestLimit: 100, requestRemaining: 90, tokenLimit: 10000, tokenRemaining: 8500 },
      coverage: { requestLimit: "reported", requestRemaining: "reported", tokenLimit: "reported", tokenRemaining: "reported" },
    };
    const result = await send(socketPath, "/v1/usage/observation", { attribution, lifecycle: "succeeded", observation: {
      source: "gateway", observationId: attribution.operationId, revision: 1, observedAt: "2026-11-01T12:00:00.000Z", freshness: "current", usage, quota,
    } });
    assert.equal(result.status, 204);
    assert.deepEqual(events[2][2].quota, quota);
    assert.deepEqual(events.map(([kind]) => kind), ["intent", "dispatched", "observation"]);
    const runtimeUsage = {
      mappingVersion: "opencode-runtime-usage-v1",
      counters: { inputTotal: 11, outputTotal: 4, cacheReadInput: null, cacheWriteInput: null, reasoningOutput: null },
      coverage: { inputTotal: "reported", outputTotal: "reported", cacheReadInput: "unknown", cacheWriteInput: "unknown", reasoningOutput: "unknown" },
    };
    assert.equal((await send(socketPath, "/v1/usage/runtime-observation", {
      dispatchId: attribution.operationId, usage: runtimeUsage,
    })).status, 204);
    assert.deepEqual(events[3], ["runtime", attribution.operationId, runtimeUsage]);
    assert.equal((await send(socketPath, "/v1/usage/runtime-observation", {
      dispatchId: "not-a-dispatch", usage: runtimeUsage,
    })).status, 400);
    assert.equal((await send(socketPath, "/v1/usage/runtime-observation", {
      dispatchId: attribution.operationId, usage: { ...runtimeUsage, prompt: "secret" },
    })).status, 400);
    assert.equal(events[2][3], "succeeded");
    assert.equal((await send(socketPath, "/v1/usage/intent", { attribution, prompt: "must be refused" })).status, 400);
    assert.equal((await send(socketPath, "/v1/usage/observation", { attribution, lifecycle: "succeeded", observation: {
      source: "gateway", observationId: attribution.operationId, revision: 1, observedAt: "2026-11-01T12:00:00.000Z", freshness: "current", usage: { ...usage, prompt: "must be refused" },
    } })).status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
