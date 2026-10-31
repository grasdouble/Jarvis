import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldTurn } from "node:timers/promises";
import * as worker from "../dist/index.js";
const readyRestoreGate = { activateAfterRestore: async () => undefined, waitUntilActivated: async () => undefined };

test("OpenCode session flow uses only manager relay operations and bounded polling", async () => {
  const calls = [];
  const manager = { request: async (sandboxId, taskId, attemptId, leaseEpoch, request) => {
    calls.push([sandboxId, taskId, attemptId, leaseEpoch, request.operation]);
    if (request.operation === "session.create") return { id: "session_1" };
    if (request.operation === "messages") return { messages: [{ type: "assistant", content: [{ type: "text", text: "synthetic result" }] }] };
    return {};
  } };
  const result = await worker.runOpenCodeSession({
    manager, sandboxId: "00000000-0000-4000-8000-000000000001", taskId: "task-1", attemptId: "attempt-1", leaseEpoch: 4,
    title: "test",
    prompt: "synthetic prompt", signal: new globalThis.AbortController().signal, pollIntervalMs: 10, maxPolls: 2,
  });
  assert.equal(result.messages[0].content[0].text, "synthetic result");
  assert.deepEqual(calls, [
    ["00000000-0000-4000-8000-000000000001", "task-1", "attempt-1", 4, "session.create"],
    ["00000000-0000-4000-8000-000000000001", "task-1", "attempt-1", 4, "prompt"],
    ["00000000-0000-4000-8000-000000000001", "task-1", "attempt-1", 4, "messages"],
    ["00000000-0000-4000-8000-000000000001", "task-1", "attempt-1", 4, "status"],
  ]);
});

test("fixed relay manager port emits only the lease- and run-bound runtime API route", async () => {
  let captured;
  const port = worker.createFixedOpenCodeManagerPort(async (...args) => { captured = args; return { healthy: true }; });
  assert.deepEqual(await port.request("00000000-0000-4000-8000-000000000001", "task-1", "attempt-1", 3, { operation: "health" }), { healthy: true });
  assert.deepEqual(captured, [
    "/v1/sandboxes/00000000-0000-4000-8000-000000000001/runtime",
    { leaseEpoch: 3, taskId: "task-1", attemptId: "attempt-1", request: { operation: "health" } },
    undefined,
  ]);
  assert.throws(() => port.request("../../other", "task-1", "attempt-1", 3, { operation: "health" }), /identity/i);
});

test("OpenCode session failure requests cancellation through the manager relay", async () => {
  const operations = [];
  const manager = { request: async (_sandboxId, _taskId, _attemptId, _leaseEpoch, request) => {
    operations.push(request.operation);
    if (request.operation === "session.create") return { id: "session_2" };
    if (request.operation === "status") return { status: "idle" };
    if (request.operation === "messages") return { messages: [] };
    return {};
  } };
  await assert.rejects(() => worker.runOpenCodeSession({
    manager, sandboxId: "00000000-0000-4000-8000-000000000002", taskId: "task-2", attemptId: "attempt-2", leaseEpoch: 1,
    title: "test",
    prompt: "synthetic prompt", signal: new globalThis.AbortController().signal, pollIntervalMs: 10, maxPolls: 1,
  }), /without an assistant response/);
  assert.deepEqual(operations, ["session.create", "prompt", "messages", "status", "cancel"]);
});

test("unresponsive manager relay is bounded and triggers best-effort session cancellation", async () => {
  const operations = [];
  const manager = { request: async (_sandboxId, _taskId, _attemptId, _leaseEpoch, request) => {
    operations.push(request.operation);
    if (request.operation === "session.create") return { id: "session_3" };
    if (request.operation === "prompt") return new Promise(() => {});
    return {};
  } };
  await assert.rejects(() => worker.runOpenCodeSession({
    manager, sandboxId: "00000000-0000-4000-8000-000000000003", taskId: "task-3", attemptId: "attempt-3", leaseEpoch: 2,
    title: "test", prompt: "synthetic prompt",
    signal: new globalThis.AbortController().signal, requestTimeoutMs: 10,
  }), /timed out/);
  assert.deepEqual(operations, ["session.create", "prompt", "cancel"]);
});

test("aborted in-flight prompt uses a fresh signal for fixed-relay cleanup cancellation", async () => {
  const controller = new globalThis.AbortController();
  let promptSignal;
  let cancelSignal;
  let promptStarted;
  const started = new Promise((resolve) => { promptStarted = resolve; });
  const manager = { request: async (_sandboxId, _taskId, _attemptId, _epoch, request, signal) => {
    if (request.operation === "session.create") return { id: "session_abort" };
    if (request.operation === "prompt") {
      promptSignal = signal;
      promptStarted();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true }));
    }
    if (request.operation === "cancel") { cancelSignal = signal; return {}; }
    return {};
  } };
  const running = worker.runOpenCodeSession({
    manager, sandboxId: "00000000-0000-4000-8000-000000000004", taskId: "task-4", attemptId: "attempt-4", leaseEpoch: 2,
    title: "test", prompt: "synthetic prompt", signal: controller.signal, requestTimeoutMs: 100,
  });
  await started;
  controller.abort();
  await assert.rejects(running, /prompt aborted/);
  assert.equal(promptSignal.aborted, true);
  assert.ok(cancelSignal, "cleanup cancellation must be sent");
  assert.equal(cancelSignal.aborted, false, "cleanup must not inherit the caller's aborted signal");
});

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

test("stop during the initial admission read prevents later dispatch", async () => {
  let releaseAdmission;
  let admissionStarted;
  const admission = new Promise((resolve) => { releaseAdmission = resolve; });
  const started = new Promise((resolve) => { admissionStarted = resolve; });
  const events = [];
  const executor = worker.createStopAwareExecutor({
    readStop: async () => { admissionStarted(); return admission; },
    dispatch: async () => { events.push("dispatch"); return "unexpected"; },
    revokeCapability: async () => events.push("revoked"),
    stopSandbox: async () => { events.push("sandbox-stopped"); return "stopped"; },
    recordAcceptedEffectUnknown: async () => events.push("unknown"),
  });

  const execution = executor.execute({ taskId: "initial-admission-stop", projectId: "p1", capability: "cap" });
  await started;
  await executor.stop("p1");
  releaseAdmission({ stopped: false, version: 1 });

  assert.deepEqual(await execution, { kind: "stopped" });
  assert.deepEqual(events, ["revoked", "sandbox-stopped"], "no effect is uncertain until dispatch has actually started");
  assert.deepEqual(executor.activeTaskIds(), []);
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
  let dispatchStarted;
  const started = new Promise((resolve) => { dispatchStarted = resolve; });
  const executor = worker.createStopAwareExecutor({
    readStop: async () => ({ stopped: false, version: 1 }), dispatch: async () => { dispatchStarted(); return new Promise(() => {}); },
    revokeCapability: async () => undefined, stopSandbox: async () => new Promise(() => {}),
    recordAcceptedEffectUnknown: async () => undefined,
  }, { shutdownTimeoutMs: 20 });
  void executor.execute({ taskId: "task-3", projectId: "p1", capability: "c" });
  await started;
  const start = performance.now();
  await executor.stop();
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 15 && elapsed < 500, `20 ms bounded mock stop elapsed ${elapsed.toFixed(2)} ms`);
});

test("stop-aware OpenCode integration sends fixed manager cancel and records uncertain in-flight effects", async () => {
  const operations = [];
  const effects = [];
  let promptStarted;
  const started = new Promise((resolve) => { promptStarted = resolve; });
  const manager = worker.createFixedOpenCodeManagerPort(async (path, body, signal) => {
    const request = body.request;
    operations.push([path, request.operation]);
    if (request.operation === "session.create") return { id: "session_stop" };
    if (request.operation === "prompt") {
      promptStarted();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("relay aborted")), { once: true }));
    }
    return {};
  });
  const ports = worker.createStopAwareOpenCodePorts({
    readStop: async () => ({ stopped: false, version: 0 }),
    manager,
    revokeCapability: async (taskId) => effects.push(["revoke", taskId]),
    stopSandbox: async (taskId) => { effects.push(["stop", taskId]); return "stopped"; },
    recordAcceptedEffectUnknown: async (taskId) => effects.push(["unknown", taskId]),
    session: { requestTimeoutMs: 1000, pollIntervalMs: 10, maxPolls: 2 },
  });
  const executor = worker.createStopAwareExecutor(ports, { pollIntervalMs: 10, shutdownTimeoutMs: 1000 });
  const execution = executor.execute({
    taskId: "task-integrated", projectId: "project-integrated",
    capability: {
      sandboxId: "00000000-0000-4000-8000-000000000251", taskId: "task-integrated", attemptId: "attempt-integrated",
      leaseEpoch: 1, title: "synthetic", prompt: "synthetic prompt",
    },
  });
  await started;
  await executor.stop("project-integrated");
  assert.deepEqual(await execution, { kind: "stop_unknown" });
  assert.deepEqual(operations.map(([, operation]) => operation), ["session.create", "prompt", "cancel"]);
  assert.deepEqual(operations.map(([path]) => path), Array(3).fill("/v1/sandboxes/00000000-0000-4000-8000-000000000251/runtime"));
  assert.deepEqual(effects, [["unknown", "task-integrated"], ["revoke", "task-integrated"], ["stop", "task-integrated"]]);
});

test("composed stop gate denies the final manager/gateway relay dispatch after admission", async () => {
  let reads = 0;
  const routes = [];
  const manager = worker.createFixedOpenCodeManagerPort(async (path, body) => {
    routes.push([path, body.request.operation]);
    return {};
  });
  const ports = worker.createStopAwareOpenCodePorts({
    readStop: async () => ({ stopped: ++reads >= 2, version: reads }),
    manager,
    revokeCapability: async () => undefined,
    stopSandbox: async () => "stopped",
    recordAcceptedEffectUnknown: async () => undefined,
  });
  const executor = worker.createStopAwareExecutor(ports);
  const outcome = await executor.execute({
    taskId: "task-final-gate", projectId: "project-final-gate",
    capability: {
      sandboxId: "00000000-0000-4000-8000-000000000251", taskId: "task-final-gate", attemptId: "attempt-final-gate",
      leaseEpoch: 7, title: "synthetic", prompt: "must not dispatch",
    },
  });
  assert.deepEqual(outcome, { kind: "stopped" });
  assert.deepEqual(routes, [], "the fixed manager runtime route (and downstream gateway) is not invoked after final stop read");
});

test("active stop revokes the capability, aborts dispatch and terminates the sandbox", async () => {
  const events = [];
  let finish;
  let dispatchStarted;
  const started = new Promise((resolve) => { dispatchStarted = resolve; });
  const executor = worker.createStopAwareExecutor({
    readStop: async () => ({ stopped: false, version: 1 }),
    dispatch: async (_capability, signal) => { dispatchStarted(); return new Promise((resolve) => {
      signal.addEventListener("abort", () => { events.push("aborted"); finish = resolve; }, { once: true });
    }); },
    revokeCapability: async (task) => { events.push(`revoked:${task}`); },
    stopSandbox: async (task, timeout) => { events.push(`sandbox:${task}:${timeout}`); return "stopped"; },
    recordAcceptedEffectUnknown: async (task) => { events.push(`unknown:${task}`); },
  });
  const execution = executor.execute({ taskId: "task-2", projectId: "p1", capability: "secret-capability" });
  await started;
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
  let dispatches = 0;
  let bothDispatched;
  const started = new Promise((resolve) => { bothDispatched = resolve; });
  const executor = worker.createStopAwareExecutor({
    readStop: async () => ({ stopped: false, version: 1 }), dispatch: async () => { if (++dispatches === 2) bothDispatched(); return new Promise(() => {}); },
    revokeCapability: async (task) => stopped.push(task), stopSandbox: async () => "stopped",
    recordAcceptedEffectUnknown: async () => undefined,
  }, { shutdownTimeoutMs: 5 });
  void executor.execute({ taskId: "one", projectId: "p1", capability: "c1" });
  void executor.execute({ taskId: "two", projectId: "p2", capability: "c2" });
  await started;
  await executor.stop("p1");
  assert.deepEqual(stopped, ["one"]);
  assert.deepEqual(executor.activeTaskIds(), ["one", "two"]);
  await executor.stop("p2");
});

test("after a durable project resume only a fresh execution is admitted", async () => {
  const projectStops = new Map([["project-resume", true]]);
  const dispatched = [];
  const executor = worker.createStopAwareExecutor({
    readStop: async (projectId) => ({ stopped: projectStops.get(projectId) ?? false, version: 1 }),
    dispatch: async (_capability, signal) => { assert.equal(signal.aborted, false); dispatched.push("fresh-attempt"); return "done"; },
    revokeCapability: async () => undefined,
    stopSandbox: async () => "stopped",
    recordAcceptedEffectUnknown: async () => undefined,
  });
  assert.deepEqual(await executor.execute({ taskId: "stopped-attempt", projectId: "project-resume", capability: "old" }), { kind: "stopped" });
  projectStops.set("project-resume", false);
  assert.deepEqual(await executor.execute({ taskId: "new-attempt", projectId: "project-resume", capability: "new" }), { kind: "dispatched", result: "done" });
  assert.deepEqual(dispatched, ["fresh-attempt"]);
});

test("queue lifecycle claims, executes and completes through the lease service", async () => {
  const events = [];
  const lease = { task: { id: "q1", taskId: "22222222-2222-4222-8222-222222222222" }, attemptId: "33333333-3333-4333-8333-333333333333", worker: "w", epoch: 1, expiresAt: Date.now() + 1000 };
  const queue = {
    claim: async () => { events.push("claim"); return lease; },
    complete: async (_lease, reference, canonical) => { events.push(`complete:${reference.id}:${canonical.mode}`); },
    fail: async () => { throw new Error("unexpected fail"); },
    cancel: async (id) => { events.push(`cancel:${id}`); },
  };
  const runtime = worker.createQueueWorker({
    queue, workerId: "w", leaseMs: 1000, restoreGate: readyRestoreGate,
    hydrate: async () => ({ taskId: "22222222-2222-4222-8222-222222222222", projectId: "p1", capability: "cap" }),
    trustedResultContext: async () => ({
      resultId: "44444444-4444-4444-8444-444444444444",
      expected: { requestId: "11111111-1111-4111-8111-111111111111", taskId: "22222222-2222-4222-8222-222222222222", attemptId: "33333333-3333-4333-8333-333333333333", leaseEpoch: 1, mode: "dev", sourceRevision: "a".repeat(40), snapshotDigest: "b".repeat(64), provider: "openai", model: "gpt-4.1" },
    }),
    execution: {
      readStop: async () => ({ stopped: false, version: 1 }),
      dispatch: async () => { events.push("dispatch"); return { payload: { summary: "Patch report", artifactId: "55555555-5555-4555-8555-555555555555", patchDigest: "c".repeat(64), changedPaths: ["src/index.ts"], limitations: [] } }; },
      revokeCapability: async () => undefined, stopSandbox: async () => "stopped",
      recordAcceptedEffectUnknown: async () => undefined,
    },
  });
  assert.equal(await runtime.runOnce(), "completed");
  assert.deepEqual(events, ["claim", "dispatch", "complete:44444444-4444-4444-8444-444444444444:dev"]);
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

test("persisted stop reader combines global and project state and fails closed at dispatch", async () => {
  const reads = [];
  const readStop = worker.createPersistedStopReader({
    get: async ({ projectId }) => {
      reads.push(projectId);
      return { global: { stopped: false, version: 4 }, project: { stopped: projectId === "p1", version: 7 } };
    },
  });
  assert.deepEqual(await readStop("p1"), { stopped: true, version: 7 });
  assert.deepEqual(await readStop("p2"), { stopped: false, version: 7 });
  const dispatched = [];
  const executor = worker.createStopAwareExecutor({
    readStop,
    dispatch: async () => { dispatched.push(true); return "unexpected"; },
    revokeCapability: async () => undefined,
    stopSandbox: async () => "stopped",
    recordAcceptedEffectUnknown: async () => undefined,
  });
  assert.deepEqual(await executor.execute({ taskId: "isolated", projectId: "p1", capability: "cap" }), { kind: "stopped" });
  assert.deepEqual(await executor.execute({ taskId: "unaffected", projectId: "p2", capability: "cap" }), { kind: "dispatched", result: "unexpected" });
  assert.deepEqual(dispatched, [true]);
  assert.deepEqual(reads, ["p1", "p2", "p1", "p2", "p2"]);
});
