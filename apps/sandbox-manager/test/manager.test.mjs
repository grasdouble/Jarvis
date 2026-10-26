import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import * as sandboxManager from "../dist/index.js";

test("exports the restricted sandbox-manager factory", () => {
  assert.equal(typeof sandboxManager.createSandboxManager, "function");
});

test("manager configuration factory wires a closed trusted gateway/filter profile into lifecycle creation", async () => {
  const engine = engineFake();
  const configured = sandboxManager.createSandboxManagerFromConfiguration({
    engine,
    profiles: [profile],
    now: () => new Date("2026-10-19T00:00:00.000Z"),
    gatewayFilterConfig: {
      gatewayImage: `registry.example.invalid/jarvis/gateway@sha256:${"b".repeat(64)}`,
      filterImage: `registry.example.invalid/jarvis/filter@sha256:${"c".repeat(64)}`,
      providerId: "inactive", model: "synthetic-model", platform: "linux/arm64",
    },
    createCapability: () => "d".repeat(64),
  });
  await configured.create(spec, "idempotency-main-config");
  assert.equal(engine.calls.some(([kind, input]) => kind === "createContainer" && input.labels.resource_kind === "filter"), true);
  const inactiveEngine = engineFake();
  const inactive = sandboxManager.createSandboxManagerFromConfiguration({
    engine: inactiveEngine, profiles: [profile], now: () => new Date("2026-10-19T00:00:00.000Z"),
  });
  await inactive.create(spec, "idempotency-main-config-absent");
  assert.equal(inactiveEngine.calls.some(([kind, input]) => kind === "createContainer" &&
    ["gateway", "filter"].includes(input.labels.resource_kind)), false);
  assert.throws(() => sandboxManager.parseTrustedGatewayFilterConfig({
    gatewayImage: "example.invalid/gateway:latest", providerKey: "must-not-be-accepted",
  }), /unknown|immutable|invalid/i);
});

test("builds deterministic per-attempt filter and gateway config archives, both disabled by default", () => {
  assert.equal(typeof sandboxManager.createAttemptConfigArchive, "function");
  const capability = "a".repeat(64);
  const archive = sandboxManager.createAttemptConfigArchive(capability);
  assert.ok(archive instanceof Uint8Array);
  const header = Buffer.from(archive.subarray(0, 512));
  assert.equal(header.toString("utf8", 0, 100).replace(/\0.*$/s, ""), "egress.json");
  const size = Number.parseInt(header.toString("ascii", 124, 136).replace(/\0.*$/s, "").trim(), 8);
  const config = JSON.parse(Buffer.from(archive.subarray(512, 512 + size)).toString("utf8"));
  assert.deepEqual(config, {
    providers: [],
    dispatch_enabled: false,
    filterCapability: capability,
  });
  const gatewayHeader = Buffer.from(archive.subarray(1024, 1536));
  assert.equal(gatewayHeader.toString("utf8", 0, 100).replace(/\0.*$/s, ""), "gateway.json");
  const gatewaySize = Number.parseInt(gatewayHeader.toString("ascii", 124, 136).replace(/\0.*$/s, "").trim(), 8);
  assert.deepEqual(JSON.parse(Buffer.from(archive.subarray(1536, 1536 + gatewaySize)).toString()), {
    dispatch_enabled: false, providerId: "inactive", model: "inactive",
    filterHost: "jarvis-egress-filter-00000000-0000-4000-8000-000000000000", filterPort: 8080,
  });
  assert.deepEqual(sandboxManager.createAttemptConfigArchive(capability), archive);
  const socketArchive = sandboxManager.createGatewaySocketArchive();
  const socketHeader = Buffer.from(socketArchive.subarray(0, 512));
  assert.equal(socketHeader.toString("utf8", 0, 100).replace(/\0.*$/s, ""), "jarvis/");
  assert.equal(Number.parseInt(socketHeader.toString("ascii", 100, 108).replace(/\0.*$/s, "").trim(), 8), 0o770);
  assert.equal(Number.parseInt(socketHeader.toString("ascii", 108, 116).replace(/\0.*$/s, "").trim(), 8), 10001);
});

const profile = {
  id: "plan-readonly-v1",
  image: `registry.example.invalid/jarvis/plan@sha256:${"a".repeat(64)}`,
  platform: "linux/arm64",
  memoryBytes: 4 * 1024 ** 3,
  nanoCpus: 2_000_000_000,
  pidsLimit: 256,
  maxDurationMs: 30 * 60 * 1000,
  readOnlyWorkspace: true,
};

function engineFake() {
  const calls = [];
  const containers = new Map();
  const volumes = new Map();
  const networks = new Map();
  return {
    calls,
    async createVolume(input) {
      calls.push(["createVolume", input]);
      volumes.set(input.name, { name: input.name, labels: input.labels });
      return { name: input.name, labels: input.labels };
    },
    async createContainer(input) {
      calls.push(["createContainer", input]);
      const id = `engine-${input.labels.resource_kind}`;
      containers.set(id, { id, state: "created", labels: input.labels });
      return containers.get(id);
    },
    async listManagedContainers() {
      return [...containers.values()];
    },
    async listManagedVolumes() {
      return [...volumes.values()];
    },
    async listManagedNetworks() { return [...networks.values()]; },
    async startContainer(id) { calls.push(["startContainer", id]); if (containers.has(id)) containers.get(id).state = "running"; },
    async inspectContainer(id) {
      calls.push(["inspectContainer", id]);
      if (!containers.has(id)) { const labels = calls.filter(([kind]) => kind === "createContainer").map(([, input]) => input.labels).find((item) => `engine-${item.resource_kind}` === id); return { id, state: "running", labels }; }
      return containers.get(id);
    },
    async stopContainer(id) { calls.push(["stopContainer", id]); },
    async removeContainer(id) { calls.push(["removeContainer", id]); containers.delete(id); },
    async removeVolume(name) { calls.push(["removeVolume", name]); volumes.delete(name); },
    async createNetwork(input) { calls.push(["createNetwork", input]); const result = { id: `network-${input.labels.resource_kind}`, name: input.name, labels: input.labels, containerIds: [] }; networks.set(result.id, result); return result; },
    async connectNetwork(networkId, containerId, labels) { calls.push(["connectNetwork", networkId, containerId, labels]); networks.get(networkId)?.containerIds.push(containerId); },
    async disconnectNetwork(networkId, containerId) { calls.push(["disconnectNetwork", networkId, containerId]); },
    async removeNetwork(id, labels) { calls.push(["removeNetwork", id, labels]); networks.delete(id); },
    async putContainerArchive(id, destination, archive) { calls.push(["putContainerArchive", id, destination, archive]); },
  };
}

const spec = {
  taskId: "task-123",
  attemptId: "attempt-456",
  snapshotId: "a".repeat(40),
  profileId: "plan-readonly-v1",
  modelProfileId: "model-profile-v1",
  deadline: "2026-10-19T00:20:00.000Z",
  leaseEpoch: 1,
};

function manager(engine, extra = {}) {
  return sandboxManager.createSandboxManager({
    engine,
    profiles: [profile],
    now: () => new Date("2026-10-19T00:00:00.000Z"),
    ...extra,
  });
}

test("creates only profile-derived, isolated resources with generated ownership metadata", async () => {
  const engine = engineFake();
  const service = manager(engine);
  const result = await service.create(spec, "idempotency-1");
  const container = engine.calls.find(([kind]) => kind === "createContainer")[1];
  const volumes = engine.calls.filter(([kind]) => kind === "createVolume").map(([, value]) => value);

  assert.match(result.sandboxId, /^[0-9a-f-]{36}$/i);
  assert.equal(container.image, profile.image);
  assert.equal(container.networkMode, "none");
  assert.equal(container.privileged, false);
  assert.deepEqual(container.capDrop, ["ALL"]);
  assert.equal(container.memoryBytes, profile.memoryBytes);
  assert.equal(container.nanoCpus, profile.nanoCpus);
  assert.equal(container.pidsLimit, profile.pidsLimit);
  assert.equal(container.user, "10001:10001");
  assert.equal(container.command, undefined);
  assert.equal(container.hostConfig, undefined);
  assert.equal(volumes.length, 2);
  for (const resource of [container, ...volumes]) {
    assert.equal(resource.labels["jarvis.managed"], "true");
    assert.equal(resource.labels.task_id, spec.taskId);
    assert.equal(resource.labels.attempt_id, spec.attemptId);
    assert.equal(resource.labels.expires_at, spec.deadline);
  }
  assert.notEqual(result.sandboxId, "engine-container-id");
});

test("creates the per-attempt config and gateway/filter graph in fail-closed order", async () => {
  const engine = engineFake();
  const service = manager(engine, {
    createId: () => "00000000-0000-4000-8000-000000000251",
    createCapability: () => "c".repeat(64),
    gatewayFilter: {
      gatewayImage: `registry.example.invalid/jarvis/gateway@sha256:${"b".repeat(64)}`,
      filterImage: `registry.example.invalid/jarvis/filter@sha256:${"c".repeat(64)}`,
      providerId: "inactive", model: "synthetic-model", platform: "linux/arm64",
    },
  });
  await service.create(spec, "idempotency-gateway-graph");
  const writer = engine.calls.find(([kind, input]) => kind === "createContainer" && input?.labels?.resource_kind === "config-writer")[1];
  const filter = engine.calls.find(([kind, input]) => kind === "createContainer" && input?.labels?.resource_kind === "filter")[1];
  const gateway = engine.calls.find(([kind, input]) => kind === "createContainer" && input?.labels?.resource_kind === "gateway")[1];
  const sandbox = engine.calls.find(([kind, input]) => kind === "createContainer" && input?.labels?.resource_kind === "container")[1];
  const archiveCall = engine.calls.find(([kind]) => kind === "putContainerArchive");
  const connections = engine.calls.filter(([kind]) => kind === "connectNetwork");
  const starts = engine.calls.map(([kind, id]) => [kind, id]).filter(([kind]) => kind === "startContainer");
  assert.deepEqual(JSON.parse(Buffer.from(archiveCall[3]).subarray(512, 512 + Number.parseInt(Buffer.from(archiveCall[3]).toString("ascii", 124, 136).replace(/\0.*$/s, "").trim(), 8)).toString()), {
    providers: [], dispatch_enabled: false, filterCapability: "c".repeat(64),
  });
  assert.equal(writer.mounts[0].readOnly, false);
  assert.equal(filter.mounts[0].readOnly, true);
  assert.equal(gateway.mounts[0].readOnly, true);
  assert.equal(sandbox.networkMode, "none");
  assert.equal(writer.environment, undefined);
  assert.equal(gateway.environment.LLM_GATEWAY_ATTEMPT_CAPABILITY, undefined);
  assert.deepEqual(connections.map(([, , containerId]) => containerId), [
    "engine-filter", "engine-filter", "engine-gateway",
  ]);
  assert.equal(connections.some(([, networkId, containerId]) => networkId === "network-provider-network" && containerId !== "engine-filter"), false);
  assert.equal(engine.calls.findIndex(([kind]) => kind === "putContainerArchive") < engine.calls.findIndex(([, input]) => input?.labels?.resource_kind === "filter"), true);
  assert.deepEqual(starts.map(([, id]) => id), ["engine-config-writer", "engine-config-writer", "engine-filter", "engine-gateway", "engine-container"]);
  assert.equal(engine.calls.findIndex(([kind, id]) => kind === "startContainer" && id === "engine-config-writer") < engine.calls.findIndex(([kind]) => kind === "putContainerArchive"), true);
  assert.equal(engine.calls.findIndex(([kind]) => kind === "putContainerArchive") < engine.calls.findIndex(([kind, id]) => kind === "removeContainer" && id === "engine-config-writer"), true);
});

test("rolls back setup failures and preserves uncertain config volumes until recovery reconciles them", async () => {
  const engine = engineFake();
  const originalArchive = engine.putContainerArchive;
  engine.putContainerArchive = async (...args) => { await originalArchive(...args); throw new Error("lost archive response"); };
  const service = manager(engine, {
    gatewayFilter: {
      gatewayImage: `registry.example.invalid/jarvis/gateway@sha256:${"b".repeat(64)}`,
      filterImage: `registry.example.invalid/jarvis/filter@sha256:${"c".repeat(64)}`,
      providerId: "inactive", model: "synthetic-model", platform: "linux/arm64",
    },
  });
  await assert.rejects(() => service.create(spec, "idempotency-setup-failure"), /creation failed/i);
  assert.equal(engine.calls.some(([kind]) => kind === "removeNetwork"), true);
  assert.equal(engine.calls.some(([kind, name]) => kind === "removeVolume" && String(name).includes("egress-config")), false);
  assert.equal(engine.calls.some(([kind, id]) => kind === "removeContainer" && id === "engine-config-writer"), true);
  await service.recover();
  assert.equal(engine.calls.some(([kind]) => kind === "removeVolume"), true);
});

test("recovers gateway/filter resources from labels and destroys each attempt resource idempotently", async () => {
  const engine = engineFake();
  const gatewayFilter = {
    gatewayImage: `registry.example.invalid/jarvis/gateway@sha256:${"b".repeat(64)}`,
    filterImage: `registry.example.invalid/jarvis/filter@sha256:${"c".repeat(64)}`,
    providerId: "inactive", model: "synthetic-model", platform: "linux/arm64",
  };
  const first = manager(engine, { gatewayFilter });
  const created = await first.create(spec, "idempotency-before-gateway-restart");
  const restarted = manager(engine, { gatewayFilter });
  await restarted.recover();
  assert.equal((await restarted.inspect(created.sandboxId)).state, "running");
  await restarted.destroy(created.sandboxId, 1);
  await restarted.destroy(created.sandboxId, 1);
  assert.equal(engine.calls.some(([kind, name]) => kind === "removeVolume" && String(name).includes("egress-config")), true);
  assert.equal(engine.calls.some(([kind]) => kind === "removeNetwork"), true);
  assert.equal(engine.calls.filter(([kind]) => kind === "removeContainer").length, 5);
  const configRemoval = engine.calls.findIndex(([kind, name]) => kind === "removeVolume" && String(name).includes("egress-config"));
  const lastContainerRemoval = engine.calls.map(([kind], index) => kind === "removeContainer" ? index : -1).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(configRemoval > lastContainerRemoval, "attempt config volume is deleted after all attached containers");
});

test("retries cleanup after a network failure without deleting config volume before containers", async () => {
  const engine = engineFake();
  const removeNetwork = engine.removeNetwork;
  let failOnce = true;
  engine.removeNetwork = async (...args) => {
    if (failOnce) { failOnce = false; throw new Error("synthetic network removal failure"); }
    return removeNetwork(...args);
  };
  const service = manager(engine, {
    gatewayFilter: {
      gatewayImage: `registry.example.invalid/jarvis/gateway@sha256:${"b".repeat(64)}`,
      filterImage: `registry.example.invalid/jarvis/filter@sha256:${"c".repeat(64)}`,
      providerId: "inactive", model: "synthetic-model", platform: "linux/arm64",
    },
  });
  const created = await service.create(spec, "idempotency-cleanup-retry");
  await assert.rejects(() => service.destroy(created.sandboxId, 1), /cleanup|failure/i);
  assert.equal(engine.calls.some(([kind, name]) => kind === "removeVolume" && String(name).includes("egress-config")), false);
  await service.destroy(created.sandboxId, 1);
  assert.equal(engine.calls.some(([kind, name]) => kind === "removeVolume" && String(name).includes("egress-config")), true);
});

test("refuses sidecar cleanup after ownership labels diverge and succeeds after trusted reconciliation", async () => {
  const engine = engineFake();
  const service = manager(engine, {
    gatewayFilter: {
      gatewayImage: `registry.example.invalid/jarvis/gateway@sha256:${"b".repeat(64)}`,
      filterImage: `registry.example.invalid/jarvis/filter@sha256:${"c".repeat(64)}`,
      providerId: "inactive", model: "synthetic-model", platform: "linux/arm64",
    },
  });
  const created = await service.create(spec, "idempotency-label-mismatch");
  const inspect = engine.inspectContainer.bind(engine);
  let mismatch = true;
  engine.inspectContainer = async (id) => {
    const result = await inspect(id);
    return mismatch && id === "engine-filter" ? { ...result, labels: { ...result.labels, attempt_id: "foreign-attempt" } } : result;
  };
  await assert.rejects(() => service.destroy(created.sandboxId, 1), /labels do not match/i);
  assert.equal(engine.calls.some(([kind, name]) => kind === "removeVolume" && String(name).includes("egress-config")), false);
  mismatch = false;
  await service.destroy(created.sandboxId, 1);
});

test("cancels and expires gateway/filter sidecars with the attempt while preserving the sandbox network mode", async () => {
  const engine = engineFake();
  let current = new Date("2026-10-19T00:00:00.000Z");
  const service = manager(engine, {
    now: () => current,
    gatewayFilter: {
      gatewayImage: `registry.example.invalid/jarvis/gateway@sha256:${"b".repeat(64)}`,
      filterImage: `registry.example.invalid/jarvis/filter@sha256:${"c".repeat(64)}`,
      providerId: "inactive", model: "synthetic-model", platform: "linux/arm64",
    },
  });
  const created = await service.create(spec, "idempotency-gateway-expire");
  const setupCallCount = engine.calls.length;
  await service.cancel(created.sandboxId, 1);
  const stopped = engine.calls.slice(setupCallCount).filter(([kind]) => kind === "stopContainer").map(([, id]) => id);
  assert.deepEqual(stopped, ["engine-container", "engine-gateway", "engine-filter"]);
  await service.cancel(created.sandboxId, 1);
  assert.equal(engine.calls.find(([, input]) => input?.labels?.resource_kind === "container")[1].networkMode, "none");
  current = new Date(spec.deadline);
  assert.equal(await service.expire(), 1);
  assert.equal(engine.calls.some(([kind]) => kind === "removeNetwork"), true);
  assert.equal(engine.calls.some(([kind, name]) => kind === "removeVolume" && String(name).includes("egress-config")), true);
});

test("rejects unknown fields and caller-supplied resource controls before engine access", async () => {
  const engine = engineFake();
  const service = manager(engine);

  await assert.rejects(() => service.create({ ...spec, image: profile.image }, "idempotency-1"), /unknown.*field/i);
  await assert.rejects(() => service.create({ ...spec, command: ["sh"] }, "idempotency-cmd"), /unknown.*field/i);
  await assert.rejects(() => service.create({ ...spec, privileged: true }, "idempotency-priv"), /unknown.*field/i);
  await assert.rejects(() => service.create({ ...spec, containerId: "engine-container-id" }, "idempotency-id"), /unknown.*field/i);
  await assert.rejects(() => service.create({ ...spec, hostPath: "/Users/owner" }, "idempotency-2"), /unknown.*field/i);
  await assert.rejects(() => service.create({ ...spec, networkMode: "host" }, "idempotency-3"), /unknown.*field/i);
  await assert.rejects(() => service.create({ ...spec, profileId: "arbitrary" }, "idempotency-4"), /profile/i);
  assert.deepEqual(engine.calls, []);
});

test("limits deadlines to the profile and cleans only managed resources", async () => {
  const engine = engineFake();
  const service = manager(engine);

  await assert.rejects(() => service.create({ ...spec, deadline: "2026-10-20T00:00:00.000Z" }, "idempotency-1"), /deadline/i);
  assert.deepEqual(engine.calls, []);

  const result = await service.create(spec, "idempotency-2");
  await service.destroy(result.sandboxId, 1);
  assert.equal(engine.calls.some(([kind]) => /prune/i.test(kind)), false);
  assert.equal(engine.calls.filter(([kind]) => kind === "removeContainer").length, 1);
  assert.equal(engine.calls.filter(([kind]) => kind === "removeVolume").length, 2);
});

test("reconciles idempotent retries and rejects key reuse for a different request", async () => {
  const engine = engineFake();
  const service = manager(engine);
  const first = await service.create(spec, "idempotency-replay");
  const second = await service.create(spec, "idempotency-replay");

  assert.deepEqual(second, first);
  assert.equal(engine.calls.filter(([kind]) => kind === "createContainer").length, 1);
  await assert.rejects(
    () => service.create({ ...spec, attemptId: "attempt-other" }, "idempotency-replay"),
    /different sandbox request/i,
  );
});

test("binds cancellation and destruction to the active lease epoch", async () => {
  const engine = engineFake();
  const service = manager(engine);
  const created = await service.create(spec, "idempotency-lease");

  await assert.rejects(() => service.cancel(created.sandboxId, 2), /lease epoch/i);
  assert.equal(engine.calls.some(([kind]) => kind === "stopContainer"), false);
  assert.equal((await service.inspect(created.sandboxId)).state, "running");
  await service.cancel(created.sandboxId, 1);
  assert.equal(engine.calls.filter(([kind]) => kind === "stopContainer").length, 1);
});

test("routes only fixed OpenCode relay operations through the matching sandbox lease", async () => {
  const engine = engineFake();
  engine.relayOpenCode = async (containerId, request) => {
    engine.calls.push(["relayOpenCode", containerId, request]);
    return { operation: request.operation };
  };
  const service = manager(engine);
  const created = await service.create(spec, "idempotency-relay");

  const requests = [
    { operation: "health" },
    { operation: "session.create", title: "synthetic" },
    { operation: "prompt", sessionID: "session_1", text: "synthetic prompt" },
    { operation: "messages", sessionID: "session_1" },
    { operation: "status", sessionID: "session_1" },
    { operation: "cancel", sessionID: "session_1" },
  ];
  for (const request of requests) assert.deepEqual(await service.runtime(created.sandboxId, 1, spec.taskId, spec.attemptId, request), { operation: request.operation });
  await assert.rejects(() => service.runtime(created.sandboxId, 2, spec.taskId, spec.attemptId, { operation: "health" }), /lease epoch/i);
  await assert.rejects(() => service.runtime(created.sandboxId, 1, "other-task", spec.attemptId, { operation: "health" }), /identity/i);
  await assert.rejects(() => service.runtime(created.sandboxId, 1, spec.taskId, spec.attemptId, { operation: "exec", command: "id" }), /operation|field/i);
  await assert.rejects(() => service.runtime(created.sandboxId, 1, spec.taskId, spec.attemptId, { operation: "health", url: "http://example.invalid" }), /field/i);
  assert.deepEqual(engine.calls.filter(([kind]) => kind === "relayOpenCode").map(([, , request]) => request), [
    ...requests,
  ]);
});

test("expires only due attempts from its ownership registry", async () => {
  const engine = engineFake();
  let currentTime = new Date("2026-10-19T00:00:00.000Z");
  const service = manager(engine, { now: () => currentTime });
  const created = await service.create(spec, "idempotency-expiry");

  assert.equal(await service.expire(), 0);
  currentTime = new Date(spec.deadline);
  assert.equal(await service.expire(), 1);
  await assert.rejects(() => service.inspect(created.sandboxId), /not found/i);
  assert.equal(engine.calls.some(([kind]) => /prune/i.test(kind)), false);
});

test("rejects an unpinned or malformed trusted profile at manager construction", () => {
  const engine = engineFake();
  assert.throws(() => manager(engine, {
    profiles: [{ ...profile, image: "registry.example.invalid/jarvis/plan:latest" }],
  }), /immutable image digest/i);
});

test("rejects profile quotas that exceed the selected one-sandbox resource envelope", () => {
  const engine = engineFake();
  assert.throws(() => manager(engine, {
    profiles: [{ ...profile, memoryBytes: 5 * 1024 ** 3 }],
  }), /memory limit/i);
  assert.throws(() => manager(engine, {
    profiles: [{ ...profile, nanoCpus: 3_000_000_000 }],
  }), /CPU limit/i);
  assert.throws(() => manager(engine, {
    profiles: [{ ...profile, maxDurationMs: 31 * 60 * 1000 }],
  }), /duration limit/i);
});

test("recovers a live attempt from ownership labels after a manager restart", async () => {
  const engine = engineFake();
  const firstProcess = manager(engine);
  const created = await firstProcess.create(spec, "idempotency-before-restart");
  const restartedProcess = manager(engine);

  await restartedProcess.recover();
  assert.equal((await restartedProcess.inspect(created.sandboxId)).state, "running");
  assert.deepEqual(
    await restartedProcess.create(spec, "idempotency-after-restart"),
    { ...created, state: "running" },
  );
  assert.equal(engine.calls.filter(([kind]) => kind === "createContainer").length, 1);
});

test("enforces the one-sandbox capacity before creating a second attempt", async () => {
  const engine = engineFake();
  const service = manager(engine);
  await service.create(spec, "idempotency-capacity-1");

  await assert.rejects(
    () => service.create({ ...spec, attemptId: "attempt-next" }, "idempotency-capacity-2"),
    /capacity is exhausted/i,
  );
  assert.equal(engine.calls.filter(([kind]) => kind === "createContainer").length, 1);
});

test("reserves capacity while the first sandbox creation is still in flight", async () => {
  const engine = engineFake();
  let releaseVolume;
  const firstVolume = new Promise((resolve) => { releaseVolume = resolve; });
  const createVolume = engine.createVolume.bind(engine);
  engine.createVolume = async (input) => {
    if (!engine.calls.some(([kind]) => kind === "createVolume")) await firstVolume;
    return createVolume(input);
  };
  const service = manager(engine);
  const first = service.create(spec, "idempotency-race-1");

  await assert.rejects(
    () => service.create({ ...spec, attemptId: "attempt-race" }, "idempotency-race-2"),
    /capacity is exhausted/i,
  );
  releaseVolume();
  await first;
  assert.equal(engine.calls.filter(([kind]) => kind === "createContainer").length, 1);
});

test("retains uncertain resources after a lost create response for label-based reconciliation", async () => {
  const engine = engineFake();
  engine.createContainer = async (input) => {
    engine.calls.push(["createContainer", input]);
    throw new Error("simulated lost Docker Engine response");
  };
  engine.listManagedContainers = async () => [];
  const service = manager(engine);

  await assert.rejects(() => service.create(spec, "idempotency-lost-container"), /Sandbox creation failed/i);
  assert.equal(engine.calls.filter(([kind]) => kind === "removeVolume").length, 0);
  await service.recover();
  assert.equal(engine.calls.filter(([kind]) => kind === "removeVolume").length, 2);
  assert.equal(engine.calls.some(([kind]) => /prune/i.test(kind)), false);
});

test("trusted filter accepts only the fixed allowlisted HTTPS provider route", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const filterPath = resolve(testDir, "../../../infra/llm-egress-filter/filter.py");
  const python = String.raw`
import base64, importlib.util, json
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("filter", ${JSON.stringify(filterPath)})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
config = {"providers": [], "dispatch_enabled": False, "filterCapability": "c" * 64}
with patch.object(module.Path, "read_text", lambda _self: json.dumps(config)):
    empty, capability = module.load_allowlist()
assert empty == {} and capability == "c" * 64
with patch.object(module.Path, "read_text", lambda _self: json.dumps({**config, "providers": [{"id":"synthetic"}]})):
    try: module.load_allowlist()
    except ValueError: pass
    else: raise AssertionError("non-empty provider configuration must be denied")
calls = []
class Response:
    status = 200
    def getheader(self, name, default=None): return "application/json" if name == "content-type" else default
    def read(self, size): return b'{"ok":true}'
class Connection:
    def __init__(self, host, port, timeout): calls.append(["connect", host, port, timeout])
    def request(self, method, path, body, headers): calls.append(["request", method, path, body.decode(), headers["authorization"]])
    def getresponse(self): return Response()
    def close(self): calls.append(["close"])
providers = {"synthetic": {"id":"synthetic", "host":"provider.invalid", "port":443, "protocol":"https", "route":module.ROUTE, "api_key":"synthetic-only"}}
result = module.dispatch("synthetic", module.ROUTE, base64.b64encode(b'{"model":"fixture"}').decode(), providers, Connection)
assert result == (200, "application/json", b'{"ok":true}')
assert calls[0] == ["connect", "provider.invalid", 443, 30]
assert calls[1][1:4] == ["POST", module.ROUTE, '{"model":"fixture"}']
assert calls[1][4] == "Bearer synthetic-only"
before = len(calls)
try: module.dispatch("synthetic", "/v1/other", "e30=", providers, Connection)
except ValueError: pass
else: raise AssertionError("unknown route was accepted")
try: module.dispatch("other", module.ROUTE, "e30=", providers, Connection)
except PermissionError: pass
else: raise AssertionError("unknown provider was accepted")
assert len(calls) == before, "denied requests must not contact any destination"
print(json.dumps({"calls":calls}))
`;
  const result = spawnSync("python3", ["-c", python], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
