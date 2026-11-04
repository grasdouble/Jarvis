import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createOperationalDashboardServer, createUsageReadBoundary } from "../dist/index.js";

const period = "start=2026-10-25&end=2026-10-26&timeZone=Europe%2FParis";

test("HTTP usage summary rejects unsupported query keys and pagination controls", async () => {
  let reads = 0;
  const auth = { authorizeRead: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }) };
  const usage = createUsageReadBoundary({
    summary: async () => { reads += 1; throw new Error("invalid summary reached persistence"); },
    requests: async () => { reads += 1; throw new Error("invalid summary reached persistence"); },
  }, auth);
  const server = createOperationalDashboardServer({
    auth,
    dashboard: async () => ({ status: 404, body: { error: "not_found" } }),
    usageSummary: (request) => usage.summary(request),
    usageRequests: (request) => usage.requests(request),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    for (const invalidParameter of ["limit=10", "cursor=eyJhdCI6IngifQ", "constructor=ignored", "toString=ignored", "__proto__=ignored"]) {
      const response = await globalThis.fetch(`http://127.0.0.1:${address.port}/api/v1/usage?${period}&${invalidParameter}`);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_usage_query" });
    }
    assert.equal(reads, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});


test("unauthorized HTTP usage reads are denied before either model method runs", async () => {
  let reads = 0;
  const auth = {
    authorizeRead: async () => ({
      authorized: false,
      response: { status: 401, body: { error: "unauthorized" }, headers: {} },
    }),
  };
  const usage = createUsageReadBoundary({
    summary: async () => { reads += 1; return {}; },
    requests: async () => { reads += 1; return {}; },
  }, auth);
  const server = createOperationalDashboardServer({
    auth,
    dashboard: async () => ({ status: 404, body: { error: "not_found" } }),
    usageSummary: (request) => usage.summary(request),
    usageRequests: (request) => usage.requests(request),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    for (const path of ["/api/v1/usage", "/api/v1/usage/requests"]) {
      const response = await globalThis.fetch(`http://127.0.0.1:${address.port}${path}?${period}`);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    }
    assert.equal(reads, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});
