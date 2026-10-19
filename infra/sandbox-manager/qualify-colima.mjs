import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const context = "colima-jarvis";
const dockerfile = join(scriptDirectory, "qualification/Dockerfile");
const qualificationDirectory = join(scriptDirectory, "qualification");
const apiVersion = "1.54";
const profile = {
  id: "jv007-readonly-qualification-v1",
  image: `registry.example.invalid/jarvis/qualification@sha256:${"0".repeat(64)}`,
  platform: "linux/arm64",
  memoryBytes: 4 * 1024 ** 3,
  nanoCpus: 2_000_000_000,
  pidsLimit: 128,
  maxDurationMs: 30 * 60 * 1000,
  readOnlyWorkspace: true,
};

function usage() {
  return `Usage: node infra/sandbox-manager/qualify-colima.mjs --profile jarvis\n\n` +
    `Builds a synthetic-only qualification image and exercises the sandbox-manager ` +
    `adapter against the dedicated ${context} Docker Engine. Creates and removes only ` +
    `resources tagged for this run. It does not start Compose services or provision secrets.\n`;
}

function docker(...args) {
  return execFileSync("docker", ["--context", context, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function parseArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  if (args.length !== 2 || args[0] !== "--profile" || args[1] !== "jarvis") {
    throw new Error("Only the dedicated jarvis profile is supported.\n" + usage());
  }
  return { help: false };
}

function localNetworkTargets(witnessAddress, witnessName) {
  const targets = new Map();
  const add = (label, address, port = 443) => {
    if (!address || address.includes("%") || !/^[0-9a-fA-F:.]+$/.test(address)) return;
    const key = `${address}|${port}`;
    if (!targets.has(key)) targets.set(key, { label, address, port });
  };
  for (const [interfaceName, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal) add(`mac-${interfaceName}-${entry.family}`, entry.address);
    }
  }
  try {
    const gateway = command("route", ["-n", "get", "default"])
      .match(/^\s*gateway:\s*(\S+)/m)?.[1];
    if (gateway) add("lan-gateway", gateway);
  } catch { /* No default route means there is no discovered host gateway. */ }
  try {
    const neighbors = command("arp", ["-an"]);
    for (const [index, match] of [...neighbors.matchAll(/\(([^)]+)\)/g)].entries()) {
      if (index >= 32) break;
      add(`lan-neighbor-${index + 1}`, match[1]);
    }
  } catch { /* ARP may be unavailable on an otherwise valid host. */ }
  try {
    const networks = docker("network", "ls", "--quiet").split("\n").filter(Boolean);
    for (const [index, networkId] of networks.entries()) {
      const name = docker("network", "inspect", "--format", "{{.Name}}", networkId);
      const gateways = docker("network", "inspect", "--format", "{{range .IPAM.Config}}{{println .Gateway}}{{end}}", networkId)
        .split("\n").filter(Boolean);
      for (const [gatewayIndex, gateway] of gateways.entries()) add(`docker-network-${index}-gateway-${gatewayIndex}`, gateway);
      if (name === "none" || name === "host") continue;
    }
    const peers = docker("ps", "--quiet").split("\n").filter(Boolean);
    let peerIndex = 0;
    for (const peer of peers) {
      const name = docker("inspect", "--format", "{{.Name}}", peer).replace(/^\//, "");
      if (name === witnessName) continue;
      const networks = JSON.parse(docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", peer));
      for (const network of Object.values(networks ?? {})) {
        add(`task-peer-${peerIndex}-ipv4`, network.IPAddress);
        add(`task-peer-${peerIndex}-ipv6`, network.GlobalIPv6Address);
        peerIndex += 1;
      }
    }
  } catch { /* Missing or stopped peers do not supply a direct target. */ }
  add("core-network-witness", witnessAddress, 8181);
  add("public-ipv4", "1.1.1.1");
  add("public-ipv4-secondary", "8.8.8.8");
  add("public-ipv6", "2606:4700:4700::1111");
  return [...targets.values()];
}

async function waitForReport(containerId) {
  const stopAt = Date.now() + 20_000;
  let lastError;
  while (Date.now() < stopAt) {
    try {
      const logs = docker("logs", containerId);
      const line = logs.split("\n").find((entry) => entry.startsWith("JV007_QUALIFICATION "));
      if (line) return JSON.parse(line.slice("JV007_QUALIFICATION ".length));
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`The synthetic sandbox did not produce qualification evidence${lastError ? ": Docker logs unavailable" : "."}`);
}

function assertInspection(inspect) {
  const host = inspect.HostConfig;
  assert.equal(inspect.Config.User, "10001:10001");
  assert.deepEqual(inspect.Config.Cmd ?? [], [], "no caller-selected command may be present");
  assert.deepEqual(inspect.Config.Entrypoint, ["/usr/local/bin/jarvis-sandbox"]);
  assert.equal((inspect.Config.Env ?? []).some((entry) =>
    /^(?:github|token|secret|credential|private.?key|aws)[^=]*=/i.test(entry)), false,
  "credential-like environment variables are configured on the agent");
  assert.equal(host.NetworkMode, "none");
  assert.equal(host.ReadonlyRootfs, true);
  assert.equal(host.Privileged, false);
  assert.deepEqual(host.CapDrop, ["ALL"]);
  assert.ok(host.SecurityOpt.includes("no-new-privileges:true"));
  assert.equal(host.Memory, profile.memoryBytes);
  assert.equal(host.NanoCpus, profile.nanoCpus);
  assert.equal(host.PidsLimit, profile.pidsLimit);
  for (const field of ["PidMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode"]) {
    assert.ok(!host[field] || host[field] === "private", `${field} must not share a host namespace`);
  }
  assert.deepEqual(host.Devices ?? [], []);
  assert.deepEqual(host.PortBindings ?? {}, {});
  assert.ok(!host.Binds, "legacy bind mounts must be absent");
  for (const field of ["PidMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode"]) {
    assert.notEqual(host[field], "host", `${field} must not use the host namespace`);
  }
  assert.ok(inspect.Mounts.every((mount) => mount.Type === "volume"), "a non-volume mount is present");
  assert.ok(inspect.Mounts.every((mount) => !mount.Source.includes("docker.sock")), "Engine socket is mounted");
  const workspace = inspect.Mounts.find((mount) => mount.Destination === "/workspace");
  assert.ok(workspace && workspace.RW === false, "snapshot volume is not read-only");
}

function namespaceReference(witnessName) {
  const source = `const fs=require('node:fs');const n=['pid','net','mnt','ipc','uts'].map(x=>fs.readlinkSync('/proc/1/ns/'+x));process.stdout.write(JSON.stringify(n))`;
  return JSON.parse(docker("exec", witnessName, "node", "-e", source));
}

async function main(args) {
  const parsed = parseArguments(args);
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }

  const [{ createSandboxManager }, { DockerEngineClient }] = await Promise.all([
    import("../../apps/sandbox-manager/dist/index.js"),
    import("../../apps/sandbox-manager/dist/docker-engine.js"),
  ]);

  command("bash", [join(repositoryRoot, "infra/colima/verify.sh"), "--profile", "jarvis"]);
  assert.equal(docker("info", "--format", "{{.OSType}}/{{.Architecture}}"), "linux/aarch64",
    "the selected Engine is not Linux ARM64");
  const endpoint = JSON.parse(docker("context", "inspect", context, "--format", "{{json .Endpoints.docker}}"));
  assert.ok(endpoint.Host.startsWith("unix://"), "the dedicated Colima context must use its forwarded Unix socket");
  const socketPath = decodeURIComponent(endpoint.Host.slice("unix://".length));

  const runId = randomUUID();
  const taskId = `jv007-${runId}`;
  const networkName = `jv007-core-${runId}`;
  const witnessName = `jv007-witness-${runId}`;
  const imageTag = `jarvis/sandbox-qualification:jv007-${runId}`;
  let imageId;
  let witnessCreated = false;
  let networkCreated = false;
  let manager;
  const activeSandboxIds = new Set();

  const removeRunResources = async () => {
    for (const sandboxId of activeSandboxIds) {
      try { await manager?.destroy(sandboxId, 1); } catch { /* Keep cleanup scoped; report failures below. */ }
    }
    if (witnessCreated) {
      try { docker("rm", "--force", witnessName); } catch { /* Removed by the engine already. */ }
    }
    if (networkCreated) {
      try { docker("network", "rm", networkName); } catch { /* Removed with the witness. */ }
    }
    try { docker("image", "rm", imageId ?? imageTag); } catch { /* The engine may still reference it. */ }
  };

  try {
    docker("build", "--platform", "linux/arm64", "--file", dockerfile, "--tag", imageTag, qualificationDirectory);
    imageId = docker("image", "inspect", "--format", "{{.Id}}", imageTag);
    assert.match(imageId, /^sha256:[0-9a-f]{64}$/);

    docker("network", "create", "--internal", networkName);
    networkCreated = true;
    const witnessSource = `const http=require('node:http');http.createServer((_q,r)=>r.end('synthetic witness\\n')).listen(8181,'0.0.0.0')`;
    docker("run", "--detach", "--name", witnessName, "--network", networkName,
      "--entrypoint", "node", imageId, "-e", witnessSource);
    witnessCreated = true;
    const witnessAddress = docker("inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", witnessName);
    assert.match(witnessAddress, /^\d+\.\d+\.\d+\.\d+$/);
    const referenceNamespaces = namespaceReference(witnessName);
    const targets = localNetworkTargets(witnessAddress, witnessName);
    const seed = {
      targets,
      dnsNames: ["example.com", "host.lima.internal", "host.docker.internal", "gateway.docker.internal", "core-witness"],
      referenceNamespaces: Object.fromEntries(["pid", "net", "mnt", "ipc", "uts"].map((name, index) => [name, referenceNamespaces[index]])),
      limits: { memoryBytes: profile.memoryBytes, nanoCpus: profile.nanoCpus, pids: profile.pidsLimit },
    };

    const rawEngine = new DockerEngineClient({ socketPath, apiVersion });
    const engine = Object.create(rawEngine);
    engine.createVolume = async (request) => {
        const created = await rawEngine.createVolume(request);
        if (request.labels.resource_kind === "workspace") {
          const writer = `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));fs.mkdirSync('/workspace',{recursive:true});fs.writeFileSync('/workspace/qualification-input.json',JSON.stringify(input),{mode:0o444});fs.chownSync('/workspace',10001,10001);fs.chownSync('/workspace/qualification-input.json',10001,10001)`;
          execFileSync("docker", ["--context", context, "run", "--rm", "--interactive", "--network", "none", "--user", "0:0",
            "--mount", `type=volume,source=${request.name},target=/workspace`, "--entrypoint", "node", imageId, "-e", writer], {
            cwd: repositoryRoot,
            input: JSON.stringify(seed),
            stdio: ["pipe", "pipe", "pipe"],
          });
        }
        return created;
      };
    engine.createContainer = (request) => rawEngine.createContainer({ ...request, image: imageId });
    manager = createSandboxManager({ engine, profiles: [profile] });

    const executeAttempt = async (deadline) => {
      const spec = {
        taskId,
        attemptId: `attempt-${randomUUID()}`,
        snapshotId: randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40),
        profileId: profile.id,
        modelProfileId: "jv007-synthetic-model-profile",
        deadline,
        leaseEpoch: 1,
      };
      const status = await manager.create(spec, `jv007:${randomUUID()}`);
      activeSandboxIds.add(status.sandboxId);
      const containerId = docker("ps", "--all", "--quiet", "--filter", `label=sandbox_id=${status.sandboxId}`);
      assert.match(containerId, /^[0-9a-f]{12,64}$/i, "manager did not create exactly one labeled container");
      const inspection = JSON.parse(docker("inspect", containerId))[0];
      assertInspection(inspection);
      const report = await waitForReport(containerId);
      return { status, containerId, report };
    };

    const cancellationStart = Date.now();
    const first = await executeAttempt(new Date(Date.now() + 5 * 60_000).toISOString());
    assert.equal(first.report.uid, 10001);
    assert.equal(first.report.gid, 10001);
    assert.deepEqual(first.report.cgroups, {
      memory: String(profile.memoryBytes),
      cpu: `${profile.nanoCpus / 10_000} 100000`,
      pids: String(profile.pidsLimit),
    });
    await manager.cancel(first.status.sandboxId, 1);
    await manager.destroy(first.status.sandboxId, 1);
    activeSandboxIds.delete(first.status.sandboxId);
    assert.equal(docker("ps", "--all", "--quiet", "--filter", `label=sandbox_id=${first.status.sandboxId}`), "",
      "cancelled container remains");
    assert.equal(docker("volume", "ls", "--quiet", "--filter", `label=sandbox_id=${first.status.sandboxId}`), "",
      "cancelled attempt volumes remain");
    const cancellationCleanupMs = Date.now() - cancellationStart;
    assert.ok(cancellationCleanupMs < 5 * 60_000, "cancelled attempt cleanup exceeded five minutes");

    const expiryStart = Date.now();
    const expiring = await executeAttempt(new Date(Date.now() + 8_000).toISOString());
    await delay(8_250);
    assert.equal(await manager.expire(), 1, "the manager did not expire the overdue attempt");
    activeSandboxIds.delete(expiring.status.sandboxId);
    assert.equal(docker("ps", "--all", "--quiet", "--filter", `label=sandbox_id=${expiring.status.sandboxId}`), "",
      "expired container remains");
    assert.equal(docker("volume", "ls", "--quiet", "--filter", `label=sandbox_id=${expiring.status.sandboxId}`), "",
      "expired attempt volumes remain");
    const expiryCleanupMs = Date.now() - expiryStart;
    assert.ok(expiryCleanupMs < 5 * 60_000, "expired attempt cleanup exceeded five minutes");

    process.stdout.write(JSON.stringify({
      profile: "jarvis",
      engine: "linux/arm64",
      attempts: 2,
      cancellationCleanupMs,
      expiryCleanupMs,
      probe: first.report,
      evidence: "synthetic-only; no repository or real credentials were mounted or sent",
    }, null, 2) + "\n");
  } finally {
    await removeRunResources();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`JV-007 Colima qualification failed: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
