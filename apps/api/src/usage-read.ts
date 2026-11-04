import type { PostgresUsageReadModel, UsagePeriodFilter } from "@jarvis/persistence";
import type { OwnerAuthBoundary, OwnerAuthHttpRequest, OwnerAuthHttpResponse } from "./auth.js";
type UsageReadRequest = OwnerAuthHttpRequest & { readonly url: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL = /^[a-zA-Z0-9._:-]{1,96}$/;
const ALLOWED: Record<string, true> = { start: true, end: true, timeZone: true, projectId: true, taskId: true, provider: true, model: true, purpose: true, limit: true, cursor: true };

function filterFrom(request: UsageReadRequest, kind: "summary" | "requests"): UsagePeriodFilter {
  if (request.url.length > 2_048) throw new TypeError("Invalid usage query.");
  const url = new URL(request.url, "http://localhost");
  for (const key of url.searchParams.keys()) if (!Object.hasOwn(ALLOWED, key) || url.searchParams.getAll(key).length !== 1) throw new TypeError("Invalid usage query.");
  if (kind === "summary" && (url.searchParams.has("limit") || url.searchParams.has("cursor"))) throw new TypeError("Invalid usage query.");
  const required = (name: string): string => {
    const value = url.searchParams.get(name);
    if (!value) throw new TypeError("Invalid usage query.");
    return value;
  };
  const result: Record<string, unknown> = { start: required("start"), end: required("end"), timeZone: required("timeZone") };
  for (const key of ["projectId", "taskId", "provider", "model", "purpose"] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      if ((key === "projectId" || key === "taskId") ? !UUID.test(value) : !LABEL.test(value)) throw new TypeError("Invalid usage query.");
      result[key] = value;
    }
  }
  if (url.searchParams.has("limit")) {
    const raw = required("limit");
    if (!/^(?:[1-9][0-9]{0,2})$/.test(raw)) throw new TypeError("Invalid usage query.");
    result.limit = Number(raw);
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new TypeError("Invalid usage query.");
    result.cursor = cursor;
  }
  return result as UsagePeriodFilter;
}

export function createUsageReadBoundary(model: PostgresUsageReadModel, auth: OwnerAuthBoundary): {
  summary(request: UsageReadRequest): Promise<OwnerAuthHttpResponse>;
  requests(request: UsageReadRequest): Promise<OwnerAuthHttpResponse>;
} {
  const read = async (request: UsageReadRequest, kind: "summary" | "requests"): Promise<OwnerAuthHttpResponse> => {
    const authorization = await auth.authorizeRead(request);
    if (!authorization.authorized) return authorization.response;
    let filter: UsagePeriodFilter;
    try { filter = filterFrom(request, kind); }
    catch { return { status: 400, body: { error: "invalid_usage_query" }, headers: authorization.headers }; }
    try {
      const body = kind === "summary" ? await model.summary(authorization.auth.ownerId, filter) : await model.requests(authorization.auth.ownerId, filter);
      return { status: 200, body, headers: authorization.headers };
    } catch (error) {
      if (error instanceof TypeError) return { status: 400, body: { error: "invalid_usage_query" }, headers: authorization.headers };
      throw error;
    }
  };
  return { summary: (request) => read(request, "summary"), requests: (request) => read(request, "requests") };
}
