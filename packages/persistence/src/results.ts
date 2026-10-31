import { createHash } from "node:crypto";
import { canonicalizeTaskResult, type TaskResult } from "@jarvis/queue";
import type { SqlPool } from "./index.js";

type StoredResult = {
  result_json: TaskResult;
  digest: string;
};

/** Owner-scoped task result read. The owner and task are joined through the allowlisted project. */
export class PostgresTaskResultReadModel {
  constructor(private readonly pool: SqlPool) {}

  async getForOwner(ownerId: string, taskId: string): Promise<TaskResult | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) return null;
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<StoredResult>(`
        SELECT tr.payload_json AS result_json, tr.digest
        FROM jarvis.task_results tr
        JOIN jarvis.queue_entries q ON q.task_id = tr.task_id AND q.result_id = tr.id AND q.state = 'succeeded'
        JOIN jarvis.projects p ON p.id = tr.project_id AND p.repository_id = tr.repository_id
        JOIN jarvis.installations i ON i.id = p.installation_id
        WHERE p.owner_id = $1 AND p.state = 'active' AND i.state = 'active' AND i.revoked_at IS NULL
          AND tr.task_id = $2
      `, [ownerId, taskId]);
      const row = rows[0];
      if (row === undefined) return null;
      const digest = digestTaskResult(row.result_json);
      if (digest !== row.digest || row.result_json.taskId !== taskId) throw new Error("Stored task result integrity check failed");
      return row.result_json;
    } finally {
      client.release();
    }
}
}
export function digestTaskResult(result: TaskResult): string {
  return createHash("sha256").update(canonicalizeTaskResult(result)).digest("hex");
}