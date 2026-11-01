import type { Server } from "node:http";
import { databaseReadiness } from "./database-readiness.js";
import { readFile } from "node:fs/promises";
import { Pool, type PoolConfig } from "pg";
import {
  PostgresOperationalDashboardReadModel,
  PostgresOwnerAuthStore,
  PostgresPersistence,
  PostgresStopControlStore,
  PostgresTaskResultReadModel,
  PostgresUsageAccountingStore,
} from "@jarvis/persistence";
import { createOwnerAuthBoundary, createOwnerAuthService } from "./auth.js";
import { createOperationalDashboardBoundary, createOperationalDashboardHttpHandler } from "./dashboard.js";
import { createTaskResultReadBoundary } from "./task-results.js";
import { createOperationalDashboardServer } from "./http-server.js";
import { createStaticAssetHandler } from "./static-assets.js";
import { createStopControlHttpHandler } from "./stop-controls.js";
import { listenUsageAccounting } from "./usage-accounting.js";

const DATABASE_HOST = process.env.DATABASE_HOST ?? "postgres";
const DATABASE_PORT = Number(process.env.DATABASE_PORT ?? "5432");
const DATABASE_NAME = process.env.DATABASE_NAME ?? "jarvis";
const WEB_ROOT = process.env.WEB_ROOT ?? "/app/web-dist";
const LISTEN_HOST = process.env.LISTEN_HOST ?? "0.0.0.0";
const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? "3000");
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? "http://127.0.0.1:3000";

async function secret(path: string | undefined, name: string): Promise<string> {
  if (path === undefined || path.length === 0) throw new Error(`${name} file path is required.`);
  const value = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
  if (value.length === 0) throw new Error(`${name} file is empty.`);
  return value;
}

function poolOptions(user: string, password: string): PoolConfig {
  if (!Number.isSafeInteger(DATABASE_PORT) || DATABASE_PORT < 1 || DATABASE_PORT > 65_535) throw new Error("DATABASE_PORT is invalid.");
  return { host: DATABASE_HOST, port: DATABASE_PORT, database: DATABASE_NAME, user, password, max: 10, connectionTimeoutMillis: 5_000 };
}

async function bootstrapRoles(): Promise<void> {
  const adminPassword = await secret(process.env.POSTGRES_PASSWORD_FILE, "POSTGRES_PASSWORD_FILE");
  const migratorPassword = await secret(process.env.MIGRATOR_PASSWORD_FILE, "MIGRATOR_PASSWORD_FILE");
  const runtimePassword = await secret(process.env.RUNTIME_PASSWORD_FILE, "RUNTIME_PASSWORD_FILE");
  const pool = new Pool(poolOptions("postgres", adminPassword));
  try {
    for (const [role, password, attributes, setting] of [
      ["jarvis_migrator", migratorPassword, "LOGIN NOSUPERUSER NOCREATEDB CREATEROLE INHERIT", "jarvis.migrator_password"],
      ["jarvis_runtime", runtimePassword, "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT", "jarvis.runtime_password"],
    ] as const) {
      const client = await pool.connect();
      try {
        const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
        if (existing.rowCount === 0) {
          await client.query("SELECT set_config($1, $2, false)", [setting, password]);
          try {
            await client.query(`DO $bootstrap$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN EXECUTE format('CREATE ROLE ${role} ${attributes} PASSWORD %L', current_setting('${setting}')); END IF; END $bootstrap$`);
          } finally {
            await client.query("SELECT set_config($1, '', false)", [setting]);
          }
        }
      } finally {
        client.release();
      }
    }
    await pool.query("GRANT CONNECT, CREATE ON DATABASE jarvis TO jarvis_migrator");
  } finally {
    await pool.end();
  }
}

async function migrate(): Promise<void> {
  const password = await secret(process.env.MIGRATOR_PASSWORD_FILE, "MIGRATOR_PASSWORD_FILE");
  const pool = new Pool(poolOptions("jarvis_migrator", password));
  try {
    await new PostgresPersistence(pool).migrate();
    await pool.query("GRANT jarvis_app TO jarvis_runtime");
  } finally {
    await pool.end();
  }
}
async function serve(): Promise<void> {
  if (!Number.isSafeInteger(LISTEN_PORT) || LISTEN_PORT < 1 || LISTEN_PORT > 65_535) throw new Error("LISTEN_PORT is invalid.");
  const onboardingSecret = await secret(process.env.ONBOARDING_SECRET_FILE, "ONBOARDING_SECRET_FILE");
  const runtimePassword = await secret(process.env.RUNTIME_PASSWORD_FILE, "RUNTIME_PASSWORD_FILE");
  const pool = new Pool(poolOptions("jarvis_runtime", runtimePassword));
  const auth = createOwnerAuthBoundary(createOwnerAuthService({ store: new PostgresOwnerAuthStore(pool), onboardingSecret }), { origin: PUBLIC_ORIGIN });
  const dashboard = createOperationalDashboardHttpHandler(createOperationalDashboardBoundary(new PostgresOperationalDashboardReadModel(pool), auth));
  const taskResults = createTaskResultReadBoundary(new PostgresTaskResultReadModel(pool), auth);
  const stopControls = createStopControlHttpHandler(new PostgresStopControlStore(pool), auth);
  const assets = createStaticAssetHandler(WEB_ROOT);
  const server = createOperationalDashboardServer({ auth, dashboard: async (request) => {
    if (request.url.split("?", 1)[0] === "/healthz") return databaseReadiness(pool);
    if (request.url.split("?", 1)[0]?.startsWith("/api/")) return dashboard(request);
    return assets(request);
  }, stopControls, taskResults: (request, taskId) => taskResults.get(request, taskId) });
  let accounting: Server | undefined;
  try {
    const accountingStore = new PostgresUsageAccountingStore(pool);
    await accountingStore.reconcileInterrupted();
    accounting = await listenUsageAccounting({
      path: process.env.USAGE_ACCOUNTING_SOCKET ?? "/run/jarvis-accounting/accounting.sock",
      store: accountingStore,
    });
    server.listen(LISTEN_PORT, LISTEN_HOST);
  } catch {
    accounting?.close();
    await pool.end();
    throw new Error("API database or usage accounting socket startup failed.");
  }
  server.on("error", () => {
    process.stderr.write("API server failed to bind.\n");
    const finishStartupFailure = (): void => {
      void pool.end().finally(() => { process.exitCode = 1; });
    };
    if (accounting) accounting.close(finishStartupFailure);
    else finishStartupFailure();
  });
  const shutdown = (): void => {
    accounting?.close();
    server.close((): void => { void pool.end(); });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

const command = process.argv[2];
if (command === "bootstrap") await bootstrapRoles();
else if (command === "migrate") await migrate();
else if (command === "serve") await serve();
else throw new Error("Expected one of: bootstrap, migrate, serve.");
