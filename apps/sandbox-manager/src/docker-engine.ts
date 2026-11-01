import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";

import type {
  ContainerInspection,
  ContainerRequest,
  ManagedLabels,
  ManagedNetworkInspection,
  OpenCodeRelayRequest,
  OpenCodeRelayResponse,
  NetworkRequest,
  SandboxEngine,
  VolumeRequest,
} from "./index.js";
import { SandboxManagerError } from "./index.js";

const MAX_HEADER_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ARCHIVE_BYTES = 64 * 1024;

type DockerEngineOptions = {
  socketPath?: string;
  apiVersion: string;
};

type EngineVolume = {
  Name: string;
  Labels?: Record<string, string> | null;
};

type EngineContainer = {
  Id: string;
  Labels?: Record<string, string> | null;
  Config?: { Labels?: Record<string, string> | null };
  State?: { Status?: string } | string;
};

function stateFromEngine(value: string | undefined): ContainerInspection["state"] {
  switch (value) {
    case "created":
    case "running":
    case "paused":
    case "restarting":
    case "removing":
    case "exited":
    case "dead":
      return value;
    default:
      return "unknown";
  }
}

function safeLabels(value: Record<string, string> | null | undefined): ManagedLabels {
  return value ?? {};
}

function assertLabels(actual: ManagedLabels, expected: ManagedLabels): void {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new SandboxManagerError("Docker Engine resource labels do not match the manager registry.", "CONFLICT");
    }
  }
}

export class DockerEngineClient implements SandboxEngine {
  private readonly socketPath: string;
  private readonly apiPrefix: string;

  constructor(options: DockerEngineOptions) {
    this.socketPath = options.socketPath ?? "/var/run/docker.sock";
    if (!/^\d+\.\d+$/.test(options.apiVersion)) {
      throw new SandboxManagerError("A fixed Docker Engine API version is required.", "INVALID_ARGUMENT");
    }
    this.apiPrefix = `/v${options.apiVersion}`;
  }

  private async call<T>(method: string, path: string, body?: unknown, acceptedStatus = 200): Promise<T | undefined> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        socketPath: this.socketPath,
        path: `${this.apiPrefix}${path}`,
        method,
        timeout: REQUEST_TIMEOUT_MS,
        headers: payload ? {
          "content-type": "application/json",
          "content-length": payload.byteLength,
        } : undefined,
      }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("Docker Engine response exceeded the configured limit."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode !== acceptedStatus && response.statusCode !== 204 && response.statusCode !== 304) {
            const status = response.statusCode ?? 0;
            reject(new SandboxManagerError(
              `Docker Engine request failed with HTTP ${status}.`,
              status === 404 ? "NOT_FOUND" : "ENGINE_ERROR",
            ));
            return;
          }
          if (response.statusCode === 204 || response.statusCode === 304 || text.length === 0) {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new SandboxManagerError("Docker Engine returned invalid JSON.", "ENGINE_ERROR"));
          }
        });
      });
      request.on("timeout", () => request.destroy(new Error("Docker Engine request timed out.")));
      request.on("error", () => reject(new SandboxManagerError("Docker Engine transport failed.", "ENGINE_ERROR")));
      if (payload) request.write(payload);
      request.end();
    });
  }

  async putContainerArchive(containerId: string, destination: "/etc/jarvis", archive: Uint8Array): Promise<void> {
    if (!/^[a-f0-9]{12,64}$/i.test(containerId) || destination !== "/etc/jarvis" ||
        !(archive instanceof Uint8Array) || archive.byteLength < 1 || archive.byteLength > MAX_ARCHIVE_BYTES) {
      throw new SandboxManagerError("Manager config archive request is invalid or exceeds its fixed bounds.", "INVALID_ARGUMENT");
    }
    const payload = Buffer.from(archive);
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest({
        socketPath: this.socketPath,
        path: `${this.apiPrefix}/containers/${encodeURIComponent(containerId)}/archive?path=${encodeURIComponent(destination)}`,
        method: "PUT",
        timeout: REQUEST_TIMEOUT_MS,
        headers: { "content-type": "application/x-tar", "content-length": payload.byteLength },
      }, (response) => {
        response.resume();
        response.on("end", () => {
          if (response.statusCode === 200) resolve();
          else reject(new SandboxManagerError(`Docker Engine archive upload failed with HTTP ${response.statusCode ?? 0}.`,
            response.statusCode === 404 ? "NOT_FOUND" : "ENGINE_ERROR"));
        });
      });
      request.on("timeout", () => request.destroy(new Error("Docker Engine archive upload timed out.")));
      request.on("error", () => reject(new SandboxManagerError("Docker Engine archive transport failed.", "ENGINE_ERROR")));
      request.end(payload);
    });
  }

  async createVolume(input: VolumeRequest): Promise<{ name: string; labels: ManagedLabels }> {
    const result = await this.call<{ Name: string; Labels?: ManagedLabels }>("POST", "/volumes/create", {
      Name: input.name,
      Driver: "local",
      Labels: input.labels,
    }, 201);
    if (!result || result.Name !== input.name) {
      throw new SandboxManagerError("Docker Engine did not confirm the requested volume identity.", "ENGINE_ERROR");
    }
    const labels = safeLabels(result.Labels);
    assertLabels(labels, input.labels);
    return { name: result.Name, labels };
  }

  async createContainer(input: ContainerRequest): Promise<ContainerInspection> {
    const allowedEnvironment: Readonly<Record<string, true>> = {
      LLM_GATEWAY_SOCKET: true,
      LLM_GATEWAY_ATTEMPT_CAPABILITY: true,
      LLM_GATEWAY_PROVIDER_ID: true,
      LLM_GATEWAY_MODEL: true,
      LLM_GATEWAY_PROFILE_ID: true,
      LLM_GATEWAY_CONTEXT_WINDOW_TOKENS: true,
      LLM_GATEWAY_MAX_OUTPUT_TOKENS: true,
      LLM_GATEWAY_MAX_INPUT_BYTES: true,
      LLM_GATEWAY_MAX_REQUESTS: true,
      LLM_GATEWAY_ACCOUNTING_SOCKET: true,
      XDG_CONFIG_HOME: true,
    };
    for (const [key, value] of Object.entries(input.environment ?? {})) {
      if (!Object.hasOwn(allowedEnvironment, key) || typeof value !== "string" || value.length > 256 || /[\0\r\n]/.test(value)) {
        throw new SandboxManagerError("Container environment contains an unapproved setting.", "INVALID_ARGUMENT");
      }
    }
    const config = {
      Image: input.image,
      ...(input.entrypoint.length ? { Entrypoint: input.entrypoint } : {}),
      User: input.user,
      Labels: input.labels,
      ...(input.environment ? { Env: Object.entries(input.environment).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`) } : {}),
      HostConfig: {
        NetworkMode: input.networkMode,
        ReadonlyRootfs: input.readOnlyRootfs,
        Privileged: input.privileged,
        CapDrop: input.capDrop,
        ...(input.capAdd ? { CapAdd: input.capAdd } : {}),
        SecurityOpt: input.securityOptions,
        Memory: input.memoryBytes,
        NanoCpus: input.nanoCpus,
        PidsLimit: input.pidsLimit,
        RestartPolicy: { Name: "no" },
        AutoRemove: false,
        Mounts: input.mounts.map((mount) => ({
          Type: mount.type,
          Source: mount.source,
          Target: mount.target,
          ReadOnly: mount.readOnly,
        })),
      },
    };
    const query = new URLSearchParams({ name: input.name, platform: input.platform });
    const result = await this.call<{ Id: string }>("POST", `/containers/create?${query}`, config, 201);
    if (!result?.Id) throw new SandboxManagerError("Docker Engine did not return a container identity.", "ENGINE_ERROR");
    const inspection = await this.inspectContainer(result.Id);
    assertLabels(inspection.labels, input.labels);
    return inspection;
  }

  async listManagedContainers(): Promise<ContainerInspection[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: ["jarvis.managed=true"] }));
    const results = await this.call<EngineContainer[]>("GET", `/containers/json?all=true&filters=${filters}`);
    return (results ?? []).map((container) => ({
      id: container.Id,
      state: stateFromEngine(typeof container.State === "string" ? container.State : container.State?.Status),
      labels: safeLabels(container.Labels),
    }));
  }

  async listManagedVolumes(): Promise<Array<{ name: string; labels: ManagedLabels }>> {
    const filters = encodeURIComponent(JSON.stringify({ label: ["jarvis.managed=true"] }));
    const result = await this.call<{ Volumes?: EngineVolume[] }>("GET", `/volumes?filters=${filters}`);
    return (result?.Volumes ?? []).map((volume) => ({
      name: volume.Name,
      labels: safeLabels(volume.Labels),
    }));
  }

  async listManagedNetworks(): Promise<ManagedNetworkInspection[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: ["jarvis.managed=true"] }));
    const results = await this.call<Array<{ Id: string; Name: string; Labels?: ManagedLabels; Containers?: Record<string, unknown> | null }>>(
      "GET", `/networks?filters=${filters}`,
    );
    return (results ?? []).map((network) => ({
      id: network.Id, name: network.Name, labels: safeLabels(network.Labels), containerIds: Object.keys(network.Containers ?? {}),
    }));
  }

  async startContainer(id: string): Promise<void> {
    await this.call("POST", `/containers/${encodeURIComponent(id)}/start`, undefined, 204);
  }

  async inspectContainer(id: string): Promise<ContainerInspection> {
    const result = await this.call<EngineContainer>("GET", `/containers/${encodeURIComponent(id)}/json`);
    if (!result?.Id || result.Id !== id) {
      throw new SandboxManagerError("Docker Engine returned an unexpected container identity.", "CONFLICT");
    }
    return {
      id: result.Id,
      state: stateFromEngine(typeof result.State === "string" ? result.State : result.State?.Status),
      labels: safeLabels(result.Config?.Labels),
    };
  }

  async stopContainer(id: string, timeoutSeconds: number): Promise<void> {
    const query = new URLSearchParams({ t: String(timeoutSeconds) });
    await this.call("POST", `/containers/${encodeURIComponent(id)}/stop?${query}`, undefined, 204);
  }

  async relayOpenCode(containerId: string, request: OpenCodeRelayRequest): Promise<OpenCodeRelayResponse> {
    // The Engine hijack request is written as one bounded HTTP frame so Node cannot
    // switch protocols before the fixed start options have reached the daemon.
    const execResult = await this.call<{ Id?: string }>("POST", `/containers/${encodeURIComponent(containerId)}/exec`, {
      AttachStdin: true, AttachStdout: true, AttachStderr: false, Tty: true,
      Cmd: ["/usr/local/bin/jarvis-opencode-relay"],
    }, 201);
    const execId = execResult?.Id;
    if (typeof execId !== "string" || !/^[a-f0-9]{12,64}$/i.test(execId)) {
      throw new SandboxManagerError("Docker Engine did not return a valid fixed-relay execution identity.", "ENGINE_ERROR");
    }
    const startBody = Buffer.from('{"Detach":false,"Tty":true}');
    const startHeaders = Buffer.from([
      `POST ${this.apiPrefix}/exec/${encodeURIComponent(execId)}/start HTTP/1.1`,
      "Host: localhost",
      "Connection: Upgrade",
      "Upgrade: tcp",
      "Content-Type: application/json",
      `Content-Length: ${startBody.byteLength}`,
      "",
      "",
    ].join("\r\n"));
    return new Promise((resolve, reject) => {
      let settled = false;
      let upgraded = false;
      let responseHead = Buffer.alloc(0);
      let output = Buffer.alloc(0);
      const socket = createConnection({ path: this.socketPath });
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) {
          reject(new SandboxManagerError("Fixed OpenCode relay transport failed.", "ENGINE_ERROR"));
          return;
        }
        try {
          const value: unknown = JSON.parse(output.toString("utf8").trim());
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid response");
          resolve(value as OpenCodeRelayResponse);
        } catch {
          reject(new SandboxManagerError("Fixed OpenCode relay returned invalid framed JSON.", "ENGINE_ERROR"));
        }
      };
      const timer = setTimeout(() => finish(new Error("timeout")), REQUEST_TIMEOUT_MS);
      socket.on("connect", () => socket.write(Buffer.concat([startHeaders, startBody])));
      socket.on("data", (chunk: Buffer) => {
        if (!upgraded) {
          responseHead = Buffer.concat([responseHead, chunk]);
          if (responseHead.byteLength > MAX_HEADER_BYTES) { finish(new Error("response headers too large")); return; }
          const delimiter = responseHead.indexOf("\r\n\r\n");
          if (delimiter < 0) return;
          const statusLine = responseHead.subarray(0, delimiter).toString("ascii").split("\r\n", 1)[0] ?? "";
          if (!/^HTTP\/1\.[01] (?:101|200)(?:\s|$)/.test(statusLine)) { finish(new Error("unexpected response")); return; }
          upgraded = true;
          output = Buffer.from(responseHead.subarray(delimiter + 4));
          responseHead = Buffer.alloc(0);
          socket.end(Buffer.from(`${JSON.stringify(request)}\n`));
        } else {
          output = Buffer.concat([output, chunk]);
        }
        if (output.byteLength > MAX_RESPONSE_BYTES) finish(new Error("response too large"));
      });
      socket.on("end", () => finish());
      socket.on("error", finish);
    });
  }

  async removeContainer(id: string, expectedLabels: ManagedLabels): Promise<void> {
    try {
      const current = await this.inspectContainer(id);
      assertLabels(current.labels, expectedLabels);
    } catch (error) {
      if (error instanceof SandboxManagerError && error.code === "NOT_FOUND") return;
      throw error;
    }
    const query = new URLSearchParams({ force: "false", v: "false" });
    try {
      await this.call("DELETE", `/containers/${encodeURIComponent(id)}?${query}`, undefined, 204);
    } catch (error) {
      if (!(error instanceof SandboxManagerError) || error.code !== "NOT_FOUND") throw error;
    }
  }

  async removeVolume(name: string, expectedLabels: ManagedLabels): Promise<void> {
    let result: EngineVolume | undefined;
    try {
      result = await this.call<EngineVolume>("GET", `/volumes/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error instanceof SandboxManagerError && error.code === "NOT_FOUND") return;
      throw error;
    }
    if (!result || result.Name !== name) throw new SandboxManagerError("Managed volume was not found.", "CONFLICT");
    assertLabels(safeLabels(result.Labels), expectedLabels);
    try {
      await this.call("DELETE", `/volumes/${encodeURIComponent(name)}?force=false`, undefined, 204);
    } catch (error) {
      if (!(error instanceof SandboxManagerError) || error.code !== "NOT_FOUND") throw error;
    }
  }

  async createNetwork(input: NetworkRequest): Promise<{ id: string; name: string; labels: ManagedLabels }> {
    const result = await this.call<{ Id?: string; Warning?: string }>("POST", "/networks/create", {
      Name: input.name,
      Driver: "bridge",
      Internal: input.internal,
      Attachable: false,
      Ingress: false,
      EnableIPv6: false,
      Labels: input.labels,
      ...(input.internal ? { Options: { "com.docker.network.bridge.enable_ip_masquerade": "false" } } : {}),
    }, 201);
    if (!result?.Id || result.Warning) throw new SandboxManagerError("Docker Engine did not confirm the requested network identity.", "ENGINE_ERROR");
    const inspected = await this.call<{ Id?: string; Name?: string; Labels?: ManagedLabels; Internal?: boolean }>(
      "GET", `/networks/${encodeURIComponent(result.Id)}`,
    );
    if (!inspected || inspected.Id !== result.Id || inspected.Name !== input.name || inspected.Internal !== input.internal) {
      throw new SandboxManagerError("Docker Engine network identity or isolation mode did not match the request.", "CONFLICT");
    }
    const labels = safeLabels(inspected.Labels);
    assertLabels(labels, input.labels);
    return { id: result.Id, name: inspected.Name, labels };
  }

  async connectNetwork(networkId: string, containerId: string, endpointLabels: ManagedLabels): Promise<void> {
    await this.call("POST", `/networks/${encodeURIComponent(networkId)}/connect`, {
      Container: containerId,
      EndpointConfig: { Labels: endpointLabels },
    }, 200);
  }

  async disconnectNetwork(networkId: string, containerId: string): Promise<void> {
    await this.call("POST", `/networks/${encodeURIComponent(networkId)}/disconnect`, {
      Container: containerId,
      Force: false,
    }, 200);
  }

  async removeNetwork(networkId: string, expectedLabels: ManagedLabels): Promise<void> {
    let result: { Id?: string; Name?: string; Labels?: ManagedLabels } | undefined;
    try { result = await this.call("GET", `/networks/${encodeURIComponent(networkId)}`); }
    catch (error) {
      if (error instanceof SandboxManagerError && error.code === "NOT_FOUND") return;
      throw error;
    }
    if (!result || result.Id !== networkId) throw new SandboxManagerError("Managed network was not found.", "CONFLICT");
    assertLabels(safeLabels(result.Labels), expectedLabels);
    try {
      await this.call("DELETE", `/networks/${encodeURIComponent(networkId)}`, undefined, 204);
    } catch (error) {
      if (!(error instanceof SandboxManagerError) || error.code !== "NOT_FOUND") throw error;
    }
  }
}
