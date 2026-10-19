import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockerEngineClient } from "../dist/docker-engine.js";

async function withEngine(handler, run) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-engine-test-"));
  const socketPath = join(directory, "engine.sock");
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => handler(request, response, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await run(new DockerEngineClient({ socketPath, apiVersion: "1.54" }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test("maps the closed container request to a least-privilege Docker Engine payload", async () => {
  let requestPath;
  let payload;
  const labels = {
    "jarvis.managed": "true",
    task_id: "task-123",
    attempt_id: "attempt-456",
    expires_at: "2026-10-19T00:20:00.000Z",
    sandbox_id: "00000000-0000-4000-8000-000000000001",
    profile_id: "plan-readonly-v1",
  };

  await withEngine((request, response, body) => {
    if (request.method === "POST") {
      requestPath = request.url;
      payload = JSON.parse(body);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ Id: "engine-container-id" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      Id: "engine-container-id",
      Config: { Labels: payload.Labels },
      State: { Status: "created" },
    }));
  }, async (engine) => {
    const result = await engine.createContainer({
      name: "jarvis-sandbox-00000000-0000-4000-8000-000000000001",
      image: `registry.example.invalid/jarvis/plan@sha256:${"a".repeat(64)}`,
      platform: "linux/arm64",
      entrypoint: ["/usr/local/bin/jarvis-sandbox"],
      user: "10001:10001",
      labels,
      networkMode: "none",
      readOnlyRootfs: true,
      privileged: false,
      capDrop: ["ALL"],
      securityOptions: ["no-new-privileges:true"],
      memoryBytes: 4 * 1024 ** 3,
      nanoCpus: 2_000_000_000,
      pidsLimit: 256,
      mounts: [
        { type: "volume", source: "jarvis-work-a", target: "/workspace", readOnly: true },
        { type: "volume", source: "jarvis-state-a", target: "/state", readOnly: false },
      ],
    });
    assert.equal(result.id, "engine-container-id");
  });

  assert.match(requestPath, /^\/v1\.54\/containers\/create\?/);
  assert.match(requestPath, /platform=linux%2Farm64/);
  assert.equal(payload.Image, `registry.example.invalid/jarvis/plan@sha256:${"a".repeat(64)}`);
  assert.equal(payload.User, "10001:10001");
  assert.deepEqual(payload.Labels, labels);
  assert.equal(payload.HostConfig.NetworkMode, "none");
  assert.equal(payload.HostConfig.ReadonlyRootfs, true);
  assert.equal(payload.HostConfig.Privileged, false);
  assert.deepEqual(payload.HostConfig.CapDrop, ["ALL"]);
  assert.equal(payload.HostConfig.PidsLimit, 256);
  assert.equal(payload.HostConfig.Binds, undefined);
  assert.equal(payload.HostConfig.Devices, undefined);
  assert.equal(payload.HostConfig.PidMode, undefined);
  assert.equal(payload.HostConfig.IpcMode, undefined);
  assert.equal(payload.HostConfig.PortBindings, undefined);
});

test("refuses to delete a volume with foreign ownership labels", async () => {
  let deletes = 0;
  await withEngine((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ Name: "jarvis-state-a", Labels: { "jarvis.managed": "true", task_id: "other" } }));
      return;
    }
    deletes += 1;
    response.writeHead(204);
    response.end();
  }, async (engine) => {
    await assert.rejects(() => engine.removeVolume("jarvis-state-a", {
      "jarvis.managed": "true",
      task_id: "task-123",
    }), /labels do not match/i);
  });
  assert.equal(deletes, 0);
});

test("recovers managed container and volume identities using label-filtered Engine calls", async () => {
  const labels = {
    "jarvis.managed": "true",
    task_id: "task-123",
    attempt_id: "attempt-456",
    expires_at: "2026-10-19T00:20:00.000Z",
    sandbox_id: "00000000-0000-4000-8000-000000000001",
    profile_id: "plan-readonly-v1",
    snapshot_id: "a".repeat(40),
    model_profile_id: "model-profile-v1",
    lease_epoch: "1",
    resource_kind: "container",
  };
  let containerPath;
  let volumePath;
  await withEngine((request, response) => {
    if (request.url.startsWith("/v1.54/containers/json")) {
      containerPath = request.url;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ Id: "engine-container-id", State: "running", Labels: labels }]));
      return;
    }
    volumePath = request.url;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ Volumes: [{ Name: "jarvis-work-id", Labels: { ...labels, resource_kind: "workspace" } }] }));
  }, async (engine) => {
    assert.deepEqual(await engine.listManagedContainers(), [{
      id: "engine-container-id", state: "running", labels,
    }]);
    assert.deepEqual(await engine.listManagedVolumes(), [{
      name: "jarvis-work-id", labels: { ...labels, resource_kind: "workspace" },
    }]);
  });
  assert.match(containerPath, /filters=/);
  assert.match(volumePath, /filters=/);
});
