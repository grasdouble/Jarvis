export type RequestMode = "plan" | "dev";
export type RequestKind = "project" | "dependency_update";
export type IntakeState = "clarification" | "queued" | "blocked";

export interface ProjectSnapshot {
  id: string;
  repositoryId: string;
  configVersion: number;
  policyHash: string;
  profileHash: string;
  active: boolean;
}

export interface RequestSubmission {
  idempotencyKey: string;
  projectId?: string;
  repository?: string;
  mode?: RequestMode;
  prompt: string;
  kind?: RequestKind;
}

export interface RequestRecord {
  id: string;
  ownerId: string;
  projectId: string | null;
  repositoryId: string | null;
  mode: RequestMode | null;
  kind: RequestKind;
  prompt: string | null;
  promptDigest: string;
  configVersion: number | null;
  policyHash: string | null;
  state: IntakeState;
  clarification: readonly string[];
  idempotencyKey: string;
  requestDigest: string | null;
  selector: string | null;
  explicitMode: RequestMode | null;
  explicitKind: RequestKind | null;
  version: number;
  profileHash: string | null;
  clarificationDigest: string | null;
}

/** Trusted persistence boundary. Implementations must atomically deduplicate and enqueue only queued records. */
export interface RequestIntakeStore {
  findByIdempotency(ownerId: string, key: string): Promise<RequestRecord | null>;
  create(record: RequestRecord): Promise<RequestRecord>;
  getOwned(id: string, ownerId: string): Promise<RequestRecord | null>;
  replaceClarification(record: RequestRecord, expectedVersion: number): Promise<RequestRecord>;
}

export interface RequestAuthorization {
  projectById(id: string): Promise<ProjectSnapshot | null>;
  projectByRepository(repository: string): Promise<ProjectSnapshot | null>;
  currentProject(id: string): Promise<ProjectSnapshot | null>;
}

export class RequestConflictError extends Error {
  constructor(message: string) { super(message); this.name = "RequestConflictError"; }
}

async function sha256(value: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function submissionDigest(input: RequestSubmission): Promise<string> {
  return sha256(JSON.stringify({ prompt: input.prompt, projectId: input.projectId ?? null, repository: input.repository ?? null, mode: input.mode ?? null, kind: input.kind ?? null }));
}

function selectorIdentity(input: RequestSubmission): string | null {
  if (!input.projectId && !input.repository) return null;
  return JSON.stringify({ projectId: input.projectId ?? null, repository: input.repository ?? null });
}

/** Admit only authenticated, explicit owner intent. Repository/event data is never an authorization source. */
export class ProjectRequestIntake {
  constructor(
    private readonly store: RequestIntakeStore,
    private readonly authorization: RequestAuthorization,
    private readonly id: () => string,
  ) {}

  async submit(ownerId: string, input: RequestSubmission): Promise<RequestRecord> {
    if (!ownerId || ownerId.length > 200) throw new TypeError("Authenticated owner is required.");
    if (!input || typeof input.prompt !== "string" || input.prompt.trim().length === 0 || input.prompt.length > 20_000) {
      throw new TypeError("Prompt must contain 1–20000 characters.");
    }
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(input.idempotencyKey)) throw new TypeError("Invalid idempotency key.");
    if (input.mode !== undefined && input.mode !== "plan" && input.mode !== "dev") throw new TypeError("Mode must be plan or dev.");
    if (input.kind !== undefined && input.kind !== "project" && input.kind !== "dependency_update") throw new TypeError("Unsupported request kind.");
    const hash = await sha256(input.prompt);
    const requestDigest = await submissionDigest(input);
    const prior = await this.store.findByIdempotency(ownerId, input.idempotencyKey);
    if (prior) {
      if (prior.prompt === null || prior.requestDigest === null) {
        throw new RequestConflictError("Legacy request lacks replay-safe prompt and digest binding.");
      }
      if (prior.requestDigest !== requestDigest) throw new RequestConflictError("Idempotency key was already used for a different request.");
      return prior;
    }
    // Every supplied selector must independently resolve to the same internally authorized project.
    const byId = input.projectId ? await this.authorization.projectById(input.projectId) : null;
    const byRepository = input.repository ? await this.authorization.projectByRepository(input.repository) : null;
    const project = byId ?? byRepository;
    if ((input.projectId || input.repository) &&
        (!project || !project.active || (input.projectId !== undefined && !byId) ||
          (input.repository !== undefined && !byRepository) ||
          (byId && byRepository && (byId.id !== byRepository.id || !byRepository.active)))) {
      throw new RequestConflictError("Repository is not internally authorized.");
    }
    const clarification = [
      ...(!project ? ["project"] : []),
      ...(!input.mode ? ["mode"] : []),
    ];
    const record: RequestRecord = {
      id: this.id(), ownerId, projectId: project?.id ?? null, repositoryId: project?.repositoryId ?? null,
      mode: input.mode ?? null, kind: input.kind ?? "project", prompt: input.prompt, promptDigest: hash,
      configVersion: project?.configVersion ?? null, policyHash: project?.policyHash ?? null,
      state: clarification.length ? "clarification" : "queued", clarification,
      idempotencyKey: input.idempotencyKey,
      requestDigest, selector: selectorIdentity(input),
      explicitMode: input.mode ?? null, explicitKind: input.kind ?? null, version: 1,
      profileHash: project?.profileHash ?? null,
      clarificationDigest: null,
    };
    return this.store.create(record);
  }

  async clarify(ownerId: string, requestId: string, expectedVersion: number, answer: RequestSubmission): Promise<RequestRecord> {
    const existing = await this.store.getOwned(requestId, ownerId);
    if (!existing) throw new RequestConflictError("No owned clarification is pending.");
    if (existing.prompt === null || existing.requestDigest === null) {
      throw new RequestConflictError("Legacy request lacks prompt and digest binding and cannot be clarified.");
    }
    if (answer.prompt !== existing.prompt || answer.idempotencyKey !== existing.idempotencyKey) {
      throw new RequestConflictError("Clarification must resume the same request and idempotency key.");
    }
    const answerDigest = await submissionDigest(answer);
    if (existing.state === "queued" && existing.clarificationDigest === answerDigest && existing.version === expectedVersion + 1) return existing;
    if (existing.state !== "clarification") throw new RequestConflictError("No owned clarification is pending.");
    if (existing.version !== expectedVersion) throw new RequestConflictError("Clarification version is stale.");
    if (answer.mode !== undefined && answer.mode !== "plan" && answer.mode !== "dev") throw new TypeError("Mode must be plan or dev.");
    if (existing.explicitMode && answer.mode && existing.explicitMode !== answer.mode) throw new RequestConflictError("Clarification cannot change the explicitly selected mode.");
    if (existing.explicitKind && answer.kind && existing.explicitKind !== answer.kind) throw new RequestConflictError("Clarification cannot change the explicitly selected request kind.");
    if (existing.selector && selectorIdentity(answer) && existing.selector !== selectorIdentity(answer)) {
      throw new RequestConflictError("Clarification cannot change the original project selector.");
    }
    const byId = answer.projectId ? await this.authorization.projectById(answer.projectId) : null;
    const byRepository = answer.repository ? await this.authorization.projectByRepository(answer.repository) : null;
    if (byId && byRepository && byId.id !== byRepository.id) throw new RequestConflictError("Conflicting project selectors.");
    const project = byId ?? byRepository ?? (existing.projectId ? await this.authorization.projectById(existing.projectId) : null);
    const current = project ? await this.authorization.currentProject(project.id) : null;
    if (!project || !project.active || !current?.active || project.repositoryId !== current.repositoryId) {
      throw new RequestConflictError("Project authorization could not be revalidated.");
    }
    if (existing.configVersion !== null &&
        (existing.configVersion !== current.configVersion || existing.policyHash !== current.policyHash)) {
      throw new RequestConflictError("Project configuration or policy changed; submit a new request.");
    }
    const mode = answer.mode ?? existing.mode;
    if (!mode) throw new RequestConflictError("Explicit plan or dev mode is required.");
    const record: RequestRecord = {
      ...existing, projectId: current.id, repositoryId: current.repositoryId, mode,
      kind: answer.kind ?? existing.kind, configVersion: current.configVersion, policyHash: current.policyHash,
      profileHash: current.profileHash,
      clarificationDigest: answerDigest,
      version: existing.version + 1,
      state: "queued", clarification: [],
    };
    return this.store.replaceClarification(record, existing.version);
  }
}
