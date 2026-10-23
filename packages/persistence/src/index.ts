import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface SqlClient {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
  release(): void;
}

export interface SqlPool {
  connect(): Promise<SqlClient>;
}

export interface CheckpointInput {
  taskId: string;
  attemptId: string;
  projectId: string;
  leaseEpoch: number;
  step: string;
  schemaVersion: number;
  state: CheckpointState;
  requiredSkills: readonly { skillId: string; revisionDigest: string }[];
}

export interface CheckpointState {
  phase: "request_admitted" | "snapshot_bound" | "plan_validated" | "artifact_recorded" | "publication_reconciled";
  configVersion: number;
  policyHash: string;
  revisionDigest?: string;
  artifactDigest?: string;
  reportId?: string;
  actionIntentId?: string;
  completedStep?: string;
  reasonCodes?: readonly string[];
}

export interface SavedCheckpoint {
  id: string;
  stateDigest: string;
}

export interface LoadedCheckpoint {
  id: string;
  step: string;
  schemaVersion: number;
  state: CheckpointState;
  stateDigest: string;
}

export class CheckpointRejectedError extends Error {
  constructor() {
    super("Checkpoint was not saved: the task lease, project authorization, or skill consent is no longer valid.");
    this.name = "CheckpointRejectedError";
  }
}

const MIGRATION_LOCK_ID = 0x4a415256;
const MAX_CHECKPOINT_BYTES = 4096;
const CHECKPOINT_FIELDS = new Set([
  "phase", "revisionDigest", "artifactDigest", "reportId", "actionIntentId",
  "configVersion", "policyHash", "completedStep", "reasonCodes",
]);
const CHECKPOINT_FIELD_ORDER = [
  "phase", "configVersion", "policyHash", "revisionDigest", "artifactDigest",
  "reportId", "actionIntentId", "completedStep", "reasonCodes",
] as const;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeReasonCodes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 16) {
    throw new TypeError("reasonCodes must contain at most 16 stable codes.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^\d+$/.test(key)))) {
    throw new TypeError("reasonCodes must be a dense plain array.");
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError("reasonCodes must contain only enumerable data values.");
    }
    if (typeof descriptor.value !== "string" || !/^[a-z0-9_.-]{1,64}$/.test(descriptor.value)) {
      throw new TypeError("reasonCodes must contain only bounded stable codes.");
    }
    result.push(descriptor.value);
  }
  return result;
}

function validateCheckpointState(state: CheckpointState): string {
  if (state === null || Array.isArray(state) || typeof state !== "object") {
    throw new TypeError("Checkpoint state must be a JSON object.");
  }
  const prototype = Object.getPrototypeOf(state);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Checkpoint state must be a plain object.");
  const descriptors = Object.getOwnPropertyDescriptors(state);
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(state)) {
    if (typeof key !== "string" || !CHECKPOINT_FIELDS.has(key)) {
      throw new TypeError(`Checkpoint field '${String(key)}' is not part of the closed core-state contract.`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError("Checkpoint state must contain only enumerable data properties.");
    }
  }
  for (const key of CHECKPOINT_FIELD_ORDER) {
    if (Object.hasOwn(state, key)) {
      const value = descriptors[key]?.value;
      normalized[key] = key === "reasonCodes" ? normalizeReasonCodes(value) : value;
    }
  }
  const checkpoint = normalized as unknown as CheckpointState;
  if (![
    "request_admitted", "snapshot_bound", "plan_validated", "artifact_recorded", "publication_reconciled",
  ].includes(checkpoint.phase)) throw new TypeError("Checkpoint phase is not supported.");
  for (const key of ["revisionDigest", "artifactDigest", "policyHash"] as const) {
    const value = checkpoint[key];
    if (value !== undefined && !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${key} must be a SHA-256 digest.`);
  }
  for (const key of ["reportId", "actionIntentId"] as const) {
    const value = checkpoint[key];
    if (value !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new TypeError(`${key} must be a UUID.`);
    }
  }
  if (!Number.isSafeInteger(checkpoint.configVersion) || checkpoint.configVersion < 1) {
    throw new TypeError("Checkpoint state must bind a positive configVersion.");
  }
  if (!/^[a-f0-9]{64}$/.test(checkpoint.policyHash)) {
    throw new TypeError("Checkpoint state must bind a SHA-256 policyHash.");
  }
  if (checkpoint.completedStep !== undefined && !/^[a-z0-9_.-]{1,64}$/.test(checkpoint.completedStep)) {
    throw new TypeError("completedStep must be a bounded core step identifier.");
  }
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CHECKPOINT_BYTES) {
    throw new TypeError("Checkpoint state exceeds the 4 KiB limit.");
  }
  return encoded;
}

function validateInput(input: CheckpointInput): void {
  for (const [field, value] of Object.entries({
    taskId: input.taskId,
    attemptId: input.attemptId,
    projectId: input.projectId,
    step: input.step,
  })) {
    if (value.length === 0 || value.length > 200) throw new TypeError(`${field} must contain 1–200 characters.`);
  }
  if (!Number.isSafeInteger(input.leaseEpoch) || input.leaseEpoch < 1) {
    throw new TypeError("leaseEpoch must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new TypeError("schemaVersion must be a positive safe integer.");
  }
  for (const skill of input.requiredSkills) {
    if (skill.skillId.length === 0 || skill.skillId.length > 200) {
      throw new TypeError("Skill identifiers must contain 1–200 characters.");
    }
    if (!/^[a-f0-9]{64}$/.test(skill.revisionDigest)) throw new TypeError("Skill revisions must use SHA-256 digests.");
  }
  if (new Set(input.requiredSkills.map(({ skillId }) => skillId)).size !== input.requiredSkills.length) {
    throw new TypeError("requiredSkills must not contain duplicate identifiers.");
  }
}

export class PostgresPersistence {
  constructor(private readonly pool: SqlPool) {}

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
      await client.query("CREATE SCHEMA IF NOT EXISTS jarvis");
      await client.query(`
        CREATE TABLE IF NOT EXISTS jarvis.schema_migrations (
          version text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      const { rows } = await client.query<{ version: string; checksum: string }>(
        "SELECT version, checksum FROM jarvis.schema_migrations ORDER BY version",
      );
      const applied = new Map(rows.map((row) => [row.version, row.checksum]));
      const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
      const files = (await readdir(directory)).filter((entry) => /^\d{3}_[a-z0-9_]+\.sql$/.test(entry)).sort();
      const available = new Set(files.map((file) => basename(file, ".sql")));
      for (const version of applied.keys()) {
        if (!available.has(version)) throw new Error(`Applied migration ${version} is missing from the migration bundle.`);
      }

      for (const file of files) {
        const sql = await readFile(join(directory, file), "utf8");
        const version = basename(file, ".sql");
        const checksum = digest(sql);
        const previous = applied.get(version);
        if (previous !== undefined) {
          if (previous !== checksum) throw new Error(`Applied migration ${version} has changed; add a new migration instead.`);
          continue;
        }

        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL search_path TO jarvis, public");
          await client.query(sql);
          await client.query("INSERT INTO jarvis.schema_migrations (version, checksum) VALUES ($1, $2)", [version, checksum]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
      } finally {
        client.release();
      }
    }
  }

  async saveCheckpoint(input: CheckpointInput): Promise<SavedCheckpoint> {
    validateInput(input);
    const encodedState = validateCheckpointState(input.state);
    const stateDigest = digest(encodedState);
    const client = await this.pool.connect();
    let rows: SavedCheckpoint[];
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      // Approval inserts take an UPDATE lock on this project row. Acquire the
      // matching SHARE lock in a separate statement so a waiter gets a fresh
      // READ COMMITTED snapshot for the authorization query below.
      await client.query("SELECT id FROM jarvis.projects WHERE id = $1 FOR SHARE", [input.projectId]);
      ({ rows } = await client.query<SavedCheckpoint>(`
          WITH eligible AS MATERIALIZED (
            SELECT t.id AS task_id, a.id AS attempt_id, t.project_id, t.repository_id, a.lease_epoch,
                   $5::text AS step, $6::integer AS schema_version, $7::jsonb AS state_json,
                   $8::char(64) AS state_digest, $9::jsonb AS skill_requirements
            FROM jarvis.tasks t
            JOIN jarvis.task_attempts a
              ON a.task_id = t.id AND a.id = $2 AND a.lease_epoch = $3
            JOIN jarvis.projects p
              ON p.id = t.project_id AND p.repository_id = t.repository_id
            JOIN jarvis.installations i ON i.id = p.installation_id
            WHERE t.id = $1
              AND t.project_id = $4
              AND t.state = 'running'
              AND a.state = 'active'
              AND a.lease_until > now()
              AND p.state = 'active'
              AND i.state = 'active'
              AND i.revoked_at IS NULL
              AND p.config_version = t.config_version
              AND t.config_version = ($7::jsonb ->> 'configVersion')::integer
              AND t.policy_hash = ($7::jsonb ->> 'policyHash')
              AND NOT EXISTS (
                SELECT 1
                FROM jsonb_to_recordset($9::jsonb) AS required(skill_id text, revision_digest char(64))
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM jarvis.project_skill_approvals approval
                  WHERE approval.project_id = t.project_id
                    AND approval.skill_id = required.skill_id
                    AND approval.revision_digest = required.revision_digest
                    AND approval.decision = 'approved'
                    AND approval.config_version = t.config_version
                    AND NOT EXISTS (
                      SELECT 1 FROM jarvis.project_skill_approvals revoked
                      WHERE revoked.project_id = approval.project_id
                        AND revoked.skill_id = approval.skill_id
                        AND revoked.revision_digest = approval.revision_digest
                        AND revoked.decision_order > approval.decision_order
                    )
                )
              )
            FOR SHARE OF t, a, p, i
          )
          INSERT INTO jarvis.task_checkpoints (
            task_id, attempt_id, project_id, repository_id, lease_epoch,
            step, schema_version, state_json, state_digest, skill_requirements
          )
          SELECT task_id, attempt_id, project_id, repository_id, lease_epoch,
                 step, schema_version, state_json, state_digest, skill_requirements
          FROM eligible
          ON CONFLICT (task_id, attempt_id, lease_epoch, step) DO NOTHING
          RETURNING id, state_digest AS "stateDigest"
        `, [
          input.taskId,
          input.attemptId,
          input.leaseEpoch,
          input.projectId,
          input.step,
          input.schemaVersion,
          encodedState,
          stateDigest,
          JSON.stringify(input.requiredSkills.map(({ skillId, revisionDigest }) => ({
            skill_id: skillId,
            revision_digest: revisionDigest,
          }))),
        ]));
      await client.query("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const saved = rows[0];
    if (saved === undefined) throw new CheckpointRejectedError();
    return saved;
  }

  async loadLatestCheckpoint(input: { taskId: string; projectId: string }): Promise<LoadedCheckpoint | null> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<LoadedCheckpoint>(`
        SELECT c.id, c.step, c.schema_version AS "schemaVersion",
               c.state_json AS state, c.state_digest AS "stateDigest"
        FROM jarvis.task_checkpoints c
        JOIN jarvis.tasks t
          ON t.id = c.task_id AND t.project_id = c.project_id AND t.repository_id = c.repository_id
        JOIN jarvis.projects p
          ON p.id = c.project_id AND p.repository_id = c.repository_id
        JOIN jarvis.installations i ON i.id = p.installation_id
        WHERE c.task_id = $1
          AND c.project_id = $2
          AND t.state NOT IN ('cancelled', 'failed', 'completed')
          AND p.state = 'active'
          AND i.state = 'active'
          AND i.revoked_at IS NULL
          AND p.config_version = t.config_version
          AND (c.state_json ->> 'configVersion')::integer = t.config_version
          AND c.state_json ->> 'policyHash' = t.policy_hash
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_to_recordset(c.skill_requirements) AS required(skill_id text, revision_digest char(64))
            WHERE NOT EXISTS (
              SELECT 1
              FROM jarvis.project_skill_approvals approval
              WHERE approval.project_id = c.project_id
                AND approval.skill_id = required.skill_id
                AND approval.revision_digest = required.revision_digest
                AND approval.decision = 'approved'
                AND approval.config_version = t.config_version
                AND NOT EXISTS (
                  SELECT 1 FROM jarvis.project_skill_approvals newer
                  WHERE newer.project_id = approval.project_id
                    AND newer.skill_id = approval.skill_id
                    AND newer.revision_digest = approval.revision_digest
                    AND newer.decision_order > approval.decision_order
                )
            )
          )
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 1
      `, [input.taskId, input.projectId]);
      const checkpoint = rows[0];
      if (checkpoint === undefined) return null;
      const actualDigest = digest(validateCheckpointState(checkpoint.state));
      if (actualDigest !== checkpoint.stateDigest) {
        throw new Error("Persisted checkpoint digest does not match its validated state.");
      }
      return checkpoint;
    } finally {
      client.release();
    }
  }
}

export { PostgresQueueStore } from "./queue.js";
export { PostgresRequestIntakeStore } from "./request-intake.js";
export { PostgresOwnerAuthStore } from "./auth.js";
