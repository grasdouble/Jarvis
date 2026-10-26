export const serviceName = "worker";
import type { QueueLease, QueueResult, QueueService } from "@jarvis/queue";

export type FixedOpenCodeRequest =
  | { readonly operation: "health" }
  | { readonly operation: "session.create"; readonly title: string }
  | { readonly operation: "prompt"; readonly sessionID: string; readonly text: string }
  | { readonly operation: "messages"; readonly sessionID: string }
  | { readonly operation: "status"; readonly sessionID: string }
  | { readonly operation: "cancel"; readonly sessionID: string };
export interface FixedOpenCodeManagerPort {
  request(sandboxId: string, taskId: string, attemptId: string, leaseEpoch: number, request: FixedOpenCodeRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
export type SandboxManagerPost = (path: string, body: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<Record<string, unknown>>;

/** Binds worker relay calls to the authenticated manager API's fixed runtime route. */
export function createFixedOpenCodeManagerPort(post: SandboxManagerPost): FixedOpenCodeManagerPort {
  return {
    request(sandboxId, taskId, attemptId, leaseEpoch, request, signal): Promise<Record<string, unknown>> {
      if (!/^[0-9a-f-]{36}$/i.test(sandboxId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(taskId) ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(attemptId) || !Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) {
        throw new TypeError("Sandbox runtime identity is invalid");
      }
      return post(`/v1/sandboxes/${sandboxId}/runtime`, { leaseEpoch, taskId, attemptId, request }, signal);
    },
  };
}

/** Bounded message/polling session flow; the only runtime route is the manager's closed relay API. */
export async function runOpenCodeSession(input: {
  readonly manager: FixedOpenCodeManagerPort;
  readonly sandboxId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly leaseEpoch: number;
  readonly title: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
  readonly requestTimeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const interval = input.pollIntervalMs ?? 250;
  const maxPolls = input.maxPolls ?? 40;
  const requestTimeoutMs = input.requestTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(interval) || interval < 10 || interval > 2_000 ||
      !Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 240 ||
      !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 10 || requestTimeoutMs > 12_000) throw new TypeError("OpenCode polling bounds are invalid");
  const call = (request: FixedOpenCodeRequest, mode: "task" | "cleanup" = "task"): Promise<Record<string, unknown>> =>
    {
      const controller = new AbortController();
      const signal = mode === "task" ? input.signal : undefined;
      const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Sandbox-manager relay request timed out")); }, requestTimeoutMs);
      });
      return Promise.race([
        input.manager.request(input.sandboxId, input.taskId, input.attemptId, input.leaseEpoch, request, operationSignal),
        deadline,
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    };
  const session = await call({ operation: "session.create", title: input.title });
  if (typeof session.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) throw new Error("Manager returned an invalid OpenCode session identity");
  const sessionID = session.id;
  try {
    await call({ operation: "prompt", sessionID, text: input.prompt });
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      if (input.signal.aborted) throw new Error("OpenCode session cancelled");
      const [messages, status] = await Promise.all([
        call({ operation: "messages", sessionID }),
        call({ operation: "status", sessionID }),
      ]);
      if (Array.isArray(messages.messages) && messages.messages.some((item) => {
        if (typeof item !== "object" || item === null || (item as Record<string, unknown>).type !== "assistant") return false;
        const content = (item as Record<string, unknown>).content;
        return Array.isArray(content) && content.some((part) => typeof part === "object" && part !== null &&
          (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string" &&
          ((part as Record<string, unknown>).text as string).length > 0);
      })) return messages;
      if (status.status === "idle" || status.status === "error") throw new Error("OpenCode session ended without an assistant response");
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => { clearTimeout(timer); reject(new Error("OpenCode session cancelled")); };
        const timer = setTimeout(() => { input.signal.removeEventListener("abort", onAbort); resolve(); }, interval);
        input.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    throw new Error("OpenCode session polling deadline exceeded");
  } catch (error) {
    try { await call({ operation: "cancel", sessionID }, "cleanup"); } catch { /* Preserve the original failure; manager cancellation remains lease-bound. */ }
    throw error;
  }
}

export interface StopSnapshot { readonly stopped: boolean; readonly version: number }
export interface PersistedStopControlReader {
  get(input: { readonly projectId: string }): Promise<{ readonly global: { readonly stopped: boolean; readonly version: number }; readonly project: { readonly stopped: boolean; readonly version: number } | null }>;
}

/** Adapt durable global/project controls to the worker's fail-closed admission port. */
export function createPersistedStopReader(store: PersistedStopControlReader): (projectId: string) => Promise<StopSnapshot> {
  return async (projectId) => {
    const snapshot = await store.get({ projectId });
    return {
      stopped: snapshot.global.stopped || snapshot.project?.stopped === true,
      version: Math.max(snapshot.global.version, snapshot.project?.version ?? 0),
    };
  };
}
export interface StopAwareExecutionPorts<C, R> {
  /** Must read durable effective (global OR project) stop state; failures deny dispatch. */
  readStop(projectId: string): Promise<StopSnapshot>;
  dispatch(capability: C, signal: AbortSignal): Promise<R>;
  revokeCapability(taskId: string): Promise<void>;
  /** Bounded sandbox-manager operation, never a generic Docker client. */
  stopSandbox(taskId: string, timeoutMs: number): Promise<"stopped" | "unknown">;
  recordAcceptedEffectUnknown(taskId: string): Promise<void>;
}

export interface StopAwareTask<C> { readonly taskId: string; readonly projectId: string; readonly capability: C }
export type StopExecutionResult<R> = { readonly kind: "dispatched"; readonly result: R } | { readonly kind: "stopped" | "stop_unknown" };
export interface StopAwareExecutor<C, R> {
  execute(task: StopAwareTask<C>): Promise<StopExecutionResult<R>>;
  stop(projectId?: string): Promise<void>;
  activeTaskIds(): readonly string[];
}

/** A small worker execution boundary; the final durable read is immediately before dispatch. */
export function createStopAwareExecutor<C, R>(ports: StopAwareExecutionPorts<C, R>, options: { shutdownTimeoutMs?: number; pollIntervalMs?: number } = {}): StopAwareExecutor<C, R> {
  const active = new Map<string, { controller: AbortController; projectId: string; unknownRecorded: boolean; stopping?: Promise<void> }>();
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 10_000) throw new TypeError("Shutdown timeout must be in 1..10000 ms");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 2_000) throw new TypeError("Stop polling interval must be in 10..2000 ms");

  const requestStop = (taskId: string, item: { controller: AbortController; projectId: string; unknownRecorded: boolean; stopping?: Promise<void> }): Promise<void> => {
    if (item.stopping) return item.stopping;
    item.controller.abort();
    item.stopping = (async (): Promise<void> => {
      const deadline = Date.now() + shutdownTimeoutMs;
      const bounded = async <T>(operation: Promise<T>): Promise<T> => {
        const remaining = Math.max(1, deadline - Date.now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Stop operation exceeded its bounded deadline")), remaining); }),
          ]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
      };
      const persistUnknown = bounded(Promise.resolve().then(() => ports.recordAcceptedEffectUnknown(taskId))).then(() => { item.unknownRecorded = true; });
      const revoke = bounded(Promise.resolve().then(() => ports.revokeCapability(taskId)));
      const sandbox = bounded(Promise.resolve().then(() => ports.stopSandbox(taskId, shutdownTimeoutMs))).catch(() => "unknown" as const);
      const outcomes = await Promise.allSettled([persistUnknown, revoke, sandbox]);
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (failure) throw failure.reason;
    })();
    return item.stopping;
  };

  return {
    async execute(task: StopAwareTask<C>): Promise<{ readonly kind: "dispatched"; readonly result: R } | { readonly kind: "stopped" | "stop_unknown" }> {
      const controller = new AbortController();
      const running = { controller, projectId: task.projectId, unknownRecorded: false };
      active.set(task.taskId, running);
      let finished = false;
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      try {
        // Register before the first asynchronous admission read so stop() can
        // abort this execution even while durable admission is unresolved.
        const admission = await ports.readStop(task.projectId).catch(() => null);
        if (controller.signal.aborted) return { kind: "stopped" };
        if (admission === null || admission.stopped) return { kind: admission === null ? "stop_unknown" : "stopped" };
        // Final gate deliberately has no await between this read and invoking provider dispatch.
        const final = await ports.readStop(task.projectId).catch(() => null);
        if (final === null || final.stopped) return { kind: final === null ? "stop_unknown" : "stopped" };
        if (controller.signal.aborted) return { kind: "stopped" };
        const dispatch = ports.dispatch(task.capability, controller.signal).then(
          (result) => ({ kind: "result" as const, result }),
          (error: unknown) => ({ kind: "error" as const, error }),
        );
        const watch = (async (): Promise<{ kind: "stopped" }> => {
          while (!finished) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try { await Promise.race([done, new Promise<void>((resolve) => { timer = setTimeout(resolve, pollIntervalMs); })]); }
            finally { if (timer !== undefined) clearTimeout(timer); }
            if (finished || controller.signal.aborted) return { kind: "stopped" };
            const snapshot = await ports.readStop(task.projectId).catch(() => null);
            if (snapshot === null || snapshot.stopped) {
              await requestStop(task.taskId, running);
              return { kind: "stopped" };
            }
          }
          return { kind: "stopped" };
        })();
        const outcome = await Promise.race([dispatch, watch]);
        if (outcome.kind === "stopped") return { kind: "stop_unknown" };
        finished = true;
        finish();
        if (outcome.kind === "error") {
          if (controller.signal.aborted) return { kind: "stop_unknown" };
          throw outcome.error;
        }
        if (controller.signal.aborted) return { kind: "stop_unknown" };
        return { kind: "dispatched", result: outcome.result };
      } finally { finished = true; finish(); active.delete(task.taskId); }
    },
    async stop(projectId?: string): Promise<void> {
      const tasks = [...active.entries()].filter(([, item]) => projectId === undefined || item.projectId === projectId);
      await Promise.all(tasks.map(([taskId, item]) => requestStop(taskId, item)));
    },
    activeTaskIds(): readonly string[] { return [...active.keys()]; },
  };
}

export interface QueueWorkerPorts<T, C> {
  readonly queue: Pick<QueueService<T>, "claim" | "complete" | "fail" | "cancel">;
  readonly workerId: string;
  readonly leaseMs: number;
  /** Loads trusted project context/capability for the already-claimed durable task. */
  readonly hydrate: (lease: QueueLease<T>) => Promise<StopAwareTask<C>>;
  readonly execution: StopAwareExecutionPorts<C, QueueResult>;
  /** Must resolve only after the explicit post-restore suspension transaction commits. */
  readonly restoreGate: RestoreActivationGate;
}

export interface RestoreActivationGate {
  /** Explicit restore composition calls this only after database restore completes. */
  activateAfterRestore(): Promise<void>;
  /** Worker claim path awaits this; it remains pending until durable suspension succeeds. */
  waitUntilActivated(): Promise<void>;
}

/**
 * Bind the restore lifecycle to its durable suspension operation. Do not call
 * activateAfterRestore during ordinary process startup/restart.
 */
export function createRestoreActivationGate(suspendAfterRestore: () => Promise<unknown>): RestoreActivationGate {
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let activation: Promise<void> | undefined;
  return {
    activateAfterRestore(): Promise<void> {
      if (activation) return activation;
      activation = Promise.resolve().then(suspendAfterRestore).then(
        () => { resolveReady(); },
        (error: unknown) => { rejectReady(error); throw error; },
      );
      return activation;
    },
    waitUntilActivated(): Promise<void> { return ready; },
  };
}
export interface QueueWorker {
  runOnce(): Promise<"idle" | "completed" | "cancelled" | "unknown">;
  stop(projectId?: string): Promise<void>;
}

/** One-claim consumer. Durable queue claim gates admission; executor gates final dispatch. */
export function createQueueWorker<T, C>(ports: QueueWorkerPorts<T, C>): QueueWorker {
  if (!ports.workerId || !Number.isSafeInteger(ports.leaseMs) || ports.leaseMs < 1 || ports.leaseMs > 60_000 ||
      typeof ports.restoreGate?.waitUntilActivated !== "function" ||
      typeof ports.restoreGate?.activateAfterRestore !== "function") {
    throw new TypeError("A worker id and bounded lease duration are required");
  }
  const executor = createStopAwareExecutor(ports.execution);
  let running = false;
  let runningProjectId: string | undefined;
  let runFinished: Promise<void> | undefined;
  let finishRun: (() => void) | undefined;
  return {
    async runOnce(): Promise<"idle" | "completed" | "cancelled" | "unknown"> {
      if (running) throw new Error("Queue worker already has a claim in progress");
      running = true;
      runFinished = new Promise<void>((resolve) => { finishRun = resolve; });
      runningProjectId = undefined;
      let lease: QueueLease<T> | null = null;
      try {
        // This mandatory lifecycle gate is not invoked on ordinary restarts;
        // restore composition must perform durable suspension before releasing it.
        await ports.restoreGate.waitUntilActivated();
        lease = await ports.queue.claim(ports.workerId, ports.leaseMs);
        if (lease === null) return "idle";
        const task = await ports.hydrate(lease);
        runningProjectId = task.projectId;
        let result: StopExecutionResult<QueueResult>;
        try { result = await executor.execute(task); }
        catch {
          // Dispatch exceptions can follow remote acceptance; never retry as though definitely unapplied.
          await ports.queue.fail(lease, { kind: "unknown_external", effectId: task.taskId });
          return "unknown";
        }
        if (result.kind === "dispatched") {
          await ports.queue.complete(lease, result.result);
          return "completed";
        }
        if (result.kind === "stop_unknown") {
          await ports.queue.fail(lease, { kind: "unknown_external", effectId: task.taskId });
          return "unknown";
        }
        await ports.queue.cancel(lease.task.id);
        return "cancelled";
      } finally {
        running = false;
        runningProjectId = undefined;
        finishRun?.();
        finishRun = undefined;
        runFinished = undefined;
      }
    },
    async stop(projectId?: string): Promise<void> {
      const shouldWaitForLease = running && (projectId === undefined || runningProjectId === undefined || runningProjectId === projectId);
      const completion = runFinished;
      await executor.stop(projectId);
      // Wait for runOnce to release/cancel or mark the lease reconciliation-required.
      if (shouldWaitForLease && completion) await completion;
    },
  };
}
