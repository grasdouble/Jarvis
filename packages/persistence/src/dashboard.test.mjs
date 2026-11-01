import test from "node:test";
import assert from "node:assert/strict";
import * as persistence from "../dist/index.js";

test("persistence exports owner-scoped operational dashboard read model", () => {
  assert.equal(typeof persistence.PostgresOperationalDashboardReadModel, "function");
});

test("PostgreSQL dashboard reads only active allowlisted owner projects and preserves unknown facts", async () => {
  const calls = [];
  const pool = { connect: async () => ({
    query: async (text, values = []) => {
      calls.push({ text, values });
      return { rows: [{ project_id: "p1", repository: "safe/repo", state: "active", installation_state: "active", revoked_at: null, config_version: 3,
        requests: [{ id: "r1", mode: "dev", state: "running", attemptCount: 0, remoteResult: "unknown", observedAt: null }],
        pull_requests: [], latest_observed_at: null }], rowCount: 1 };
    }, release() {},
  }) };
  const model = new persistence.PostgresOperationalDashboardReadModel(pool);
  const projects = await model.list("owner");
  assert.deepEqual(calls[0].values, ["owner"]);
  assert.equal(projects[0].requests[0].remoteResult, "unknown");
  assert.equal(projects[0].observedAt, null);
  assert.equal(projects[0].usage.coverage, "unknown");
  assert.equal(projects[0].health, "unknown");
  assert.deepEqual(await model.list("other"), []);
  assert.equal(calls.length, 1);
});

test("dashboard exposes only project-attributed persisted usage and preserves per-field unknown coverage", async () => {
  const pool = { connect: async () => ({
    query: async () => { return { rows: [{ project_id: "p1", repository: "safe/repo", state: "active", installation_state: "active", revoked_at: null, config_version: 3,
      requests: [{ id: "r1", mode: "dev", state: "completed", attemptCount: 1, attempts: [], remoteResult: "known", observedAt: "2026-10-23T00:00:00.000Z" }],
      pull_requests: [], latest_observed_at: "2026-10-23T00:00:00.000Z",
      usage: { modelRequestCount: 1, coverage: "unknown", modelRequests: [{ id: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222", state: "completed", runtimeCoverage: "unknown", dispatchedAt: "2026-10-23T00:00:00.000Z", ledger: { reserved: "0.00000000", tokenCounts: { input: 120, output: null, prompt: "secret" }, fieldStatuses: { input: "reported", output: "unknown" }, estimatedCharge: null, providerReportedCharge: null, currency: null, reconciliationState: "unknown", updatedAt: "2026-10-23T00:00:00.000Z" }, observations: [{ source: "gateway", revision: 1, numericUsage: { inputTotal: 12 }, mappingVersion: "openai-chat-completions-v1", coverage: "partial", observedAt: "2026-10-23T00:00:00.000Z", quotaSignals: { mappingVersion: "openai-rate-limit-headers-v1", source: "provider-response-header", provider: "openai", observedAt: "2026-10-23T00:00:00.000Z", freshness: "current", counters: { requestRemaining: 90 }, coverage: { requestRemaining: "reported" } } }] }] } }], rowCount: 1 }; }, release() {},
  }) };
  const model = new persistence.PostgresOperationalDashboardReadModel(pool);
  const [project] = await model.list("owner");
  assert.ok(project.usage, "persisted project-attributed usage should be available");
  assert.equal(project.usage.modelRequestCount, 1);
  assert.equal(project.usage.modelRequests[0].ledger.tokenCounts.input, 120);
  assert.equal(project.usage.modelRequests[0].ledger.tokenCounts.output, null);
  assert.equal(project.usage.modelRequests[0].ledger.tokenCounts.prompt, undefined);
  assert.equal(project.usage.modelRequests[0].ledger.fieldStatuses.output, "unknown");
  assert.equal(project.usage.modelRequests[0].runtimeCoverage, "unknown");
  assert.deepEqual(project.usage.modelRequests[0].observations[0].quotaSignals.counters, { requestLimit: null, requestRemaining: 90, tokenLimit: null, tokenRemaining: null });
});
test("dashboard preserves exact token quota counters while filtering credential-like keys", async () => {
  const pool = { connect: async () => ({
    query: async () => ({ rows: [{
      project_id: "p1", repository: "safe/repo", state: "active", installation_state: "active",
      revoked_at: null, config_version: 1, requests: [], pull_requests: [], latest_observed_at: null,
      usage: { modelRequestCount: 1, coverage: "partial", modelRequests: [{
        id: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222",
        taskId: "33333333-3333-4333-8333-333333333333", attemptId: "44444444-4444-4444-8444-444444444444",
        state: "completed", runtimeCoverage: "unknown", observations: [{
          source: "gateway", revision: 1, freshness: "current", quotaSignals: {
            mappingVersion: "openai-rate-limit-headers-v1", source: "provider-response-header",
            provider: "openai", observedAt: "2026-10-23T00:00:00.000Z", freshness: "current",
            counters: { requestLimit: 100, requestRemaining: 90, tokenLimit: 10_000, tokenRemaining: 8_500, token: 777, accessToken: 888 },
            coverage: { requestLimit: "reported", requestRemaining: "reported", tokenLimit: "reported", tokenRemaining: "reported" },
          },
        }],
      }] },
    }], rowCount: 1 }), release() {},
  }) };
  const [project] = await new persistence.PostgresOperationalDashboardReadModel(pool).list("owner");
  assert.deepEqual(project.usage.modelRequests[0].observations[0].quotaSignals.counters,
    { requestLimit: 100, requestRemaining: 90, tokenLimit: 10_000, tokenRemaining: 8_500 });
});

test("missing or malformed usage evidence remains unknown instead of becoming zero", async () => {
  const supplied = [null, { modelRequestCount: "not-a-count", modelRequests: "malformed" }];
  const pool = { connect: async () => ({
    query: async () => ({ rows: supplied.map((usage, index) => ({ project_id: `p${index}`, repository: "safe/repo", state: "active", installation_state: "active", revoked_at: null,
      config_version: 1, requests: [], pull_requests: [], latest_observed_at: null, usage })), rowCount: supplied.length }),
    release() {},
  }) };
  const projects = await new persistence.PostgresOperationalDashboardReadModel(pool).list("owner");
  for (const project of projects) {
    assert.equal(project.usage.modelRequestCount, null);
    assert.equal(project.usage.coverage, "unknown");
    assert.equal(project.usage.modelRequests.length, 0);
  }
});

test("dashboard usage preserves bounded provider/model and request/task/attempt/purpose attribution", async () => {
  const pool = { connect: async () => ({
    query: async () => {
      return { rows: [{ project_id: "p1", repository: "safe/repo", state: "active", installation_state: "active", revoked_at: null,
        config_version: 1, requests: [], pull_requests: [], latest_observed_at: null,
        usage: { modelRequestCount: 2, modelRequests: [{ id: "11111111-1111-4111-8111-111111111111",
          requestId: "22222222-2222-4222-8222-222222222222", taskId: "33333333-3333-4333-8333-333333333333",
          attemptId: "44444444-4444-4444-8444-444444444444", provider: "OpenAI", model: "gpt-4.1", purpose: "task_execution",
          profileHash: "must-not-leak", prompt: "must-not-leak", state: "completed", observations: [], ledger: null },
          { provider: "OpenAI\\nInjected", model: "model", purpose: "unknown purpose", taskId: "bad-id", attemptId: null }] } }], rowCount: 1 };
    }, release() {},
  }) };
  const [project] = await new persistence.PostgresOperationalDashboardReadModel(pool).list("owner");
  const row = project.usage.modelRequests[0];
  assert.deepEqual({ provider: row.provider, model: row.model, purpose: row.purpose, requestId: row.requestId, taskId: row.taskId, attemptId: row.attemptId }, {
    provider: "OpenAI", model: "gpt-4.1", purpose: "task_execution", requestId: "22222222-2222-4222-8222-222222222222",
    taskId: "33333333-3333-4333-8333-333333333333", attemptId: "44444444-4444-4444-8444-444444444444",
  });
  assert.equal("profileHash" in row, false);
  assert.equal("prompt" in row, false);
  assert.equal(project.usage.modelRequests[1].provider, null);
  assert.equal(project.usage.modelRequests[1].taskId, null);
});
