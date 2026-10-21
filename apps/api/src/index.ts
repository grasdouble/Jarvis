import { ProjectRequestIntake, type RequestSubmission } from "@jarvis/domain";

export const serviceName = "api";

export interface AuthenticatedOwnerContext { readonly ownerId: string }
export interface IntakeHttpRequest {
  readonly auth: AuthenticatedOwnerContext | null;
  readonly body: unknown;
  readonly idempotencyKey: string | null;
}
export interface IntakeHttpResponse { status: number; body: unknown }
export interface RequestIntakeBoundary {
  submit(request: IntakeHttpRequest): Promise<IntakeHttpResponse>;
  clarify(request: IntakeHttpRequest & { requestId: string; expectedVersion: number }): Promise<IntakeHttpResponse>;
}

function parseSubmission(body: unknown, idempotencyKey: string): RequestSubmission {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new TypeError("Request body must be an object.");
  const data = body as Record<string, unknown>;
  const allowed = new Set(["prompt", "projectId", "mode", "kind"]);
  if (Object.keys(data).some((key) => !allowed.has(key))) throw new TypeError("Request contains unsupported fields.");
  if (typeof data.prompt !== "string") throw new TypeError("prompt is required.");
  if (data.projectId !== undefined && typeof data.projectId !== "string") throw new TypeError("projectId must be a string.");
  if (data.mode !== undefined && data.mode !== "plan" && data.mode !== "dev") throw new TypeError("mode must be plan or dev.");
  if (data.kind !== undefined && data.kind !== "project" && data.kind !== "dependency_update") throw new TypeError("kind is invalid.");
  return {
    prompt: data.prompt,
    idempotencyKey,
    ...(data.projectId === undefined ? {} : { projectId: data.projectId as string }),
    ...(data.mode === undefined ? {} : { mode: data.mode as "plan" | "dev" }),
    ...(data.kind === undefined ? {} : { kind: data.kind as "project" | "dependency_update" }),
  };
}

function publicRequest(value: Awaited<ReturnType<ProjectRequestIntake["submit"]>>): unknown {
  return {
    id: value.id, state: value.state, clarification: value.clarification, version: value.version,
    projectId: value.projectId, mode: value.mode, kind: value.kind,
  };
}

/** HTTP adapter contract. Authentication is supplied by trusted middleware, never deserialized from body. */
export function createRequestIntakeBoundary(intake: ProjectRequestIntake): RequestIntakeBoundary {
  return {
    async submit(request: IntakeHttpRequest): Promise<IntakeHttpResponse> {
      if (!request.auth?.ownerId) return { status: 401, body: { error: "unauthenticated" } };
      if (!request.idempotencyKey) return { status: 422, body: { error: "idempotency_key_required" } };
      try {
        const saved = await intake.submit(request.auth.ownerId, parseSubmission(request.body, request.idempotencyKey));
        return { status: 202, body: publicRequest(saved) };
      } catch (error) {
        if (error instanceof TypeError) return { status: 422, body: { error: "invalid_request" } };
        if (error instanceof Error && (error.name === "RequestConflictError" || ["IDEMPOTENCY_CONFLICT", "PROJECT_AUTHORIZATION_STALE", "REQUEST_VERSION_CONFLICT"].includes(error.message))) return { status: 409, body: { error: "request_conflict" } };
        throw error;
      }
    },
    async clarify(request: IntakeHttpRequest & { requestId: string; expectedVersion: number }): Promise<IntakeHttpResponse> {
      if (!request.auth?.ownerId) return { status: 401, body: { error: "unauthenticated" } };
      if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1) return { status: 422, body: { error: "expected_version_required" } };
      if (!request.idempotencyKey) return { status: 422, body: { error: "idempotency_key_required" } };
      try {
        const saved = await intake.clarify(request.auth.ownerId, request.requestId, request.expectedVersion, parseSubmission(request.body, request.idempotencyKey));
        return { status: 202, body: publicRequest(saved) };
      } catch (error) {
        if (error instanceof TypeError) return { status: 422, body: { error: "invalid_request" } };
        if (error instanceof Error && (error.name === "RequestConflictError" || ["IDEMPOTENCY_CONFLICT", "PROJECT_AUTHORIZATION_STALE", "REQUEST_VERSION_CONFLICT"].includes(error.message))) return { status: 409, body: { error: "request_conflict" } };
        throw error;
      }
    },
  };
}
