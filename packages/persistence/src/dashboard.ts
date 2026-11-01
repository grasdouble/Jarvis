import type { SqlPool } from "./index.js";

interface DashboardRow {
  project_id: string;
  repository: string;
  state: string;
  installation_state: string;
  revoked_at: Date | string | null;
  config_version: number;
  requests: unknown;
  pull_requests: unknown;
  usage: unknown;
  latest_observed_at: Date | string | null;
}

export interface PersistedDashboardRequest {
  readonly id: string;
  readonly mode: string | null;
  readonly state: string;
  readonly attemptCount: number | null;
  readonly attempts: readonly { readonly ordinal: number; readonly state: string; readonly observedAt: string | null }[];
  readonly remoteResult: "waiting" | "unavailable" | "permanent_failure" | "unknown" | "known";
  readonly observedAt: string | null;
  readonly pullRequests: readonly { readonly number: number; readonly state: string; readonly observedAt: string | null }[];
}

export interface PersistedDashboardProject {
  readonly id: string;
  readonly repository: string;
  readonly state: string;
  readonly configVersion: number;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly requests: readonly PersistedDashboardRequest[];
  readonly pullRequests: readonly { readonly number: number; readonly state: string; readonly observedAt: string | null }[];
  readonly health: "unavailable" | "unknown";
  readonly usage: Readonly<Record<string, unknown>>;
  readonly observedAt: string | null;
}

/** Read-only view of persisted dashboard facts. Every relation is joined through the allowlisted project. */
export class PostgresOperationalDashboardReadModel {
  constructor(private readonly pool: SqlPool) {}

  async list(ownerId: string): Promise<readonly PersistedDashboardProject[]> {
    if (ownerId !== "owner") return [];
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<DashboardRow>(`
        SELECT p.id AS project_id,
          p.owner_id || '/' || p.repository_name AS repository,
          p.state,
          i.state AS installation_state,
          i.revoked_at,
          p.config_version,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', r.id, 'mode', r.mode, 'state', r.state,
              'attemptCount', (SELECT count(*)::integer FROM jarvis.task_attempts a JOIN jarvis.tasks t ON t.id=a.task_id WHERE t.request_id=r.id AND t.project_id=p.id),
              'attempts', COALESCE((SELECT jsonb_agg(jsonb_build_object('ordinal', a.ordinal, 'state', a.state, 'observedAt', COALESCE(a.finished_at, a.created_at)) ORDER BY a.ordinal)
                FROM jarvis.task_attempts a JOIN jarvis.tasks t ON t.id=a.task_id WHERE t.request_id=r.id AND t.project_id=p.id), '[]'::jsonb),
              'remoteResult', COALESCE((
                SELECT CASE ai.state WHEN 'pending' THEN 'waiting' WHEN 'unknown' THEN 'unknown'
                  WHEN 'failed' THEN 'permanent_failure' WHEN 'succeeded' THEN 'known' ELSE 'unknown' END
                FROM jarvis.action_intents ai JOIN jarvis.tasks t ON t.id=ai.task_id
                WHERE t.request_id=r.id AND t.project_id=p.id AND ai.kind='create_pull_request'
                ORDER BY ai.updated_at DESC LIMIT 1
              ), 'unknown'),
              'observedAt', r.updated_at
            ) ORDER BY r.created_at DESC)
            FROM jarvis.requests r WHERE r.project_id=p.id AND r.owner_id=p.owner_id
          ), '[]'::jsonb) AS requests,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object('number', pr.number, 'state', pr.remote_state, 'observedAt', pr.observed_at)
              ORDER BY pr.number)
            FROM jarvis.pull_requests pr WHERE pr.project_id=p.id AND pr.repository_id=p.repository_id
          ), '[]'::jsonb) AS pull_requests,
          jsonb_build_object(
            'modelRequestCount', (SELECT count(*)::integer FROM jarvis.model_requests mr
              JOIN jarvis.requests r ON r.id=mr.request_id AND r.project_id=p.id AND r.owner_id=p.owner_id),
            'modelRequests', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', mr.id,
                'requestId', mr.request_id,
                'taskId', mr.task_id,
                'attemptId', mr.attempt_id,
                'provider', mr.provider,
                'model', mr.model,
                'purpose', mr.purpose,
                'state', mr.state,
                'dispatchedAt', mr.dispatched_at,
                'runtimeCoverage', mr.runtime_coverage,
                'observationsCount', (SELECT count(*)::integer FROM jarvis.usage_observations count_uo WHERE count_uo.model_request_id=mr.id),
                'ledger', CASE WHEN ul.model_request_id IS NULL THEN NULL ELSE jsonb_build_object(
                  'reserved', ul.reserved::text,
                  'tokenCounts', ul.token_counts,
                  'fieldStatuses', ul.field_statuses,
                  'estimatedCharge', ul.estimated_charge::text,
                  'providerReportedCharge', ul.provider_reported_charge::text,
                  'currency', btrim(ul.currency),
                  'reconciliationState', ul.reconciliation_state,
                  'updatedAt', ul.updated_at
                ) END,
                'observations', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'source', uo.source, 'revision', uo.revision, 'numericUsage', uo.numeric_usage,
                    'mappingVersion', uo.mapping_version, 'coverage', uo.coverage, 'observedAt', uo.observed_at,
                    'quotaSignals', uo.quota_signals
                  ) ORDER BY uo.observed_at DESC, uo.revision DESC)
                  FROM jarvis.usage_observations uo
                  WHERE uo.model_request_id=mr.id AND uo.id IN (
                    SELECT recent.id FROM jarvis.usage_observations recent
                    WHERE recent.model_request_id=mr.id
                    ORDER BY recent.observed_at DESC, recent.revision DESC LIMIT 100
                  )
                ), '[]'::jsonb)
              ) ORDER BY mr.created_at, mr.id)
              FROM jarvis.model_requests mr
              JOIN jarvis.requests r ON r.id=mr.request_id AND r.project_id=p.id AND r.owner_id=p.owner_id
              LEFT JOIN jarvis.usage_ledger ul ON ul.model_request_id=mr.id
              WHERE mr.id IN (
                SELECT recent.id FROM jarvis.model_requests recent
                JOIN jarvis.requests recent_request ON recent_request.id=recent.request_id
                WHERE recent_request.project_id=p.id AND recent_request.owner_id=p.owner_id
                ORDER BY recent.created_at, recent.id LIMIT 100
              )
            ), '[]'::jsonb),
            'allocationLimits', NULL,
            'allocationState', 'unknown',
            'coverage', 'unknown'
          ) AS usage,
          GREATEST(
            (SELECT max(r.updated_at) FROM jarvis.requests r WHERE r.project_id=p.id AND r.owner_id=p.owner_id),
            (SELECT max(pr.observed_at) FROM jarvis.pull_requests pr WHERE pr.project_id=p.id AND pr.repository_id=p.repository_id),
            (SELECT max(uo.observed_at) FROM jarvis.usage_observations uo
              JOIN jarvis.model_requests mr ON mr.id=uo.model_request_id
              JOIN jarvis.requests r ON r.id=mr.request_id AND r.project_id=p.id AND r.owner_id=p.owner_id)
          ) AS latest_observed_at
        FROM jarvis.projects p
        JOIN jarvis.installations i ON i.id=p.installation_id
        WHERE p.owner_id=$1 AND p.state <> 'removed'
        ORDER BY p.repository_id
      `, [ownerId]);
      return rows.map((row) => ({
        id: row.project_id,
        repository: row.repository,
        state: row.state,
        configVersion: row.config_version,
        configuration: { repository: row.repository, state: row.state, configVersion: row.config_version },
        requests: Array.isArray(row.requests) ? row.requests.map((value) => ({
          ...(value as PersistedDashboardRequest), attempts: (value as PersistedDashboardRequest).attempts ?? [], pullRequests: [],
        })) : [],
        pullRequests: Array.isArray(row.pull_requests) ? row.pull_requests as PersistedDashboardProject["pullRequests"] : [],
        health: row.installation_state === "active" && row.revoked_at === null ? "unknown" as const : "unavailable" as const,
        usage: safeUsage(row.usage),
        observedAt: row.latest_observed_at === null ? null : new Date(row.latest_observed_at).toISOString(),
      }));
    } finally { client.release(); }
  }
}

const UNSAFE_METRIC_KEY = /(?:secret|password|credential|private.?key|api.?key|access.?token|refresh.?token|bearer|prompt|repository.?content|^(?:token|session)$)/i;
const QUOTA_COUNTER_KEYS = new Set(["requestLimit", "requestRemaining", "tokenLimit", "tokenRemaining"]);
function safeUsage(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { modelRequestCount: null, modelRequests: [], modelRequestsTruncated: false, modelRequestsOmitted: null,
      allocationLimits: null, allocationState: "unknown", coverage: "unknown" };
  }
  const usage = value as Record<string, unknown>;
  const safeMap = (value: unknown, numeric: boolean): Record<string, number | string | null> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    const safe: Record<string, number | string | null> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
      if ((!QUOTA_COUNTER_KEYS.has(key) && UNSAFE_METRIC_KEY.test(key)) || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) continue;
      if (numeric && typeof entry === "number" && Number.isFinite(entry) && entry >= 0) safe[key] = entry;
      if (!numeric && typeof entry === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(entry)) safe[key] = entry;
      if (entry === null) safe[key] = null;
    }
    return safe;
  };
  const rows = Array.isArray(usage.modelRequests) ? usage.modelRequests.slice(0, 100) : [];
  const modelRequests = rows.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const ledgerValue = row.ledger;
    const ledger = ledgerValue !== null && typeof ledgerValue === "object" && !Array.isArray(ledgerValue)
      ? ledgerValue as Record<string, unknown> : null;
    const sourceObservations = Array.isArray(row.observations) ? row.observations : [];
    const observations = sourceObservations.slice(0, 100).flatMap((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
      const observation = entry as Record<string, unknown>;
      const rawQuota = observation.quotaSignals;
      const quota = rawQuota !== null && typeof rawQuota === "object" && !Array.isArray(rawQuota)
        ? rawQuota as Record<string, unknown> : null;
      const quotaFields = ["requestLimit", "requestRemaining", "tokenLimit", "tokenRemaining"] as const;
      const quotaCounters = safeMap(quota?.counters, true);
      const quotaCoverage = safeMap(quota?.coverage, false);
      const quotaSignals = quota === null ? null : {
        mappingVersion: safeLabel(quota.mappingVersion), source: quota.source === "provider-response-header" ? quota.source : null,
        provider: safeAttribution(quota.provider), observedAt: safeTimestamp(quota.observedAt),
        freshness: ["current", "stale", "unknown"].includes(String(quota.freshness)) ? quota.freshness : "unknown",
        counters: Object.fromEntries(quotaFields.map((field) => [field, typeof quotaCounters[field] === "number" ? quotaCounters[field] : null])),
        coverage: Object.fromEntries(quotaFields.map((field) => [field, ["reported", "unknown", "not_supported"].includes(String(quotaCoverage[field])) ? quotaCoverage[field] : "unknown"])),
      };
      return [{
        source: safeLabel(observation.source), revision: typeof observation.revision === "number" ? observation.revision : null,
        numericUsage: safeMap(observation.numericUsage, true), mappingVersion: safeLabel(observation.mappingVersion),
        coverage: safeLabel(observation.coverage), observedAt: safeTimestamp(observation.observedAt), quotaSignals,
      }];
    });
    const observationsCount = Number.isSafeInteger(row.observationsCount) && (row.observationsCount as number) >= sourceObservations.length
      ? row.observationsCount as number : sourceObservations.length;
    return {
      id: safeUuid(row.id), requestId: safeUuid(row.requestId), taskId: safeUuid(row.taskId), attemptId: safeUuid(row.attemptId),
      provider: safeAttribution(row.provider), model: safeAttribution(row.model), purpose: safeAttribution(row.purpose),
      state: safeLabel(row.state),
      runtimeCoverage: ["observed", "unknown", "not_supported"].includes(String(row.runtimeCoverage)) ? row.runtimeCoverage : "unknown",
      dispatchedAt: safeTimestamp(row.dispatchedAt),
      ledger: ledger === null ? null : {
        reserved: safeDecimal(ledger.reserved), tokenCounts: safeMap(ledger.tokenCounts, true),
        fieldStatuses: safeMap(ledger.fieldStatuses, false), estimatedCharge: safeDecimal(ledger.estimatedCharge),
        providerReportedCharge: safeDecimal(ledger.providerReportedCharge), currency: safeCurrency(ledger.currency),
        reconciliationState: safeLabel(ledger.reconciliationState), updatedAt: safeTimestamp(ledger.updatedAt),
      },
      observations, observationsCount, observationsTruncated: observationsCount > observations.length,
      observationsOmitted: Math.max(0, observationsCount - observations.length),
    };
  }).filter((entry) => entry !== null);
  return {
    modelRequestCount: Number.isSafeInteger(usage.modelRequestCount) && (usage.modelRequestCount as number) >= modelRequests.length
      ? usage.modelRequestCount : null,
    modelRequestsTruncated: Number.isSafeInteger(usage.modelRequestCount) && (usage.modelRequestCount as number) > modelRequests.length,
    modelRequestsOmitted: Number.isSafeInteger(usage.modelRequestCount) && (usage.modelRequestCount as number) >= modelRequests.length
      ? (usage.modelRequestCount as number) - modelRequests.length : null,
    modelRequests,
    allocationLimits: null,
    allocationState: "unknown",
    coverage: safeLabel(usage.coverage) ?? "unknown",
  };
}

function safeLabel(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(value) ? value : null;
}
function safeAttribution(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@/+ -]{0,127}$/.test(value) ? value : null;
}
function safeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function safeUuid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}
function safeDecimal(value: unknown): string | null {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,8})?$/.test(value) ? value : null;
}
function safeCurrency(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null;
}
