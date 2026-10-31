import assert from "node:assert/strict";
import test from "node:test";
import { createTaskResultReadBoundary } from "../dist/index.js";
import { once } from "node:events";
import { createOperationalDashboardServer } from "../dist/index.js";

const result = { schemaVersion: 1, requestId: "11111111-1111-4111-8111-111111111111", taskId: "22222222-2222-4222-8222-222222222222", attemptId: "33333333-3333-4333-8333-333333333333", leaseEpoch: 1, mode: "dev", sourceRevision: "a".repeat(40), snapshotDigest: "b".repeat(64), provider: "openai", model: "gpt-4.1", resultId: "44444444-4444-4444-8444-444444444444", payload: { summary: "Synthetic", artifactId: "55555555-5555-4555-8555-555555555555", patchDigest: "c".repeat(64), changedPaths: [], limitations: [] } };

test("task result boundary authorizes owner before reading scoped canonical data", async () => {
  const reads = [];
  const boundary = createTaskResultReadBoundary({ getForOwner: async (ownerId, taskId) => { reads.push([ownerId, taskId]); return result; } }, {
    authorizeRead: async () => ({ authorized: true, auth: { ownerId: "owner-a" }, headers: { "cache-control": "no-store" } }),
  });
  const response = await boundary.get({}, result.taskId);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, result);
  assert.deepEqual(reads, [["owner-a", result.taskId]]);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("task result boundary never reads before authorization and hides missing cross-project results", async () => {
  let reads = 0;
  const denied = createTaskResultReadBoundary({ getForOwner: async () => { reads += 1; return result; } }, {
    authorizeRead: async () => ({ authorized: false, response: { status: 401, body: { error: "unauthorized" } } }),
  });
  assert.equal((await denied.get({}, result.taskId)).status, 401);
  assert.equal(reads, 0);
  const missing = createTaskResultReadBoundary({ getForOwner: async () => null }, {
    authorizeRead: async () => ({ authorized: true, auth: { ownerId: "other-owner" }, headers: {} }),
  });
  assert.equal((await missing.get({}, result.taskId)).status, 404);
});
test("HTTP server routes task result reads to the trusted boundary", async () => {
  const taskId = result.taskId;
  const server = createOperationalDashboardServer({
    dashboard: async () => ({ status: 404, body: { error: "dashboard_not_found" } }),
    auth: { authorizeRead: async () => ({ authorized: true, auth: { ownerId: "owner-a" }, headers: {} }) },
    taskResults: async (_request, id) => id === taskId ? { status: 200, body: result } : { status: 404, body: null },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await globalThis.fetch(`http://127.0.0.1:${address.port}/api/v1/tasks/${taskId}/result`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
  } finally {
    server.close();
    await once(server, "close");
  }
});
