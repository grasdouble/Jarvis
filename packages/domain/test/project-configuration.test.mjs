import assert from "node:assert/strict";
import test from "node:test";
import { ProjectConfigurationService, RequestConflictError } from "../dist/index.js";

const seed = {
  policyHash: "a".repeat(64),
  profileHash: "b".repeat(64),
};

function fixture() {
  const projects = new Map();
  const service = new ProjectConfigurationService({
    async list() { return [...projects.values()]; },
    async add(actor, input, initial) {
      if ([...projects.values()].some((project) => project.repositoryId === input.repositoryId)) {
        throw new RequestConflictError("Repository identity already exists.");
      }
      const project = { ...input, ...initial, projectId: `project-${projects.size + 1}`, state: "active", configVersion: 1 };
      projects.set(input.repositoryId, project);
      return project;
    },
    async update(actor, repositoryId, expectedVersion, changes) {
      const current = projects.get(repositoryId);
      if (!current || current.configVersion !== expectedVersion) throw new RequestConflictError("Project configuration version is stale.");
      const next = { ...current, ...changes, configVersion: current.configVersion + 1 };
      projects.set(repositoryId, next);
      return next;
    },
    async remove(actor, repositoryId, expectedVersion) {
      const current = projects.get(repositoryId);
      if (!current || current.configVersion !== expectedVersion) throw new RequestConflictError("Project configuration version is stale.");
      const next = { ...current, state: "removed", configVersion: current.configVersion + 1 };
      projects.set(repositoryId, next);
      return next;
    },
  }, { async initialConfiguration() { return seed; } });
  return { service, projects };
}

test("project configuration uses core-owned policy/profile references and supports at least ten stable repository identities", async () => {
  const { service } = fixture();
  const projects = [];
  for (let id = 1; id <= 12; id += 1) {
    projects.push(await service.add("owner", {
      repositoryId: String(9_000_000_000_000_000 + id),
      installationId: "00000000-0000-4000-8000-000000000001",
      repositoryOwner: `org-${id}`,
      repositoryName: `repo-${id}`,
    }));
  }
  assert.equal((await service.list()).length, 12);
  assert.equal(projects[0].repositoryId, "9000000000000001", "GitHub IDs remain exact decimal strings beyond Number precision");
  assert.equal(projects[0].policyHash, seed.policyHash);
  assert.equal(projects[0].profileHash, seed.profileHash);
});

test("renaming project metadata preserves stable repository identity and removal preserves the record", async () => {
  const { service, projects } = fixture();
  const added = await service.add("owner", {
    repositoryId: "3001", installationId: "00000000-0000-4000-8000-000000000001",
    repositoryOwner: "old-org", repositoryName: "old-name",
  });
  const renamed = await service.update("owner", "3001", 1, { repositoryOwner: "new-org", repositoryName: "new-name" });
  assert.equal(renamed.projectId, added.projectId);
  assert.equal(renamed.repositoryId, "3001");
  assert.equal(renamed.configVersion, 2);
  const removed = await service.remove("owner", "3001", 2);
  assert.equal(removed.state, "removed");
  assert.equal(removed.configVersion, 3);
  assert.equal(projects.has("3001"), true);
  await assert.rejects(() => service.remove("owner", "3001", 2), RequestConflictError);
});

test("malformed and duplicate repository identities fail closed and do not accept caller policy or actor fields", async () => {
  const { service } = fixture();
  const base = {
    repositoryId: "3001", installationId: "00000000-0000-4000-8000-000000000001",
    repositoryOwner: "org", repositoryName: "repo",
  };
  for (const repositoryId of ["0", "03001", "3e3", "9223372036854775808", 3001]) {
    await assert.rejects(() => service.add("owner", { ...base, repositoryId }), TypeError);
  }
  await assert.rejects(() => service.add("owner", { ...base, policyHash: "c".repeat(64) }), TypeError);
  await assert.rejects(() => service.add("owner", { ...base, actorId: "spoof" }), TypeError);
  await service.add("owner", base);
  await assert.rejects(() => service.add("owner", base), RequestConflictError);
});

test("project configuration edits require the authenticated owner and expected version", async () => {
  const { service } = fixture();
  const input = {
    repositoryId: "3001", installationId: "00000000-0000-4000-8000-000000000001",
    repositoryOwner: "org", repositoryName: "repo",
  };
  await assert.rejects(() => service.add("repository-content", input), TypeError);
  await service.add("owner", input);
  await assert.rejects(() => service.update("owner", "3001", 0, { repositoryName: "renamed" }), TypeError);
});

test("project addition fails closed when no trusted initial configuration is available", async () => {
  let writes = 0;
  const service = new ProjectConfigurationService({
    async list() { return []; },
    async add() { writes += 1; throw new Error("must not be called"); },
    async update() { throw new Error("unused"); },
    async remove() { throw new Error("unused"); },
  }, { async initialConfiguration() { return null; } });
  await assert.rejects(() => service.add("owner", {
    repositoryId: "3001", installationId: "00000000-0000-4000-8000-000000000001",
    repositoryOwner: "org", repositoryName: "repo",
  }), TypeError);
  assert.equal(writes, 0);
});
