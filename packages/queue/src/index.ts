export type TaskStatus = 'queued' | 'leased' | 'succeeded' | 'failed' | 'cancelled' | 'reconciliation_required';
export interface QueueTask<T = unknown> {
  id: string; eventId: string; taskId: string; payload: T; status: TaskStatus;
  createdAt: number; availableAt: number; deadline: number; maxAttempts: number;
  attempt: number; epoch: number; retry: { baseDelay: number; maxDelay: number };
  lease?: { worker: string; epoch: number; expiresAt: number };
  result?: QueueResult; error?: QueueFailure;
}
export interface QueueLease<T = unknown> { task: QueueTask<T>; worker: string; attemptId: string; epoch: number; expiresAt: number }
export interface QueueResult { kind: 'report' | 'action_intent' | 'checkpoint'; id: string }
export type QueueFailure = { kind: 'transient' | 'permanent'; code: string } | { kind: 'unknown_external'; effectId: string };
export interface QueueStore<T = unknown> {
  enqueue(task: QueueTask<T>, eventId: string): Promise<QueueTask<T>>;
  claim(worker: string, now: number, leaseMs: number): Promise<QueueLease<T> | null>;
  get(id: string): Promise<QueueTask<T> | undefined>;
  update(task: QueueTask<T>, lease?: QueueLease<T>): Promise<QueueTask<T>>;
  cancel(id: string): Promise<QueueTask<T>>;
}
export interface QueuePorts<T> { store: QueueStore<T>; clock: { now(): number }; ids: { next(): string } }
export class QueueError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

function validateResult(value: QueueResult): QueueResult {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new QueueError('INVALID_RESULT', 'Queue result must be a plain reference object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(descriptors, 'kind') || !Object.hasOwn(descriptors, 'id') ||
      !('value' in descriptors.kind) || !('value' in descriptors.id) ||
      !['report', 'action_intent', 'checkpoint'].includes(descriptors.kind.value) ||
      typeof descriptors.id.value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(descriptors.id.value)) {
    throw new QueueError('INVALID_RESULT', 'Queue results must be bounded core-owned report, action-intent, or checkpoint references');
  }
  return { kind: descriptors.kind.value as QueueResult['kind'], id: descriptors.id.value };
}

export class QueueService<T = unknown> {
  constructor(private readonly ports: QueuePorts<T>) {}
  async enqueue(input: { eventId: string; taskId: string; payload: T; deadline: number; maxAttempts: number; retry: { baseDelay: number; maxDelay: number } }): Promise<QueueTask<T>> {
    const now = this.ports.clock.now();
    if (typeof input.eventId !== 'string' || input.eventId.length < 1 || input.eventId.length > 200 ||
        typeof input.taskId !== 'string' || input.taskId.length < 1 || input.taskId.length > 200 ||
        !Number.isSafeInteger(input.deadline) || input.deadline <= now ||
        !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 3 ||
        !Number.isSafeInteger(input.retry.baseDelay) || input.retry.baseDelay < 0 || input.retry.baseDelay > 86_400_000 ||
        !Number.isSafeInteger(input.retry.maxDelay) || input.retry.maxDelay < input.retry.baseDelay || input.retry.maxDelay > 86_400_000) {
      throw new QueueError('INVALID_REQUEST', 'Queue request is outside the bounded contract');
    }
    return this.ports.store.enqueue({
      id: this.ports.ids.next(), eventId: input.eventId, taskId: input.taskId, payload: input.payload,
      status: 'queued', createdAt: now, availableAt: now, deadline: input.deadline,
      maxAttempts: input.maxAttempts, attempt: 0, epoch: 0,
      retry: { baseDelay: input.retry.baseDelay, maxDelay: input.retry.maxDelay },
    }, input.eventId);
  }
  claim(worker: string, leaseMs: number): Promise<QueueLease<T> | null> {
    if (!worker || worker.length > 200 || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 60_000) {
      throw new QueueError('INVALID_LEASE', 'Worker and a lease duration from 1 to 60000 ms are required');
    }
    return this.ports.store.claim(worker, this.ports.clock.now(), leaseMs);
  }
  async complete(lease: QueueLease<T>, result: QueueResult): Promise<QueueTask<T>> {
    const safeResult = validateResult(result);
    const task = await this.owned(lease); task.status = 'succeeded'; task.result = safeResult; delete task.error; delete task.lease; return this.ports.store.update(task, lease);
  }
  async fail(lease: QueueLease<T>, failure: QueueFailure): Promise<QueueTask<T>> {
    if (failure.kind === 'unknown_external' && (!failure.effectId || failure.effectId.length > 200)) {
      throw new QueueError('INVALID_FAILURE', 'Unknown effects require a bounded effect identifier');
    }
    if (failure.kind !== 'unknown_external' && !/^[a-z0-9_.-]{1,64}$/.test(failure.code)) {
      throw new QueueError('INVALID_FAILURE', 'Failures require a bounded stable code');
    }
    const task = await this.owned(lease);
    task.error = failure.kind === 'unknown_external'
      ? { kind: 'unknown_external', effectId: failure.effectId }
      : { kind: failure.kind, code: failure.code };
    delete task.lease;
    if (failure.kind === 'unknown_external') {
      task.status = 'reconciliation_required';
    }
    else if (failure.kind === 'transient' && task.attempt < task.maxAttempts && this.ports.clock.now() < task.deadline) {
      task.status = 'queued'; task.availableAt = Math.min(task.deadline, this.ports.clock.now() + Math.min(task.retry.maxDelay, task.retry.baseDelay * 2 ** (task.attempt - 1)));
    } else if (failure.kind === 'permanent' || failure.kind === 'transient') {
      task.status = 'failed';
    } else throw new QueueError('INVALID_FAILURE', 'Unknown failure kind');
    return this.ports.store.update(task, lease);
  }
  async reconcile(id: string, resolution: { outcome: 'applied'; result: QueueResult } | { outcome: 'not_applied' | 'indeterminate' }): Promise<QueueTask<T>> {
    if (resolution.outcome === 'applied') resolution = { outcome: 'applied', result: validateResult(resolution.result) };
    const task = await this.ports.store.get(id);
    if (!task || task.status !== 'reconciliation_required') throw new QueueError('NOT_RECONCILING', 'Task is not awaiting reconciliation');
    if (resolution.outcome === 'indeterminate') return task;
    if (resolution.outcome === 'applied') { task.status = 'succeeded'; task.result = resolution.result; delete task.error; }
    else if (resolution.outcome === 'not_applied' && task.attempt < task.maxAttempts && this.ports.clock.now() < task.deadline) {
      task.status = 'queued'; delete task.error; task.availableAt = Math.min(task.deadline, this.ports.clock.now() + Math.min(task.retry.maxDelay, task.retry.baseDelay * 2 ** (task.attempt - 1)));
    } else if (resolution.outcome === 'not_applied') { task.status = 'failed'; delete task.error; }
    else throw new QueueError('INVALID_RECONCILIATION', 'Unsupported reconciliation outcome');
    return this.ports.store.update(task);
  }
  cancel(id: string): Promise<QueueTask<T>> {
    if (!id || id.length > 200) throw new QueueError('INVALID_TASK_ID', 'Task identifier must contain 1–200 characters');
    return this.ports.store.cancel(id);
  }
  private async owned(lease: QueueLease<T>): Promise<QueueTask<T>> {
    const task = await this.ports.store.get(lease.task.id);
    if (!task || task.status !== 'leased' || task.epoch !== lease.epoch || task.lease?.worker !== lease.worker || task.lease.expiresAt <= this.ports.clock.now()) throw new QueueError('STALE_LEASE', 'Lease is stale or expired');
    return task;
  }
}
