import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequestIntakeBoundary } from "../dist/index.js";

test("API boundary requires injected authentication and never takes owner from body", async () => {
  const calls = [];
  const intake = {
    async submit(owner, input) { calls.push({ owner, input }); return { state: "clarification", id: "r1" }; },
    async clarify(owner, id, version, input) { calls.push({ owner, id, version, input }); return { state: "queued", id }; },
  };
  const boundary = createRequestIntakeBoundary(intake);
  assert.equal((await boundary.submit({ auth: null, body: { ownerId: "spoof", prompt: "x" }, idempotencyKey: "k" })).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await boundary.submit({ auth: { ownerId: "trusted" }, body: { ownerId: "spoof", prompt: "x" }, idempotencyKey: "k" })).status, 422);
  assert.equal((await boundary.submit({ auth: { ownerId: "trusted" }, body: { prompt: "x", repository: "attacker/repo" }, idempotencyKey: "k" })).status, 422);
  assert.equal((await boundary.submit({ auth: { ownerId: "trusted" }, body: { prompt: "x", actorId: "spoof" }, idempotencyKey: "k" })).status, 422);
  assert.equal((await boundary.submit({ auth: { ownerId: "trusted" }, body: { prompt: "x", policyHash: "a".repeat(64) }, idempotencyKey: "k" })).status, 422);
  const result = await boundary.submit({ auth: { ownerId: "trusted" }, body: { prompt: "x", projectId: "p1" }, idempotencyKey: "k" });
  assert.equal(result.status, 202);
  assert.equal("prompt" in result.body, false);
  assert.equal("ownerId" in result.body, false);
  assert.equal(calls[0].owner, "trusted");
  assert.equal(calls[0].input.projectId, "p1");
  assert.equal("ownerId" in calls[0].input, false);
});

test("API clarification requires expected version and uses the authenticated owner", async () => {
  const calls = [];
  const boundary = createRequestIntakeBoundary({
    async submit() { throw new Error("unused"); },
    async clarify(...args) { calls.push(args); return { state: "queued" }; },
  });
  const request = { auth: { ownerId: "trusted" }, requestId: "r1", body: { prompt: "same" }, idempotencyKey: "k", expectedVersion: 2 };
  assert.equal((await boundary.clarify({ ...request, expectedVersion: 0 })).status, 422);
  assert.equal((await boundary.clarify(request)).status, 202);
  assert.deepEqual(calls[0].slice(0, 3), ["trusted", "r1", 2]);
});
