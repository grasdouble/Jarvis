import { request as httpRequest } from "node:http";

import type {
  ContainerInspection,
  ContainerRequest,
  ManagedLabels,
  OpenCodeRelayRequest,
  OpenCodeRelayResponse,
  SandboxEngine,
  VolumeRequest,
} from "./index.js";
import { SandboxManagerError } from "./index.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

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
    const config = {
      Image: input.image,
      Entrypoint: input.entrypoint,
      User: input.user,
      Labels: input.labels,
      HostConfig: {
        NetworkMode: input.networkMode,
        ReadonlyRootfs: input.readOnlyRootfs,
        Privileged: input.privileged,
        CapDrop: input.capDrop,
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
    // Container identity comes only from the manager registry. Command and path are fixed;
    // the operation is structured stdin, never interpolated into argv or a shell.
    const created = await this.call<{ Id?: string }>("POST", `/containers/${encodeURIComponent(containerId)}/exec`, {
      AttachStdin: true, AttachStdout: true, AttachStderr: false, Tty: true,
      Cmd: ["/usr/local/bin/jarvis-opencode-relay"],
    }, 201);
    const execId = created?.Id;
    if (typeof execId !== "string" || !/^[a-f0-9]{12,64}$/i.test(execId)) {
      throw new SandboxManagerError("Docker Engine did not return a valid fixed-relay execution identity.", "ENGINE_ERROR");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let output = Buffer.alloc(0);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { reject(new SandboxManagerError("Fixed OpenCode relay transport failed.", "ENGINE_ERROR")); return; }
        try {
          const text = output.toString("utf8").trim();
          const value: unknown = JSON.parse(text);
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid response");
          resolve(value as OpenCodeRelayResponse);
        } catch { reject(new SandboxManagerError("Fixed OpenCode relay returned invalid framed JSON.", "ENGINE_ERROR")); }
      };
      const timer = setTimeout(() => { requestHandle.destroy(); finish(new Error("timeout")); }, REQUEST_TIMEOUT_MS);
      const requestHandle = httpRequest({
        socketPath: this.socketPath,
        path: `${this.apiPrefix}/exec/${encodeURIComponent(execId)}/start`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength('{"Detach":false,"Tty":true}'),
          connection: "Upgrade",
          upgrade: "tcp",
        },
      });
      requestHandle.on("upgrade", (_response, socket, head) => {
        if (head.length) output = Buffer.concat([output, head]);
        socket.on("data", (chunk: Buffer) => {
          output = Buffer.concat([output, chunk]);
          if (output.byteLength > MAX_RESPONSE_BYTES) { socket.destroy(); finish(new Error("response too large")); }
        });
        socket.on("end", () => finish());
        socket.on("error", finish);
        socket.write(Buffer.from(`${JSON.stringify(request)}\n`));
        socket.end();
      });
      requestHandle.on("response", (response) => {
        response.resume();
        finish(new Error(`unexpected HTTP ${response.statusCode}`));
      });
      requestHandle.on("error", finish);
      requestHandle.end('{"Detach":false,"Tty":true}');
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
}
