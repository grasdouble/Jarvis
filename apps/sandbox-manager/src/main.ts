import { readFileSync } from "node:fs";
import { createSandboxManagerFromConfiguration } from "./index.js";
import type { SandboxProfile } from "./index.js";
import { DockerEngineClient } from "./docker-engine.js";
import { createSandboxManagerServer } from "./server.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required sandbox-manager setting is missing: ${name}.`);
  return value;
}

function readSecret(name: string): Buffer {
  return readFileSync(required(name));
}

const profilePath = required("SANDBOX_PROFILE_CONFIG");
const profileValue: unknown = JSON.parse(readFileSync(profilePath, "utf8"));
if (!Array.isArray(profileValue)) throw new Error("Sandbox profile configuration must be a JSON array.");
const profiles = profileValue as SandboxProfile[];
const gatewayFilterConfigPath = process.env.SANDBOX_GATEWAY_FILTER_CONFIG_FILE;
const gatewayFilterConfig = gatewayFilterConfigPath === undefined
  ? undefined
  : JSON.parse(readFileSync(gatewayFilterConfigPath, "utf8")) as unknown;
const manager = createSandboxManagerFromConfiguration({
  engine: new DockerEngineClient({
    socketPath: "/var/run/docker.sock",
    apiVersion: required("DOCKER_ENGINE_API_VERSION"),
  }),
  profiles,
  gatewayFilterConfig,
});
await manager.recover();

const server = createSandboxManagerServer({
  manager,
  tls: {
    key: readSecret("SANDBOX_MANAGER_TLS_KEY_FILE"),
    cert: readSecret("SANDBOX_MANAGER_TLS_CERT_FILE"),
    ca: readSecret("SANDBOX_MANAGER_CLIENT_CA_FILE"),
  },
  authorizeClient(certificate) {
    return certificate.subjectaltname?.split(", ").includes("URI:spiffe://jarvis/worker") ?? false;
  },
});

const port = Number(process.env.SANDBOX_MANAGER_PORT ?? "8443");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("SANDBOX_MANAGER_PORT must be a valid TCP port.");
}
server.listen(port, "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
