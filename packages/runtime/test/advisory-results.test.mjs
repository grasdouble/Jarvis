import assert from "node:assert/strict";
import { test } from "node:test";
import { AdvisoryResultError, computeSnapshotDigest, getReadOnlyAnalysisProfile, PLAN_CAPABILITIES, PR_ANALYSIS_CAPABILITIES, READ_ONLY_ANALYSIS_PROFILES, validateAdvisoryResult } from "../dist/index.js";

const binding = { repository: "grasdouble/jarvis", revision: "a".repeat(40) };
const files = [{ path: "src/index.ts", sha256: "b".repeat(64) }];
const diffSha256 = "d".repeat(64);
const excludedPaths = [];
const diffBytes = 12;
const snapshot = { ...binding, files, excludedPaths, diffSha256, diffBytes, snapshotDigest: computeSnapshotDigest(binding.repository, binding.revision, files, excludedPaths, diffSha256, diffBytes) };
const plan = { kind: "plan", ...binding, snapshotDigest: snapshot.snapshotDigest, complete: true, limitations: [], steps: [{ description: "Inspect the caller contract", sourcePaths: ["src/index.ts"] }], affectedAreas: ["src/index.ts"], assumptions: ["The manifest is complete"], risks: ["None known"], unresolvedQuestions: [] };
const review = { kind: "pr-analysis", ...binding, snapshotDigest: snapshot.snapshotDigest, complete: true, limitations: [], uncertainty: [], examinedPaths: ["src/index.ts"], findings: [{ severity: "low", summary: "Observation", sourcePaths: ["src/index.ts"] }] };

test("validates distinct, closed plan and PR-analysis schemas against the exact snapshot", () => {
  assert.equal(validateAdvisoryResult(plan, snapshot, "plan").steps[0].description, "Inspect the caller contract");
  assert.equal(validateAdvisoryResult(review, snapshot, "pr-analysis").examinedPaths[0], "src/index.ts");
  assert.deepEqual(validateAdvisoryResult(review, snapshot, "pr-analysis").uncertainty, []);
  assert.throws(() => validateAdvisoryResult({ ...plan, examinedPaths: ["src/index.ts"] }, snapshot, "plan"), AdvisoryResultError);
  assert.throws(() => validateAdvisoryResult({ ...review, steps: ["run tests"] }, snapshot, "pr-analysis"), AdvisoryResultError);
  assert.throws(() => validateAdvisoryResult({ ...review, snapshotDigest: "e".repeat(64) }, snapshot, "pr-analysis"), AdvisoryResultError);
  assert.throws(() => validateAdvisoryResult({ ...plan, repository: "Other/Repo" }, snapshot, "plan"), AdvisoryResultError);
  assert.throws(() => validateAdvisoryResult({ ...plan, revision: "not-a-revision" }, snapshot, "plan"), AdvisoryResultError);
  assert.throws(() => validateAdvisoryResult(plan, { ...snapshot, diffSha256: "e".repeat(64) }, "plan"), AdvisoryResultError);
  assert.throws(() => validateAdvisoryResult({ ...plan, steps: [{ description: "Exploit", sourcePaths: ["missing.ts"] }] }, snapshot, "plan"), AdvisoryResultError);
  assert.throws(() => validateAdvisoryResult(review, snapshot, "unknown"), AdvisoryResultError);
  assert.throws(() => validateAdvisoryResult({ ...review, examinedPaths: ["missing.ts"] }, snapshot, "pr-analysis"), AdvisoryResultError);
  assert.throws(() => validateAdvisoryResult({ ...plan, steps: [{ description: "No evidence", sourcePaths: [] }] }, snapshot, "plan"), AdvisoryResultError);
  assert.throws(() => computeSnapshotDigest(binding.repository, binding.revision, [{ path: "src/File.ts", sha256: "b".repeat(64) }, { path: "src/file.ts", sha256: "c".repeat(64) }], excludedPaths, diffSha256, diffBytes), AdvisoryResultError);
  assert.throws(() => computeSnapshotDigest(binding.repository, binding.revision, [{ path: "src/Ａ.ts", sha256: "b".repeat(64) }, { path: "src/A.ts", sha256: "c".repeat(64) }], excludedPaths, diffSha256, diffBytes), AdvisoryResultError);
  const oversizedManifest = Array.from({ length: 2100 }, (_, index) => ({ path: `${String(index).padStart(4, "0")}/${"x".repeat(1000)}`, sha256: "b".repeat(64) }));
  assert.throws(() => computeSnapshotDigest(binding.repository, binding.revision, oversizedManifest, [], diffSha256, diffBytes), /path manifest/);
});

test("bounds strings, list counts and UTF-8 bytes and requires explicit partial limitations", () => {
  assert.throws(() => validateAdvisoryResult({ ...plan, complete: false }, snapshot, "plan"), AdvisoryResultError);
  assert.throws(() => validateAdvisoryResult({ ...review, complete: true, limitations: ["partial"] }, snapshot, "pr-analysis"), AdvisoryResultError);
  assert.throws(() => validateAdvisoryResult({ ...plan, assumptions: ["é".repeat(40_000)] }, snapshot, "plan"), AdvisoryResultError);
  assert.throws(() => validateAdvisoryResult({ ...review, examinedPaths: ["src/index.ts", "src/index.ts"] }, snapshot, "pr-analysis"), AdvisoryResultError);
  assert.throws(() => validateAdvisoryResult(Object.fromEntries(Object.entries(review).filter(([key]) => key !== "uncertainty")), snapshot, "pr-analysis"), AdvisoryResultError);
});

test("exposes exact immutable read-only profiles with no network, writer, shell, plugin, command, or escalation authority", () => {
  for (const [mode, agent] of [["plan", "plan"], ["pr-analysis", "review"]]) {
    const profile = getReadOnlyAnalysisProfile(mode);
    assert.equal(profile.agent, agent);
    assert.deepEqual(profile.openCodeConfig.agents[agent].permissions, profile.openCodeConfig.permissions);
    assert.deepEqual(profile.openCodeConfig.permissions, [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ]);
    assert.equal(Object.isFrozen(profile.openCodeConfig.agents[agent]), true);
  }
  assert.deepEqual(Object.keys(READ_ONLY_ANALYSIS_PROFILES).sort(), ["plan", "prAnalysis"]);
  for (const profile of Object.values(READ_ONLY_ANALYSIS_PROFILES)) {
    assert.deepEqual(Object.keys(profile).sort(), ["agent", "commandAutoload", "devEscalation", "diffRead", "githubMutation", "githubRead", "openCodeConfig", "pluginAutoload", "profile", "publication", "repositoryRead", "skillAutoload", "tools", "workspaceWrite"].sort());
    assert.equal(Object.isFrozen(profile.openCodeConfig), true);
    assert.equal(Object.isFrozen(profile.openCodeConfig.permissions), true);
    assert.throws(() => profile.openCodeConfig.permissions.push({ action: "*", resource: "*", effect: "allow" }), TypeError);
  }
  for (const capabilities of [PLAN_CAPABILITIES, PR_ANALYSIS_CAPABILITIES]) {
    assert.equal(capabilities.workspaceWrite, false);
    assert.equal(capabilities.githubMutation, false);
    assert.equal(capabilities.publication, false);
    assert.equal(capabilities.devEscalation, false);
    assert.equal(capabilities.pluginAutoload, false);
    assert.equal(capabilities.commandAutoload, false);
  }
  assert.throws(() => getReadOnlyAnalysisProfile("upgrade"), /mode/);
});
