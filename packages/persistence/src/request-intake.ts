import type { RequestIntakeStore, RequestRecord } from "@jarvis/domain";
import type { SqlClient, SqlPool } from "./index.js";

type RequestRow = {
  id: string; owner_id: string; project_id: string | null; repository_id: string | null; mode: RequestRecord["mode"];
  request_kind: RequestRecord["kind"]; prompt: string | null; prompt_digest: string; request_digest: string | null;
  config_version: number | null; policy_hash: string | null; state: RequestRecord["state"];
  clarification: string[]; idempotency_key: string; selector: string | null; explicit_mode: RequestRecord["explicitMode"];
  explicit_kind: RequestRecord["explicitKind"]; version: number; profile_hash: string | null;
  clarification_digest: string | null;
};

const columns = `id, owner_id, project_id, repository_id, mode, request_kind, prompt, prompt_digest,
 request_digest, config_version, policy_hash, state, clarification, idempotency_key, selector,
  explicit_mode, explicit_kind, version, profile_hash, clarification_digest`;
const record = (r: RequestRow): RequestRecord => ({
  id: r.id, ownerId: r.owner_id, projectId: r.project_id, repositoryId: r.repository_id, mode: r.mode,
  kind: r.request_kind, prompt: r.prompt, promptDigest: r.prompt_digest, requestDigest: r.request_digest,
  configVersion: r.config_version, policyHash: r.policy_hash, state: r.state, clarification: r.clarification,
  idempotencyKey: r.idempotency_key, selector: r.selector, explicitMode: r.explicit_mode,
  explicitKind: r.explicit_kind, version: r.version, profileHash: r.profile_hash, clarificationDigest: r.clarification_digest,
});

async function queueAuthorized(client: SqlClient, value: RequestRecord): Promise<void> {
  if (value.state !== "queued") return;
  if (!value.projectId || !value.repositoryId || !value.mode || !value.configVersion ||
      !value.policyHash || !value.profileHash) throw new Error("AUTHORIZED_REQUEST_BINDING_INCOMPLETE");
  const { rows } = await client.query<{ id: string }>(`
    INSERT INTO jarvis.tasks (request_id, project_id, repository_id, mode, profile_hash, policy_hash, config_version, state, dedupe_key)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8)
    ON CONFLICT (request_id) DO NOTHING RETURNING id
  `, [value.id, value.projectId, value.repositoryId, value.mode, value.profileHash, value.policyHash, value.configVersion, value.id]);
  const task = rows[0];
  if (!task) throw new Error("Authorized request task was not created.");
  const eventId = `request:${value.id}`;
  await client.query(`
    INSERT INTO jarvis.queue_entries (task_id, event_id, state, available_at, deadline, max_attempts, retry_base_delay_ms, retry_max_delay_ms)
    VALUES ($1, $2, 'queued', clock_timestamp(), clock_timestamp() + interval '24 hours', 3, 1000, 60000)
  `, [task.id, eventId]);
  await client.query(`
    INSERT INTO jarvis.outbox (aggregate_id, event_type, payload, dedupe_key)
    VALUES ($1, 'queue.task.queued', jsonb_build_object('taskId', $4::text, 'eventId', $2::text), $3)
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  `, [task.id, eventId, `queue:${task.id}:queued:0`, task.id]);
}

export class PostgresRequestIntakeStore implements RequestIntakeStore {
  constructor(private readonly pool: SqlPool) {}

  async findByIdempotency(ownerId: string, key: string): Promise<RequestRecord | null> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<RequestRow>(`SELECT ${columns} FROM jarvis.requests WHERE owner_id = $1 AND idempotency_key = $2`, [ownerId, key]);
      return rows[0] ? record(rows[0]) : null;
    } finally { client.release(); }
  }

  async create(value: RequestRecord): Promise<RequestRecord> {
    if (value.prompt === null || value.requestDigest === null) {
      throw new TypeError("New requests require a raw prompt and full request digest.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: existingRows } = await client.query<RequestRow>(
        `SELECT ${columns} FROM jarvis.requests WHERE owner_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [value.ownerId, value.idempotencyKey],
      );
      const existing = existingRows[0];
      if (existing) {
        if (existing.request_digest !== value.requestDigest) throw new Error("IDEMPOTENCY_CONFLICT");
        await client.query("COMMIT");
        return record(existing);
      }
      if (value.state === "queued" && value.projectId) {
        const { rows: projects } = await client.query<{ id: string }>(`
          SELECT p.id FROM jarvis.projects p JOIN jarvis.installations i ON i.id=p.installation_id
          WHERE p.id=$1 AND p.repository_id=$2 AND p.state='active' AND i.state='active' AND i.revoked_at IS NULL
            AND p.config_version=$3
            AND EXISTS (SELECT 1 FROM jarvis.project_config_versions c WHERE c.project_id=p.id AND c.version=$3 AND c.policy_hash=$4)
          FOR SHARE OF p,i
        `, [value.projectId,value.repositoryId,value.configVersion,value.policyHash]);
        if (!projects[0]) throw new Error("PROJECT_AUTHORIZATION_STALE");
      }
      const { rows } = await client.query<RequestRow>(`
        INSERT INTO jarvis.requests
          (id, owner_id, project_id, repository_id, mode, prompt_digest, state, idempotency_key,
           config_version, policy_hash, prompt, request_digest, request_kind, clarification, selector,
           explicit_mode, explicit_kind, version, profile_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,1,$18)
        ON CONFLICT (owner_id, idempotency_key) DO NOTHING
        RETURNING ${columns}
      `, [value.id,value.ownerId,value.projectId,value.repositoryId,value.mode,value.promptDigest,value.state,value.idempotencyKey,
        value.configVersion,value.policyHash,value.prompt,value.requestDigest,value.kind,JSON.stringify(value.clarification),
        value.selector,value.explicitMode,value.explicitKind,value.profileHash]);
      if (rows[0]) {
        const saved = record(rows[0]);
        await queueAuthorized(client, { ...saved, profileHash: value.profileHash });
        await client.query("COMMIT");
        return saved;
      }
      const { rows: priorRows } = await client.query<RequestRow>(`SELECT ${columns} FROM jarvis.requests WHERE owner_id=$1 AND idempotency_key=$2 FOR UPDATE`, [value.ownerId, value.idempotencyKey]);
      const prior = priorRows[0];
      if (!prior) throw new Error("Request idempotency conflict disappeared.");
      if (prior.request_digest !== value.requestDigest) throw new Error("IDEMPOTENCY_CONFLICT");
      await client.query("COMMIT");
      return record(prior);
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async getOwned(id: string, ownerId: string): Promise<RequestRecord | null> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<RequestRow>(`SELECT ${columns} FROM jarvis.requests WHERE id=$1 AND owner_id=$2`, [id, ownerId]);
      return rows[0] ? record(rows[0]) : null;
    } finally { client.release(); }
  }

  async replaceClarification(value: RequestRecord, expectedVersion: number): Promise<RequestRecord> {
    if (value.prompt === null || value.requestDigest === null) {
      throw new TypeError("Legacy requests without prompt and digest cannot be clarified.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: projects } = await client.query<{ id: string }>(`
        SELECT p.id FROM jarvis.projects p JOIN jarvis.installations i ON i.id=p.installation_id
        WHERE p.id=$1 AND p.repository_id=$2 AND p.state='active' AND i.state='active' AND i.revoked_at IS NULL
          AND p.config_version=$3
          AND EXISTS (SELECT 1 FROM jarvis.project_config_versions c WHERE c.project_id=p.id AND c.version=$3 AND c.policy_hash=$4)
        FOR SHARE OF p,i
      `, [value.projectId,value.repositoryId,value.configVersion,value.policyHash]);
      if (!projects[0]) throw new Error("PROJECT_AUTHORIZATION_STALE");
      const { rows } = await client.query<RequestRow>(`
        UPDATE jarvis.requests SET project_id=$3, repository_id=$4, mode=$5, config_version=$6, policy_hash=$7, profile_hash=$9,
          clarification_digest=$11,
          request_kind=$8, state='queued', clarification='[]'::jsonb, version=version+1, updated_at=clock_timestamp()
          WHERE id=$1 AND owner_id=$2 AND state='clarification' AND version=$10
        RETURNING ${columns}
      `, [value.id,value.ownerId,value.projectId,value.repositoryId,value.mode,value.configVersion,value.policyHash,value.kind,value.profileHash,expectedVersion,value.clarificationDigest]);
      const saved = rows[0];
      if (!saved) throw new Error("REQUEST_VERSION_CONFLICT");
      await queueAuthorized(client, { ...record(saved), profileHash: value.profileHash });
      await client.query("COMMIT");
      return record(saved);
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}
