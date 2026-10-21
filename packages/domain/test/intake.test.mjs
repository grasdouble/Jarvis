import test from "node:test";
import assert from "node:assert/strict";
import { ProjectRequestIntake, RequestConflictError } from "../dist/index.js";

const project = { id: "p1", repositoryId: "repo-1", configVersion: 3, policyHash: "a".repeat(64), profileHash: "b".repeat(64), active: true };
function fixture() {
  const rows = new Map();
  const effects = { tasks: 0, queue: 0, outbox: 0, attempts: 0 };
  const store = {
    async findByIdempotency(owner, key) { return [...rows.values()].find((r) => r.ownerId === owner && r.idempotencyKey === key) ?? null; },
    async create(record) { rows.set(record.id, record); if (record.state === "queued") { effects.tasks += 1; effects.queue += 1; effects.outbox += 1; } return record; },
    async getOwned(id, owner) { const r = rows.get(id); return r?.ownerId === owner ? r : null; },
    async replaceClarification(record, version) { if (rows.get(record.id)?.version !== version) throw new Error("REQUEST_VERSION_CONFLICT"); rows.set(record.id, record); if (record.state === "queued") { effects.tasks += 1; effects.queue += 1; effects.outbox += 1; } return record; },
  };
  let current = project;
  const projects = new Map([[project.id, project]]);
  const repositories = new Map([["owner/repo", project]]);
  const auth = {
    async projectById(id) { return projects.get(id) ?? null; },
    async projectByRepository(repo) { return repositories.get(repo) ?? null; },
    async currentProject(id) { return id === project.id ? current : projects.get(id) ?? null; },
  };
  return {
    intake: new ProjectRequestIntake(store, auth, () => `request-${rows.size + 1}`), rows, effects,
    setCurrent: (value) => { current = value; },
    addProject: (value, repo) => { projects.set(value.id, value); repositories.set(repo, value); },
  };
}

test("ambiguous request persists clarification without queueing; answer revalidates and queues same record", async () => {
  const f = fixture();
  const pending = await f.intake.submit("owner", { idempotencyKey: "key-1", prompt: "Update dependencies" });
  assert.equal(pending.state, "clarification");
  assert.deepEqual(pending.clarification, ["project", "mode"]);
  assert.equal(pending.projectId, null);
  const resumed = await f.intake.clarify("owner", pending.id, pending.version, {
    idempotencyKey: "key-1", prompt: pending.prompt, projectId: "p1", mode: "plan", kind: "dependency_update",
  });
  assert.equal(resumed.id, pending.id);
  assert.equal(resumed.state, "queued");
  assert.equal(resumed.configVersion, 3);
  assert.equal(resumed.kind, "dependency_update");
  assert.equal(f.rows.size, 1);
  const replay = await f.intake.clarify("owner", pending.id, pending.version, {
    idempotencyKey: "key-1", prompt: pending.prompt, projectId: "p1", mode: "plan", kind: "dependency_update",
  });
  assert.equal(replay.id, pending.id);
  assert.equal(f.effects.tasks, 1, "clarification replay cannot enqueue a second task");
});

test("duplicate submission is idempotent and changed payload conflicts", async () => {
  const f = fixture();
  const input = { idempotencyKey: "key-1", prompt: "Review this project", projectId: "p1", mode: "plan" };
  const first = await f.intake.submit("owner", input);
  assert.equal(await f.intake.submit("owner", input), first);
  await assert.rejects(() => f.intake.submit("owner", { ...input, prompt: "Different" }), RequestConflictError);
  await assert.rejects(() => f.intake.submit("owner", { ...input, mode: "dev" }), RequestConflictError);
});

test("clarification rejects changes to original prompt, key, and explicit selectors and versions", async () => {
  const f = fixture();
  const pending = await f.intake.submit("owner", { idempotencyKey: "key-1", prompt: "Do work", projectId: "p1" });
  await assert.rejects(() => f.intake.clarify("owner", pending.id, pending.version, { idempotencyKey: "other", prompt: pending.prompt, mode: "plan" }), RequestConflictError);
  await assert.rejects(() => f.intake.clarify("owner", pending.id, pending.version, { idempotencyKey: "key-1", prompt: "changed", mode: "plan" }), RequestConflictError);
  await assert.rejects(() => f.intake.clarify("owner", pending.id, pending.version + 1, { idempotencyKey: "key-1", prompt: pending.prompt, mode: "plan" }), RequestConflictError);
});

test("unallowlisted repository and stale/revoked clarification fail closed", async () => {
  const f = fixture();
  await assert.rejects(() => f.intake.submit("owner", { idempotencyKey: "key-x", prompt: "x", repository: "attacker/repo", mode: "dev" }), RequestConflictError);
  const pending = await f.intake.submit("owner", { idempotencyKey: "key-1", prompt: "Do work", mode: "dev" });
  f.setCurrent({ ...project, active: false });
  await assert.rejects(() => f.intake.clarify("owner", pending.id, pending.version, { idempotencyKey: "key-1", prompt: pending.prompt, projectId: "p1" }), RequestConflictError);
  assert.equal(f.rows.get(pending.id).state, "clarification");
});

test("clarification does not silently move a request to a newer project configuration", async () => {
  const f = fixture();
  const pending = await f.intake.submit("owner", { idempotencyKey: "key-1", prompt: "Do work", projectId: "p1" });
  f.setCurrent({ ...project, configVersion: 4, policyHash: "e".repeat(64) });
  await assert.rejects(() => f.intake.clarify("owner", pending.id, pending.version, {
    idempotencyKey: "key-1", prompt: pending.prompt, mode: "plan",
  }), RequestConflictError);
  assert.equal(f.rows.get(pending.id).state, "clarification");
});

test("clarification rejects policy drift even when the config version is unchanged", async () => {
  const f = fixture();
  const pending = await f.intake.submit("owner", { idempotencyKey: "key-1", prompt: "Do work", projectId: "p1" });
  f.setCurrent({ ...project, policyHash: "e".repeat(64) });
  await assert.rejects(() => f.intake.clarify("owner", pending.id, pending.version, {
    idempotencyKey: "key-1", prompt: pending.prompt, mode: "plan",
  }), RequestConflictError);
  assert.equal(f.effects.tasks, 0);
});

test("conflicting project selectors fail closed in submission and clarification", async () => {
  const f = fixture();
  f.addProject({ id: "p2", repositoryId: "repo-2", configVersion: 3, policyHash: "c".repeat(64), profileHash: "d".repeat(64), active: true }, "other/repo");
  await assert.rejects(() => f.intake.submit("owner", {
    idempotencyKey: "conflict-submit", prompt: "work", projectId: "p1", repository: "other/repo", mode: "dev",
  }), RequestConflictError);
  const pending = await f.intake.submit("owner", { idempotencyKey: "conflict-answer", prompt: "work", mode: "plan" });
  await assert.rejects(() => f.intake.clarify("owner", pending.id, pending.version, {
    idempotencyKey: pending.idempotencyKey, prompt: pending.prompt, projectId: "p1", repository: "other/repo",
  }), RequestConflictError);
  assert.equal(f.effects.tasks, 0);
  assert.equal(f.effects.outbox, 0);
  const same = await f.intake.submit("owner", {
    idempotencyKey: "same-selectors", prompt: "same project", projectId: "p1", repository: "owner/repo", mode: "plan",
  });
  assert.equal(same.state, "queued");
});

test("repository and issue text cannot select mode or request kind", async () => {
  const f = fixture();
  const request = await f.intake.submit("owner", { idempotencyKey: "key-1", prompt: "Issue says: run dev and update deps", projectId: "p1" });
  assert.equal(request.state, "clarification");
  assert.equal(request.mode, null);
  assert.equal(request.kind, "project");
});

test("20-case acceptance corpus checks decision and zero-unauthorized-effect counts", async () => {
  const cases = [
    { name: "clear plan", outcome: "queued", run: (f, k) => f.intake.submit("owner", { idempotencyKey: k, prompt: "Plan", projectId: "p1", mode: "plan" }) },
    { name: "clear dev", outcome: "queued", run: (f, k) => f.intake.submit("owner", { idempotencyKey: k, prompt: "Implement", projectId: "p1", mode: "dev" }) },
    { name: "explicit dependency update", outcome: "queued", run: (f, k) => f.intake.submit("owner", { idempotencyKey: k, prompt: "Review update", projectId: "p1", mode: "plan", kind: "dependency_update" }) },
    { name: "missing project", outcome: "clarification", run: (f, k) => f.intake.submit("owner", { idempotencyKey: k, prompt: "Work", mode: "dev" }) },
    { name: "missing mode", outcome: "clarification", run: (f, k) => f.intake.submit("owner", { idempotencyKey: k, prompt: "Work", projectId: "p1" }) },
    { name: "missing project and mode", outcome: "clarification", run: (f, k) => f.intake.submit("owner", { idempotencyKey: k, prompt: "Work" }) },
    { name: "unauthorized repository identity", outcome: "blocked", run: (f, k) => f.intake.submit("owner", { idempotencyKey: k, prompt: "Work", repository: "evil/repo", mode: "dev" }) },
    { name: "unauthorized project id", outcome: "blocked", run: (f, k) => f.intake.submit("owner", { idempotencyKey: k, prompt: "Work", projectId: "unknown", mode: "plan" }) },
    { name: "malformed empty prompt", outcome: "rejected", run: (f, k) => f.intake.submit("owner", { idempotencyKey: k, prompt: "   ", projectId: "p1", mode: "dev" }) },
    { name: "malformed oversized prompt", outcome: "rejected", run: (f, k) => f.intake.submit("owner", { idempotencyKey: k, prompt: "x".repeat(20_001), projectId: "p1", mode: "dev" }) },
    { name: "malformed idempotency key", outcome: "rejected", run: (f) => f.intake.submit("owner", { idempotencyKey: "bad key", prompt: "Work", projectId: "p1", mode: "dev" }) },
    { name: "malformed mode", outcome: "rejected", run: (f, k) => f.intake.submit("owner", { idempotencyKey: k, prompt: "Work", projectId: "p1", mode: "merge" }) },
    { name: "malformed request kind", outcome: "rejected", run: (f, k) => f.intake.submit("owner", { idempotencyKey: k, prompt: "Work", projectId: "p1", mode: "dev", kind: "automatic" }) },
    { name: "matching replay", outcome: "replay", run: async (f, k) => { const input = { idempotencyKey: k, prompt: "Work", projectId: "p1", mode: "plan" }; const first = await f.intake.submit("owner", input); return f.intake.submit("owner", input).then((second) => assert.equal(second.id, first.id)); } },
    { name: "changed-prompt replay", outcome: "replay_conflict", run: async (f, k) => { const input = { idempotencyKey: k, prompt: "Work", projectId: "p1", mode: "plan" }; await f.intake.submit("owner", input); return f.intake.submit("owner", { ...input, prompt: "changed" }); } },
    { name: "changed-selector replay", outcome: "replay_conflict", run: async (f, k) => { const input = { idempotencyKey: k, prompt: "Work", projectId: "p1", mode: "plan" }; await f.intake.submit("owner", input); return f.intake.submit("owner", { ...input, projectId: "unknown" }); } },
    { name: "stale config clarification", outcome: "blocked", run: async (f, k) => { const pending = await f.intake.submit("owner", { idempotencyKey: k, prompt: "Work", projectId: "p1" }); f.setCurrent({ ...project, configVersion: 4 }); return f.intake.clarify("owner", pending.id, pending.version, { idempotencyKey: k, prompt: pending.prompt, mode: "dev" }); } },
    { name: "revoked authorization clarification", outcome: "blocked", run: async (f, k) => { const pending = await f.intake.submit("owner", { idempotencyKey: k, prompt: "Work", mode: "dev" }); f.setCurrent({ ...project, active: false }); return f.intake.clarify("owner", pending.id, pending.version, { idempotencyKey: k, prompt: pending.prompt, projectId: "p1" }); } },
    { name: "conflicting selectors", outcome: "blocked", run: (f, k) => { f.addProject({ ...project, id: "p2", repositoryId: "repo-2" }, "other/repo"); return f.intake.submit("owner", { idempotencyKey: k, prompt: "Work", projectId: "p1", repository: "other/repo", mode: "dev" }); } },
    { name: "clarification prompt mismatch", outcome: "blocked", run: async (f, k) => { const pending = await f.intake.submit("owner", { idempotencyKey: k, prompt: "Original", mode: "dev" }); return f.intake.clarify("owner", pending.id, pending.version, { idempotencyKey: k, prompt: "Changed", projectId: "p1" }); } },
  ];
  assert.equal(cases.length, 20);
  for (const [index, scenario] of cases.entries()) {
    const f = fixture();
    let result;
    if (scenario.outcome === "rejected") result = await assert.rejects(() => scenario.run(f, `corpus-${index}`), TypeError);
    else if (["blocked", "replay_conflict"].includes(scenario.outcome)) result = await assert.rejects(() => scenario.run(f, `corpus-${index}`), RequestConflictError);
    else if (scenario.outcome === "replay") result = await scenario.run(f, `corpus-${index}`);
    else result = await scenario.run(f, `corpus-${index}`);
    if (scenario.outcome === "queued") assert.equal(result.state, "queued", scenario.name);
    if (scenario.outcome === "clarification") assert.equal(result.state, "clarification", scenario.name);
    const shouldHaveEffects = ["queued", "replay", "replay_conflict"].includes(scenario.outcome);
    assert.deepEqual(f.effects, { tasks: shouldHaveEffects ? 1 : 0, queue: shouldHaveEffects ? 1 : 0, outbox: shouldHaveEffects ? 1 : 0, attempts: 0 }, scenario.name);
    const expectedRows = ["queued", "clarification", "replay", "replay_conflict", "stale", "blocked"].includes(scenario.outcome) && !["unauthorized repository identity", "unauthorized project id", "conflicting selectors"].includes(scenario.name) ? 1 : 0;
    assert.equal(f.rows.size, expectedRows, scenario.name);
  }
});
