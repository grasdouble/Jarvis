import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import * as persistenceModule from "../dist/index.js";
const { CheckpointRejectedError } = persistenceModule;

function createPool(results = []) {
  const calls = [];
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      return results.shift() ?? { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { calls, async connect() { return client; } };
}

test("checkpoint writes require the current lease and current project and skill consent", async () => {
  assert.equal(typeof persistenceModule.PostgresPersistence, "function");
  const { PostgresPersistence } = persistenceModule;
  const pool = createPool([
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 1 },
    { rows: [{ id: "checkpoint-1" }], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  const persistence = new PostgresPersistence(pool);

  await persistence.saveCheckpoint({
    taskId: "task-1",
    attemptId: "attempt-1",
    projectId: "project-1",
    leaseEpoch: 4,
    step: "plan-ready",
    schemaVersion: 1,
    state: { phase: "plan_validated", configVersion: 2, policyHash: "c".repeat(64), artifactDigest: "a".repeat(64) },
    requiredSkills: [{ skillId: "plan", revisionDigest: "b".repeat(64) }],
  });

  const sql = pool.calls.map(({ text }) => text).join("\n");
  assert.match(sql, /lease_epoch\s*=\s*\$3/i);
  assert.match(sql, /project_id\s*=\s*\$4/i);
  assert.match(sql, /revoked_at\s+IS\s+NULL/i);
  assert.match(sql, /revision_digest/i);
  assert.deepEqual(pool.calls[2].values.slice(0, 4), ["task-1", "attempt-1", 4, "project-1"]);
  assert.match(pool.calls[1].text, /FOR SHARE/i);
});

test("migrations enforce repository-scoped identity and hide secrets from task state", async () => {
  const migration = await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
  const approvalOrderingMigration = await readFile(new URL("../migrations/002_skill_approval_order.sql", import.meta.url), "utf8");
  const requestIntakeMigration = await readFile(new URL("../migrations/004_project_request_intake.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE projects/i);
  assert.match(migration, /UNIQUE\s*\(id, repository_id\)/i);
  assert.match(migration, /FOREIGN KEY\s*\([^)]*repository_id[^)]*\)\s*REFERENCES/i);
  assert.match(migration, /CREATE ROLE jarvis_app/i);
  assert.doesNotMatch(migration, /provider_session|private_key|access_token/i);
  assert.match(migration, /CREATE TABLE task_checkpoints/i);
  assert.match(migration, /CREATE TABLE project_skill_approvals/i);
  assert.match(migration, /project_skill_approvals_serialize/i);
  assert.match(approvalOrderingMigration, /skill_approval_order\s*=\s*skill_approval_order\s*\+\s*1/i);
  assert.match(approvalOrderingMigration, /decision_order_unique/i);
  assert.match(requestIntakeMigration, /ADD COLUMN request_digest/i);
  assert.match(requestIntakeMigration, /ADD COLUMN clarification/i);
  assert.match(requestIntakeMigration, /ADD COLUMN clarification_digest/i);
  assert.match(requestIntakeMigration, /ALTER COLUMN project_id DROP NOT NULL/i);
  assert.match(requestIntakeMigration, /requests_admission_binding/i);
});

test("migration runner serializes concurrent callers and records applied versions", async () => {
  assert.equal(typeof persistenceModule.PostgresPersistence, "function");
  const { PostgresPersistence } = persistenceModule;
  const pool = createPool([{ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }]);
  const persistence = new PostgresPersistence(pool);

  await persistence.migrate();

  const sql = pool.calls.map(({ text }) => text).join("\n");
  assert.match(sql, /pg_advisory_lock/);
  assert.match(sql, /schema_migrations/);
  assert.ok(pool.calls.some(({ values }) => values?.includes("001_initial")));
  assert.match(sql, /pg_advisory_unlock/);
});

test("migration runner refuses to rewrite an applied migration", async () => {
  const pool = createPool([
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [{ version: "001_initial", checksum: "old-checksum" }], rowCount: 1 },
  ]);
  const persistence = new persistenceModule.PostgresPersistence(pool);

  await assert.rejects(persistence.migrate(), /has changed/);
  assert.equal(pool.calls.some(({ text }) => text === "BEGIN"), false);
  assert.match(pool.calls.at(-1).text, /pg_advisory_unlock/);
});

test("expired consent is rechecked when loading a checkpoint for recovery", async () => {
  const pool = createPool([{ rows: [], rowCount: 0 }]);
  const persistence = new persistenceModule.PostgresPersistence(pool);

  assert.equal(await persistence.loadLatestCheckpoint({ taskId: "task-1", projectId: "project-1" }), null);
  const sql = pool.calls[0].text;
  assert.match(sql, /t\.state NOT IN/);
  assert.match(sql, /p\.state = 'active'/);
  assert.match(sql, /c\.state_json ->> 'policyHash' = t\.policy_hash/);
  assert.match(sql, /jsonb_to_recordset\(c\.skill_requirements\)/);
  assert.match(sql, /newer\.decision_order/i);
});

test("untrusted or oversized checkpoint content is rejected before database access", async () => {
  const pool = createPool();
  const persistence = new persistenceModule.PostgresPersistence(pool);
  const common = {
    taskId: "task-1",
    attemptId: "attempt-1",
    projectId: "project-1",
    leaseEpoch: 4,
    step: "plan-ready",
    schemaVersion: 1,
    requiredSkills: [],
  };

  await assert.rejects(
    persistence.saveCheckpoint({
      ...common,
      state: { phase: "plan_validated", configVersion: 2, policyHash: "c".repeat(64), providerSession: "sensitive" },
    }),
    /closed core-state contract/,
  );
  const accessorState = { configVersion: 2, policyHash: "c".repeat(64) };
  Object.defineProperty(accessorState, "phase", { enumerable: true, get() { return "plan_validated"; } });
  await assert.rejects(
    persistence.saveCheckpoint({ ...common, state: accessorState }),
    /data properties/,
  );
  const reasonCodes = ["safe"];
  reasonCodes.toJSON = () => ({ token: "hidden" });
  await assert.rejects(
    persistence.saveCheckpoint({
      ...common,
      state: { phase: "plan_validated", configVersion: 2, policyHash: "c".repeat(64), reasonCodes },
    }),
    /dense plain array/,
  );
  assert.equal(pool.calls.length, 0);
});

test("recovery rejects persisted checkpoint state whose digest no longer matches", async () => {
  const pool = createPool([{
    rows: [{
      id: "checkpoint-1",
      step: "plan-ready",
      schemaVersion: 1,
      state: { phase: "plan_validated", configVersion: 2, policyHash: "c".repeat(64) },
      stateDigest: "a".repeat(64),
    }],
    rowCount: 1,
  }]);
  const persistence = new persistenceModule.PostgresPersistence(pool);

  await assert.rejects(
    persistence.loadLatestCheckpoint({ taskId: "task-1", projectId: "project-1" }),
    /digest does not match/,
  );
});

test("stale leases and revoked skills cannot save a checkpoint", async () => {
  const pool = createPool([
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
  ]);
  const persistence = new persistenceModule.PostgresPersistence(pool);

  await assert.rejects(persistence.saveCheckpoint({
    taskId: "task-1",
    attemptId: "attempt-1",
    projectId: "project-1",
    leaseEpoch: 4,
    step: "plan-ready",
    schemaVersion: 1,
    state: { phase: "plan_validated", configVersion: 2, policyHash: "c".repeat(64) },
    requiredSkills: [{ skillId: "plan", revisionDigest: "b".repeat(64) }],
  }), CheckpointRejectedError);

  const sql = pool.calls.map(({ text }) => text).join("\n");
  assert.match(sql, /a\.lease_until > now\(\)/);
  assert.match(sql, /p\.state = 'active'/);
  assert.match(sql, /approval\.skill_id = required\.skill_id/);
  assert.match(sql, /revoked\.decision_order > approval\.decision_order/);
});
