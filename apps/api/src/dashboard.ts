import type { OwnerAuthBoundary, OwnerAuthHttpRequest, OwnerAuthHttpResponse } from "./auth.js";
import { PostgresOperationalDashboardReadModel, type SqlPool } from "@jarvis/persistence";

export interface DashboardProject {
  readonly id: string;
  readonly repository: string;
  readonly configVersion: number | null;
  readonly configuration: Readonly<Record<string, unknown>> | null;
  readonly requests: readonly DashboardRequest[];
  readonly pullRequests?: readonly DashboardPullRequest[];
  readonly state?: string;
  readonly health: "available" | "unavailable" | "unknown";
  readonly usage: Readonly<Record<string, unknown>> | null;
  readonly observedAt: string | null;
}

export interface DashboardRequest {
  readonly id: string;
  readonly mode: string | null;
  readonly state: string;
  readonly attemptCount: number | null;
  readonly attempts?: readonly { readonly ordinal: number; readonly state: string; readonly observedAt: string | null }[];
  readonly pullRequests: readonly DashboardPullRequest[];
  readonly remoteResult: "waiting" | "unavailable" | "permanent_failure" | "unknown" | "known";
  readonly observedAt: string | null;
}

export interface DashboardPullRequest {
  readonly number: number;
  readonly state: string;
  readonly observedAt: string | null;
  readonly url?: string;
}

/** Implementations must select only persisted, allowlisted owner/project-scoped rows. */
export interface OperationalDashboardReadModel {
  list(ownerId: string): Promise<readonly DashboardProject[]>;
}

export interface DashboardHttpRequest extends OwnerAuthHttpRequest {
  readonly method: string;
  readonly url: string;
}

const MAX_EXPORT_BYTES = 64 * 1024;
const MAX_TEXT = 1024;
const SECRET_KEY = /(?:secret|password|credential|private.?key|api.?key|access.?token|refresh.?token|bearer|prompt|repository.?content|^(?:token|session)$)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[bounded]";
  if (typeof value === "string") return value.slice(0, MAX_TEXT);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    result[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(item, depth + 1);
  }
  return result;
}

function safePayload(projects: readonly DashboardProject[]): unknown {
  const pullRequest = (repository: string, value: DashboardPullRequest): DashboardPullRequest => {
    const url = canonicalPullRequestUrl(repository, value.number);
    return { number: value.number, state: value.state, observedAt: value.observedAt, ...(url === null ? {} : { url }) };
  };
  const bounded = projects.slice(0, 50).map((project) => ({
    id: project.id,
    repository: project.repository,
    state: project.state ?? "unknown",
    configVersion: project.configVersion,
    configuration: project.configuration,
    health: project.health,
    usage: boundedUsage(project.usage),
    observedAt: project.observedAt,
    requests: project.requests.slice(0, 50).map((request) => ({
      id: request.id, mode: request.mode, state: request.state,
      attemptCount: request.attemptCount, attempts: request.attempts?.slice(0, 50), remoteResult: request.remoteResult, observedAt: request.observedAt,
      pullRequests: request.pullRequests.slice(0, 50).map((pr) => pullRequest(project.repository, pr)),
      truncation: {
        attemptsOmitted: Math.max(0, (request.attempts?.length ?? 0) - 50),
        pullRequestsOmitted: Math.max(0, request.pullRequests.length - 50),
      },
    })),
    pullRequests: (project.pullRequests ?? []).slice(0, 50).map((pr) => pullRequest(project.repository, pr)),
    truncation: {
      requestsOmitted: Math.max(0, project.requests.length - 50),
      pullRequestsOmitted: Math.max(0, (project.pullRequests?.length ?? 0) - 50),
    },
  }));
  return {
    provenance: { source: "persisted operational read model", generatedAt: new Date().toISOString() },
    truncation: { projectsOmitted: Math.max(0, projects.length - 50) },
    projects: redact(bounded),
  };
}

function boundedUsage(value: Readonly<Record<string, unknown>> | null): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { modelRequestCount: null, modelRequests: [], modelRequestsTruncated: false, modelRequestsOmitted: null, coverage: "unknown" };
  }
  const usage = value as Record<string, unknown>;
  const sourceRows = Array.isArray(usage.modelRequests) ? usage.modelRequests : [];
  const modelRequests = sourceRows.slice(0, 100).map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    const sourceObservations = Array.isArray(row.observations) ? row.observations : [];
    const observations = sourceObservations.slice(0, 100).flatMap((observation) => {
      if (observation === null || typeof observation !== "object" || Array.isArray(observation)) return [];
      const item = observation as Record<string, unknown>;
      return [{ source: item.source, revision: item.revision, numericUsage: item.numericUsage,
        mappingVersion: item.mappingVersion, coverage: item.coverage, observedAt: item.observedAt }];
    });
    const observationsCount = Number.isSafeInteger(row.observationsCount) && (row.observationsCount as number) >= sourceObservations.length
      ? row.observationsCount as number : sourceObservations.length;
    const ledger = row.ledger !== null && typeof row.ledger === "object" && !Array.isArray(row.ledger)
      ? row.ledger as Record<string, unknown> : null;
    const id = safeUsageUuid(row.id);
    const requestId = safeUsageUuid(row.requestId);
    const taskId = safeUsageUuid(row.taskId);
    const attemptId = safeUsageUuid(row.attemptId);
    const provider = safeAttributionLabel(row.provider);
    const model = safeAttributionLabel(row.model);
    const purpose = safeAttributionLabel(row.purpose);
    const state = safeLabel(row.state);
    const dispatchedAt = safeUsageTimestamp(row.dispatchedAt);
    return {
      ...(id === null ? {} : { id }), ...(requestId === null ? {} : { requestId }),
      ...(taskId === null ? {} : { taskId }), ...(attemptId === null ? {} : { attemptId }),
      ...(provider === null ? {} : { provider }), ...(model === null ? {} : { model }), ...(purpose === null ? {} : { purpose }),
      ...(state === null ? {} : { state }), ...(dispatchedAt === null ? {} : { dispatchedAt }),
      ledger: ledger === null ? null : {
        reserved: ledger.reserved, tokenCounts: ledger.tokenCounts, fieldStatuses: ledger.fieldStatuses,
        estimatedCharge: ledger.estimatedCharge, providerReportedCharge: ledger.providerReportedCharge,
        currency: ledger.currency, reconciliationState: ledger.reconciliationState, updatedAt: ledger.updatedAt,
      },
      observations,
      observationsCount,
      observationsTruncated: row.observationsTruncated === true || observationsCount > observations.length,
      observationsOmitted: Math.max(0, observationsCount - observations.length),
    };
  });
  const modelRequestCount = Number.isSafeInteger(usage.modelRequestCount) && (usage.modelRequestCount as number) >= modelRequests.length
    ? usage.modelRequestCount as number : null;
  return {
    allocationLimits: null,
    allocationState: safeLabel(usage.allocationState) ?? "unknown",
    coverage: safeLabel(usage.coverage) ?? "unknown",
    modelRequestCount,
    modelRequests,
    modelRequestsTruncated: usage.modelRequestsTruncated === true || (modelRequestCount !== null && modelRequestCount > modelRequests.length),
    modelRequestsOmitted: modelRequestCount === null ? null : Math.max(0, modelRequestCount - modelRequests.length),
  };
}

function safeUsageUuid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function safeAttributionLabel(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@/+ -]{0,127}$/.test(value) ? value : null;
}

function safeUsageTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeLabel(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : null;
}

function canonicalPullRequestUrl(repository: string, number: number): string | null {
  if (!Number.isSafeInteger(number) || number < 1 || repository.length > 201) return null;
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length < 1 || part.length > 100
    || part === "." || part === ".." || !/^[A-Za-z0-9_.-]+$/.test(part))) return null;
  const [owner, name] = parts;
  return `https://github.com/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/pull/${number}`;
}

/** Authenticated read-only dashboard and bounded export endpoints. */
export function createOperationalDashboardBoundary(model: OperationalDashboardReadModel, auth: OwnerAuthBoundary): {
  read(request: OwnerAuthHttpRequest): Promise<OwnerAuthHttpResponse>;
  export(request: OwnerAuthHttpRequest, format: "json" | "text"): Promise<OwnerAuthHttpResponse>;
} {
  return {
    async read(request: OwnerAuthHttpRequest): Promise<OwnerAuthHttpResponse> {
      const authorization = await auth.authorizeRead(request);
      if (!authorization.authorized) return authorization.response;
      const body = JSON.stringify(safePayload(await model.list(authorization.auth.ownerId)));
      if (Buffer.byteLength(body, "utf8") > MAX_EXPORT_BYTES) return { status: 413, body: { error: "dashboard_too_large" }, headers: authorization.headers };
      return { status: 200, body: JSON.parse(body) as unknown, headers: authorization.headers };
    },
    async export(request: OwnerAuthHttpRequest, format: "json" | "text"): Promise<OwnerAuthHttpResponse> {
      const authorization = await auth.authorizeRead(request);
      if (!authorization.authorized) return authorization.response;
      const payload = safePayload(await model.list(authorization.auth.ownerId));
      const body = format === "json" ? JSON.stringify(payload) : textExport(payload);
      if (Buffer.byteLength(body, "utf8") > MAX_EXPORT_BYTES) {
        return { status: 413, body: { error: "export_too_large" }, headers: authorization.headers };
      }
      return { status: 200, body, headers: { ...authorization.headers, "content-type": format === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8" } };
    },
  };
}

function textExport(payload: unknown): string {
  const data = payload as { provenance: { source: string; generatedAt: string }; truncation?: Record<string, unknown>; projects: Array<Record<string, unknown>> };
  const lines = [`Source: ${data.provenance.source}`, `Generated: ${data.provenance.generatedAt}`];
  const topTruncation = data.truncation as Record<string, unknown> | undefined;
  if (typeof topTruncation?.projectsOmitted === "number" && topTruncation.projectsOmitted > 0) {
    lines.push(`Bounded view omitted ${topTruncation.projectsOmitted} authorized project(s).`);
  }
  for (const project of data.projects) {
    lines.push(``, `Project: ${String(project.repository)} (${String(project.state)})`,
      `Configuration version: ${project.configVersion ?? "unknown"}`,
      `Configuration: ${safeConfigText(project.configuration)}`,
      `Health: ${String(project.health)}`,
      `Last observation: ${String(project.observedAt ?? "unknown")}`);
    const projectTruncation = project.truncation as Record<string, unknown> | undefined;
    if (typeof projectTruncation?.requestsOmitted === "number" && projectTruncation.requestsOmitted > 0) lines.push(`Bounded view omitted ${projectTruncation.requestsOmitted} request(s).`);
    if (typeof projectTruncation?.pullRequestsOmitted === "number" && projectTruncation.pullRequestsOmitted > 0) lines.push(`Bounded view omitted ${projectTruncation.pullRequestsOmitted} project pull request(s).`);
    const requests = project.requests as Array<Record<string, unknown>>;
    for (const request of requests) {
      lines.push(`Request ${String(request.id)}: mode=${String(request.mode ?? "unknown")}; state=${String(request.state)}; attempts=${String(request.attemptCount ?? "unknown")}; remote=${String(request.remoteResult)}; observed=${String(request.observedAt ?? "unknown")}`);
      for (const prValue of (request.pullRequests ?? []) as Array<Record<string, unknown>>) {
        lines.push(`  Pull request #${String(prValue.number)}: ${String(prValue.state)}; URL=${canonicalPullRequestUrl(String(project.repository), prValue.number as number) ?? "unknown"}; observed=${String(prValue.observedAt ?? "unknown")}`);
      }
    }
    for (const request of requests) {
      const requestTruncation = request.truncation as Record<string, unknown> | undefined;
      if (typeof requestTruncation?.attemptsOmitted === "number" && requestTruncation.attemptsOmitted > 0) lines.push(`Bounded view omitted ${requestTruncation.attemptsOmitted} attempt(s) for request ${String(request.id)}.`);
      if (typeof requestTruncation?.pullRequestsOmitted === "number" && requestTruncation.pullRequestsOmitted > 0) lines.push(`Bounded view omitted ${requestTruncation.pullRequestsOmitted} request pull request(s) for request ${String(request.id)}.`);
      const attempts = (request.attempts ?? []) as Array<Record<string, unknown>>;
      for (const attempt of attempts) lines.push(
        `  Attempt ${String(attempt.ordinal)}: ${String(attempt.state)}; observed=${String(attempt.observedAt ?? "unknown")}`,
      );
    }
    const pullRequests = (project.pullRequests ?? []) as Array<Record<string, unknown>>;
    for (const pullRequest of pullRequests) lines.push(
      `Pull request #${String(pullRequest.number)}: ${String(pullRequest.state)}; URL=${canonicalPullRequestUrl(String(project.repository), pullRequest.number as number) ?? "unknown"}; observed=${String(pullRequest.observedAt ?? "unknown")}`,
    );
    lines.push(...textUsage(project.usage));
  }
  return lines.join("\n");
}

function safeConfigText(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const config = value as Record<string, unknown>;
  const repository = typeof config.repository === "string" ? config.repository.slice(0, MAX_TEXT) : "unknown";
  const state = typeof config.state === "string" ? config.state.slice(0, 64) : "unknown";
  const version = Number.isSafeInteger(config.configVersion) ? String(config.configVersion) : "unknown";
  return `repository=${repository}; state=${state}; version=${version}`;
}

function textUsage(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["Usage: unknown / not available"];
  const usage = value as Record<string, unknown>;
  const count = Number.isSafeInteger(usage.modelRequestCount) && (usage.modelRequestCount as number) >= 0
    ? String(usage.modelRequestCount) : "unknown";
  const modelRequests = Array.isArray(usage.modelRequests) ? usage.modelRequests.slice(0, 100) : [];
  const omittedModelRequests = Number.isSafeInteger(usage.modelRequestsOmitted) && (usage.modelRequestsOmitted as number) > 0
    ? `; ${usage.modelRequestsOmitted} omitted` : usage.modelRequestsTruncated === true ? "; additional model requests omitted (count unknown)" : "";
  const lines = [
    `Usage model requests: ${count}${usage.modelRequestsTruncated === true ? " (first 100 shown)" : ""}${omittedModelRequests}; coverage: ${safeCode(usage.coverage)}`,
    `Allocation limits: unknown; allocation state: ${safeCode(usage.allocationState)}; no threshold or enforcement interpretation`,
  ];
  for (const [index, item] of modelRequests.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const modelRequest = item as Record<string, unknown>;
    const id = safeUuidText(modelRequest.id);
    lines.push(`Model request ${id}: state=${safeCode(modelRequest.state)}; dispatched=${safeTimestampText(modelRequest.dispatchedAt)}`,
      `  Provider/model: ${safeAttributionText(modelRequest.provider)}/${safeAttributionText(modelRequest.model)}`,
      `  Purpose: ${safeAttributionText(modelRequest.purpose)}`,
      `  Request: ${safeUuidText(modelRequest.requestId)}; Task: ${safeUuidText(modelRequest.taskId)}; Attempt: ${safeUuidText(modelRequest.attemptId)}`);
    if (modelRequest.ledger === null || typeof modelRequest.ledger !== "object" || Array.isArray(modelRequest.ledger)) {
      lines.push("  Ledger: unknown / not recorded");
    } else {
      const ledger = modelRequest.ledger as Record<string, unknown>;
      lines.push(`  Token counts: ${safeMetricText(ledger.tokenCounts, "numeric")}`,
        `  Field statuses: ${safeMetricText(ledger.fieldStatuses, "status")}`,
        `  Reserved: ${safeDecimalText(ledger.reserved)} (persisted; not spend)`,
        `  Estimated charge: ${safeDecimalText(ledger.estimatedCharge)}; provider-reported charge: ${safeDecimalText(ledger.providerReportedCharge)}; stored currency: ${safeCurrencyText(ledger.currency)}`,
        `  Reconciliation: ${safeCode(ledger.reconciliationState)}; ledger updated: ${safeTimestampText(ledger.updatedAt)}`);
    }
    const observations = Array.isArray(modelRequest.observations) ? modelRequest.observations.slice(0, 100) : [];
    if (observations.length === 0) lines.push("  Usage observations: unknown / not recorded");
    for (const observationValue of observations) {
      if (observationValue === null || typeof observationValue !== "object" || Array.isArray(observationValue)) continue;
      const observation = observationValue as Record<string, unknown>;
      lines.push(`  Observation: source=${safeCode(observation.source)}; revision=${safePositiveInteger(observation.revision)}; mapping=${safeCode(observation.mappingVersion)}; coverage=${safeCode(observation.coverage)}; observed=${safeTimestampText(observation.observedAt)}`,
        `    Numeric usage: ${safeMetricText(observation.numericUsage, "numeric")}`);
    }
    if (typeof modelRequest.observationsOmitted === "number" && modelRequest.observationsOmitted > 0) {
      lines.push(`  Bounded view omitted ${modelRequest.observationsOmitted} usage observation(s).`);
    }
    if (index === 99 && modelRequests.length === 100) lines.push("  Further model requests are not included in this bounded export.");
  }
  return lines;
}

function safeMetricText(value: unknown, mode: "numeric" | "status"): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const entries: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
    if (SECRET_KEY.test(key) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (item === null) entries.push(`${key}=unknown`);
    else if (mode === "numeric" && typeof item === "number" && Number.isFinite(item) && item >= 0) entries.push(`${key}=${item}`);
    else if (mode === "status" && typeof item === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(item)) entries.push(`${key}=${safeCode(item)}`);
  }
  return entries.length === 0 ? "unknown" : entries.join(", ");
}

function safeCode(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : "unknown";
}
function safeAttributionText(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@/+ -]{0,127}$/.test(value) ? value : "unknown";
}
function safeUuidText(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : "unknown";
}
function safeTimestampText(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : "unknown";
}
function safeDecimalText(value: unknown): string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,8})?$/.test(value) ? value : "unknown";
}
function safeCurrencyText(value: unknown): string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : "unknown";
}
function safePositiveInteger(value: unknown): string {
  return Number.isSafeInteger(value) && (value as number) > 0 ? String(value) : "unknown";
}

/** Framework-neutral real HTTP route adapter for GET dashboard and export routes. */
export function createOperationalDashboardHttpHandler(boundary: ReturnType<typeof createOperationalDashboardBoundary>):
  (request: DashboardHttpRequest) => Promise<OwnerAuthHttpResponse> {
  return async (request) => {
    if (request.method !== "GET") return { status: 405, body: { error: "method_not_allowed" }, headers: { allow: "GET", "cache-control": "no-store" } };
    let url: URL;
    try { url = new URL(request.url, "http://jarvis.local"); }
    catch { return { status: 404, body: { error: "not_found" } }; }
    if (url.pathname === "/api/v1/dashboard") return boundary.read(request);
    if (url.pathname === "/api/v1/dashboard/export.json") return boundary.export(request, "json");
    if (url.pathname === "/api/v1/dashboard/export.txt") return boundary.export(request, "text");
    return { status: 404, body: { error: "not_found" }, headers: { "cache-control": "no-store" } };
  };
}

/** Production composition uses the PostgreSQL read model; no dashboard writes are available. */
export function createPostgresOperationalDashboardHttpHandler(pool: SqlPool, auth: OwnerAuthBoundary):
  (request: DashboardHttpRequest) => Promise<OwnerAuthHttpResponse> {
  return createOperationalDashboardHttpHandler(createOperationalDashboardBoundary(
    new PostgresOperationalDashboardReadModel(pool), auth,
  ));
}
