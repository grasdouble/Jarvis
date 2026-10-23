import { createHash } from "node:crypto";
import { RequestConflictError, type InitialProjectConfiguration, type NewProjectConfiguration, type ProjectConfigurationChanges, type ProjectConfigurationRecord, type ProjectConfigurationStore, type ProjectSnapshot, type RequestAuthorization } from "@jarvis/domain";
import type { SqlClient, SqlPool } from "./index.js";

interface ProjectRow {
  project_id: string;
  repository_id: string;
  installation_id: string;
  repository_owner: string;
  repository_name: string;
  state: ProjectConfigurationRecord["state"];
  config_version: number;
  config_json: unknown;
  config_hash: string;
  policy_hash: string;
}

interface AuthorizationRow extends ProjectRow {
  installation_active: boolean;
}

interface StoredProjectConfiguration {
  readonly schemaVersion: 1;
  readonly repository: { readonly owner: string; readonly name: string };
  readonly profileHash: string;
}

const HASH = /^[a-f0-9]{64}$/;
const REPOSITORY_ID = /^[1-9][0-9]{0,18}$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SELECT_PROJECT = `p.id AS project_id, p.repository_id::text AS repository_id, p.installation_id,
  p.owner_id AS repository_owner, p.repository_name, p.state, p.config_version,
  c.config_json, c.config_hash, c.policy_hash`;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Project configuration must contain finite JSON numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Project configuration must be JSON data.");
  const object = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Project configuration objects must be plain.");
  const descriptors = Object.getOwnPropertyDescriptors(object);
  const keys = Reflect.ownKeys(object);
  for (const key of keys) {
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError("Project configuration must contain enumerable data fields only.");
    }
  }
  return `{${(keys as string[]).sort().map((key) => `${JSON.stringify(key)}:${canonical(descriptors[key]!.value)}`).join(",")}}`;
}

function validateRepositoryId(repositoryId: string): void {
  if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId) || BigInt(repositoryId) > MAX_BIGINT) {
    throw new TypeError("Repository identity must be a canonical positive decimal string.");
  }
}

function validateActor(actorId: string): void {
  if (actorId !== "owner") throw new TypeError("Only the authenticated owner may change project configuration.");
}

function validateName(value: string, field: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 100 || !/^[A-Za-z0-9_.-]+$/.test(value)
    || value === "." || value === "..") throw new TypeError(`${field} is invalid.`);
}

function validateSeed(seed: InitialProjectConfiguration): void {
  if (!HASH.test(seed.policyHash) || !HASH.test(seed.profileHash)) throw new TypeError("Trusted project configuration references are invalid.");
}

function assertVersion(expectedVersion: number): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion >= 2_147_483_647) {
    throw new TypeError("Expected configuration version is invalid.");
  }
}

function asConfig(value: unknown, row: ProjectRow): StoredProjectConfiguration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Persisted project configuration is malformed.");
  const config = value as Record<string, unknown>;
  if (config.schemaVersion !== 1 || config.profileHash === undefined || !HASH.test(String(config.profileHash))
    || config.repository === null || typeof config.repository !== "object" || Array.isArray(config.repository)) {
    throw new Error("Persisted project configuration is malformed.");
  }
  const repository = config.repository as Record<string, unknown>;
  if (repository.owner !== row.repository_owner || repository.name !== row.repository_name) {
    throw new Error("Persisted project identity does not match its configuration version.");
  }
  const normalized: StoredProjectConfiguration = {
    schemaVersion: 1,
    repository: { owner: row.repository_owner, name: row.repository_name },
    profileHash: String(config.profileHash),
  };
  if (digest(canonical(normalized)) !== row.config_hash.trim()) throw new Error("Persisted project configuration hash is invalid.");
  if (!HASH.test(row.policy_hash.trim())) throw new Error("Persisted project policy reference is invalid.");
  return normalized;
}

function projectRecord(row: ProjectRow): ProjectConfigurationRecord {
  if (!UUID.test(row.project_id) || !UUID.test(row.installation_id) || !REPOSITORY_ID.test(row.repository_id)
    || BigInt(row.repository_id) > MAX_BIGINT || !Number.isSafeInteger(row.config_version) || row.config_version < 1
    || !["active", "suspended", "removed"].includes(row.state)) {
    throw new Error("Persisted project configuration row is malformed.");
  }
  const config = asConfig(row.config_json, row);
  return {
    projectId: row.project_id,
    repositoryId: row.repository_id,
    installationId: row.installation_id,
    repositoryOwner: row.repository_owner,
    repositoryName: row.repository_name,
    state: row.state,
    configVersion: row.config_version,
    policyHash: row.policy_hash.trim(),
    profileHash: config.profileHash,
  };
}

function createConfig(repositoryOwner: string, repositoryName: string, profileHash: string): StoredProjectConfiguration {
  const config = {
    schemaVersion: 1 as const,
    repository: { owner: repositoryOwner, name: repositoryName },
    profileHash,
  };
  canonical(config);
  return config;
}

function conflictForDatabaseIdentity(error: unknown): never {
  if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505") {
    throw new RequestConflictError("PROJECT_IDENTITY_CONFLICT");
  }
  throw error;
}

async function audit(client: SqlClient, actorId: string, repositoryId: string, action: string, details: unknown): Promise<void> {
  await client.query(`
    INSERT INTO jarvis.audit_events (actor, action, resource, details_hash)
    VALUES ($1, $2, $3, $4)
  `, [actorId, action, `project:${repositoryId}`, digest(canonical(details))]);
}

/** PostgreSQL project allowlist/configuration adapter. Every mutation serializes on the project row. */
export class PostgresProjectConfigStore implements ProjectConfigurationStore {
  constructor(private readonly pool: SqlPool) {}

  async list(): Promise<readonly ProjectConfigurationRecord[]> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<ProjectRow>(`
        SELECT ${SELECT_PROJECT}
        FROM jarvis.projects p
        JOIN jarvis.project_config_versions c
          ON c.project_id=p.id AND c.repository_id=p.repository_id AND c.version=p.config_version
        ORDER BY p.repository_id
      `);
      return rows.map(projectRecord);
    } finally { client.release(); }
  }

  async add(actorId: string, input: NewProjectConfiguration, initial: InitialProjectConfiguration): Promise<ProjectConfigurationRecord> {
    validateActor(actorId);
    validateRepositoryId(input.repositoryId);
    if (!UUID.test(input.installationId)) throw new TypeError("Installation identity must be a UUID.");
    validateName(input.repositoryOwner, "repositoryOwner");
    validateName(input.repositoryName, "repositoryName");
    validateSeed(initial);
    const config = createConfig(input.repositoryOwner, input.repositoryName, initial.profileHash);
    const encoded = canonical(config);
    const configHash = digest(encoded);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: existing } = await client.query<{ id: string }>(`
        SELECT id FROM jarvis.projects WHERE repository_id=$1 FOR UPDATE
      `, [input.repositoryId]);
      if (existing.length) throw new RequestConflictError("PROJECT_IDENTITY_CONFLICT");
      const { rows: installations } = await client.query<{ id: string }>(`
        SELECT id FROM jarvis.installations
        WHERE id=$1 AND state='active' AND revoked_at IS NULL
        FOR SHARE
      `, [input.installationId]);
      if (!installations[0]) throw new RequestConflictError("PROJECT_INSTALLATION_UNAVAILABLE");
      const { rows: policies } = await client.query<{ hash: string }>(`
        SELECT hash FROM jarvis.policies WHERE hash=$1 AND activated_at IS NOT NULL FOR SHARE
      `, [initial.policyHash]);
      if (!policies[0]) throw new RequestConflictError("PROJECT_CONFIGURATION_UNAVAILABLE");
      const { rows } = await client.query<ProjectRow>(`
        INSERT INTO jarvis.projects
          (repository_id, installation_id, owner_id, repository_name, state, config_version)
        VALUES ($1,$2,$3,$4,'active',1)
        RETURNING id AS project_id, repository_id::text AS repository_id, installation_id,
          owner_id AS repository_owner, repository_name, state, config_version
      `, [input.repositoryId, input.installationId, input.repositoryOwner, input.repositoryName]);
      const project = rows[0];
      if (!project) throw new Error("Project insert did not return its row.");
      project.config_json = config;
      project.config_hash = configHash;
      project.policy_hash = initial.policyHash;
      await client.query(`
        INSERT INTO jarvis.project_config_versions
          (project_id, repository_id, version, config_json, config_hash, policy_hash, created_by)
        VALUES ($1,$2,1,$3::jsonb,$4,$5,$6)
      `, [project.project_id, input.repositoryId, encoded, configHash, initial.policyHash, actorId]);
      await audit(client, actorId, input.repositoryId, "project.added", {
        repositoryId: input.repositoryId, configVersion: 1, state: "active",
      });
      await client.query("COMMIT");
      return projectRecord(project);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      conflictForDatabaseIdentity(error);
    } finally { client.release(); }
  }

  async update(actorId: string, repositoryId: string, expectedVersion: number, changes: ProjectConfigurationChanges): Promise<ProjectConfigurationRecord> {
    return this.writeVersion(actorId, repositoryId, expectedVersion, changes, "project.updated");
  }

  async remove(actorId: string, repositoryId: string, expectedVersion: number): Promise<ProjectConfigurationRecord> {
    return this.writeVersion(actorId, repositoryId, expectedVersion, { state: "removed" }, "project.removed");
  }

  private async writeVersion(
    actorId: string,
    repositoryId: string,
    expectedVersion: number,
    changes: ProjectConfigurationChanges,
    action: string,
  ): Promise<ProjectConfigurationRecord> {
    validateActor(actorId);
    validateRepositoryId(repositoryId);
    assertVersion(expectedVersion);
    if (changes.repositoryOwner !== undefined) validateName(changes.repositoryOwner, "repositoryOwner");
    if (changes.repositoryName !== undefined) validateName(changes.repositoryName, "repositoryName");
    if (changes.state !== undefined && !["active", "suspended", "removed"].includes(changes.state)) throw new TypeError("Project state is invalid.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: locked } = await client.query<{ id: string }>(`
        SELECT id FROM jarvis.projects WHERE repository_id=$1 FOR UPDATE
      `, [repositoryId]);
      if (!locked[0]) throw new RequestConflictError("PROJECT_NOT_FOUND");
      const { rows } = await client.query<ProjectRow>(`
        SELECT ${SELECT_PROJECT}
        FROM jarvis.projects p
        JOIN jarvis.project_config_versions c
          ON c.project_id=p.id AND c.repository_id=p.repository_id AND c.version=p.config_version
        WHERE p.repository_id=$1
      `, [repositoryId]);
      const existing = rows[0];
      if (!existing) throw new RequestConflictError("PROJECT_NOT_FOUND");
      const current = projectRecord(existing);
      if (current.configVersion !== expectedVersion) throw new RequestConflictError("PROJECT_CONFIG_VERSION_CONFLICT");
      if (action === "project.removed" && current.state === "removed") throw new RequestConflictError("PROJECT_NOT_ACTIVE");
      if (current.configVersion >= 2_147_483_646) throw new RequestConflictError("PROJECT_CONFIG_VERSION_CONFLICT");
      const repositoryOwner = changes.repositoryOwner ?? current.repositoryOwner;
      const repositoryName = changes.repositoryName ?? current.repositoryName;
      const state = changes.state ?? current.state;
      const configVersion = current.configVersion + 1;
      const config = createConfig(repositoryOwner, repositoryName, current.profileHash);
      const encoded = canonical(config);
      const configHash = digest(encoded);
      const { rows: updatedRows } = await client.query<ProjectRow>(`
        UPDATE jarvis.projects
        SET owner_id=$2, repository_name=$3, state=$4, config_version=$5, updated_at=clock_timestamp()
        WHERE id=$1 AND config_version=$6
        RETURNING id AS project_id, repository_id::text AS repository_id, installation_id,
          owner_id AS repository_owner, repository_name, state, config_version
      `, [current.projectId, repositoryOwner, repositoryName, state, configVersion, expectedVersion]);
      const updated = updatedRows[0];
      if (!updated) throw new RequestConflictError("PROJECT_CONFIG_VERSION_CONFLICT");
      updated.config_json = config;
      updated.config_hash = configHash;
      updated.policy_hash = current.policyHash;
      await client.query(`
        INSERT INTO jarvis.project_config_versions
          (project_id, repository_id, version, config_json, config_hash, policy_hash, created_by)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
      `, [current.projectId, repositoryId, configVersion, encoded, configHash, current.policyHash, actorId]);
      await audit(client, actorId, repositoryId, action, {
        repositoryId, previousVersion: expectedVersion, configVersion,
        previousState: current.state, state,
        changedFields: Object.keys(changes).sort(),
      });
      await client.query("COMMIT");
      return projectRecord(updated);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      conflictForDatabaseIdentity(error);
    } finally { client.release(); }
  }
}

/** Request authorization reads only the current JARVIS allowlist and immutable config version. */
export class PostgresProjectRequestAuthorization implements RequestAuthorization {
  constructor(private readonly pool: SqlPool) {}

  projectById(id: string): Promise<ProjectSnapshot | null> {
    if (!UUID.test(id)) return Promise.resolve(null);
    return this.find(`p.id=$1`, [id]);
  }

  projectByRepository(repository: string): Promise<ProjectSnapshot | null> {
    if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) return Promise.resolve(null);
    return this.find(`lower(p.owner_id || '/' || p.repository_name)=lower($1)`, [repository]);
  }

  currentProject(id: string): Promise<ProjectSnapshot | null> {
    return this.projectById(id);
  }

  private async find(predicate: string, values: readonly unknown[]): Promise<ProjectSnapshot | null> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<AuthorizationRow>(`
        SELECT ${SELECT_PROJECT}, (i.state='active' AND i.revoked_at IS NULL) AS installation_active
        FROM jarvis.projects p
        JOIN jarvis.project_config_versions c
          ON c.project_id=p.id AND c.repository_id=p.repository_id AND c.version=p.config_version
        JOIN jarvis.installations i ON i.id=p.installation_id
        WHERE ${predicate}
        ORDER BY p.id
        LIMIT 2
      `, values);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) return null;
      const record = projectRecord(row);
      return {
        id: record.projectId,
        repositoryId: record.repositoryId,
        configVersion: record.configVersion,
        policyHash: record.policyHash,
        profileHash: record.profileHash,
        active: record.state === "active" && row.installation_active,
      };
    } finally { client.release(); }
  }
}
