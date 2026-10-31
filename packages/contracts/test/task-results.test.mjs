import test from "node:test";
import assert from "node:assert/strict";
import { validateTaskResult } from "../dist/index.js";

const common = {
  schemaVersion: 1, requestId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222", attemptId: "33333333-3333-4333-8333-333333333333",
  leaseEpoch: 2, mode: "plan", sourceRevision: "a".repeat(40), snapshotDigest: "b".repeat(64), provider: "openai", model: "gpt-4.1",
  resultId: "44444444-4444-4444-8444-444444444444",
};
const plan = { summary: "Review", steps: [{ description: "Inspect", sources: ["src/index.ts"] }], affectedAreas: ["runtime"], assumptions: [], risks: [], questions: [], limitations: [] };
const snapshot = { repository: "owner/repo", revision: "a".repeat(40), snapshotDigest: "b".repeat(64), includedPaths: ["src/index.ts"] };
const expected = ({ mode = common.mode, sourceRevision = common.sourceRevision } = {}) => ({ requestId: common.requestId, taskId: common.taskId, attemptId: common.attemptId, leaseEpoch: common.leaseEpoch, mode, sourceRevision, snapshotDigest: common.snapshotDigest, provider: common.provider, model: common.model });

test("accepts a snapshot-bound closed plan result envelope", () => {
  assert.deepEqual(validateTaskResult({ ...common, payload: plan }, { snapshot, expected: expected() }), { ...common, payload: plan });
});
test("rejects extra fields, oversized output and mismatched provenance", () => {
  assert.throws(() => validateTaskResult({ ...common, payload: plan, authority: true }, { snapshot, expected: expected() }));
  assert.throws(() => validateTaskResult({ ...common, requestId: "55555555-5555-4555-8555-555555555555", payload: plan }, { snapshot, expected: expected() }));
  assert.throws(() => validateTaskResult({ ...common, sourceRevision: "c".repeat(40), payload: plan }, { snapshot, expected: expected() }));
  assert.throws(() => validateTaskResult({ ...common, snapshotDigest: "d".repeat(64), payload: plan }, { snapshot, expected: expected() }));
  assert.throws(() => validateTaskResult({ ...common, payload: { ...plan, summary: "x".repeat(40000) } }, { snapshot, expected: expected() }));
  assert.throws(() => validateTaskResult({ ...common, payload: { ...plan, steps: [{ description: "Inspect", sources: ["../secret"] }] } }, { snapshot, expected: expected() }));
});
test("accepts inert dev artifacts but rejects path traversal and unexpected authority", () => {
  const dev = { ...common, mode: "dev", payload: { summary: "Patch report", artifactId: "55555555-5555-4555-8555-555555555555", patchDigest: "c".repeat(64), changedPaths: ["src/index.ts"], limitations: [] } };
  const trustedDev = expected({ mode: "dev" });
  assert.deepEqual(validateTaskResult(dev, { expected: trustedDev }), dev);
  assert.throws(() => validateTaskResult({ ...dev, payload: { ...dev.payload, changedPaths: ["../secret"] } }, { expected: trustedDev }));
  assert.throws(() => validateTaskResult({ ...dev, payload: { ...dev.payload, approved: true } }, { expected: trustedDev }));
  assert.throws(() => validateTaskResult(dev, { expected: expected() }));
});
