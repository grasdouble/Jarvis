import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";

import {
  PostgresOperationalDashboardReadModel,
  PostgresPersistence,
  PostgresQueueStore,
  PostgresStopControlStore,
  PostgresTaskResultReadModel,
  PostgresUsageAccountingStore,
} from "@jarvis/persistence";
import { QueueService } from "../../../packages/queue/dist/index.js";
import {
  createOperationalDashboardBoundary,
  createOperationalDashboardHttpHandler,
  createOperationalDashboardServer,
  createTaskResultReadBoundary,
} from "../dist/index.js";
import { listenUsageAccounting } from "../dist/usage-accounting.js";

const { Pool } = pg;
const databaseUrl = process.env.JARVIS_TEST_DATABASE_URL;
const expectedDatabaseName = process.env.JARVIS_TEST_EXPECTED_DATABASE_NAME;
const gatewayPath = new URL("../../llm-gateway/dist/gateway.js", import.meta.url);
const llmPath = new URL("../../llm-gateway/node_modules/@jarvis/llm/dist/index.js", import.meta.url);
const eventCapabilities = ["chat-completions", "streaming", "cancellation", "context-budget"];

async function builtRuntimePresent() {
  try {
    await Promise.all([access(fileURLToPath(gatewayPath)), access(fileURLToPath(llmPath))]);
    return true;
  } catch {
    return false;
  }
}

function validateDisposableDatabaseUrl(value) {
  assert.equal(typeof value, "string", "a PostgreSQL URL is required");
  let url;
  try { url = new URL(value); }
  catch { throw new Error("database URL must be a valid PostgreSQL URL"); }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "database must use PostgreSQL");
  assert.ok(url.hostname === "127.0.0.1" || (expectedDatabaseName !== undefined && url.hostname === "localhost"),
    "database must use explicit loopback and a disposable database name");
  assert.ok(url.port !== "" && Number(url.port) >= 1 && Number(url.port) <= 65_535, "database must specify a valid local mapped port");
  assert.ok(url.username && url.password, "database credentials are required");
  assert.equal(url.search, "", "database URL options are not permitted");
  assert.equal(url.hash, "", "database URL fragments are not permitted");
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (expectedDatabaseName !== undefined) {
    assert.match(expectedDatabaseName, /^jarvis_integration_(?:auto|manual)_[0-9]+_[0-9]+$/,
      "expected workflow database must use the per-run naming scheme");
    assert.equal(databaseName, expectedDatabaseName, "database URL must match the expected workflow database");
  } else {
    assert.match(databaseName, /^jarvis_issue307_[a-f0-9]{32}$/,
      "local integration requires a uniquely named jarvis_issue307_ disposable database");
  }
}

if (databaseUrl !== undefined) validateDisposableDatabaseUrl(databaseUrl);
const runtimeAvailable = await builtRuntimePresent();
const skipReason = databaseUrl === undefined
  ? "set JARVIS_TEST_DATABASE_URL to a disposable empty loopback PostgreSQL database"
  : !runtimeAvailable
    ? "build @jarvis/llm and @jarvis/llm-gateway before running this cross-layer integration"
    : false;

function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(...args, resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function postJson(socketPath, path, value) {
  const body = Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath, path, method: "POST",
      headers: { "content-type": "application/json", "content-length": body.byteLength },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(body);
  });
}

async function assertEmptyFixtureTables(pool) {
  await pool.query(`DO $$
    DECLARE table_name text; row_count bigint;
    BEGIN
      FOR table_name IN
        SELECT tablename FROM pg_tables
        WHERE schemaname='jarvis' AND tablename NOT IN ('schema_migrations','stop_controls')
      LOOP
        EXECUTE format('SELECT count(*) FROM jarvis.%I', table_name) INTO row_count;
        IF row_count <> 0 THEN
          RAISE EXCEPTION 'provider/result usage integration requires an empty disposable database: jarvis.%', table_name;
        END IF;
      END LOOP;
    END $$`);
}

async function waitForObservation(pool, operationId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await pool.query(`SELECT mr.id
      FROM jarvis.model_requests mr JOIN jarvis.usage_observations uo ON uo.model_request_id=mr.id
      WHERE mr.operation_id=$1 AND uo.source='gateway'`, [operationId]);
    if (rows.length === 1) return rows[0].id;
    await delay(10);
  }
  assert.fail("gateway usage observation did not reach PostgreSQL through the API-owned socket");
}

async function seedDispatchFixture(pool, fixture) {
  const client = await pool.connect();
  const policyHash = "a".repeat(64);
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO jarvis.installations (id, github_id, app_id, state)
      VALUES ($1,$2,$3,'active')`, [fixture.installationId, fixture.repositoryId + 1, fixture.repositoryId + 2]);
    await client.query(`INSERT INTO jarvis.policies (id, version, canonical_json, hash, activated_at)
      VALUES ($1,1,'{"version":1}'::jsonb,$2,now())`, [fixture.policyId, policyHash]);
    await client.query(`INSERT INTO jarvis.projects (id, repository_id, installation_id, owner_id, repository_name, state, config_version)
      VALUES ($1,$2,$3,'owner','synthetic-repository','active',1)`, [fixture.projectId, fixture.repositoryId, fixture.installationId]);
    await client.query(`INSERT INTO jarvis.project_config_versions
      (project_id, repository_id, version, config_json, config_hash, policy_hash, created_by)
      VALUES ($1,$2,1,'{"synthetic":true}'::jsonb,$3,$4,'integration-test')`, [
      fixture.projectId, fixture.repositoryId, "b".repeat(64), policyHash,
    ]);
    await client.query(`INSERT INTO jarvis.requests
      (id, owner_id, project_id, repository_id, mode, prompt_digest, state, idempotency_key, config_version, policy_hash)
      VALUES ($1,'owner',$2,$3,'dev',$4,'queued',$5,1,$6)`, [
      fixture.requestId, fixture.projectId, fixture.repositoryId, "c".repeat(64), `jv307-${fixture.taskId}`, policyHash,
    ]);
    await client.query(`INSERT INTO jarvis.tasks
      (id, request_id, project_id, repository_id, mode, profile_hash, policy_hash, config_version, state, dedupe_key, revision)
      VALUES ($1,$2,$3,$4,'dev',$5,$6,1,'queued',$7,$8)`, [
      fixture.taskId, fixture.requestId, fixture.projectId, fixture.repositoryId, "d".repeat(64),
      policyHash, `jv307-${fixture.taskId}`, fixture.sourceRevision,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

test("dashboard quota signals use a closed allowlist and preserve unknown coverage", async () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const modelRequestId = "22222222-2222-4222-8222-222222222222";
  const operationId = "33333333-3333-4333-8333-333333333333";
  const observedAt = "2026-10-23T00:00:00.000Z";
  const auth = { authorizeRead: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }) };
  const boundary = createOperationalDashboardBoundary({
    async list(ownerId) {
      assert.equal(ownerId, "owner");
      return [{
        id: "project-id", repository: "safe/repo", configVersion: 1,
        configuration: { repository: "safe/repo", state: "active", configVersion: 1,
          nested: { a: { b: { c: { d: { e: { f: "deep-config-value" } } } } } } },
        requests: [], pullRequests: [], state: "active", health: "unknown", observedAt: null,
        usage: {
          modelRequestCount: 1, modelRequests: [{
            id: modelRequestId, operationId, requestId, taskId: requestId, attemptId: requestId,
            provider: "openai", model: "fixture-openai", purpose: "task_execution", state: "succeeded",
            observationsCount: 1, ledger: null, observations: [{
              source: "gateway", revision: 1, mappingVersion: "openai-chat-completions-v1",
              numericUsage: { inputTotal: 1 }, coverage: "partial", freshness: "current", observedAt,
              quotaSignals: {
                source: "provider-response-header", provider: "openai",
                mappingVersion: "openai-rate-limit-headers-v1", observedAt, freshness: "current",
                counters: { requestLimit: 9, requestRemaining: 8, tokenLimit: 7, tokenRemaining: 6, token: 99 },
                coverage: { requestLimit: "reported", requestRemaining: "reported", tokenLimit: "unknown", tokenRemaining: "not_supported", token: "reported" },
                accessToken: "must-not-appear",
              },
            }],
          }],
        },
      }];
    },
  }, auth);
  const response = await boundary.read({ headers: {} });
  assert.equal(response.status, 200);
  assert.equal(response.body.projects[0].configuration.nested.a.b.c.d.e.f, "[bounded]");
  const quota = response.body.projects[0].usage.modelRequests[0].observations[0].quotaSignals;
  assert.deepEqual(quota, {
    source: "provider-response-header",
    provider: "openai",
    mappingVersion: "openai-rate-limit-headers-v1",
    observedAt,
    freshness: "current",
    counters: { requestLimit: 9, requestRemaining: 8, tokenLimit: 7, tokenRemaining: 6 },
    coverage: { requestLimit: "reported", requestRemaining: "reported", tokenLimit: "unknown", tokenRemaining: "not_supported" },
  });
});

test("selected provider usage crosses the configured gateway and API socket into owner-scoped PostgreSQL reads", {
  skip: skipReason,
}, async () => {
  const { resolveProviderCatalog } = await import(fileURLToPath(llmPath));
  const { createConfiguredGateway, createUnixSocketFetch } = await import(fileURLToPath(gatewayPath));
  const pool = new Pool({ connectionString: databaseUrl, max: 6, application_name: "jv307-provider-result-usage" });
  const lockClient = await pool.connect();
  let accountingServer;
  let gateway;
  let apiServer;
  let directory;
  let fixtureStarted = false;
  try {
    const { rows: [database] } = await pool.query("SELECT current_database() AS name");
    const url = new URL(databaseUrl);
    assert.equal(database.name, decodeURIComponent(url.pathname.slice(1)), "test connected to its named disposable database");
    await new PostgresPersistence(pool).migrate();
    await lockClient.query("SELECT pg_advisory_lock($1)", [0x4a385445]);
    await assertEmptyFixtureTables(pool);

    const fixture = {
      installationId: randomUUID(), policyId: randomUUID(), projectId: randomUUID(), requestId: randomUUID(),
      taskId: randomUUID(), resultId: randomUUID(), repositoryId: 307_000_000 + Math.floor(Math.random() * 1_000_000),
      sourceRevision: "e".repeat(40),
    };
    const profiles = resolveProviderCatalog({
      activeProfileId: "openai",
      profiles: {
        copilot: { modelId: "fixture-copilot", contextWindowTokens: 4096, maxOutputTokens: 512, capabilities: eventCapabilities },
        openai: { modelId: "fixture-openai", contextWindowTokens: 4096, maxOutputTokens: 512, capabilities: eventCapabilities },
      },
    });
    const selected = profiles.active;
    assert.equal(profiles.activeProfileId, "openai");
    assert.deepEqual(Object.keys(profiles.profiles).sort(), ["copilot", "openai"]);
    assert.equal(selected.id, "openai");
    assert.equal(selected.providerId, "openai");
    const model = selected.modelId;
    fixtureStarted = true;
    await seedDispatchFixture(pool, fixture);
    await pool.query(`INSERT INTO jarvis.stop_controls(scope, project_id, stopped, version, changed_by)
      VALUES ('global', NULL, true, 1, 'system') ON CONFLICT DO NOTHING`);
    const stopControls = new PostgresStopControlStore(pool);
    const globalStop = await stopControls.get({});
    await stopControls.set({ stopped: false, expectedVersion: globalStop.global.version, ownerId: "owner" });
    const queue = new QueueService({
      store: new PostgresQueueStore(pool),
      clock: { now: () => Date.now() },
      ids: { next: () => randomUUID() },
    });
    await queue.enqueue({
      eventId: `jv307-${fixture.taskId}`,
      taskId: fixture.taskId,
      payload: { taskId: fixture.taskId },
      deadline: Date.now() + 60 * 60_000,
      maxAttempts: 3,
      retry: { baseDelay: 0, maxDelay: 0 },
    });
    const lease = await queue.claim("jv307-synthetic-worker", 60_000);
    assert.ok(lease, "the disposable queued task receives a real PostgreSQL lease");
    assert.equal(lease.task.taskId, fixture.taskId);

    directory = await mkdtemp(join(tmpdir(), "jv307-"));
    const accountingSocketPath = join(directory, "accounting.sock");
    const gatewaySocketPath = join(directory, "gateway.sock");
    accountingServer = await listenUsageAccounting({ path: accountingSocketPath, store: new PostgresUsageAccountingStore(pool) });

    const dispatches = [];
    const syntheticUsage = [
      { prompt_tokens: 2000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1500 }, completion_tokens_details: { reasoning_tokens: 100 } },
      { prompt_tokens: 4, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 0 } },
    ];
    const capability = "a".repeat(64);
    gateway = createConfiguredGateway({
      socketPath: gatewaySocketPath,
      accountingSocketPath,
      egressConfig: { providers: [], dispatch_enabled: false, filterCapability: capability },
      gatewayConfig: {
        accounting: { taskId: fixture.taskId, attemptId: lease.attemptId, leaseEpoch: lease.epoch },
        dispatch_enabled: true,
        profile: selected,
        filterHost: `jarvis-egress-filter-${randomUUID()}`,
        filterPort: 8080,
      },
      maxInputBytes: 16 * 1024,
      maxOutputTokens: selected.maxOutputTokens,
      maxRequests: 3,
      fetcher: async (url, init) => {
        assert.match(String(url), /^http:\/\/jarvis-egress-filter-[0-9a-f-]{36}:8080\/v1\/dispatch$/);
        assert.equal(init?.method, "POST");
        assert.equal((init?.headers ?? {}).authorization, `Bearer ${capability}`);
        const envelope = JSON.parse(String(init?.body));
        const providerBody = JSON.parse(Buffer.from(envelope.body, "base64").toString("utf8"));
        assert.equal(envelope.providerId, selected.providerId);
        assert.equal(envelope.route, "/v1/chat/completions");
        assert.equal(providerBody.model, selected.modelId);
        dispatches.push({ providerId: envelope.providerId, model: providerBody.model });
        if (dispatches.length === 2) {
          return Response.json({ error: { message: "synthetic selected-provider failure" } }, { status: 503 });
        }
        const usage = syntheticUsage[dispatches.length === 1 ? 0 : 1];
        assert.ok(usage);
        return Response.json({
          id: `synthetic-${dispatches.length}`,
          model: selected.modelId,
          choices: [{ message: { role: "assistant", content: `synthetic result ${dispatches.length}` } }],
          usage,
        }, { headers: {
          "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "90",
          "x-ratelimit-limit-tokens": "10000", "x-ratelimit-remaining-tokens": "8500",
        } });
      },
    });
    await listen(gateway, gatewaySocketPath);

    const ownerFor = (requestValue) => requestValue.headers["x-fixture-owner"] === "other" ? "other" : "owner";
    const auth = {
      async authorizeRead(requestValue) {
        return { authorized: true, auth: { ownerId: ownerFor(requestValue) }, headers: { "cache-control": "no-store" } };
      },
      async getSession() { return { status: 404 }; },
      async onboard() { return { status: 404 }; },
      async login() { return { status: 404 }; },
      async logout() { return { status: 404 }; },
      async authorizeMutation() { return { authorized: false, response: { status: 401, body: { error: "unauthorized" } } }; },
    };
    const dashboard = createOperationalDashboardHttpHandler(createOperationalDashboardBoundary(
      new PostgresOperationalDashboardReadModel(pool), auth,
    ));
    const taskResult = createTaskResultReadBoundary(new PostgresTaskResultReadModel(pool), auth);
    apiServer = createOperationalDashboardServer({
      auth,
      dashboard,
      taskResults: (requestValue, taskId) => taskResult.get(requestValue, taskId),
    });
    await listen(apiServer, 0, "127.0.0.1");
    const address = apiServer.address();
    assert.ok(address && typeof address === "object");
    const apiOrigin = `http://127.0.0.1:${address.port}`;
    const gatewayFetch = createUnixSocketFetch(gatewaySocketPath);
    const attemptIdentity = {
      taskId: fixture.taskId,
      attemptId: lease.attemptId,
      leaseEpoch: lease.epoch,
      dispatchAttempt: 1,
      provider: selected.providerId,
      model,
      purpose: "task_execution",
    };

    const firstResponse = await gatewayFetch("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 128, stream: false, messages: [{ role: "user", content: "synthetic first attempt" }] }),
    });
    assert.equal(firstResponse.status, 200);
    assert.equal((await firstResponse.json()).choices[0].message.content, "synthetic result 1");
    const firstOperationId = firstResponse.headers.get("x-jarvis-dispatch-id");
    assert.match(firstOperationId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    await waitForObservation(pool, firstOperationId);

    const { rows: [storedObservation] } = await pool.query(`SELECT mr.id AS model_request_id, mr.provider, mr.model,
      mr.lifecycle, uo.observation_id, uo.revision, uo.numeric_usage, uo.field_statuses, uo.mapping_version,
      to_char(uo.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at,
      uo.freshness, uo.quota_signals
      FROM jarvis.model_requests mr JOIN jarvis.usage_observations uo ON uo.model_request_id=mr.id
      WHERE mr.operation_id=$1 AND uo.source='gateway'`, [firstOperationId]);
    assert.equal(storedObservation.provider, selected.providerId);
    assert.equal(storedObservation.model, selected.modelId);
    assert.equal(storedObservation.lifecycle, "succeeded");
    assert.deepEqual(storedObservation.numeric_usage, {
      inputTotal: 2000, outputTotal: 300, cacheReadInput: 1500, cacheWriteInput: null, reasoningOutput: 100,
    });
    assert.equal(storedObservation.freshness, "current");
    assert.equal(storedObservation.quota_signals.source, "provider-response-header");
    assert.equal(storedObservation.quota_signals.freshness, "current");
    assert.deepEqual(storedObservation.quota_signals.counters, {
      requestLimit: 100, requestRemaining: 90, tokenLimit: 10000, tokenRemaining: 8500,
    });
    assert.ok(Object.values(storedObservation.quota_signals.coverage).every((status) => status === "reported"));
    const replay = await postJson(accountingSocketPath, "/v1/usage/observation", {
      attribution: { ...attemptIdentity, operationId: firstOperationId },
      lifecycle: "succeeded",
      observation: {
        source: "gateway", observationId: storedObservation.observation_id, revision: storedObservation.revision,
        observedAt: storedObservation.observed_at, freshness: storedObservation.freshness,
        usage: {
          mappingVersion: storedObservation.mapping_version,
          counters: storedObservation.numeric_usage,
          coverage: storedObservation.field_statuses,
        },
        quota: storedObservation.quota_signals,
      },
    });
    assert.equal(replay.status, 204, replay.body);
    const { rows: [afterReplay] } = await pool.query(`SELECT count(*)::integer AS observations,
      max(ul.token_counts->>'inputTotal') AS canonical_input
      FROM jarvis.model_requests mr
      JOIN jarvis.usage_observations uo ON uo.model_request_id=mr.id AND uo.source='gateway'
      JOIN jarvis.usage_ledger ul ON ul.model_request_id=mr.id
      WHERE mr.operation_id=$1`, [firstOperationId]);
    assert.deepEqual(afterReplay, { observations: 1, canonical_input: "2000" }, "same API-socket observation replay is idempotent");
    const failedResponse = await gatewayFetch("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 128, stream: false, messages: [{ role: "user", content: "synthetic failed attempt" }] }),
    });
    assert.equal(failedResponse.status, 503);
    const failedOperationId = failedResponse.headers.get("x-jarvis-dispatch-id");
    assert.match(failedOperationId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(failedOperationId, firstOperationId, "the failed provider operation has a distinct identity");
    await waitForObservation(pool, failedOperationId);
    const { rows: [failedObservation] } = await pool.query(`SELECT mr.lifecycle, mr.state,
      uo.numeric_usage, uo.field_statuses, uo.quota_signals, uo.observed_at, uo.freshness
      FROM jarvis.model_requests mr JOIN jarvis.usage_observations uo ON uo.model_request_id=mr.id
      WHERE mr.operation_id=$1 AND uo.source='gateway'`, [failedOperationId]);
    assert.equal(failedObservation.lifecycle, "failed");
    assert.equal(failedObservation.state, "failed");
    assert.ok(Number.isFinite(Date.parse(failedObservation.observed_at)));
    assert.equal(failedObservation.freshness, "current");
    assert.deepEqual(failedObservation.numeric_usage, {
      inputTotal: null, outputTotal: null, cacheReadInput: null, cacheWriteInput: null, reasoningOutput: null,
    });
    assert.ok(Object.values(failedObservation.field_statuses).every((status) => status === "unknown"));
    assert.equal(failedObservation.quota_signals.source, "provider-response-header");
    assert.equal(failedObservation.quota_signals.provider, selected.providerId);
    assert.equal(failedObservation.quota_signals.mappingVersion, "openai-rate-limit-headers-v1");
    assert.equal(failedObservation.quota_signals.freshness, "current");
    assert.ok(Number.isFinite(Date.parse(failedObservation.quota_signals.observedAt)));
    assert.deepEqual(failedObservation.quota_signals.counters, {
      requestLimit: null, requestRemaining: null, tokenLimit: null, tokenRemaining: null,
    });
    assert.deepEqual(failedObservation.quota_signals.coverage, {
      requestLimit: "unknown", requestRemaining: "unknown", tokenLimit: "unknown", tokenRemaining: "unknown",
    });

    const retryResponse = await gatewayFetch("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 128, stream: false, messages: [{ role: "user", content: "synthetic retry" }] }),
    });
    assert.equal(retryResponse.status, 200);
    assert.equal((await retryResponse.json()).choices[0].message.content, "synthetic result 3");
    const retryOperationId = retryResponse.headers.get("x-jarvis-dispatch-id");
    assert.match(retryOperationId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(retryOperationId, failedOperationId, "the separately dispatched retry has its own operation identity");
    assert.notEqual(retryOperationId, firstOperationId, "a retry is separately dispatched from the first operation");
    await waitForObservation(pool, retryOperationId);
    assert.deepEqual(dispatches, [
      { providerId: selected.providerId, model: selected.modelId },
      { providerId: selected.providerId, model: selected.modelId },
      { providerId: selected.providerId, model: selected.modelId },
    ]);
    const { rows: operationRows } = await pool.query(`SELECT mr.operation_id, mr.request_id, mr.task_id, mr.attempt_id,
      mr.provider, mr.model, mr.purpose, mr.dispatch_attempt, mr.lifecycle, mr.state,
      mr.dispatched_at IS NOT NULL AS dispatched, mr.completed_at IS NOT NULL AS completed,
      a.lease_epoch, a.state AS attempt_state, q.attempt_id AS queue_attempt_id,
      q.lease_epoch AS queue_lease_epoch, q.state AS queue_state
      FROM jarvis.model_requests mr
      JOIN jarvis.task_attempts a ON a.id=mr.attempt_id AND a.task_id=mr.task_id
      JOIN jarvis.queue_entries q ON q.task_id=mr.task_id AND q.attempt_id=a.id AND q.lease_epoch=a.lease_epoch
      WHERE mr.operation_id=ANY($1::uuid[]) ORDER BY mr.operation_id`,
    [[firstOperationId, failedOperationId, retryOperationId]]);
    assert.equal(operationRows.length, 3);
    const operationById = new Map(operationRows.map((row) => [row.operation_id, row]));
    for (const [operationId, lifecycle] of [
      [firstOperationId, "succeeded"],
      [failedOperationId, "failed"],
      [retryOperationId, "succeeded"],
    ]) {
      const operation = operationById.get(operationId);
      assert.ok(operation, `operation ${operationId} is durably attributed`);
      assert.deepEqual({
        requestId: operation.request_id,
        taskId: operation.task_id,
        attemptId: operation.attempt_id,
        leaseEpoch: Number(operation.lease_epoch),
        attemptState: operation.attempt_state,
        queueAttemptId: operation.queue_attempt_id,
        queueLeaseEpoch: Number(operation.queue_lease_epoch),
        queueState: operation.queue_state,
        provider: operation.provider,
        model: operation.model,
        purpose: operation.purpose,
        dispatchAttempt: operation.dispatch_attempt,
        lifecycle: operation.lifecycle,
        state: operation.state,
        dispatched: operation.dispatched,
        completed: operation.completed,
      }, {
        requestId: fixture.requestId,
        taskId: fixture.taskId,
        attemptId: lease.attemptId,
        leaseEpoch: lease.epoch,
        attemptState: "active",
        queueAttemptId: lease.attemptId,
        queueLeaseEpoch: lease.epoch,
        queueState: "leased",
        provider: selected.providerId,
        model: selected.modelId,
        purpose: "task_execution",
        dispatchAttempt: 1,
        lifecycle,
        state: lifecycle,
        dispatched: true,
        completed: true,
      });
    }

    const { rows: [billed] } = await pool.query(`SELECT count(*)::integer AS request_count,
      count(DISTINCT mr.operation_id)::integer AS distinct_operations,
      sum((ul.token_counts->>'inputTotal')::integer)::integer AS input_total,
      sum((ul.token_counts->>'outputTotal')::integer)::integer AS output_total
      FROM jarvis.model_requests mr JOIN jarvis.usage_ledger ul ON ul.model_request_id=mr.id
      WHERE mr.operation_id=ANY($1::uuid[])`, [[firstOperationId, retryOperationId]]);
    assert.deepEqual(billed, { request_count: 2, distinct_operations: 2, input_total: 2004, output_total: 301 });

    const canonicalResult = {
      schemaVersion: 1,
      requestId: fixture.requestId,
      taskId: fixture.taskId,
      attemptId: lease.attemptId,
      leaseEpoch: lease.epoch,
      mode: "dev",
      sourceRevision: fixture.sourceRevision,
      snapshotDigest: "f".repeat(64),
      provider: selected.providerId,
      model: selected.modelId,
      resultId: fixture.resultId,
      payload: {
        summary: "Synthetic completed task result",
        artifactId: randomUUID(),
        patchDigest: "1".repeat(64),
        changedPaths: ["src/synthetic.ts"],
        limitations: [],
      },
    };
    const completion = await queue.complete(lease, { kind: "report", id: fixture.resultId }, canonicalResult);
    assert.equal(completion.status, "succeeded");

    const ownerDashboardResponse = await fetch(`${apiOrigin}/api/v1/dashboard`, { headers: { "x-fixture-owner": "owner" } });
    assert.equal(ownerDashboardResponse.status, 200);
    const ownerDashboard = await ownerDashboardResponse.json();
    assert.equal(ownerDashboard.projects.length, 1);
    const usage = ownerDashboard.projects[0].usage;
    assert.equal(usage.modelRequestCount, 3);
    assert.equal(usage.modelRequests.length, 3);
    assert.equal(usage.modelRequestsTruncated, false);
    assert.equal(usage.modelRequestsOmitted, 0);
    const projectedByOperation = new Map(usage.modelRequests.map((entry) => [entry.operationId, entry]));
    assert.deepEqual([...projectedByOperation.keys()].sort(), [firstOperationId, failedOperationId, retryOperationId].sort());
    for (const [operationId, inputTotal, outputTotal] of [
      [firstOperationId, 2000, 300],
      [retryOperationId, 4, 1],
    ]) {
      const entry = projectedByOperation.get(operationId);
      assert.ok(entry);
      assert.deepEqual({
        requestId: entry.requestId,
        taskId: entry.taskId,
        attemptId: entry.attemptId,
        provider: entry.provider,
        model: entry.model,
        purpose: entry.purpose,
        state: entry.state,
      }, {
        requestId: fixture.requestId,
        taskId: fixture.taskId,
        attemptId: lease.attemptId,
        provider: selected.providerId,
        model: selected.modelId,
        purpose: "task_execution",
        state: "succeeded",
      });
      assert.ok(Number.isFinite(Date.parse(entry.dispatchedAt)));
      assert.equal(entry.observationsCount, 1);
      assert.equal(entry.observations.length, 1);
      const observation = entry.observations[0];
      assert.deepEqual(observation.numericUsage, {
        inputTotal, outputTotal, cacheReadInput: inputTotal === 2000 ? 1500 : 1,
        cacheWriteInput: null, reasoningOutput: inputTotal === 2000 ? 100 : 0,
      });
      assert.equal(observation.source, "gateway");
      assert.equal(observation.revision, 1);
      assert.equal(observation.mappingVersion, "openai-chat-completions-v1");
      assert.equal(observation.coverage, "partial");
      assert.equal(observation.freshness, "current");
      assert.ok(Number.isFinite(Date.parse(observation.observedAt)));
      assert.deepEqual(Object.keys(observation.quotaSignals).sort(), [
        "counters", "coverage", "freshness", "mappingVersion", "observedAt", "provider", "source",
      ]);
      assert.ok(Number.isFinite(Date.parse(observation.quotaSignals.observedAt)));
      assert.deepEqual(observation.quotaSignals, {
        source: "provider-response-header",
        provider: selected.providerId,
        mappingVersion: "openai-rate-limit-headers-v1",
        observedAt: observation.quotaSignals.observedAt,
        freshness: "current",
        counters: { requestLimit: 100, requestRemaining: 90, tokenLimit: 10000, tokenRemaining: 8500 },
        coverage: {
          requestLimit: "reported", requestRemaining: "reported", tokenLimit: "reported", tokenRemaining: "reported",
        },
      });
      assert.equal(entry.ledger.tokenCounts.inputTotal, inputTotal);
      assert.equal(entry.ledger.tokenCounts.outputTotal, outputTotal);
    }
    const failedEntry = projectedByOperation.get(failedOperationId);
    assert.ok(failedEntry);
    assert.deepEqual({
      requestId: failedEntry.requestId,
      taskId: failedEntry.taskId,
      attemptId: failedEntry.attemptId,
      provider: failedEntry.provider,
      model: failedEntry.model,
      purpose: failedEntry.purpose,
      state: failedEntry.state,
    }, {
      requestId: fixture.requestId,
      taskId: fixture.taskId,
      attemptId: lease.attemptId,
      provider: selected.providerId,
      model: selected.modelId,
      purpose: "task_execution",
      state: "failed",
    });
    assert.equal(failedEntry.observationsCount, 1);
    const failedProjection = failedEntry.observations[0];
    assert.deepEqual(failedProjection.numericUsage, {
      inputTotal: null, outputTotal: null, cacheReadInput: null, cacheWriteInput: null, reasoningOutput: null,
    });
    assert.equal(failedProjection.coverage, "partial");
    assert.equal(failedProjection.freshness, "current");
    assert.equal(failedProjection.source, "gateway");
    assert.equal(failedProjection.revision, 1);
    assert.equal(failedProjection.mappingVersion, "openai-chat-completions-v1");
    assert.ok(Number.isFinite(Date.parse(failedProjection.observedAt)));
    assert.ok(Number.isFinite(Date.parse(failedProjection.quotaSignals.observedAt)));
    assert.deepEqual(failedProjection.quotaSignals.counters, {
      requestLimit: null, requestRemaining: null, tokenLimit: null, tokenRemaining: null,
    });
    assert.deepEqual(failedProjection.quotaSignals.coverage, {
      requestLimit: "unknown", requestRemaining: "unknown", tokenLimit: "unknown", tokenRemaining: "unknown",
    });

    const otherDashboardResponse = await fetch(`${apiOrigin}/api/v1/dashboard`, { headers: { "x-fixture-owner": "other" } });
    assert.equal(otherDashboardResponse.status, 200);
    assert.deepEqual((await otherDashboardResponse.json()).projects, [], "usage dashboard is scoped to the authenticated owner");
    const ownerResultResponse = await fetch(`${apiOrigin}/api/v1/tasks/${fixture.taskId}/result`, { headers: { "x-fixture-owner": "owner" } });
    assert.equal(ownerResultResponse.status, 200);
    assert.deepEqual(await ownerResultResponse.json(), canonicalResult);
    const otherResultResponse = await fetch(`${apiOrigin}/api/v1/tasks/${fixture.taskId}/result`, { headers: { "x-fixture-owner": "other" } });
    assert.equal(otherResultResponse.status, 404, "canonical result read does not disclose another owner's task result");
  } finally {
    if (apiServer?.listening) await close(apiServer);
    if (gateway?.listening) await close(gateway);
    if (accountingServer?.listening) await close(accountingServer);
    if (fixtureStarted) {
      await pool.query(`DO $$
        DECLARE truncate_tables text;
        BEGIN
          SELECT string_agg(format('jarvis.%I', tablename), ', ' ORDER BY tablename)
          INTO truncate_tables FROM pg_tables
          WHERE schemaname='jarvis' AND tablename NOT IN ('schema_migrations','stop_controls');
          IF truncate_tables IS NOT NULL THEN EXECUTE 'TRUNCATE TABLE ' || truncate_tables || ' CASCADE'; END IF;
        END $$`);
      await pool.query(`INSERT INTO jarvis.stop_controls(scope, project_id, stopped, version, changed_by)
        VALUES ('global', NULL, true, 1, 'system') ON CONFLICT DO NOTHING`);
    }
    await lockClient.query("SELECT pg_advisory_unlock($1)", [0x4a385445]);
    lockClient.release();
    await pool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
