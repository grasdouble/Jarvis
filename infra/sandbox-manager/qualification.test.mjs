import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import process from "node:process";

const qualificationScript = fileURLToPath(new URL("./qualify-colima.mjs", import.meta.url));

test("qualification CLI exposes its fixed dedicated-profile contract without connecting to Colima", () => {
  const result = spawnSync(process.execPath, [qualificationScript, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /colima-jarvis/);
  assert.match(result.stdout, /sandbox-manager/);
});

test("qualification CLI refuses a non-JARVIS profile before any Docker operation", () => {
  const result = spawnSync(process.execPath, [qualificationScript, "--profile", "default"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only.*jarvis|profile.*jarvis/i);
  assert.doesNotMatch(result.stdout + result.stderr, /docker (?:run|create|rm|volume)/i);
});
