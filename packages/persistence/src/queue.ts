import { QueueError, type QueueFailure, type QueueLease, type QueueResult, type QueueStore, type QueueTask, type TaskResult } from "@jarvis/queue";
import { digestTaskResult } from "./results.js";
import type { SqlClient, SqlPool } from "./index.js";

type QueuePayload = { taskId: string };
type QueueRow = {
  id: string;
  task_id: string;
  event_id: string;
  state: QueueTask<QueuePayload>["status"];
  created_at: Date | string;
  available_at: Date | string;
  deadline: Date | string;
  max_attempts: number;
  attempt_count: number;
  lease_epoch: string | number;
  lease_until: Date | string | null;
  worker_id: string | null;
  attempt_id?: string | null;
  deadline_expired?: boolean;
  retry_base_delay_ms: number;
  retry_max_delay_ms: number;
  result_json: QueueResult | null;
  error_json: QueueFailure | null;
};

const MAX_JSON_BYTES = 16 * 1024;
const MAX_CANONICAL_RESULT_BYTES = 32 * 1024;
const jsonValue = (value: unknown, field: string, maxBytes = MAX_JSON_BYTES): string | null => {
  if (value === undefined) return null;
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { throw new QueueError("INVALID_QUEUE_VALUE", `${field} must be JSON serializable`); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new QueueError("INVALID_QUEUE_VALUE", `${field} must be at most ${maxBytes} bytes`);
  }
  return encoded;
};

const epoch = (value: Date | string): number => new Date(value).getTime();
const seconds = (value: number): string => new Date(value).toISOString();

function toTask(row: QueueRow): QueueTask<QueuePayload> {
  const task: QueueTask<QueuePayload> = {
    id: row.id,
    eventId: row.event_id,
    taskId: row.task_id,
    payload: { taskId: row.task_id },
    status: row.state,
    createdAt: epoch(row.created_at),
    availableAt: epoch(row.available_at),
    deadline: epoch(row.deadline),
    maxAttempts: row.max_attempts,
    attempt: row.attempt_count,
    epoch: Number(row.lease_epoch),
    retry: { baseDelay: row.retry_base_delay_ms, maxDelay: row.retry_max_delay_ms },
  };
  if (row.state === "leased" && row.lease_until !== null && row.worker_id !== null) {
    task.lease = { worker: row.worker_id, epoch: task.epoch, expiresAt: epoch(row.lease_until) };
  }
  if (row.result_json !== null) task.result = row.result_json;
  if (row.error_json !== null) task.error = row.error_json;
  return task;
}

async function begin(client: SqlClient): Promise<void> { await client.query("BEGIN"); }
async function commit(client: SqlClient): Promise<void> { await client.query("COMMIT"); }
async function rollback(client: SqlClient): Promise<void> { await client.query("ROLLBACK").catch(() => undefined); }

async function emit(
  client: SqlClient,
  taskId: string,
  eventType: string,
  key: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(`
    INSERT INTO jarvis.outbox (aggregate_id, event_type, payload, dedupe_key)
    VALUES ($1, $2, $3::jsonb, $4)
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  `, [taskId, eventType, JSON.stringify(payload), key]);
}

export class PostgresQueueStore implements QueueStore<QueuePayload> {
  constructor(private readonly pool: SqlPool) {}

  async enqueue(task: QueueTask<QueuePayload>, eventId: string): Promise<QueueTask<QueuePayload>> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await begin(client);
      const { rows: taskProjects } = await client.query<{ project_id: string }>(
        "SELECT project_id FROM jarvis.tasks WHERE id = $1", [task.taskId],
      );
      const projectId = taskProjects[0]?.project_id;
      if (projectId === undefined) {
        throw new QueueError("TASK_NOT_AUTHORIZED", "Only an active, core-authorized durable queued task can enter the queue");
      }
      // Coordinate with global stop mutations before taking project locks. The
      // authorization read below gets a fresh READ COMMITTED snapshot after
      // both gates have been acquired.
      await client.query("SELECT pg_advisory_xact_lock_shared(1246849618)");
      await client.query("SELECT id FROM jarvis.projects WHERE id = $1 FOR SHARE", [projectId]);
      const { rows: authorized } = await client.query<{ id: string }>(`
        SELECT t.id
        FROM jarvis.tasks t
        JOIN jarvis.requests r ON r.id = t.request_id AND r.project_id = t.project_id AND r.repository_id = t.repository_id
         JOIN jarvis.projects p ON p.id = t.project_id AND p.repository_id = t.repository_id
         JOIN jarvis.installations i ON i.id = p.installation_id
         JOIN jarvis.stop_controls global_stop ON global_stop.scope = 'global' AND global_stop.project_id IS NULL
         WHERE t.id = $1 AND t.state = 'queued' AND r.state = 'queued'
           AND p.state = 'active' AND i.state = 'active' AND i.revoked_at IS NULL
           AND global_stop.stopped = false
           AND NOT EXISTS (SELECT 1 FROM jarvis.stop_controls project_stop WHERE project_stop.scope = 'project' AND project_stop.project_id = p.id AND project_stop.stopped)
          AND p.config_version = t.config_version AND t.config_version = r.config_version
          AND t.policy_hash = r.policy_hash
        FOR KEY SHARE OF t, r, p, i
      `, [task.taskId]);
      if (authorized[0] === undefined) {
        throw new QueueError("TASK_NOT_AUTHORIZED", "Only an active, core-authorized durable queued task can enter the queue");
      }

      const { rows: conflicts } = await client.query<QueueRow>(`
        SELECT q.id, q.task_id, q.event_id, q.state, q.created_at, q.available_at, q.deadline,
               q.max_attempts, q.attempt_count, q.lease_epoch, q.lease_until, q.worker_id,
               q.retry_base_delay_ms, q.retry_max_delay_ms, q.result_json, q.error_json
        FROM jarvis.queue_entries q
        WHERE q.event_id = $1 OR q.task_id = $2
        FOR UPDATE
      `, [eventId, task.taskId]);
      if (conflicts.length > 0) {
        const existing = conflicts.find((row) => row.event_id === eventId);
        if (existing === undefined || existing.task_id !== task.taskId ||
            epoch(existing.deadline) !== task.deadline || existing.max_attempts !== task.maxAttempts ||
            existing.retry_base_delay_ms !== task.retry.baseDelay || existing.retry_max_delay_ms !== task.retry.maxDelay) {
          throw new QueueError("QUEUE_EVENT_CONFLICT", "Queue event or task identity was already used with different task parameters");
        }
        await commit(client);
        committed = true;
        return toTask(existing);
      }

      const { rows } = await client.query<QueueRow>(`
        INSERT INTO jarvis.queue_entries
          (task_id, event_id, state, available_at, deadline, max_attempts,
           retry_base_delay_ms, retry_max_delay_ms)
        VALUES ($1, $2, 'queued', clock_timestamp(), $3, $4, $5, $6)
        RETURNING id, task_id, event_id, state, created_at, available_at, deadline,
                  max_attempts, attempt_count, lease_epoch, lease_until, worker_id,
                  retry_base_delay_ms, retry_max_delay_ms, result_json, error_json
      `, [task.taskId, eventId, seconds(task.deadline), task.maxAttempts, task.retry.baseDelay, task.retry.maxDelay]);
      const saved = rows[0];
      if (saved === undefined) throw new Error("Queue insert returned no row");
      await emit(client, task.taskId, "queue.task.queued", `queue:${task.taskId}:queued:0`, { taskId: task.taskId, eventId });
      await commit(client);
      committed = true;
      return toTask(saved);
    } catch (error) {
      if (!committed) await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async claim(worker: string, _now: number, leaseMs: number): Promise<QueueLease<QueuePayload> | null> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await begin(client);
      const { rows } = await client.query<QueueRow & { project_id: string; repository_id: string }>(`
        SELECT q.id, q.task_id, q.event_id, q.state, q.created_at, q.available_at, q.deadline,
               q.max_attempts, q.attempt_count, q.lease_epoch, q.lease_until, q.worker_id,
               q.attempt_id, (q.deadline <= clock_timestamp()) AS deadline_expired,
               q.retry_base_delay_ms, q.retry_max_delay_ms, q.result_json, q.error_json,
               t.project_id, t.repository_id
        FROM jarvis.queue_entries q
        JOIN jarvis.tasks t ON t.id = q.task_id
        JOIN jarvis.requests r ON r.id = t.request_id AND r.project_id = t.project_id AND r.repository_id = t.repository_id
         JOIN jarvis.projects p ON p.id = t.project_id AND p.repository_id = t.repository_id
         JOIN jarvis.installations i ON i.id = p.installation_id
         JOIN jarvis.stop_controls global_stop ON global_stop.scope = 'global' AND global_stop.project_id IS NULL
        WHERE ((q.state = 'queued' AND q.available_at <= clock_timestamp())
           OR (q.state = 'leased' AND q.lease_until <= clock_timestamp()))
          AND r.state IN ('queued', 'running')
           AND p.state = 'active' AND i.state = 'active' AND i.revoked_at IS NULL
           AND global_stop.stopped = false
           AND NOT EXISTS (SELECT 1 FROM jarvis.stop_controls project_stop WHERE project_stop.scope = 'project' AND project_stop.project_id = p.id AND project_stop.stopped)
          AND p.config_version = t.config_version AND t.config_version = r.config_version
          AND t.policy_hash = r.policy_hash
        ORDER BY q.available_at, q.created_at, q.id
         FOR UPDATE OF q, t, r, p, i, global_stop SKIP LOCKED
        LIMIT 1
      `);
      const candidate = rows[0];
      if (candidate === undefined) {
        await commit(client);
        committed = true;
        return null;
      }

      if (candidate.state === "leased" && candidate.attempt_id) {
        await client.query(`
          UPDATE jarvis.task_attempts
          SET state = 'expired', finished_at = clock_timestamp()
          WHERE id = $1 AND task_id = $2 AND lease_epoch = $3 AND state = 'active'
        `, [candidate.attempt_id, candidate.task_id, candidate.lease_epoch]);
      }

      const nextAttempt = candidate.attempt_count + 1;
      if (nextAttempt > candidate.max_attempts || candidate.deadline_expired) {
        await client.query(`
          UPDATE jarvis.queue_entries
          SET state = 'failed', lease_until = NULL, worker_id = NULL,
              error_json = '{"kind":"permanent","code":"deadline_or_attempts_exhausted"}'::jsonb,
              updated_at = clock_timestamp()
          WHERE id = $1
        `, [candidate.id]);
        await client.query("UPDATE jarvis.tasks SET state = 'failed', updated_at = clock_timestamp() WHERE id = $1", [candidate.task_id]);
        await client.query("UPDATE jarvis.requests SET state = 'failed', updated_at = clock_timestamp() WHERE id = (SELECT request_id FROM jarvis.tasks WHERE id = $1)", [candidate.task_id]);
        await emit(client, candidate.task_id, "queue.task.failed", `queue:${candidate.task_id}:failed:${candidate.lease_epoch}`, {
          taskId: candidate.task_id, code: "deadline_or_attempts_exhausted",
        });
        await commit(client);
        committed = true;
        return null;
      }

      const nextEpoch = Number(candidate.lease_epoch) + 1;
      const { rows: attempts } = await client.query<{ id: string; lease_until: Date }>(`
        INSERT INTO jarvis.task_attempts
          (task_id, project_id, repository_id, ordinal, lease_epoch, lease_until, worker_id, state)
        VALUES ($1, $2, $3, $4, $5, clock_timestamp() + ($6 * interval '1 millisecond'), $7, 'active')
        RETURNING id, lease_until
      `, [candidate.task_id, candidate.project_id, candidate.repository_id, nextAttempt, nextEpoch, leaseMs, worker]);
      const attempt = attempts[0];
      if (attempt === undefined) throw new Error("Lease claim did not create an attempt");

      const { rows: updatedRows } = await client.query<QueueRow>(`
        UPDATE jarvis.queue_entries
        SET state = 'leased', attempt_count = $2, lease_epoch = $3,
            attempt_id = $4, lease_until = $5, worker_id = $6,
            updated_at = clock_timestamp()
        WHERE id = $1
        RETURNING id, task_id, event_id, state, created_at, available_at, deadline,
                  max_attempts, attempt_count, lease_epoch, lease_until, worker_id,
                  retry_base_delay_ms, retry_max_delay_ms, result_json, error_json
      `, [candidate.id, nextAttempt, nextEpoch, attempt.id, attempt.lease_until, worker]);
      await client.query("UPDATE jarvis.tasks SET state = 'running', updated_at = clock_timestamp() WHERE id = $1", [candidate.task_id]);
      await client.query("UPDATE jarvis.requests SET state = 'running', updated_at = clock_timestamp() WHERE id = (SELECT request_id FROM jarvis.tasks WHERE id = $1)", [candidate.task_id]);
      await emit(client, candidate.task_id, "queue.task.leased", `queue:${candidate.task_id}:leased:${nextEpoch}`, {
        taskId: candidate.task_id, attemptId: attempt.id, leaseEpoch: nextEpoch,
      });
      const updated = updatedRows[0];
      if (updated === undefined) throw new Error("Lease claim returned no queue row");
      await commit(client);
      committed = true;
      const task = toTask(updated);
      return { task, worker, attemptId: attempt.id, epoch: task.epoch, expiresAt: task.lease?.expiresAt ?? epoch(attempt.lease_until) };
    } catch (error) {
      if (!committed) await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<QueueTask<QueuePayload> | undefined> {
    const { rows } = await this.pool.connect().then(async (client) => {
      try {
        return await client.query<QueueRow>(`
          SELECT id, task_id, event_id, state, created_at, available_at, deadline,
                 max_attempts, attempt_count, lease_epoch, lease_until, worker_id,
                 retry_base_delay_ms, retry_max_delay_ms, result_json, error_json
          FROM jarvis.queue_entries WHERE id = $1
        `, [id]);
      } finally { client.release(); }
    });
    const row = rows[0];
    return row === undefined ? undefined : toTask(row);
  }

  async cancel(id: string): Promise<QueueTask<QueuePayload>> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await begin(client);
      const { rows } = await client.query<QueueRow>(`
        SELECT id, task_id, event_id, state, created_at, available_at, deadline,
               max_attempts, attempt_count, lease_epoch, lease_until, worker_id,
               attempt_id, retry_base_delay_ms, retry_max_delay_ms, result_json, error_json
        FROM jarvis.queue_entries WHERE id = $1 FOR UPDATE
      `, [id]);
      const current = rows[0];
      if (current === undefined) throw new QueueError("QUEUE_TASK_NOT_FOUND", "Queue task does not exist");
      if (["succeeded", "failed", "cancelled"].includes(current.state)) {
        await commit(client);
        committed = true;
        return toTask(current);
      }
      if (current.state === "reconciliation_required") {
        throw new QueueError("RECONCILIATION_REQUIRED", "An uncertain external effect must be reconciled before cancellation");
      }
      if (current.state === "leased" && current.attempt_id !== undefined && current.attempt_id !== null) {
        const { rowCount } = await client.query(`
          UPDATE jarvis.task_attempts
          SET state = 'cancelled', finished_at = clock_timestamp()
          WHERE id = $1 AND task_id = $2 AND lease_epoch = $3 AND state = 'active'
        `, [current.attempt_id, current.task_id, current.lease_epoch]);
        if (rowCount !== 1) throw new QueueError("STALE_LEASE", "Active attempt changed before cancellation");
      }
      const { rows: updatedRows } = await client.query<QueueRow>(`
        UPDATE jarvis.queue_entries
        SET state = 'cancelled', lease_epoch = lease_epoch + CASE WHEN state = 'leased' THEN 1 ELSE 0 END,
            lease_until = NULL, worker_id = NULL, updated_at = clock_timestamp()
        WHERE id = $1 AND state = $2
        RETURNING id, task_id, event_id, state, created_at, available_at, deadline,
                  max_attempts, attempt_count, lease_epoch, lease_until, worker_id,
                  attempt_id, retry_base_delay_ms, retry_max_delay_ms, result_json, error_json
      `, [id, current.state]);
      const updated = updatedRows[0];
      if (updated === undefined) throw new QueueError("QUEUE_STATE_CHANGED", "Queue task changed before cancellation");
      await client.query("UPDATE jarvis.tasks SET state = 'cancelled', updated_at = clock_timestamp() WHERE id = $1", [current.task_id]);
      await client.query("UPDATE jarvis.requests SET state = 'cancelled', updated_at = clock_timestamp() WHERE id = (SELECT request_id FROM jarvis.tasks WHERE id = $1)", [current.task_id]);
      await emit(client, current.task_id, "queue.task.cancelled", `queue:${current.task_id}:cancelled:${updated.lease_epoch}`, {
        taskId: current.task_id, leaseEpoch: Number(updated.lease_epoch),
      });
      await commit(client);
      committed = true;
      return toTask(updated);
    } catch (error) {
      if (!committed) await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async update(task: QueueTask<QueuePayload>, lease?: QueueLease<QueuePayload>, canonicalResult?: TaskResult): Promise<QueueTask<QueuePayload>> {
    const resultJson = jsonValue(task.result, "result");
    const errorJson = jsonValue(task.error, "error");
    const canonicalJson = canonicalResult === undefined ? null : jsonValue(canonicalResult, "canonical result", MAX_CANONICAL_RESULT_BYTES);
    const client = await this.pool.connect();
    let committed = false;
    try {
      await begin(client);
      const leaseGuard = lease === undefined
        ? `q.state = 'reconciliation_required' AND q.lease_epoch = $2`
        : `q.state = 'leased' AND q.lease_epoch = $2 AND q.worker_id = $3 AND q.lease_until > clock_timestamp()`;
      const values = lease === undefined
        ? [task.id, task.epoch, task.status, new Date(task.availableAt), resultJson, errorJson, canonicalResult?.resultId ?? null]
        : [task.id, lease.epoch, lease.worker, task.status, new Date(task.availableAt), resultJson, errorJson, canonicalResult?.resultId ?? null];
      const statusIndex = lease === undefined ? "$3" : "$4";
      const availableIndex = lease === undefined ? "$4" : "$5";
      const resultIndex = lease === undefined ? "$5" : "$6";
      const errorIndex = lease === undefined ? "$6" : "$7";
      const resultIdIndex = lease === undefined ? "$7" : "$8";
      if (canonicalResult !== undefined) {
        if (lease === undefined || task.status !== "succeeded" || task.result?.id !== canonicalResult.resultId) {
          throw new QueueError("INVALID_RESULT", "Canonical result requires a matching successful leased completion");
        }
        const activeLease = await client.query(`
          SELECT q.id
          FROM jarvis.queue_entries q
          JOIN jarvis.task_attempts a
            ON a.id = q.attempt_id AND a.task_id = q.task_id
           AND a.lease_epoch = q.lease_epoch AND a.state = 'active'
          WHERE q.id = $1 AND q.task_id = $2 AND q.attempt_id = $5
            AND q.state = 'leased' AND q.lease_epoch = $3 AND q.worker_id = $4
            AND q.lease_until > clock_timestamp()
          FOR UPDATE OF q
        `, [task.id, task.taskId, lease.epoch, lease.worker, lease.attemptId]);
        if (activeLease.rowCount !== 1) {
          throw new QueueError("STALE_LEASE", "Queue state changed or the lease expired before result persistence");
        }
        const inserted = await client.query(`
          INSERT INTO jarvis.task_results
            (id, task_id, request_id, project_id, repository_id, attempt_id, lease_epoch,
             mode, source_revision, provider, model, schema_version, payload_json, digest)
          SELECT $1, t.id, r.id, t.project_id, t.repository_id, a.id, a.lease_epoch,
                 $6, $7, $8, $9, 1, $10::jsonb, $11
          FROM jarvis.tasks t
          JOIN jarvis.requests r ON r.id = t.request_id AND r.project_id = t.project_id AND r.repository_id = t.repository_id
          JOIN jarvis.task_attempts a ON a.task_id = t.id AND a.id = $3 AND a.lease_epoch = $4 AND a.state = 'active'
          WHERE t.id = $2 AND r.id = $5 AND t.mode = $6 AND COALESCE(t.revision, '') = $7
          ON CONFLICT DO NOTHING
          RETURNING id
        `, [canonicalResult.resultId, task.taskId, lease.attemptId, lease.epoch, canonicalResult.requestId,
          canonicalResult.mode, canonicalResult.sourceRevision, canonicalResult.provider, canonicalResult.model,
          canonicalJson, digestTaskResult(canonicalResult)]);
        if (inserted.rowCount !== 1) {
          throw new QueueError("RESULT_CONFLICT", "Canonical result identity is already stored or its trusted attribution does not match");
        }
      }
      if (task.status === "succeeded" && task.result !== undefined && canonicalResult === undefined) {
        const { rows: taskRows } = await client.query<{ mode: string }>("SELECT mode FROM jarvis.tasks WHERE id = $1", [task.taskId]);
        if (taskRows[0]?.mode === "plan" || taskRows[0]?.mode === "dev") {
          throw new QueueError("MISSING_CANONICAL_RESULT", "Successful plan/dev completion requires a canonical stored result");
        }
      }
      const { rows } = await client.query<QueueRow>(`
        UPDATE jarvis.queue_entries q
        SET state = ${statusIndex}, available_at = ${availableIndex},
            lease_until = NULL, worker_id = NULL, result_id = ${resultIdIndex}::uuid,
            result_json = ${resultIndex}::jsonb, error_json = ${errorIndex}::jsonb
        WHERE q.id = $1 AND ${leaseGuard}
        RETURNING q.id, q.task_id, q.event_id, q.state, q.created_at, q.available_at, q.deadline,
                  q.max_attempts, q.attempt_count, q.lease_epoch, q.lease_until, q.worker_id,
                  q.retry_base_delay_ms, q.retry_max_delay_ms, q.result_json, q.error_json
      `, values);
      const updated = rows[0];
      if (updated === undefined) throw new QueueError("STALE_LEASE", "Queue state changed or the lease expired before the transition committed");

      if (lease !== undefined) {
        const attemptState = task.status === "succeeded" ? "succeeded" : "failed";
        const { rowCount } = await client.query(`
          UPDATE jarvis.task_attempts
          SET state = $4, finished_at = clock_timestamp()
          WHERE id = (SELECT attempt_id FROM jarvis.queue_entries WHERE id = $1)
            AND task_id = (SELECT task_id FROM jarvis.queue_entries WHERE id = $1)
            AND lease_epoch = $2 AND worker_id = $3 AND state = 'active'
        `, [task.id, lease.epoch, lease.worker, attemptState]);
        if (rowCount !== 1) throw new QueueError("STALE_LEASE", "The active attempt no longer matches the lease");
      }

      const taskState = task.status === "succeeded" ? "completed" : task.status === "reconciliation_required" ? "blocked" : task.status;
      await client.query("UPDATE jarvis.tasks SET state = $2, updated_at = clock_timestamp() WHERE id = $1", [task.taskId, taskState]);
      await client.query("UPDATE jarvis.requests SET state = $2, updated_at = clock_timestamp() WHERE id = (SELECT request_id FROM jarvis.tasks WHERE id = $1)", [task.taskId, taskState]);
      await emit(client, task.taskId, `queue.task.${task.status}`, `queue:${task.taskId}:${task.status}:${task.epoch}`, {
        taskId: task.taskId, leaseEpoch: task.epoch, availableAt: task.availableAt,
        ...(task.error?.kind === "unknown_external" ? { effectId: task.error.effectId } : {}),
        ...(task.error && task.error.kind !== "unknown_external" ? { code: task.error.code } : {}),
      });
      await commit(client);
      committed = true;
      return toTask(updated);
    } catch (error) {
      if (!committed) await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
