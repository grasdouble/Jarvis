import test from 'node:test';
import assert from 'node:assert/strict';
const AbortController = globalThis.AbortController;
import { createSandboxRuntime } from '../dist/sandbox-runtime.js';
import { createSandboxQueueWorker } from '../dist/index.js';

test('configured sandbox queue composition requires trusted spec and sandbox dispatch', () => {
  assert.equal(typeof createSandboxQueueWorker, 'function');
  assert.throws(() => createSandboxQueueWorker({}), /sandbox/i);
});

test('configured sandbox queue composition rejects missing recovery contract methods', () => {
  const completePorts = () => ({
    workerId: 'worker', leaseMs: 1000, queue: { claim: async () => null, complete: async () => {}, fail: async () => {}, cancel: async () => {} },
    hydrate: async () => ({ taskId: 'task-a', projectId: 'project-a', capability: {} }),
    execution: { readStop: async () => ({ stopped: false }), dispatch: async () => ({}), revokeCapability: async () => {}, stopSandbox: async () => 'stopped', recordAcceptedEffectUnknown: async () => {} },
    restoreGate: { waitUntilActivated: async () => {}, activateAfterRestore: async () => {} },
    sandbox: { trustedSpec: async () => spec, sandbox: { create: async () => ({ sandboxId: 'unused' }), cancel: async () => {}, findByIdempotencyKey: async () => null },
      mappings: { reserve: async () => {}, bind: async () => {}, get: async () => null, clear: async () => {}, getForReconciliation: async () => ({ sandboxId: null, idempotencyKey: 'task:a:1', spec }), clearAfterReconciliationCancellation: async () => {}, clearAfterReconciliationNoSandbox: async () => {} } },
    dispatchSandbox: async () => ({}),
  });
  const missing = [
    (ports) => { delete ports.sandbox.mappings.reserve; },
    (ports) => { delete ports.sandbox.mappings.clearAfterReconciliationNoSandbox; },
    (ports) => { delete ports.sandbox.sandbox.findByIdempotencyKey; },
  ];
  for (const omit of missing) {
    const ports = completePorts();
    omit(ports);
    assert.throws(() => createSandboxQueueWorker(ports), /Sandbox worker composition requires/);
  }
});

const lease = { task: { taskId: 'task-a' }, worker: 'worker', attemptId: 'attempt-a', epoch: 2, expiresAt: Date.now() + 1000 };
const spec = { taskId: 'task-a', attemptId: 'attempt-a', snapshotId: 'a'.repeat(40), profileId: 'trusted', modelProfileId: 'model', deadline: new Date(Date.now() + 60_000).toISOString(), leaseEpoch: 2 };

test('create persists exact lease mapping before dispatch and cancellation uses that mapping', async () => {
  const events = []; let stored;
  const runtime = createSandboxRuntime({
    trustedSpec: async () => spec,
    sandbox: { create: async (s, key) => { events.push(['create', s, key]); return { sandboxId: 'sandbox-1' }; }, findByIdempotencyKey: async () => null, cancel: async (...args) => events.push(['cancel', ...args]) },
    mappings: { reserve: async (m) => events.push(['reserve', m]), bind: async (m) => { events.push(['bind', m]); stored = m.sandboxId; }, get: async (m) => { events.push(['get', m]); return stored; }, clear: async () => { events.push(['clear']); stored = undefined; }, getForReconciliation: async () => ({ sandboxId: stored, idempotencyKey: 'key', spec }), clearAfterReconciliationCancellation: async () => { events.push(['recovery-clear']); stored = undefined; }, clearAfterReconciliationNoSandbox: async () => { events.push(['recovery-no-sandbox-clear']); } },
    dispatch: async ({ sandboxId }) => { events.push(['dispatch', sandboxId]); return 'ok'; },
  });
  assert.equal(await runtime.execute(lease, new AbortController().signal), 'ok');
  assert.deepEqual(events.map(([kind]) => kind), ['reserve', 'create', 'bind', 'dispatch', 'clear']);
  stored = 'sandbox-1';
  assert.equal(await runtime.cancel(lease), 'cancelled');
  assert.deepEqual(events.slice(-1), [['cancel', 'sandbox-1', 2]]);
  assert.equal(stored, 'sandbox-1', 'active stop retains mapping until queue outcome is known');
});

test('durable reservation precedes create and reconciliation recovers after bind and cancel failure', async () => {
  const events = []; let reservation; let mapped;
  const ports = { trustedSpec: async () => spec,
    sandbox: { create: async (_spec, key) => { events.push(['create', key]); return { sandboxId: 'sandbox-1' }; },
      findByIdempotencyKey: async (key) => { events.push(['resolve', key]); return 'sandbox-1'; },
      cancel: async (id) => { events.push(['cancel', id]); if (events.filter(([e]) => e === 'cancel').length === 1) throw Error('cancel uncertain'); } },
    mappings: { reserve: async (m) => { events.push(['reserve', m]); reservation = m; },
      bind: async (m) => { events.push(['bind', m]); if (!mapped) throw Error('db bind failed'); mapped = m.sandboxId; },
      get: async () => mapped ?? null, clear: async () => {},
      getForReconciliation: async () => ({ sandboxId: mapped ?? null, idempotencyKey: `${spec.taskId}:${spec.attemptId}:${spec.leaseEpoch}`, spec }),
      clearAfterReconciliationCancellation: async () => { events.push(['recovery-clear']); reservation = undefined; mapped = undefined; }, clearAfterReconciliationNoSandbox: async () => { reservation = undefined; } },
    dispatch: async () => { events.push(['dispatch']); } };
  const runtime = createSandboxRuntime(ports);
  await assert.rejects(runtime.execute(lease, new AbortController().signal), /db bind failed/);
  assert.ok(reservation, 'reservation survives failed bind and uncertain compensation');
  assert.equal(events.some(([kind]) => kind === 'dispatch'), false);
  await runtime.cancelForReconciliation({ taskId: 'task-a', attemptId: 'attempt-a', leaseEpoch: 2 });
  assert.deepEqual(events.filter(([kind]) => ['reserve','create','resolve','cancel','recovery-clear'].includes(kind)).map(([kind]) => kind), ['reserve','create','cancel','resolve','cancel','recovery-clear']);
  assert.equal(reservation, undefined);
});

test('reconciliation retains reservation when manager resolution or cancellation is uncertain', async () => {
  const reservation = { sandboxId: null, idempotencyKey: 'task-a:attempt-a:2', spec };
  let clears = 0; let resolveFails = true; let cancelFails = true;
  const runtime = createSandboxRuntime({ trustedSpec: async () => spec,
    sandbox: { create: async () => ({ sandboxId: 'unused' }), findByIdempotencyKey: async () => { if (resolveFails) throw Error('resolve unavailable'); return 'sandbox-exact'; }, cancel: async () => { if (cancelFails) throw Error('cancel unavailable'); } },
    mappings: { reserve: async () => {}, bind: async () => {}, get: async () => null, clear: async () => {}, getForReconciliation: async () => reservation, clearAfterReconciliationCancellation: async () => { clears++; }, clearAfterReconciliationNoSandbox: async () => { clears++; } },
    dispatch: async () => { throw Error('must not dispatch'); } });
  const identity = { taskId: 'task-a', attemptId: 'attempt-a', leaseEpoch: 2 };
  await assert.rejects(runtime.cancelForReconciliation(identity), /resolve unavailable/);
  assert.equal(clears, 0);
  resolveFails = false;
  await assert.rejects(runtime.cancelForReconciliation(identity), /cancel unavailable/);
  assert.equal(clears, 0);
  cancelFails = false;
  assert.equal(await runtime.cancelForReconciliation(identity), 'cancelled');
  assert.equal(clears, 1);
});

test('confirmed exact-key absence clears only the unbound reservation', async () => {
  const calls = [];
  const runtime = createSandboxRuntime({ trustedSpec: async () => spec,
    sandbox: { create: async () => ({ sandboxId: 'unused' }), findByIdempotencyKey: async () => null, cancel: async () => { throw Error('must not cancel an absent sandbox'); } },
    mappings: { reserve: async () => {}, bind: async () => {}, get: async () => null, clear: async () => {},
      getForReconciliation: async () => ({ sandboxId: null, idempotencyKey: 'task-a:attempt-a:2', spec }),
      clearAfterReconciliationCancellation: async () => { throw Error('wrong cleanup path'); },
      clearAfterReconciliationNoSandbox: async (identity) => calls.push(identity) },
    dispatch: async () => { throw Error('must not dispatch'); } });
  assert.equal(await runtime.cancelForReconciliation({ taskId: 'task-a', attemptId: 'attempt-a', leaseEpoch: 2 }), 'no_sandbox');
  assert.deepEqual(calls, [{ taskId: 'task-a', attemptId: 'attempt-a', leaseEpoch: 2 }]);
});

test('spec mismatch fails before create; mapping failure cancels and never dispatches', async () => {
  let creates = 0; let dispatches = 0; let cancellations = 0;
  const ports = { trustedSpec: async () => ({ ...spec, leaseEpoch: 1 }), sandbox: { create: async () => { creates++; return { sandboxId: 'sandbox-1' }; }, findByIdempotencyKey: async () => null, cancel: async () => { cancellations++; } }, mappings: { reserve: async () => {}, bind: async () => { throw Error('db down'); }, get: async () => null, clear: async () => {}, getForReconciliation: async () => ({ sandboxId: null, idempotencyKey: 'key', spec }), clearAfterReconciliationCancellation: async () => {}, clearAfterReconciliationNoSandbox: async () => {} }, dispatch: async () => { dispatches++; } };
  const runtime = createSandboxRuntime(ports);
  await assert.rejects(runtime.execute(lease, new AbortController().signal), /does not match/);
  assert.equal(creates, 0);
  ports.trustedSpec = async () => spec;
  await assert.rejects(runtime.execute(lease, new AbortController().signal), /db down/);
  assert.equal(cancellations, 1); assert.equal(dispatches, 0);
});

test('mapping read is fenced by exact task attempt and epoch', async () => {
  let requested;
  const runtime = createSandboxRuntime({ trustedSpec: async () => spec,
    sandbox: { create: async () => ({ sandboxId: 'unused' }), findByIdempotencyKey: async () => null, cancel: async (id, epoch) => { assert.equal(id, 'exact'); assert.equal(epoch, 2); } },
    mappings: { reserve: async () => {}, bind: async () => {}, get: async (m) => { requested = m; return 'exact'; }, clear: async () => {}, getForReconciliation: async () => ({ sandboxId: null, idempotencyKey: 'key', spec }), clearAfterReconciliationCancellation: async () => {}, clearAfterReconciliationNoSandbox: async () => {} }, dispatch: async () => 'ok' });
  await runtime.cancel(lease);
  assert.deepEqual(requested, { taskId: 'task-a', attemptId: 'attempt-a', leaseEpoch: 2 });
});

test('aborted/unknown dispatch preserves mapping until exact cancellation is confirmed', async () => {
  let stored;
  const cancelled = [];
  const runtime = createSandboxRuntime({ trustedSpec: async () => spec,
    sandbox: { create: async () => ({ sandboxId: 'sandbox-1' }), findByIdempotencyKey: async () => stored, cancel: async (id, epoch) => { cancelled.push([id, epoch]); } },
     mappings: { reserve: async () => {}, bind: async (m) => { stored = m.sandboxId; }, get: async () => stored, clear: async () => { stored = undefined; }, getForReconciliation: async () => ({ sandboxId: stored ?? null, idempotencyKey: `${spec.taskId}:${spec.attemptId}:${spec.leaseEpoch}`, spec }), clearAfterReconciliationCancellation: async () => { stored = undefined; }, clearAfterReconciliationNoSandbox: async () => { stored = undefined; } },
    dispatch: async () => { throw new Error('remote result unknown'); } });
  await assert.rejects(runtime.execute(lease, new AbortController().signal), /unknown/);
  assert.equal(stored, 'sandbox-1', 'unknown remote effect retains association');
  await runtime.cancelForReconciliation({ taskId: 'task-a', attemptId: 'attempt-a', leaseEpoch: 2 });
  assert.deepEqual(cancelled, [['sandbox-1', 2]]);
  assert.equal(stored, undefined, 'confirmed cancellation clears association');
});

test('stale lease cannot cancel a sandbox mapped to the current attempt', async () => {
  let cancellations = 0;
  const runtime = createSandboxRuntime({ trustedSpec: async () => spec,
    sandbox: { create: async () => ({ sandboxId: 'sandbox-current' }), findByIdempotencyKey: async () => null, cancel: async () => { cancellations++; } },
    mappings: { reserve: async () => {}, bind: async () => {}, get: async (identity) => {
      if (identity.attemptId !== 'attempt-a' || identity.leaseEpoch !== 2) throw new Error('stale lease');
      return 'sandbox-current';
     }, clear: async () => {}, getForReconciliation: async () => ({ sandboxId: null, idempotencyKey: 'key', spec }), clearAfterReconciliationCancellation: async () => {}, clearAfterReconciliationNoSandbox: async () => {} }, dispatch: async () => 'ok' });
  await assert.rejects(runtime.cancel({ ...lease, attemptId: 'old-attempt', epoch: 1 }), /stale lease/);
  assert.equal(cancellations, 0);
});
