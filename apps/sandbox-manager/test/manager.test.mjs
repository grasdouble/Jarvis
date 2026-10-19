import assert from "node:assert/strict";
import test from "node:test";

import * as sandboxManager from "../dist/index.js";

test("exports the restricted sandbox-manager factory", () => {
  assert.equal(typeof sandboxManager.createSandboxManager, "function");
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
  return {
    calls,
    async createVolume(input) {
      calls.push(["createVolume", input]);
      return { name: input.name, labels: input.labels };
    },
    async createContainer(input) {
      calls.push(["createContainer", input]);
      return { id: "engine-container-id", labels: input.labels };
    },
    async listManagedContainers() {
      return calls.filter(([kind]) => kind === "createContainer").map(([, input]) => ({
        id: "engine-container-id", state: "running", labels: input.labels,
      }));
    },
    async listManagedVolumes() {
      return calls.filter(([kind]) => kind === "createVolume").map(([, input]) => ({
        name: input.name, labels: input.labels,
      }));
    },
    async startContainer(id) { calls.push(["startContainer", id]); },
    async inspectContainer(id) {
      calls.push(["inspectContainer", id]);
      return { id, state: "running", labels: calls.find(([kind]) => kind === "createContainer")[1].labels };
    },
    async stopContainer(id) { calls.push(["stopContainer", id]); },
    async removeContainer(id) { calls.push(["removeContainer", id]); },
    async removeVolume(name) { calls.push(["removeVolume", name]); },
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
