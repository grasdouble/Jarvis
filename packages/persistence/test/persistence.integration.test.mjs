import assert from "node:assert/strict";
import { describe, test } from "node:test";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import https from "node:https";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  PostgresTaskResultReadModel,
  createSandboxLeaseStore,
  SandboxLeaseRejectedError,
} from "../dist/index.js";
import { ProjectRequestIntake } from "@jarvis/domain";
import { QueueError, QueueService } from "@jarvis/queue";

const { Pool } = pg;
const databaseUrl = process.env.JARVIS_TEST_DATABASE_URL;
const expectedDatabaseName = process.env.JARVIS_TEST_EXPECTED_DATABASE_NAME;
const restoreGateDatabaseUrl = process.env.JV265_RESTORE_GATE_DATABASE_URL;
function parseSafePostgresUrl(value, { allowLocalhost = false } = {}) {
  assert.equal(typeof value, "string", "a PostgreSQL URL is required");
  let url;
  try { url = new URL(value); }
  catch { throw new Error("database URL must be a valid PostgreSQL URL"); }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "database must use PostgreSQL");
  assert.ok(url.hostname === "127.0.0.1" || (allowLocalhost && url.hostname === "localhost"),
    "database must use explicit IPv4 loopback or localhost with an expected workflow database name");
  assert.ok(url.port !== "" && Number(url.port) >= 1 && Number(url.port) <= 65535, "database must specify a valid local mapped port");
  assert.ok(url.username && url.password, "database credentials are required");
  assert.equal(url.search, "", "database URL options are not permitted");
  assert.equal(url.hash, "", "database URL fragments are not permitted");
  return { url, databaseName: decodeURIComponent(url.pathname.slice(1)) };
}
function validateExpectedDatabaseName(value) {
  if (value !== undefined) {
    assert.match(value, /^jarvis_integration_(?:auto|manual)_[0-9]+_[0-9]+$/,
      "expected workflow database must use the per-run naming scheme");
  }
}
function validateIntegrationDatabaseUrl(value, { expectedDatabaseName } = {}) {
  validateExpectedDatabaseName(expectedDatabaseName);
  const { databaseName } = parseSafePostgresUrl(value, { allowLocalhost: expectedDatabaseName !== undefined });
  if (expectedDatabaseName !== undefined) {
    assert.equal(databaseName, expectedDatabaseName, "database URL must match the expected workflow database");
  } else {
    assert.match(databaseName, /^jarvis_issue8_[a-f0-9]{32}$/,
      "local integration requires a uniquely named jarvis_issue8_ disposable database");
  }
  return databaseName;
}
function validateRestoreGateDatabaseUrl(value, { expectedDatabaseName } = {}) {
  validateExpectedDatabaseName(expectedDatabaseName);
  const { databaseName } = parseSafePostgresUrl(value, { allowLocalhost: expectedDatabaseName !== undefined });
  assert.match(databaseName, /^jv265_restore_[a-f0-9-]{36}$/i,
    "refusing a database not explicitly named as a JV-265 disposable restore target");
  return databaseName;
}
if (databaseUrl !== undefined) {
  validateIntegrationDatabaseUrl(databaseUrl, { expectedDatabaseName });
}
if (restoreGateDatabaseUrl !== undefined) {
  validateRestoreGateDatabaseUrl(restoreGateDatabaseUrl, { expectedDatabaseName });
}
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

test("JV-265 restored PostgreSQL state stays behind the real worker activation gate", {
  skip: restoreGateDatabaseUrl === undefined && process.env.JV265_RESTORE_GATE_POSTGRES_CONTAINER_ID === undefined
    ? "set JV265_RESTORE_GATE_DATABASE_URL or the trusted ephemeral PostgreSQL service container ID" : false,
}, async () => {
  const fixture = restoreGateDatabaseUrl === undefined ? await provisionRestoreGateDatabase() : undefined;
  const targetUrl = fixture?.url ?? restoreGateDatabaseUrl;
  const databaseName = validateRestoreGateDatabaseUrl(targetUrl, { expectedDatabaseName });
  const pool = new Pool({ connectionString: targetUrl, max: 3, application_name: "jv265-restore-gate-integration" });
  let testFailure;
  try {
    const { rows: [identity] } = await pool.query("SELECT current_database() AS name");
    assert.equal(identity.name, databaseName);
    const { PostgresPersistence } = await import("../dist/index.js");
    const { createRestoreActivationGate, createQueueWorker } = await import("../../../apps/worker/dist/index.js");
    const persistence = new PostgresPersistence(pool);
    await persistence.migrate();
    const controls = new PostgresStopControlStore(pool);
    const beforeRestoreActivation = await controls.get({});
    assert.equal(beforeRestoreActivation.global.stopped, false, "source backup must retain a resumed global control before restore activation");
    const { rows: [restoredResume] } = await pool.query(`SELECT count(*)::integer AS count FROM jarvis.audit_events
      WHERE actor='owner' AND action='stop.resume' AND resource='global'`);
    assert.equal(restoredResume.count, 1, "restored database must contain the source's durable resume audit");

    const gate = createRestoreActivationGate(async () => controls.suspendAfterRestore());
    const taskId = randomUUID();
    const task = { id: taskId, taskId };
    const leases = [1, 2].map((epoch) => ({ task, worker: "jv265-restore-worker", attemptId: randomUUID(), epoch,
      expiresAt: Date.now() + 60_000 }));
    let claims = 0;
    let dispatches = 0;
    let cancellations = 0;
    const queue = {
      claim: async () => { claims += 1; return leases.shift() ?? null; },
      complete: async () => {}, fail: async () => {}, cancel: async () => { cancellations += 1; },
    };
    const worker = createQueueWorker({
      queue, workerId: "jv265-restore-worker", leaseMs: 30_000,
      hydrate: async () => ({ taskId, projectId: "synthetic-project", capability: "synthetic-only" }),
      restoreGate: gate,
      trustedResultContext: async (lease) => ({
        resultId: randomUUID(),
        expected: { requestId: randomUUID(), taskId: lease.task.taskId, attemptId: lease.attemptId, leaseEpoch: lease.epoch, mode: "review", sourceRevision: "a".repeat(40), snapshotDigest: "b".repeat(64), provider: "synthetic", model: "synthetic" },
      }),
      execution: {
        readStop: async () => {
          const state = await controls.get({});
          return { stopped: state.global.stopped || state.project?.stopped === true, version: state.global.version };
        },
        dispatch: async () => { dispatches += 1; return { payload: { summary: "Synthetic restored task", steps: [], affectedAreas: [], assumptions: [], risks: [], questions: [], limitations: [] } }; },
        revokeCapability: async () => {}, stopSandbox: async () => "stopped", recordAcceptedEffectUnknown: async () => {},
      },
    });

    let activated = false;
    const waiting = worker.runOnce();
    try {
      await delay(30);
      assert.equal(claims, 0, "worker claimed before explicit restore activation");
      assert.equal(dispatches, 0, "worker dispatched before explicit restore activation");
      await gate.activateAfterRestore();
      activated = true;
      assert.equal(await waiting, "cancelled", "restored stop prevents dispatch after gate activation");
      assert.equal(claims, 1);
      assert.equal(cancellations, 1);
      assert.equal(dispatches, 0);
      const suspended = await controls.get({});
      assert.equal(suspended.global.stopped, true);
      assert.equal(suspended.global.changedBy, "system:restore");
      assert.equal(suspended.global.version, beforeRestoreActivation.global.version + 1,
        "durable restore suspension advances the restored global-control fencing version");
      const { rows: [restoreAudit] } = await pool.query(`SELECT count(*)::integer AS count FROM jarvis.audit_events
        WHERE actor='system:restore' AND action='stop.restore_suspend' AND resource='global'`);
      assert.equal(restoreAudit.count, 1, "restore suspension audit was not durable exactly once");

      await controls.set({ stopped: false, expectedVersion: suspended.global.version, ownerId: "owner" });
      assert.equal(await worker.runOnce(), "completed", "explicitly resumed restored database permits fresh synthetic work");
      assert.equal(claims, 2);
      assert.equal(dispatches, 1);
    } finally {
      if (!activated) await gate.activateAfterRestore().catch(() => undefined);
      await pool.end();
    }
  } catch (error) {
    testFailure = error;
  } finally {
    const cleanupFailures = await runCleanupSteps([
      async () => { if (!pool.ended) await pool.end(); },
      async () => { await fixture?.cleanup(); },
    ]);
    throwCollectedFailures(testFailure, cleanupFailures);
  }
});

async function provisionRestoreGateDatabase() {
  const containerId = process.env.JV265_RESTORE_GATE_POSTGRES_CONTAINER_ID;
  if (!containerId) return undefined;
  assert.match(containerId, /^[0-9a-f]{12,64}$/i, "invalid ephemeral PostgreSQL service container ID");
  assert.ok(expectedDatabaseName !== undefined, "automatic restore fixture requires an explicit per-run workflow database name");
  assert.ok(databaseUrl, "JARVIS_TEST_DATABASE_URL is required with the CI restore fixture");
  validateIntegrationDatabaseUrl(databaseUrl, { expectedDatabaseName });
  const { url: base } = parseSafePostgresUrl(databaseUrl, { allowLocalhost: true });
  const runId = randomUUID();
  const sourceName = `jv265_source_${runId.replaceAll("-", "")}`;
  const targetName = `jv265_restore_${runId}`;
  const dumpPath = `/tmp/${sourceName}.dump`;
  assert.match(sourceName, /^jv265_source_[a-f0-9]{32}$/);
  assert.match(targetName, /^jv265_restore_[a-f0-9-]{36}$/);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1, application_name: "jv265-restore-fixture" });
  const exec = (args, input) => {
    const result = spawnSync("docker", ["exec", ...(input === undefined ? [] : ["-i"]), containerId, ...args], {
      input, encoding: null, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PGPASSWORD: decodeURIComponent(base.password) },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `PostgreSQL fixture utility failed (${args[0]})`);
    return result.stdout;
  };
  let sourceCreated = false;
  let targetCreated = false;
  let transferred = false;
  let adminEnded = false;
  let operationFailure;
  try {
    await admin.query(`CREATE DATABASE "${sourceName}"`);
    sourceCreated = true;
    await admin.query(`CREATE DATABASE "${targetName}"`);
    targetCreated = true;
    const sourceUrl = new URL(databaseUrl);
    sourceUrl.pathname = `/${sourceName}`;
    const sourcePool = new Pool({ connectionString: sourceUrl.toString(), max: 2 });
    try {
      const persistence = new PostgresPersistence(sourcePool);
      await persistence.migrate();
      const sourceControls = new PostgresStopControlStore(sourcePool);
      const initialControls = await sourceControls.get({});
      await sourceControls.set({ stopped: false, expectedVersion: initialControls.global.version, ownerId: "owner" });
    } finally { await sourcePool.end(); }
    exec(["pg_dump", "--format=custom", "--no-owner", "--username", base.username, "--dbname", sourceName, "--file", dumpPath]);
    exec(["pg_restore", "--no-owner", "--no-acl", "--exit-on-error", "--username", base.username, "--dbname", targetName, dumpPath]);
    const targetUrl = new URL(databaseUrl);
    targetUrl.pathname = `/${targetName}`;
    await admin.end();
    adminEnded = true;
    transferred = true;
    return { url: targetUrl.toString(), cleanup: async () => runCleanupSteps([
      async () => { exec(["rm", "-f", "--", dumpPath]); },
      async () => dropOwnedDatabases(),
    ]).then((failures) => throwCollectedFailures(undefined, failures)) };
  } catch (error) {
    operationFailure = error;
    throw error;
  } finally {
    const cleanupFailures = await runCleanupSteps([
      async () => { if (!adminEnded) await admin.end(); },
      async () => { if (!transferred) exec(["rm", "-f", "--", dumpPath]); },
      async () => { if (!transferred) await dropOwnedDatabases(); },
    ]);
    throwCollectedFailures(operationFailure, cleanupFailures);
  }

  async function dropOwnedDatabases() {
    const cleanup = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    const failures = await runCleanupSteps([
      async () => { if (targetCreated) await cleanup.query(`DROP DATABASE IF EXISTS "${targetName}" WITH (FORCE)`); },
      async () => { if (sourceCreated) await cleanup.query(`DROP DATABASE IF EXISTS "${sourceName}" WITH (FORCE)`); },
      async () => { await cleanup.end(); },
    ]);
    throwCollectedFailures(undefined, failures);
  }
}

function createSyntheticSandboxTls() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-issue242-integration-tls-"));
  const openssl = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "server.ext"), "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  writeFileSync(join(dir, "worker.ext"), "subjectAltName=URI:spiffe://jarvis/worker\nextendedKeyUsage=clientAuth\n");
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=synthetic-integration-ca", "-days", "1");
  for (const name of ["server", "worker"]) {
    openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`);
    openssl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "1", "-extfile", `${name}.ext`);
  }
  const read = (name) => readFileSync(join(dir, name));
  return { dir, ca: read("ca.crt"), serverCert: read("server.crt"), serverKey: read("server.key"), workerCert: read("worker.crt"), workerKey: read("worker.key") };
}

async function runCleanupSteps(steps) {
  const failures = [];
  for (const step of steps) {
    try { await step(); }
    catch (error) { failures.push(error); }
  }
  return failures;
}

function throwCollectedFailures(testFailure, cleanupFailures) {
  const failures = [...(testFailure ? [testFailure] : []), ...cleanupFailures];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "integration test and cleanup failed");
}

describe("PostgreSQL persistence integration", { concurrency: false }, () => {
test("integration URL guard rejects unsafe targets before a pool can be created", () => {
  const valid = "postgresql://test:secret@127.0.0.1:54321/jarvis_issue8_0123456789abcdef0123456789abcdef";
  assert.equal(validateIntegrationDatabaseUrl(valid), "jarvis_issue8_0123456789abcdef0123456789abcdef");
  const runDatabase = "jarvis_integration_auto_123456789_2";
  assert.throws(() => validateIntegrationDatabaseUrl(`postgresql://test:secret@127.0.0.1:5432/${runDatabase}`),
    "local mode must retain its dedicated reviewer database-name contract");
  assert.equal(validateIntegrationDatabaseUrl(`postgresql://test:secret@localhost:5432/${runDatabase}`,
    { expectedDatabaseName: runDatabase }), runDatabase);
  for (const target of [
    "postgresql://test:secret@example.com:5432/jarvis_issue8_0123456789abcdef0123456789abcdef",
    "postgresql://test:secret@localhost:5432/jarvis_issue8_0123456789abcdef0123456789abcdef",
    "postgresql://test:secret@[::1]:5432/jarvis_issue8_0123456789abcdef0123456789abcdef",
    "postgresql://test:secret@127.0.0.1:5432/jarvis_production",
    "postgresql://test:secret@127.0.0.1:5432/jarvis_issue8_0123456789abcdef0123456789abcdef?host=remote.example",
    "postgresql://test:secret@127.0.0.1:5432/jarvis_integration_auto",
    "postgresql://test:secret@127.0.0.1:5432/jarvis_integration_manual",
  ]) {
    assert.throws(() => validateIntegrationDatabaseUrl(target));
  }
  assert.throws(() => validateIntegrationDatabaseUrl(
    "postgresql://test:secret@localhost:5432/jarvis_integration_auto", { expectedDatabaseName: "jarvis_integration_auto" }),
  "fixed workflow database names must remain rejected");
  assert.throws(() => validateIntegrationDatabaseUrl(
    `postgresql://test:secret@localhost:5432/${runDatabase}`, { expectedDatabaseName: "jarvis_integration_auto" }),
  "expected name must match the per-run workflow naming scheme");
  assert.throws(() => validateIntegrationDatabaseUrl(
    `postgresql://test:secret@localhost:5432/${runDatabase}`,
    { expectedDatabaseName: `${runDatabase}?options=-c%20search_path=public` }),
  "expected name must not accept URL options or arbitrary suffixes");
});

test("restore-gate URL guard rejects unsafe supplied targets before a pool can be created", () => {
  const valid = "postgresql://test:secret@127.0.0.1:54321/jv265_restore_01234567-89ab-cdef-0123-456789abcdef";
  assert.equal(validateRestoreGateDatabaseUrl(valid), "jv265_restore_01234567-89ab-cdef-0123-456789abcdef");
  for (const target of [
    "postgresql://test:secret@db.example:5432/jv265_restore_01234567-89ab-cdef-0123-456789abcdef",
    "postgresql://test:secret@localhost:5432/jv265_restore_01234567-89ab-cdef-0123-456789abcdef",
    "postgresql://test:secret@[::1]:5432/jv265_restore_01234567-89ab-cdef-0123-456789abcdef",
    "postgresql://test:secret@127.0.0.1:5432/jv265_source_0123456789abcdef0123456789abcdef",
    "postgresql://test:secret@127.0.0.1:5432/jv265_restore_01234567-89ab-cdef-0123-456789abcdef?host=remote.example",
  ]) {
    assert.throws(() => validateRestoreGateDatabaseUrl(target));
  }
  assert.equal(validateRestoreGateDatabaseUrl(
    "postgresql://test:secret@localhost:5432/jv265_restore_01234567-89ab-cdef-0123-456789abcdef",
    { expectedDatabaseName: "jarvis_integration_manual_123456789_2" }), "jv265_restore_01234567-89ab-cdef-0123-456789abcdef");
  const runnerSourceUrl = new URL("postgresql://test:secret@localhost:5432/jarvis_integration_auto_123456789_2");
  runnerSourceUrl.pathname = "/jv265_restore_01234567-89ab-cdef-0123-456789abcdef";
  assert.equal(validateRestoreGateDatabaseUrl(runnerSourceUrl.toString(), { expectedDatabaseName: "jarvis_integration_auto_123456789_2" }),
    "jv265_restore_01234567-89ab-cdef-0123-456789abcdef",
    "the automatic fixture's target URL remains valid on the trusted service-container runner");
});

test("cleanup records every phase failure and continues later phases", async () => {
  const events = [];
  const firstFailure = new Error("rollback failed");
  const secondFailure = new Error("pool close failed");
  const failures = await runCleanupSteps([
    async () => { events.push("rollback"); throw firstFailure; },
    async () => { events.push("release"); throw secondFailure; },
    async () => { events.push("later cleanup"); },
  ]);

  assert.deepEqual(events, ["rollback", "release", "later cleanup"]);
  assert.deepEqual(failures, [firstFailure, secondFailure]);
  const testFailure = new Error("test assertion failed");
  assert.throws(() => throwCollectedFailures(testFailure, failures), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [testFailure, firstFailure, secondFailure]);
    return true;
  });
});

async function waitForBlockedQueries(client, applicationNames, expectedCount = 1, isOperationSettled = () => false) {
  const names = Array.isArray(applicationNames) ? applicationNames : [applicationNames];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (isOperationSettled()) return "settled";
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

async function createStopRaceFixture(pool, mode, policyVersion = 1) {
  await new PostgresPersistence(pool).migrate();
  const fixture = {
    installationId: randomUUID(),
    policyId: randomUUID(),
    projectId: randomUUID(),
    requestId: randomUUID(),
    taskId: randomUUID(),
    attemptId: randomUUID(),
    repositoryId: Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
    policyHash: policyVersion === 1 ? "b".repeat(64) : String(policyVersion).padStart(64, "0"),
    profileHash: "f".repeat(64),
    promptDigest: "e".repeat(64),
    revision: "a".repeat(40),
    state: mode === "checkpoint" ? "running" : "queued",
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`INSERT INTO jarvis.installations(id, github_id, app_id, state)
      VALUES ($1, $2, 2001, 'active')`, [fixture.installationId, fixture.repositoryId]);
    await client.query(`INSERT INTO jarvis.policies(id, version, canonical_json, hash, activated_at)
      VALUES ($1, $2, $3::jsonb, $4, now())`, [
      fixture.policyId, policyVersion, JSON.stringify({ version: policyVersion }), fixture.policyHash,
    ]);
    await client.query(`INSERT INTO jarvis.projects(id, repository_id, installation_id, owner_id, repository_name, state, config_version)
      VALUES ($1, $2, $3, 'owner-race', 'stop-race', 'active', 1)`, [fixture.projectId, fixture.repositoryId, fixture.installationId]);
    await client.query(`INSERT INTO jarvis.project_config_versions
      (project_id, repository_id, version, config_json, config_hash, policy_hash, created_by)
      VALUES ($1, $2, 1, '{"schemaVersion":1}', $3, $4, 'owner-race')`, [
      fixture.projectId, fixture.repositoryId, "a".repeat(64), fixture.policyHash,
    ]);
    await client.query(`INSERT INTO jarvis.requests
      (id, owner_id, project_id, repository_id, mode, prompt_digest, state, idempotency_key, config_version, policy_hash)
      VALUES ($1, 'owner-race', $2, $3, 'plan', $4, $5, $6, 1, $7)`, [
      fixture.requestId, fixture.projectId, fixture.repositoryId, fixture.promptDigest,
      mode === "checkpoint" ? "running" : "queued", `stop-race-${fixture.taskId}`, fixture.policyHash,
    ]);
    await client.query(`INSERT INTO jarvis.tasks
      (id, request_id, project_id, repository_id, mode, revision, profile_hash, policy_hash, config_version, state, dedupe_key)
      VALUES ($1, $2, $3, $4, 'plan', $5, $6, $7, 1, $8, $9)`, [
      fixture.taskId, fixture.requestId, fixture.projectId, fixture.repositoryId, fixture.revision,
      fixture.profileHash, fixture.policyHash, fixture.state, `stop-race-${fixture.taskId}`,
    ]);
    if (mode === "checkpoint") {
      await client.query(`INSERT INTO jarvis.task_attempts
        (id, task_id, project_id, repository_id, ordinal, lease_epoch, lease_until, state)
        VALUES ($1, $2, $3, $4, 1, 1, now() + interval '1 hour', 'active')`, [
        fixture.attemptId, fixture.taskId, fixture.projectId, fixture.repositoryId,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const controls = new PostgresStopControlStore(pool);
  try {
    const { global } = await controls.get({ projectId: fixture.projectId });
    await controls.set({ stopped: false, expectedVersion: global.version, ownerId: "owner" });
  } catch (error) {
    await resetStopRaceFixture(pool).catch(() => undefined);
    throw error;
  }
  return fixture;
}

async function resetStopRaceFixture(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DO $$ DECLARE tables text; BEGIN
      SELECT string_agg(format('jarvis.%I', tablename), ', ') INTO tables
      FROM pg_tables WHERE schemaname = 'jarvis' AND tablename <> 'schema_migrations';
      EXECUTE 'TRUNCATE TABLE ' || tables;
    END $$`);
    await client.query(`INSERT INTO jarvis.stop_controls(scope, project_id, stopped, version, changed_by)
      VALUES ('global', NULL, true, 1, 'system')`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function waitForStopBlockOrReturn(inspector, applicationName, isReturned) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (isReturned()) return "returned";
    const { rows: [activity] } = await inspector.query(`
      SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = $1
        AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
    `, [applicationName]);
    if (activity.count > 0) return "blocked";
    await delay(5);
  }
  throw new Error(`Stop mutation from ${applicationName} neither returned nor blocked on a database lock`);
}

async function exercisePauseRace(mode, scope) {
  const operationName = `jv203-${mode}-operation`;
  const stopName = `jv203-${mode}-stop`;
  const fixturePool = new Pool({ connectionString: databaseUrl, max: 5, application_name: "jv203-race-fixture" });
  const operationPool = new Pool({ connectionString: databaseUrl, max: 2, application_name: operationName });
  const stopPool = new Pool({ connectionString: databaseUrl, max: 2, application_name: stopName });
  const blockerPool = new Pool({ connectionString: databaseUrl, max: 1, application_name: "jv203-race-blocker" });
  let fixture;
  let blocker;
  let operationPromise;
  let pausePromise;
  let testFailure;
  try {
    fixture = await createStopRaceFixture(fixturePool, mode);
    blocker = await blockerPool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM jarvis.tasks WHERE id = $1 FOR UPDATE", [fixture.taskId]);

    const operationResult = mode === "enqueue"
      ? new PostgresQueueStore(operationPool).enqueue({
        id: fixture.taskId, eventId: `stop-race-${fixture.taskId}`, taskId: fixture.taskId,
        payload: { taskId: fixture.taskId }, status: "queued", createdAt: Date.now(), availableAt: Date.now(),
        deadline: Date.now() + 60_000, maxAttempts: 3, attempt: 0, epoch: 0,
        retry: { baseDelay: 100, maxDelay: 1_000 },
      }, `stop-race-${fixture.taskId}`)
      : new PostgresPersistence(operationPool).saveCheckpoint({
        taskId: fixture.taskId, attemptId: fixture.attemptId, projectId: fixture.projectId, leaseEpoch: 1,
        step: "stop-race-checkpoint", schemaVersion: 1,
        state: { phase: "plan_validated", configVersion: 1, policyHash: fixture.policyHash }, requiredSkills: [],
      });
    let pauseReturned = false;
    let operationSettled = false;
    let operationCommittedAfterPause = false;
    operationPromise = operationResult.then((value) => {
      operationSettled = true;
      operationCommittedAfterPause = pauseReturned;
      return { status: "fulfilled", value };
    }, (reason) => {
      operationSettled = true;
      return { status: "rejected", reason };
    });
    const controls = new PostgresStopControlStore(stopPool);
    const snapshot = await controls.get({ projectId: fixture.projectId });
    const expectedVersion = scope === "global" ? snapshot.global.version : snapshot.project?.version ?? 0;
    pausePromise = controls.set({
      ...(scope === "project" ? { projectId: fixture.projectId } : {}),
      stopped: true, expectedVersion, ownerId: "owner",
    }).then(() => {
      pauseReturned = true;
      return { status: "fulfilled" };
    }, (reason) => ({ status: "rejected", reason }));

    await waitForBlockedQueries(blocker, operationName, 1, () => operationSettled);
    const pauseState = await waitForStopBlockOrReturn(blocker, stopName, () => pauseReturned);
    await blocker.query("COMMIT");
    blocker.release();
    blocker = undefined;
    const [operationOutcome, pauseOutcome] = await Promise.all([operationPromise, pausePromise]);
    assert.equal(pauseOutcome.status, "fulfilled", "pause mutation should complete successfully");
    assert.equal(operationCommittedAfterPause, false, `${mode} must not commit after ${scope} pause returns`);
    if (pauseState === "blocked") {
      assert.equal(operationOutcome.status, "fulfilled", `${mode} should finish before the waiting ${scope} pause returns`);
    } else {
      assert.equal(operationOutcome.status, "rejected", `${mode} must fail closed when ${scope} pause wins the lock race`);
      if (mode === "enqueue") {
        assert.equal(operationOutcome.reason?.code, "TASK_NOT_AUTHORIZED");
      } else {
        assert.ok(operationOutcome.reason instanceof CheckpointRejectedError);
      }
    }
  } catch (error) {
    testFailure = error;
  }

  const cleanupFailures = await runCleanupSteps([
    async () => { if (blocker) await blocker.query("ROLLBACK"); },
    async () => {
      if (blocker) {
        blocker.release();
        blocker = undefined;
      }
    },
    async () => {
      if (operationPromise || pausePromise) {
        await Promise.allSettled([operationPromise, pausePromise].filter(Boolean));
      }
    },
    async () => operationPool.end(),
    async () => stopPool.end(),
    async () => blockerPool.end(),
    async () => { if (fixture) await resetStopRaceFixture(fixturePool); },
    async () => fixturePool.end(),
  ]);
  throwCollectedFailures(testFailure, cleanupFailures);
}

test("PostgreSQL migrations and checkpoint authorization work against the real database", {
  skip: databaseUrl === undefined ? "set JARVIS_TEST_DATABASE_URL to a disposable empty database" : false,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 5, application_name: "jv201-integration" });
  let client;
  let authClient;
  let lockClient;
  let fixtureCommitted = false;
  let testFailure;
  try {
    for (const scope of ["global", "project"]) {
      await exercisePauseRace("enqueue", scope);
      await exercisePauseRace("checkpoint", scope);
    }
    const { rows: [database] } = await pool.query("SELECT current_database() AS name");
    if (expectedDatabaseName !== undefined) {
      assert.equal(database.name, expectedDatabaseName,
        `integration run requires database ${expectedDatabaseName}, got ${database.name}`);
    } else {
      assert.match(database.name, /^jarvis_issue8_[a-f0-9]{32}$/,
        "local reviewer integration requires a uniquely named jarvis_issue8_ disposable database");
    }

    const persistence = new PostgresPersistence(pool);
    await persistence.migrate();
    await persistence.migrate();
    const { rows: migrations } = await pool.query("SELECT version FROM jarvis.schema_migrations");
    assert.deepEqual(migrations.map(({ version }) => version), ["001_initial", "002_skill_approval_order", "003_durable_queue", "004_project_request_intake", "005_owner_auth", "006_project_configuration_api", "007_durable_stop_controls", "008_sandbox_reservations", "009_task_results", "010_usage_accounting"]);
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
    const { PostgresUsageAccountingStore } = await import("../dist/index.js");
    const accounting = new PostgresUsageAccountingStore(pool);
    const dispatchedAt = "2026-01-01T00:00:00.000Z";
    const periodEnd = "2026-02-01T00:00:00.000Z";
    const boundaryRequestId = randomUUID();
    const boundaryOperationId = randomUUID();
    await pool.query(`INSERT INTO jarvis.model_requests
      (id,request_id,task_id,attempt_id,purpose,provider,model,profile_version,dispatched_at,state,
       operation_id,dispatch_attempt,purpose_version,requested_model,lifecycle,mapping_version)
      VALUES ($1,'00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005',
        '00000000-0000-4000-8000-000000000006','task_execution','openai','boundary-model',1,$2,'dispatched',
        $3,1,'jarvis-usage-v1','boundary-model','dispatched','openai-chat-completions-v1')`,
    [boundaryRequestId, dispatchedAt, boundaryOperationId]);
    const periodEndRequestId = randomUUID();
    const periodEndOperationId = randomUUID();
    await pool.query(`INSERT INTO jarvis.model_requests
      (id,request_id,task_id,attempt_id,purpose,provider,model,profile_version,dispatched_at,state,
       operation_id,dispatch_attempt,purpose_version,requested_model,lifecycle,mapping_version)
      VALUES ($1,'00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005',
        '00000000-0000-4000-8000-000000000006','task_execution','openai','boundary-model',1,$2,'succeeded',
        $3,1,'jarvis-usage-v1','boundary-model','succeeded','openai-chat-completions-v1')`,
    [periodEndRequestId, periodEnd, periodEndOperationId]);
    const cancelRequestId = randomUUID();
    const cancelOperationId = randomUUID();
    const retryRequestId = randomUUID();
    const retryOperationId = randomUUID();
    const recoveryPreparedRequestId = randomUUID();
    const recoveryDispatchedRequestId = randomUUID();
    const seedRequest = async ({ id, operationId, dispatchAttempt = 1, lifecycle, dispatchedAt }) => {
      await pool.query(`INSERT INTO jarvis.model_requests
        (id,request_id,task_id,attempt_id,purpose,provider,model,profile_version,dispatched_at,state,
         operation_id,dispatch_attempt,purpose_version,requested_model,lifecycle,mapping_version)
        VALUES ($1,'00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005',
          '00000000-0000-4000-8000-000000000006','task_execution','openai','boundary-model',1,$2,$3,
          $4,$5,'jarvis-usage-v1','boundary-model',$3,'openai-chat-completions-v1')`,
      [id, dispatchedAt, lifecycle, operationId, dispatchAttempt]);
    };
    await seedRequest({ id: cancelRequestId, operationId: cancelOperationId, lifecycle: "dispatched", dispatchedAt: "2026-01-01T00:01:00.000Z" });
    await seedRequest({ id: retryRequestId, operationId: retryOperationId, lifecycle: "dispatched", dispatchedAt: "2026-01-01T00:00:06.000Z" });
    const recoveryPreparedOperationId = randomUUID();
    const recoveryDispatchedOperationId = randomUUID();
    await seedRequest({ id: recoveryPreparedRequestId, operationId: recoveryPreparedOperationId, lifecycle: "prepared", dispatchedAt: "2026-01-01T00:02:00.000Z" });
    await seedRequest({ id: recoveryDispatchedRequestId, operationId: recoveryDispatchedOperationId, lifecycle: "dispatched", dispatchedAt: "2026-01-01T00:03:00.000Z" });
    const periodUsage = (inputTotal, outputTotal, cacheReadInput, cacheWriteInput, reasoningOutput) => ({
      mappingVersion: "openai-chat-completions-v1",
      counters: { inputTotal, outputTotal, cacheReadInput, cacheWriteInput, reasoningOutput },
      coverage: { inputTotal: "reported", outputTotal: "reported", cacheReadInput: "reported", cacheWriteInput: "reported", reasoningOutput: "reported" },
    });
    const usage2000 = periodUsage(2000, 300, 1500, 200, 100);
    const usage10 = periodUsage(10, 2, 4, 1, 1);
    const usage4 = periodUsage(4, 1, 1, 0, 0);
    const unknownUsage = {
      mappingVersion: "openai-chat-completions-v1",
      counters: { inputTotal: null, outputTotal: null, cacheReadInput: null, cacheWriteInput: null, reasoningOutput: null },
      coverage: { inputTotal: "unknown", outputTotal: "unknown", cacheReadInput: "unknown", cacheWriteInput: "unknown", reasoningOutput: "unknown" },
    };
    const staleQuota = {
      mappingVersion: "openai-rate-limit-headers-v1", source: "provider-response-header", provider: "openai",
      observedAt: "2026-01-31T23:55:00.000Z", freshness: "stale",
      counters: { requestLimit: 100, requestRemaining: 80, tokenLimit: 10000, tokenRemaining: 7000 },
      coverage: { requestLimit: "reported", requestRemaining: "reported", tokenLimit: "reported", tokenRemaining: "reported" },
    };
    const unavailableQuota = {
      mappingVersion: "openai-rate-limit-headers-v1", source: "provider-response-header", provider: "openai",
      observedAt: "2026-01-01T00:01:00.000Z", freshness: "unknown",
      counters: { requestLimit: null, requestRemaining: null, tokenLimit: null, tokenRemaining: null },
      coverage: { requestLimit: "unknown", requestRemaining: "unknown", tokenLimit: "unknown", tokenRemaining: "unknown" },
    };
    const attribution = {
      operationId: boundaryOperationId, taskId: "00000000-0000-4000-8000-000000000005",
      attemptId: "00000000-0000-4000-8000-000000000006", leaseEpoch: 4, dispatchAttempt: 1,
      provider: "openai", model: "boundary-model", purpose: "task_execution",
    };
    const runtimeUsage = {
      mappingVersion: "opencode-runtime-usage-v1",
      counters: { inputTotal: 9000, outputTotal: 800, cacheReadInput: null, cacheWriteInput: null, reasoningOutput: 700 },
      coverage: { inputTotal: "reported", outputTotal: "reported", cacheReadInput: "unknown", cacheWriteInput: "unknown", reasoningOutput: "reported" },
    };
    for (let index = 0; index < 100; index += 1) await accounting.recordRuntimeObservation(boundaryOperationId, runtimeUsage);
    for (let index = 0; index < 100; index += 1) await accounting.recordObservation(attribution, {
      source: "gateway", observationId: boundaryOperationId, revision: 2,
      observedAt: "2026-02-02T00:00:00.000Z", freshness: "stale", usage: usage2000, quota: staleQuota,
    }, "succeeded");
    await accounting.recordObservation(attribution, {
      source: "gateway", observationId: boundaryOperationId, revision: 1,
      observedAt: "2026-03-01T00:00:00.000Z", freshness: "current", usage: usage10,
    }, "succeeded");
    await accounting.recordObservation({
      ...attribution, operationId: retryOperationId,
    }, {
      source: "gateway", observationId: retryOperationId, revision: 1,
      observedAt: "2026-01-01T00:00:06.000Z", freshness: "current", usage: usage4,
    }, "succeeded");
    await accounting.recordObservation({
      ...attribution, operationId: cancelOperationId,
    }, {
      source: "gateway", observationId: cancelOperationId, revision: 1,
      observedAt: "2026-01-01T00:01:01.000Z", freshness: "unknown", usage: unknownUsage, quota: unavailableQuota,
    }, "cancelled");
    assert.equal(await accounting.reconcileInterrupted(), 2, "restart recovery marks prepared and dispatched operations unknown");
    assert.equal(await accounting.reconcileInterrupted(), 0, "repeated recovery is idempotent");
    const { rows: [periodResult] } = await pool.query(`SELECT count(*)::integer AS request_count,
      sum((mr.dispatched_at >= $1::timestamptz AND mr.dispatched_at < $2::timestamptz)::integer)::integer AS in_period_count,
      max(ul.canonical_revision)::integer AS canonical_revision,
      max((ul.token_counts->>'inputTotal')::integer)::integer AS canonical_input,
      max((ul.token_counts->>'cacheReadInput')::integer)::integer AS cache_read_input,
      max((ul.token_counts->>'cacheWriteInput')::integer)::integer AS cache_write_input,
      max((ul.token_counts->>'outputTotal')::integer)::integer AS output_total,
      max((ul.token_counts->>'reasoningOutput')::integer)::integer AS reasoning_output
      FROM jarvis.model_requests mr JOIN jarvis.usage_ledger ul ON ul.model_request_id=mr.id
      WHERE mr.id=$3 AND mr.dispatched_at >= $1::timestamptz AND mr.dispatched_at < $2::timestamptz`,
    [dispatchedAt, periodEnd, boundaryRequestId]);
    assert.deepEqual(periodResult, {
      request_count: 1, in_period_count: 1, canonical_revision: 2, canonical_input: 2000,
      cache_read_input: 1500, cache_write_input: 200, output_total: 300, reasoning_output: 100,
    }, "replays and later-arriving lower revisions preserve total counters without adding cache/reasoning subsets again");
    const { rows: [runtimeResult] } = await pool.query(`SELECT mr.runtime_coverage,
      count(uo.id)::integer AS runtime_observation_count
      FROM jarvis.model_requests mr LEFT JOIN jarvis.usage_observations uo
        ON uo.model_request_id=mr.id AND uo.source='runtime'
      WHERE mr.id=$1 GROUP BY mr.id`, [boundaryRequestId]);
    assert.deepEqual(runtimeResult, { runtime_coverage: "observed", runtime_observation_count: 1 },
      "runtime evidence arriving before provider completion remains correlated but non-additive");
    const { rows: [billedAttempts] } = await pool.query(`SELECT count(*)::integer AS request_count,
      count(DISTINCT mr.operation_id)::integer AS distinct_operations,
      count(DISTINCT mr.dispatch_attempt)::integer AS dispatch_attempts,
      sum((ul.token_counts->>'inputTotal')::integer)::integer AS separately_billed_input
      FROM jarvis.model_requests mr JOIN jarvis.usage_ledger ul ON ul.model_request_id=mr.id
      WHERE mr.operation_id = ANY($1::uuid[]) AND mr.lifecycle='succeeded'`,
    [[boundaryOperationId, retryOperationId]]);
    assert.deepEqual(billedAttempts, { request_count: 2, distinct_operations: 2, dispatch_attempts: 1, separately_billed_input: 2004 },
      "a retry has a distinct operation UUID and is separately billed");
    const { rows: revisions } = await pool.query(`SELECT revision, freshness, numeric_usage, quota_signals
      FROM jarvis.usage_observations WHERE model_request_id=$1 AND source='gateway' ORDER BY revision`,
    [boundaryRequestId]);
    assert.equal(revisions.length, 2, "100 replays for each observation revision create only one SQL row per revision");
    assert.equal(revisions[1].freshness, "stale");
    assert.equal(revisions[1].quota_signals.freshness, "stale");
    assert.deepEqual(Object.keys(revisions[1].numeric_usage).sort(),
      ["cacheReadInput", "cacheWriteInput", "inputTotal", "outputTotal", "reasoningOutput"],
      "durable token observations contain only the bounded counter schema, not prompt or response text");
    const { rows: [cancelledResult] } = await pool.query(`SELECT mr.lifecycle, uo.freshness, uo.quota_signals
      FROM jarvis.model_requests mr JOIN jarvis.usage_observations uo ON uo.model_request_id=mr.id
      WHERE mr.id=$1 AND uo.source='gateway'`, [cancelRequestId]);
    assert.equal(cancelledResult.lifecycle, "cancelled");
    assert.equal(cancelledResult.freshness, "unknown");
    assert.deepEqual(cancelledResult.quota_signals.coverage,
      { requestLimit: "unknown", requestRemaining: "unknown", tokenLimit: "unknown", tokenRemaining: "unknown" });
    const { rows: recoveryRows } = await pool.query(`SELECT lifecycle FROM jarvis.model_requests
      WHERE id = ANY($1::uuid[]) ORDER BY lifecycle`,
    [[recoveryPreparedRequestId, recoveryDispatchedRequestId]]);
    assert.deepEqual(recoveryRows, [{ lifecycle: "unknown" }, { lifecycle: "unknown" }],
      "restart recovery persists unfinished prepared/dispatched attempts as unknown");
    const { rows: [endBoundary] } = await pool.query(`SELECT count(*)::integer AS request_count
      FROM jarvis.model_requests WHERE id IN ($1,$2)
        AND dispatched_at >= $3::timestamptz AND dispatched_at < $4::timestamptz`,
    [boundaryRequestId, periodEndRequestId, dispatchedAt, periodEnd]);
    assert.equal(endBoundary.request_count, 1, "the exact upper bound belongs to the next half-open period");

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
    await pool.query("UPDATE jarvis.tasks SET revision = $2 WHERE id = $1", [request.taskId, "a".repeat(40)]);
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
    const sandboxMappings = createSandboxLeaseStore(pool);
    const leaseIdentity = { taskId: firstLease.task.taskId, attemptId: firstLease.attemptId, leaseEpoch: firstLease.epoch };
    const sandboxSpec = { ...leaseIdentity, snapshotId: "snapshot-durable-test", profileId: "profile-test", modelProfileId: "model-test", deadline: new Date(firstLease.expiresAt).toISOString() };
    await sandboxMappings.reserve({ ...leaseIdentity, idempotencyKey: `${leaseIdentity.taskId}:${leaseIdentity.attemptId}:${leaseIdentity.leaseEpoch}`, spec: sandboxSpec });
    await assert.rejects(sandboxMappings.reserve({ ...leaseIdentity, idempotencyKey: "different-key", spec: sandboxSpec }), SandboxLeaseRejectedError);
    await sandboxMappings.bind({ ...leaseIdentity, sandboxId: "sandbox-exact-attempt" });
    assert.equal(await sandboxMappings.get(leaseIdentity), "sandbox-exact-attempt");
    await assert.rejects(sandboxMappings.get({ ...leaseIdentity, attemptId: "00000000-0000-4000-8000-000000000000" }), SandboxLeaseRejectedError);
    await assert.rejects(sandboxMappings.get({ ...leaseIdentity, leaseEpoch: leaseIdentity.leaseEpoch + 1 }), SandboxLeaseRejectedError);
    await assert.rejects(sandboxMappings.bind({ ...leaseIdentity, sandboxId: "sandbox-conflicting" }), SandboxLeaseRejectedError);
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
    await assert.rejects(sandboxMappings.get(leaseIdentity), SandboxLeaseRejectedError, "expired/reclaimed lease cannot read the prior attempt mapping");
    await assert.rejects(sandboxMappings.clear(leaseIdentity), SandboxLeaseRejectedError, "stale lease cannot clear the next attempt's mapping");
    const secondIdentity = { taskId: secondLease.task.taskId, attemptId: secondLease.attemptId, leaseEpoch: secondLease.epoch };
    const secondSpec = { ...secondIdentity, snapshotId: "snapshot-second-test", profileId: "profile-test", modelProfileId: "model-test", deadline: new Date(secondLease.expiresAt).toISOString() };
    await sandboxMappings.reserve({ ...secondIdentity, idempotencyKey: `${secondIdentity.taskId}:${secondIdentity.attemptId}:${secondIdentity.leaseEpoch}`, spec: secondSpec });
    await sandboxMappings.bind({ ...secondIdentity, sandboxId: "sandbox-second-attempt" });
    assert.equal(await sandboxMappings.get({ taskId: secondLease.task.taskId, attemptId: secondLease.attemptId, leaseEpoch: secondLease.epoch }), "sandbox-second-attempt");
    await assert.rejects(queue.complete(firstLease, { kind: "report", id: "00000000-0000-4000-8000-000000000009" }), { code: "STALE_LEASE" });

    const unknown = await queue.fail(secondLease, { kind: "unknown_external", effectId: "github-pr-intent-1" });
    assert.equal(unknown.status, "reconciliation_required");
    const recoveryReservation = await sandboxMappings.getForReconciliation(secondIdentity);
    assert.equal(recoveryReservation.idempotencyKey, `${secondIdentity.taskId}:${secondIdentity.attemptId}:${secondIdentity.leaseEpoch}`);
    assert.deepEqual(recoveryReservation.spec, secondSpec);
    assert.equal(recoveryReservation.sandboxId, "sandbox-second-attempt");
    await sandboxMappings.clearAfterReconciliationCancellation({ ...secondIdentity, sandboxId: recoveryReservation.sandboxId });
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
    await stopControls.set({ projectId: input.projectId, stopped: true, expectedVersion: 3, ownerId: "owner" });
    assert.equal(await queue.claim("worker-paused-retry", 60_000), null, "a project stop also prevents a ready retry from being claimed");
    await stopControls.set({ projectId: input.projectId, stopped: false, expectedVersion: 4, ownerId: "owner" });
    const thirdLease = await queue.claim("worker-c", 60_000);
    assert.ok(thirdLease);
    assert.equal(thirdLease.epoch, 3);
    const canonicalResult = {
      schemaVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000007",
      taskId: request.taskId,
      attemptId: thirdLease.attemptId,
      leaseEpoch: thirdLease.epoch,
      mode: "dev",
      sourceRevision: "a".repeat(40),
      snapshotDigest: "b".repeat(64),
      provider: "openai",
      model: "gpt-4.1",
      resultId: "00000000-0000-4000-8000-000000000009",
      payload: {
        summary: "Synthetic inert patch report",
        artifactId: "00000000-0000-4000-8000-000000000010",
        patchDigest: "c".repeat(64),
        changedPaths: ["src/index.ts"],
        limitations: [],
      },
    };
    const resultReference = { kind: "report", id: canonicalResult.resultId };
    await pool.query(`
      CREATE FUNCTION public.reject_result_outbox_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'queue.task.succeeded' THEN RAISE EXCEPTION 'injected result completion failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_result_outbox_test BEFORE INSERT ON jarvis.outbox
      FOR EACH ROW EXECUTE FUNCTION public.reject_result_outbox_test()`);
    try {
      await assert.rejects(queue.complete(thirdLease, resultReference, canonicalResult), /injected result completion failure/);
      const { rows: [rolledBackResult] } = await pool.query("SELECT count(*)::integer AS count FROM jarvis.task_results WHERE task_id = $1", [request.taskId]);
      assert.equal(rolledBackResult.count, 0, "result persistence rolls back when fenced completion/outbox fails");
      const { rows: [stillLeased] } = await pool.query("SELECT state FROM jarvis.queue_entries WHERE task_id = $1", [request.taskId]);
      assert.equal(stillLeased.state, "leased", "queue completion rolls back with result persistence");
    } finally {
      await pool.query("DROP TRIGGER reject_result_outbox_test ON jarvis.outbox");
      await pool.query("DROP FUNCTION public.reject_result_outbox_test()");
    }
    assert.equal((await queue.complete(thirdLease, resultReference, canonicalResult)).status, "succeeded");
    await assert.rejects(queue.complete(thirdLease, resultReference, canonicalResult), { code: "STALE_LEASE" }, "replayed completion cannot replace the canonical result");
    const resultRead = new PostgresTaskResultReadModel(pool);
    assert.deepEqual(await resultRead.getForOwner("owner-a", request.taskId), canonicalResult);
    assert.equal(await resultRead.getForOwner("someone-else", request.taskId), null, "other projects/owners cannot read the canonical result");
    await pool.query(`
      INSERT INTO jarvis.requests
        (id, owner_id, project_id, repository_id, mode, prompt_digest, state, idempotency_key, config_version, policy_hash)
      VALUES ($1, 'owner-a', $2, 3001, 'plan', $3, 'queued', 'request-plan-result', 1, $4)`, [
      "00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000003", "d".repeat(64), "b".repeat(64),
    ]);
    await pool.query(`
      INSERT INTO jarvis.tasks
        (id, request_id, project_id, repository_id, mode, revision, profile_hash, policy_hash, config_version, state, dedupe_key)
      VALUES ($1, $2, $3, 3001, 'plan', $4, $5, $6, 1, 'queued', 'task-plan-result')`, [
      "00000000-0000-4000-8000-000000000012", "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000003", "a".repeat(40), "f".repeat(64), "b".repeat(64),
    ]);
    const planQueue = await queue.enqueue({
      eventId: "plan-result-event", taskId: "00000000-0000-4000-8000-000000000012",
      payload: { taskId: "00000000-0000-4000-8000-000000000012" },
      deadline: Date.now() + 60_000, maxAttempts: 2, retry: { baseDelay: 10, maxDelay: 100 },
    });
    const planLease = await queue.claim("worker-plan-result", 60_000);
    assert.ok(planLease);
    assert.equal(planLease.task.id, planQueue.id);
    const planResult = {
      schemaVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000011",
      taskId: "00000000-0000-4000-8000-000000000012",
      attemptId: planLease.attemptId,
      leaseEpoch: planLease.epoch,
      mode: "plan",
      sourceRevision: "a".repeat(40),
      snapshotDigest: "b".repeat(64),
      provider: "openai",
      model: "gpt-4.1",
      resultId: "00000000-0000-4000-8000-000000000013",
      payload: {
        summary: "Synthetic plan",
        steps: [{ description: "Inspect the included source", sources: ["src/index.ts"] }],
        affectedAreas: ["runtime"],
        assumptions: [],
        risks: [],
        questions: [],
        limitations: [],
      },
    };
    await queue.complete(planLease, { kind: "report", id: planResult.resultId }, planResult);
    assert.deepEqual(await resultRead.getForOwner("owner-a", planResult.taskId), planResult);

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
  } catch (error) {
    testFailure = error;
  }

  let fixtureCleanupClient;
  let cleanupTransactionAttempted = false;
  let cleanupVerified = false;
  let cleanupTruncated = false;
  let cleanupCommitted = false;
  const cleanupFailures = await runCleanupSteps([
    async () => { if (client) await client.query("ROLLBACK"); },
    async () => {
      if (client) {
        const currentClient = client;
        client = undefined;
        currentClient.release();
      }
    },
    async () => { if (authClient) await authClient.query("ROLLBACK"); },
    async () => {
      if (authClient) {
        const currentClient = authClient;
        authClient = undefined;
        currentClient.release();
      }
    },
    async () => { if (fixtureCommitted) fixtureCleanupClient = await pool.connect(); },
    async () => {
      if (fixtureCleanupClient) {
        cleanupTransactionAttempted = true;
        await fixtureCleanupClient.query("BEGIN");
      }
    },
    async () => {
      if (cleanupTransactionAttempted) {
        await fixtureCleanupClient.query(`
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
                  WHEN 'audit_events' THEN 22
                  WHEN 'project_skills' THEN 1
                  WHEN 'project_skill_approvals' THEN 4
                  WHEN 'stop_controls' THEN 2
                  WHEN 'requests' THEN 11
                  WHEN 'tasks' THEN 8
                  WHEN 'task_attempts' THEN 6
                  WHEN 'task_checkpoints' THEN 1
                  WHEN 'task_results' THEN 2
                  WHEN 'queue_entries' THEN 7
                  WHEN 'model_requests' THEN 6
                  WHEN 'usage_observations' THEN 5
                  WHEN 'usage_ledger' THEN 3
                  WHEN 'outbox' THEN 17
                  ELSE 0
                END;
                IF row_count <> expected_count THEN
                  RAISE EXCEPTION 'refusing fixture cleanup: jarvis.% contains % rows; expected %',
                    table_name, row_count, expected_count;
                END IF;
              END LOOP;
            END $$
            `);
        cleanupVerified = true;
      }
    },
    async () => {
      if (cleanupVerified) {
        await fixtureCleanupClient.query(`
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
        cleanupTruncated = true;
      }
    },
    async () => {
      if (cleanupVerified && cleanupTruncated) {
        await fixtureCleanupClient.query("COMMIT");
        cleanupCommitted = true;
      }
    },
    async () => {
      if (cleanupTransactionAttempted && !cleanupCommitted) await fixtureCleanupClient.query("ROLLBACK");
    },
    async () => {
      if (fixtureCleanupClient) {
        const currentClient = fixtureCleanupClient;
        fixtureCleanupClient = undefined;
        currentClient.release();
      }
    },
    async () => { if (lockClient) await lockClient.query("SELECT pg_advisory_unlock($1)", [0x4a385445]); },
    async () => {
      if (lockClient) {
        const currentClient = lockClient;
        lockClient = undefined;
        currentClient.release();
      }
    },
    async () => { await pool.end(); },
  ]);
  throwCollectedFailures(testFailure, cleanupFailures);
});

test("real PostgreSQL stop controls gate and cancel the real queue worker composition", {
  skip: process.env.JARVIS_RUN_STOP_RUNTIME_INTEGRATION !== "1"
    ? "set JARVIS_RUN_STOP_RUNTIME_INTEGRATION=1 to run this on-demand integration scenario"
    : databaseUrl === undefined ? "set JARVIS_TEST_DATABASE_URL to a disposable empty database" : false,
}, async () => {
  const [{ createQueueWorker, createSandboxQueueWorker, createPersistedStopReader, createRestoreActivationGate, createSandboxManagerHttpClient }, api, { QueueService: RuntimeQueueService }, { Pool: PgPool }] = await Promise.all([
    import("../../../apps/worker/dist/index.js"),
    import("../../../apps/api/dist/runtime-composition.js"),
    import("@jarvis/queue"),
    import("pg"),
  ]);
  const pool = new PgPool({ connectionString: databaseUrl, max: 5, application_name: "jv242-worker-integration" });
  let fixture;
  let worker;
  let apiServer;
  let sandboxServer;
  let tlsFixture;
  let testFailure;
  try {
    await new PostgresPersistence(pool).migrate();
    await resetStopRaceFixture(pool);
    fixture = await createStopRaceFixture(pool, "enqueue");
    let now = Date.now();
    const queueStore = new PostgresQueueStore(pool);
    const runtimeQueue = new RuntimeQueueService({
      store: queueStore, clock: { now: () => now }, ids: { next: () => randomUUID() },
    });
    const task = await runtimeQueue.enqueue({
      eventId: `jv242-${fixture.taskId}`, taskId: fixture.taskId, payload: { taskId: fixture.taskId },
      deadline: now + 60_000, maxAttempts: 2, retry: { baseDelay: 10, maxDelay: 100 },
    });
    const controls = new PostgresStopControlStore(pool);
    const auth = {
      authorizeRead: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }),
      authorizeMutation: async ({ headers }) => headers.authorization === "Bearer synthetic-owner"
        ? { authorized: true, auth: { ownerId: "owner" }, headers: {} }
        : { authorized: false, response: { status: 401, body: { error: "unauthorized" } } },
    };
    const dispatchStarted = [];
    const sandboxStops = [];
    let resolveSandboxCancelObserved;
    const sandboxCancelObserved = new Promise((resolve) => { resolveSandboxCancelObserved = resolve; });
    let rejectNextSandboxCancel = false;
    let withholdNextSandboxCancelResponse = false;
    let withheldCancelResponseStartedAt;
    let withheldCancelResponseClosedAt;
    const sandboxMappings = createSandboxLeaseStore(pool);
    let activeSandboxIdentity;
    tlsFixture = createSyntheticSandboxTls();
    sandboxServer = https.createServer({ key: tlsFixture.serverKey, cert: tlsFixture.serverCert, ca: tlsFixture.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => {
      if (req.socket.getPeerCertificate().subjectaltname !== "URI:spiffe://jarvis/worker") { req.socket.destroy(); return; }
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/v1/sandboxes") {
          res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ sandboxId: "11111111-1111-4111-8111-111111111111", state: "running" }));
        } else if (req.method === "POST" && req.url === "/v1/sandboxes/11111111-1111-4111-8111-111111111111/cancel") {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          sandboxStops.push({ sandboxId: "11111111-1111-4111-8111-111111111111", epoch: body.leaseEpoch });
          resolveSandboxCancelObserved(performance.now());
          if (withholdNextSandboxCancelResponse) {
            withholdNextSandboxCancelResponse = false;
            withheldCancelResponseStartedAt = performance.now();
            res.on("close", () => { withheldCancelResponseClosedAt = performance.now(); });
          }
          else if (rejectNextSandboxCancel) { rejectNextSandboxCancel = false; res.writeHead(503); res.end(); }
          else { res.writeHead(204); res.end(); }
        } else { res.writeHead(404); res.end(); }
      });
    });
    await new Promise((resolve) => sandboxServer.listen(0, "127.0.0.1", resolve));
    const sandboxCancelTimeoutMs = 300;
    const sandboxClient = createSandboxManagerHttpClient({ endpoint: new URL(`https://127.0.0.1:${sandboxServer.address().port}`), key: tlsFixture.workerKey, cert: tlsFixture.workerCert, ca: tlsFixture.ca, timeoutMs: sandboxCancelTimeoutMs });
    const unknownEffects = [];
    const beforeFailedRestore = await controls.get({});
    const { rows: [auditCountBeforeFailedRestore] } = await pool.query(`SELECT count(*)::integer AS count FROM jarvis.audit_events
      WHERE actor='system:restore' AND action='stop.restore_suspend' AND resource='global'`);
    let rejectCommit = true;
    const rejectingPool = {
      async connect() {
        const client = await pool.connect();
        let released = false;
        return {
          async query(text, values) {
            if (text === "COMMIT" && rejectCommit) {
              rejectCommit = false;
              throw new Error("injected restore COMMIT failure");
            }
            return client.query(text, values);
          },
          release() {
            assert.equal(released, false, "failed restore client is released exactly once");
            released = true;
            client.release();
          },
        };
      },
    };
    const failedRestoreGate = createRestoreActivationGate(() => new PostgresStopControlStore(rejectingPool).suspendAfterRestore());
    let failedWorkerClaimCount = 0;
    const failedWorker = createQueueWorker({
      queue: {
        claim: async (...args) => { failedWorkerClaimCount += 1; return runtimeQueue.claim(...args); },
        complete: (...args) => runtimeQueue.complete(...args),
        fail: (...args) => runtimeQueue.fail(...args),
        cancel: (...args) => runtimeQueue.cancel(...args),
      },
      workerId: "jv242-failed-restore-worker", leaseMs: 30_000, restoreGate: failedRestoreGate,
      hydrate: async () => { throw new Error("failed restore worker must not hydrate queued work"); },
      execution: {
        readStop: async () => ({ stopped: false, version: 0 }),
        dispatch: async () => { throw new Error("failed restore worker must not dispatch"); },
        revokeCapability: async () => undefined,
        stopSandbox: async () => "stopped",
        recordAcceptedEffectUnknown: async () => undefined,
      },
    });
    const failedRestoreRun = failedWorker.runOnce();
    try {
      await delay(20);
      await assert.rejects(failedRestoreGate.activateAfterRestore(), /injected restore COMMIT failure/);
      await assert.rejects(failedRestoreRun, /injected restore COMMIT failure/);
    } finally {
      // Release the waiting run even if activation/assertions fail; do not start another run on this worker.
      await failedRestoreGate.activateAfterRestore().catch(() => undefined);
      await Promise.allSettled([failedRestoreRun]);
    }
    assert.equal(failedWorkerClaimCount, 0, "failed durable restore leaves its bound worker unable to claim");
    assert.equal((await queueStore.get(task.id)).status, "queued", "failed durable restore leaves queued work untouched");
    const afterFailedRestore = await controls.get({});
    const { rows: [auditCountAfterFailedRestore] } = await pool.query(`SELECT count(*)::integer AS count FROM jarvis.audit_events
      WHERE actor='system:restore' AND action='stop.restore_suspend' AND resource='global'`);
    assert.equal(afterFailedRestore.global.stopped, beforeFailedRestore.global.stopped, "failed restore COMMIT rolls back the persisted stop state");
    assert.equal(afterFailedRestore.global.version, beforeFailedRestore.global.version, "failed restore COMMIT rolls back the version increment");
    assert.equal(auditCountAfterFailedRestore.count, auditCountBeforeFailedRestore.count, "failed restore COMMIT rolls back its audit record");

    const restoreGate = createRestoreActivationGate(async () => {
      const restored = await controls.suspendAfterRestore();
      assert.equal(restored.stopped, true, "restore activation waits for durable global suspension");
      const { rows: [auditCount] } = await pool.query(`SELECT count(*)::integer AS count FROM jarvis.audit_events
        WHERE actor='system:restore' AND action='stop.restore_suspend' AND resource='global'`);
      assert.equal(auditCount.count, auditCountBeforeFailedRestore.count + 1, "successful restore adds exactly one test-created audit row");
      const { rows: [audit] } = await pool.query(`SELECT actor, action FROM jarvis.audit_events
        WHERE actor='system:restore' AND action='stop.restore_suspend' AND resource='global' ORDER BY occurred_at DESC LIMIT 1`);
      assert.deepEqual(audit, { actor: "system:restore", action: "stop.restore_suspend" });
      const { rows: [saved] } = await pool.query(`SELECT stopped, version FROM jarvis.stop_controls WHERE scope='global' AND project_id IS NULL`);
      assert.equal(saved.stopped, true);
      assert.equal(saved.version, restored.version);
    });
    worker = createSandboxQueueWorker({
      queue: runtimeQueue, workerId: "jv242-worker", leaseMs: 30_000,
      hydrate: async () => ({ taskId: fixture.taskId, projectId: fixture.projectId, capability: "fake-dispatch-capability" }),
      restoreGate,
      trustedResultContext: async (lease) => ({
        resultId: randomUUID(),
        expected: { requestId: fixture.requestId, taskId: fixture.taskId, attemptId: lease.attemptId, leaseEpoch: lease.epoch, mode: "plan", sourceRevision: fixture.revision, snapshotDigest: "b".repeat(64), provider: "synthetic", model: "synthetic" },
        snapshot: { repository: "owner-race/stop-race", revision: fixture.revision, snapshotDigest: "b".repeat(64), includedPaths: ["src/index.ts"] },
      }),
      sandbox: {
        trustedSpec: async (lease) => {
          activeSandboxIdentity = { taskId: lease.task.taskId, attemptId: lease.attemptId, leaseEpoch: lease.epoch };
          return { ...activeSandboxIdentity, snapshotId: "trusted-snapshot", profileId: "trusted-profile", modelProfileId: "trusted-model", deadline: new Date(lease.expiresAt).toISOString(), leaseEpoch: lease.epoch };
        },
        mappings: sandboxMappings,
        sandbox: sandboxClient,
      },
      dispatchSandbox: async ({ sandboxId, signal }) => {
        dispatchStarted.push(sandboxId);
        return new Promise((resolve) => { signal.addEventListener("abort", () => resolve({ payload: { summary: "Synthetic cancelled plan", steps: [], affectedAreas: [], assumptions: [], risks: [], questions: [], limitations: [] } }), { once: true }); });
      },
      execution: {
        readStop: createPersistedStopReader(controls),
        revokeCapability: async () => undefined,
        stopSandbox: async () => { throw new Error("sandbox dispatch must use the injected manager"); },
        recordAcceptedEffectUnknown: async (taskId) => { unknownEffects.push(taskId); },
      },
    });
    const composition = api.createRuntimeComposition({ store: controls, auth, worker, dashboard: async () => ({ status: 404 }) });
    await new Promise((resolve) => {
      apiServer = composition.server.listen(0, "127.0.0.1", resolve);
    });
    const initial = await controls.get({ projectId: fixture.projectId });
    const waitingForRestore = worker.runOnce();
    try {
      await delay(20);
      assert.deepEqual(dispatchStarted, [], "worker cannot dispatch while restore activation is pending");
      assert.equal((await queueStore.get(task.id)).status, "queued", "worker cannot claim queued work before restore activation");
    } finally {
      // Always release runOnce's activation wait, including when a pre-activation assertion fails.
      await restoreGate.activateAfterRestore().catch(() => undefined);
    }
    assert.equal(await waitingForRestore, "idle", "restored global stop prevents queued work from being claimed");
    const globalPaused = await controls.get({ projectId: fixture.projectId });
    const apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;
    const unauthorized = await globalThis.fetch(`${apiOrigin}/api/v1/stop/projects/${fixture.projectId}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer not-owner" },
      body: JSON.stringify({ stopped: false, expectedVersion: globalPaused.global.version }),
    });
    assert.equal(unauthorized.status, 401, "synthetic owner auth rejects an unauthorized HTTP mutation");
    const afterUnauthorized = await controls.get({ projectId: fixture.projectId });
    assert.deepEqual(afterUnauthorized.global, globalPaused.global, "unauthorized HTTP mutation leaves global stop unchanged");
    const globalResume = await globalThis.fetch(`${apiOrigin}/api/v1/stop`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-owner" },
      body: JSON.stringify({ stopped: false, expectedVersion: globalPaused.global.version }),
    });
    assert.equal(globalResume.status, 200, "authorized HTTP global resume uses the composed route");
    assert.equal((await globalResume.json()).global.stopped, false);
    const noDispatchStopStarted = performance.now();
    const stoppedProject = await globalThis.fetch(`${apiOrigin}/api/v1/stop/projects/${fixture.projectId}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-owner" },
      body: JSON.stringify({ stopped: true, expectedVersion: 0 }),
    });
    assert.equal(stoppedProject.status, 200);
    const projectStopState = await stoppedProject.json();
    assert.equal(projectStopState.project.stopped, true, "authorized HTTP project stop persists through the composed route");
    assert.equal(await worker.runOnce(), "idle", "a stopped project cannot claim its queued task");
    const noDispatchElapsedMs = performance.now() - noDispatchStopStarted;
    assert.ok(noDispatchElapsedMs <= 2_000, `project stop to stopped worker claim attempt took ${noDispatchElapsedMs.toFixed(2)}ms`);
    assert.deepEqual(dispatchStarted, []);
    assert.equal(await queueStore.get(task.id).then((saved) => saved.status), "queued", "stopped claim attempt does not consume the queued task");
    const paused = await controls.get({ projectId: fixture.projectId });
    const projectResume = await globalThis.fetch(`${apiOrigin}/api/v1/stop/projects/${fixture.projectId}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-owner" },
      body: JSON.stringify({ stopped: false, expectedVersion: paused.project.version }),
    });
    assert.equal(projectResume.status, 200, "authorized HTTP project resume uses the composed route");
    assert.equal((await projectResume.json()).project.stopped, false);
    const running = worker.runOnce();
    const deadline = Date.now() + 2_000;
    while (dispatchStarted.length === 0 && Date.now() < deadline) await delay(5);
    assert.equal(dispatchStarted.length, 1, "resumed project can claim and reach sandbox-backed dispatch");
    const stopStarted = performance.now();
    withholdNextSandboxCancelResponse = true;
    const stopped = await globalThis.fetch(`${apiOrigin}/api/v1/stop/projects/${fixture.projectId}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-owner" },
      body: JSON.stringify({ stopped: true, expectedVersion: paused.project.version + 1 }),
    });
    assert.equal(stopped.status, 200);
    let cancelObservationTimeout;
    const sandboxCancelObservedAt = await Promise.race([
      sandboxCancelObserved,
      new Promise((_, reject) => {
        cancelObservationTimeout = globalThis.setTimeout(() => reject(new Error("synthetic HTTPS/mTLS manager did not receive cancellation within 10 seconds")), 10_000);
      }),
    ]).finally(() => globalThis.clearTimeout(cancelObservationTimeout));
    const cancelRequestElapsedMs = sandboxCancelObservedAt - stopStarted;
    assert.ok(cancelRequestElapsedMs <= 10_000, `active stop to synthetic manager cancellation request took ${cancelRequestElapsedMs.toFixed(2)}ms`);
    assert.equal(await running, "unknown", "a possible accepted effect is retained as unknown");
    assert.equal(dispatchStarted.length, 1, "manager cancellation timeout does not dispatch an additional external effect");
    const elapsedMs = performance.now() - stopStarted;
    assert.ok(withheldCancelResponseStartedAt !== undefined, "synthetic manager accepted cancellation before withholding its response");
    assert.ok(withheldCancelResponseClosedAt !== undefined, "client closed the withheld manager response after timing out");
    const withheldDurationMs = withheldCancelResponseClosedAt - withheldCancelResponseStartedAt;
    assert.ok(withheldDurationMs >= sandboxCancelTimeoutMs - 50,
      `synthetic manager must withhold its response for the configured ${sandboxCancelTimeoutMs}ms timeout; observed ${withheldDurationMs.toFixed(2)}ms`);
    assert.ok(withheldDurationMs < sandboxCancelTimeoutMs + 1_000,
      `client must close the withheld response within the configured ${sandboxCancelTimeoutMs}ms timeout bound; observed ${withheldDurationMs.toFixed(2)}ms`);
    assert.ok(elapsedMs >= sandboxCancelTimeoutMs - 50, `manager cancellation must remain pending until the configured ${sandboxCancelTimeoutMs}ms timeout; observed ${elapsedMs.toFixed(2)}ms`);
    assert.ok(elapsedMs < sandboxCancelTimeoutMs + 1_000, `persisted stop/cancel must remain bounded by its ${sandboxCancelTimeoutMs}ms manager timeout; observed ${elapsedMs.toFixed(2)}ms`);
    globalThis.console.log(`# single PostgreSQL-backed in-process sample: project stop to stopped worker claim attempt ${noDispatchElapsedMs.toFixed(2)}ms (no dispatch; task remains queued); active stop to synthetic HTTPS/mTLS manager cancellation request ${cancelRequestElapsedMs.toFixed(2)}ms; manager accepted request but withheld response for ${withheldDurationMs.toFixed(2)}ms; configured client timeout ${sandboxCancelTimeoutMs}ms; active stop/cancel completion ${elapsedMs.toFixed(2)}ms. Local synthetic evidence only; no OS process restart or production latency qualification.`);
    const persisted = await queueStore.get(task.id);
    assert.equal(persisted.status, "reconciliation_required");
    assert.deepEqual(sandboxStops, [{ sandboxId: "11111111-1111-4111-8111-111111111111", epoch: 1 }], "the API stop handler reaches exact durable mapping and sandbox cancellation");
    await assert.rejects(sandboxMappings.get(activeSandboxIdentity), SandboxLeaseRejectedError, "terminal unknown lease cannot be read as active mapping");
    assert.equal(typeof worker.cancelSandboxForReconciliation, "function", "queue worker exposes only the fenced reconciliation cancellation operation");
    const stopCountBeforeInvalidIdentities = sandboxStops.length;
    await assert.rejects(worker.cancelSandboxForReconciliation({ ...activeSandboxIdentity, taskId: `${activeSandboxIdentity.taskId}-wrong` }));
    await assert.rejects(worker.cancelSandboxForReconciliation({ ...activeSandboxIdentity, attemptId: "22222222-2222-4222-8222-222222222222" }));
    await assert.rejects(worker.cancelSandboxForReconciliation({ ...activeSandboxIdentity, leaseEpoch: activeSandboxIdentity.leaseEpoch + 1 }));
    assert.equal(sandboxStops.length, stopCountBeforeInvalidIdentities, "wrong task, attempt, or lease epoch never reaches sandbox manager");
    assert.equal((await sandboxMappings.getForReconciliation(activeSandboxIdentity)).sandboxId, "11111111-1111-4111-8111-111111111111", "rejected identities preserve the original exact mapping");
    const temporarilyFailed = await pool.query("UPDATE jarvis.queue_entries SET state = 'failed' WHERE id = $1", [task.id]);
    try {
      assert.equal(temporarilyFailed.rowCount, 1, "the exact queue row enters the non-reconciliation state");
      assert.equal((await sandboxMappings.getForReconciliation(activeSandboxIdentity)).sandboxId, "11111111-1111-4111-8111-111111111111", "failed queue state retains the exact reservation for reconciliation");
    } finally {
      await pool.query("UPDATE jarvis.queue_entries SET state = 'reconciliation_required' WHERE id = $1", [task.id]);
    }
    assert.equal((await sandboxMappings.getForReconciliation(activeSandboxIdentity)).sandboxId, "11111111-1111-4111-8111-111111111111", "restoring reconciliation state permits normal recovery");
    rejectNextSandboxCancel = true;
    await assert.rejects(worker.cancelSandboxForReconciliation(activeSandboxIdentity));
    assert.equal((await sandboxMappings.getForReconciliation(activeSandboxIdentity)).sandboxId, "11111111-1111-4111-8111-111111111111", "rejected manager cancellation retains mapping for retry");
    await worker.cancelSandboxForReconciliation(activeSandboxIdentity);
    assert.deepEqual(sandboxStops, [
      { sandboxId: "11111111-1111-4111-8111-111111111111", epoch: 1 },
      { sandboxId: "11111111-1111-4111-8111-111111111111", epoch: 1 },
      { sandboxId: "11111111-1111-4111-8111-111111111111", epoch: 1 },
    ], "reconciliation cancellation reaches sandbox manager with exact epoch");
    await assert.rejects(sandboxMappings.getForReconciliation(activeSandboxIdentity), SandboxLeaseRejectedError, "confirmed recovery cancellation clears the exact durable mapping");
    assert.equal((await queueStore.get(task.id)).status, "reconciliation_required", "sandbox cancellation does not resolve the unknown external effect");
    assert.deepEqual(unknownEffects, [fixture.taskId]);
    const verificationPool = new PgPool({ connectionString: databaseUrl, max: 1 });
    try { assert.equal((await new PostgresStopControlStore(verificationPool).get({ projectId: fixture.projectId })).project.stopped, true, "a new PostgreSQL connection observes persisted stop state"); }
    finally { await verificationPool.end(); }
    assert.ok(initial.global.stopped === false);
  } catch (error) {
    testFailure = error;
  }
  const cleanupFailures = await runCleanupSteps([
    async () => { if (worker) await worker.stop(); },
    async () => { if (apiServer) await new Promise((resolve) => apiServer.close(resolve)); },
    async () => { if (sandboxServer) await new Promise((resolve) => sandboxServer.close(resolve)); },
    async () => { if (tlsFixture) rmSync(tlsFixture.dir, { recursive: true, force: true }); },
    async () => { if (fixture) await resetStopRaceFixture(pool); },
    async () => pool.end(),
  ]);
  throwCollectedFailures(testFailure, cleanupFailures);
});

test("PostgreSQL stop during persisted retry backoff preserves eligibility and isolates project workers", {
  skip: process.env.JARVIS_RUN_STOP_RUNTIME_INTEGRATION !== "1"
    ? "set JARVIS_RUN_STOP_RUNTIME_INTEGRATION=1 to run this on-demand integration scenario"
    : databaseUrl === undefined ? "set JARVIS_TEST_DATABASE_URL to a disposable empty database" : false,
}, async () => {
  const [{ createQueueWorker }, api, { QueueService: RuntimeQueueService }, { Pool: PgPool }] = await Promise.all([
    import("../../../apps/worker/dist/index.js"),
    import("../../../apps/api/dist/runtime-composition.js"),
    import("@jarvis/queue"),
    import("pg"),
  ]);
  const pool = new PgPool({ connectionString: databaseUrl, max: 8, application_name: "jv286-stop-retry-integration" });
  const restoreGate = { waitUntilActivated: async () => undefined, activateAfterRestore: async () => undefined };
  let apiServer;
  let fixtureA;
  let fixtureB;
  let testFailure;
  try {
    await new PostgresPersistence(pool).migrate();
    await resetStopRaceFixture(pool);
    fixtureA = await createStopRaceFixture(pool, "enqueue");
    fixtureB = await createStopRaceFixture(pool, "enqueue", 2);
    let now = Date.now();
    const queueStore = new PostgresQueueStore(pool);
    const queue = new RuntimeQueueService({ store: queueStore, clock: { now: () => now }, ids: { next: () => randomUUID() } });
    const enqueue = (fixture, suffix) => queue.enqueue({
      eventId: `jv286-${suffix}-${fixture.taskId}`, taskId: fixture.taskId, payload: { taskId: fixture.taskId },
      deadline: now + 60_000, maxAttempts: 3, retry: { baseDelay: 4_000, maxDelay: 4_000 },
    });
    const taskA = await enqueue(fixtureA, "retry");
    const controls = new PostgresStopControlStore(pool);
    const auth = {
      authorizeRead: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }),
      authorizeMutation: async ({ headers }) => headers.authorization === "Bearer synthetic-owner"
        ? { authorized: true, auth: { ownerId: "owner" }, headers: {} }
        : { authorized: false, response: { status: 401, body: { error: "unauthorized" } } },
    };
    const dispatched = [];
    let forceFirstRetry = true;
    const makeWorker = (fixture, workerId, retryFirst = false) => {
      const projectId = fixture.projectId;
      const workerQueue = {
        claim: (...args) => queue.claim(...args),
        complete: async (lease, reference, canonical) => {
          if (retryFirst && forceFirstRetry) {
            forceFirstRetry = false;
            return queue.fail(lease, { kind: "transient", code: "synthetic-transient" });
          }
          return queue.complete(lease, reference, canonical);
        },
        fail: (...args) => queue.fail(...args),
        cancel: (...args) => queue.cancel(...args),
      };
      return createQueueWorker({
        queue: workerQueue, workerId, leaseMs: 30_000, restoreGate,
        hydrate: async (lease) => ({ taskId: lease.task.taskId, projectId, capability: "synthetic-only" }),
        trustedResultContext: async (lease) => ({
          resultId: randomUUID(),
          expected: { requestId: fixture.requestId, taskId: fixture.taskId, attemptId: lease.attemptId, leaseEpoch: lease.epoch, mode: "plan", sourceRevision: fixture.revision, snapshotDigest: "b".repeat(64), provider: "openai", model: "gpt-4.1" },
          snapshot: { repository: "owner-race/stop-race", revision: fixture.revision, snapshotDigest: "b".repeat(64), includedPaths: ["src/index.ts"] },
        }),
        execution: {
          readStop: async () => {
            const state = await controls.get({ projectId });
            return { stopped: state.global.stopped || state.project?.stopped === true, version: state.global.version };
          },
          dispatch: async () => { dispatched.push({ workerId, projectId }); return { payload: { summary: "Synthetic plan", steps: [{ description: "Inspect source", sources: ["src/index.ts"] }], affectedAreas: [], assumptions: [], risks: [], questions: [], limitations: [] } }; },
          revokeCapability: async () => undefined,
          stopSandbox: async () => "stopped",
          recordAcceptedEffectUnknown: async () => undefined,
        },
      });
    };
    const workerA = makeWorker(fixtureA, "jv286-worker-a", true);
    const workerB = makeWorker(fixtureB, "jv286-worker-b");
    const composition = api.createRuntimeComposition({ store: controls, auth, worker: workerA, dashboard: async () => ({ status: 404 }) });
    await new Promise((resolve) => { apiServer = composition.server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${apiServer.address().port}`;
    const ownerPost = async (path, body) => globalThis.fetch(`${origin}${path}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-owner" }, body: JSON.stringify(body),
    });

    assert.equal(await workerA.runOnce(), "completed");
    let persistedA = await queueStore.get(taskA.id);
    assert.equal(persistedA.status, "queued", "synthetic transient failure persists a retry rather than consuming the task");
    assert.equal(persistedA.attempt, 1);
    assert.ok(persistedA.availableAt > now, "retry remains unavailable during persisted backoff");
    const { rows: [retryRow] } = await pool.query("SELECT state, attempt_count, available_at > clock_timestamp() AS delayed FROM jarvis.queue_entries WHERE id=$1", [taskA.id]);
    assert.deepEqual(retryRow, { state: "queued", attempt_count: 1, delayed: true });

    const stopped = await ownerPost(`/api/v1/stop/projects/${fixtureA.projectId}`, { stopped: true, expectedVersion: 0 });
    assert.equal(stopped.status, 200);
    const stoppedState = await stopped.json();
    assert.equal(stoppedState.global.stopped, false);
    assert.equal(stoppedState.project.stopped, true);
    assert.equal(await workerA.runOnce(), "idle", "stopped A cannot consume its delayed retry");
    assert.equal(await queueStore.get(taskA.id).then((saved) => saved.attempt), 1);

    const taskB = await enqueue(fixtureB, "independent");
    assert.equal(await workerB.runOnce(), "completed", "project B remains eligible while A is stopped");
    assert.deepEqual(dispatched, [{ workerId: "jv286-worker-a", projectId: fixtureA.projectId }, { workerId: "jv286-worker-b", projectId: fixtureB.projectId }]);
    assert.equal((await queueStore.get(taskB.id)).status, "succeeded");
    let savedScopes = await new PostgresStopControlStore(pool).get({ projectId: fixtureA.projectId });
    assert.equal(savedScopes.global.stopped, false, "A stop does not mutate persisted global scope");
    assert.equal(savedScopes.project.stopped, true, "A project stop survives store reconstruction");
    const savedScopesB = await new PostgresStopControlStore(pool).get({ projectId: fixtureB.projectId });
    assert.equal(savedScopesB.global.stopped, false, "B remains globally resumed while A is stopped");
    assert.equal(savedScopesB.project, null, "B has no persisted project stop");

    let eligible = false;
    const eligibilityDeadline = Date.now() + 6_000;
    while (!eligible && Date.now() < eligibilityDeadline) {
      const { rows: [eligibility] } = await pool.query("SELECT available_at <= clock_timestamp() AS ready FROM jarvis.queue_entries WHERE id=$1", [taskA.id]);
      eligible = eligibility.ready;
      if (!eligible) await delay(25);
    }
    assert.equal(eligible, true, "PostgreSQL confirms the durable retry backoff elapsed while project A remains stopped");
    assert.equal(await workerA.runOnce(), "idle", "stopped A cannot consume its eligible retry");
    persistedA = await queueStore.get(taskA.id);
    assert.equal(persistedA.status, "queued");
    assert.equal(persistedA.attempt, 1, "stopped eligible claim does not increment the attempt count");
    assert.equal(dispatched.filter((entry) => entry.projectId === fixtureA.projectId).length, 1,
      "stopped eligible claim does not dispatch A a second time");
    savedScopes = await new PostgresStopControlStore(pool).get({ projectId: fixtureA.projectId });
    assert.equal(savedScopes.global.stopped, false);
    assert.equal(savedScopes.project.stopped, true);

    const resumed = await ownerPost(`/api/v1/stop/projects/${fixtureA.projectId}`, { stopped: false, expectedVersion: stoppedState.project.version });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).project.stopped, false);
    assert.equal(await workerA.runOnce(), "completed", "retry proceeds only when eligible after explicit resume");
    persistedA = await queueStore.get(taskA.id);
    assert.equal(persistedA.status, "succeeded");
    assert.equal(persistedA.attempt, 2);
    savedScopes = await new PostgresStopControlStore(pool).get({ projectId: fixtureA.projectId });
    assert.equal(savedScopes.global.stopped, false);
    assert.equal(savedScopes.project.stopped, false);
    const { rows: [savedQueue] } = await pool.query("SELECT state, attempt_count FROM jarvis.queue_entries WHERE id=$1", [taskA.id]);
    assert.deepEqual(savedQueue, { state: "succeeded", attempt_count: 2 });
    assert.equal(dispatched.filter((entry) => entry.projectId === fixtureA.projectId).length, 2);
    globalThis.console.log("# synthetic dispatch only; PostgreSQL-backed retry/backoff and project-stop isolation; no provider/GitHub calls or product qualification");
  } catch (error) {
    testFailure = error;
  }
  const cleanupFailures = await runCleanupSteps([
    async () => { if (apiServer) await new Promise((resolve) => apiServer.close(resolve)); },
    async () => { if (fixtureA || fixtureB) await resetStopRaceFixture(pool); },
    async () => pool.end(),
  ]);
  throwCollectedFailures(testFailure, cleanupFailures);
});

test("persisted stop state survives an operating-system worker restart", {
  skip: process.env.JARVIS_RUN_STOP_RUNTIME_INTEGRATION !== "1"
    ? "set JARVIS_RUN_STOP_RUNTIME_INTEGRATION=1 to run this on-demand integration scenario"
    : databaseUrl === undefined ? "set JARVIS_TEST_DATABASE_URL to a disposable empty database" : false,
}, async () => {
  const { spawn } = await import("node:child_process");
  const pool = new Pool({ connectionString: databaseUrl, max: 4, application_name: "jv263-process-restart-fixture" });
  const workerSource = `
    import pg from "pg";
    const { PostgresQueueStore, PostgresStopControlStore } = await import(process.env.JV263_PERSISTENCE_MODULE);
    const { QueueService } = await import(process.env.JV263_QUEUE_MODULE);
    const { createQueueWorker, createPersistedStopReader } = await import(process.env.JV263_WORKER_MODULE);
    const pool = new pg.Pool({ connectionString: process.env.JARVIS_TEST_DATABASE_URL, max: 2, application_name: process.env.JV263_APPLICATION_NAME });
    try {
      const controls = new PostgresStopControlStore(pool);
      const queue = new QueueService({ store: new PostgresQueueStore(pool), clock: { now: () => Date.now() }, ids: { next: () => crypto.randomUUID() } });
      let dispatchCount = 0;
      const scope = process.env.JV263_SCOPE;
      const projectId = process.env.JV263_PROJECT_ID;
      if (process.env.JV263_PHASE === "stop") {
        const state = await controls.get({ projectId });
        const current = scope === "global" ? state.global : state.project;
        await controls.set({ ...(scope === "project" ? { projectId } : {}), stopped: true, expectedVersion: current?.version ?? 0, ownerId: "owner" });
      }
      const worker = createQueueWorker({
        queue, workerId: process.env.JV263_APPLICATION_NAME, leaseMs: 30000,
        restoreGate: { waitUntilActivated: async () => undefined, activateAfterRestore: async () => undefined },
        hydrate: async (lease) => ({ taskId: lease.task.taskId, projectId: process.env.JV263_PROJECT_ID, capability: "synthetic" }),
        trustedResultContext: async (lease) => {
          const { rows: [task] } = await pool.query("SELECT r.id AS request_id, t.id AS task_id, t.revision, p.owner_id, p.repository_name FROM jarvis.tasks t JOIN jarvis.requests r ON r.id = t.request_id JOIN jarvis.projects p ON p.id = t.project_id WHERE t.id = $1", [lease.task.taskId]);
          if (!task?.revision) throw new Error("Synthetic plan task lacks its trusted revision context");
          const snapshotDigest = "b".repeat(64);
          return {
            resultId: crypto.randomUUID(),
            expected: { requestId: task.request_id, taskId: task.task_id, attemptId: lease.attemptId, leaseEpoch: lease.epoch, mode: "plan", sourceRevision: task.revision, snapshotDigest, provider: "synthetic", model: "synthetic" },
            snapshot: { repository: task.owner_id + "/" + task.repository_name, revision: task.revision, snapshotDigest, includedPaths: [] },
          };
        },
        execution: {
          readStop: createPersistedStopReader(controls),
          dispatch: async () => { dispatchCount += 1; return { payload: { summary: "Synthetic plan", steps: [], affectedAreas: [], assumptions: [], risks: [], questions: [], limitations: [] } }; },
          revokeCapability: async () => undefined,
          stopSandbox: async () => "stopped",
          recordAcceptedEffectUnknown: async () => undefined,
        },
      });
      const outcome = await worker.runOnce();
      const state = await controls.get({ projectId });
      process.stdout.write(JSON.stringify({ pid: process.pid, outcome, global: state.global, project: state.project, dispatchCount }));
    } finally { await pool.end(); }
  `;
  const runWorker = (phase, scope) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", workerSource], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        JARVIS_TEST_DATABASE_URL: databaseUrl,
        JV263_PERSISTENCE_MODULE: new URL("../dist/index.js", import.meta.url).href,
        JV263_QUEUE_MODULE: new URL("../../queue/dist/index.js", import.meta.url).href,
        JV263_WORKER_MODULE: new URL("../../../apps/worker/dist/index.js", import.meta.url).href,
        JV263_PHASE: phase,
        JV263_SCOPE: scope,
        JV263_PROJECT_ID: fixture.projectId,
        JV263_APPLICATION_NAME: `jv263-${phase}-${randomUUID()}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = globalThis.setTimeout(() => child.kill("SIGKILL"), 10_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { globalThis.clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      globalThis.clearTimeout(timeout);
      if (code !== 0) reject(new Error(`worker ${phase}/${scope} exited code=${code} signal=${signal}: ${stderr}`));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch (error) { reject(new Error(`worker ${phase} returned invalid output: ${stdout}; stderr=${stderr}`, { cause: error })); }
      }
    });
  });

  let testFailure;
  let fixture;
  try {
    await new PostgresPersistence(pool).migrate();
    const controls = new PostgresStopControlStore(pool);
    for (const scope of ["global", "project"]) {
      await resetStopRaceFixture(pool);
      fixture = await createStopRaceFixture(pool, "enqueue");
      const queuedTask = await new QueueService({
        store: new PostgresQueueStore(pool), clock: { now: () => Date.now() }, ids: { next: () => randomUUID() },
      }).enqueue({
        eventId: `jv263-${scope}-${fixture.taskId}`, taskId: fixture.taskId, payload: { taskId: fixture.taskId, projectId: fixture.projectId },
        deadline: Date.now() + 60_000, maxAttempts: 2, retry: { baseDelay: 10, maxDelay: 100 },
      });
      const initialProcess = await runWorker("stop", scope);
      const replacementProcess = await runWorker("check", scope);
      assert.notEqual(initialProcess.pid, replacementProcess.pid, `${scope} replacement must be a distinct OS process`);
      const stoppedState = scope === "global" ? replacementProcess.global : replacementProcess.project;
      const initialStoppedState = scope === "global" ? initialProcess.global : initialProcess.project;
      assert.equal(initialStoppedState.stopped, true, `initial process observes the persisted ${scope} stop before exiting`);
      assert.equal(stoppedState.stopped, true, `replacement observes persisted ${scope} stop state`);
      assert.equal(initialProcess.dispatchCount, 0);
      assert.equal(replacementProcess.outcome, "idle", `replacement worker cannot claim queued work while ${scope}-stopped`);
      assert.equal(replacementProcess.dispatchCount, 0, `${scope}-stopped worker does not invoke dispatch`);
      if (scope === "global") assert.equal(replacementProcess.project, null, "global stop does not create project stop state");
      else assert.equal(replacementProcess.global.stopped, false, "project stop leaves global execution resumed");
      assert.equal((await new PostgresQueueStore(pool).get(queuedTask.id)).status, "queued", `${scope} stop preserves queued work`);

      const snapshot = await controls.get({ projectId: fixture.projectId });
      const current = scope === "global" ? snapshot.global : snapshot.project;
      await controls.set({ ...(scope === "project" ? { projectId: fixture.projectId } : {}), stopped: false, expectedVersion: current?.version ?? 0, ownerId: "owner" });
      const resumedProcess = await runWorker("check", scope);
      assert.notEqual(resumedProcess.pid, replacementProcess.pid, `${scope} post-resume worker is another OS process`);
      assert.equal(resumedProcess.outcome, "completed", `${scope} worker proceeds after explicit owner resume`);
      assert.equal(resumedProcess.dispatchCount, 1, `${scope} resumed worker invokes dispatch`);
      if (scope === "global") assert.equal(resumedProcess.project, null, "global resume leaves project state absent");
      else assert.equal(resumedProcess.global.stopped, false, "project resume leaves global state resumed");
    }
  } catch (error) {
    testFailure = error;
  }
  const cleanupFailures = await runCleanupSteps([
    async () => { if (fixture) await resetStopRaceFixture(pool); },
    async () => pool.end(),
  ]);
  throwCollectedFailures(testFailure, cleanupFailures);
});
});
