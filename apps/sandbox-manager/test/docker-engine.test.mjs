import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockerEngineClient } from "../dist/docker-engine.js";

async function withEngine(handler, run, upgradeHandler) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-engine-test-"));
  const socketPath = join(directory, "engine.sock");
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => handler(request, response, Buffer.concat(chunks).toString("utf8")));
  });
  if (upgradeHandler) server.on("upgrade", upgradeHandler);
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

test("invokes only the fixed relay executable with framed operation input through Engine", async () => {
  let createPayload;
  let startContentLength;
  let relayInput = "";
  await withEngine((request, response, body) => {
    assert.equal(request.method, "POST");
    assert.match(request.url, /^\/v1\.54\/containers\/engine-container-id\/exec$/);
    createPayload = JSON.parse(body);
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ Id: "a".repeat(64) }));
  }, async (engine) => {
    assert.deepEqual(await engine.relayOpenCode("engine-container-id", { operation: "health" }), { healthy: true, version: "2.0.32" });
  }, (request, socket, head) => {
    assert.match(request.url, /^\/v1\.54\/exec\/[a-f0-9]{64}\/start$/);
    assert.equal(request.headers.upgrade, "tcp");
    assert.equal(request.headers["content-type"], "application/json");
    startContentLength = Number(request.headers["content-length"]);
    socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
    assert.deepEqual(JSON.parse(head.toString("utf8")), { Detach: false, Tty: true });
    let incoming = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      incoming = Buffer.concat([incoming, chunk]);
      const newline = incoming.indexOf(0x0a);
      if (newline >= 0) relayInput = incoming.subarray(0, newline).toString("utf8");
    });
    socket.on("end", () => { socket.end('{"healthy":true,"version":"2.0.32"}\n'); });
  });
  assert.deepEqual(createPayload.Cmd, ["/usr/local/bin/jarvis-opencode-relay"]);
  assert.equal(createPayload.Tty, true);
  assert.equal(startContentLength, Buffer.byteLength('{"Detach":false,"Tty":true}'));
  assert.deepEqual(JSON.parse(relayInput.trim()), { operation: "health" });
  assert.equal(createPayload.AttachStderr, false);
});

test("uploads only bounded archive bytes to the fixed manager config directory", async () => {
  let captured;
  const archive = Buffer.from("synthetic-tar-payload");
  await withEngine((request, response, body) => {
    captured = { method: request.method, url: request.url, type: request.headers["content-type"], body };
    response.writeHead(200);
    response.end();
  }, async (engine) => {
    assert.equal(typeof engine.putContainerArchive, "function");
    await engine.putContainerArchive("a".repeat(64), "/etc/jarvis", archive);
  });
  assert.deepEqual(captured, {
    method: "PUT",
    url: `/v1.54/containers/${"a".repeat(64)}/archive?path=%2Fetc%2Fjarvis`,
    type: "application/x-tar",
    body: archive.toString(),
  });
});

test("rejects archive destinations, identities and sizes outside the manager contract before Engine access", async () => {
  let requests = 0;
  await withEngine((_request, response) => {
    requests += 1;
    response.writeHead(200);
    response.end();
  }, async (engine) => {
    await assert.rejects(() => engine.putContainerArchive("not-an-engine-id", "/etc/jarvis", Buffer.from("x")), /invalid/i);
    await assert.rejects(() => engine.putContainerArchive("a".repeat(64), "/tmp", Buffer.from("x")), /invalid/i);
    await assert.rejects(() => engine.putContainerArchive("a".repeat(64), "/etc/jarvis", Buffer.alloc(64 * 1024 + 1)), /invalid/i);
  });
  assert.equal(requests, 0);
});

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
      environment: { LLM_GATEWAY_PROVIDER_ID: "synthetic", LLM_GATEWAY_MODEL: "synthetic-model" },
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
        { type: "volume", source: "jarvis-egress-config-a", target: "/etc/jarvis", readOnly: true },
      ],
    });
    assert.equal(result.id, "engine-container-id");
  });

  assert.match(requestPath, /^\/v1\.54\/containers\/create\?/);
  assert.match(requestPath, /platform=linux%2Farm64/);
  assert.equal(payload.Image, `registry.example.invalid/jarvis/plan@sha256:${"a".repeat(64)}`);
  assert.equal(payload.User, "10001:10001");
  assert.deepEqual(payload.Labels, labels);
  assert.deepEqual(payload.Env, ["LLM_GATEWAY_MODEL=synthetic-model", "LLM_GATEWAY_PROVIDER_ID=synthetic"]);
  assert.equal(payload.HostConfig.NetworkMode, "none");
  assert.equal(payload.HostConfig.ReadonlyRootfs, true);
  assert.equal(payload.HostConfig.Privileged, false);
  assert.deepEqual(payload.HostConfig.CapDrop, ["ALL"]);
  assert.equal(payload.HostConfig.PidsLimit, 256);
  assert.deepEqual(payload.HostConfig.Mounts[2], {
    Type: "volume", Source: "jarvis-egress-config-a", Target: "/etc/jarvis", ReadOnly: true,
  });
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

test("creates an internal attempt network and attaches only the trusted filter to provider egress", async () => {
  const requests = [];
  const labels = { "jarvis.managed": "true", task_id: "task-123", attempt_id: "attempt-456", resource_kind: "gateway-network" };
  await withEngine((request, response, body) => {
    requests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : undefined });
    if (request.url === "/v1.54/networks/create") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ Id: "attempt-internal-network" }));
    } else if (request.url === "/v1.54/networks/attempt-internal-network") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ Id: "attempt-internal-network", Name: "jarvis-gateway-attempt-1", Labels: labels, Internal: true }));
    } else if (request.url === "/v1.54/networks/egress/connect") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    } else if (request.url.startsWith("/v1.54/networks?filters=")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ Id: "attempt-internal-network", Name: "jarvis-network", Labels: labels, Containers: { "filter-id": {} } }]));
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  }, async (engine) => {
    assert.equal(typeof engine.createNetwork, "function");
    assert.equal(typeof engine.connectNetwork, "function");
    const network = await engine.createNetwork({ name: "jarvis-gateway-attempt-1", internal: true, labels });
    await engine.connectNetwork("egress", "filter-container", { "jarvis.managed": "true" });
    assert.equal(network.id, "attempt-internal-network");
    assert.deepEqual((await engine.listManagedNetworks())[0].containerIds, ["filter-id"]);
  });
  assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
    ["POST", "/v1.54/networks/create"],
    ["GET", "/v1.54/networks/attempt-internal-network"],
    ["POST", "/v1.54/networks/egress/connect"],
    ["GET", requests[3].url],
  ]);
  assert.equal(requests[0].body.Internal, true);
  assert.deepEqual(requests[0].body.Labels, labels);
  assert.deepEqual(requests[2].body, { Container: "filter-container", EndpointConfig: { Labels: { "jarvis.managed": "true" } } });
});
