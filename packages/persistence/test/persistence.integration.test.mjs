import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import {
  CheckpointRejectedError,
  PostgresOwnerAuthStore,
  PostgresProjectConfigStore,
  PostgresProjectRequestAuthorization,
  PostgresPersistence,
  PostgresQueueStore,
  PostgresRequestIntakeStore,
  PostgresStopControlStore,
} from "../dist/index.js";
import { ProjectRequestIntake } from "@jarvis/domain";
import { QueueError, QueueService } from "@jarvis/queue";

const { Pool } = pg;
const databaseUrl = process.env.JARVIS_TEST_DATABASE_URL;
const originalConfig = {
  schemaVersion: 1,
  repository: { owner: "owner-a", name: "repo-a" },
  profileHash: "f".repeat(64),
};
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const originalConfigHash = createHash("sha256").update(canonical(originalConfig)).digest("hex");

async function waitForBlockedQueries(client, applicationNames, expectedCount = 1) {
  const names = Array.isArray(applicationNames) ? applicationNames : [applicationNames];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await client.query("SELECT pg_stat_clear_snapshot()");
    const { rows: [result] } = await client.query(`
      SELECT count(*)::integer AS count
      FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND wait_event_type='Lock' AND application_name=ANY($1::text[])
    `, [names]);
    if (result.count >= expectedCount) return result.count;
    await delay(10);
  }
  await client.query("SELECT pg_stat_clear_snapshot()");
  const { rows: activity } = await client.query(`
    SELECT pid, application_name, state, wait_event_type, wait_event, query
    FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid()
    ORDER BY pid
  `);
  throw new Error(`Timed out waiting for ${expectedCount} PostgreSQL lock waiter(s) from ${names.join(",")}; activity=${JSON.stringify(activity)}`);
}

async function lockProjectRow(pool, repositoryId) {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const { rows } = await client.query("SELECT id FROM jarvis.projects WHERE repository_id=$1 FOR UPDATE", [repositoryId]);
    assert.equal(rows.length, 1, `expected test project ${repositoryId}`);
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    throw error;
  }
  return {
    client,
    get open() { return open; },
    async commit() {
      if (!open) return;
      await client.query("COMMIT");
      open = false;
      client.release();
    },
    async rollback() {
      if (!open) return;
      try { await client.query("ROLLBACK"); }
      finally {
        open = false;
        client.release();
      }
    },
  };
}

test("PostgreSQL migrations and checkpoint authorization work against the real database", {
  skip: databaseUrl === undefined ? "set JARVIS_TEST_DATABASE_URL to a disposable empty database" : false,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 5, application_name: "jv201-integration" });
  let client;
  let authClient;
  let lockClient;
  let fixtureCommitted = false;
  try {
    const { rows: [database] } = await pool.query("SELECT current_database() AS name");
    assert.match(database.name, /^jarvis_issue8_/);

    const persistence = new PostgresPersistence(pool);
    await persistence.migrate();
    await persistence.migrate();
    const { rows: migrations } = await pool.query("SELECT version FROM jarvis.schema_migrations");
    assert.deepEqual(migrations.map(({ version }) => version), ["001_initial", "002_skill_approval_order", "003_durable_queue", "004_project_request_intake", "005_owner_auth", "006_project_configuration_api", "007_durable_stop_controls"]);
    const { rows: [initialStop] } = await pool.query("SELECT stopped FROM jarvis.stop_controls WHERE scope='global' AND project_id IS NULL");
    assert.equal(initialStop.stopped, true, "fresh database migration must start fail-closed");
    const restoreControls = new PostgresStopControlStore(pool);
    const { rows: [preRestore] } = await pool.query(`UPDATE jarvis.stop_controls
      SET stopped=false, version=version+1, changed_by='owner'
      WHERE scope='global' AND project_id IS NULL RETURNING version`);
    const restored = await restoreControls.suspendAfterRestore();
    assert.equal(restored.stopped, true, "restoring a backup with a resumed global stop must suspend all projects");
    assert.equal(restored.version, preRestore.version + 1, "restore invalidates resume tokens from the backup");
    const { rows: [restoreAudit] } = await pool.query(`SELECT actor, action FROM jarvis.audit_events
      WHERE actor='system:restore' AND action='stop.restore_suspend' AND resource='global'`);
    assert.deepEqual(restoreAudit, { actor: "system:restore", action: "stop.restore_suspend" });
    await assert.rejects(
      restoreControls.set({ stopped: false, expectedVersion: preRestore.version, ownerId: "owner" }),
      { code: "STOP_VERSION_CONFLICT" },
      "a pre-restore owner version cannot resume the restored deployment",
    );
    await restoreControls.set({ stopped: false, expectedVersion: restored.version, ownerId: "owner" });
    lockClient = await pool.connect();
    await lockClient.query("SELECT pg_advisory_lock($1)", [0x4a385445]);
    await pool.query(`
      DO $$
      DECLARE table_name text; row_count bigint;
      BEGIN
        FOR table_name IN
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'jarvis' AND tablename NOT IN ('schema_migrations', 'stop_controls', 'audit_events')
        LOOP
          EXECUTE format('SELECT count(*) FROM jarvis.%I', table_name) INTO row_count;
          IF row_count > 0 THEN
            RAISE EXCEPTION 'integration test database is not empty: jarvis.%', table_name;
          END IF;
        END LOOP;
      END $$
    `);

    authClient = await pool.connect();
    await authClient.query("BEGIN");
    try {
      const transactionPool = { async connect() { return { query: authClient.query.bind(authClient), release() {} }; } };
      const ownerAuthStore = new PostgresOwnerAuthStore(transactionPool);
      assert.equal(await ownerAuthStore.createOwner({ ownerId: "owner", passwordHash: "scrypt$integration-fixture" }), true);
      assert.equal(await ownerAuthStore.createOwner({ ownerId: "owner", passwordHash: "scrypt$second-fixture" }), false);
      const sessionTokenDigest = "a".repeat(64);
      const expiredTokenDigest = "c".repeat(64);
      await ownerAuthStore.createSession({
        ownerId: "owner", tokenDigest: sessionTokenDigest, csrfTokenDigest: "b".repeat(64), inactivityMs: 60_000,
      });
      assert.equal((await ownerAuthStore.touchSession(sessionTokenDigest, 60_000))?.ownerId, "owner");
      await ownerAuthStore.revokeSession(sessionTokenDigest);
      assert.equal(await ownerAuthStore.touchSession(sessionTokenDigest, 60_000), null);
      await ownerAuthStore.createSession({
        ownerId: "owner", tokenDigest: expiredTokenDigest, csrfTokenDigest: "d".repeat(64), inactivityMs: 60_000,
      });
      await authClient.query(`
        UPDATE jarvis.owner_sessions
        SET created_at = now() - interval '2 seconds',
            last_seen_at = now() - interval '2 seconds',
            expires_at = now() - interval '1 second'
        WHERE token_digest = $1
      `, [expiredTokenDigest]);
      assert.equal(await ownerAuthStore.touchSession(expiredTokenDigest, 60_000), null);
    } finally {
      await authClient.query("ROLLBACK");
      authClient.release();
      authClient = undefined;
    }

    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO jarvis.installations (id, github_id, app_id, state)
      VALUES ($1, 1001, 2001, 'active')`, ["00000000-0000-4000-8000-000000000001"]);
    await client.query(`
      INSERT INTO jarvis.policies (id, version, canonical_json, hash, activated_at)
      VALUES ($1, 1, '{"version":1}', $2, now())`, ["00000000-0000-4000-8000-000000000002", "b".repeat(64)]);
    await client.query(`
      INSERT INTO jarvis.projects (id, repository_id, installation_id, owner_id, repository_name, state, config_version)
      VALUES ($1, 3001, $2, 'owner-a', 'repo-a', 'active', 1)`, [
      "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000001",
    ]);
    await client.query(`
      INSERT INTO jarvis.project_config_versions
        (project_id, repository_id, version, config_json, config_hash, policy_hash, created_by)
      VALUES ($1, 3001, 1, $2::jsonb, $3, $4, 'owner')`, [
      "00000000-0000-4000-8000-000000000003", canonical(originalConfig), originalConfigHash, "b".repeat(64),
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
    const stopControls = new PostgresStopControlStore(pool);
    const globalBeforeQueue = await stopControls.get({});
    await stopControls.set({ stopped: false, expectedVersion: globalBeforeQueue.global.version, ownerId: "owner" });
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

    const beforeRestore = await stopControls.get({});
    await stopControls.set({ stopped: false, expectedVersion: beforeRestore.global.version, ownerId: "owner" });
    const backupResumeVersion = (await stopControls.get({})).global.version;
    const restoredForQueue = await stopControls.suspendAfterRestore();
    assert.equal(restoredForQueue.version, backupResumeVersion + 1);
    assert.equal(await queue.claim("worker-globally-paused", 60_000), null,
      "restore must suspend queued work even when the backup held a resumed global stop");
    const globalPaused = await stopControls.get({ projectId: input.projectId });
    assert.equal(globalPaused.global.stopped, true);
    await stopControls.set({ projectId: input.projectId, stopped: false, expectedVersion: 0, ownerId: "owner" });
    assert.equal(await queue.claim("worker-project-resumed-but-global-paused", 60_000), null,
      "a project-level resume cannot negate the global stop");
    await assert.rejects(stopControls.set({ stopped: false, expectedVersion: backupResumeVersion, ownerId: "owner" }),
      { code: "STOP_VERSION_CONFLICT" }, "a backup's old resume version is stale after restore");
    await stopControls.set({ stopped: false, expectedVersion: restoredForQueue.version, ownerId: "owner" });

    await stopControls.set({ projectId: input.projectId, stopped: true, expectedVersion: 1, ownerId: "owner" });
    assert.equal(await queue.claim("worker-paused", 60_000), null, "a project stop prevents claim of queued work while global execution is resumed");
    assert.equal((await stopControls.get({ projectId: input.projectId })).global.stopped, false, "project stop does not alter global state");
    assert.equal((await new PostgresStopControlStore(pool).get({ projectId: input.projectId })).project.stopped, true,
      "a newly constructed store observes the persisted pause after process recreation");
    await stopControls.set({ projectId: input.projectId, stopped: false, expectedVersion: 2, ownerId: "owner" });

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
    await stopControls.set({ projectId: input.projectId, stopped: true, expectedVersion: 2, ownerId: "owner" });
    assert.equal(await queue.claim("worker-paused-retry", 60_000), null, "a project stop also prevents a ready retry from being claimed");
    await stopControls.set({ projectId: input.projectId, stopped: false, expectedVersion: 3, ownerId: "owner" });
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

    const intakeStore = new PostgresRequestIntakeStore(pool);
    const requestBase = {
      id: randomUUID(), ownerId: "owner-a", projectId: "00000000-0000-4000-8000-000000000003", repositoryId: "3001",
      mode: "plan", kind: "dependency_update", prompt: "Review dependency updates", promptDigest: "a".repeat(64),
      requestDigest: "b".repeat(64), configVersion: 1, policyHash: "b".repeat(64), profileHash: "f".repeat(64),
      state: "queued", clarification: [], idempotencyKey: "intake-integration-1", selector: "project-1",
      explicitMode: "plan", explicitKind: "dependency_update", version: 1,
    };
    const legacyRequestId = randomUUID();
    await pool.query(`
      INSERT INTO jarvis.requests
        (id, owner_id, project_id, repository_id, mode, prompt_digest, state, idempotency_key, config_version, policy_hash)
      VALUES ($1, 'owner-a', '00000000-0000-4000-8000-000000000003', 3001, 'plan', $2, 'queued', 'legacy-request', 1, $3)
    `, [legacyRequestId, "7".repeat(64), "b".repeat(64)]);
    const legacyByKey = await intakeStore.findByIdempotency("owner-a", "legacy-request");
    const legacyOwned = await intakeStore.getOwned(legacyRequestId, "owner-a");
    assert.equal(legacyByKey.prompt, null);
    assert.equal(legacyByKey.requestDigest, null);
    assert.equal(legacyOwned.prompt, null);
    assert.equal(legacyOwned.requestDigest, null);
    await assert.rejects(intakeStore.create({
      ...requestBase, id: randomUUID(), idempotencyKey: "legacy-request", requestDigest: "8".repeat(64),
    }), /IDEMPOTENCY_CONFLICT/);
    const { rows: [untouchedLegacy] } = await pool.query(`
      SELECT r.state, r.prompt, r.request_digest,
        (SELECT count(*) FROM jarvis.tasks t WHERE t.request_id=r.id)::integer AS task_count
      FROM jarvis.requests r WHERE r.id=$1
    `, [legacyRequestId]);
    assert.deepEqual(untouchedLegacy, { state: "queued", prompt: null, request_digest: null, task_count: 0 });

    const admitted = await intakeStore.create(requestBase);
    assert.equal(admitted.state, "queued");
    assert.equal(admitted.prompt, requestBase.prompt);
    assert.equal(admitted.configVersion, 1);
    assert.equal(admitted.policyHash, requestBase.policyHash);
    assert.equal(admitted.profileHash, requestBase.profileHash);
    assert.equal((await intakeStore.create({ ...requestBase, id: randomUUID() })).id, admitted.id,
      "same owner/key and full request digest returns the persisted canonical request");
    const concurrentBase = { ...requestBase, idempotencyKey: "intake-concurrent", requestDigest: "9".repeat(64), id: randomUUID() };
    const [concurrentA, concurrentB] = await Promise.all([
      intakeStore.create(concurrentBase),
      intakeStore.create({ ...concurrentBase, id: randomUUID() }),
    ]);
    assert.equal(concurrentA.id, concurrentB.id, "concurrent duplicate submissions resolve to one canonical durable request");
    const clarification = await intakeStore.create({
      ...requestBase, id: randomUUID(), projectId: null, repositoryId: null, mode: null, configVersion: null,
      policyHash: null, profileHash: null, state: "clarification", clarification: ["project", "mode"],
      idempotencyKey: "intake-integration-clarification", selector: null, explicitMode: null, explicitKind: null,
      requestDigest: "c".repeat(64),
    });
    assert.equal(clarification.state, "clarification");
    const { rows: [clarificationEffects] } = await pool.query(`
      SELECT (SELECT count(*) FROM jarvis.tasks WHERE request_id=$1)::integer AS tasks,
             (SELECT count(*) FROM jarvis.queue_entries q JOIN jarvis.tasks t ON t.id=q.task_id WHERE t.request_id=$1)::integer AS queue,
             (SELECT count(*) FROM jarvis.task_attempts a JOIN jarvis.tasks t ON t.id=a.task_id WHERE t.request_id=$1)::integer AS attempts
    `, [clarification.id]);
    assert.deepEqual(clarificationEffects, { tasks: 0, queue: 0, attempts: 0 });
    await assert.rejects(intakeStore.create({ ...requestBase, id: randomUUID(), requestDigest: "d".repeat(64) }), /IDEMPOTENCY_CONFLICT/);
    const clarified = await intakeStore.replaceClarification({
      ...clarification, projectId: "00000000-0000-4000-8000-000000000003", repositoryId: "3001", mode: "plan",
      configVersion: 1, policyHash: "b".repeat(64), profileHash: "f".repeat(64), state: "queued", clarification: [],
      version: 2, clarificationDigest: "f".repeat(64),
    }, 1);
    assert.equal(clarified.id, clarification.id);
    assert.equal(clarified.prompt, clarification.prompt);
    assert.equal(clarified.idempotencyKey, clarification.idempotencyKey);
    assert.equal(clarified.requestDigest, clarification.requestDigest);
    assert.equal(clarified.clarificationDigest, "f".repeat(64));

    const projectConfigurations = new PostgresProjectConfigStore(pool);
    const projectAuthorization = new PostgresProjectRequestAuthorization(pool);
    const projectIntake = new ProjectRequestIntake(intakeStore, projectAuthorization, randomUUID);
    const addedProject = await projectConfigurations.add("owner", {
      repositoryId: "3002", installationId: "00000000-0000-4000-8000-000000000001",
      repositoryOwner: "org", repositoryName: "repo-two",
    }, { policyHash: "b".repeat(64), profileHash: "f".repeat(64) });
    assert.equal(addedProject.configVersion, 1);
    const renamedProject = await projectConfigurations.update("owner", "3002", 1, {
      repositoryOwner: "renamed-org", repositoryName: "renamed-repo",
    });
    assert.equal(renamedProject.repositoryId, "3002");
    assert.equal(renamedProject.configVersion, 2);
    const removedProject = await projectConfigurations.remove("owner", "3002", 2);
    assert.equal(removedProject.state, "removed");
    assert.equal(removedProject.configVersion, 3);
    await assert.rejects(() => projectConfigurations.update("owner", "3002", 2, { repositoryName: "stale" }), /PROJECT_CONFIG_VERSION_CONFLICT/);
    await assert.rejects(() => projectConfigurations.add("owner", {
      repositoryId: "3002", installationId: "00000000-0000-4000-8000-000000000001",
      repositoryOwner: "another-org", repositoryName: "duplicate-id",
    }, { policyHash: "b".repeat(64), profileHash: "f".repeat(64) }), /PROJECT_IDENTITY_CONFLICT/);
    const { rows: configHistory } = await pool.query(`
      SELECT version, created_by FROM jarvis.project_config_versions WHERE project_id=$1 ORDER BY version
    `, [addedProject.projectId]);
    assert.deepEqual(configHistory, [
      { version: 1, created_by: "owner" }, { version: 2, created_by: "owner" }, { version: 3, created_by: "owner" },
    ]);
    const { rows: configAudit } = await pool.query(`
      SELECT actor, action FROM jarvis.audit_events WHERE resource='project:3002' ORDER BY action
    `);
    assert.deepEqual(configAudit.map(({ actor, action }) => [actor, action]), [
      ["owner", "project.added"], ["owner", "project.removed"], ["owner", "project.updated"],
    ]);
    const { rows: [pendingAfterConfigChange] } = await pool.query(`
      INSERT INTO jarvis.requests
        (owner_id, project_id, repository_id, mode, prompt_digest, state, idempotency_key, config_version, policy_hash,
         prompt, request_digest, request_kind, clarification, version)
      VALUES ('owner-a', NULL, NULL, NULL, $1, 'clarification', 'stale-after-remove',  NULL, NULL,
         'will not queue after removal', $2, 'project', '["project","mode"]'::jsonb, 1)
      RETURNING id
    `, ["1".repeat(64), "2".repeat(64)]);
    const removedOriginal = await projectConfigurations.remove("owner", "3001", 1);
    assert.equal(removedOriginal.state, "removed");
    await assert.rejects(() => intakeStore.replaceClarification({
      id: pendingAfterConfigChange.id, ownerId: "owner-a", projectId: "00000000-0000-4000-8000-000000000003",
      repositoryId: "3001", mode: "plan", kind: "project", prompt: "will not queue after removal",
      promptDigest: "1".repeat(64), requestDigest: "2".repeat(64), configVersion: 1, policyHash: "b".repeat(64),
      profileHash: "f".repeat(64), state: "queued", clarification: [], idempotencyKey: "stale-after-remove",
      selector: null, explicitMode: null, explicitKind: null, version: 2, clarificationDigest: "3".repeat(64),
    }, 1), /PROJECT_AUTHORIZATION_STALE/);
    const { rows: [staleEffects] } = await pool.query(`
      SELECT state, version, (SELECT count(*) FROM jarvis.tasks WHERE request_id=$1)::integer AS tasks
      FROM jarvis.requests WHERE id=$1
    `, [pendingAfterConfigChange.id]);
    assert.deepEqual(staleEffects, { state: "clarification", version: 1, tasks: 0 });

    const concurrentProject = await projectConfigurations.add("owner", {
      repositoryId: "3003", installationId: "00000000-0000-4000-8000-000000000001",
      repositoryOwner: "org", repositoryName: "concurrent-mutations",
    }, { policyHash: "b".repeat(64), profileHash: "f".repeat(64) });
    const mutationBlocker = await lockProjectRow(pool, "3003");
    const mutationPoolOne = new Pool({ connectionString: databaseUrl, max: 1, application_name: "jv201-mutation-one" });
    const mutationPoolTwo = new Pool({ connectionString: databaseUrl, max: 1, application_name: "jv201-mutation-two" });
    const mutationStoreOne = new PostgresProjectConfigStore(mutationPoolOne);
    const mutationStoreTwo = new PostgresProjectConfigStore(mutationPoolTwo);
    const [{ rows: mutationConnectionOne }, { rows: mutationConnectionTwo }] = await Promise.all([
      mutationPoolOne.query("SELECT 1 AS connected"), mutationPoolTwo.query("SELECT 1 AS connected"),
    ]);
    assert.equal(mutationConnectionOne[0].connected, 1);
    assert.equal(mutationConnectionTwo[0].connected, 1);
    let mutationPromises = [];
    let mutationOutcomes;
    try {
      mutationPromises = [
        mutationStoreOne.update("owner", "3003", 1, { repositoryName: "mutation-one" }),
        mutationStoreTwo.update("owner", "3003", 1, { repositoryName: "mutation-two" }),
      ];
      await waitForBlockedQueries(mutationBlocker.client, ["jv201-mutation-one", "jv201-mutation-two"], 2);
      await mutationBlocker.commit();
    } finally {
      if (mutationBlocker.open) await mutationBlocker.rollback();
      if (mutationPromises.length) mutationOutcomes = await Promise.allSettled(mutationPromises);
      await Promise.all([mutationPoolOne.end(), mutationPoolTwo.end()]);
    }
    assert.equal(mutationOutcomes.filter(({ status }) => status === "fulfilled").length, 1,
      "same-version concurrent project updates linearize to exactly one winner");
    const losingMutation = mutationOutcomes.find(({ status }) => status === "rejected");
    assert.ok(losingMutation);
    assert.equal(losingMutation.reason.message, "PROJECT_CONFIG_VERSION_CONFLICT");
    const { rows: [concurrentProjectVersion] } = await pool.query(`
      SELECT p.config_version, p.repository_name, p.state,
        (SELECT count(*) FROM jarvis.project_config_versions c WHERE c.project_id=p.id)::integer AS versions,
        (SELECT count(*) FROM jarvis.audit_events e WHERE e.resource='project:3003')::integer AS audits
      FROM jarvis.projects p WHERE p.repository_id=3003
    `);
    assert.equal(concurrentProjectVersion.config_version, 2);
    assert.ok(["mutation-one", "mutation-two"].includes(concurrentProjectVersion.repository_name));
    assert.equal(concurrentProjectVersion.state, "active");
    assert.equal(concurrentProjectVersion.versions, 2, "only the winning mutation appends a version");
    assert.equal(concurrentProjectVersion.audits, 2, "only the winning mutation appends its audit event");

    const pendingRaceClarification = await projectIntake.submit("owner", {
      idempotencyKey: "clarification-race-key", prompt: "Clarify project after removal", mode: "plan",
    });
    assert.equal(pendingRaceClarification.state, "clarification");
    const clarificationBlocker = await lockProjectRow(pool, "3003");
    let removalForClarification;
    let clarificationPromise;
    let removalAndClarificationOutcomes;
    try {
      removalForClarification = projectConfigurations.remove("owner", "3003", 2);
      await waitForBlockedQueries(clarificationBlocker.client, "jv201-integration");
      clarificationPromise = projectIntake.clarify("owner", pendingRaceClarification.id, pendingRaceClarification.version, {
        idempotencyKey: "clarification-race-key",
        prompt: "Clarify project after removal",
        projectId: concurrentProject.projectId,
        mode: "plan",
      });
      await waitForBlockedQueries(clarificationBlocker.client, "jv201-integration", 2);
      await clarificationBlocker.commit();
    } finally {
      if (clarificationBlocker.open) await clarificationBlocker.rollback();
      const pending = [removalForClarification, clarificationPromise].filter(Boolean);
      if (pending.length) removalAndClarificationOutcomes = await Promise.allSettled(pending);
    }
    assert.equal(removalAndClarificationOutcomes[0].status, "fulfilled");
    assert.equal(removalAndClarificationOutcomes[0].value.state, "removed");
    assert.equal(removalAndClarificationOutcomes[0].value.configVersion, 3);
    assert.equal(removalAndClarificationOutcomes[1].status, "rejected");
    assert.equal(removalAndClarificationOutcomes[1].reason.message, "PROJECT_AUTHORIZATION_STALE");
    const { rows: [clarificationAfterRemoval] } = await pool.query(`
      SELECT r.state, r.version,
        (SELECT count(*) FROM jarvis.tasks t WHERE t.request_id=r.id)::integer AS tasks,
        (SELECT count(*) FROM jarvis.queue_entries q JOIN jarvis.tasks t ON t.id=q.task_id WHERE t.request_id=r.id)::integer AS queue,
        (SELECT count(*) FROM jarvis.outbox o JOIN jarvis.tasks t ON t.id=o.aggregate_id WHERE t.request_id=r.id)::integer AS outbox
      FROM jarvis.requests r WHERE r.id=$1
    `, [pendingRaceClarification.id]);
    assert.deepEqual(clarificationAfterRemoval, { state: "clarification", version: 1, tasks: 0, queue: 0, outbox: 0 });

    const admissionRaceProject = await projectConfigurations.add("owner", {
      repositoryId: "3004", installationId: "00000000-0000-4000-8000-000000000001",
      repositoryOwner: "org", repositoryName: "admission-removal-race",
    }, { policyHash: "b".repeat(64), profileHash: "f".repeat(64) });
    const admissionBlocker = await lockProjectRow(pool, "3004");
    let removalForAdmission;
    let admissionPromise;
    let removalAndAdmissionOutcomes;
    try {
      removalForAdmission = projectConfigurations.remove("owner", "3004", 1);
      await waitForBlockedQueries(admissionBlocker.client, "jv201-integration");
      admissionPromise = projectIntake.submit("owner", {
        idempotencyKey: "submit-removal-race-3004",
        prompt: "Submit while project removal is waiting",
        projectId: admissionRaceProject.projectId,
        mode: "plan",
      });
      await waitForBlockedQueries(admissionBlocker.client, "jv201-integration", 2);
      await admissionBlocker.commit();
    } finally {
      if (admissionBlocker.open) await admissionBlocker.rollback();
      const pending = [removalForAdmission, admissionPromise].filter(Boolean);
      if (pending.length) removalAndAdmissionOutcomes = await Promise.allSettled(pending);
    }
    assert.equal(removalAndAdmissionOutcomes[0].status, "fulfilled");
    assert.equal(removalAndAdmissionOutcomes[0].value.state, "removed");
    assert.equal(removalAndAdmissionOutcomes[1].status, "rejected");
    assert.equal(removalAndAdmissionOutcomes[1].reason.message, "PROJECT_AUTHORIZATION_STALE");
    const { rows: [rejectedAdmissionEffects] } = await pool.query(`
      SELECT
        (SELECT count(*) FROM jarvis.requests r WHERE r.owner_id='owner' AND r.idempotency_key='submit-removal-race-3004')::integer AS requests,
        (SELECT count(*) FROM jarvis.tasks t JOIN jarvis.requests r ON r.id=t.request_id WHERE r.idempotency_key='submit-removal-race-3004')::integer AS tasks,
        (SELECT count(*) FROM jarvis.queue_entries q JOIN jarvis.tasks t ON t.id=q.task_id JOIN jarvis.requests r ON r.id=t.request_id WHERE r.idempotency_key='submit-removal-race-3004')::integer AS queue,
        (SELECT count(*) FROM jarvis.outbox o JOIN jarvis.tasks t ON t.id=o.aggregate_id JOIN jarvis.requests r ON r.id=t.request_id WHERE r.idempotency_key='submit-removal-race-3004')::integer AS outbox
    `);
    assert.deepEqual(rejectedAdmissionEffects, { requests: 0, tasks: 0, queue: 0, outbox: 0 });

    const admittedBeforeRemoval = await projectConfigurations.add("owner", {
      repositoryId: "3005", installationId: "00000000-0000-4000-8000-000000000001",
      repositoryOwner: "org", repositoryName: "admitted-before-removal",
    }, { policyHash: "b".repeat(64), profileHash: "f".repeat(64) });
    const admittedTaskRequest = await projectIntake.submit("owner", {
      idempotencyKey: "submit-before-removal-3005",
      prompt: "Submit before project removal",
      projectId: admittedBeforeRemoval.projectId,
      mode: "plan",
    });
    assert.equal(admittedTaskRequest.state, "queued");
    const { rows: [admittedTask] } = await pool.query(`
      SELECT t.id FROM jarvis.tasks t WHERE t.request_id=$1
    `, [admittedTaskRequest.id]);
    assert.ok(admittedTask);
    const { rows: [outboxBeforeClaim] } = await pool.query(
      "SELECT count(*)::integer AS count FROM jarvis.outbox WHERE aggregate_id=$1", [admittedTask.id]);
    assert.equal(outboxBeforeClaim.count, 1);
    const removedAfterAdmission = await projectConfigurations.remove("owner", "3005", 1);
    assert.equal(removedAfterAdmission.state, "removed");
    assert.equal(await queue.claim("worker-after-project-removal", 60_000), null,
      "a request admitted before removal is not claimable after the project is removed");
    const { rows: [unclaimedAfterRemoval] } = await pool.query(`
      SELECT r.state AS request_state, t.state AS task_state, q.state AS queue_state,
        (SELECT count(*) FROM jarvis.task_attempts a WHERE a.task_id=t.id)::integer AS attempts,
        (SELECT count(*) FROM jarvis.outbox o WHERE o.aggregate_id=t.id)::integer AS outbox
      FROM jarvis.requests r
      JOIN jarvis.tasks t ON t.request_id=r.id
      JOIN jarvis.queue_entries q ON q.task_id=t.id
      WHERE r.id=$1
    `, [admittedTaskRequest.id]);
    assert.deepEqual(unclaimedAfterRemoval, {
      request_state: "queued", task_state: "queued", queue_state: "queued", attempts: 0, outbox: outboxBeforeClaim.count,
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
      if (authClient) {
        await authClient.query("ROLLBACK").catch(() => undefined);
        authClient.release();
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
                  WHEN 'owner_accounts' THEN 0
                  WHEN 'owner_sessions' THEN 0
                  WHEN 'policies' THEN 1
                  WHEN 'projects' THEN 5
                  WHEN 'project_config_versions' THEN 12
                  WHEN 'audit_events' THEN 11
                  WHEN 'project_skills' THEN 1
                  WHEN 'project_skill_approvals' THEN 4
                  WHEN 'requests' THEN 10
                  WHEN 'tasks' THEN 7
                  WHEN 'task_attempts' THEN 5
                  WHEN 'task_checkpoints' THEN 1
                  WHEN 'queue_entries' THEN 6
                  WHEN 'outbox' THEN 14
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
