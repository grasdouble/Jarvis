import type { OwnerAuthBoundary, OwnerAuthHttpRequest, OwnerAuthHttpResponse } from "./auth.js";
import type { PostgresStopControlStore } from "@jarvis/persistence";

/** Owner-session/CSRF protected stop and resume adapter. */
export interface StopControlChangedPort {
  /** Best-effort local wakeup; durable polling remains authoritative across processes/restarts. */
  notify(input: { readonly projectId?: string; readonly stopped: boolean }): Promise<void>;
}

export interface StopControlWorkerPort {
  stop(projectId?: string): Promise<void>;
}

/** Compose the authenticated persisted stop API with a colocated worker wakeup.
 * Cross-process/restart behavior still relies on the worker's durable polling.
 */
export function createOperationalStopControlHandler(store: PostgresStopControlStore, auth: OwnerAuthBoundary, worker: StopControlWorkerPort): ReturnType<typeof createStopControlHttpHandler> {
  return createStopControlHttpHandler(store, auth, {
    notify: ({ projectId, stopped }) => stopped ? worker.stop(projectId) : Promise.resolve(),
  });
}

export function createStopControlHttpHandler(store: PostgresStopControlStore, auth: OwnerAuthBoundary, changed?: StopControlChangedPort) {
  return async (request: OwnerAuthHttpRequest & { readonly method: string; readonly projectId?: string }): Promise<OwnerAuthHttpResponse> => {
    if (request.method === "GET") {
      const authorization = await auth.authorizeRead(request);
      if (!authorization.authorized) return authorization.response;
      return { status: 200, body: await store.get({ ...(request.projectId ? { projectId: request.projectId } : {}) }), headers: authorization.headers };
    }
    const authorization = await auth.authorizeMutation(request);
    if (!authorization.authorized) return authorization.response;
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 ||
        typeof (body as { stopped?: unknown }).stopped !== "boolean" ||
        !Number.isSafeInteger((body as { expectedVersion?: unknown }).expectedVersion) ||
        ((body as { expectedVersion: number }).expectedVersion < 0)) {
      return { status: 422, body: { error: "invalid_request" } };
    }
    try {
      await store.set({ ...(request.projectId ? { projectId: request.projectId } : {}), stopped: (body as { stopped: boolean }).stopped, expectedVersion: (body as { expectedVersion: number }).expectedVersion, ownerId: authorization.auth.ownerId });
      await changed?.notify({ ...(request.projectId ? { projectId: request.projectId } : {}), stopped: (body as { stopped: boolean }).stopped }).catch(() => undefined);
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "STOP_VERSION_CONFLICT") return { status: 409, body: { error: "version_conflict" } };
      if (error !== null && typeof error === "object" && "code" in error && error.code === "PROJECT_NOT_FOUND") return { status: 404, body: { error: "project_not_found" } };
      throw error;
    }
    return { status: 200, body: await store.get({ ...(request.projectId ? { projectId: request.projectId } : {}) }), headers: authorization.headers };
  };
}
