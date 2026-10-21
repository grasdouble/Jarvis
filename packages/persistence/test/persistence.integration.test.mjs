import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import pg from "pg";
import { CheckpointRejectedError, PostgresPersistence } from "../dist/index.js";

const { Pool } = pg;
const databaseUrl = process.env.JARVIS_TEST_DATABASE_URL;

test("PostgreSQL migrations and checkpoint authorization work against the real database", {
  skip: databaseUrl === undefined ? "set JARVIS_TEST_DATABASE_URL to a disposable empty database" : false,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  let client;
  try {
    const { rows: [database] } = await pool.query("SELECT current_database() AS name");
    assert.match(database.name, /^jarvis_issue8_/);

    const persistence = new PostgresPersistence(pool);
    await persistence.migrate();
    await persistence.migrate();
    const { rows: migrations } = await pool.query("SELECT version FROM jarvis.schema_migrations");
    assert.deepEqual(migrations.map(({ version }) => version), ["001_initial"]);

    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO jarvis.installations (id, github_id, app_id, state)
      VALUES ($1, 1001, 2001, 'active')`, ["00000000-0000-4000-8000-000000000001"]);
    await client.query(`
      INSERT INTO jarvis.policies (id, version, canonical_json, hash)
      VALUES ($1, 1, '{"version":1}', $2)`, ["00000000-0000-4000-8000-000000000002", "b".repeat(64)]);
    await client.query(`
      INSERT INTO jarvis.projects (id, repository_id, installation_id, owner_id, repository_name, state, config_version)
      VALUES ($1, 3001, $2, 'owner-a', 'repo-a', 'active', 1)`, [
      "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000001",
    ]);
    await client.query(`
      INSERT INTO jarvis.project_config_versions
        (project_id, repository_id, version, config_json, config_hash, policy_hash, created_by)
      VALUES ($1, 3001, 1, '{"authorized":true}', $2, $3, 'owner')`, [
      "00000000-0000-4000-8000-000000000003", "c".repeat(64), "b".repeat(64),
    ]);
    await client.query(`
      INSERT INTO jarvis.project_skills (project_id, repository_id, skill_id, revision_digest)
      VALUES ($1, 3001, 'plan', $2)`, ["00000000-0000-4000-8000-000000000003", "d".repeat(64)]);
    await client.query(`
      INSERT INTO jarvis.project_skill_approvals
        (project_id, repository_id, skill_id, revision_digest, decision, actor_id, config_version)
      VALUES ($1, 3001, 'plan', $2, 'approved', 'owner-a', 1)`, [
      "00000000-0000-4000-8000-000000000003", "d".repeat(64),
    ]);
    await client.query(`
      INSERT INTO jarvis.requests
        (id, owner_id, project_id, repository_id, mode, prompt_digest, state, idempotency_key, config_version, policy_hash)
      VALUES ($1, 'owner-a', $2, 3001, 'plan', $3, 'queued', 'request-1', 1, $4)`, [
      "00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000003",
      "e".repeat(64), "b".repeat(64),
    ]);
    await client.query(`
      INSERT INTO jarvis.tasks
        (id, request_id, project_id, repository_id, mode, profile_hash, policy_hash, config_version, state, dedupe_key)
      VALUES ($1, $2, $3, 3001, 'plan', $4, $5, 1, 'running', 'task-1')`, [
      "00000000-0000-4000-8000-000000000005", "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000003", "f".repeat(64), "b".repeat(64),
    ]);
    await client.query(`
      INSERT INTO jarvis.task_attempts
        (id, task_id, project_id, repository_id, ordinal, lease_epoch, lease_until, state)
      VALUES ($1, $2, $3, 3001, 1, 4, now() + interval '1 hour', 'active')`, [
      "00000000-0000-4000-8000-000000000006", "00000000-0000-4000-8000-000000000005",
      "00000000-0000-4000-8000-000000000003",
    ]);

    const transactionPool = {
      async connect() {
        return { query: (text, values) => client.query(text, values), release() {} };
      },
    };
    const transactionPersistence = new PostgresPersistence(transactionPool);
    const input = {
      taskId: "00000000-0000-4000-8000-000000000005",
      attemptId: "00000000-0000-4000-8000-000000000006",
      projectId: "00000000-0000-4000-8000-000000000003",
      leaseEpoch: 4,
      step: "plan-ready",
      schemaVersion: 1,
      state: { phase: "plan_validated", configVersion: 1, policyHash: "b".repeat(64) },
      requiredSkills: [{ skillId: "plan", revisionDigest: "d".repeat(64) }],
    };
    const saved = await transactionPersistence.saveCheckpoint(input);
    assert.equal(saved.stateDigest.length, 64);
    assert.equal((await transactionPersistence.loadLatestCheckpoint({ taskId: input.taskId, projectId: input.projectId })).id, saved.id);

    await client.query(`
      INSERT INTO jarvis.project_skill_approvals
        (project_id, repository_id, skill_id, revision_digest, decision, actor_id, config_version, decided_at)
      VALUES ($1, 3001, 'plan', $2, 'revoked', 'owner-a', 1, now() + interval '1 second')`, [
      input.projectId, "d".repeat(64),
    ]);
    assert.equal(await transactionPersistence.loadLatestCheckpoint({ taskId: input.taskId, projectId: input.projectId }), null);
    await assert.rejects(
      transactionPersistence.saveCheckpoint({ ...input, step: "after-revoke" }),
      CheckpointRejectedError,
    );

    await assert.rejects(
      client.query("UPDATE jarvis.task_checkpoints SET step = 'mutated' WHERE id = $1", [saved.id]),
      /immutable record/,
    );
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    await pool.end();
  }
});
