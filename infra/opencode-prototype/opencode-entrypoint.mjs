import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export async function startOpenCodeEntryPoint({
  environment = process.env,
  spawnProcess = spawn,
  bridgeFactory,
  processControl = process,
} = {}) {
  const socketPath = environment.LLM_GATEWAY_SOCKET;
  const capability = environment.LLM_GATEWAY_ATTEMPT_CAPABILITY;
  const bridgePort = Number(environment.LLM_GATEWAY_BRIDGE_PORT ?? "4010");
  if (!socketPath || !capability || !Number.isSafeInteger(bridgePort) || bridgePort < 1 || bridgePort > 65_535) {
    throw new Error("The per-attempt gateway bridge settings are invalid.");
  }

  if (typeof processControl.getuid === "function" && processControl.getuid() !== 0) {
    throw new Error("The trusted bridge must start before OpenCode under a distinct root-owned process.");
  }
  processControl.setgid(10001);
  bridgeFactory ??= (await import("./gateway.js")).createLoopbackGatewayBridge;
  const bridge = bridgeFactory({ socketPath, capability, port: bridgePort });
  const childEnvironment = { ...environment, OPENCODE_CONFIG_PROJECT_DISABLE: "true" };
  delete childEnvironment.LLM_GATEWAY_ATTEMPT_CAPABILITY;
  const opencode = spawnProcess("/usr/local/bin/opencode", ["serve", "--hostname", "127.0.0.1", "--port", "4096"], {
    stdio: "inherit",
    env: childEnvironment,
    uid: 10001,
    gid: 10001,
  });

  let stopping = false;
  function stop(signal) {
    if (stopping) return;
    stopping = true;
    opencode.kill(signal);
    bridge.close(() => processControl.exit(0));
  }

  for (const signal of ["SIGINT", "SIGTERM"]) processControl.once(signal, () => stop(signal));
  opencode.once("error", () => {
    bridge.close(() => processControl.exit(1));
  });
  opencode.once("exit", (code) => {
    bridge.close(() => processControl.exit(code ?? 1));
  });
  return { bridge, opencode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startOpenCodeEntryPoint();
}
