import type { QueueLease } from "@jarvis/queue";
export type SandboxSpec = { taskId: string; attemptId: string; snapshotId: string; profileId: string; modelProfileId: string; deadline: string; leaseEpoch: number };

export type SandboxStatus = { sandboxId: string };
export interface SandboxManagerClient {
  create(spec: SandboxSpec, idempotencyKey: string): Promise<SandboxStatus>;
  findByIdempotencyKey(spec: SandboxSpec, idempotencyKey: string): Promise<string | null>;
  cancel(sandboxId: string, leaseEpoch: number): Promise<void>;
}
export interface SandboxMappingStore {
  reserve(input: { taskId: string; attemptId: string; leaseEpoch: number; idempotencyKey: string; spec: SandboxSpec }): Promise<void>;
  bind(input: { taskId: string; attemptId: string; leaseEpoch: number; sandboxId: string }): Promise<void>;
  get(input: { taskId: string; attemptId: string; leaseEpoch: number }): Promise<string | null>;
  clear(input: { taskId: string; attemptId: string; leaseEpoch: number }): Promise<void>;
  getForReconciliation(input: { taskId: string; attemptId: string; leaseEpoch: number }): Promise<{ sandboxId: string | null; idempotencyKey: string; spec: SandboxSpec }>;
  clearAfterReconciliationCancellation(input: { taskId: string; attemptId: string; leaseEpoch: number; sandboxId: string }): Promise<void>;
  clearAfterReconciliationNoSandbox(input: { taskId: string; attemptId: string; leaseEpoch: number }): Promise<void>;
}
export interface SandboxRuntimePorts<T, R> {
  sandbox: SandboxManagerClient;
  mappings: SandboxMappingStore;
  trustedSpec(lease: QueueLease<T>): Promise<SandboxSpec>;
  dispatch(input: { lease: QueueLease<T>; sandboxId: string; signal: AbortSignal }): Promise<R>;
}

/** Injected worker composition: the trusted core provides all profile/snapshot/deadline policy. */
export interface SandboxRuntime<T, R> {
  execute(lease: QueueLease<T>, signal: AbortSignal): Promise<R>;
  cancel(lease: QueueLease<T>): Promise<"cancelled" | "no_sandbox">;
  cancelForReconciliation(input: { taskId: string; attemptId: string; leaseEpoch: number }): Promise<"cancelled" | "no_sandbox">;
}
export function createSandboxRuntime<T, R>(ports: SandboxRuntimePorts<T, R>): SandboxRuntime<T, R> {
  return {
    async execute(lease: QueueLease<T>, signal: AbortSignal): Promise<R> {
      const spec = await ports.trustedSpec(lease);
      if (spec.taskId !== lease.task.taskId || spec.attemptId !== lease.attemptId || spec.leaseEpoch !== lease.epoch) {
        throw new Error("Trusted sandbox specification does not match the active queue lease");
      }
      if (signal.aborted) throw new Error("Lease was cancelled before sandbox creation");
      const idempotencyKey = `${spec.taskId}:${spec.attemptId}:${spec.leaseEpoch}`;
      const mapping = { taskId: spec.taskId, attemptId: spec.attemptId, leaseEpoch: spec.leaseEpoch };
      await ports.mappings.reserve({ ...mapping, idempotencyKey, spec });
      const created = await ports.sandbox.create(spec, idempotencyKey);
      try { await ports.mappings.bind({ ...mapping, sandboxId: created.sandboxId }); }
      catch (error) {
        // Never dispatch an untracked sandbox; cancellation is scoped to the identity just created.
        await ports.sandbox.cancel(created.sandboxId, spec.leaseEpoch).catch(() => undefined);
        throw error;
      }
      if (signal.aborted) {
        await ports.sandbox.cancel(created.sandboxId, spec.leaseEpoch);
        await ports.mappings.clear(mapping);
        throw new Error("Lease was cancelled before dispatch");
      }
      const result = await ports.dispatch({ lease, sandboxId: created.sandboxId, signal });
      // An aborted dispatch has an uncertain remote outcome; retain the durable association for reconciliation.
      if (!signal.aborted) await ports.mappings.clear(mapping);
      return result;
    },
    async cancel(lease: QueueLease<T>): Promise<"cancelled" | "no_sandbox"> {
      const mapping = { taskId: lease.task.taskId, attemptId: lease.attemptId, leaseEpoch: lease.epoch };
      const sandboxId = await ports.mappings.get(mapping);
      if (sandboxId === null) return "no_sandbox";
      await ports.sandbox.cancel(sandboxId, lease.epoch);
      // Cancellation races dispatch, so the queue may still end in reconciliation_required.
      // Keep the association until the queue outcome is known; recovery clears it under its stricter fence.
      return "cancelled";
    },
    async cancelForReconciliation(mapping): Promise<"cancelled" | "no_sandbox"> {
      const reservation = await ports.mappings.getForReconciliation(mapping);
      const sandboxId = reservation.sandboxId ?? await ports.sandbox.findByIdempotencyKey(reservation.spec, reservation.idempotencyKey);
      if (sandboxId === null) {
        // A successful exact-key lookup returning null confirms there is no sandbox to cancel.
        // Clear only the still-unbound reservation; this does not resolve any unknown dispatch effect.
        await ports.mappings.clearAfterReconciliationNoSandbox(mapping);
        return "no_sandbox";
      }
      await ports.sandbox.cancel(sandboxId, mapping.leaseEpoch);
      await ports.mappings.clearAfterReconciliationCancellation({ ...mapping, sandboxId });
      return "cancelled";
    },
  };
}
