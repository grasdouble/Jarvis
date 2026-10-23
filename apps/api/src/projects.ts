import { RequestConflictError, type ProjectConfigurationRecord, type ProjectConfigurationService } from "@jarvis/domain";
import type { OwnerAuthBoundary, OwnerAuthHttpRequest, OwnerAuthHttpResponse } from "./auth.js";

export type AuthenticatedProjectConfigurationRequest = OwnerAuthHttpRequest;

export interface AuthenticatedProjectConfigurationBoundary {
  list(request: AuthenticatedProjectConfigurationRequest): Promise<OwnerAuthHttpResponse>;
  add(request: AuthenticatedProjectConfigurationRequest): Promise<OwnerAuthHttpResponse>;
  update(request: AuthenticatedProjectConfigurationRequest, repositoryId: string): Promise<OwnerAuthHttpResponse>;
  remove(request: AuthenticatedProjectConfigurationRequest, repositoryId: string): Promise<OwnerAuthHttpResponse>;
}

function bodyObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const prototype = Object.getPrototypeOf(body);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(body);
  for (const key of Reflect.ownKeys(body)) {
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return null;
  }
  return body as Record<string, unknown>;
}

function closedBody(body: unknown, fields: readonly string[]): Record<string, unknown> | null {
  const object = bodyObject(body);
  if (object === null || Object.keys(object).some((key) => !fields.includes(key))) return null;
  return object;
}

function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError("expectedVersion must be a positive integer.");
  return value as number;
}

function parseAdd(body: unknown): {
  repositoryId: string;
  installationId: string;
  repositoryOwner: string;
  repositoryName: string;
} {
  const object = closedBody(body, ["repositoryId", "installationId", "repositoryOwner", "repositoryName"]);
  if (object === null || typeof object.repositoryId !== "string" || typeof object.installationId !== "string"
    || typeof object.repositoryOwner !== "string" || typeof object.repositoryName !== "string") {
    throw new TypeError("Project input is invalid.");
  }
  return {
    repositoryId: object.repositoryId,
    installationId: object.installationId,
    repositoryOwner: object.repositoryOwner,
    repositoryName: object.repositoryName,
  };
}

function parseUpdate(body: unknown): { expectedVersion: number; changes: { repositoryOwner?: string; repositoryName?: string; state?: "active" | "suspended" } } {
  const object = closedBody(body, ["expectedVersion", "repositoryOwner", "repositoryName", "state"]);
  if (object === null) throw new TypeError("Project update is invalid.");
  const version = expectedVersion(object.expectedVersion);
  const changes: { repositoryOwner?: string; repositoryName?: string; state?: "active" | "suspended" } = {};
  if (object.repositoryOwner !== undefined) {
    if (typeof object.repositoryOwner !== "string") throw new TypeError("repositoryOwner is invalid.");
    changes.repositoryOwner = object.repositoryOwner;
  }
  if (object.repositoryName !== undefined) {
    if (typeof object.repositoryName !== "string") throw new TypeError("repositoryName is invalid.");
    changes.repositoryName = object.repositoryName;
  }
  if (object.state !== undefined) {
    if (object.state !== "active" && object.state !== "suspended") throw new TypeError("state is invalid.");
    changes.state = object.state;
  }
  if (Object.keys(changes).length === 0) throw new TypeError("At least one project change is required.");
  return { expectedVersion: version, changes };
}

function parseRemove(body: unknown): number {
  const object = closedBody(body, ["expectedVersion"]);
  if (object === null) throw new TypeError("Project removal is invalid.");
  return expectedVersion(object.expectedVersion);
}

function publicProject(project: ProjectConfigurationRecord): unknown {
  return {
    id: project.projectId,
    repositoryId: project.repositoryId,
    repositoryOwner: project.repositoryOwner,
    repositoryName: project.repositoryName,
    state: project.state,
    configVersion: project.configVersion,
  };
}

function failure(error: unknown): OwnerAuthHttpResponse | null {
  if (error instanceof TypeError) return { status: 422, body: { error: "invalid_request" }, headers: { "cache-control": "no-store" } };
  if (error instanceof RequestConflictError || (error instanceof Error && [
    "PROJECT_IDENTITY_CONFLICT", "PROJECT_CONFIG_VERSION_CONFLICT", "PROJECT_NOT_FOUND", "PROJECT_CONFIGURATION_UNAVAILABLE",
    "PROJECT_INSTALLATION_UNAVAILABLE", "PROJECT_NOT_ACTIVE",
  ].includes(error.message))) {
    return { status: 409, body: { error: "project_configuration_conflict" }, headers: { "cache-control": "no-store" } };
  }
  return null;
}

function authorizationResponse(result: Awaited<ReturnType<OwnerAuthBoundary["authorizeMutation"]>> | Awaited<ReturnType<OwnerAuthBoundary["authorizeRead"]>>): OwnerAuthHttpResponse | null {
  return result.authorized ? null : {
    status: result.response.status,
    body: result.response.body ?? null,
    ...(result.response.headers === undefined ? {} : { headers: result.response.headers }),
  };
}

/** Owner-only project allowlist API; the body contains metadata, never authority or actor fields. */
export function createAuthenticatedProjectConfigurationBoundary(
  configuration: ProjectConfigurationService,
  auth: OwnerAuthBoundary,
): AuthenticatedProjectConfigurationBoundary {
  return {
    async list(request): Promise<OwnerAuthHttpResponse> {
      const authorization = await auth.authorizeRead(request);
      if (!authorization.authorized) return authorizationResponse(authorization)!;
      try {
        return {
          status: 200,
          body: { projects: (await configuration.list()).map(publicProject) },
          headers: authorization.headers,
        };
      } catch (error) {
        const mapped = failure(error);
        if (mapped) return mapped;
        throw error;
      }
    },

    async add(request): Promise<OwnerAuthHttpResponse> {
      const authorization = await auth.authorizeMutation(request);
      if (!authorization.authorized) return authorizationResponse(authorization)!;
      try {
        const project = await configuration.add(authorization.auth.ownerId, parseAdd(request.body));
        return { status: 201, body: { project: publicProject(project) }, headers: authorization.headers };
      } catch (error) {
        const mapped = failure(error);
        if (mapped) return { ...mapped, headers: authorization.headers };
        throw error;
      }
    },

    async update(request, repositoryId): Promise<OwnerAuthHttpResponse> {
      const authorization = await auth.authorizeMutation(request);
      if (!authorization.authorized) return authorizationResponse(authorization)!;
      try {
        const update = parseUpdate(request.body);
        const project = await configuration.update(authorization.auth.ownerId, repositoryId, update.expectedVersion, update.changes);
        return { status: 200, body: { project: publicProject(project) }, headers: authorization.headers };
      } catch (error) {
        const mapped = failure(error);
        if (mapped) return { ...mapped, headers: authorization.headers };
        throw error;
      }
    },

    async remove(request, repositoryId): Promise<OwnerAuthHttpResponse> {
      const authorization = await auth.authorizeMutation(request);
      if (!authorization.authorized) return authorizationResponse(authorization)!;
      try {
        const version = parseRemove(request.body);
        const project = await configuration.remove(authorization.auth.ownerId, repositoryId, version);
        return { status: 200, body: { project: publicProject(project) }, headers: authorization.headers };
      } catch (error) {
        const mapped = failure(error);
        if (mapped) return { ...mapped, headers: authorization.headers };
        throw error;
      }
    },
  };
}
