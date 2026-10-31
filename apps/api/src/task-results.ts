import type { TaskResult } from "@jarvis/contracts";
import type { OwnerAuthBoundary, OwnerAuthHttpRequest, OwnerAuthHttpResponse } from "./auth.js";

export interface TaskResultReadModel {
  getForOwner(ownerId: string, taskId: string): Promise<TaskResult | null>;
}

/** Owner-authenticated, project-scoped task result read port. */
export function createTaskResultReadBoundary(model: TaskResultReadModel, auth: OwnerAuthBoundary): {
  get(request: OwnerAuthHttpRequest, taskId: string): Promise<OwnerAuthHttpResponse>;
} {
  return {
    async get(request, taskId): Promise<OwnerAuthHttpResponse> {
      const authorization = await auth.authorizeRead(request);
      if (!authorization.authorized) return authorization.response;
      const result = await model.getForOwner(authorization.auth.ownerId, taskId);
      return result === null
        ? { status: 404, body: { error: "not_found" }, headers: authorization.headers }
        : { status: 200, body: result, headers: authorization.headers };
    },
  };
}
