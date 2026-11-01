import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { startOpenCodeEntryPoint } from "./opencode-entrypoint.mjs";

test("entrypoint keeps the attempt capability in its broker and drops it before unprivileged OpenCode launch", async () => {
  const bridgeOptions = [];
  const processListeners = new Map();
  let invocation;
  const bridge = { close(callback) { callback(); } };
  const child = new EventEmitter();
  child.kill = () => {};
  await startOpenCodeEntryPoint({
    environment: {
      LLM_GATEWAY_SOCKET: "/run/jarvis/llm.sock",
      LLM_GATEWAY_ATTEMPT_CAPABILITY: "a".repeat(64),
      LLM_GATEWAY_PROFILE_ID: "openai",
    },
    bridgeFactory(options) { bridgeOptions.push(options); return bridge; },
    spawnProcess(...args) { invocation = args; return child; },
    processControl: { getuid: () => 0, setgid: (value) => { processListeners.set("gid", value); }, once(name, handler) { processListeners.set(name, handler); }, exit() {} },
  });
  assert.equal(bridgeOptions[0].capability, "a".repeat(64));
  assert.equal(invocation[2].uid, 10001);
  assert.equal(invocation[2].gid, 10001);
  assert.equal(invocation[2].env.LLM_GATEWAY_PROFILE_ID, "openai");
  assert.equal(invocation[2].env.OPENCODE_CONFIG_PROJECT_DISABLE, "true");
  assert.equal(Object.hasOwn(invocation[2].env, "LLM_GATEWAY_ATTEMPT_CAPABILITY"), false);
  assert.equal(processListeners.get("gid"), 10001, "trusted bridge shares only the socket-owning group while retaining root UID");
  assert.equal(processListeners.has("SIGTERM"), true);
});
