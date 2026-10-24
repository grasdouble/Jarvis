import { createHash } from "node:crypto";
import type { SqlPool } from "./index.js";

export interface StopControlRecord {
  readonly stopped: boolean;
  readonly version: number;
  readonly changedAt: Date | string;
  readonly changedBy: string;
}
export interface StopControlSnapshot { readonly global: StopControlRecord; readonly project: StopControlRecord | null }

export interface RestoreStopActivation {
  readonly version: number;
  readonly stopped: true;
}

/** Durable owner-controlled global and project stop state. Database errors intentionally propagate. */
export class PostgresStopControlStore {
  constructor(private readonly pool: SqlPool) {}

  async get(input: { readonly projectId?: string }): Promise<StopControlSnapshot> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ scope: string; project_id: string | null; stopped: boolean; version: number; changed_at: Date | string; changed_by: string }>(`
        SELECT scope, project_id, stopped, version, changed_at, changed_by
        FROM jarvis.stop_controls
        WHERE scope = 'global' OR (scope = 'project' AND project_id = $1)
      `, [input.projectId ?? null]);
      const global = rows.find((row) => row.scope === "global");
      if (!global) throw new Error("Global stop control is missing; refusing to infer an enabled state.");
      const project = rows.find((row) => row.scope === "project");
      return {
        global: { stopped: global.stopped, version: global.version, changedAt: global.changed_at, changedBy: global.changed_by },
        project: project ? { stopped: project.stopped, version: project.version, changedAt: project.changed_at, changedBy: project.changed_by } : null,
      };
    } finally { client.release(); }
  }

  /**
   * Explicit restore-only activation hook. Call after restoring the database and
   * before permitting any worker to claim work; normal startup must not call it.
   * It always advances the global version so pre-restore resume tokens are stale.
   */
  async suspendAfterRestore(): Promise<RestoreStopActivation> {
    const client = await this.pool.connect();
    let active = false;
    try {
      await client.query("BEGIN"); active = true;
      await client.query("SELECT pg_advisory_xact_lock(1246849618)");
      const updated = await client.query<{ version: number }>(`
        UPDATE jarvis.stop_controls
        SET stopped = true, version = version + 1,
            changed_by = 'system:restore', changed_at = clock_timestamp()
        WHERE scope = 'global' AND project_id IS NULL
        RETURNING version
      `);
      const record = updated.rows[0];
      if (updated.rowCount !== 1 || record === undefined) {
        throw new Error("Global stop control is missing; restore activation failed closed.");
      }
      const detailsHash = createHash("sha256").update(JSON.stringify({
        scope: "global", stopped: true, version: record.version, reason: "database_restore",
      })).digest("hex");
      await client.query(`INSERT INTO jarvis.audit_events(actor, action, resource, details_hash)
        VALUES ('system:restore', 'stop.restore_suspend', 'global', $1)`, [detailsHash]);
      await client.query("COMMIT"); active = false;
      return { version: record.version, stopped: true };
    } catch (error) {
      if (active) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async set(input: { readonly projectId?: string; readonly stopped: boolean; readonly expectedVersion: number; readonly ownerId: string }): Promise<void> {
    if (input.ownerId !== "owner" || typeof input.stopped !== "boolean" ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
        (input.projectId !== undefined && !/^[0-9a-f-]{36}$/i.test(input.projectId))) {
      throw new TypeError("Stop control mutation requires authenticated owner and valid scope.");
    }
    const client = await this.pool.connect();
    let active = false;
    try {
      await client.query("BEGIN"); active = true;
      if (input.projectId === undefined) {
        await client.query("SELECT pg_advisory_xact_lock(1246849618)");
        const updated = await client.query(`UPDATE jarvis.stop_controls SET stopped = $1, version = version + 1,
          changed_by = $2, changed_at = clock_timestamp() WHERE scope = 'global' AND version = $3`,
          [input.stopped, input.ownerId, input.expectedVersion]);
        if (updated.rowCount !== 1) throw Object.assign(new Error("Stop control version is stale."), { code: "STOP_VERSION_CONFLICT" });
      } else {
        const project = await client.query<{ id: string; version: number | null }>("SELECT p.id, sc.version FROM jarvis.projects p LEFT JOIN jarvis.stop_controls sc ON sc.project_id = p.id AND sc.scope = 'project' WHERE p.id = $1 FOR UPDATE OF p", [input.projectId]);
        if (project.rowCount !== 1) throw Object.assign(new Error("Project does not exist or is not authorized."), { code: "PROJECT_NOT_FOUND" });
        const current = project.rows[0]!;
        if (current.version == null) {
          if (input.expectedVersion !== 0) throw Object.assign(new Error("Stop control version is stale."), { code: "STOP_VERSION_CONFLICT" });
          await client.query(`INSERT INTO jarvis.stop_controls(scope, project_id, stopped, version, changed_by)
            VALUES ('project', $1, $2, 1, $3)`, [input.projectId, input.stopped, input.ownerId]);
        } else {
          if (current.version !== input.expectedVersion) throw Object.assign(new Error("Stop control version is stale."), { code: "STOP_VERSION_CONFLICT" });
          const updatedProject = await client.query(`UPDATE jarvis.stop_controls SET stopped = $2, version = version + 1, changed_by = $3,
            changed_at = clock_timestamp() WHERE project_id = $1 AND scope = 'project' AND version = $4`,
            [input.projectId, input.stopped, input.ownerId, input.expectedVersion]);
          if (updatedProject.rowCount !== 1) throw Object.assign(new Error("Stop control version is stale."), { code: "STOP_VERSION_CONFLICT" });
        }
      }
      const detailsHash = createHash("sha256").update(JSON.stringify({ scope: input.projectId ?? "global", stopped: input.stopped, expectedVersion: input.expectedVersion })).digest("hex");
      await client.query(`INSERT INTO jarvis.audit_events(actor, action, resource, details_hash)
        VALUES ($1, $2, $3, $4)`, [input.ownerId, input.stopped ? "stop.pause" : "stop.resume", input.projectId ?? "global", detailsHash]);
      await client.query("COMMIT"); active = false;
    } catch (error) {
      if (active) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
