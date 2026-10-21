import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { CheckpointRejectedError, PostgresPersistence, PostgresQueueStore } from "../dist/index.js";
import { QueueError, QueueService } from "@jarvis/queue";

const { Pool } = pg;
const databaseUrl = process.env.JARVIS_TEST_DATABASE_URL;

test("PostgreSQL migrations and checkpoint authorization work against the real database", {
  skip: databaseUrl === undefined ? "set JARVIS_TEST_DATABASE_URL to a disposable empty database" : false,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  let client;
  let lockClient;
  let fixtureCommitted = false;
  try {
    const { rows: [database] } = await pool.query("SELECT current_database() AS name");
    assert.match(database.name, /^jarvis_issue8_/);

    const persistence = new PostgresPersistence(pool);
    await persistence.migrate();
    await persistence.migrate();
    const { rows: migrations } = await pool.query("SELECT version FROM jarvis.schema_migrations");
    assert.deepEqual(migrations.map(({ version }) => version), ["001_initial", "002_skill_approval_order", "003_durable_queue"]);
    lockClient = await pool.connect();
    await lockClient.query("SELECT pg_advisory_lock($1)", [0x4a385445]);
    await pool.query(`
      DO $$
      DECLARE table_name text; row_count bigint;
      BEGIN
        FOR table_name IN
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'jarvis' AND tablename <> 'schema_migrations'
        LOOP
          EXECUTE format('SELECT count(*) FROM jarvis.%I', table_name) INTO row_count;
          IF row_count > 0 THEN
            RAISE EXCEPTION 'integration test database is not empty: jarvis.%', table_name;
          END IF;
        END LOOP;
      END $$
    `);

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
    await client.query(`
      INSERT INTO jarvis.requests
        (id, owner_id, project_id, repository_id, mode, prompt_digest, state, idempotency_key, config_version, policy_hash)
      VALUES ($1, 'owner-a', $2, 3001, 'dev', $3, 'queued', 'request-queue', 1, $4)`, [
      "00000000-0000-4000-8000-000000000007", "00000000-0000-4000-8000-000000000003",
      "1".repeat(64), "b".repeat(64),
    ]);
    await client.query(`
      INSERT INTO jarvis.tasks
        (id, request_id, project_id, repository_id, mode, profile_hash, policy_hash, config_version, state, dedupe_key)
      VALUES ($1, $2, $3, 3001, 'dev', $4, $5, 1, 'queued', 'task-queue')`, [
      "00000000-0000-4000-8000-000000000008", "00000000-0000-4000-8000-000000000007",
      "00000000-0000-4000-8000-000000000003", "f".repeat(64), "b".repeat(64),
    ]);
    await client.query(`
      INSERT INTO jarvis.requests
        (id, owner_id, project_id, repository_id, mode, prompt_digest, state, idempotency_key, config_version, policy_hash)
      VALUES ($1, 'owner-a', $2, 3001, 'plan', $3, 'queued', 'request-cancel', 1, $4)`, [
      "00000000-0000-4000-8000-000000000009", "00000000-0000-4000-8000-000000000003",
      "2".repeat(64), "b".repeat(64),
    ]);
    await client.query(`
      INSERT INTO jarvis.tasks
        (id, request_id, project_id, repository_id, mode, profile_hash, policy_hash, config_version, state, dedupe_key)
      VALUES ($1, $2, $3, 3001, 'plan', $4, $5, 1, 'queued', 'task-cancel')`, [
      "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-000000000009",
      "00000000-0000-4000-8000-000000000003", "f".repeat(64), "b".repeat(64),
    ]);
    await client.query("COMMIT");
    client.release();
    client = undefined;
    fixtureCommitted = true;

    const transactionPersistence = new PostgresPersistence(pool);
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

    await pool.query(`
      INSERT INTO jarvis.project_skill_approvals
        (project_id, repository_id, skill_id, revision_digest, decision, actor_id, config_version, decided_at)
      VALUES ($1, 3001, 'plan', $2, 'revoked', 'owner-a', 1, '2000-01-01T00:00:00Z')`, [
      input.projectId, "d".repeat(64),
    ]);
    assert.equal(await transactionPersistence.loadLatestCheckpoint({ taskId: input.taskId, projectId: input.projectId }), null);
    await assert.rejects(
      transactionPersistence.saveCheckpoint({ ...input, step: "after-revoke" }),
      CheckpointRejectedError,
    );

    await pool.query(`
      INSERT INTO jarvis.project_skill_approvals
        (project_id, repository_id, skill_id, revision_digest, decision, actor_id, config_version, decided_at)
      VALUES ($1, 3001, 'plan', $2, 'approved', 'owner-a', 1, '2000-01-01T00:00:00Z')`, [
      input.projectId, "d".repeat(64),
    ]);
    assert.equal((await transactionPersistence.loadLatestCheckpoint({ taskId: input.taskId, projectId: input.projectId })).id, saved.id,
      "a later approval with an equal timestamp must supersede the revocation");
    await pool.query(`
      INSERT INTO jarvis.project_skill_approvals
        (project_id, repository_id, skill_id, revision_digest, decision, actor_id, config_version, decided_at)
      VALUES ($1, 3001, 'plan', $2, 'revoked', 'owner-a', 1, '2000-01-01T00:00:00Z')`, [
      input.projectId, "d".repeat(64),
    ]);
    assert.equal(await transactionPersistence.loadLatestCheckpoint({ taskId: input.taskId, projectId: input.projectId }), null,
      "a later revocation with an equal timestamp must supersede the approval");

    let queueClock = Date.now();
    let queueId = 0;
    const queueStore = new PostgresQueueStore(pool);
    const queue = new QueueService({
      store: queueStore,
      clock: { now: () => queueClock },
      ids: { next: () => `unused-id-${++queueId}` },
    });
    const request = {
      eventId: "owner-request-queue-1",
      taskId: "00000000-0000-4000-8000-000000000008",
      payload: { taskId: "00000000-0000-4000-8000-000000000008" },
      deadline: queueClock + 60 * 60_000,
      maxAttempts: 3,
      retry: { baseDelay: 100, maxDelay: 1_000 },
    };
    await assert.rejects(queue.enqueue({ ...request, eventId: "repository-text-cannot-enqueue", taskId: input.taskId }), {
      code: "TASK_NOT_AUTHORIZED",
    }, "a repository-supplied identifier cannot create queue work without a durable queued task");
    await pool.query(`
      CREATE FUNCTION public.reject_queue_outbox_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'queue.task.queued' THEN RAISE EXCEPTION 'injected outbox failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_queue_outbox_test BEFORE INSERT ON jarvis.outbox
      FOR EACH ROW EXECUTE FUNCTION public.reject_queue_outbox_test()`);
    try {
      await assert.rejects(queue.enqueue({ ...request, eventId: "atomic-outbox-failure" }), /injected outbox failure/);
      const { rows: [rolledBack] } = await pool.query("SELECT count(*)::integer AS count FROM jarvis.queue_entries");
      assert.equal(rolledBack.count, 0, "failed outbox writes roll back queue admission in the same transaction");
    } finally {
      await pool.query("DROP TRIGGER reject_queue_outbox_test ON jarvis.outbox");
      await pool.query("DROP FUNCTION public.reject_queue_outbox_test()");
    }
    const queued = await queue.enqueue(request);
    assert.equal((await queue.enqueue(request)).id, queued.id, "duplicate inbox events return the canonical task");
    await assert.rejects(queue.enqueue({ ...request, deadline: request.deadline + 1 }), QueueError,
      "reusing an event identity with changed task parameters is rejected");

    const [claimA, claimB] = await Promise.all([
      queue.claim("worker-a", 60_000),
      queue.claim("worker-b", 60_000),
    ]);
    assert.equal(Number(claimA !== null) + Number(claimB !== null), 1, "concurrent workers cannot claim the same task");
    const firstLease = claimA ?? claimB;
    assert.ok(firstLease);
    assert.equal(firstLease.epoch, 1);
    assert.equal(await queue.claim("worker-c", 60_000), null, "a live lease is not made available to another worker");
    await pool.query(`
      UPDATE jarvis.queue_entries SET lease_until = clock_timestamp() - interval '1 second'
      WHERE task_id = $1`, [request.taskId]);
    await pool.query(`
      UPDATE jarvis.task_attempts SET lease_until = clock_timestamp() - interval '1 second'
      WHERE task_id = $1 AND state = 'active'`, [request.taskId]);
    queueClock = Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000) AS now_ms")).rows[0].now_ms);
    const secondLease = await queue.claim("worker-b", 60_000);
    assert.ok(secondLease);
    assert.equal(secondLease.epoch, 2, "reclaimed work has a strictly increasing fencing epoch");
    await assert.rejects(queue.complete(firstLease, { kind: "report", id: "00000000-0000-4000-8000-000000000009" }), { code: "STALE_LEASE" });

    const unknown = await queue.fail(secondLease, { kind: "unknown_external", effectId: "github-pr-intent-1" });
    assert.equal(unknown.status, "reconciliation_required");
    assert.equal(await queue.claim("worker-c", 60_000), null, "unknown remote effects are not retried");
    assert.equal((await queue.reconcile(unknown.id, { outcome: "indeterminate" })).status, "reconciliation_required");
    const retrying = await queue.reconcile(unknown.id, { outcome: "not_applied" });
    assert.equal(retrying.status, "queued");
    const { rows: [initialRetry] } = await pool.query(`
      SELECT available_at > clock_timestamp() AS delayed
      FROM jarvis.queue_entries WHERE task_id = $1`, [request.taskId]);
    assert.equal(initialRetry.delayed, true, "the task remains unavailable during its backoff");
    let retryReady = false;
    for (let wait = 0; wait < 40 && !retryReady; wait += 1) {
      await delay(25);
      const { rows: [clock] } = await pool.query(`
        SELECT available_at <= clock_timestamp() AS ready,
               floor(extract(epoch FROM clock_timestamp()) * 1000) AS now_ms
        FROM jarvis.queue_entries WHERE task_id = $1`, [request.taskId]);
      retryReady = clock.ready;
      if (retryReady) queueClock = Number(clock.now_ms);
    }
    assert.equal(retryReady, true, "the retry becomes eligible after backoff/simulated wait");
    const thirdLease = await queue.claim("worker-c", 60_000);
    assert.ok(thirdLease);
    assert.equal(thirdLease.epoch, 3);
    assert.equal((await queue.complete(thirdLease, { kind: "report", id: "00000000-0000-4000-8000-000000000009" })).status, "succeeded");

    const { rows: queueResults } = await pool.query(`
      SELECT q.state, q.attempt_count, q.lease_epoch, t.state AS task_state, r.state AS request_state,
             (SELECT array_agg(state ORDER BY ordinal) FROM jarvis.task_attempts WHERE task_id = q.task_id) AS attempt_states,
             (SELECT count(*) FROM jarvis.outbox WHERE aggregate_id = q.task_id) AS outbox_count
      FROM jarvis.queue_entries q
      JOIN jarvis.tasks t ON t.id = q.task_id
      JOIN jarvis.requests r ON r.id = t.request_id
      WHERE q.task_id = $1`, [request.taskId]);
    assert.deepEqual(queueResults[0], {
      state: "succeeded", attempt_count: 3, lease_epoch: "3", task_state: "completed", request_state: "completed",
      attempt_states: ["expired", "failed", "succeeded"], outbox_count: "7",
    });

    const cancelRequest = {
      eventId: "owner-request-queue-cancel",
      taskId: "00000000-0000-4000-8000-00000000000a",
      payload: { taskId: "00000000-0000-4000-8000-00000000000a" },
      deadline: queueClock + 60 * 60_000,
      maxAttempts: 3,
      retry: { baseDelay: 100, maxDelay: 1_000 },
    };
    const cancelQueued = await queue.enqueue(cancelRequest);
    const cancelLease = await queue.claim("worker-d", 60_000);
    assert.ok(cancelLease);
    const cancelled = await queue.cancel(cancelQueued.id);
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(queue.complete(cancelLease, { kind: "report", id: "00000000-0000-4000-8000-000000000009" }), { code: "STALE_LEASE" });
    assert.equal(await queue.claim("worker-e", 60_000), null);
    const { rows: cancellationResults } = await pool.query(`
      SELECT q.state, q.lease_epoch, t.state AS task_state, r.state AS request_state,
             a.state AS attempt_state, (SELECT count(*) FROM jarvis.outbox WHERE aggregate_id = q.task_id) AS outbox_count
      FROM jarvis.queue_entries q
      JOIN jarvis.tasks t ON t.id = q.task_id
      JOIN jarvis.requests r ON r.id = t.request_id
      JOIN jarvis.task_attempts a ON a.id = q.attempt_id
      WHERE q.task_id = $1`, [cancelRequest.taskId]);
    assert.deepEqual(cancellationResults[0], {
      state: "cancelled", lease_epoch: "2", task_state: "cancelled", request_state: "cancelled",
      attempt_state: "cancelled", outbox_count: "3",
    });

    client = await pool.connect();
    await client.query("BEGIN");
    await assert.rejects(
      client.query("UPDATE jarvis.task_checkpoints SET step = 'mutated' WHERE id = $1", [saved.id]),
      /immutable record/,
    );
  } finally {
    try {
      if (client) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      if (fixtureCommitted) {
        client = await pool.connect();
        let cleanupCommitted = false;
        try {
          await client.query("BEGIN");
          await client.query(`
            DO $$
            DECLARE table_name text; row_count bigint; expected_count bigint;
            BEGIN
              FOR table_name IN
                SELECT tablename FROM pg_tables
                WHERE schemaname = 'jarvis' AND tablename <> 'schema_migrations'
                ORDER BY tablename
              LOOP
                EXECUTE format('LOCK TABLE jarvis.%I IN ACCESS EXCLUSIVE MODE', table_name);
              END LOOP;
              FOR table_name IN
                SELECT tablename FROM pg_tables
                WHERE schemaname = 'jarvis' AND tablename <> 'schema_migrations'
              LOOP
                EXECUTE format('SELECT count(*) FROM jarvis.%I', table_name) INTO row_count;
                expected_count := CASE table_name
                  WHEN 'installations' THEN 1
                  WHEN 'policies' THEN 1
                  WHEN 'projects' THEN 1
                  WHEN 'project_config_versions' THEN 1
                  WHEN 'project_skills' THEN 1
                  WHEN 'project_skill_approvals' THEN 4
                  WHEN 'requests' THEN 3
                  WHEN 'tasks' THEN 3
                  WHEN 'task_attempts' THEN 5
                  WHEN 'task_checkpoints' THEN 1
                  WHEN 'queue_entries' THEN 2
                  WHEN 'outbox' THEN 10
                  ELSE 0
                END;
                IF row_count <> expected_count THEN
                  RAISE EXCEPTION 'refusing fixture cleanup: jarvis.% contains % rows; expected %',
                    table_name, row_count, expected_count;
                END IF;
              END LOOP;
            END $$
          `);
          await client.query(`
            DO $$
            DECLARE truncate_tables text;
            BEGIN
              SELECT string_agg(format('jarvis.%I', tablename), ', ' ORDER BY tablename)
              INTO truncate_tables
              FROM pg_tables
              WHERE schemaname = 'jarvis' AND tablename <> 'schema_migrations';
              EXECUTE 'TRUNCATE TABLE ' || truncate_tables;
            END $$
          `);
          await client.query("COMMIT");
          cleanupCommitted = true;
        } finally {
          if (!cleanupCommitted) await client.query("ROLLBACK").catch(() => undefined);
          client.release();
          client = undefined;
        }
      }
    } finally {
      if (lockClient) {
        await lockClient.query("SELECT pg_advisory_unlock($1)", [0x4a385445]).catch(() => undefined);
        lockClient.release();
      }
      await pool.end();
    }
  }
});
