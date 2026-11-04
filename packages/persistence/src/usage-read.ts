import type { SqlPool } from "./index.js";

export type UsagePeriodFilter = Readonly<{
  start: string;
  end: string;
  timeZone: string;
  projectId?: string;
  taskId?: string;
  provider?: string;
  model?: string;
  purpose?: string;
  limit?: number;
  cursor?: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL = /^[a-zA-Z0-9._:-]{1,96}$/;
const COUNTERS = ["inputTotal", "outputTotal", "cacheReadInput", "cacheWriteInput", "reasoningOutput"] as const;
const QUOTA_COUNTERS = ["requestLimit", "requestRemaining", "tokenLimit", "tokenRemaining"] as const;
type QuotaCounter = typeof QUOTA_COUNTERS[number];
const COVERAGE_STATES = ["reported", "unknown", "not_supported"] as const;

function safeQuotaSignals(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.source !== "provider-response-header") return null;
  const counters = source.counters && typeof source.counters === "object" && !Array.isArray(source.counters)
    ? source.counters as Record<string, unknown> : {};
  const coverage = source.coverage && typeof source.coverage === "object" && !Array.isArray(source.coverage)
    ? source.coverage as Record<string, unknown> : {};
  const normalized = Object.fromEntries(QUOTA_COUNTERS.map((field: QuotaCounter) => {
    const status = COVERAGE_STATES.includes(coverage[field] as typeof COVERAGE_STATES[number]) ? coverage[field] : "unknown";
    return [field, status === "reported" ? numberOrNull(counters[field]) : null];
  }));
  const normalizedCoverage = Object.fromEntries(QUOTA_COUNTERS.map((field: QuotaCounter) => {
    const status = COVERAGE_STATES.includes(coverage[field] as typeof COVERAGE_STATES[number]) ? coverage[field] : "unknown";
    return [field, normalized[field] === null && status === "reported" ? "unknown" : status];
  }));
  let observedAt: string | null = null;
  if (typeof source.observedAt === "string" && Number.isFinite(Date.parse(source.observedAt))) observedAt = new Date(source.observedAt).toISOString();
  return {
    source: "provider-response-header",
    additive: false,
    provider: safeLabel(source.provider),
    mappingVersion: safeLabel(source.mappingVersion),
    observedAt,
    freshness: ["current", "stale", "unknown"].includes(String(source.freshness)) ? source.freshness : "unknown",
    counters: normalized,
    coverage: normalizedCoverage,
  };
}

type Counter = typeof COUNTERS[number];
function safeLabel(value: unknown): string | null {
  return typeof value === "string" && LABEL.test(value) ? value : null;
}

function instant(localDate: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !Number.isFinite(Date.parse(`${localDate}T00:00:00Z`)) || new Date(`${localDate}T00:00:00Z`).toISOString().slice(0, 10) !== localDate) throw new TypeError("Invalid usage period date.");
  let candidate = Date.parse(`${localDate}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  for (let index = 0; index < 3; index += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const target = Date.UTC(year, month - 1, day);
    const delta = target - represented;
    candidate += delta;
    if (delta === 0) break;
  }
  return new Date(candidate).toISOString();
}

function validate(ownerId: string, filter: UsagePeriodFilter, maxDays: number): { start: string; end: string; zone: string } {
  if (!ownerId || typeof ownerId !== "string" || !filter || typeof filter !== "object" ||
      typeof filter.start !== "string" || typeof filter.end !== "string" || typeof filter.timeZone !== "string" || filter.timeZone.length > 128) throw new TypeError("Invalid usage filter.");
  let zone: string;
  try { zone = new Intl.DateTimeFormat("en", { timeZone: filter.timeZone }).resolvedOptions().timeZone; }
  catch { throw new TypeError("Invalid usage time zone."); }
  const start = instant(filter.start, zone);
  const end = instant(filter.end, zone);
  const daySpan = (Date.parse(filter.end + "T00:00:00Z") - Date.parse(filter.start + "T00:00:00Z")) / 86_400_000;
  if (!(daySpan > 0 && daySpan <= maxDays)) throw new TypeError("Usage period is outside the bounded range.");
  if ((filter.projectId !== undefined && !UUID.test(filter.projectId)) || (filter.taskId !== undefined && !UUID.test(filter.taskId))) throw new TypeError("Invalid usage identifier.");
  for (const item of [filter.provider, filter.model, filter.purpose]) if (item !== undefined && !LABEL.test(item)) throw new TypeError("Invalid usage filter.");
  return { start, end, zone };
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (cursor === undefined) return null;
  try {
    if (cursor.length > 512) throw new Error();
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const value = JSON.parse(decoded) as { at?: unknown; id?: unknown };
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "at,id" || typeof value.at !== "string" ||
        !Number.isFinite(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at ||
        typeof value.id !== "string" || !UUID.test(value.id) ||
        Buffer.from(JSON.stringify({ at: value.at, id: value.id })).toString("base64url") !== cursor) throw new Error();
    return { at: value.at, id: value.id };
  } catch { throw new TypeError("Invalid usage cursor."); }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeUsageField(status: unknown, rawValue: unknown): {
  value: number | null;
  status: "reported" | "unknown" | "not_supported";
} {
  if (status === "not_supported") return { value: null, status: "not_supported" };
  if (status !== "reported") return { value: null, status: "unknown" };
  const value = numberOrNull(rawValue);
  return value === null ? { value: null, status: "unknown" } : { value, status: "reported" };
}
function aggregateCount(value: unknown): number | string | null {
  if (value === null || value === undefined) return null;
  try {
    const count = BigInt(value as string | number);
    if (count < 0n) return null;
    return count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : count.toString();
  } catch { return null; }
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at: new Date(at).toISOString(), id })).toString("base64url");
}

/** Owner/project-scoped period usage read model. It never selects legacy monetary or content columns. */
export class PostgresUsageReadModel {
  constructor(private readonly pool: SqlPool) {}

  async summary(ownerId: string, filter: UsagePeriodFilter): Promise<Readonly<Record<string, unknown>>> {
    if (filter.limit !== undefined || filter.cursor !== undefined) throw new TypeError("Summary queries do not accept pagination.");
    const period = validate(ownerId, filter, 90);
    const client = await this.pool.connect();
    try {
      const values: unknown[] = [ownerId, period.start, period.end];
      const where = this.where(filter, values);
      const { rows } = await client.query<{
        project_id: string; task_id: string | null; provider: string; model: string; purpose: string; mapping_version: string | null;
        request_count: string | number; observed_count: string | number;
        runtime_observed_count: string | number; runtime_unknown_count: string | number; runtime_unsupported_count: string | number;
        input_total: string | number | null; output_total: string | number | null; cache_read_input: string | number | null;
        cache_write_input: string | number | null; reasoning_output: string | number | null;
        unknown_input: string | number; unsupported_input: string | number; unknown_output: string | number; unsupported_output: string | number;
        unknown_cache_read: string | number; unsupported_cache_read: string | number; unknown_cache_write: string | number; unsupported_cache_write: string | number;
        unknown_reasoning: string | number; unsupported_reasoning: string | number; current_count: string | number; stale_count: string | number; unknown_freshness_count: string | number;
        latest_quota_signals: unknown; observation_watermark: Date | string | null;
      }>(`SELECT p.id AS project_id,mr.task_id,mr.provider,mr.model,mr.purpose,go.mapping_version,
          count(*)::integer AS request_count,
          count(go.model_request_id)::integer AS observed_count,
          count(*) FILTER (WHERE mr.runtime_coverage='observed')::integer AS runtime_observed_count,
          count(*) FILTER (WHERE mr.runtime_coverage='unknown')::integer AS runtime_unknown_count,
          count(*) FILTER (WHERE mr.runtime_coverage='not_supported')::integer AS runtime_unsupported_count,
          sum(CASE WHEN go.model_request_id IS NOT NULL AND ul.field_statuses->>'inputTotal'='reported' AND numeric_usage.input_total>=0 AND numeric_usage.input_total=trunc(numeric_usage.input_total) AND numeric_usage.input_total<=9223372036854775807 THEN numeric_usage.input_total::bigint END) AS input_total,
          sum(CASE WHEN go.model_request_id IS NOT NULL AND ul.field_statuses->>'outputTotal'='reported' AND numeric_usage.output_total>=0 AND numeric_usage.output_total=trunc(numeric_usage.output_total) AND numeric_usage.output_total<=9223372036854775807 THEN numeric_usage.output_total::bigint END) AS output_total,
          sum(CASE WHEN go.model_request_id IS NOT NULL AND ul.field_statuses->>'cacheReadInput'='reported' AND numeric_usage.cache_read_input>=0 AND numeric_usage.cache_read_input=trunc(numeric_usage.cache_read_input) AND numeric_usage.cache_read_input<=9223372036854775807 THEN numeric_usage.cache_read_input::bigint END) AS cache_read_input,
          sum(CASE WHEN go.model_request_id IS NOT NULL AND ul.field_statuses->>'cacheWriteInput'='reported' AND numeric_usage.cache_write_input>=0 AND numeric_usage.cache_write_input=trunc(numeric_usage.cache_write_input) AND numeric_usage.cache_write_input<=9223372036854775807 THEN numeric_usage.cache_write_input::bigint END) AS cache_write_input,
          sum(CASE WHEN go.model_request_id IS NOT NULL AND ul.field_statuses->>'reasoningOutput'='reported' AND numeric_usage.reasoning_output>=0 AND numeric_usage.reasoning_output=trunc(numeric_usage.reasoning_output) AND numeric_usage.reasoning_output<=9223372036854775807 THEN numeric_usage.reasoning_output::bigint END) AS reasoning_output,
          count(*) FILTER (WHERE go.model_request_id IS NULL OR ul.model_request_id IS NULL OR ul.field_statuses->>'inputTotal' IS DISTINCT FROM 'not_supported' AND (ul.field_statuses->>'inputTotal' IS DISTINCT FROM 'reported' OR numeric_usage.input_total IS NULL OR numeric_usage.input_total<0 OR numeric_usage.input_total<>trunc(numeric_usage.input_total) OR numeric_usage.input_total>9223372036854775807))::integer AS unknown_input,
          count(*) FILTER (WHERE go.model_request_id IS NOT NULL AND ul.field_statuses->>'inputTotal'='not_supported')::integer AS unsupported_input,
          count(*) FILTER (WHERE go.model_request_id IS NULL OR ul.model_request_id IS NULL OR ul.field_statuses->>'outputTotal' IS DISTINCT FROM 'not_supported' AND (ul.field_statuses->>'outputTotal' IS DISTINCT FROM 'reported' OR numeric_usage.output_total IS NULL OR numeric_usage.output_total<0 OR numeric_usage.output_total<>trunc(numeric_usage.output_total) OR numeric_usage.output_total>9223372036854775807))::integer AS unknown_output,
          count(*) FILTER (WHERE go.model_request_id IS NOT NULL AND ul.field_statuses->>'outputTotal'='not_supported')::integer AS unsupported_output,
          count(*) FILTER (WHERE go.model_request_id IS NULL OR ul.model_request_id IS NULL OR ul.field_statuses->>'cacheReadInput' IS DISTINCT FROM 'not_supported' AND (ul.field_statuses->>'cacheReadInput' IS DISTINCT FROM 'reported' OR numeric_usage.cache_read_input IS NULL OR numeric_usage.cache_read_input<0 OR numeric_usage.cache_read_input<>trunc(numeric_usage.cache_read_input) OR numeric_usage.cache_read_input>9223372036854775807))::integer AS unknown_cache_read,
          count(*) FILTER (WHERE go.model_request_id IS NOT NULL AND ul.field_statuses->>'cacheReadInput'='not_supported')::integer AS unsupported_cache_read,
          count(*) FILTER (WHERE go.model_request_id IS NULL OR ul.model_request_id IS NULL OR ul.field_statuses->>'cacheWriteInput' IS DISTINCT FROM 'not_supported' AND (ul.field_statuses->>'cacheWriteInput' IS DISTINCT FROM 'reported' OR numeric_usage.cache_write_input IS NULL OR numeric_usage.cache_write_input<0 OR numeric_usage.cache_write_input<>trunc(numeric_usage.cache_write_input) OR numeric_usage.cache_write_input>9223372036854775807))::integer AS unknown_cache_write,
          count(*) FILTER (WHERE go.model_request_id IS NOT NULL AND ul.field_statuses->>'cacheWriteInput'='not_supported')::integer AS unsupported_cache_write,
          count(*) FILTER (WHERE go.model_request_id IS NULL OR ul.model_request_id IS NULL OR ul.field_statuses->>'reasoningOutput' IS DISTINCT FROM 'not_supported' AND (ul.field_statuses->>'reasoningOutput' IS DISTINCT FROM 'reported' OR numeric_usage.reasoning_output IS NULL OR numeric_usage.reasoning_output<0 OR numeric_usage.reasoning_output<>trunc(numeric_usage.reasoning_output) OR numeric_usage.reasoning_output>9223372036854775807))::integer AS unknown_reasoning,
          count(*) FILTER (WHERE go.model_request_id IS NOT NULL AND ul.field_statuses->>'reasoningOutput'='not_supported')::integer AS unsupported_reasoning,
          count(*) FILTER (WHERE go.freshness='current')::integer AS current_count,
          count(*) FILTER (WHERE go.freshness='stale')::integer AS stale_count,
          count(*) FILTER (WHERE go.freshness IS NULL OR go.freshness='unknown')::integer AS unknown_freshness_count,
          max(go.received_at) AS observation_watermark,
          (SELECT qobs.quota_signals
           FROM jarvis.model_requests qmr
           JOIN jarvis.requests qr ON qr.id=qmr.request_id
           JOIN jarvis.projects qp ON qp.id=qr.project_id AND qp.owner_id=qr.owner_id
           JOIN jarvis.installations qi ON qi.id=qp.installation_id
           JOIN LATERAL (SELECT uo.quota_signals,uo.observed_at,uo.revision
             FROM jarvis.usage_observations uo
             WHERE uo.model_request_id=qmr.id AND uo.source='gateway' AND uo.quota_signals IS NOT NULL
               AND uo.mapping_version IS NOT DISTINCT FROM go.mapping_version
             ORDER BY uo.revision DESC,uo.observed_at DESC LIMIT 1) qobs ON true
           WHERE qr.owner_id=$1 AND qp.owner_id=$1 AND qp.state='active' AND qi.state='active' AND qi.revoked_at IS NULL
             AND qp.id=p.id AND qmr.task_id IS NOT DISTINCT FROM mr.task_id
             AND qmr.provider=mr.provider AND qmr.model=mr.model AND qmr.purpose=mr.purpose
             AND qmr.dispatched_at >= $2::timestamptz AND qmr.dispatched_at < $3::timestamptz
           ORDER BY qobs.observed_at DESC,qobs.revision DESC LIMIT 1) AS latest_quota_signals
        FROM jarvis.model_requests mr
        JOIN jarvis.requests r ON r.id=mr.request_id
        JOIN jarvis.projects p ON p.id=r.project_id AND p.owner_id=r.owner_id
        JOIN jarvis.installations i ON i.id=p.installation_id
        LEFT JOIN jarvis.usage_ledger ul ON ul.model_request_id=mr.id
        LEFT JOIN LATERAL (SELECT
          CASE WHEN jsonb_typeof(ul.token_counts->'inputTotal')='number' THEN (ul.token_counts->>'inputTotal')::numeric END AS input_total,
          CASE WHEN jsonb_typeof(ul.token_counts->'outputTotal')='number' THEN (ul.token_counts->>'outputTotal')::numeric END AS output_total,
          CASE WHEN jsonb_typeof(ul.token_counts->'cacheReadInput')='number' THEN (ul.token_counts->>'cacheReadInput')::numeric END AS cache_read_input,
          CASE WHEN jsonb_typeof(ul.token_counts->'cacheWriteInput')='number' THEN (ul.token_counts->>'cacheWriteInput')::numeric END AS cache_write_input,
          CASE WHEN jsonb_typeof(ul.token_counts->'reasoningOutput')='number' THEN (ul.token_counts->>'reasoningOutput')::numeric END AS reasoning_output
        ) numeric_usage ON true
        LEFT JOIN LATERAL (SELECT uo.model_request_id,uo.mapping_version,uo.received_at,uo.freshness FROM jarvis.usage_observations uo
          WHERE uo.model_request_id=mr.id AND uo.source='gateway'
          ORDER BY uo.revision DESC,uo.observed_at DESC LIMIT 1) go ON true
        WHERE r.owner_id=$1 AND p.owner_id=$1 AND p.state='active' AND i.state='active' AND i.revoked_at IS NULL AND mr.dispatched_at >= $2::timestamptz AND mr.dispatched_at < $3::timestamptz${where}
        GROUP BY p.id,mr.task_id,mr.provider,mr.model,mr.purpose,go.mapping_version
        ORDER BY p.id,mr.task_id,mr.provider,mr.model,mr.purpose,go.mapping_version LIMIT 501`, values);
      if (rows.length > 500) throw new TypeError("Usage result has too many groups.");
      const observationWatermark = rows.reduce<Date | string | null>((max, row) => {
        if (row.observation_watermark === null) return max;
        if (max === null || Date.parse(String(row.observation_watermark)) > Date.parse(String(max))) return row.observation_watermark;
        return max;
      }, null);
      const groups = rows.map((row) => {
        const requestCount = Number(row.request_count);
        const unknown = { inputTotal: Number(row.unknown_input), outputTotal: Number(row.unknown_output),
          cacheReadInput: Number(row.unknown_cache_read), cacheWriteInput: Number(row.unknown_cache_write), reasoningOutput: Number(row.unknown_reasoning) };
        const unsupported = { inputTotal: Number(row.unsupported_input), outputTotal: Number(row.unsupported_output),
          cacheReadInput: Number(row.unsupported_cache_read), cacheWriteInput: Number(row.unsupported_cache_write), reasoningOutput: Number(row.unsupported_reasoning) };
        const reported = Object.fromEntries(COUNTERS.map((field) => [field, Math.max(0, requestCount - unknown[field] - unsupported[field])]));
        const observedCount = Number(row.observed_count);
        const tokenCoverage = observedCount === 0 ? "unknown" :
          Object.values(unknown).some((count) => count > 0) || Object.values(unsupported).some((count) => count > 0) ? "partial" : "observed";
        return { projectId: UUID.test(row.project_id) ? row.project_id : null,
          taskId: row.task_id !== null && UUID.test(row.task_id) ? row.task_id : null,
          provider: safeLabel(row.provider), model: safeLabel(row.model), purpose: safeLabel(row.purpose),
          mappingVersion: safeLabel(row.mapping_version), requestCount, observedCount, runtimeAdditive: false,
          runtimeCoverage: { observed: Number(row.runtime_observed_count), unknown: Number(row.runtime_unknown_count),
            notSupported: Number(row.runtime_unsupported_count), additive: false },
          inputTotal: aggregateCount(row.input_total), outputTotal: aggregateCount(row.output_total),
          cacheReadInput: aggregateCount(row.cache_read_input), cacheWriteInput: aggregateCount(row.cache_write_input), reasoningOutput: aggregateCount(row.reasoning_output),
          reported, unknown, unsupported, provenance: "gateway-ledger",
          freshness: { current: Number(row.current_count), stale: Number(row.stale_count), unknown: Number(row.unknown_freshness_count) },
          quotaSignals: safeQuotaSignals(row.latest_quota_signals), tokenCoverage,
          retentionCoverage: "unknown", coverage: tokenCoverage === "unknown" ? "unknown" : "partial" };
      });
      return { period: { start: period.start, end: period.end, timeZone: period.zone, inclusiveStart: true, exclusiveEnd: true },
        observationWatermark, retentionCoverage: "unknown", coverage: groups.length === 0 ? "unknown" : "partial", groups };
    } finally { client.release(); }
  }

  async requests(ownerId: string, filter: UsagePeriodFilter): Promise<Readonly<Record<string, unknown>>> {
    const period = validate(ownerId, filter, 90);
    const limit = filter.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Invalid usage page size.");
    const cursor = decodeCursor(filter.cursor);
    const client = await this.pool.connect();
    try {
      const values: unknown[] = [ownerId, period.start, period.end];
      const where = this.where(filter, values);
      let cursorClause = "";
      if (cursor) { values.push(cursor.at, cursor.id); cursorClause = ` AND (mr.dispatched_at,mr.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`; }
      values.push(limit + 1);
      const { rows } = await client.query<Record<string, unknown>>(`SELECT mr.id,p.id AS project_id,mr.operation_id,mr.request_id,mr.task_id,mr.attempt_id,
          mr.provider,mr.model,mr.purpose,mr.lifecycle,mr.dispatched_at,mr.completed_at,mr.runtime_coverage,
          ul.token_counts AS canonical_usage,ul.field_statuses,ul.canonical_revision,ul.canonical_observed_at,ul.reconciliation_state_v2,
          go.mapping_version,go.freshness,go.observed_at AS gateway_observed_at,qgo.quota_signals,
          ro.numeric_usage AS runtime_usage,ro.field_statuses AS runtime_field_statuses,
          ro.mapping_version AS runtime_mapping_version,ro.freshness AS runtime_freshness,
          ro.revision AS runtime_revision,ro.observed_at AS runtime_observed_at
        FROM jarvis.model_requests mr JOIN jarvis.requests r ON r.id=mr.request_id
        JOIN jarvis.projects p ON p.id=r.project_id AND p.owner_id=r.owner_id
        JOIN jarvis.installations i ON i.id=p.installation_id
        LEFT JOIN jarvis.usage_ledger ul ON ul.model_request_id=mr.id
        LEFT JOIN LATERAL (SELECT uo.mapping_version,uo.freshness,uo.observed_at FROM jarvis.usage_observations uo
          WHERE uo.model_request_id=mr.id AND uo.source='gateway'
          ORDER BY uo.revision DESC,uo.observed_at DESC LIMIT 1) go ON true
        LEFT JOIN LATERAL (SELECT uo.quota_signals FROM jarvis.usage_observations uo
          WHERE uo.model_request_id=mr.id AND uo.source='gateway' AND uo.quota_signals IS NOT NULL
          ORDER BY uo.revision DESC,uo.observed_at DESC LIMIT 1) qgo ON true
        LEFT JOIN LATERAL (SELECT uo.numeric_usage,uo.field_statuses,uo.mapping_version,uo.freshness,uo.revision,uo.observed_at
          FROM jarvis.usage_observations uo WHERE uo.model_request_id=mr.id AND uo.source='runtime'
          ORDER BY uo.revision DESC,uo.observed_at DESC LIMIT 1) ro ON true
        WHERE r.owner_id=$1 AND p.owner_id=$1 AND p.state='active' AND i.state='active' AND i.revoked_at IS NULL AND mr.dispatched_at >= $2::timestamptz AND mr.dispatched_at < $3::timestamptz${where}${cursorClause}
        ORDER BY mr.dispatched_at DESC,mr.id DESC LIMIT $${values.length}`, values);
      const truncated = rows.length > limit;
      const selected = rows.slice(0, limit);
      const records = selected.map((row) => {
        const counters = (row.canonical_usage && typeof row.canonical_usage === "object" ? row.canonical_usage : {}) as Record<string, unknown>;
        const statuses = (row.field_statuses && typeof row.field_statuses === "object" ? row.field_statuses : {}) as Record<string, unknown>;
        const gatewayObserved = row.mapping_version !== null && row.mapping_version !== undefined;
        const runtimeCounters = (row.runtime_usage && typeof row.runtime_usage === "object" ? row.runtime_usage : {}) as Record<string, unknown>;
        const runtimeStatuses = (row.runtime_field_statuses && typeof row.runtime_field_statuses === "object" ? row.runtime_field_statuses : {}) as Record<string, unknown>;
        const runtimeCorroboration = row.runtime_mapping_version === null || row.runtime_mapping_version === undefined ? null : {
          source: "runtime", additive: false, mappingVersion: safeLabel(row.runtime_mapping_version), revision: row.runtime_revision,
          observedAt: row.runtime_observed_at, freshness: row.runtime_freshness ?? "unknown",
          counters: Object.fromEntries(COUNTERS.map((field: Counter) => {
            const normalized = safeUsageField(runtimeStatuses[field], runtimeCounters[field]);
            return [field, normalized];
          })),
        };
        const usage = Object.fromEntries(COUNTERS.map((field: Counter) => {
          const normalized = gatewayObserved
            ? safeUsageField(statuses[field], counters[field])
            : { value: null, status: "unknown" as const };
          return [field, {
            ...normalized,
            provenance: { source: gatewayObserved ? "gateway" : null, mappingVersion: safeLabel(row.mapping_version), revision: row.canonical_revision ?? null, observedAt: row.gateway_observed_at ?? null, freshness: row.freshness ?? "unknown" },
          }];
        }));
        return { id: row.id, projectId: UUID.test(String(row.project_id)) ? row.project_id : null,
          operationId: row.operation_id, requestId: row.request_id, taskId: row.task_id, attemptId: row.attempt_id,
          provider: safeLabel(row.provider), model: safeLabel(row.model), purpose: safeLabel(row.purpose), lifecycle: row.lifecycle, dispatchedAt: row.dispatched_at,
          completedAt: row.completed_at, runtimeCoverage: row.runtime_coverage ?? "unknown", runtimeCorroboration, usage,
          quotaSignals: safeQuotaSignals(row.quota_signals),
          reconciliation: row.reconciliation_state_v2 ?? "unknown" };
      });
      return { period: { start: period.start, end: period.end, timeZone: period.zone },
        coverage: records.length === 0 ? "unknown" : "partial", retentionCoverage: "unknown", records, truncated,
        nextCursor: truncated && selected.length ? encodeCursor(String(selected[selected.length - 1]!.dispatched_at), String(selected[selected.length - 1]!.id)) : null };
    } finally { client.release(); }
  }

  private where(filter: UsagePeriodFilter, values: unknown[]): string {
    let sql = "";
    if (filter.projectId !== undefined) { values.push(filter.projectId); sql += ` AND p.id=$${values.length}::uuid`; }
    if (filter.taskId !== undefined) { values.push(filter.taskId); sql += ` AND mr.task_id=$${values.length}::uuid`; }
    if (filter.provider !== undefined) { values.push(filter.provider); sql += ` AND mr.provider=$${values.length}`; }
    if (filter.model !== undefined) { values.push(filter.model); sql += ` AND mr.model=$${values.length}`; }
    if (filter.purpose !== undefined) { values.push(filter.purpose); sql += ` AND mr.purpose=$${values.length}`; }
    return sql;
  }
}
