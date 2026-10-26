import test from "node:test";
import assert from "node:assert/strict";
import { createOperationalStopControlHandler, createStopControlHttpHandler } from "../dist/stop-controls.js";
import { createOperationalDashboardServer } from "../dist/http-server.js";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import * as worker from "../../worker/dist/index.js";
import { createRuntimeComposition } from "../dist/runtime-composition.js";

test("runtime composition wires persisted stop state to authenticated API and worker cancellation", async () => {
  const store = { get: async () => ({ global: { stopped: true, version: 2 }, project: null }), set: async () => undefined };
  const auth = { authorizeRead: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }), authorizeMutation: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }) };
  const stopped = [];
  const composition = createRuntimeComposition({ store, auth, worker: { stop: async (projectId) => stopped.push(projectId) }, dashboard: async () => ({ status: 404 }) });
  const response = await composition.stopControls({ method: "POST", headers: {}, body: { stopped: true, expectedVersion: 1 } });
  assert.equal(response.status, 200);
  assert.deepEqual(stopped, [undefined]);
});

test("injected stop composition stops matching tasks, leaves fresh work on resume, and preserves uncertain effects", async (context) => {
  const state = { global: { stopped: false, version: 1, changedBy: "owner", changedAt: new Date(0) }, project: null };
  const store = {
    get: async ({ projectId } = {}) => ({ ...state, project: projectId && state.project?.projectId === projectId ? state.project.record : null }),
    set: async ({ projectId, stopped, expectedVersion, ownerId }) => {
      const record = projectId ? state.project?.record ?? { stopped: false, version: 0, changedBy: ownerId, changedAt: new Date(0) } : state.global;
      assert.equal(record.version, expectedVersion);
      record.stopped = stopped;
      record.version += 1;
      if (projectId) state.project = { projectId, record };
      else state.global = record;
    },
  };
  const started = [];
  const sandboxStops = [];
  const executions = [];
  const executor = worker.createStopAwareExecutor({
    readStop: worker.createPersistedStopReader(store),
    dispatch: async (_capability, signal) => new Promise((resolve) => { started.push(resolve); signal.addEventListener("abort", () => {}, { once: true }); }),
    revokeCapability: async () => undefined,
    stopSandbox: async (taskId, timeoutMs) => { sandboxStops.push({ taskId, timeoutMs }); return "stopped"; },
    recordAcceptedEffectUnknown: async () => undefined,
  }, { pollIntervalMs: 10, shutdownTimeoutMs: 100 });
  const execute = (taskId, projectId) => {
    const execution = executor.execute({ taskId, projectId, capability: `cap-${taskId}` });
    executions.push(execution);
    return execution;
  };
  context.after(async () => { await executor.stop(); await Promise.allSettled(executions); });
  const auth = { authorizeRead: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }), authorizeMutation: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }) };
  const control = createOperationalStopControlHandler(store, auth, executor);
  const one = execute("task-one", "project-one");
  const two = execute("task-two", "project-two");
  while (started.length < 2) await delay(0);
  state.project = { projectId: "project-one", record: { stopped: false, version: 0, changedBy: "owner", changedAt: new Date(0) } };
  const stopStartedAt = performance.now();
  const response = await control({ method: "POST", projectId: "project-one", headers: {}, body: { stopped: true, expectedVersion: 0 } });
  assert.equal(response.status, 200);
  assert.deepEqual(await one, { kind: "stop_unknown" });
  const blockNewCallsMs = performance.now() - stopStartedAt;
  context.diagnostic(`in-process composition blocked calls/cancelled the active task in ${blockNewCallsMs.toFixed(2)} ms (mock persistence, dispatch, capability revocation and sandbox cancellation)`);
  assert.ok(blockNewCallsMs < 2_000, `local injected runtime blocked calls in ${blockNewCallsMs.toFixed(2)} ms`);
  assert.deepEqual(executor.activeTaskIds(), ["task-two"]);
  assert.deepEqual(sandboxStops, [{ taskId: "task-one", timeoutMs: 100 }]);
  assert.equal((await control({ method: "POST", projectId: "project-one", headers: {}, body: { stopped: false, expectedVersion: 1 } })).status, 200);
  const fresh = execute("task-fresh-after-resume", "project-one");
  while (started.length < 3) await delay(0);
  assert.equal((await control({ method: "POST", projectId: "project-one", headers: {}, body: { stopped: false, expectedVersion: 2 } })).status, 200);
  assert.deepEqual(executor.activeTaskIds(), ["task-two", "task-fresh-after-resume"], "resume must not stop fresh active work");
  assert.deepEqual(sandboxStops, [{ taskId: "task-one", timeoutMs: 100 }], "resume must not request sandbox cancellation");
  assert.equal((await control({ method: "POST", projectId: "project-one", headers: {}, body: { stopped: true, expectedVersion: 3 } })).status, 200, "a stop mutation still cancels matching active work");
  assert.deepEqual(await fresh, { kind: "stop_unknown" });
  assert.deepEqual(sandboxStops, [{ taskId: "task-one", timeoutMs: 100 }, { taskId: "task-fresh-after-resume", timeoutMs: 100 }]);
  await executor.stop("project-two");
  await two;
});

test("injected composition applies persisted global stop across projects and gates subsequent dispatch", async (context) => {
  const state = { global: { stopped: false, version: 1, changedBy: "owner", changedAt: new Date(0) }, projects: new Map() };
  const store = {
    get: async ({ projectId } = {}) => ({
      global: state.global,
      project: projectId ? state.projects.get(projectId) ?? null : null,
    }),
    set: async ({ projectId, stopped, expectedVersion, ownerId }) => {
      const previous = projectId
        ? state.projects.get(projectId) ?? { stopped: false, version: 0, changedBy: ownerId, changedAt: new Date(0) }
        : state.global;
      assert.equal(previous.version, expectedVersion);
      const updated = { ...previous, stopped, version: previous.version + 1, changedBy: ownerId };
      if (projectId) state.projects.set(projectId, updated);
      else state.global = updated;
    },
  };
  const dispatches = [];
  const sandboxStops = [];
  const unknownEffects = [];
  const executor = worker.createStopAwareExecutor({
    readStop: worker.createPersistedStopReader(store),
    dispatch: async (capability, signal) => {
      dispatches.push(capability);
      return new Promise(() => signal.addEventListener("abort", () => {}, { once: true }));
    },
    revokeCapability: async () => undefined,
    stopSandbox: async (taskId, timeoutMs) => { sandboxStops.push({ taskId, timeoutMs }); return "stopped"; },
    recordAcceptedEffectUnknown: async (taskId) => { unknownEffects.push(taskId); },
  }, { pollIntervalMs: 10, shutdownTimeoutMs: 100 });
  const executions = [];
  context.after(async () => { await executor.stop(); await Promise.allSettled(executions); });
  const execute = (taskId, projectId) => {
    const run = executor.execute({ taskId, projectId, capability: `cap-${taskId}` });
    executions.push(run);
    return run;
  };
  const auth = { authorizeRead: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }), authorizeMutation: async () => ({ authorized: true, auth: { ownerId: "owner" }, headers: {} }) };
  const control = createOperationalStopControlHandler(store, auth, executor);
  const projectOne = execute("global-task-one", "project-one");
  const projectTwo = execute("global-task-two", "project-two");
  while (dispatches.length < 2) await delay(0);

  const response = await control({ method: "POST", headers: {}, body: { stopped: true, expectedVersion: 1 } });
  assert.equal(response.status, 200);
  assert.deepEqual(await projectOne, { kind: "stop_unknown" });
  assert.deepEqual(await projectTwo, { kind: "stop_unknown" });
  assert.deepEqual(executor.activeTaskIds(), []);
  assert.deepEqual(sandboxStops.map(({ taskId }) => taskId).sort(), ["global-task-one", "global-task-two"]);
  assert.deepEqual(unknownEffects.sort(), ["global-task-one", "global-task-two"], "possible accepted remote effects remain unknown, not cancelled or erased");

  const gated = await execute("global-task-three", "project-three");
  assert.deepEqual(gated, { kind: "stopped" });
  assert.deepEqual(dispatches, ["cap-global-task-one", "cap-global-task-two"], "persisted global stop gates subsequent dispatch in every project");
  context.diagnostic("global-stop integration uses mock persistence, dispatch and sandbox cancellation; no live services or remote effects were exercised");
});

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
