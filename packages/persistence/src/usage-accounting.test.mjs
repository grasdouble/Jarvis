import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresUsageAccountingStore, UsageAccountingRejectedError } from "../dist/index.js";

const attribution = {
  operationId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  leaseEpoch: 4, dispatchAttempt: 1, provider: "openai", model: "gpt-test", purpose: "task_execution",
};
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
const observation = { source: "gateway", observationId: attribution.operationId, revision: 2, observedAt: "2026-11-01T12:00:00.000Z", freshness: "current", usage, quota };

function fakePool(handler) {
  const calls = [];
  return {
    calls,
    async connect() {
      return {
        async query(text, values = []) { calls.push({ text, values }); return handler(text, values); },
        release() {},
      };
    },
  };
}

test("intent persistence is lease-fenced and its operation/dispatch identity replays idempotently", async () => {
  let inserted = false;
  const pool = fakePool((text) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: null };
    if (text.startsWith("SELECT id,task_id,attempt_id")) return inserted
      ? { rows: [{ id: "55555555-5555-4555-8555-555555555555", task_id: attribution.taskId, attempt_id: attribution.attemptId, provider: attribution.provider, model: attribution.model, purpose: attribution.purpose }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
    if (text.includes("SELECT r.id AS request_id")) return { rows: [{ request_id: "44444444-4444-4444-8444-444444444444" }], rowCount: 1 };
    if (text.startsWith("INSERT INTO jarvis.model_requests")) { inserted = true; return { rows: [{ id: "55555555-5555-4555-8555-555555555555" }], rowCount: 1 }; }
    throw new Error(`Unexpected query: ${text}`);
  });
  const store = new PostgresUsageAccountingStore(pool);
  assert.equal(await store.recordIntent(attribution), "55555555-5555-4555-8555-555555555555");
  assert.equal(await store.recordIntent(attribution), "55555555-5555-4555-8555-555555555555");
});

test("replay-100x and out-of-order observations preserve the single highest-revision canonical record", async () => {
  const stored = new Map();
  let ledger;
  const pool = fakePool((text, values) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: null };
    if (text.includes("SELECT mr.id FROM jarvis.model_requests")) return { rows: [{ id: "55555555-5555-4555-8555-555555555555" }], rowCount: 1 };
    if (text.startsWith("INSERT INTO jarvis.usage_observations")) {
      const key = values.slice(0, 4).join(":");
      if (stored.has(key)) return { rows: [], rowCount: 0 };
      stored.set(key, { numeric_usage: JSON.parse(values[4]), field_statuses: JSON.parse(values[5]), revision: values[3], observed_at: new Date(values[8]), quota_signals: values[10] === null ? null : JSON.parse(values[10]) });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE jarvis.model_requests")) return { rows: [], rowCount: 1 };
    if (text.startsWith("SELECT numeric_usage")) {
      const ordered = [...stored.values()].sort((a, b) => b.revision - a.revision || b.observed_at - a.observed_at);
      return ordered.length ? { rows: [ordered[0]], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (text.startsWith("INSERT INTO jarvis.usage_ledger")) {
      if (!ledger || values[1] > ledger.revision || (values[1] === ledger.revision && values[5] >= ledger.observed_at)) {
        ledger = { revision: values[1], numeric_usage: JSON.parse(values[2]), field_statuses: JSON.parse(values[3]), observed_at: values[5] };
      }
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${text}`);
  });
  const store = new PostgresUsageAccountingStore(pool);
  for (let i = 0; i < 100; i += 1) await store.recordObservation(attribution, observation, "succeeded");
  const old = { ...observation, observationId: "old-revision", revision: 1, observedAt: "2026-11-01T12:30:00.000Z",
    usage: { ...usage, counters: { ...usage.counters, inputTotal: 3 } } };
  await store.recordObservation(attribution, old, "succeeded");
  assert.equal(stored.size, 2);
  assert.deepEqual([...stored.values()][0].quota_signals, quota);
  assert.equal(ledger.revision, 2);
  assert.equal(ledger.numeric_usage.inputTotal, 2000);
  assert.equal(ledger.field_statuses.outputTotal, "reported");
});
test("runtime corroboration binds one dispatch, replays idempotently, and never updates canonical totals", async () => {
  const dispatchId = attribution.operationId;
  const runtimeRows = new Map();
  let allowDispatch = true;
  let runtimeCoverage = "unknown";
  const pool = fakePool((text, values) => {
    if (text.startsWith("UPDATE jarvis.model_requests SET runtime_coverage='observed'")) {
      runtimeCoverage = "observed";
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("SELECT id FROM jarvis.model_requests")) {
      return { rowCount: allowDispatch && values[0] === dispatchId ? 1 : 0, rows: allowDispatch && values[0] === dispatchId ? [{ id: "request-1" }] : [] };
    }
    if (text.startsWith("INSERT INTO jarvis.usage_observations")) {
      const [requestId, observationId, counters, coverage] = values;
      const key = [requestId, "runtime", observationId, 1].join(":");
      if (!runtimeRows.has(key)) runtimeRows.set(key, { requestId, source: "runtime", observationId, revision: 1, numeric: JSON.parse(counters), coverage: JSON.parse(coverage) });
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });
  const store = new PostgresUsageAccountingStore(pool);
  const runtime = {
    mappingVersion: "opencode-runtime-usage-v1",
    counters: { inputTotal: 2000, outputTotal: 300, cacheReadInput: null, cacheWriteInput: null, reasoningOutput: 100 },
    coverage: { inputTotal: "reported", outputTotal: "reported", cacheReadInput: "unknown", cacheWriteInput: "unknown", reasoningOutput: "reported" },
  };
  for (let i = 0; i < 100; i += 1) await store.recordRuntimeObservation(dispatchId, runtime);
  assert.equal(runtimeCoverage, "observed");
  assert.equal(pool.calls.filter(({ text }) => text.startsWith("UPDATE jarvis.model_requests SET runtime_coverage")).length, 100);
  assert.equal(runtimeRows.size, 1);
  assert.deepEqual([...runtimeRows.values()][0], {
    requestId: "request-1", source: "runtime", observationId: dispatchId, revision: 1,
    numeric: runtime.counters, coverage: runtime.coverage,
  });
  await assert.rejects(store.recordRuntimeObservation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", runtime), UsageAccountingRejectedError);
  allowDispatch = false;
  await assert.rejects(store.recordRuntimeObservation(dispatchId, runtime), UsageAccountingRejectedError);
  await assert.rejects(store.recordRuntimeObservation(dispatchId, {
    ...runtime, counters: { ...runtime.counters, outputTotal: -1 },
  }), UsageAccountingRejectedError);
});
test("startup recovery marks only unfinished durable attempts unknown and is idempotent", async () => {
  const lifecycle = new Map([["prepared-1", "prepared"], ["dispatched-1", "dispatched"], ["completed-1", "succeeded"]]);
  const pool = fakePool((text) => {
    let changed = 0;
    for (const [id, state] of lifecycle) {
      if (state === "prepared" || state === "dispatched") { lifecycle.set(id, "unknown"); changed += 1; }
    }
    return { rowCount: changed, rows: [] };
  });
  const store = new PostgresUsageAccountingStore(pool);
  assert.equal(await store.reconcileInterrupted(), 2);
  assert.deepEqual([...lifecycle.values()], ["unknown", "unknown", "succeeded"]);
  assert.equal(await store.reconcileInterrupted(), 0);
});

test("accounting rejects extra payload fields before they can reach SQL", async () => {
  let connected = false;
  const pool = { async connect() { connected = true; throw new Error("must not connect"); } };
  const store = new PostgresUsageAccountingStore(pool);
  await assert.rejects(store.recordObservation(attribution, { ...observation, usage: { ...usage, prompt: "must not persist" } }, "succeeded"), UsageAccountingRejectedError);
  await assert.rejects(store.recordObservation(attribution,
    { ...observation, quota: { ...quota, provider: "github-copilot" } }, "succeeded"), UsageAccountingRejectedError);
  assert.equal(connected, false);
});
