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
  assert.match(calls[0].text, /p\.owner_id=\$1/);
  assert.match(calls[0].text, /r\.project_id=p\.id/);
  assert.doesNotMatch(calls[0].text, /\b(INSERT|UPDATE|DELETE)\b/i);
  assert.equal(projects[0].requests[0].remoteResult, "unknown");
  assert.equal(projects[0].observedAt, null);
  assert.equal(projects[0].usage.coverage, "unknown");
  assert.equal(projects[0].health, "unknown");
  assert.deepEqual(await model.list("other"), []);
  assert.equal(calls.length, 1);
});

test("dashboard exposes only project-attributed persisted usage and preserves per-field unknown coverage", async () => {
  let query = "";
  const pool = { connect: async () => ({
    query: async (text) => { query = text; return { rows: [{ project_id: "p1", repository: "safe/repo", state: "active", installation_state: "active", revoked_at: null, config_version: 3,
      requests: [{ id: "r1", mode: "dev", state: "completed", attemptCount: 1, attempts: [], remoteResult: "known", observedAt: "2026-10-23T00:00:00.000Z" }],
      pull_requests: [], latest_observed_at: "2026-10-23T00:00:00.000Z",
      usage: { modelRequestCount: 1, coverage: "unknown", modelRequests: [{ id: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222", state: "completed", dispatchedAt: "2026-10-23T00:00:00.000Z", ledger: { reserved: "0.00000000", tokenCounts: { input: 120, output: null, prompt: "secret" }, fieldStatuses: { input: "reported", output: "unknown" }, estimatedCharge: null, providerReportedCharge: null, currency: null, reconciliationState: "unknown", updatedAt: "2026-10-23T00:00:00.000Z" }, observations: [] }] } }], rowCount: 1 }; }, release() {},
  }) };
  const model = new persistence.PostgresOperationalDashboardReadModel(pool);
  const [project] = await model.list("owner");
  assert.ok(project.usage, "persisted project-attributed usage should be available");
  assert.equal(project.usage.modelRequestCount, 1);
  assert.equal(project.usage.modelRequests[0].ledger.tokenCounts.input, 120);
  assert.equal(project.usage.modelRequests[0].ledger.tokenCounts.output, null);
  assert.equal(project.usage.modelRequests[0].ledger.tokenCounts.prompt, undefined);
  assert.equal(project.usage.modelRequests[0].ledger.fieldStatuses.output, "unknown");
  assert.match(query, /usage_ledger/);
  assert.match(query, /usage_observations/);
  assert.match(query, /r\.id=mr\.request_id/);
  assert.match(query, /r\.project_id=p\.id AND r\.owner_id=p\.owner_id/);
  assert.match(query, /uo\.model_request_id=mr\.id/);
  assert.doesNotMatch(query, /r\.prompt|api_key|credential/i);
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
