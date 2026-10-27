import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
import test from "node:test";
import process from "node:process";
import net from "node:net";
import { connect, targetIsBlocked } from "./qualification/qualification-probe.mjs";

const qualificationScript = fileURLToPath(new URL("./qualify-colima.mjs", import.meta.url));
const qualificationSource = readFileSync(qualificationScript, "utf8");

test("qualification CLI exposes its fixed dedicated-profile contract without connecting to Colima", () => {
  const result = spawnSync(process.execPath, [qualificationScript, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /colima-jarvis/);
  assert.match(result.stdout, /sandbox-manager/);
  assert.match(result.stdout, /createSandboxManagerServer/);
  assert.match(result.stdout, /createSandboxQueueWorker/);
  assert.match(result.stdout, /stop.*2 seconds/i);
  assert.match(result.stdout, /cancellation.*10 seconds/i);
});

test("qualification CLI refuses a non-JARVIS profile before any Docker operation", () => {
  const result = spawnSync(process.execPath, [qualificationScript, "--profile", "default"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only.*jarvis|profile.*jarvis/i);
  assert.doesNotMatch(result.stdout + result.stderr, /docker (?:run|create|rm|volume)/i);
});

test("live network probes are limited to loopback and the run-owned synthetic witness", () => {
  assert.match(qualificationSource, /add\("loopback-ipv4", "127\.0\.0\.1"\)/);
  assert.match(qualificationSource, /add\("loopback-ipv6", "::1"\)/);
  assert.match(qualificationSource, /add\("core-network-witness", witnessAddress, 8181\)/);
  assert.doesNotMatch(qualificationSource, /1\.1\.1\.1|8\.8\.8\.8|2606:4700:4700/);
  assert.doesNotMatch(qualificationSource, /arp|route.*default|networkInterfaces\(/i);
  assert.match(qualificationSource, /dnsNames: \["core-witness"\]/);
});

test("expected loopback refusal is blocked evidence, while a successful connection is reachable", async () => {
  const refused = await connect("127.0.0.1", 1);
  assert.equal(refused.code, "ECONNREFUSED");
  assert.equal(targetIsBlocked({ label: "loopback-ipv4" }, refused), true);

  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const connected = await connect("127.0.0.1", server.address().port);
    assert.equal(connected.connected, true);
    assert.equal(targetIsBlocked({ label: "loopback-ipv4" }, connected), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("active refusal from the synthetic witness is not treated as blocked", () => {
  assert.equal(targetIsBlocked({ label: "core-network-witness" }, { connected: false, code: "ECONNREFUSED" }), false);
});

test("Colima stop/resume qualification provides a fresh fenced lease after cancelling stopped work", () => {
  assert.match(qualificationSource, /const leases = \[1, 2\]\.map\(\(epoch\)/);
  assert.match(qualificationSource, /cancelledTaskIds, \[workerTaskId\]/);
  assert.match(qualificationSource, /dispatchedLease\.attemptId, resumedLease\.attemptId/);
  assert.match(qualificationSource, /dispatchedLease\.epoch, resumedLease\.epoch/);
  assert.match(qualificationSource, /mappings\.get\(\{ taskId: workerTaskId, attemptId: resumedLease\.attemptId, leaseEpoch: resumedLease\.epoch \}\)/);
  assert.match(qualificationSource, /manager\.destroy\(workerSandboxId, resumedLease\.epoch\)/);
});
