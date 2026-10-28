import type { Pool, PoolClient } from "pg";

/** Reports runtime database availability without exposing connection errors. */
export async function databaseReadiness(pool: Pick<Pool, "connect">): Promise<{ readonly status: number; readonly body: { readonly status: string }; readonly headers: { readonly "cache-control": string } }> {
  let client: PoolClient | undefined;
  let failed = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 5000");
    await client.query("SELECT 1");
    await client.query("COMMIT");
    return { status: 200, body: { status: "ok" }, headers: { "cache-control": "no-store" } };
  } catch {
    failed = true;
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* Discarded with the connection below. */ }
    }
    return { status: 503, body: { status: "unavailable" }, headers: { "cache-control": "no-store" } };
  } finally {
    client?.release(failed ? new Error("Readiness probe failed.") : undefined);
  }
}
