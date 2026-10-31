import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import assert from "node:assert/strict";
import { getReadOnlyAnalysisProfile } from "/opt/jarvis/advisory-results.mjs";
import { OpenCodeClient } from "/opt/jarvis/runtime-client.mjs";

const password = process.env.OPENCODE_SERVER_PASSWORD;
assert.ok(password, "attempt-scoped server password must be set");
const origin = "http://127.0.0.1:4096";
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
async function request(path, init = {}) {
  const response = await fetch(new URL(path, origin), {
    ...init,
    headers: { authorization, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
  });
  const text = await response.text();
  assert.ok(response.ok, `OpenCode ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`OpenCode ${path} returned non-JSON ${response.headers.get("content-type")}: ${text.slice(0, 250)}`);
  }
}

const client = new OpenCodeClient({
  baseUrl: origin,
  password,
  mode: "pr-analysis",
  timeoutMs: 10_000,
});
const health = await client.health();
assert.equal(health.version, "2.0.32");

const config = JSON.parse(readFileSync("/config/opencode/opencode.json", "utf8"));
for (const mode of ["plan", "pr-analysis"]) {
  const profile = getReadOnlyAnalysisProfile(mode);
  assert.deepEqual(config.agents[profile.openCodeConfig.default_agent], profile.openCodeConfig.agents[profile.openCodeConfig.default_agent]);
  assert.deepEqual(config.permissions, profile.openCodeConfig.permissions);
}

const file = await fetch(new URL("/api/fs/read/fixture.txt", origin), { headers: { authorization } });
assert.equal(file.status, 200);
assert.match(await file.text(), /synthetic fixed snapshot/);

const session = await client.createSession("Synthetic fixed-snapshot review", {
  providerID: "jarvis-fixture",
  modelID: "fixture-model",
});
assert.match(session.id, /^[a-zA-Z0-9_-]+$/);

let report;
let permissionToolRefused = false;
let permissionEditRefused = false;
try {
  await client.prompt(session.id, "Return the structured review report for the synthetic fixed snapshot. Do not use tools.");
  let messages;
  let assistant;
  let content = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    messages = await client.messages(session.id);
    assistant = messages.find((item) => item.type === "assistant");
    content = (assistant?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (content) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(content, `OpenCode should return a synthetic assistant response: ${JSON.stringify(messages).slice(0, 3000)}`);
  report = JSON.parse(content);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.complete, false);
  assert.equal(report.recommendation, "uncertain");
  assert.deepEqual(report.examinedPaths, ["fixture.txt"]);

  await client.prompt(session.id, "__permission_probe__");
  let permissionMessages = [];
  let refusedShell;
  let refusedEdit;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    permissionMessages = await client.messages(session.id);
    const tools = permissionMessages.flatMap((item) => item.content ?? []).filter((part) => part.type === "tool" && part.executed === false);
    refusedShell = tools.find((part) => part.name === "shell");
    refusedEdit = tools.find((part) => part.name === "edit");
    if (refusedShell && refusedEdit) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  permissionToolRefused = Boolean(refusedShell);
  permissionEditRefused = Boolean(refusedEdit);
  assert.equal(permissionToolRefused, true, `OpenCode should refuse shell: ${JSON.stringify(permissionMessages).slice(0, 3000)}`);
  assert.equal(permissionEditRefused, true, `OpenCode should refuse edit: ${JSON.stringify(permissionMessages).slice(0, 3000)}`);
  assert.match(refusedShell.state?.error?.message ?? "", /no tool named|permission|denied/i);
  assert.match(refusedEdit.state?.error?.message ?? "", /no tool named|permission|denied/i);
  assert.equal(existsSync("/state/permission-probe.txt"), false);
  await client.abort(session.id);

  const planClient = new OpenCodeClient({ baseUrl: origin, password, mode: "plan", timeoutMs: 10_000 });
  const planSession = await planClient.createSession("Synthetic fixed-snapshot plan permission check", { providerID: "jarvis-fixture", modelID: "fixture-model" });
  try {
    await planClient.prompt(planSession.id, "__permission_probe__");
    let planMessages = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      planMessages = await planClient.messages(planSession.id);
      const refusals = planMessages.flatMap((item) => item.content ?? []).filter((part) => part.type === "tool" && part.executed === false);
      if (refusals.some((part) => part.name === "shell") && refusals.some((part) => part.name === "edit")) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const planRefusals = planMessages.flatMap((item) => item.content ?? []).filter((part) => part.type === "tool" && part.executed === false);
    assert.ok(planRefusals.some((part) => part.name === "shell"), `plan must refuse shell: ${JSON.stringify(planMessages).slice(0, 3000)}`);
    assert.ok(planRefusals.some((part) => part.name === "edit"), `plan must refuse edit: ${JSON.stringify(planMessages).slice(0, 3000)}`);
  } finally {
    await planClient.abort(planSession.id);
    await planClient.deleteSession(planSession.id);
  }

  await client.prompt(session.id, "__cancel_probe__");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(await client.abort(session.id), true);
} finally {
  await client.abort(session.id);
  await client.deleteSession(session.id);
}

const stateProbe = "/state/opencode-prototype-state-probe.txt";
writeFileSync(stateProbe, "state volume is writable\n", { mode: 0o600 });
unlinkSync(stateProbe);

console.log(JSON.stringify({
  opencodeVersion: health.version,
  snapshotRead: true,
  serverAuthenticated: true,
  reportSchemaVersion: report.schemaVersion,
  reportRecommendation: report.recommendation,
  reportComplete: report.complete,
  permissionProbeSentinelAbsent: !existsSync("/state/permission-probe.txt"),
  permissionToolRefused,
  permissionEditRefused,
  sessionCancelledAndDeleted: true,
  stateVolumeWritable: true,
  configPermissionsLoaded: true,
  planAndReviewModesExercised: true,
}));
