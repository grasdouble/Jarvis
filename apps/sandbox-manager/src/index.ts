import { createHash } from "node:crypto";
import { resolveProviderCatalog, resolveProviderSelection, type ProviderCatalog, type ProviderProfile, type TrustedProviderCatalogConfiguration } from "@jarvis/llm";
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
const IDEMPOTENCY_LABEL = "idempotency_key_sha256";
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

export type NetworkRequest = {
  name: string;
  internal: boolean;
  labels: ManagedLabels;
};
export type ManagedNetworkInspection = { id: string; name: string; labels: ManagedLabels; containerIds: readonly string[] };

export type TrustedGatewayFilterProfile = {
  readonly gatewayImage: string;
  readonly filterImage: string;
  readonly providerCatalog: TrustedProviderCatalogConfiguration;
  readonly platform: "linux/arm64";
  readonly activeProfile: ProviderProfile;
};

export type ContainerRequest = {
  name: string;
  image: string;
  platform: "linux/arm64";
  entrypoint: string[];
  user: "0:0" | "10001:10001";
  labels: ManagedLabels;
  environment?: Readonly<Partial<Record<"LLM_GATEWAY_SOCKET" | "LLM_GATEWAY_ATTEMPT_CAPABILITY" | "LLM_GATEWAY_PROVIDER_ID" | "LLM_GATEWAY_MODEL" | "LLM_GATEWAY_PROFILE_ID" | "LLM_GATEWAY_CONTEXT_WINDOW_TOKENS" | "LLM_GATEWAY_MAX_OUTPUT_TOKENS" | "LLM_GATEWAY_MAX_INPUT_BYTES" | "LLM_GATEWAY_MAX_REQUESTS" | "LLM_GATEWAY_ACCOUNTING_SOCKET" | "XDG_CONFIG_HOME", string>>>;
  networkMode: "none";
  readOnlyRootfs: true;
  privileged: false;
  capDrop: ["ALL"];
  capAdd?: readonly ("SETUID" | "SETGID" | "KILL")[];
  securityOptions: ["no-new-privileges:true"];
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  mounts: readonly { type: "volume"; source: string; target: "/workspace" | "/state" | "/etc/jarvis" | "/run" | "/run/jarvis-accounting" | "/config/opencode"; readOnly: boolean }[];
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
  createNetwork(request: NetworkRequest): Promise<{ id: string; name: string; labels: ManagedLabels }>;
  connectNetwork(networkId: string, containerId: string, endpointLabels: ManagedLabels): Promise<void>;
  disconnectNetwork(networkId: string, containerId: string): Promise<void>;
  removeNetwork(networkId: string, expectedLabels: ManagedLabels): Promise<void>;
  putContainerArchive(containerId: string, destination: "/etc/jarvis", archive: Uint8Array): Promise<void>;
  listManagedNetworks(): Promise<ManagedNetworkInspection[]>;
  relayOpenCode(containerId: string, request: OpenCodeRelayRequest): Promise<OpenCodeRelayResponse>;
}

export type OpenCodeRelayRequest =
  | { readonly operation: "health" }
  | { readonly operation: "session.create"; readonly title: string; readonly mode: "plan" | "dev"; readonly profileId: string; readonly modelId: string }
  | { readonly operation: "prompt"; readonly sessionID: string; readonly text: string }
  | { readonly operation: "messages"; readonly sessionID: string }
  | { readonly operation: "status"; readonly sessionID: string }
  | { readonly operation: "cancel"; readonly sessionID: string };
export type OpenCodeRelayResponse = Readonly<Record<string, unknown>>;

export function createAttemptConfigArchive(
  filterCapability: string,
  profile: ProviderProfile,
  filterHost: string,
  filterPort: number,
  attribution: { readonly taskId: string; readonly attemptId: string; readonly leaseEpoch: number },
): Uint8Array {
  if (typeof filterCapability !== "string" || !/^[a-f0-9]{64}$/i.test(filterCapability) ||
      !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(filterHost) || filterPort !== 8080 ||
      typeof attribution !== "object" || attribution === null ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(attribution.taskId) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(attribution.attemptId) ||
      !Number.isSafeInteger(attribution.leaseEpoch) || attribution.leaseEpoch < 1) {
    invalid("Attempt capability, selected profile, and accounting lease identity are required.");
  }
  const selected = resolveProviderSelection(profile);
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  const entries = [
    { name: "egress.json", content: encode({ providers: [], dispatch_enabled: false, filterCapability }) },
    { name: "gateway.json", content: encode({
      dispatch_enabled: false, profile: selected, filterHost, filterPort,
      accounting: attribution,
    }) },
  ];
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    const write = (offset: number, length: number, value: string): void => {
      header.set(new TextEncoder().encode(value).subarray(0, length), offset);
    };
    const octal = (value: number, length: number): string => value.toString(8).padStart(length - 1, "0") + "\0";
    write(0, 100, entry.name);
    write(100, 8, octal(0o444, 8));
    write(108, 8, octal(10001, 8));
    write(116, 8, octal(10001, 8));
    write(124, 12, octal(entry.content.byteLength, 12));
    write(136, 12, octal(0, 12));
    header.fill(0x20, 148, 156);
    write(156, 1, "0");
    write(257, 6, "ustar\0");
    write(263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    write(148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
    const padded = new Uint8Array(Math.ceil(entry.content.byteLength / 512) * 512);
    padded.set(entry.content);
    blocks.push(header, padded);
  }
  const archive = new Uint8Array(blocks.reduce((sum, block) => sum + block.byteLength, 1024));
  let offset = 0;
  for (const block of blocks) { archive.set(block, offset); offset += block.byteLength; }
  return archive;
}
export function createOpenCodeProfileArchive(profileInput: ProviderProfile): Uint8Array {
  const profile = resolveProviderSelection(profileInput);
  const planPermissions = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
  ];
  const buildPermissions = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "deny" },
  ];
  const content = new TextEncoder().encode(JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    default_agent: "plan",
    update: "disable",
    model: `jarvis-gateway/${profile.modelId}`,
    agents: {
      plan: { mode: "primary", permissions: planPermissions },
      build: { mode: "primary", permissions: buildPermissions },
    },
    plugin: ["/opt/jarvis/opencode-usage-plugin"],
    mcp: {},
    providers: {
      "jarvis-gateway": {
        name: "JARVIS fixed gateway",
        env: ["LLM_GATEWAY_ATTEMPT_CAPABILITY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "http://127.0.0.1:4010/v1", encoding: "none" },
        models: { [profile.modelId]: { name: profile.modelId, limit: { context: profile.contextWindowTokens, output: profile.maxOutputTokens } } },
      },
    },
  }));
  const header = new Uint8Array(512);
  const write = (offset: number, length: number, value: string): void => {
    header.set(new TextEncoder().encode(value).subarray(0, length), offset);
  };
  const octal = (value: number, length: number): string => value.toString(8).padStart(length - 1, "0") + "\0";
  write(0, 100, "opencode.json");
  write(100, 8, octal(0o444, 8));
  write(108, 8, octal(10001, 8));
  write(116, 8, octal(10001, 8));
  write(124, 12, octal(content.byteLength, 12));
  write(136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  write(156, 1, "0");
  write(257, 6, "ustar\0");
  write(263, 2, "00");
  write(148, 8, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ");
  const padded = new Uint8Array(Math.ceil(content.byteLength / 512) * 512);
  padded.set(content);
  const archive = new Uint8Array(header.byteLength + padded.byteLength + 1024);
  archive.set(header);
  archive.set(padded, header.byteLength);
  return archive;
}

export function createGatewaySocketArchive(): Uint8Array {
  const header = new Uint8Array(512);
  const write = (offset: number, length: number, value: string): void => {
    header.set(new TextEncoder().encode(value).subarray(0, length), offset);
  };
  const octal = (value: number, length: number): string => value.toString(8).padStart(length - 1, "0") + "\0";
  write(0, 100, "jarvis/");
  write(100, 8, octal(0o770, 8));
  write(108, 8, octal(10001, 8));
  write(116, 8, octal(10001, 8));
  write(124, 12, octal(0, 12));
  write(136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  write(156, 1, "5");
  write(257, 6, "ustar\0");
  write(263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  write(148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
  const archive = new Uint8Array(1536);
  archive.set(header);
  return archive;
}

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
  gatewayFilter?: unknown;
  now?: () => Date;
  createId?: () => string;
  createCapability?: () => string;
};

export type SandboxStatus = {
  sandboxId: string;
  state: ContainerInspection["state"];
  deadline: string;
  profileId: string;
};

export type SandboxManager = {
  create(spec: unknown, idempotencyKey: string): Promise<SandboxStatus>;
  findByIdempotencyKey(spec: unknown, idempotencyKey: string): Promise<string | null>;
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
  configVolume?: string;
  configLabels?: ManagedLabels;
  socketVolume?: string;
  socketLabels?: ManagedLabels;
  internalNetwork?: string;
  egressNetwork?: string;
  gatewayId?: string;
  filterId?: string;
  gatewayLabels?: ManagedLabels;
  filterLabels?: ManagedLabels;
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
      exact("operation", "title", "mode", "profileId", "modelId");
      if (record.mode !== "plan" && record.mode !== "dev") invalid("Relay mode is invalid.");
      return {
        operation: "session.create",
        title: string("title", 200),
        mode: record.mode,
        profileId: string("profileId", 32),
        modelId: string("modelId", 128),
      };
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

export function parseTrustedGatewayFilterConfig(input: unknown): TrustedGatewayFilterProfile | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid("Trusted gateway/filter configuration must be an object.");
  const value = input as Record<string, unknown>;
  const keys = ["filterImage", "gatewayImage", "platform", "providerCatalog"].sort();
  if (Object.keys(value).sort().join(",") !== keys.join(",")) invalid("Trusted gateway/filter configuration contains unknown or missing fields.");
  if (typeof value.gatewayImage !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value.gatewayImage) ||
      typeof value.filterImage !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value.filterImage)) {
    invalid("Trusted gateway/filter images must use immutable digests.");
  }
  if (value.platform !== "linux/arm64") invalid("Trusted gateway/filter platform is invalid.");
  let catalog: ProviderCatalog;
  try { catalog = resolveProviderCatalog(value.providerCatalog); }
  catch { invalid("Trusted provider catalog is invalid."); }
  return Object.freeze({
    gatewayImage: value.gatewayImage,
    filterImage: value.filterImage,
    providerCatalog: value.providerCatalog as TrustedProviderCatalogConfiguration,
    activeProfile: catalog.active,
    platform: "linux/arm64",
  });
}

export function createSandboxManagerFromConfiguration(options: Omit<SandboxManagerOptions, "gatewayFilter"> & {
  readonly gatewayFilterConfig?: unknown;
}): SandboxManager {
  return createSandboxManager({
    engine: options.engine,
    profiles: options.profiles,
    ...(options.now ? { now: options.now } : {}),
    ...(options.createId ? { createId: options.createId } : {}),
    ...(options.createCapability ? { createCapability: options.createCapability } : {}),
    ...(options.gatewayFilterConfig === undefined ? {} : { gatewayFilter: options.gatewayFilterConfig }),
  });
}

function labelsFor(
  spec: SandboxSpec,
  sandboxId: string,
  profile: SandboxProfile,
  resourceKind: "container" | "workspace" | "state" | "gateway" | "filter" | "config-writer" | "egress-config" | "gateway-network" | "provider-network",
  idempotencyHash?: string,
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
    ...(resourceKind === "container" && idempotencyHash ? { [IDEMPOTENCY_LABEL]: idempotencyHash } : {}),
  };
}

function specFromLabels(labels: ManagedLabels, profile: SandboxProfile): SandboxSpec {
  const spec: SandboxSpec = {
    taskId: labels[TASK_LABEL] ?? "",
    attemptId: labels[ATTEMPT_LABEL] ?? "",
    snapshotId: labels[SNAPSHOT_LABEL] ?? "",
    profileId: profile.id,
    modelProfileId: labels[MODEL_PROFILE_LABEL] ?? "",
    deadline: labels[EXPIRY_LABEL] ?? "",
    leaseEpoch: Number(labels[LEASE_LABEL]),
  };
  validateSpec(spec);
  return spec;
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
  const gatewayFilter = options.gatewayFilter ? parseTrustedGatewayFilterConfig(options.gatewayFilter) : undefined;

  const now: () => Date = options.now ?? ((): Date => new Date());
  const createId: () => string = options.createId ?? ((): string => globalThis.crypto.randomUUID());
  const createCapability: () => string = options.createCapability ?? ((): string => {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });
  const managed = new Map<string, ManagedSandbox>();
  const idempotency = new Map<string, { fingerprint: string; result: SandboxStatus }>();
  const inFlight = new Map<string, { fingerprint: string; promise: Promise<SandboxStatus> }>();
  const preparing = new Map<string, { fingerprint: string; promise: Promise<SandboxStatus> }>();
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
      for (const [id, labels] of [[record.gatewayId, record.gatewayLabels], [record.filterId, record.filterLabels]] as const) {
        if (!id || !labels) continue;
        try {
          const inspection = await options.engine.inspectContainer(id);
          assertOwned(inspection.labels, labels);
          if (["running", "paused", "restarting"].includes(inspection.state)) await options.engine.stopContainer(id, 5);
          await options.engine.removeContainer(id, labels);
        } catch (error) {
          if (!(error instanceof SandboxManagerError) || error.code !== "NOT_FOUND") throw error;
        }
      }
      for (const [id, labels] of [[record.internalNetwork, labelsFor(record.spec, record.sandboxId, record.profile, "gateway-network")],
        [record.egressNetwork, labelsFor(record.spec, record.sandboxId, record.profile, "provider-network")]] as const) {
        if (!id) continue;
        try { await options.engine.removeNetwork(id, labels); }
        catch (error) { if (!(error instanceof SandboxManagerError) || error.code !== "NOT_FOUND") throw error; }
      }
      await options.engine.removeVolume(record.workspaceVolume, record.workspaceLabels);
      await options.engine.removeVolume(record.stateVolume, record.stateLabels);
      if (record.configVolume && record.configLabels) await options.engine.removeVolume(record.configVolume, record.configLabels);
      if (record.socketVolume && record.socketLabels) await options.engine.removeVolume(record.socketVolume, record.socketLabels);
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
    if (typeof idempotencyKey !== "string" || !/^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey)) invalid("A bounded idempotency key is required.");
    const fingerprint = fingerprintFor(spec);
    const pending = preparing.get(idempotencyKey);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new SandboxManagerError("Idempotency key is already being used for a different sandbox request.", "CONFLICT");
      return pending.promise;
    }
    const promise = createImpl(spec, idempotencyKey);
    preparing.set(idempotencyKey, { fingerprint, promise });
    try { return await promise; }
    finally { preparing.delete(idempotencyKey); }
  }

  async function createImpl(specInput: unknown, idempotencyKey: string): Promise<SandboxStatus> {
    const spec = validateSpec(specInput);
    if (typeof idempotencyKey !== "string" || !/^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      invalid("A bounded idempotency key is required.");
    }
    const profile = profiles.get(spec.profileId);
    if (!profile) invalid("Unknown sandbox profile.");
    if (gatewayFilter && spec.modelProfileId !== gatewayFilter.activeProfile.id) {
      throw new SandboxManagerError("Sandbox model profile does not match trusted active configuration.", "CONFLICT");
    }

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
    const idempotencyHash = createHash("sha256").update(idempotencyKey).digest("hex");
    const sameAttempt = [...managed.values()].find((record) =>
      record.spec.taskId === spec.taskId && record.spec.attemptId === spec.attemptId);
    if (sameAttempt) {
      if (fingerprintFor(sameAttempt.spec) !== fingerprint || sameAttempt.labels[IDEMPOTENCY_LABEL] !== idempotencyHash) {
        throw new SandboxManagerError("Task attempt already has a different managed sandbox request.", "CONFLICT");
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
      const labels = labelsFor(spec, sandboxId, profile, "container", idempotencyHash);
      const workspaceLabels = labelsFor(spec, sandboxId, profile, "workspace");
      const stateLabels = labelsFor(spec, sandboxId, profile, "state");
      const configVolume = gatewayFilter ? `jarvis-egress-config-${sandboxId}` : undefined;
      const socketVolume = gatewayFilter ? `jarvis-gateway-socket-${sandboxId}` : undefined;
      const configLabels = gatewayFilter ? labelsFor(spec, sandboxId, profile, "egress-config") : undefined;
      const socketLabels = gatewayFilter ? labelsFor(spec, sandboxId, profile, "gateway") : undefined;
      let workspaceCreated = false;
      let stateCreated = false;
      let configCreated = false;
      let socketCreated = false;
      let containerCreateAttempted = false;
      let sidecarCreateAttempted = false;
      let container: ContainerInspection | undefined;
      const sidecars: Array<{ id: string; labels: ManagedLabels }> = [];
      const networks: Array<{ id: string; labels: ManagedLabels }> = [];
      let internalNetworkId: string | undefined;
      let attemptCapability: string | undefined;
      let egressNetworkId: string | undefined;
      try {
        const workspace = await options.engine.createVolume({ name: workspaceVolume, labels: workspaceLabels });
        workspaceCreated = true;
        assertOwned(workspace.labels, workspaceLabels);
        const state = await options.engine.createVolume({ name: stateVolume, labels: stateLabels });
        stateCreated = true;
        assertOwned(state.labels, stateLabels);
        if (gatewayFilter && configVolume && socketVolume && configLabels && socketLabels) {
          const config = await options.engine.createVolume({ name: configVolume, labels: configLabels });
          configCreated = true;
          assertOwned(config.labels, configLabels);
          const socket = await options.engine.createVolume({ name: socketVolume, labels: socketLabels });
          socketCreated = true;
          assertOwned(socket.labels, socketLabels);
          const internalLabels = labelsFor(spec, sandboxId, profile, "gateway-network");
          const egressLabels = labelsFor(spec, sandboxId, profile, "provider-network");
          const internalNetwork = await options.engine.createNetwork({ name: `jarvis-internal-${sandboxId}`, internal: true, labels: internalLabels });
          internalNetworkId = internalNetwork.id;
          networks.push({ id: internalNetwork.id, labels: internalLabels });
          assertOwned(internalNetwork.labels, internalLabels);
          const egressNetwork = await options.engine.createNetwork({ name: `jarvis-egress-${sandboxId}`, internal: false, labels: egressLabels });
          egressNetworkId = egressNetwork.id;
          networks.push({ id: egressNetwork.id, labels: egressLabels });
          assertOwned(egressNetwork.labels, egressLabels);

          const writerLabels = labelsFor(spec, sandboxId, profile, "config-writer");
          sidecarCreateAttempted = true;
          const writer = await options.engine.createContainer({
            name: `jarvis-config-writer-${sandboxId}`, image: gatewayFilter.filterImage, platform: gatewayFilter.platform,
            entrypoint: ["python3", "/opt/jarvis/filter.py", "--config-writer"], user: "10001:10001", labels: writerLabels,
            networkMode: "none", readOnlyRootfs: true, privileged: false, capDrop: ["ALL"],
            securityOptions: ["no-new-privileges:true"], memoryBytes: 128 * 1024 ** 2, nanoCpus: 250_000_000,
            pidsLimit: 32, mounts: [{ type: "volume", source: configVolume, target: "/etc/jarvis", readOnly: false }],
          });
          sidecars.push({ id: writer.id, labels: writerLabels });
          assertOwned(writer.labels, writerLabels);
          await options.engine.startContainer(writer.id);
          attemptCapability = createCapability();
          await options.engine.putContainerArchive(writer.id, "/etc/jarvis", createAttemptConfigArchive(
            attemptCapability, gatewayFilter.activeProfile, `jarvis-egress-filter-${sandboxId}`, 8080,
            { taskId: spec.taskId, attemptId: spec.attemptId, leaseEpoch: spec.leaseEpoch },
          ));
          await options.engine.stopContainer(writer.id, 5);
          await options.engine.removeContainer(writer.id, writerLabels);
          sidecars.pop();
          const socketWriter = await options.engine.createContainer({
            name: `jarvis-socket-writer-${sandboxId}`, image: gatewayFilter.filterImage, platform: gatewayFilter.platform,
            entrypoint: ["python3", "/opt/jarvis/filter.py", "--config-writer"], user: "10001:10001", labels: writerLabels,
            networkMode: "none", readOnlyRootfs: true, privileged: false, capDrop: ["ALL"],
            securityOptions: ["no-new-privileges:true"], memoryBytes: 128 * 1024 ** 2, nanoCpus: 250_000_000,
            pidsLimit: 32, mounts: [{ type: "volume", source: socketVolume, target: "/etc/jarvis", readOnly: false }],
          });
          sidecars.push({ id: socketWriter.id, labels: writerLabels });
          assertOwned(socketWriter.labels, writerLabels);
          await options.engine.startContainer(socketWriter.id);
          await options.engine.putContainerArchive(socketWriter.id, "/etc/jarvis", createGatewaySocketArchive());
          await options.engine.putContainerArchive(socketWriter.id, "/etc/jarvis", createOpenCodeProfileArchive(gatewayFilter.activeProfile));
          await options.engine.stopContainer(socketWriter.id, 5);
          await options.engine.removeContainer(socketWriter.id, writerLabels);
          sidecars.pop();
          sidecarCreateAttempted = false;

          const filterLabels = labelsFor(spec, sandboxId, profile, "filter");
          sidecarCreateAttempted = true;
          const filter = await options.engine.createContainer({
            name: `jarvis-egress-filter-${sandboxId}`, image: gatewayFilter.filterImage, platform: gatewayFilter.platform,
            entrypoint: [], user: "10001:10001", labels: filterLabels, networkMode: "none", readOnlyRootfs: true,
            privileged: false, capDrop: ["ALL"], securityOptions: ["no-new-privileges:true"],
            memoryBytes: 256 * 1024 ** 2, nanoCpus: 500_000_000, pidsLimit: 64,
            mounts: [{ type: "volume", source: configVolume, target: "/etc/jarvis", readOnly: true }],
          });
          sidecars.push({ id: filter.id, labels: filterLabels });
          assertOwned(filter.labels, filterLabels);
          await options.engine.startContainer(filter.id);
          await options.engine.connectNetwork(internalNetworkId, filter.id, filterLabels);
          await options.engine.connectNetwork(egressNetworkId, filter.id, filterLabels);

          const gatewayLabels = labelsFor(spec, sandboxId, profile, "gateway");
          sidecarCreateAttempted = true;
          const gateway = await options.engine.createContainer({
            name: `jarvis-llm-gateway-${sandboxId}`, image: gatewayFilter.gatewayImage, platform: gatewayFilter.platform,
            entrypoint: [], user: "10001:10001", labels: gatewayLabels, networkMode: "none", readOnlyRootfs: true,
            privileged: false, capDrop: ["ALL"], securityOptions: ["no-new-privileges:true"],
            memoryBytes: 256 * 1024 ** 2, nanoCpus: 500_000_000, pidsLimit: 64,
            environment: {
              LLM_GATEWAY_SOCKET: "/run/jarvis/llm.sock",
              LLM_GATEWAY_ACCOUNTING_SOCKET: "/run/jarvis-accounting/accounting.sock",
            },
            mounts: [
              { type: "volume", source: configVolume, target: "/etc/jarvis", readOnly: true },
              { type: "volume", source: socketVolume, target: "/run", readOnly: false },
              { type: "volume", source: "jarvis-accounting-socket", target: "/run/jarvis-accounting", readOnly: false },
            ],
          });
          sidecars.push({ id: gateway.id, labels: gatewayLabels });
          assertOwned(gateway.labels, gatewayLabels);
          await options.engine.startContainer(gateway.id);
          await options.engine.connectNetwork(internalNetworkId, gateway.id, gatewayLabels);
          sidecarCreateAttempted = false;
        }
        if (gatewayFilter && !attemptCapability) invalid("The trusted gateway attempt capability was not generated.");
        containerCreateAttempted = true;
        container = await options.engine.createContainer({
          name: `jarvis-sandbox-${sandboxId}`,
          image: profile.image,
          platform: profile.platform,
          entrypoint: [ENTRYPOINT],
          user: gatewayFilter ? "0:0" : "10001:10001",
          labels,
          networkMode: "none",
          readOnlyRootfs: true,
          privileged: false,
          capDrop: ["ALL"],
          ...(gatewayFilter ? { capAdd: ["SETUID", "SETGID", "KILL"] as const } : {}),
          securityOptions: ["no-new-privileges:true"],
          memoryBytes: profile.memoryBytes,
          nanoCpus: profile.nanoCpus,
          pidsLimit: profile.pidsLimit,
          ...(gatewayFilter ? {
            environment: {
              LLM_GATEWAY_SOCKET: "/run/jarvis/llm.sock",
              LLM_GATEWAY_ATTEMPT_CAPABILITY: attemptCapability!,
              LLM_GATEWAY_PROFILE_ID: gatewayFilter.activeProfile.id,
              LLM_GATEWAY_MODEL: gatewayFilter.activeProfile.modelId,
              LLM_GATEWAY_CONTEXT_WINDOW_TOKENS: String(gatewayFilter.activeProfile.contextWindowTokens),
              LLM_GATEWAY_MAX_OUTPUT_TOKENS: String(gatewayFilter.activeProfile.maxOutputTokens),
              XDG_CONFIG_HOME: "/config",
            },
          } : {}),
          mounts: [
            { type: "volume", source: workspaceVolume, target: WORKSPACE_TARGET, readOnly: profile.readOnlyWorkspace },
            { type: "volume", source: stateVolume, target: STATE_TARGET, readOnly: false },
            ...(socketVolume ? [
              { type: "volume" as const, source: socketVolume, target: "/run" as const, readOnly: true },
              { type: "volume" as const, source: socketVolume, target: "/config/opencode" as const, readOnly: true },
            ] : []),
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
          ...(configVolume && configLabels ? { configVolume, configLabels } : {}),
          ...(socketVolume && socketLabels ? { socketVolume, socketLabels } : {}),
          ...(internalNetworkId ? { internalNetwork: internalNetworkId } : {}),
          ...(egressNetworkId ? { egressNetwork: egressNetworkId } : {}),
          ...(sidecars.find((item) => item.labels[RESOURCE_LABEL] === "gateway") ? {
            gatewayId: sidecars.find((item) => item.labels[RESOURCE_LABEL] === "gateway")!.id,
            gatewayLabels: sidecars.find((item) => item.labels[RESOURCE_LABEL] === "gateway")!.labels,
          } : {}),
          ...(sidecars.find((item) => item.labels[RESOURCE_LABEL] === "filter") ? {
            filterId: sidecars.find((item) => item.labels[RESOURCE_LABEL] === "filter")!.id,
            filterLabels: sidecars.find((item) => item.labels[RESOURCE_LABEL] === "filter")!.labels,
          } : {}),
        });
        idempotency.set(idempotencyKey, { fingerprint, result: status });
        return status;
      } catch {
        reconcileBeforeCreate = true;
        let safeToRemoveVolumes = !containerCreateAttempted && !sidecarCreateAttempted;
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
        for (const sidecar of sidecars.reverse()) {
          try {
            const current = await options.engine.inspectContainer(sidecar.id);
            assertOwned(current.labels, sidecar.labels);
            if (["running", "paused", "restarting"].includes(current.state)) await options.engine.stopContainer(sidecar.id, 5);
            await options.engine.removeContainer(sidecar.id, sidecar.labels);
          } catch { safeToRemoveVolumes = false; }
        }
        for (const network of networks.reverse()) {
          try { await options.engine.removeNetwork(network.id, network.labels); } catch { safeToRemoveVolumes = false; }
        }
        if (safeToRemoveVolumes && workspaceCreated) {
          try { await options.engine.removeVolume(workspaceVolume, workspaceLabels); } catch { /* Best-effort scoped compensation. */ }
        }
        if (safeToRemoveVolumes && stateCreated) {
          try { await options.engine.removeVolume(stateVolume, stateLabels); } catch { /* Best-effort scoped compensation. */ }
        }
        if (safeToRemoveVolumes && configCreated && configLabels && configVolume) {
          try { await options.engine.removeVolume(configVolume, configLabels); } catch { /* Best-effort scoped compensation. */ }
        }
        if (safeToRemoveVolumes && socketCreated && socketLabels && socketVolume) {
          try { await options.engine.removeVolume(socketVolume, socketLabels); } catch { /* Best-effort scoped compensation. */ }
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

  async function findByIdempotencyKey(specInput: unknown, idempotencyKey: string): Promise<string | null> {
    const spec = validateSpec(specInput);
    if (typeof idempotencyKey !== "string" || !/^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey)) invalid("A bounded idempotency key is required.");
    const fingerprint = fingerprintFor(spec);
    const prior = idempotency.get(idempotencyKey);
    const pending = preparing.get(idempotencyKey) ?? inFlight.get(idempotencyKey);
    if (prior && prior.fingerprint !== fingerprint || pending && pending.fingerprint !== fingerprint) {
      throw new SandboxManagerError("Idempotency key was already used for a different sandbox request.", "CONFLICT");
    }
    if (pending) return (await pending.promise).sandboxId;
    if (prior) return managed.has(prior.result.sandboxId) ? prior.result.sandboxId : null;
    const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
    const found = [...managed.values()].filter((record) => record.labels[IDEMPOTENCY_LABEL] === keyHash);
    if (found.some((record) => fingerprintFor(record.spec) !== fingerprint)) throw new SandboxManagerError("Idempotency key was already used for a different sandbox request.", "CONFLICT");
    if (found.length > 1) throw new SandboxManagerError("Idempotency key resolves to multiple managed sandboxes.", "CONFLICT");
    return found[0]?.sandboxId ?? null;
  }

  async function inspect(sandboxId: string): Promise<SandboxStatus> {
    const record = find(sandboxId);
    return status(record);
  }

  async function cancel(sandboxId: string, leaseEpoch: number): Promise<void> {
    const record = managed.get(sandboxId);
    if (!record) return;
    if (leaseEpoch !== record.spec.leaseEpoch) throw new SandboxManagerError("Sandbox lease epoch does not match.", "CONFLICT");
    if (new Date(record.spec.deadline).getTime() <= now().getTime()) {
      await remove(record);
      return;
    }
    const inspection = await options.engine.inspectContainer(record.engineId);
    assertOwned(inspection.labels, record.labels);
    if (["running", "paused", "restarting"].includes(inspection.state)) {
      await options.engine.stopContainer(record.engineId, 5);
    }
    for (const [id, labels] of [[record.gatewayId, record.gatewayLabels], [record.filterId, record.filterLabels]] as const) {
      if (!id || !labels) continue;
      const sidecar = await options.engine.inspectContainer(id);
      assertOwned(sidecar.labels, labels);
      if (["running", "paused", "restarting"].includes(sidecar.state)) await options.engine.stopContainer(id, 5);
    }
  }

  async function destroy(sandboxId: string, leaseEpoch: number): Promise<void> {
    const record = managed.get(sandboxId);
    if (!record) return;
    if (leaseEpoch !== record.spec.leaseEpoch) throw new SandboxManagerError("Sandbox lease epoch does not match.", "CONFLICT");
    await remove(record);
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
    if (request.operation === "session.create" &&
        (request.profileId !== gatewayFilter?.activeProfile.id || request.modelId !== gatewayFilter?.activeProfile.modelId)) {
      throw new SandboxManagerError("Session selected profile does not match trusted active configuration.", "CONFLICT");
    }
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
    const [containers, volumes, networks] = await Promise.all([
      options.engine.listManagedContainers(),
      options.engine.listManagedVolumes(),
      options.engine.listManagedNetworks(),
    ]);
    const containersBySandbox = new Map<string, ContainerInspection>();
    const sidecarsBySandbox = new Map<string, ContainerInspection[]>();
    for (const container of containers) {
      const labels = container.labels;
      if (labels[MANAGED_LABEL] !== "true") continue;
      const sandboxId = labels[SANDBOX_LABEL];
      if (!sandboxId || !/^[0-9a-f-]{36}$/i.test(sandboxId)) continue;
      if (labels[RESOURCE_LABEL] === "container") {
        if (containersBySandbox.has(sandboxId)) throw new SandboxManagerError("Duplicate manager-owned containers share a sandbox identity.", "CONFLICT");
        containersBySandbox.set(sandboxId, container);
      } else if (["gateway", "filter", "config-writer"].includes(labels[RESOURCE_LABEL] ?? "")) {
        const group = sidecarsBySandbox.get(sandboxId) ?? [];
        group.push(container);
        sidecarsBySandbox.set(sandboxId, group);
      }
    }
    const volumesBySandbox = new Map<string, Array<{ name: string; labels: ManagedLabels }>>();
    for (const volume of volumes) {
      const labels = volume.labels;
      if (labels[MANAGED_LABEL] !== "true" || !["workspace", "state", "egress-config", "gateway"].includes(labels[RESOURCE_LABEL] ?? "")) continue;
      const sandboxId = labels[SANDBOX_LABEL];
      if (!sandboxId || !/^[0-9a-f-]{36}$/i.test(sandboxId)) continue;
      const group = volumesBySandbox.get(sandboxId) ?? [];
      group.push(volume);
      volumesBySandbox.set(sandboxId, group);
    }
    const networksBySandbox = new Map<string, ManagedNetworkInspection[]>();
    for (const network of networks) {
      const labels = network.labels;
      if (labels[MANAGED_LABEL] !== "true" || !["gateway-network", "provider-network"].includes(labels[RESOURCE_LABEL] ?? "")) continue;
      const sandboxId = labels[SANDBOX_LABEL];
      if (!sandboxId || !/^[0-9a-f-]{36}$/i.test(sandboxId)) continue;
      const group = networksBySandbox.get(sandboxId) ?? [];
      group.push(network);
      networksBySandbox.set(sandboxId, group);
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
      const config = group.filter((item) => item.labels[RESOURCE_LABEL] === "egress-config");
      const socket = group.filter((item) => item.labels[RESOURCE_LABEL] === "gateway");
      const sidecars = sidecarsBySandbox.get(sandboxId) ?? [];
      const gateways = sidecars.filter((item) => item.labels[RESOURCE_LABEL] === "gateway");
      const filters = sidecars.filter((item) => item.labels[RESOURCE_LABEL] === "filter");
      const writers = sidecars.filter((item) => item.labels[RESOURCE_LABEL] === "config-writer");
      const networkGroup = networksBySandbox.get(sandboxId) ?? [];
      const internalNetworks = networkGroup.filter((item) => item.labels[RESOURCE_LABEL] === "gateway-network");
      const providerNetworks = networkGroup.filter((item) => item.labels[RESOURCE_LABEL] === "provider-network");
      const workspaceLabels = labelsFor(spec, sandboxId, profile, "workspace");
      const stateLabels = labelsFor(spec, sandboxId, profile, "state");
      if (!/^[a-f0-9]{64}$/.test(labels[IDEMPOTENCY_LABEL] ?? "")) throw new SandboxManagerError("Recovered sandbox is missing its idempotency identity.", "CONFLICT");
      assertOwned(labels, labelsFor(spec, sandboxId, profile, "container", labels[IDEMPOTENCY_LABEL]));
      if (!gatewayFilter && (config.length || socket.length || gateways.length || filters.length || writers.length || networkGroup.length)) {
        throw new SandboxManagerError("Recovered attempt has gateway/filter resources but no trusted sidecar profile is configured.", "CONFLICT");
      }
      const egressMissing = gatewayFilter && (config.length !== 1 || socket.length !== 1 || gateways.length !== 1 || filters.length !== 1 || internalNetworks.length !== 1 || providerNetworks.length !== 1);
      if (workspace.length !== 1 || state.length !== 1 || egressMissing) {
        if (new Date(spec.deadline).getTime() <= now().getTime()) {
          if (["running", "paused", "restarting"].includes(container.state)) await options.engine.stopContainer(container.id, 5);
          await options.engine.removeContainer(container.id, labelsFor(spec, sandboxId, profile, "container"));
          for (const item of sidecars) {
            const kind = item.labels[RESOURCE_LABEL];
            if (!["gateway", "filter", "config-writer"].includes(kind ?? "")) throw new SandboxManagerError("Recovered sidecar has an unknown manager resource kind.", "CONFLICT");
            assertOwned(item.labels, labelsFor(spec, sandboxId, profile, kind as "gateway" | "filter" | "config-writer"));
            if (["running", "paused", "restarting"].includes(item.state)) await options.engine.stopContainer(item.id, 5);
            await options.engine.removeContainer(item.id, item.labels);
          }
          for (const item of networkGroup) {
            const kind = item.labels[RESOURCE_LABEL];
            if (!["gateway-network", "provider-network"].includes(kind ?? "")) throw new SandboxManagerError("Recovered network has an unknown manager resource kind.", "CONFLICT");
            assertOwned(item.labels, labelsFor(spec, sandboxId, profile, kind as "gateway-network" | "provider-network"));
            await options.engine.removeNetwork(item.id, item.labels);
          }
          for (const item of group) {
            const kind = item.labels[RESOURCE_LABEL];
            if (!["workspace", "state", "egress-config", "gateway"].includes(kind ?? "")) throw new SandboxManagerError("Recovered volume has an unknown manager resource kind.", "CONFLICT");
            assertOwned(item.labels, labelsFor(spec, sandboxId, profile, kind as "workspace" | "state" | "egress-config" | "gateway"));
            await options.engine.removeVolume(item.name, item.labels);
          }
          continue;
        }
        throw new SandboxManagerError("A live managed sandbox is missing its expected private volumes.", "CONFLICT");
      }
      assertOwned(workspace[0]!.labels, workspaceLabels);
      assertOwned(state[0]!.labels, stateLabels);
      let configLabels: ManagedLabels | undefined;
      let socketLabels: ManagedLabels | undefined;
      if (gatewayFilter) {
        configLabels = labelsFor(spec, sandboxId, profile, "egress-config");
        socketLabels = labelsFor(spec, sandboxId, profile, "gateway");
        assertOwned(config[0]!.labels, configLabels);
        assertOwned(socket[0]!.labels, socketLabels);
        assertOwned(gateways[0]!.labels, labelsFor(spec, sandboxId, profile, "gateway"));
        assertOwned(filters[0]!.labels, labelsFor(spec, sandboxId, profile, "filter"));
        assertOwned(internalNetworks[0]!.labels, labelsFor(spec, sandboxId, profile, "gateway-network"));
        assertOwned(providerNetworks[0]!.labels, labelsFor(spec, sandboxId, profile, "provider-network"));
        const internalAttached = [...internalNetworks[0]!.containerIds].sort();
        const providerAttached = [...providerNetworks[0]!.containerIds].sort();
        if (internalAttached.join(",") !== [gateways[0]!.id, filters[0]!.id].sort().join(",") ||
            providerAttached.join(",") !== filters[0]!.id) {
          throw new SandboxManagerError("Recovered gateway/filter network graph does not match the trusted attachment contract.", "CONFLICT");
        }
        for (const writer of writers) {
          assertOwned(writer.labels, labelsFor(spec, sandboxId, profile, "config-writer"));
          if (["running", "paused", "restarting"].includes(writer.state)) await options.engine.stopContainer(writer.id, 5);
          await options.engine.removeContainer(writer.id, writer.labels);
        }
      }
      const record: ManagedSandbox = {
        sandboxId,
        engineId: container.id,
        workspaceVolume: workspace[0]!.name,
        stateVolume: state[0]!.name,
        spec,
        profile,
        labels,
        workspaceLabels,
        stateLabels,
        ...(gatewayFilter && configLabels ? { configVolume: config[0]!.name, configLabels } : {}),
        ...(gatewayFilter && socketLabels ? { socketVolume: socket[0]!.name, socketLabels } : {}),
        ...(gatewayFilter ? { internalNetwork: internalNetworks[0]!.id, egressNetwork: providerNetworks[0]!.id,
          gatewayId: gateways[0]!.id, gatewayLabels: gateways[0]!.labels,
          filterId: filters[0]!.id, filterLabels: filters[0]!.labels } : {}),
      };
      if (new Date(spec.deadline).getTime() <= now().getTime()) await remove(record);
      else managed.set(sandboxId, record);
    }

    for (const [sandboxId, group] of sidecarsBySandbox) {
      if (containersBySandbox.has(sandboxId)) continue;
      for (const item of group) {
        const profile = profiles.get(item.labels[PROFILE_LABEL] ?? "");
        if (!profile) throw new SandboxManagerError("Orphaned manager sidecar references an unavailable profile.", "CONFLICT");
        const spec = specFromLabels(item.labels, profile);
        const kind = item.labels[RESOURCE_LABEL];
        if (!["gateway", "filter", "config-writer"].includes(kind ?? "")) throw new SandboxManagerError("Orphaned manager sidecar has an unknown resource kind.", "CONFLICT");
        const expected = labelsFor(spec, sandboxId, profile, kind as "gateway" | "filter" | "config-writer");
        assertOwned(item.labels, expected);
        if (["running", "paused", "restarting"].includes(item.state)) await options.engine.stopContainer(item.id, 5);
        await options.engine.removeContainer(item.id, expected);
      }
    }
    for (const [sandboxId, group] of networksBySandbox) {
      if (containersBySandbox.has(sandboxId)) continue;
      for (const network of group) {
        const profile = profiles.get(network.labels[PROFILE_LABEL] ?? "");
        if (!profile) throw new SandboxManagerError("Orphaned manager network references an unavailable profile.", "CONFLICT");
        const spec = specFromLabels(network.labels, profile);
        const kind = network.labels[RESOURCE_LABEL];
        if (!["gateway-network", "provider-network"].includes(kind ?? "")) throw new SandboxManagerError("Orphaned manager network has an unknown resource kind.", "CONFLICT");
        const expected = labelsFor(spec, sandboxId, profile, kind as "gateway-network" | "provider-network");
        assertOwned(network.labels, expected);
        await options.engine.removeNetwork(network.id, expected);
      }
    }
    for (const [sandboxId, group] of volumesBySandbox) {
      if (containersBySandbox.has(sandboxId)) continue;
      for (const volume of group) {
        const profile = profiles.get(volume.labels[PROFILE_LABEL] ?? "");
        if (!profile) throw new SandboxManagerError("Orphaned manager volume references an unavailable profile.", "CONFLICT");
        const spec = specFromLabels(volume.labels, profile);
        const kind = volume.labels[RESOURCE_LABEL];
        if (!["workspace", "state", "egress-config", "gateway"].includes(kind ?? "")) throw new SandboxManagerError("Orphaned manager volume has an unknown resource kind.", "CONFLICT");
        const expected = labelsFor(spec, sandboxId, profile, kind as "workspace" | "state" | "egress-config" | "gateway");
        assertOwned(volume.labels, expected);
        await options.engine.removeVolume(volume.name, expected);
      }
    }
  }

  return { create, findByIdempotencyKey, inspect, cancel, destroy, runtime, expire, recover };
}
