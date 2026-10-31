import assert from "node:assert/strict";
import test from "node:test";
import { PostgresQueueStore, PostgresTaskResultReadModel } from "../dist/index.js";

const result = {
  schemaVersion: 1,
  requestId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  leaseEpoch: 2,
  mode: "dev",
  sourceRevision: "a".repeat(40),
  snapshotDigest: "b".repeat(64),
  provider: "openai",
  model: "gpt-4.1",
  resultId: "44444444-4444-4444-8444-444444444444",
  payload: { summary: "Synthetic report", artifactId: "55555555-5555-4555-8555-555555555555", patchDigest: "c".repeat(64), changedPaths: ["src/index.ts"], limitations: [] },
};
const lease = { task: { id: "q1", taskId: result.taskId }, worker: "worker-1", attemptId: result.attemptId, epoch: 2, expiresAt: Date.now() + 10000 };
const savedRow = { id: "q1", task_id: result.taskId, event_id: "event-1", state: "succeeded", created_at: new Date(), available_at: new Date(), deadline: new Date(Date.now() + 10000), max_attempts: 3, attempt_count: 1, lease_epoch: 2, lease_until: null, worker_id: null, retry_base_delay_ms: 10, retry_max_delay_ms: 100, result_json: { kind: "report", id: result.resultId }, error_json: null };

function transactionPool({ failOutbox = false } = {}) {
  const calls = [];
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes("FOR UPDATE OF q")) return { rows: [{ id: lease.task.id }], rowCount: 1 };
      if (text.includes("UPDATE jarvis.queue_entries")) return { rows: [savedRow], rowCount: 1 };
      if (text.includes("INSERT INTO jarvis.task_results")) return { rows: [{ id: result.resultId }], rowCount: 1 };
      if (text.includes("UPDATE jarvis.task_attempts")) return { rows: [], rowCount: 1 };
      if (text.includes("INSERT INTO jarvis.outbox") && failOutbox) throw new Error("injected outbox failure");
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { calls, async connect() { return client; } };
}

test("stores canonical result and queue reference in one fenced transaction", async () => {
  const pool = transactionPool();
  const store = new PostgresQueueStore(pool);
  await store.update({ ...lease.task, eventId: "event-1", payload: { taskId: result.taskId }, status: "succeeded", createdAt: Date.now(), availableAt: Date.now(), deadline: Date.now() + 10000, maxAttempts: 3, attempt: 1, epoch: 2, retry: { baseDelay: 10, maxDelay: 100 }, result: { kind: "report", id: result.resultId } }, lease, result);
  assert.equal(pool.calls[0].text, "BEGIN");
  const insert = pool.calls.find(({ text }) => text.includes("INSERT INTO jarvis.task_results"));
  assert.ok(insert);
  assert.deepEqual(insert.values.slice(0, 5), [result.resultId, result.taskId, result.attemptId, result.leaseEpoch, result.requestId]);
  const outbox = pool.calls.find(({ text }) => text.includes("INSERT INTO jarvis.outbox"));
  assert.ok(outbox);
  assert.doesNotMatch(JSON.stringify(outbox.values), /Synthetic report|patchDigest|src\/index/);
  assert.equal(pool.calls.at(-1).text, "COMMIT");
});

test("rolls back canonical result when the same completion transaction fails", async () => {
  const pool = transactionPool({ failOutbox: true });
  const store = new PostgresQueueStore(pool);
  await assert.rejects(store.update({ ...lease.task, eventId: "event-1", payload: { taskId: result.taskId }, status: "succeeded", createdAt: Date.now(), availableAt: Date.now(), deadline: Date.now() + 10000, maxAttempts: 3, attempt: 1, epoch: 2, retry: { baseDelay: 10, maxDelay: 100 }, result: { kind: "report", id: result.resultId } }, lease, result), /injected outbox failure/);
  assert.equal(pool.calls.at(-1).text, "ROLLBACK");
});

test("rejects invalid identifiers and corrupted canonical results", async () => {
  const unusedPool = { async connect() { throw new Error("invalid identifiers must not reach storage"); } };
  assert.equal(await new PostgresTaskResultReadModel(unusedPool).getForOwner("owner", "not-a-task-id"), null);

  const corruptClient = {
    async query() { return { rows: [{ result_json: result, digest: "d".repeat(64) }], rowCount: 1 }; },
    release() {},
  };
  const corruptPool = { async connect() { return corruptClient; } };
  await assert.rejects(new PostgresTaskResultReadModel(corruptPool).getForOwner("owner", result.taskId), /integrity check failed/);
});
test("review queue completion remains successful without a plan/dev canonical envelope", async () => {
  const reviewTaskId = "66666666-6666-4666-8666-666666666666";
  const queueId = "review-queue-id";
  const activeLease = {
    task: { id: queueId, taskId: reviewTaskId },
    worker: "review-worker",
    attemptId: "77777777-7777-4777-8777-777777777777",
    epoch: 1,
    expiresAt: Date.now() + 10000,
  };
  let storedQueueResult;
  const client = {
    async query(text, values = []) {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (text === "SELECT mode FROM jarvis.tasks WHERE id = $1") return { rows: [{ mode: "review" }], rowCount: 1 };
      if (text.includes("UPDATE jarvis.queue_entries")) {
        storedQueueResult = JSON.parse(values[5]);
        return { rows: [{
          id: queueId, task_id: reviewTaskId, event_id: "review-event", state: values[3],
          created_at: new Date(), available_at: new Date(), deadline: new Date(Date.now() + 10000),
          max_attempts: 1, attempt_count: 1, lease_epoch: 1, lease_until: null, worker_id: null,
          retry_base_delay_ms: 10, retry_max_delay_ms: 100, result_json: storedQueueResult, error_json: null,
        }], rowCount: 1 };
      }
      if (text.includes("UPDATE jarvis.task_attempts")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const postgresQueue = new PostgresQueueStore({ async connect() { return client; } });
  const task = {
    ...activeLease.task, eventId: "review-event", payload: { taskId: reviewTaskId }, status: "leased",
    createdAt: Date.now(), availableAt: Date.now(), deadline: Date.now() + 10000, maxAttempts: 1,
    attempt: 1, epoch: 1, retry: { baseDelay: 10, maxDelay: 100 },
    lease: { worker: activeLease.worker, epoch: activeLease.epoch, expiresAt: activeLease.expiresAt },
  };
  const store = {
    enqueue: async (value) => value,
    claim: async () => activeLease,
    get: async () => task,
    update: (value, lease, canonical) => postgresQueue.update(value, lease, canonical),
    cancel: async () => task,
  };
  const { QueueService } = await import("@jarvis/queue");
  const queue = new QueueService({ store, clock: { now: () => Date.now() }, ids: { next: () => queueId } });
  const completed = await queue.complete(activeLease, { kind: "report", id: "88888888-8888-4888-8888-888888888888" });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.result?.kind, "report");
  assert.equal(storedQueueResult.id, "88888888-8888-4888-8888-888888888888");
});
test("plan reconciliation cannot report success without a canonical result", async () => {
  const taskId = "99999999-9999-4999-8999-999999999999";
  const queueId = "plan-reconciliation-queue";
  const storedTask = {
    id: queueId, taskId, eventId: "plan-reconcile-event", payload: { taskId }, status: "reconciliation_required",
    createdAt: Date.now(), availableAt: Date.now(), deadline: Date.now() + 10000, maxAttempts: 2,
    attempt: 1, epoch: 1, retry: { baseDelay: 10, maxDelay: 100 },
    error: { kind: "unknown_external", effectId: taskId },
  };
  const calls = [];
  const client = {
    async query(text) {
      calls.push(text);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (text === "SELECT mode FROM jarvis.tasks WHERE id = $1") return { rows: [{ mode: "plan" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const postgresQueue = new PostgresQueueStore({ async connect() { return client; } });
  const store = {
    enqueue: async (value) => value,
    claim: async () => null,
    get: async () => ({ ...storedTask }),
    update: (value, lease, canonical) => postgresQueue.update(value, lease, canonical),
    cancel: async () => ({ ...storedTask }),
  };
  const { QueueService } = await import("@jarvis/queue");
  const queue = new QueueService({ store, clock: { now: () => Date.now() }, ids: { next: () => queueId } });
  await assert.rejects(queue.reconcile(queueId, {
    outcome: "applied",
    result: { kind: "report", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  }), { code: "MISSING_CANONICAL_RESULT" });
  assert.equal(storedTask.status, "reconciliation_required");
  assert.equal(calls.some((statement) => statement.includes("UPDATE jarvis.queue_entries")), false);
  assert.equal(calls.at(-1), "ROLLBACK");
});
test("replayed result completion returns stale lease before persisting a duplicate", async () => {
  const calls = [];
  let insertedResults = 0;
  const client = {
    async query(text) {
      calls.push(text);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (text.includes("FROM jarvis.queue_entries q") && text.includes("FOR UPDATE OF q")) return { rows: [], rowCount: 0 };
      if (text.includes("INSERT INTO jarvis.task_results")) {
        insertedResults += 1;
        return { rows: [{ id: result.resultId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const store = new PostgresQueueStore({ async connect() { return client; } });
  const task = {
    ...lease.task, eventId: "event-1", payload: { taskId: result.taskId }, status: "succeeded",
    createdAt: Date.now(), availableAt: Date.now(), deadline: Date.now() + 10000, maxAttempts: 3,
    attempt: 1, epoch: lease.epoch, retry: { baseDelay: 10, maxDelay: 100 },
    result: { kind: "report", id: result.resultId },
  };
  await assert.rejects(store.update(task, lease, result), { code: "STALE_LEASE" });
  assert.equal(insertedResults, 0);
  assert.equal(calls.at(-1), "ROLLBACK");
});
