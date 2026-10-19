import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const input = JSON.parse(await fs.readFile("/workspace/qualification-input.json", "utf8"));

function statusFields(text) {
  return Object.fromEntries(text.split("\n").flatMap((line) => {
    const separator = line.indexOf(":");
    return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1).trim()]];
  }));
}

async function namespaceIds() {
  return Object.fromEntries(await Promise.all(["pid", "net", "mnt", "ipc", "uts", "user"].map(async (name) => {
    return [name, await fs.readlink(`/proc/self/ns/${name}`)];
  })));
}

async function connect(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ connected: false, code: "TIMEOUT" }));
    socket.once("connect", () => finish({ connected: true, code: "CONNECTED" }));
    socket.once("error", (error) => finish({ connected: false, code: error.code ?? "ERROR" }));
  });
}

async function networkEvidence() {
  const targets = input.targets;
  const attempts = await Promise.all(targets.map(async (target) => {
    const result = await connect(target.address, target.port);
    return { label: target.label, ...result };
  }));
  const dnsResults = await Promise.all(input.dnsNames.map(async (name) => {
    try {
      await dns.lookup(name, { all: true, verbatim: true });
      return { name, resolved: true };
    } catch {
      return { name, resolved: false };
    }
  }));
  const interfaces = (await fs.readFile("/proc/net/dev", "utf8"))
    .split("\n").slice(2).map((line) => line.split(":")[0].trim()).filter(Boolean);
  const nonLoopback = interfaces.filter((name) => name !== "lo");
  const routes = (await fs.readFile("/proc/net/route", "utf8")).trim().split("\n").slice(1)
    .map((line) => line.split(/\s+/)).filter((columns) => columns[0] && columns[0] !== "lo");
  const ipv6Interfaces = (await fs.readFile("/proc/net/if_inet6", "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map((line) => line.trim().split(/\s+/).at(-1)).filter((name) => name !== "lo");

  assert.equal(nonLoopback.length, 0, "the agent has a non-loopback network interface");
  assert.equal(routes.length, 0, "the agent has an IPv4 route outside loopback");
  assert.equal(ipv6Interfaces.length, 0, "the agent has an IPv6 interface outside loopback");
  assert.equal(attempts.some((attempt) => attempt.connected || attempt.code === "ECONNREFUSED"), false,
    "a direct IPv4/IPv6 target was reachable or returned an active refusal");
  assert.equal(dnsResults.some((result) => result.resolved), false, "DNS resolved from the isolated agent");
  return {
    interfaceCount: interfaces.length,
    directTargets: attempts.length,
    directBlocked: attempts.length,
    dnsNames: dnsResults.length,
    dnsBlocked: dnsResults.length,
  };
}

async function main() {
  assert.equal(process.getuid(), 10001, "unexpected effective UID");
  assert.equal(process.getgid(), 10001, "unexpected effective GID");
  const procStatus = statusFields(await fs.readFile("/proc/self/status", "utf8"));
  assert.equal(procStatus.CapEff, "0000000000000000", "effective Linux capabilities are present");
  for (const field of ["CapInh", "CapPrm", "CapBnd", "CapAmb"]) {
    assert.equal(procStatus[field], "0000000000000000", `${field} Linux capabilities are present`);
  }
  assert.equal(procStatus.NoNewPrivs, "1", "no_new_privs is not active");
  assert.equal(procStatus.Seccomp, "2", "the default seccomp filter is not active");

  const namespaces = await namespaceIds();
  for (const name of ["pid", "net", "mnt", "ipc", "uts"]) {
    assert.notEqual(namespaces[name], input.referenceNamespaces[name], `${name} namespace is shared with a peer`);
  }

  const cgroups = {
    memory: (await fs.readFile("/sys/fs/cgroup/memory.max", "utf8")).trim(),
    cpu: (await fs.readFile("/sys/fs/cgroup/cpu.max", "utf8")).trim(),
    pids: (await fs.readFile("/sys/fs/cgroup/pids.max", "utf8")).trim(),
  };
  assert.equal(cgroups.memory, String(input.limits.memoryBytes), "effective cgroup memory limit differs");
  assert.deepEqual(cgroups.cpu.split(/\s+/), [String(input.limits.nanoCpus / 10_000), "100000"],
    "effective cgroup CPU quota differs");
  assert.equal(cgroups.pids, String(input.limits.pids), "effective cgroup PID limit differs");

  await assert.rejects(() => fs.writeFile("/qualification-root-write", "probe"),
    (error) => ["EROFS", "EACCES", "EPERM"].includes(error.code));
  await assert.rejects(() => fs.writeFile("/workspace/qualification-write", "probe"),
    (error) => ["EROFS", "EACCES", "EPERM"].includes(error.code));
  const unavailablePaths = ["/var/run/docker.sock", "/run/secrets", "/root/.ssh", "/root/.aws", "/Users"];
  for (const path of unavailablePaths) {
    await assert.rejects(() => fs.access(path), undefined, `${path} is unexpectedly accessible`);
  }
  const sensitiveEnvironment = Object.keys(process.env).filter((name) =>
    /(?:github|token|secret|credential|private.?key|aws)/i.test(name));
  assert.deepEqual(sensitiveEnvironment, [], "credential-like environment variables are visible");
  const network = await networkEvidence();

  const report = {
    uid: process.getuid(),
    gid: process.getgid(),
    capabilitySets: Object.fromEntries(["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]
      .map((field) => [field, procStatus[field]])),
    noNewPrivs: procStatus.NoNewPrivs,
    seccomp: procStatus.Seccomp,
    namespaces: Object.keys(namespaces).filter((name) => name !== "user"),
    cgroups,
    rootfsReadOnly: true,
    snapshotReadOnly: true,
    socketAndSecretPathsUnavailable: unavailablePaths.length,
    credentialEnvironmentVariables: 0,
    network,
  };
  process.stdout.write(`JV007_QUALIFICATION ${JSON.stringify(report)}\n`);
  while (true) await delay(60_000);
}

if (process.env.JV007_WITNESS === "true") {
  const server = await import("node:http").then(({ createServer }) => createServer((_request, response) => {
    response.end("synthetic internal-network witness\n");
  }));
  server.listen(8181, "0.0.0.0", () => process.stdout.write("JV007_WITNESS_READY\n"));
} else {
  await main();
}
