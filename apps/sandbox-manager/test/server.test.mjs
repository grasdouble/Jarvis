import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSandboxManager } from "../dist/index.js";
import { createSandboxManagerServer } from "../dist/server.js";

function openssl(directory, args) {
  execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
}

async function certificateFixture(directory) {
  openssl(directory, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=Jarvis Test CA", "-keyout", "ca.key", "-out", "ca.crt"]);
  for (const [name, san] of [["worker", "URI:spiffe://jarvis/worker"], ["other", "DNS:untrusted-role.invalid"]]) {
    openssl(directory, ["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=" + name,
      "-keyout", name + ".key", "-out", name + ".csr"]);
    await writeFile(join(directory, name + ".ext"),
      "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\nsubjectAltName=" + san + "\n");
    openssl(directory, ["x509", "-req", "-in", name + ".csr", "-CA", "ca.crt", "-CAkey", "ca.key",
      "-CAcreateserial", "-days", "1", "-extfile", name + ".ext", "-out", name + ".crt"]);
  }
  openssl(directory, ["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=sandbox-manager",
    "-keyout", "server.key", "-out", "server.csr"]);
  await writeFile(join(directory, "server.ext"),
    "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n");
  openssl(directory, ["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
    "-CAcreateserial", "-days", "1", "-extfile", "server.ext", "-out", "server.crt"]);
}

function httpsRequest(port, options, body) {
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: "localhost", port, ...options }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

test("requires a trusted worker certificate and rejects other identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-mtls-test-"));
  await certificateFixture(directory);
  let managedLabels;
  const engine = {
    async createVolume({ name, labels }) { return { name, labels }; },
    async createContainer(input) { managedLabels = input.labels; return { id: "engine-container-id", state: "created", labels: input.labels }; },
    async listManagedContainers() { return []; },
    async listManagedVolumes() { return []; },
    async startContainer() {},
    async inspectContainer(id) {
      return { id, state: "running", labels: managedLabels };
    },
    async relayOpenCode(_containerId, request) { return { operation: request.operation }; },
    async stopContainer() {},
    async removeContainer() {},
    async removeVolume() {},
  };
  const manager = createSandboxManager({
    engine,
    now: () => new Date("2026-10-19T00:00:00.000Z"),
    createId: () => "00000000-0000-4000-8000-000000000001",
    profiles: [{
      id: "plan-readonly-v1",
      image: `registry.example.invalid/jarvis/plan@sha256:${"a".repeat(64)}`,
      platform: "linux/arm64",
      memoryBytes: 4 * 1024 ** 3,
      nanoCpus: 2_000_000_000,
      pidsLimit: 256,
      maxDurationMs: 30 * 60 * 1000,
      readOnlyWorkspace: true,
    }],
  });
  const [key, cert, ca] = await Promise.all([
    readFile(join(directory, "server.key")),
    readFile(join(directory, "server.crt")),
    readFile(join(directory, "ca.crt")),
  ]);
  const server = createSandboxManagerServer({
    manager,
    tls: { key, cert, ca },
    authorizeClient: (peer) => peer.subjectaltname?.split(", ").includes("URI:spiffe://jarvis/worker") ?? false,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  try {
    const workerOptions = {
      ca,
      cert: await readFile(join(directory, "worker.crt")),
      key: await readFile(join(directory, "worker.key")),
      rejectUnauthorized: true,
      method: "POST",
      path: "/v1/sandboxes",
      headers: { "content-type": "application/json", "idempotency-key": "worker-idempotency-1" },
    };
    const spec = {
      taskId: "task-123",
      attemptId: "attempt-456",
      snapshotId: "a".repeat(40),
      profileId: "plan-readonly-v1",
      modelProfileId: "model-profile-v1",
      deadline: "2026-10-19T00:20:00.000Z",
      leaseEpoch: 1,
    };
    const accepted = await httpsRequest(port, workerOptions, JSON.stringify(spec));
    assert.equal(accepted.status, 201);
    const createResponse = JSON.parse(accepted.body);
    assert.deepEqual(Object.keys(createResponse).sort(), ["sandboxId", "state"]);
    assert.equal(createResponse.state, "running");
    const sandboxId = createResponse.sandboxId;
    const resolved = await httpsRequest(port, { ...workerOptions, path: "/v1/sandboxes/resolve" }, JSON.stringify(spec));
    assert.equal(resolved.status, 200);
    assert.deepEqual(JSON.parse(resolved.body), { sandboxId });
    const runtime = await httpsRequest(port, {
      ...workerOptions,
      path: `/v1/sandboxes/${sandboxId}/runtime`,
      headers: { "content-type": "application/json" },
    }, JSON.stringify({ leaseEpoch: 1, taskId: "task-123", attemptId: "attempt-456", request: { operation: "health" } }));
    assert.equal(runtime.status, 200);
    assert.deepEqual(JSON.parse(runtime.body), { operation: "health" });
    const invalidRuntime = await httpsRequest(port, {
      ...workerOptions,
      path: `/v1/sandboxes/${sandboxId}/runtime`,
      headers: { "content-type": "application/json" },
    }, JSON.stringify({ leaseEpoch: 1, taskId: "task-123", attemptId: "attempt-456", request: { operation: "exec", command: "id" } }));
    assert.equal(invalidRuntime.status, 400);

    const rejected = await httpsRequest(port, {
      ...workerOptions,
      cert: await readFile(join(directory, "other.crt")),
      key: await readFile(join(directory, "other.key")),
      headers: { "content-type": "application/json", "idempotency-key": "fixture-key" },
    }, JSON.stringify(spec));
    assert.equal(rejected.status, 403);
    assert.deepEqual(JSON.parse(rejected.body), { error: "client_not_authorized" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
