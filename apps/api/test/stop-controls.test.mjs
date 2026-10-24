import test from "node:test";
import assert from "node:assert/strict";
import { createStopControlHttpHandler } from "../dist/stop-controls.js";
import { createOperationalDashboardServer } from "../dist/http-server.js";
import { once } from "node:events";

test("stop mutation uses authenticated owner, requires closed versioned body, and maps stale version to 409", async () => {
  const writes = [];
  const auth = {
    authorizeRead: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }),
    authorizeMutation: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }),
  };
  const store = {
    get: async () => ({ global: { stopped: true, version: 2, changedBy: "owner", changedAt: new Date(0) }, project: null }),
    set: async (value) => { writes.push(value); throw Object.assign(new Error("stale"), { code: "STOP_VERSION_CONFLICT" }); },
  };
  const handler = createStopControlHttpHandler(store, auth);
  const invalid = await handler({ method: "POST", headers: {}, body: { stopped: false, expectedVersion: 2, ownerId: "attacker" } });
  assert.equal(invalid.status, 422);
  assert.equal(writes.length, 0);
  const conflict = await handler({ method: "POST", headers: {}, body: { stopped: false, expectedVersion: 1 } });
  assert.equal(conflict.status, 409);
  assert.deepEqual(writes, [{ stopped: false, expectedVersion: 1, ownerId: "owner" }]);
});

test("a rejected best-effort notification does not turn a committed stop mutation into an API error", async () => {
  const state = { stopped: false, version: 4, changedBy: "owner", changedAt: new Date(0) };
  const auth = {
    authorizeRead: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }),
    authorizeMutation: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }),
  };
  const store = {
    get: async () => ({ global: { ...state }, project: null }),
    set: async ({ stopped, expectedVersion, ownerId }) => {
      assert.equal(expectedVersion, state.version);
      state.stopped = stopped;
      state.version += 1;
      state.changedBy = ownerId;
    },
  };
  const handler = createStopControlHttpHandler(store, auth, { notify: async () => { throw new Error("local wakeup unavailable"); } });

  const response = await handler({ method: "POST", headers: {}, body: { stopped: true, expectedVersion: 4 } });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { global: { stopped: true, version: 5, changedBy: "owner", changedAt: new Date(0) }, project: null });
});

test("real HTTP route protects stop mutation with auth and Origin/CSRF and applies expected version", async (context) => {
  const writes = [];
  const notifications = [];
  const store = {
    get: async () => ({ global: { stopped: true, version: writes.length + 1, changedBy: "owner", changedAt: new Date(0) }, project: null }),
    set: async (value) => { writes.push(value); },
  };
  const auth = {
    authorizeRead: async (request) => request.headers.cookie === "session=ok"
      ? { authorized: true, auth: { ownerId: "owner" }, headers: {} }
      : { authorized: false, response: { status: 401, body: { error: "unauthenticated" } } },
    authorizeMutation: async (request) => {
      if (request.headers.cookie !== "session=ok") return { authorized: false, response: { status: 401, body: { error: "unauthenticated" } } };
      if (request.headers.origin !== "http://127.0.0.1") return { authorized: false, response: { status: 403, body: { error: "origin_denied" } } };
      if (request.headers["x-csrf-token"] !== "csrf-ok") return { authorized: false, response: { status: 403, body: { error: "csrf_denied" } } };
      return { authorized: true, auth: { ownerId: "owner" }, headers: {} };
    },
    getSession: async () => ({ status: 404 }), login: async () => ({ status: 404 }), onboard: async () => ({ status: 404 }), logout: async () => ({ status: 404 }),
  };
  const stopControls = createStopControlHttpHandler(store, auth, { notify: async (event) => notifications.push(event) });
  const server = createOperationalDashboardServer({ dashboard: async () => ({ status: 404 }), auth, stopControls });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/api/v1/stop`;
  const body = JSON.stringify({ stopped: true, expectedVersion: 3 });
  const denied = await globalThis.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(denied.status, 401);
  const csrfDenied = await globalThis.fetch(url, { method: "POST", headers: { cookie: "session=ok", origin: "http://127.0.0.1", "content-type": "application/json" }, body });
  assert.equal(csrfDenied.status, 403);
  const originDenied = await globalThis.fetch(url, { method: "POST", headers: { cookie: "session=ok", origin: "https://attacker.invalid", "x-csrf-token": "csrf-ok", "content-type": "application/json" }, body });
  assert.equal(originDenied.status, 403);
  assert.deepEqual(writes, []);
  const authorized = await globalThis.fetch(url, { method: "POST", headers: { cookie: "session=ok", origin: "http://127.0.0.1", "x-csrf-token": "csrf-ok", "content-type": "application/json" }, body });
  assert.equal(authorized.status, 200);
  assert.deepEqual(writes, [{ stopped: true, expectedVersion: 3, ownerId: "owner" }]);
  assert.deepEqual(notifications, [{ stopped: true }]);
});
