import test from "node:test";
import assert from "node:assert/strict";
import { createOperationalDashboardBoundary } from "../dist/dashboard.js";
import * as api from "../dist/index.js";

test("dashboard provides a routable authenticated read-only HTTP adapter", () => {
  assert.equal(typeof api.createOperationalDashboardHttpHandler, "function");
});

test("HTTP adapter routes authenticated dashboard and both exports, rejects mutations", async () => {
  const calls = [];
  const handler = api.createOperationalDashboardHttpHandler(api.createOperationalDashboardBoundary({
    list: async (ownerId) => { calls.push(ownerId); return [project]; },
  }, auth));
  const read = await handler({ method: "GET", url: "/api/v1/dashboard", headers: {} });
  assert.equal(read.status, 200);
  assert.equal((await handler({ method: "GET", url: "/api/v1/dashboard/export.json", headers: {} })).status, 200);
  assert.equal((await handler({ method: "GET", url: "/api/v1/dashboard/export.txt", headers: {} })).status, 200);
  assert.equal((await handler({ method: "POST", url: "/api/v1/dashboard", headers: {} })).status, 405);
  assert.equal((await handler({ method: "POST", url: "/api/v1/dashboard/export.json", headers: {} })).status, 405);
  assert.deepEqual(calls, ["owner", "owner", "owner"]);
});

const project = {
  id: "p1", repository: "owner/repo", configVersion: null, configuration: null,
  requests: [{ id: "r1", mode: "dev", state: "running", attemptCount: null, pullRequests: [], remoteResult: "unknown", observedAt: null }],
  health: "unknown", usage: null, observedAt: null,
};
const auth = {
  authorizeRead: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: { "cache-control": "no-store" } }),
};

test("dashboard uses owner-scoped read model and discloses unknown/stale observations", async () => {
  const calls = [];
  const boundary = createOperationalDashboardBoundary({ list: async (ownerId) => { calls.push(ownerId); return [project]; } }, auth);
  const response = await boundary.read({ headers: {} });
  assert.deepEqual(calls, ["owner"]);
  assert.equal(response.status, 200);
  assert.equal(response.body.projects[0].requests[0].remoteResult, "unknown");
  assert.equal(response.body.projects[0].observedAt, null);
  assert.equal("stop" in boundary, false);
  assert.equal("mutate" in boundary, false);
});

test("unauthorized read is denied and exports redact and bound output", async () => {
  const denied = createOperationalDashboardBoundary({ list: async () => { throw new Error("must not read"); } }, {
    authorizeRead: async () => ({ authorized: false, response: { status: 401, body: { error: "unauthenticated" } } }),
  });
  assert.equal((await denied.read({ headers: {} })).status, 401);

  const model = { list: async () => [{ ...project, configuration: { accessToken: "secret", display: "<script>" } }] };
  const boundary = createOperationalDashboardBoundary(model, auth);
  const exported = await boundary.export({ headers: {} }, "json");
  assert.equal(exported.status, 200);
  assert.match(exported.body, /persisted operational read model/);
  assert.match(exported.body, /\[redacted\]/);
  assert.doesNotMatch(exported.body, /"secret"/);
  const text = await boundary.export({ headers: {} }, "text");
  assert.equal(text.status, 200);
  assert.doesNotMatch(text.body, /secret|accessToken|<script>/i);
});

test("dashboard bounds exported fields and total bytes while retaining provenance", async () => {
  const large = Array.from({ length: 50 }, (_, index) => ({ ...project, id: `p${index}`,
    requests: Array.from({ length: 50 }, (_, requestIndex) => ({
      ...project.requests[0], id: `r${requestIndex}`, mode: "x".repeat(2048),
    })),
  }));
  const boundary = createOperationalDashboardBoundary({ list: async () => large }, auth);
  const tooLarge = await boundary.export({ headers: {} }, "json");
  assert.equal(tooLarge.status, 413);
  const tooLargeText = await boundary.export({ headers: {} }, "text");
  assert.equal(tooLargeText.status, 413);
  const bounded = createOperationalDashboardBoundary({ list: async () => [
    { ...project, requests: [{ ...project.requests[0], mode: "x".repeat(5000) }] },
  ] }, auth);
  const response = await bounded.export({ headers: {} }, "json");
  assert.equal(response.status, 200);
  const value = JSON.parse(response.body);
  assert.equal(value.provenance.source, "persisted operational read model");
  assert.ok(value.projects[0].requests[0].mode.length <= 1024);
});

test("API preserves persisted usage field statuses through dashboard and JSON export", async () => {
  const usage = { modelRequestCount: 1, allocationLimits: null, allocationState: "unknown", coverage: "unknown", modelRequests: [{
    id: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222", state: "completed",
    ledger: { tokenCounts: { input: 120, output: null }, fieldStatuses: { input: "reported", output: "unknown" }, estimatedCharge: null, providerReportedCharge: null, currency: null }, observations: [],
  }] };
  const boundary = createOperationalDashboardBoundary({ list: async () => [{ ...project, usage }] }, auth);
  const response = await boundary.read({ headers: {} });
  assert.equal(response.body.projects[0].usage.modelRequests[0].ledger.tokenCounts.input, 120);
  assert.equal(response.body.projects[0].usage.modelRequests[0].ledger.tokenCounts.output, null);
  assert.equal(response.body.projects[0].usage.modelRequests[0].ledger.fieldStatuses.output, "unknown");
  assert.equal(response.body.projects[0].usage.modelRequests[0].ledger.tokenCounts.prompt_tokens, undefined);
  const exported = await boundary.export({ headers: {} }, "json");
  assert.equal(JSON.parse(exported.body).projects[0].usage.modelRequests[0].ledger.estimatedCharge, null);
});

test("text export renders safe persisted usage provenance and explicit unknowns without hostile content", async () => {
  const usage = { modelRequestCount: 1, modelRequestsTruncated: false, allocationLimits: null, allocationState: "unknown", coverage: "unknown", modelRequests: [{
    id: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222", state: "completed",
    dispatchedAt: "2026-10-23T00:00:00.000Z",
    ledger: { reserved: "0.00000000", tokenCounts: { input: 120, output: null, prompt_tokens: 1 }, fieldStatuses: { input: "reported", output: "unknown" }, estimatedCharge: null, providerReportedCharge: "0.00420000", currency: "USD", reconciliationState: "partial", updatedAt: "2026-10-23T00:00:01.000Z", password: "credential-secret" },
    observations: [{ source: "provider", revision: 2, numericUsage: { input: 120, output: null, prompt: 1 }, mappingVersion: "v1", coverage: "partial", observedAt: "2026-10-23T00:00:01.000Z", prompt: "hostile private source" }],
  }] };
  const boundary = createOperationalDashboardBoundary({ list: async () => [{ ...project, usage, configuration: { repository: "safe/repo", prompt: "PRIVATE REPOSITORY TEXT" } }] }, auth);
  const response = await boundary.export({ headers: {} }, "text");
  assert.equal(response.status, 200);
  assert.match(response.body, /Model request/);
  assert.match(response.body, /input=120/);
  assert.match(response.body, /output=unknown/);
  assert.match(response.body, /provider-reported charge: 0\.00420000/);
  assert.match(response.body, /currency: USD/);
  assert.match(response.body, /coverage=partial/);
  assert.match(response.body, /Allocation limits: unknown/);
  assert.doesNotMatch(response.body, /hostile private source|PRIVATE REPOSITORY TEXT|credential-secret|prompt_tokens|prompt:/i);
});

test("authenticated dashboard and both reports include canonical stable PR links only for valid repository identity", async () => {
  const safeProject = { ...project, repository: "Acme-Team/docs.v2",
    requests: [{ ...project.requests[0], pullRequests: [{ number: 41, state: "open", observedAt: null }] }],
    pullRequests: [{ number: 42, state: "open", observedAt: "2026-10-23T00:00:00.000Z" }] };
  const boundary = createOperationalDashboardBoundary({ list: async () => [safeProject] }, auth);
  const expected = "https://github.com/Acme-Team/docs.v2/pull/42";
  const dashboard = await boundary.read({ headers: {} });
  assert.equal(dashboard.body.projects[0].pullRequests[0].url, expected);
  assert.equal(dashboard.body.projects[0].requests[0].pullRequests[0].url, "https://github.com/Acme-Team/docs.v2/pull/41");
  const json = await boundary.export({ headers: {} }, "json");
  assert.equal(JSON.parse(json.body).projects[0].pullRequests[0].url, expected);
  const text = await boundary.export({ headers: {} }, "text");
  assert.match(text.body, new RegExp(expected.replaceAll(".", "\\.")));
  assert.match(text.body, /https:\/\/github\.com\/Acme-Team\/docs\.v2\/pull\/41/);

  const hostile = await createOperationalDashboardBoundary({ list: async () => [{
    ...safeProject, repository: "javascript:alert(1)/repo", pullRequests: [{ number: 42, state: "open", observedAt: null }],
  }] }, auth).read({ headers: {} });
  assert.equal("url" in hostile.body.projects[0].pullRequests[0], false);
});

test("dashboard and reports disclose omitted counts for every bounded collection", async () => {
  const observations = Array.from({ length: 101 }, (_, index) => ({ source: "fixture", revision: index + 1, numericUsage: { input: 1 }, coverage: "reported" }));
  const modelRequests = Array.from({ length: 101 }, (_, index) => ({
    id: `model-${index}`, observations: index === 0 ? observations : [], ledger: null,
  }));
  const attempts = Array.from({ length: 51 }, (_, index) => ({ ordinal: index + 1, state: "failed", observedAt: null }));
  const pullRequests = Array.from({ length: 51 }, (_, index) => ({ number: index + 1, state: "open", observedAt: null }));
  const requests = Array.from({ length: 51 }, (_, index) => ({
    ...project.requests[0], id: `request-${index}`, attempts: index === 0 ? attempts : [], pullRequests: index === 0 ? pullRequests : [],
  }));
  const projects = Array.from({ length: 51 }, (_, index) => ({ ...project, id: `project-${index}`,
    requests: index === 0 ? requests : [], pullRequests: index === 0 ? pullRequests : [],
    usage: index === 0 ? { modelRequestCount: 101, modelRequestsTruncated: false, modelRequests } : null,
  }));
  const boundary = createOperationalDashboardBoundary({ list: async () => projects }, auth);
  const dashboard = await boundary.read({ headers: {} });
  assert.equal(dashboard.body.truncation?.projectsOmitted, 1);
  assert.equal(dashboard.body.projects[0].truncation?.requestsOmitted, 1);
  assert.equal(dashboard.body.projects[0].truncation?.pullRequestsOmitted, 1);
  assert.equal(dashboard.body.projects[0].requests[0].truncation?.attemptsOmitted, 1);
  assert.equal(dashboard.body.projects[0].requests[0].truncation?.pullRequestsOmitted, 1);
  assert.equal(dashboard.body.projects[0].usage.modelRequestsTruncated, true);
  assert.equal(dashboard.body.projects[0].usage.modelRequests[0].observationsTruncated, true);

  const json = await boundary.export({ headers: {} }, "json");
  const jsonReport = JSON.parse(json.body);
  assert.equal(jsonReport.truncation.projectsOmitted, 1);
  assert.equal(jsonReport.projects[0].requests[0].truncation.attemptsOmitted, 1);
  const text = await boundary.export({ headers: {} }, "text");
  assert.match(text.body, /omitted 1 authorized project/i);
  assert.match(text.body, /omitted 1 request/i);
  assert.match(text.body, /omitted 1 attempt/i);
  assert.match(text.body, /omitted 1 usage observation/i);
});
