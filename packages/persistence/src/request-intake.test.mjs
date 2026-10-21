import assert from "node:assert/strict";
import { test } from "node:test";
import * as persistence from "../dist/index.js";

function poolFor(results) {
  const calls = [];
  const client = { async query(text, values = []) { calls.push({ text, values }); return results.shift() ?? { rows: [], rowCount: 0 }; }, release() {} };
  return { calls, async connect() { return client; } };
}

test("PostgresRequestIntakeStore is available for durable admission", () => {
  assert.equal(typeof persistence.PostgresRequestIntakeStore, "function");
});

test("ambiguous durable intake commits only the clarification record", async () => {
  const saved = {
    id: "00000000-0000-4000-8000-000000000001", owner_id: "owner", project_id: null, repository_id: null,
    mode: null, request_kind: "project", prompt: "unclear", prompt_digest: "a".repeat(64), request_digest: "b".repeat(64),
    config_version: null, policy_hash: null, state: "clarification", clarification: ["project", "mode"],
    idempotency_key: "k", selector: null, explicit_mode: null, explicit_kind: null, version: 1, profile_hash: null,
  };
  const pool = poolFor([{ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }, { rows: [saved], rowCount: 1 }]);
  const store = new persistence.PostgresRequestIntakeStore(pool);
  const result = await store.create({
    id: saved.id, ownerId: "owner", projectId: null, repositoryId: null, mode: null, kind: "project", prompt: "unclear",
    promptDigest: "a".repeat(64), requestDigest: "b".repeat(64), configVersion: null, policyHash: null, profileHash: null,
    state: "clarification", clarification: ["project", "mode"], idempotencyKey: "k", selector: null,
    explicitMode: null, explicitKind: null, version: 1,
  });
  assert.equal(result.state, "clarification");
  assert.equal(pool.calls[0].text, "BEGIN");
  assert.match(pool.calls[2].text, /INSERT INTO jarvis\.requests/);
  assert.equal(pool.calls.at(-1).text, "COMMIT");
  assert.equal(pool.calls.some(({ text }) => /INSERT INTO jarvis\.(tasks|queue_entries|outbox|task_attempts)/i.test(text)), false);
});

test("authorized durable admission atomically creates the task, queue entry, and outbox event", async () => {
  const saved = {
    id: "00000000-0000-4000-8000-000000000002", owner_id: "owner", project_id: "p1", repository_id: "3001",
    mode: "dev", request_kind: "dependency_update", prompt: "Update deps", prompt_digest: "a".repeat(64),
    request_digest: "b".repeat(64), config_version: 1, policy_hash: "c".repeat(64), state: "queued", clarification: [],
    idempotency_key: "k2", selector: "p1", explicit_mode: "dev", explicit_kind: "dependency_update", version: 1,
    profile_hash: "d".repeat(64),
  };
  const pool = poolFor([
    { rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }, { rows: [{ id: "p1" }], rowCount: 1 }, { rows: [saved], rowCount: 1 },
    { rows: [{ id: "task1" }], rowCount: 1 }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 },
  ]);
  const store = new persistence.PostgresRequestIntakeStore(pool);
  const result = await store.create({
    id: saved.id, ownerId: "owner", projectId: "p1", repositoryId: "3001", mode: "dev", kind: "dependency_update",
    prompt: "Update deps", promptDigest: saved.prompt_digest, requestDigest: saved.request_digest, configVersion: 1,
    policyHash: saved.policy_hash, profileHash: saved.profile_hash, state: "queued", clarification: [], idempotencyKey: "k2",
    selector: "p1", explicitMode: "dev", explicitKind: "dependency_update", version: 1,
  });
  assert.equal(result.state, "queued");
  const writes = pool.calls.filter(({ text }) => /INSERT INTO jarvis\.(requests|tasks|queue_entries|outbox)/i.test(text)).map(({ text }) => text);
  assert.equal(writes.length, 4);
  assert.match(writes[0], /INSERT INTO jarvis\.requests/);
  assert.match(writes[1], /INSERT INTO jarvis\.tasks/);
  assert.match(writes[2], /INSERT INTO jarvis\.queue_entries/);
  assert.match(writes[3], /INSERT INTO jarvis\.outbox/);
  assert.equal(pool.calls.at(-1).text, "COMMIT");
  assert.equal(pool.calls.some(({ text }) => /INSERT INTO jarvis\.task_attempts/i.test(text)), false);
});

test("clarification persistence rechecks authorization and applies expected-version CAS atomically", async () => {
  const saved = {
    id: "00000000-0000-4000-8000-000000000003", owner_id: "owner", project_id: "p1", repository_id: "3001",
    mode: "plan", request_kind: "project", prompt: "original", prompt_digest: "a".repeat(64), request_digest: "b".repeat(64),
    config_version: 2, policy_hash: "c".repeat(64), state: "queued", clarification: [], idempotency_key: "k3",
    selector: null, explicit_mode: null, explicit_kind: null, version: 2, profile_hash: "d".repeat(64),
  };
  const pool = poolFor([
    { rows: [], rowCount: 0 }, { rows: [{ id: "p1" }], rowCount: 1 }, { rows: [saved], rowCount: 1 },
    { rows: [{ id: "task2" }], rowCount: 1 }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 },
  ]);
  const store = new persistence.PostgresRequestIntakeStore(pool);
  await store.replaceClarification({
    id: saved.id, ownerId: "owner", projectId: "p1", repositoryId: "3001", mode: "plan", kind: "project", prompt: "original",
    promptDigest: saved.prompt_digest, requestDigest: saved.request_digest, configVersion: 2, policyHash: saved.policy_hash,
    profileHash: saved.profile_hash, state: "queued", clarification: [], idempotencyKey: "k3", selector: null,
    explicitMode: null, explicitKind: null, version: 2,
  }, 1);
  const update = pool.calls.find(({ text }) => /UPDATE jarvis\.requests/i.test(text));
  assert.match(update.text, /state='clarification' AND version=\$10/);
  assert.equal(update.values[9], 1);
  assert.match(pool.calls.find(({ text }) => /SELECT p\.id FROM jarvis\.projects/i.test(text)).text, /config_version=\$3/);
  assert.equal(pool.calls.at(-1).text, "COMMIT");
});

test("stale project authorization rolls back before any task, queue, or outbox write", async () => {
  const pool = poolFor([
    { rows: [], rowCount: 0 }, // BEGIN
    { rows: [], rowCount: 0 }, // idempotency lookup
    { rows: [], rowCount: 0 }, // current allowlist/config check
  ]);
  const store = new persistence.PostgresRequestIntakeStore(pool);
  await assert.rejects(() => store.create({
    id: "00000000-0000-4000-8000-000000000004", ownerId: "owner", projectId: "p1", repositoryId: "3001",
    mode: "dev", kind: "project", prompt: "work", promptDigest: "a".repeat(64), requestDigest: "b".repeat(64),
    configVersion: 2, policyHash: "c".repeat(64), profileHash: "d".repeat(64), state: "queued", clarification: [],
    idempotencyKey: "stale", selector: null, explicitMode: "dev", explicitKind: null, version: 1,
    clarificationDigest: null,
  }), /PROJECT_AUTHORIZATION_STALE/);
  assert.equal(pool.calls.some(({ text }) => /INSERT INTO jarvis\.(requests|tasks|queue_entries|outbox)/i.test(text)), false);
  assert.equal(pool.calls.at(-1).text, "ROLLBACK");
});

test("failed clarification reauthorization rolls back before changing request or queuing work", async () => {
  const pool = poolFor([{ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }]);
  const store = new persistence.PostgresRequestIntakeStore(pool);
  await assert.rejects(() => store.replaceClarification({
    id: "00000000-0000-4000-8000-000000000005", ownerId: "owner", projectId: "p1", repositoryId: "3001",
    mode: "plan", kind: "project", prompt: "original", promptDigest: "a".repeat(64), requestDigest: "b".repeat(64),
    configVersion: 2, policyHash: "c".repeat(64), profileHash: "d".repeat(64), state: "queued", clarification: [],
    idempotencyKey: "stale-answer", selector: null, explicitMode: null, explicitKind: null, version: 2,
    clarificationDigest: "e".repeat(64),
  }, 1), /PROJECT_AUTHORIZATION_STALE/);
  assert.equal(pool.calls.some(({ text }) => /UPDATE jarvis\.requests|INSERT INTO jarvis\.(tasks|queue_entries|outbox)/i.test(text)), false);
  assert.equal(pool.calls.at(-1).text, "ROLLBACK");
});
