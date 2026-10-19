import { spawn } from "node:child_process";
import { createLoopbackGatewayBridge } from "./gateway.js";

const socketPath = process.env.LLM_GATEWAY_SOCKET;
const capability = process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY;
const bridgePort = Number(process.env.LLM_GATEWAY_BRIDGE_PORT ?? "4010");
if (!socketPath || !capability || !Number.isSafeInteger(bridgePort) || bridgePort < 1 || bridgePort > 65_535) {
  throw new Error("The per-attempt gateway bridge settings are invalid.");
}

const bridge = createLoopbackGatewayBridge({ socketPath, capability, port: bridgePort });
const opencode = spawn("/usr/local/bin/opencode", ["serve", "--hostname", "127.0.0.1", "--port", "4096"], {
  stdio: "inherit",
  env: process.env,
});

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  opencode.kill(signal);
  bridge.close(() => process.exit(0));
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop(signal));
opencode.once("error", () => {
  bridge.close(() => process.exit(1));
});
opencode.once("exit", (code) => {
  bridge.close(() => process.exit(code ?? 1));
});
