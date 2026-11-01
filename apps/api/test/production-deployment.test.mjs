import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { parse } from "yaml";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { createOwnerAuthBoundary, createOwnerAuthService, createOperationalDashboardBoundary, createOperationalDashboardHttpHandler, createOperationalDashboardServer } from "../dist/index.js";
import { createStaticAssetHandler } from "../dist/static-assets.js";

import { Pool } from "pg";
import { databaseReadiness } from "../dist/database-readiness.js";
const fetch = globalThis.fetch;

class AuthStore {
  owner = null;
  sessions = new Map();
  async findOwner() { return this.owner; }
  async createOwner(owner) { if (this.owner) return false; this.owner = owner; return true; }
  async createSession(session) { this.sessions.set(session.tokenDigest, session); }
  async touchSession(tokenDigest) { return this.sessions.get(tokenDigest) ?? null; }
  async revokeSession(tokenDigest) { this.sessions.delete(tokenDigest); }
}

function cookieHeader(response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

test("production HTTP composition gates persisted data while serving the compiled UI and its assets", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "jarvis-ui-"));
  const root = join(temporary, "web");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(temporary, "package.json"), "{\"private\":\"outside-static-root\"}");
  await writeFile(join(root, "index.html"), "<!doctype html><main>JARVIS</main>");
  await writeFile(join(root, "assets", "app.js"), "window.jarvis = true;");
  await writeFile(join(root, "assets", "pixel.png"), Buffer.from([0, 255, 128, 13, 10, 26]));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:3000";
  const auth = createOwnerAuthBoundary(createOwnerAuthService({ store: new AuthStore(), onboardingSecret: "test-deployment-onboarding-secret-over-32-bytes" }), { origin });
  const dashboard = createOperationalDashboardHttpHandler(createOperationalDashboardBoundary({ list: async (ownerId) => [{ id: ownerId, repository: "owner/repo", health: "unknown", usage: null, requests: [], pullRequests: [] }] }, auth));
  const assets = createStaticAssetHandler(root);
  const server = createOperationalDashboardServer({ auth, dashboard: async (request) => request.url.split("?", 1)[0]?.startsWith("/api/") ? dashboard(request) : assets(request) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await html.text(), /JARVIS/);
  assert.match(await (await fetch(`${base}/assets/app.js`)).text(), /window\.jarvis/);
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/assets/pixel.png`)).arrayBuffer()), Buffer.from([0, 255, 128, 13, 10, 26]));
  const head = await fetch(`${base}/assets/pixel.png`, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), "6");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const traversal = new URL("/%2e%2e%2fpackage.json", base);
  assert.equal(traversal.pathname, "/%2e%2e%2fpackage.json");
  const escaped = await fetch(traversal);
  assert.equal(escaped.status, 404);
  assert.doesNotMatch(await escaped.text(), /outside-static-root/);


  const denied = await fetch(`${base}/api/v1/dashboard`);
  assert.equal(denied.status, 401);
  const challenge = await fetch(`${base}/api/v1/session`);
  const csrfToken = (await challenge.json()).csrfToken;
  const challengeCookies = cookieHeader(challenge);
  const badOrigin = await fetch(`${base}/api/v1/session/onboard`, {
    method: "POST",
    headers: { origin: "http://evil.example", cookie: challengeCookies, "x-csrf-token": csrfToken, "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-deployment-onboarding-secret-over-32-bytes", password: "a sufficiently long owner-selected test passphrase" }),
  });
  assert.equal(badOrigin.status, 403);
  const missingCsrf = await fetch(`${base}/api/v1/session/onboard`, {
    method: "POST",
    headers: { origin, cookie: challengeCookies, "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-deployment-onboarding-secret-over-32-bytes", password: "a sufficiently long owner-selected test passphrase" }),
  });
  assert.equal(missingCsrf.status, 403);
  const onboard = await fetch(`${base}/api/v1/session/onboard`, {
    method: "POST",
    headers: { origin, cookie: challengeCookies, "x-csrf-token": csrfToken, "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-deployment-onboarding-secret-over-32-bytes", password: "a sufficiently long owner-selected test passphrase" }),
  });
  assert.equal(onboard.status, 201);
  const credentials = await onboard.json();
  assert.equal("sessionToken" in credentials, false);
  const authenticatedCookies = cookieHeader(onboard);
  const authorized = await fetch(`${base}/api/v1/dashboard`, { headers: { cookie: authenticatedCookies, origin } });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).projects[0].repository, "owner/repo");
});
test("database readiness returns unavailable for an unreachable runtime database", async (context) => {
  const pool = new Pool({ host: "127.0.0.1", port: 1, database: "jarvis", user: "jarvis_runtime", password: "not-a-real-secret", connectionTimeoutMillis: 250, max: 1 });
  context.after(() => pool.end());
  const server = createOperationalDashboardServer({
    auth: { getSession: async () => ({ status: 404 }), login: async () => ({ status: 404 }), onboard: async () => ({ status: 404 }), logout: async () => ({ status: 404 }) },
    dashboard: async (request) => request.url === "/healthz" ? databaseReadiness(pool) : { status: 404 },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  const responseText = await response.text();
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(responseText), { status: "unavailable" });
  assert.doesNotMatch(responseText, /not-a-real-secret|127\.0\.0\.1|ECONNREFUSED/);
});

test("Compose manifests keep the ARM64 API on the internal network without host port publication", async () => {
  const root = new URL("../../../", import.meta.url);
  const base = parse(await readFile(new URL("infra/compose/compose.yaml", root), "utf8"));
  const app = parse(await readFile(new URL("infra/compose/app.compose.yaml", root), "utf8"));
  assert.equal(base.networks.core.internal, true);
  assert.deepEqual(base.services.postgres.ports, undefined);
  assert.deepEqual(base.services["sandbox-manager"].ports, undefined);
  assert.deepEqual(base.services["sandbox-manager"].profiles, ["sandbox-manager"]);
  assert.deepEqual(app.services["db-bootstrap"].networks, ["core"]);
  assert.deepEqual(app.services.migrate.networks, ["core"]);
  assert.deepEqual(app.services.api.ports, undefined);
  assert.deepEqual(app.services.api.networks, { core: { ipv4_address: "172.30.132.10" } });
  assert.equal(app.networks.core.internal, true);
  assert.deepEqual(app.networks.core.ipam.config, [{ subnet: "172.30.132.0/24" }]);
  for (const name of ["db-bootstrap", "migrate", "api"]) {
    assert.equal(app.services[name].image, "${JARVIS_APP_IMAGE:?set a local sha256 image ID}");
    assert.equal(app.services[name].pull_policy, "never");
  }
  assert.equal(app.services.api.platform, "linux/arm64");
  assert.equal(app.services.api.environment.PUBLIC_ORIGIN, "http://127.0.0.1:3000");
  assert.equal(app.services.api.environment.LISTEN_HOST, "0.0.0.0");
  assert.equal(app.services.api.user, "0:10001");
  assert.deepEqual(app.services.api.cap_drop, ["ALL"]);
  assert.deepEqual(app.services.api.volumes, [{ type: "volume", source: "accounting_socket", target: "/run/jarvis-accounting" }]);
  assert.equal(app.services.api.environment.USAGE_ACCOUNTING_SOCKET, "/run/jarvis-accounting/accounting.sock");
  assert.deepEqual(app.volumes.accounting_socket, { name: "jarvis-accounting-socket" });
  assert.deepEqual(app.services.api.secrets, ["jarvis_runtime_password", "owner_onboarding_secret"]);
  assert.deepEqual(app.services["db-bootstrap"].secrets, ["postgres_password", "jarvis_migrator_password", "jarvis_runtime_password"]);
  assert.equal(app.services["db-bootstrap"].command[0], "bootstrap");
  assert.equal(app.services["db-bootstrap"].environment.POSTGRES_PASSWORD_FILE, "/run/secrets/postgres_password");
  assert.equal(app.services["db-bootstrap"].environment.MIGRATOR_PASSWORD_FILE, "/run/secrets/jarvis_migrator_password");
  assert.equal(app.services["db-bootstrap"].environment.RUNTIME_PASSWORD_FILE, "/run/secrets/jarvis_runtime_password");
  assert.deepEqual(app.services["db-bootstrap"].ports, undefined);
  assert.equal(app.services.migrate.command[0], "migrate");
  assert.equal(app.services.migrate.environment.MIGRATOR_PASSWORD_FILE, "/run/secrets/jarvis_migrator_password");
  assert.deepEqual(app.services.migrate.secrets, ["jarvis_migrator_password"]);
  assert.deepEqual(app.services.migrate.ports, undefined);
  assert.equal(app.services.api.environment.MIGRATOR_PASSWORD_FILE, undefined);
  assert.equal(app.services.api.environment.POSTGRES_PASSWORD_FILE, undefined);
  assert.equal(app.secrets.owner_onboarding_secret.file, "/etc/jarvis/secrets/owner_onboarding_secret");
  assert.equal(base.secrets.postgres_password.file, "/etc/jarvis/secrets/postgres_password");
});

test("deployment wrapper rejects tags and registry references before invoking Colima", () => {
  const script = new URL("../../../infra/colima/compose.sh", import.meta.url).pathname;
  for (const image of ["registry.example/jarvis:latest", `registry.example/jarvis@sha256:${"a".repeat(64)}`]) {
    const result = spawnSync("bash", [script, "ps"], {
      encoding: "utf8",
      env: { ...process.env, JARVIS_APP_IMAGE: image },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must be a local Docker image ID/);
  }
});
