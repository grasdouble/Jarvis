import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldTurn } from "node:timers/promises";
import * as worker from "../dist/index.js";
const readyRestoreGate = { activateAfterRestore: async () => undefined, waitUntilActivated: async () => undefined };

test("an active stop prevents dispatch after a task is admitted", async () => {
  const calls = [];
  let reads = 0;
  const executor = worker.createStopAwareExecutor({
    readStop: async () => ({ stopped: ++reads === 2, version: reads }),
    dispatch: async (capability) => calls.push(capability),
    revokeCapability: async () => undefined,
    stopSandbox: async () => "stopped",
    recordAcceptedEffectUnknown: async () => undefined,
  });

  const startedAt = performance.now();
  const result = await executor.execute({ taskId: "task-1", projectId: "p1", capability: "capability-1" });
  const preventionMs = performance.now() - startedAt;

  assert.deepEqual(calls, [], "a stop racing admission must block the final dispatch gate");
  assert.deepEqual(result, { kind: "stopped" });
  assert.ok(preventionMs <= 2_000, `fake durable read prevented dispatch in ${preventionMs.toFixed(2)} ms (test abstraction)`);
});

test("durable stop persisted during a long dispatch is observed without a manual stop call", async () => {
  let stopped = false;
  let dispatchedSignal;
  const events = [];
  const executor = worker.createStopAwareExecutor({
    readStop: async () => ({ stopped, version: stopped ? 2 : 1 }),
    dispatch: async (_capability, signal) => {
      dispatchedSignal = signal;
      return new Promise(() => {});
    },
    revokeCapability: async () => events.push("revoked"),
    stopSandbox: async () => { events.push("sandbox-cancelled"); return "stopped"; },
    recordAcceptedEffectUnknown: async () => events.push("unknown"),
  }, { pollIntervalMs: 50 });
  const execution = executor.execute({ taskId: "persisted-stop", projectId: "p1", capability: "cap" });
  while (!dispatchedSignal) await yieldTurn();
  const start = performance.now();
  stopped = true;
  let timeout;
  let result;
  try {
    result = await Promise.race([
      execution,
      new Promise((_, reject) => { timeout = globalThis.setTimeout(() => reject(new Error("durable stop was not observed within 2 seconds")), 2_000); }),
    ]);
  } finally { globalThis.clearTimeout(timeout); }
  const elapsed = performance.now() - start;
  assert.deepEqual(result, { kind: "stop_unknown" });
  assert.ok(elapsed <= 2_000, `durable stop observed in ${elapsed.toFixed(2)} ms`);
  assert.deepEqual(events, ["unknown", "revoked", "sandbox-cancelled"]);
});

test("unresponsive sandbox-manager returns unknown at its bounded test timeout", async () => {
  const executor = worker.createStopAwareExecutor({
    readStop: async () => ({ stopped: false, version: 1 }), dispatch: async () => new Promise(() => {}),
    revokeCapability: async () => undefined, stopSandbox: async () => new Promise(() => {}),
    recordAcceptedEffectUnknown: async () => undefined,
  }, { shutdownTimeoutMs: 20 });
  void executor.execute({ taskId: "task-3", projectId: "p1", capability: "c" });
  while (executor.activeTaskIds().length === 0) await yieldTurn();
  const start = performance.now();
  await executor.stop();
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 15 && elapsed < 500, `20 ms bounded mock stop elapsed ${elapsed.toFixed(2)} ms`);
});

test("active stop revokes the capability, aborts dispatch and terminates the sandbox", async () => {
  const events = [];
  let finish;
  const executor = worker.createStopAwareExecutor({
    readStop: async () => ({ stopped: false, version: 1 }),
    dispatch: async (_capability, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { events.push("aborted"); finish = resolve; }, { once: true });
    }),
    revokeCapability: async (task) => { events.push(`revoked:${task}`); },
    stopSandbox: async (task, timeout) => { events.push(`sandbox:${task}:${timeout}`); return "stopped"; },
    recordAcceptedEffectUnknown: async (task) => { events.push(`unknown:${task}`); },
  });
  const execution = executor.execute({ taskId: "task-2", projectId: "p1", capability: "secret-capability" });
  while (executor.activeTaskIds().length === 0) await yieldTurn();
  const startedAt = performance.now();
  await executor.stop("p1");
  const shutdownMs = performance.now() - startedAt;
  assert.ok(shutdownMs <= 10_000, `responsive fake sandbox stop took ${shutdownMs.toFixed(2)} ms`);
  finish?.("late-response");
  assert.deepEqual(await execution, { kind: "stop_unknown" });
  assert.deepEqual(events, ["aborted", "unknown:task-2", "revoked:task-2", "sandbox:task-2:10000"]);
});

test("project stop leaves other projects running", async () => {
  const stopped = [];
  const executor = worker.createStopAwareExecutor({
    readStop: async () => ({ stopped: false, version: 1 }), dispatch: async () => new Promise(() => {}),
    revokeCapability: async (task) => stopped.push(task), stopSandbox: async () => "stopped",
    recordAcceptedEffectUnknown: async () => undefined,
  }, { shutdownTimeoutMs: 5 });
  void executor.execute({ taskId: "one", projectId: "p1", capability: "c1" });
  void executor.execute({ taskId: "two", projectId: "p2", capability: "c2" });
  while (executor.activeTaskIds().length < 2) await yieldTurn();
  await executor.stop("p1");
  assert.deepEqual(stopped, ["one"]);
  assert.deepEqual(executor.activeTaskIds(), ["one", "two"]);
  await executor.stop("p2");
});

test("queue lifecycle claims, executes and completes through the lease service", async () => {
  const events = [];
  const lease = { task: { id: "q1", taskId: "t1" }, worker: "w", epoch: 1, expiresAt: Date.now() + 1000 };
  const queue = {
    claim: async () => { events.push("claim"); return lease; },
    complete: async (_lease, result) => { events.push(`complete:${result.id}`); },
    fail: async () => { throw new Error("unexpected fail"); },
    cancel: async (id) => { events.push(`cancel:${id}`); },
  };
  const runtime = worker.createQueueWorker({
    queue, workerId: "w", leaseMs: 1000, restoreGate: readyRestoreGate,
    hydrate: async () => ({ taskId: "t1", projectId: "p1", capability: "cap" }),
    execution: {
      readStop: async () => ({ stopped: false, version: 1 }),
      dispatch: async () => { events.push("dispatch"); return { kind: "report", id: "00000000-0000-4000-8000-000000000001" }; },
      revokeCapability: async () => undefined, stopSandbox: async () => "stopped",
      recordAcceptedEffectUnknown: async () => undefined,
    },
  });
  assert.equal(await runtime.runOnce(), "completed");
  assert.deepEqual(events, ["claim", "dispatch", "complete:00000000-0000-4000-8000-000000000001"]);
});

test("stop racing a claimed active dispatch fails the lease as unknown, never cancels a possible effect", async () => {
  let stopped = false;
  let dispatchStarted;
  const started = new Promise((resolve) => { dispatchStarted = resolve; });
  const events = [];
  const lease = { task: { id: "q-stop", taskId: "t-stop" }, worker: "w", epoch: 1, expiresAt: Date.now() + 1000 };
  const runtime = worker.createQueueWorker({
    queue: {
      claim: async () => lease,
      complete: async () => events.push("complete"),
      fail: async (_lease, failure) => events.push(`fail:${failure.kind}`),
      cancel: async () => events.push("cancel"),
    },
    workerId: "w", leaseMs: 1000, restoreGate: readyRestoreGate,
    hydrate: async () => ({ taskId: "t-stop", projectId: "p1", capability: "cap" }),
    execution: {
      readStop: async () => ({ stopped, version: stopped ? 2 : 1 }),
      dispatch: async () => { dispatchStarted(); return new Promise(() => {}); },
      revokeCapability: async () => events.push("revoke"),
      stopSandbox: async () => { events.push("sandbox"); return "stopped"; },
      recordAcceptedEffectUnknown: async () => events.push("unknown"),
    },
  });
  const run = runtime.runOnce();
  await started;
  stopped = true;
  const outcome = await run;
  assert.equal(outcome, "unknown");
  assert.deepEqual(events, ["unknown", "revoke", "sandbox", "fail:unknown_external"]);
  assert.equal(events.includes("cancel"), false);
});

test("stop-state read failure during active dispatch fails closed and reconciles as unknown", async () => {
  let reads = 0;
  const executor = worker.createStopAwareExecutor({
    readStop: async () => { if (++reads > 2) throw new Error("database unavailable"); return { stopped: false, version: 1 }; },
    dispatch: async () => new Promise(() => {}),
    revokeCapability: async () => undefined,
    stopSandbox: async () => "unknown",
    recordAcceptedEffectUnknown: async () => undefined,
  }, { pollIntervalMs: 10 });
  assert.deepEqual(await executor.execute({ taskId: "read-failure", projectId: "p1", capability: "cap" }), { kind: "stop_unknown" });
});

test("queue worker stop waits for runOnce to release its lease as reconciliation-required", async () => {
  let dispatchStarted;
  const started = new Promise((resolve) => { dispatchStarted = resolve; });
  const events = [];
  const runtime = worker.createQueueWorker({
    queue: {
      claim: async () => ({ task: { id: "q-direct-stop", taskId: "t-direct-stop" }, worker: "w", epoch: 1, expiresAt: Date.now() + 1000 }),
      complete: async () => events.push("complete"),
      fail: async (_lease, failure) => events.push(`failed:${failure.kind}`),
      cancel: async () => events.push("cancelled"),
    },
    workerId: "w", leaseMs: 1000, restoreGate: readyRestoreGate,
    hydrate: async () => ({ taskId: "t-direct-stop", projectId: "p1", capability: "cap" }),
    execution: {
      readStop: async () => ({ stopped: false, version: 1 }),
      dispatch: async () => { dispatchStarted(); return new Promise(() => {}); },
      revokeCapability: async () => events.push("revoked"),
      stopSandbox: async () => "stopped",
      recordAcceptedEffectUnknown: async () => events.push("unknown"),
    },
  });
  const run = runtime.runOnce();
  await started;
  await runtime.stop("p1");
  assert.equal(await run, "unknown");
  assert.deepEqual(events, ["unknown", "revoked", "failed:unknown_external"]);
});

test("queue worker does not claim or dispatch before restore activation is complete", async () => {
  let commitRestore;
  const restoreCommit = new Promise((resolve) => { commitRestore = resolve; });
  const events = [];
  const restoreGate = worker.createRestoreActivationGate(async () => {
    events.push("suspend-start");
    await restoreCommit;
    events.push("suspend-committed");
  });
  const runtime = worker.createQueueWorker({
    queue: {
      claim: async () => { events.push("claim"); return null; },
      complete: async () => undefined, fail: async () => undefined, cancel: async () => undefined,
    },
    workerId: "restore-worker", leaseMs: 1000,
    hydrate: async () => { throw new Error("no task expected"); },
    execution: {
      readStop: async () => ({ stopped: false, version: 2 }), dispatch: async () => undefined,
      revokeCapability: async () => undefined, stopSandbox: async () => "stopped",
      recordAcceptedEffectUnknown: async () => undefined,
    },
    restoreGate,
  });

  const run = runtime.runOnce();
  await yieldTurn();
  assert.deepEqual(events, [], "restored workers must remain inert until durable suspension commits");
  const activation = restoreGate.activateAfterRestore();
  await yieldTurn();
  assert.deepEqual(events, ["suspend-start"], "claim must wait for the restore suspension transaction");
  commitRestore();
  await activation;
  assert.equal(await run, "idle");
  assert.deepEqual(events, ["suspend-start", "suspend-committed", "claim"]);
});

test("failed restore suspension leaves the worker unable to claim", async () => {
  let claims = 0;
  const gate = worker.createRestoreActivationGate(async () => { throw new Error("restore audit transaction failed"); });
  const runtime = worker.createQueueWorker({
    queue: {
      claim: async () => { claims += 1; return null; },
      complete: async () => undefined, fail: async () => undefined, cancel: async () => undefined,
    },
    workerId: "failed-restore-worker", leaseMs: 1000, restoreGate: gate,
    hydrate: async () => { throw new Error("no task expected"); },
    execution: {
      readStop: async () => ({ stopped: false, version: 1 }), dispatch: async () => undefined,
      revokeCapability: async () => undefined, stopSandbox: async () => "stopped",
      recordAcceptedEffectUnknown: async () => undefined,
    },
  });
  const run = runtime.runOnce();
  await assert.rejects(gate.activateAfterRestore(), /restore audit transaction failed/);
  await assert.rejects(run, /restore audit transaction failed/);
  assert.equal(claims, 0);
});
