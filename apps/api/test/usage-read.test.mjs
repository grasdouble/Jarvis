import { Buffer } from "node:buffer";
import { URLSearchParams } from "node:url";
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

test("authenticated HTTP request pages preserve cursor order without omissions or duplicates", async () => {
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
  ];
  const cursor = Buffer.from(JSON.stringify({
    at: "2026-10-25T12:00:00.000Z", id: ids[1],
  })).toString("base64url");
  const calls = [];
  const auth = { authorizeRead: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }) };
  const model = {
    summary: async () => { throw new Error("request route called summary"); },
    requests: async (ownerId, filter) => {
      calls.push({ ownerId, filter });
      return filter.cursor === undefined
        ? { records: ids.slice(0, 2).map((id) => ({ id })), truncated: true, nextCursor: cursor }
        : { records: ids.slice(2).map((id) => ({ id })), truncated: false, nextCursor: null };
    },
  };
  const usage = createUsageReadBoundary(model, auth);
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
    const base = `http://127.0.0.1:${address.port}/api/v1/usage/requests`;
    const firstResponse = await globalThis.fetch(`${base}?${period}&limit=2`);
    assert.equal(firstResponse.status, 200);
    const firstPage = await firstResponse.json();
    assert.deepEqual(firstPage.records.map(({ id }) => id), ids.slice(0, 2));
    assert.equal(firstPage.truncated, true);
    assert.equal(firstPage.nextCursor, cursor);

    const pageTwoQuery = new URLSearchParams(period);
    pageTwoQuery.set("limit", "2");
    pageTwoQuery.set("cursor", cursor);
    const secondResponse = await globalThis.fetch(`${base}?${pageTwoQuery}`);
    assert.equal(secondResponse.status, 200);
    const secondPage = await secondResponse.json();
    assert.deepEqual(secondPage.records.map(({ id }) => id), ids.slice(2));
    assert.equal(secondPage.truncated, false);
    assert.equal(secondPage.nextCursor, null);
    const receivedIds = [...firstPage.records, ...secondPage.records].map(({ id }) => id);
    assert.deepEqual(receivedIds, ids, "HTTP cursor pages contain every request exactly once");
    assert.deepEqual(calls.map(({ ownerId }) => ownerId), ["owner", "owner"]);
    assert.equal(calls[0].filter.limit, 2);
    assert.equal(calls[1].filter.cursor, cursor);
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
