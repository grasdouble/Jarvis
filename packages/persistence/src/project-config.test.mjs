import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import * as persistence from "../dist/index.js";

function poolFor(results) {
  const calls = [];
  const client = {
    async query(text, values = []) { calls.push({ text, values }); return results.shift() ?? { rows: [], rowCount: 0 }; },
    release() {},
  };
  return { calls, async connect() { return client; } };
}

const storedConfig = { schemaVersion: 1, repository: { owner: "org", name: "repo" }, profileHash: "b".repeat(64) };
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const configHash = createHash("sha256").update(canonical(storedConfig)).digest("hex");

const projectRow = {
  project_id: "00000000-0000-4000-8000-000000000001", repository_id: "9007199254740993",
  installation_id: "00000000-0000-4000-8000-000000000002", repository_owner: "org", repository_name: "repo",
  state: "active", config_version: 1, config_json: storedConfig,
  config_hash: configHash, policy_hash: "a".repeat(64), created_by: "owner",
};

test("PostgresProjectConfigStore is exported and lists only internally stored project configuration", async () => {
  assert.equal(typeof persistence.PostgresProjectConfigStore, "function");
  const pool = poolFor([{ rows: [projectRow], rowCount: 1 }]);
  const store = new persistence.PostgresProjectConfigStore(pool);
  const projects = await store.list();
  assert.equal(projects[0].repositoryId, "9007199254740993");
  assert.equal(projects[0].repositoryName, "repo");
  assert.equal(projects[0].profileHash, "b".repeat(64));
  assert.match(pool.calls[0].text, /FROM jarvis\.projects/);
  assert.match(pool.calls[0].text, /project_config_versions/);
  assert.doesNotMatch(pool.calls[0].text, /github_events|repository_content|dependabot/i);
});

test("request authorization resolves only current internal projects by stable ID or current metadata", async () => {
  assert.equal(typeof persistence.PostgresProjectRequestAuthorization, "function");
  const renamed = {
    ...projectRow,
    repository_owner: "new-org",
    repository_name: "new-name",
    config_json: { ...storedConfig, repository: { owner: "new-org", name: "new-name" } },
  };
  renamed.config_hash = createHash("sha256").update(canonical(renamed.config_json)).digest("hex");
  const pool = poolFor([
    { rows: [{ ...projectRow, installation_active: true }], rowCount: 1 },
    { rows: [{ ...renamed, installation_active: true }], rowCount: 1 },
    { rows: [{ ...renamed, installation_active: true }, { ...projectRow, installation_active: true }], rowCount: 2 },
  ]);
  const authorization = new persistence.PostgresProjectRequestAuthorization(pool);
  const byId = await authorization.projectById(projectRow.project_id);
  assert.equal(byId.id, projectRow.project_id);
  assert.equal(byId.repositoryId, "9007199254740993");
  assert.equal(byId.active, true);
  const byRenamedRepository = await authorization.projectByRepository("new-org/new-name");
  assert.equal(byRenamedRepository.repositoryId, "9007199254740993");
  assert.equal(byRenamedRepository.active, true);
  assert.equal(await authorization.projectByRepository("unlisted/repository"), null, "ambiguous metadata lookup fails closed");
  assert.match(pool.calls[0].text, /FROM jarvis\.projects/);
  assert.match(pool.calls[0].text, /JOIN jarvis\.installations/);
  assert.doesNotMatch(pool.calls[0].text, /events|dependabot|repository_content/i);
});

test("adding a project serializes identity, immutable config version, project row and actor audit", async () => {
  const saved = { ...projectRow, repository_id: "3001", repository_name: "repo" };
  const pool = poolFor([
    { rows: [], rowCount: 0 }, // BEGIN
    { rows: [], rowCount: 0 }, // no duplicate repository identity
    { rows: [{ id: "installation" }], rowCount: 1 }, // internally known active installation
    { rows: [{ hash: "a".repeat(64) }], rowCount: 1 }, // active core policy
    { rows: [saved], rowCount: 1 }, // project row
    { rows: [], rowCount: 1 }, // initial config version
    { rows: [], rowCount: 1 }, // audit event
  ]);
  const store = new persistence.PostgresProjectConfigStore(pool);
  const result = await store.add("owner", {
    repositoryId: "3001", installationId: "00000000-0000-4000-8000-000000000002",
    repositoryOwner: "org", repositoryName: "repo",
  }, { policyHash: "a".repeat(64), profileHash: "b".repeat(64) });
  assert.equal(result.repositoryId, "3001");
  assert.equal(pool.calls[0].text, "BEGIN");
  assert.match(pool.calls.find(({ text }) => /INSERT INTO jarvis\.project_config_versions/i.test(text)).text, /INSERT INTO jarvis\.project_config_versions/i);
  const audit = pool.calls.find(({ text }) => /INSERT INTO jarvis\.audit_events/i.test(text));
  assert.ok(audit);
  assert.equal(audit.values[0], "owner");
  assert.match(pool.calls.at(-1).text, /COMMIT/);
});

test("stale update and duplicate identity roll back without partial project or audit writes", async () => {
  const stalePool = poolFor([
    { rows: [], rowCount: 0 }, // BEGIN
    { rows: [{ id: projectRow.project_id }], rowCount: 1 }, // project identity lock
    { rows: [{ ...projectRow, config_version: 2 }], rowCount: 1 }, // project lookup/lock
  ]);
  const store = new persistence.PostgresProjectConfigStore(stalePool);
  await assert.rejects(() => store.update("owner", "9007199254740993", 1, { repositoryName: "renamed" }), /PROJECT_CONFIG_VERSION_CONFLICT/);
  assert.equal(stalePool.calls.some(({ text }) => /INSERT INTO jarvis\.(project_config_versions|audit_events)/i.test(text)), false);
  assert.equal(stalePool.calls.at(-1).text, "ROLLBACK");

  const duplicatePool = poolFor([{ rows: [], rowCount: 0 }, { rows: [{ id: "existing" }], rowCount: 1 }]);
  await assert.rejects(() => new persistence.PostgresProjectConfigStore(duplicatePool).add("owner", {
    repositoryId: "3001", installationId: "00000000-0000-4000-8000-000000000002", repositoryOwner: "org", repositoryName: "repo",
  }, { policyHash: "a".repeat(64), profileHash: "b".repeat(64) }), /PROJECT_IDENTITY_CONFLICT/);
  assert.equal(duplicatePool.calls.some(({ text }) => /INSERT INTO jarvis\.(projects|project_config_versions|audit_events)/i.test(text)), false);
  assert.equal(duplicatePool.calls.at(-1).text, "ROLLBACK");
});

test("removal advances immutable configuration and writes audit in one transaction", async () => {
  const current = { ...projectRow, config_version: 2, repository_id: "3001" };
  const updated = { ...current, config_version: 3, state: "removed" };
  const pool = poolFor([
    { rows: [], rowCount: 0 }, // BEGIN
    { rows: [{ id: current.project_id }], rowCount: 1 }, // project identity lock
    { rows: [current], rowCount: 1 }, // project FOR UPDATE
    { rows: [updated], rowCount: 1 }, // project state/version update
    { rows: [], rowCount: 1 }, // immutable config version
    { rows: [], rowCount: 1 }, // audit
  ]);
  const result = await new persistence.PostgresProjectConfigStore(pool).remove("owner", "3001", 2);
  assert.equal(result.state, "removed");
  assert.equal(result.configVersion, 3);
  assert.equal(pool.calls.some(({ text }) => /DELETE FROM jarvis\.projects/i.test(text)), false);
  assert.match(pool.calls.find(({ text }) => /FOR UPDATE/i.test(text)).text, /FOR UPDATE/);
  assert.equal(pool.calls.filter(({ text }) => /INSERT INTO jarvis\.(project_config_versions|audit_events)/i.test(text)).length, 2);
  assert.equal(pool.calls.at(-1).text, "COMMIT");
});
