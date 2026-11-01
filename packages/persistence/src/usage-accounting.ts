import type { SqlClient, SqlPool } from "./index.js";

type UsageField = "inputTotal" | "outputTotal" | "cacheReadInput" | "cacheWriteInput" | "reasoningOutput";
type NormalizedUsage = Readonly<{
  mappingVersion: string;
  counters: Readonly<Record<UsageField, number | null>>;
  coverage: Readonly<Record<UsageField, "reported" | "estimated" | "unknown" | "not_supported">>;
}>;

export type UsageAttribution = Readonly<{
  operationId: string;
  taskId: string;
  attemptId: string;
  leaseEpoch: number;
  dispatchAttempt: number;
  provider: string;
  model: string;
  purpose: string;
}>;
export type UsageLifecycle = "dispatched" | "succeeded" | "failed" | "cancelled" | "unknown";
export type UsageObservationSource = "gateway" | "runtime";
export type UsageQuotaSignals = Readonly<{
  mappingVersion: string;
  source: "provider-response-header";
  provider: string;
  observedAt: string;
  freshness: "current" | "stale" | "unknown";
  counters: Readonly<Record<"requestLimit" | "requestRemaining" | "tokenLimit" | "tokenRemaining", number | null>>;
  coverage: Readonly<Record<"requestLimit" | "requestRemaining" | "tokenLimit" | "tokenRemaining", "reported" | "unknown" | "not_supported">>;
}>;
export type UsageObservation = Readonly<{
  source: UsageObservationSource;
  observationId: string;
  revision: number;
  observedAt: string;
  freshness: "current" | "stale" | "unknown";
  usage: NormalizedUsage;
  quota?: UsageQuotaSignals;
}>;
export class UsageAccountingRejectedError extends Error {
  constructor() { super("Usage accounting event did not match its live attempt or bounded schema."); this.name = "UsageAccountingRejectedError"; }
}

const fields: readonly UsageField[] = ["inputTotal", "outputTotal", "cacheReadInput", "cacheWriteInput", "reasoningOutput"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const safeLabel = /^[a-zA-Z0-9._:-]{1,96}$/;
function validateAttribution(value: UsageAttribution): void {
  if (!uuid.test(value.operationId) || !safeId.test(value.taskId) || !safeId.test(value.attemptId) ||
      !Number.isSafeInteger(value.leaseEpoch) || value.leaseEpoch < 1 || !Number.isSafeInteger(value.dispatchAttempt) || value.dispatchAttempt < 1 ||
      !["github-copilot", "openai"].includes(value.provider) || !safeLabel.test(value.model) || value.purpose !== "task_execution") throw new UsageAccountingRejectedError();
}
function validateObservation(value: UsageObservation): void {
  const exact = (record: unknown, keys: readonly string[]): boolean => typeof record === "object" && record !== null && !Array.isArray(record) &&
    Object.keys(record).sort().join(",") === [...keys].sort().join(",");
  if (!exact(value.usage, ["mappingVersion", "counters", "coverage"]) || !exact(value.usage.counters, fields) || !exact(value.usage.coverage, fields) ||
      !(value.source === "gateway" || value.source === "runtime") || !safeLabel.test(value.observationId) ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isFinite(Date.parse(value.observedAt)) ||
      !["current", "stale", "unknown"].includes(value.freshness) || typeof value.usage.mappingVersion !== "string" || !safeLabel.test(value.usage.mappingVersion)) {
    throw new UsageAccountingRejectedError();
  }
  for (const field of fields) {
    const count = value.usage.counters[field];
    const status = value.usage.coverage[field];
    if (!(status === "reported" || status === "estimated" || status === "unknown" || status === "not_supported") ||
        (count !== null && (!Number.isSafeInteger(count) || count < 0 || count > 2_147_483_647)) ||
        ((status === "reported" || status === "estimated") !== (count !== null))) throw new UsageAccountingRejectedError();
  }
  if (value.quota !== undefined) {
    const quotaFields = ["requestLimit", "requestRemaining", "tokenLimit", "tokenRemaining"] as const;
    if (!exact(value.quota, ["mappingVersion", "source", "provider", "observedAt", "freshness", "counters", "coverage"]) ||
        !exact(value.quota.counters, quotaFields) || !exact(value.quota.coverage, quotaFields) ||
        value.quota.source !== "provider-response-header" || !safeLabel.test(value.quota.provider) ||
        !safeLabel.test(value.quota.mappingVersion) || !Number.isFinite(Date.parse(value.quota.observedAt)) ||
        !["current", "stale", "unknown"].includes(value.quota.freshness)) throw new UsageAccountingRejectedError();
    for (const field of quotaFields) {
      const count = value.quota.counters[field]; const status = value.quota.coverage[field];
      if (!(status === "reported" || status === "unknown" || status === "not_supported") ||
          (count !== null && (!Number.isSafeInteger(count) || count < 0 || count > 2_147_483_647)) ||
          ((status === "reported") !== (count !== null))) throw new UsageAccountingRejectedError();
    }
  }
}

/** API-owned writes, fenced by the active durable queue lease for every event. */
export class PostgresUsageAccountingStore {
  constructor(private readonly pool: SqlPool) {}

  async recordIntent(input: UsageAttribution): Promise<string> {
    validateAttribution(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ id: string; task_id: string; attempt_id: string; provider: string; model: string; purpose: string }>(`SELECT id,task_id,attempt_id,provider,model,purpose FROM jarvis.model_requests
        WHERE operation_id=$1 AND dispatch_attempt=$2 FOR SHARE`, [input.operationId, input.dispatchAttempt]);
      if (existing.rowCount) {
        const row = existing.rows[0]!;
        if (row.task_id !== input.taskId || row.attempt_id !== input.attemptId || row.provider !== input.provider || row.model !== input.model || row.purpose !== input.purpose) {
          throw new UsageAccountingRejectedError();
        }
        await client.query("COMMIT");
        return row.id;
      }
      const active = await client.query<{ request_id: string }>(`SELECT r.id AS request_id FROM jarvis.task_attempts a
        JOIN jarvis.queue_entries q ON q.task_id=a.task_id AND q.attempt_id=a.id AND q.lease_epoch=a.lease_epoch
        JOIN jarvis.tasks t ON t.id=a.task_id JOIN jarvis.requests r ON r.id=t.request_id
        WHERE a.task_id=$1 AND a.id=$2 AND a.lease_epoch=$3 AND a.state='active'
          AND q.state='leased' AND q.lease_until > clock_timestamp() FOR SHARE OF a,q`,
      [input.taskId, input.attemptId, input.leaseEpoch]);
      if (active.rowCount !== 1) throw new UsageAccountingRejectedError();
      const inserted = await client.query<{ id: string }>(`INSERT INTO jarvis.model_requests
        (request_id, task_id, attempt_id, purpose, provider, model, requested_model, profile_version,
         operation_id, dispatch_attempt, lifecycle, state, mapping_version)
        VALUES ($1,$2,$3,$4,$5,$6,$6,1,$7,$8,'prepared','prepared',$9)
        ON CONFLICT (operation_id, dispatch_attempt) WHERE operation_id IS NOT NULL DO NOTHING RETURNING id`,
      [active.rows[0]?.request_id, input.taskId, input.attemptId, input.purpose, input.provider, input.model, input.operationId, input.dispatchAttempt,
        input.provider === "openai" ? "openai-chat-completions-v1" : `${input.provider}-usage-unknown-v1`]);
      let id = inserted.rows[0]?.id;
      if (!id) {
        const retry = await client.query<{ id: string }>(`SELECT id FROM jarvis.model_requests
          WHERE operation_id=$1 AND dispatch_attempt=$2 AND task_id=$3 AND attempt_id=$4 AND provider=$5 AND model=$6 AND purpose=$7`,
        [input.operationId, input.dispatchAttempt, input.taskId, input.attemptId, input.provider, input.model, input.purpose]);
        id = retry.rows[0]?.id;
      }
      if (!id) throw new UsageAccountingRejectedError();
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof UsageAccountingRejectedError) throw error;
      throw new UsageAccountingRejectedError();
    } finally { client.release(); }
  }
  async markDispatched(input: UsageAttribution): Promise<void> {
    validateAttribution(input);
    const client = await this.pool.connect();
    try {
      const result = await client.query(`UPDATE jarvis.model_requests mr SET lifecycle='dispatched', state='dispatched',
        dispatched_at=COALESCE(dispatched_at,clock_timestamp())
        WHERE mr.operation_id=$1 AND mr.dispatch_attempt=$2 AND mr.task_id=$3 AND mr.attempt_id=$4
          AND mr.provider=$6 AND mr.model=$7 AND mr.purpose=$8
          AND (mr.lifecycle='dispatched' OR (mr.lifecycle='prepared' AND EXISTS (
            SELECT 1 FROM jarvis.task_attempts a JOIN jarvis.queue_entries q
              ON q.task_id=a.task_id AND q.attempt_id=a.id AND q.lease_epoch=a.lease_epoch
            WHERE a.task_id=$3 AND a.id=$4 AND a.lease_epoch=$5 AND a.state='active'
              AND q.state='leased' AND q.lease_until > clock_timestamp())))`,
      [input.operationId, input.dispatchAttempt, input.taskId, input.attemptId, input.leaseEpoch, input.provider, input.model, input.purpose]);
      if (result.rowCount !== 1) throw new UsageAccountingRejectedError();
    } finally { client.release(); }
  }

  async recordObservation(attribution: UsageAttribution, observation: UsageObservation, lifecycle: UsageLifecycle): Promise<void> {
    validateAttribution(attribution);
    validateObservation(observation);
    if (observation.quota !== undefined && observation.quota.provider !== attribution.provider) throw new UsageAccountingRejectedError();
    if (!["succeeded", "failed", "cancelled", "unknown"].includes(lifecycle)) throw new UsageAccountingRejectedError();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const request = await client.query<{ id: string }>(`SELECT mr.id FROM jarvis.model_requests mr
        JOIN jarvis.task_attempts a ON a.id=mr.attempt_id AND a.task_id=mr.task_id AND a.lease_epoch=$5
        WHERE mr.operation_id=$1 AND mr.dispatch_attempt=$2 AND mr.task_id=$3 AND mr.attempt_id=$4
          AND mr.provider=$6 AND mr.model=$7 AND mr.purpose=$8
          AND mr.lifecycle IN ('dispatched','unknown','succeeded','failed','cancelled')`,
      [attribution.operationId, attribution.dispatchAttempt, attribution.taskId, attribution.attemptId, attribution.leaseEpoch,
        attribution.provider, attribution.model, attribution.purpose]);
      if (request.rowCount !== 1) throw new UsageAccountingRejectedError();
      const modelRequestId = request.rows[0]?.id;
      await client.query(`INSERT INTO jarvis.usage_observations
        (model_request_id, source, observation_id, revision, numeric_usage, field_statuses, mapping_version, coverage, observed_at, freshness, quota_signals)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT (model_request_id,source,observation_id,revision) DO NOTHING`,
      [modelRequestId, observation.source, observation.observationId, observation.revision,
        JSON.stringify(observation.usage.counters), JSON.stringify(observation.usage.coverage), observation.usage.mappingVersion,
        Object.values(observation.usage.coverage).every((value) => value === "reported" || value === "not_supported") ? "complete" : "partial",
        observation.observedAt, observation.freshness, observation.quota === undefined ? null : JSON.stringify(observation.quota)]);
      await client.query(`UPDATE jarvis.model_requests SET
        lifecycle=CASE WHEN lifecycle IN ('succeeded','failed','cancelled') THEN lifecycle ELSE $2 END,
        state=CASE WHEN state IN ('succeeded','failed','cancelled') THEN state ELSE $2 END,
        completed_at=CASE WHEN lifecycle IN ('succeeded','failed','cancelled') THEN completed_at
          WHEN $2 IN ('succeeded','failed','cancelled') THEN COALESCE(completed_at,clock_timestamp()) ELSE completed_at END
        WHERE id=$1`, [modelRequestId, lifecycle]);
      await refreshCanonicalLedger(client, modelRequestId!);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof UsageAccountingRejectedError) throw error;
      throw new UsageAccountingRejectedError();
    } finally { client.release(); }
  }
  async recordRuntimeObservation(dispatchId: string, usage: NormalizedUsage): Promise<void> {
    if (!uuid.test(dispatchId)) throw new UsageAccountingRejectedError();
    const observation: UsageObservation = {
      source: "runtime",
      observationId: dispatchId,
      revision: 1,
      observedAt: new Date().toISOString(),
      freshness: "current",
      usage,
    };
    validateObservation(observation);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const request = await client.query<{ id: string }>(`SELECT id FROM jarvis.model_requests
        WHERE operation_id=$1 AND dispatch_attempt=1 AND lifecycle IN ('dispatched','unknown','succeeded','failed','cancelled')
        FOR SHARE`, [dispatchId]);
      if (request.rowCount !== 1) throw new UsageAccountingRejectedError();
      await client.query(`INSERT INTO jarvis.usage_observations
        (model_request_id,source,observation_id,revision,numeric_usage,field_statuses,mapping_version,coverage,observed_at,freshness,quota_signals)
        VALUES ($1,'runtime',$2,1,$3::jsonb,$4::jsonb,$5,$6,$7,'current',NULL)
        ON CONFLICT (model_request_id,source,observation_id,revision) DO NOTHING`,
      [request.rows[0]!.id, dispatchId, JSON.stringify(usage.counters), JSON.stringify(usage.coverage), usage.mappingVersion,
        Object.values(usage.coverage).every((value) => value === "reported" || value === "not_supported") ? "complete" : "partial",
        observation.observedAt]);
      await client.query("UPDATE jarvis.model_requests SET runtime_coverage='observed' WHERE id=$1", [request.rows[0]!.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof UsageAccountingRejectedError) throw error;
      throw new UsageAccountingRejectedError();
    } finally { client.release(); }
  }
  async reconcileInterrupted(): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`UPDATE jarvis.model_requests
        SET lifecycle='unknown', state='unknown', completed_at=COALESCE(completed_at,clock_timestamp())
        WHERE operation_id IS NOT NULL AND lifecycle IN ('prepared','dispatched')
        RETURNING id`);
      return result.rowCount ?? 0;
    } finally { client.release(); }
  }
}

async function refreshCanonicalLedger(client: SqlClient, modelRequestId: string): Promise<void> {
  const result = await client.query<{ numeric_usage: Record<string, number | null>; field_statuses: Record<string, string>; revision: number; observed_at: Date }>(`SELECT numeric_usage,field_statuses,revision,observed_at FROM jarvis.usage_observations
    WHERE model_request_id=$1 AND source='gateway' ORDER BY revision DESC, observed_at DESC LIMIT 1`, [modelRequestId]);
  if (result.rowCount !== 1) return;
  const { numeric_usage, field_statuses, revision, observed_at } = result.rows[0]!;
  await client.query(`INSERT INTO jarvis.usage_ledger
    (model_request_id,canonical_revision,token_counts,field_statuses,reconciliation_state,reconciliation_state_v2,canonical_observed_at,updated_at)
    VALUES ($1,$2,$3::jsonb,$4::jsonb,'observed',$5,$6,clock_timestamp())
    ON CONFLICT (model_request_id) DO UPDATE SET canonical_revision=EXCLUDED.canonical_revision,
      token_counts=EXCLUDED.token_counts,field_statuses=EXCLUDED.field_statuses,reconciliation_state_v2=EXCLUDED.reconciliation_state_v2,
      canonical_observed_at=EXCLUDED.canonical_observed_at,updated_at=clock_timestamp()
    WHERE (EXCLUDED.canonical_revision,EXCLUDED.canonical_observed_at) >=
      (jarvis.usage_ledger.canonical_revision,jarvis.usage_ledger.canonical_observed_at)`,
  [modelRequestId, revision, JSON.stringify(numeric_usage), JSON.stringify(field_statuses),
    Object.values(field_statuses).every((status) => status === "reported" || status === "not_supported") ? "complete" : "partial", observed_at]);
}
