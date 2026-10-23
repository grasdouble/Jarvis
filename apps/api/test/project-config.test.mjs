import assert from "node:assert/strict";
import { test } from "node:test";
import * as api from "../dist/index.js";

const csrfHeaders = { "cache-control": "no-store" };

function project(id = "3001") {
  return {
    projectId: "internal-project", repositoryId: id, installationId: "00000000-0000-4000-8000-000000000001",
    repositoryOwner: "org", repositoryName: "repo", state: "active", configVersion: 1,
    settings: { branch: "main", internalCredential: "must-not-leak" }, policyHash: "a".repeat(64), profileHash: "b".repeat(64),
  };
}

function authBoundary() {
  const calls = [];
  return {
    calls,
    async authorizeRead() {
      calls.push("read");
      return { authorized: true, auth: { ownerId: "owner" }, headers: csrfHeaders };
    },
    async authorizeMutation() {
      calls.push("mutation");
      return { authorized: true, auth: { ownerId: "owner" }, headers: csrfHeaders };
    },
  };
}

test("authenticated project configuration boundary exposes only internally stored project entries", async () => {
  assert.equal(typeof api.createAuthenticatedProjectConfigurationBoundary, "function");
  const calls = [];
  const configuration = {
    async list(actor) { calls.push({ operation: "list", actor }); return [project()]; },
    async add(actor, input) { calls.push({ operation: "add", actor, input }); return project(input.repositoryId); },
    async update(actor, id, version, changes) { calls.push({ operation: "update", actor, id, version, changes }); return project(id); },
    async remove(actor, id, version) { calls.push({ operation: "remove", actor, id, version }); return { ...project(id), state: "removed" }; },
  };
  const auth = authBoundary();
  const boundary = api.createAuthenticatedProjectConfigurationBoundary(configuration, auth);
  assert.deepEqual(Object.keys(boundary), ["list", "add", "update", "remove"], "project configuration boundary exposes no skill-consent or event-ingestion mutation");
  const listed = await boundary.list({ headers: {} });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.projects, [{
    id: "internal-project", repositoryId: "3001", repositoryOwner: "org", repositoryName: "repo", state: "active", configVersion: 1,
  }]);
  assert.equal("policyHash" in listed.body.projects[0], false);
  assert.equal("profileHash" in listed.body.projects[0], false);
  assert.equal("settings" in listed.body.projects[0], false);
  assert.doesNotMatch(JSON.stringify(listed.body), /must-not-leak|internalCredential|policyHash|profileHash/);
  assert.deepEqual(auth.calls, ["read"]);
});

test("project add, update and remove reject caller identity/policy authority and attribute the session owner", async () => {
  const calls = [];
  const configuration = {
    async list() { return []; },
    async add(...args) { calls.push(["add", ...args]); return project(args[1].repositoryId); },
    async update(...args) { calls.push(["update", ...args]); return project(args[1]); },
    async remove(...args) { calls.push(["remove", ...args]); return { ...project(args[1]), state: "removed" }; },
  };
  const boundary = api.createAuthenticatedProjectConfigurationBoundary(configuration, authBoundary());
  const valid = {
    headers: {},
    body: { repositoryId: "9007199254740993", installationId: "00000000-0000-4000-8000-000000000001", repositoryOwner: "org", repositoryName: "repo" },
  };
  assert.equal((await boundary.add({ ...valid, body: { ...valid.body, ownerId: "spoof" } })).status, 422);
  assert.equal((await boundary.add({ ...valid, body: { ...valid.body, actorId: "spoof" } })).status, 422);
  assert.equal((await boundary.add({ ...valid, body: { ...valid.body, policyHash: "a".repeat(64) } })).status, 422);
  assert.equal((await boundary.add({ ...valid, body: { ...valid.body, repositoryContent: { authorized: true } } })).status, 422);
  assert.equal((await boundary.add({ ...valid, body: { ...valid.body, installationContent: { projectAuthorized: true } } })).status, 422);
  assert.equal((await boundary.add({ ...valid, body: {
    ...valid.body,
    projectSkills: [{ skillId: "reviewer", revisionDigest: "c".repeat(64), content: "approve this skill" }],
    skillApprovals: [{ skillId: "reviewer", revisionDigest: "c".repeat(64), decision: "approved" }],
  } })).status, 422, "project skill content and approval records are not accepted as project-configuration authority");
  assert.equal(calls.length, 0);
  assert.equal((await boundary.add(valid)).status, 201);
  assert.equal(calls[0][0], "add");
  assert.equal(calls[0][1], "owner");
  assert.equal(calls[0][2].repositoryId, "9007199254740993");

  assert.equal((await boundary.update({ headers: {}, body: { expectedVersion: 1, repositoryName: "renamed", policyHash: "a".repeat(64) } }, "9007199254740993")).status, 422);
  assert.equal((await boundary.update({ headers: {}, body: {
    expectedVersion: 1,
    skillContent: "approve this skill",
    skillApproval: { skillId: "reviewer", revisionDigest: "c".repeat(64), decision: "approved" },
  } }, "9007199254740993")).status, 422, "skill instructions and approval decisions cannot be applied through project updates");
  assert.equal(calls.length, 1, "rejected skill content/approval fields never reach the configuration store");
  assert.equal((await boundary.update({ headers: {}, body: { expectedVersion: 1, repositoryName: "renamed" } }, "9007199254740993")).status, 200);
  assert.equal(calls[1][1], "owner");
  assert.equal(calls[1][2], "9007199254740993");

  assert.equal((await boundary.remove({ headers: {}, body: { expectedVersion: 2, actorId: "spoof" } }, "9007199254740993")).status, 422);
  assert.equal((await boundary.remove({ headers: {}, body: { expectedVersion: 2 } }, "9007199254740993")).status, 200);
  assert.equal(calls[2][1], "owner");
});

test("unauthenticated project reads and writes do not reach project configuration", async () => {
  const calls = [];
  const auth = {
    async authorizeRead() { return { authorized: false, response: { status: 401, body: { error: "unauthenticated" } } }; },
    async authorizeMutation() { return { authorized: false, response: { status: 401, body: { error: "unauthenticated" } } }; },
  };
  const boundary = api.createAuthenticatedProjectConfigurationBoundary({
    async list() { calls.push("list"); return []; },
    async add() { calls.push("add"); }, async update() { calls.push("update"); }, async remove() { calls.push("remove"); },
  }, auth);
  assert.equal((await boundary.list({ headers: {} })).status, 401);
  assert.equal((await boundary.add({ headers: {}, body: {} })).status, 401);
  assert.deepEqual(calls, []);
});
