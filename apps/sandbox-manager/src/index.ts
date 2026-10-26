export const serviceName = "sandbox-manager";

const MANAGED_LABEL = "jarvis.managed";
const TASK_LABEL = "task_id";
const ATTEMPT_LABEL = "attempt_id";
const EXPIRY_LABEL = "expires_at";
const SANDBOX_LABEL = "sandbox_id";
const PROFILE_LABEL = "profile_id";
const SNAPSHOT_LABEL = "snapshot_id";
const MODEL_PROFILE_LABEL = "model_profile_id";
const LEASE_LABEL = "lease_epoch";
const RESOURCE_LABEL = "resource_kind";
const MAX_CONCURRENT_SANDBOXES = 1;
const WORKSPACE_TARGET = "/workspace";
const STATE_TARGET = "/state";
const ENTRYPOINT = "/usr/local/bin/jarvis-sandbox";

export type SandboxSpec = {
  taskId: string;
  attemptId: string;
  snapshotId: string;
  profileId: string;
  modelProfileId: string;
  deadline: string;
  leaseEpoch: number;
};

export type SandboxProfile = {
  id: string;
  image: string;
  platform: "linux/arm64";
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  maxDurationMs: number;
  readOnlyWorkspace: boolean;
};

export type ManagedLabels = Record<string, string>;

export type VolumeRequest = {
  name: string;
  labels: ManagedLabels;
};

export type ContainerRequest = {
  name: string;
  image: string;
  platform: "linux/arm64";
  entrypoint: string[];
  user: "10001:10001";
  labels: ManagedLabels;
  networkMode: "none";
  readOnlyRootfs: true;
  privileged: false;
  capDrop: ["ALL"];
  securityOptions: ["no-new-privileges:true"];
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  mounts: [
    { type: "volume"; source: string; target: typeof WORKSPACE_TARGET; readOnly: boolean },
    { type: "volume"; source: string; target: typeof STATE_TARGET; readOnly: false },
  ];
};

export type ContainerInspection = {
  id: string;
  state: "created" | "running" | "paused" | "restarting" | "removing" | "exited" | "dead" | "unknown";
  labels: ManagedLabels;
};

export interface SandboxEngine {
  createVolume(request: VolumeRequest): Promise<{ name: string; labels: ManagedLabels }>;
  createContainer(request: ContainerRequest): Promise<ContainerInspection>;
  listManagedContainers(): Promise<ContainerInspection[]>;
  listManagedVolumes(): Promise<Array<{ name: string; labels: ManagedLabels }>>;
  startContainer(id: string): Promise<void>;
  inspectContainer(id: string): Promise<ContainerInspection>;
  stopContainer(id: string, timeoutSeconds: number): Promise<void>;
  removeContainer(id: string, expectedLabels: ManagedLabels): Promise<void>;
  removeVolume(name: string, expectedLabels: ManagedLabels): Promise<void>;
  relayOpenCode(containerId: string, request: OpenCodeRelayRequest): Promise<OpenCodeRelayResponse>;
}

export type OpenCodeRelayRequest =
  | { readonly operation: "health" }
  | { readonly operation: "session.create"; readonly title: string }
  | { readonly operation: "prompt"; readonly sessionID: string; readonly text: string }
  | { readonly operation: "messages"; readonly sessionID: string }
  | { readonly operation: "status"; readonly sessionID: string }
  | { readonly operation: "cancel"; readonly sessionID: string };
export type OpenCodeRelayResponse = Readonly<Record<string, unknown>>;

export class SandboxManagerError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_ARGUMENT" | "NOT_FOUND" | "CONFLICT" | "ENGINE_ERROR",
  ) {
    super(message);
    this.name = "SandboxManagerError";
  }
}

export type SandboxManagerOptions = {
  engine: SandboxEngine;
  profiles: readonly SandboxProfile[];
  now?: () => Date;
  createId?: () => string;
};

export type SandboxStatus = {
  sandboxId: string;
  state: ContainerInspection["state"];
  deadline: string;
  profileId: string;
};

export type SandboxManager = {
  create(spec: unknown, idempotencyKey: string): Promise<SandboxStatus>;
  inspect(sandboxId: string): Promise<SandboxStatus>;
  cancel(sandboxId: string, leaseEpoch: number): Promise<void>;
  destroy(sandboxId: string, leaseEpoch: number): Promise<void>;
  runtime(sandboxId: string, leaseEpoch: number, taskId: string, attemptId: string, request: unknown): Promise<OpenCodeRelayResponse>;
  expire(): Promise<number>;
  recover(): Promise<void>;
};

type ManagedSandbox = {
  sandboxId: string;
  engineId: string;
  workspaceVolume: string;
  stateVolume: string;
  spec: SandboxSpec;
  profile: SandboxProfile;
  labels: ManagedLabels;
  workspaceLabels: ManagedLabels;
  stateLabels: ManagedLabels;
};

const specKeys = new Set([
  "taskId",
  "attemptId",
  "snapshotId",
  "profileId",
  "modelProfileId",
  "deadline",
  "leaseEpoch",
]);
const profileKeys = new Set([
  "id",
  "image",
  "platform",
  "memoryBytes",
  "nanoCpus",
  "pidsLimit",
  "maxDurationMs",
  "readOnlyWorkspace",
]);

function invalid(message: string): never {
  throw new SandboxManagerError(message, "INVALID_ARGUMENT");
}

function validateSpec(input: unknown): SandboxSpec {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalid("Sandbox specification must be an object.");
  }

  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!specKeys.has(key)) invalid(`Unknown sandbox specification field: ${key}.`);
  }
  for (const key of specKeys) {
    if (!(key in record)) invalid(`Missing sandbox specification field: ${key}.`);
  }

  for (const key of ["taskId", "attemptId", "profileId", "modelProfileId"] as const) {
    if (typeof record[key] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(record[key])) {
      invalid(`${key} is invalid.`);
    }
  }
  if (typeof record.snapshotId !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.snapshotId)) {
    invalid("snapshotId must be a validated hexadecimal snapshot identifier.");
  }
  if (typeof record.deadline !== "string") invalid("deadline must be an ISO timestamp.");
  const parsedDeadline = new Date(record.deadline);
  if (!Number.isFinite(parsedDeadline.getTime()) || parsedDeadline.toISOString() !== record.deadline) {
    invalid("deadline must be a canonical ISO timestamp.");
  }
  if (!Number.isSafeInteger(record.leaseEpoch) || (record.leaseEpoch as number) < 1) {
    invalid("leaseEpoch must be a positive safe integer.");
  }

  return record as SandboxSpec;
}

function validateRelayRequest(input: unknown): OpenCodeRelayRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid("Relay request must be an object.");
  const record = input as Record<string, unknown>;
  const string = (key: string, max: number): string => {
    const value = record[key];
    if (typeof value !== "string" || value.length < 1 || value.length > max) invalid(`Relay ${key} is invalid.`);
    return value;
  };
  const exact = (...keys: string[]): void => {
    if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) invalid("Relay request contains unknown or missing fields.");
  };
  switch (record.operation) {
    case "health": exact("operation"); return { operation: "health" };
    case "session.create":
      exact("operation", "title");
      return { operation: "session.create", title: string("title", 200) };
    case "prompt":
      exact("operation", "sessionID", "text");
      return { operation: "prompt", sessionID: sessionId(string("sessionID", 128)), text: string("text", 64 * 1024) };
    case "messages": case "status": case "cancel":
      exact("operation", "sessionID");
      return { operation: record.operation, sessionID: sessionId(string("sessionID", 128)) };
    default: return invalid("Unsupported fixed relay operation.");
  }
}

function sessionId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) invalid("Relay sessionID is invalid.");
  return value;
}

function validateProfile(profile: SandboxProfile): void {
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    invalid("Configured sandbox profile must be an object.");
  }
  for (const key of Object.keys(profile)) {
    if (!profileKeys.has(key)) invalid(`Unknown configured profile field: ${key}.`);
  }
  for (const key of profileKeys) {
    if (!(key in profile)) invalid(`Missing configured profile field: ${key}.`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile.id)) {
    invalid("Configured profile id is invalid.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(profile.image)) {
    invalid(`Profile ${profile.id} must use an immutable image digest.`);
  }
  if (profile.platform !== "linux/arm64") invalid(`Profile ${profile.id} must use the native linux/arm64 platform.`);
  if (!Number.isSafeInteger(profile.memoryBytes) || profile.memoryBytes < 64 * 1024 ** 2 || profile.memoryBytes > 4 * 1024 ** 3) {
    invalid(`Profile ${profile.id} has an invalid memory limit.`);
  }
  if (!Number.isSafeInteger(profile.nanoCpus) || profile.nanoCpus < 100_000_000 || profile.nanoCpus > 2_000_000_000) {
    invalid(`Profile ${profile.id} has an invalid CPU limit.`);
  }
  if (!Number.isSafeInteger(profile.pidsLimit) || profile.pidsLimit < 16 || profile.pidsLimit > 256) {
    invalid(`Profile ${profile.id} has an invalid PID limit.`);
  }
  if (!Number.isSafeInteger(profile.maxDurationMs) || profile.maxDurationMs < 1_000 || profile.maxDurationMs > 30 * 60 * 1000) {
    invalid(`Profile ${profile.id} has an invalid duration limit.`);
  }
  if (typeof profile.readOnlyWorkspace !== "boolean") {
    invalid(`Profile ${profile.id} must define workspace access explicitly.`);
  }
}

function labelsFor(
  spec: SandboxSpec,
  sandboxId: string,
  profile: SandboxProfile,
  resourceKind: "container" | "workspace" | "state",
): ManagedLabels {
  return {
    [MANAGED_LABEL]: "true",
    [TASK_LABEL]: spec.taskId,
    [ATTEMPT_LABEL]: spec.attemptId,
    [EXPIRY_LABEL]: spec.deadline,
    [SANDBOX_LABEL]: sandboxId,
    [PROFILE_LABEL]: profile.id,
    [SNAPSHOT_LABEL]: spec.snapshotId,
    [MODEL_PROFILE_LABEL]: spec.modelProfileId,
    [LEASE_LABEL]: String(spec.leaseEpoch),
    [RESOURCE_LABEL]: resourceKind,
  };
}

function assertOwned(actual: ManagedLabels, expected: ManagedLabels): void {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new SandboxManagerError("Engine resource ownership labels do not match the manager registry.", "CONFLICT");
    }
  }
}

function fingerprintFor(spec: SandboxSpec): string {
  return JSON.stringify([...specKeys].sort().map((key) => [key, spec[key as keyof SandboxSpec]]));
}

export function createSandboxManager(options: SandboxManagerOptions): SandboxManager {
  if (options.profiles.length === 0) invalid("At least one trusted sandbox profile is required.");
  const profiles = new Map<string, SandboxProfile>();
  for (const profile of options.profiles) {
    validateProfile(profile);
    if (profiles.has(profile.id)) invalid(`Duplicate sandbox profile: ${profile.id}.`);
    profiles.set(profile.id, Object.freeze({ ...profile }));
  }

  const now: () => Date = options.now ?? ((): Date => new Date());
  const createId: () => string = options.createId ?? ((): string => globalThis.crypto.randomUUID());
  const managed = new Map<string, ManagedSandbox>();
  const idempotency = new Map<string, { fingerprint: string; result: SandboxStatus }>();
  const inFlight = new Map<string, { fingerprint: string; promise: Promise<SandboxStatus> }>();
  let reconcileBeforeCreate = false;

  function find(sandboxId: string, leaseEpoch?: number): ManagedSandbox {
    const record = managed.get(sandboxId);
    if (!record) throw new SandboxManagerError("Managed sandbox was not found.", "NOT_FOUND");
    if (leaseEpoch !== undefined && leaseEpoch !== record.spec.leaseEpoch) {
      throw new SandboxManagerError("Sandbox lease epoch does not match.", "CONFLICT");
    }
    return record;
  }

  async function remove(record: ManagedSandbox): Promise<void> {
    try {
      try {
        const inspection = await options.engine.inspectContainer(record.engineId);
        assertOwned(inspection.labels, record.labels);
        if (["running", "paused", "restarting"].includes(inspection.state)) {
          await options.engine.stopContainer(record.engineId, 5);
        }
        await options.engine.removeContainer(record.engineId, record.labels);
      } catch (error) {
        if (!(error instanceof SandboxManagerError) || error.code !== "NOT_FOUND") throw error;
      }
      await options.engine.removeVolume(record.workspaceVolume, record.workspaceLabels);
      await options.engine.removeVolume(record.stateVolume, record.stateLabels);
      managed.delete(record.sandboxId);
    } catch (error) {
      reconcileBeforeCreate = true;
      throw error;
    }
  }

  async function status(record: ManagedSandbox): Promise<SandboxStatus> {
    if (new Date(record.spec.deadline).getTime() <= now().getTime()) {
      await remove(record);
      throw new SandboxManagerError("Managed sandbox deadline has expired.", "NOT_FOUND");
    }
    const inspection = await options.engine.inspectContainer(record.engineId);
    assertOwned(inspection.labels, record.labels);
    return {
      sandboxId: record.sandboxId,
      state: inspection.state,
      deadline: record.spec.deadline,
      profileId: record.profile.id,
    };
  }

  async function create(specInput: unknown, idempotencyKey: string): Promise<SandboxStatus> {
    const spec = validateSpec(specInput);
    if (typeof idempotencyKey !== "string" || !/^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      invalid("A bounded idempotency key is required.");
    }
    const profile = profiles.get(spec.profileId);
    if (!profile) invalid("Unknown sandbox profile.");

    const nowMs = now().getTime();
    const deadlineMs = new Date(spec.deadline).getTime();
    if (deadlineMs <= nowMs || deadlineMs - nowMs > profile.maxDurationMs) {
      invalid("Sandbox deadline is expired or exceeds the selected profile limit.");
    }
    if (reconcileBeforeCreate) {
      await recover();
      reconcileBeforeCreate = false;
    }
    await expire();

    const fingerprint = fingerprintFor(spec);
    const sameAttempt = [...managed.values()].find((record) =>
      record.spec.taskId === spec.taskId && record.spec.attemptId === spec.attemptId);
    if (sameAttempt) {
      if (fingerprintFor(sameAttempt.spec) !== fingerprint) {
        throw new SandboxManagerError("Task attempt already has a different managed sandbox.", "CONFLICT");
      }
      return status(sameAttempt);
    }
    const prior = idempotency.get(idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new SandboxManagerError("Idempotency key was already used for a different sandbox request.", "CONFLICT");
      }
      if (!managed.has(prior.result.sandboxId)) {
        throw new SandboxManagerError("Idempotent sandbox request has already ended.", "CONFLICT");
      }
      return status(find(prior.result.sandboxId));
    }
    const pending = inFlight.get(idempotencyKey);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        throw new SandboxManagerError("Idempotency key is already being used for a different sandbox request.", "CONFLICT");
      }
      return pending.promise;
    }
    if (managed.size + inFlight.size >= MAX_CONCURRENT_SANDBOXES) {
      throw new SandboxManagerError("The configured sandbox capacity is exhausted.", "CONFLICT");
    }

    const promise = (async (): Promise<SandboxStatus> => {
      const sandboxId = createId();
      const workspaceVolume = `jarvis-work-${sandboxId}`;
      const stateVolume = `jarvis-state-${sandboxId}`;
      const labels = labelsFor(spec, sandboxId, profile, "container");
      const workspaceLabels = labelsFor(spec, sandboxId, profile, "workspace");
      const stateLabels = labelsFor(spec, sandboxId, profile, "state");
      let workspaceCreated = false;
      let stateCreated = false;
      let containerCreateAttempted = false;
      let container: ContainerInspection | undefined;
      try {
        const workspace = await options.engine.createVolume({ name: workspaceVolume, labels: workspaceLabels });
        workspaceCreated = true;
        assertOwned(workspace.labels, workspaceLabels);
        const state = await options.engine.createVolume({ name: stateVolume, labels: stateLabels });
        stateCreated = true;
        assertOwned(state.labels, stateLabels);
        containerCreateAttempted = true;
        container = await options.engine.createContainer({
          name: `jarvis-sandbox-${sandboxId}`,
          image: profile.image,
          platform: profile.platform,
          entrypoint: [ENTRYPOINT],
          user: "10001:10001",
          labels,
          networkMode: "none",
          readOnlyRootfs: true,
          privileged: false,
          capDrop: ["ALL"],
          securityOptions: ["no-new-privileges:true"],
          memoryBytes: profile.memoryBytes,
          nanoCpus: profile.nanoCpus,
          pidsLimit: profile.pidsLimit,
          mounts: [
            { type: "volume", source: workspaceVolume, target: WORKSPACE_TARGET, readOnly: profile.readOnlyWorkspace },
            { type: "volume", source: stateVolume, target: STATE_TARGET, readOnly: false },
          ],
        });
        assertOwned(container.labels, labels);
        if (new Date(spec.deadline).getTime() <= now().getTime()) {
          throw new SandboxManagerError("Sandbox deadline expired before its container was started.", "CONFLICT");
        }
        await options.engine.startContainer(container.id);
        const status: SandboxStatus = {
          sandboxId,
          state: "running",
          deadline: spec.deadline,
          profileId: profile.id,
        };
        managed.set(sandboxId, {
          sandboxId,
          engineId: container.id,
          workspaceVolume,
          stateVolume,
          spec,
          profile,
          labels,
          workspaceLabels,
          stateLabels,
        });
        idempotency.set(idempotencyKey, { fingerprint, result: status });
        return status;
      } catch {
        reconcileBeforeCreate = true;
        let safeToRemoveVolumes = !containerCreateAttempted;
        if (container) {
          try {
            const current = await options.engine.inspectContainer(container.id);
            assertOwned(current.labels, labels);
            if (["running", "paused", "restarting"].includes(current.state)) {
              await options.engine.stopContainer(container.id, 5);
            }
            await options.engine.removeContainer(container.id, labels);
            safeToRemoveVolumes = true;
          } catch {
            // Keep the original failure; the manager never broadens cleanup after an uncertain identity.
          }
        }
        if (safeToRemoveVolumes && workspaceCreated) {
          try { await options.engine.removeVolume(workspaceVolume, workspaceLabels); } catch { /* Best-effort scoped compensation. */ }
        }
        if (safeToRemoveVolumes && stateCreated) {
          try { await options.engine.removeVolume(stateVolume, stateLabels); } catch { /* Best-effort scoped compensation. */ }
        }
        throw new SandboxManagerError("Sandbox creation failed; scoped cleanup was attempted.", "ENGINE_ERROR");
      }
    })();

    inFlight.set(idempotencyKey, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      inFlight.delete(idempotencyKey);
    }
  }

  async function inspect(sandboxId: string): Promise<SandboxStatus> {
    const record = find(sandboxId);
    return status(record);
  }

  async function cancel(sandboxId: string, leaseEpoch: number): Promise<void> {
    const record = find(sandboxId, leaseEpoch);
    if (new Date(record.spec.deadline).getTime() <= now().getTime()) {
      await remove(record);
      return;
    }
    const inspection = await options.engine.inspectContainer(record.engineId);
    assertOwned(inspection.labels, record.labels);
    if (["running", "paused", "restarting"].includes(inspection.state)) {
      await options.engine.stopContainer(record.engineId, 5);
    }
  }

  async function destroy(sandboxId: string, leaseEpoch: number): Promise<void> {
    await remove(find(sandboxId, leaseEpoch));
  }

  async function runtime(sandboxId: string, leaseEpoch: number, taskId: string, attemptId: string, requestInput: unknown): Promise<OpenCodeRelayResponse> {
    const record = find(sandboxId, leaseEpoch);
    if (taskId !== record.spec.taskId || attemptId !== record.spec.attemptId) {
      throw new SandboxManagerError("Sandbox task or attempt identity does not match.", "CONFLICT");
    }
    if (new Date(record.spec.deadline).getTime() <= now().getTime()) {
      await remove(record);
      throw new SandboxManagerError("Managed sandbox deadline has expired.", "NOT_FOUND");
    }
    const request = validateRelayRequest(requestInput);
    const inspection = await options.engine.inspectContainer(record.engineId);
    assertOwned(inspection.labels, record.labels);
    if (inspection.state !== "running") throw new SandboxManagerError("Managed sandbox is not running.", "CONFLICT");
    try { return await options.engine.relayOpenCode(record.engineId, request); }
    catch { throw new SandboxManagerError("Fixed OpenCode relay failed.", "ENGINE_ERROR"); }
  }

  async function expire(): Promise<number> {
    const timestamp = now().getTime();
    const expired = [...managed.values()].filter((record) => new Date(record.spec.deadline).getTime() <= timestamp);
    for (const record of expired) await remove(record);
    return expired.length;
  }

  async function recover(): Promise<void> {
    const [containers, volumes] = await Promise.all([
      options.engine.listManagedContainers(),
      options.engine.listManagedVolumes(),
    ]);
    const containersBySandbox = new Map<string, ContainerInspection>();
    for (const container of containers) {
      const labels = container.labels;
      if (labels[MANAGED_LABEL] !== "true" || labels[RESOURCE_LABEL] !== "container") continue;
      const sandboxId = labels[SANDBOX_LABEL];
      if (!sandboxId || !/^[0-9a-f-]{36}$/i.test(sandboxId)) continue;
      if (containersBySandbox.has(sandboxId)) {
        throw new SandboxManagerError("Duplicate manager-owned containers share a sandbox identity.", "CONFLICT");
      }
      containersBySandbox.set(sandboxId, container);
    }
    const volumesBySandbox = new Map<string, Array<{ name: string; labels: ManagedLabels }>>();
    for (const volume of volumes) {
      const labels = volume.labels;
      if (labels[MANAGED_LABEL] !== "true" || !["workspace", "state"].includes(labels[RESOURCE_LABEL] ?? "")) continue;
      const sandboxId = labels[SANDBOX_LABEL];
      if (!sandboxId || !/^[0-9a-f-]{36}$/i.test(sandboxId)) continue;
      const group = volumesBySandbox.get(sandboxId) ?? [];
      group.push(volume);
      volumesBySandbox.set(sandboxId, group);
    }

    const liveCount = [...containersBySandbox.values()].filter((container) => {
      const deadline = Date.parse(container.labels[EXPIRY_LABEL] ?? "");
      return Number.isFinite(deadline) && deadline > now().getTime();
    }).length;
    if (liveCount > MAX_CONCURRENT_SANDBOXES) {
      throw new SandboxManagerError("Recovered sandboxes exceed the configured capacity.", "CONFLICT");
    }

    managed.clear();

    for (const [sandboxId, container] of containersBySandbox) {
      const labels = container.labels;
      const profile = profiles.get(labels[PROFILE_LABEL] ?? "");
      if (!profile) throw new SandboxManagerError("A live sandbox references an unavailable trusted profile.", "CONFLICT");
      const deadline = labels[EXPIRY_LABEL];
      const leaseEpoch = Number(labels[LEASE_LABEL]);
      const spec: SandboxSpec = {
        taskId: labels[TASK_LABEL] ?? "",
        attemptId: labels[ATTEMPT_LABEL] ?? "",
        snapshotId: labels[SNAPSHOT_LABEL] ?? "",
        modelProfileId: labels[MODEL_PROFILE_LABEL] ?? "",
        profileId: profile.id,
        deadline: deadline ?? "",
        leaseEpoch,
      };
      validateSpec(spec);
      const group = volumesBySandbox.get(sandboxId) ?? [];
      const workspace = group.filter((item) => item.labels[RESOURCE_LABEL] === "workspace");
      const state = group.filter((item) => item.labels[RESOURCE_LABEL] === "state");
      const workspaceLabels = labelsFor(spec, sandboxId, profile, "workspace");
      const stateLabels = labelsFor(spec, sandboxId, profile, "state");
      assertOwned(labels, labelsFor(spec, sandboxId, profile, "container"));
      if (workspace.length !== 1 || state.length !== 1) {
        if (new Date(spec.deadline).getTime() <= now().getTime()) {
          for (const item of group) await options.engine.removeVolume(item.name, item.labels);
          if (["running", "paused", "restarting"].includes(container.state)) {
            await options.engine.stopContainer(container.id, 5);
          }
          await options.engine.removeContainer(container.id, container.labels);
          continue;
        }
        throw new SandboxManagerError("A live managed sandbox is missing its expected private volumes.", "CONFLICT");
      }
      assertOwned(workspace[0]!.labels, workspaceLabels);
      assertOwned(state[0]!.labels, stateLabels);
      const record: ManagedSandbox = {
        sandboxId,
        engineId: container.id,
        workspaceVolume: workspace[0]!.name,
        stateVolume: state[0]!.name,
        spec,
        profile,
        labels: labelsFor(spec, sandboxId, profile, "container"),
        workspaceLabels,
        stateLabels,
      };
      if (new Date(spec.deadline).getTime() <= now().getTime()) await remove(record);
      else managed.set(sandboxId, record);
    }

    for (const [sandboxId, group] of volumesBySandbox) {
      if (containersBySandbox.has(sandboxId)) continue;
      for (const volume of group) await options.engine.removeVolume(volume.name, volume.labels);
    }
  }

  return { create, inspect, cancel, destroy, runtime, expire, recover };
}
