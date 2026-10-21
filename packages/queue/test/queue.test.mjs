import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueService } from '../dist/index.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

const setup = () => {
  let now = 1_000;
  let sequence = 0;
  const rows = new Map();
  const events = new Map();
  const store = {
     enqueue: async (row, eventId) => { if (events.has(eventId)) return clone(rows.get(events.get(eventId))); rows.set(row.id, clone(row)); events.set(eventId, row.id); return clone(row); },
     claim: async (worker, now, leaseMs) => { const row = [...rows.values()].filter((r) => (r.status === 'queued' && r.availableAt <= now) || (r.status === 'leased' && r.lease.expiresAt <= now)).sort((a,b) => a.availableAt-b.availableAt)[0]; if (!row) return null; row.status='leased'; row.attempt++; row.epoch++; row.lease={worker, epoch:row.epoch, expiresAt:now+leaseMs}; return { task:clone(row), ...row.lease }; },
     get: async (id) => clone(rows.get(id)),
     update: async (row, lease) => {
       const stored = rows.get(row.id);
       if (lease && (stored?.status !== 'leased' || stored.epoch !== lease.epoch || stored.lease?.worker !== lease.worker)) {
         throw Object.assign(new Error('stale lease'), { code: 'STALE_LEASE' });
       }
       rows.set(row.id,clone(row)); return clone(row);
     },
     cancel: async (id) => { const row = rows.get(id); if (!row) throw new Error('missing task'); if (row.status === 'reconciliation_required') throw Object.assign(new Error('reconciliation required'), { code: 'RECONCILIATION_REQUIRED' }); if (row.status === 'leased') row.epoch++; row.status='cancelled'; delete row.lease; rows.set(id,clone(row)); return clone(row); },
  };
  const queue = new QueueService({ store, clock: { now: () => now }, ids: { next: () => `id-${++sequence}` } });
  return { queue, store, setNow: (value) => { now = value; } };
};

test('enqueue is idempotent by event identity and claim issues a fencing epoch', async () => {
  const { queue } = setup();
  const request = { eventId: 'evt-1', taskId: 'task-1', payload: { requestId: 'r1' }, deadline: 10_000, maxAttempts: 3, retry: { baseDelay: 100, maxDelay: 500 } };
  const first = await queue.enqueue(request);
  assert.equal((await queue.enqueue(request)).id, first.id);
  const lease = await queue.claim('worker-1', 100);
  assert.equal(lease.task.id, first.id);
  assert.equal(lease.epoch, 1);
});

test('expired ownership cannot complete after a later claim; epochs increase monotonically', async () => {
  const { queue, setNow } = setup();
  await queue.enqueue({ eventId: 'evt', taskId: 'task', payload: {}, deadline: 10_000, maxAttempts: 2, retry: { baseDelay: 10, maxDelay: 20 } });
  const old = await queue.claim('a', 10);
  setNow(1_011);
  const current = await queue.claim('b', 100);
  assert.equal(current.epoch, old.epoch + 1);
  await assert.rejects(queue.complete(old, { kind: 'report', id: '00000000-0000-4000-8000-000000000009' }), { code: 'STALE_LEASE' });
  assert.equal((await queue.complete(current, { kind: 'report', id: '00000000-0000-4000-8000-000000000009' })).status, 'succeeded');
});

test('retry is bounded/backed off and unknown external outcome requires reconciliation, never retry', async () => {
  const { queue, setNow } = setup();
  await queue.enqueue({ eventId: 'evt', taskId: 'task', payload: {}, deadline: 20_000, maxAttempts: 2, retry: { baseDelay: 100, maxDelay: 300 } });
  const lease = await queue.claim('worker', 1_000);
  const retrying = await queue.fail(lease, { kind: 'transient', code: 'provider_timeout' });
  assert.equal(retrying.status, 'queued');
  assert.equal(retrying.availableAt, 1_100);
  setNow(1_100);
  const next = await queue.claim('worker', 1_000);
  const unknown = await queue.fail(next, { kind: 'unknown_external', effectId: 'effect-1' });
  assert.equal(unknown.status, 'reconciliation_required');
  assert.equal(await queue.claim('worker', 1_000), null);
  assert.equal((await queue.reconcile(unknown.id, { outcome: 'indeterminate' })).status, 'reconciliation_required');
  assert.equal(await queue.claim('worker', 1_000), null);
  const reconciled = await queue.reconcile(unknown.id, { outcome: 'not_applied' });
  assert.equal(reconciled.status, 'failed');
});

test('request limits and stable failure codes are validated before transitions', async () => {
  const { queue } = setup();
  await assert.rejects(queue.enqueue({ eventId: 'evt', taskId: 'task', payload: {}, deadline: 10_000, maxAttempts: 4, retry: { baseDelay: 1, maxDelay: 2 } }), { code: 'INVALID_REQUEST' });
  await queue.enqueue({ eventId: 'evt', taskId: 'task', payload: {}, deadline: 10_000, maxAttempts: 1, retry: { baseDelay: 1, maxDelay: 2 } });
  const lease = await queue.claim('worker', 1_000);
  await assert.rejects(queue.fail(lease, { kind: 'permanent', code: 'Contains secret detail!' }), { code: 'INVALID_FAILURE' });
});

test('provider outage uses bounded backoff and cancellation fences a leased worker', async () => {
  const { queue, setNow } = setup();
  const enqueued = await queue.enqueue({ eventId: 'sleep-event', taskId: 'sleep-task', payload: {}, deadline: 10_000, maxAttempts: 3, retry: { baseDelay: 100, maxDelay: 400 } });
  const first = await queue.claim('worker-a', 1_000);
  const retry = await queue.fail(first, { kind: 'transient', code: 'docker_unavailable' });
  assert.equal(retry.availableAt, 1_100);
  setNow(1_099);
  assert.equal(await queue.claim('worker-b', 1_000), null, 'simulated sleep before backoff expiry does not start work');
  setNow(1_100);
  const second = await queue.claim('worker-b', 1_000);
  assert.equal(second.task.attempt, 2);
  const cancelled = await queue.cancel(enqueued.id);
  assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(queue.complete(second, { kind: 'report', id: '00000000-0000-4000-8000-000000000009' }), { code: 'STALE_LEASE' });
  assert.equal(await queue.claim('worker-c', 1_000), null);
});

test('completion accepts only a closed core result reference without invoking accessors', async () => {
  const { queue } = setup();
  await queue.enqueue({ eventId: 'result-event', taskId: 'result-task', payload: {}, deadline: 10_000, maxAttempts: 1, retry: { baseDelay: 1, maxDelay: 1 } });
  const lease = await queue.claim('worker', 1_000);
  let getterCalled = false;
  const result = { id: '00000000-0000-4000-8000-000000000009', extra: 'ignored' };
  Object.defineProperty(result, 'kind', { enumerable: true, get() { getterCalled = true; return 'report'; } });
  await assert.rejects(queue.complete(lease, result), { code: 'INVALID_RESULT' });
  assert.equal(getterCalled, false);
});
