import { getReadOnlyAnalysisProfile, type ReadOnlyAnalysisMode, type ReadOnlyAnalysisProfile } from "./advisory-results.js";
export type OpenCodeSession = { id: string; title?: string };
export type OpenCodePromptAdmission = { data: { id: string; text: string } };
export type OpenCodeMessage = {
  id: string;
  type: "user" | "assistant" | "idle" | string;
  text?: string;
  time?: { created: number };
  content?: Array<{ type: string; text?: string }>;
  outcome?: "succeeded" | "failed";
  error?: unknown;
};

export type OpenCodeClientOptions = {
  baseUrl: string;
  password: string;
  mode: ReadOnlyAnalysisMode;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class OpenCodeClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "OpenCodeClientError";
  }
}

/** A deliberately small client for an already-running, loopback-only OpenCode server. */
export class OpenCodeClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly authorization: string;
  private readonly profile: ReadOnlyAnalysisProfile;

  constructor(options: OpenCodeClientOptions) {
    try {
      this.profile = getReadOnlyAnalysisProfile(options.mode);
    } catch {
      throw new OpenCodeClientError("An explicit plan or PR-analysis mode is required.");
    }
    this.baseUrl = new URL(options.baseUrl);
    if (this.baseUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(this.baseUrl.hostname) ||
        this.baseUrl.username || this.baseUrl.password || this.baseUrl.pathname !== "/" ||
        this.baseUrl.search || this.baseUrl.hash) {
      throw new OpenCodeClientError("OpenCode server must be an authenticated loopback HTTP endpoint.");
    }
    if (!options.password) throw new OpenCodeClientError("A per-attempt OpenCode server password is required.");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new OpenCodeClientError("OpenCode request timeout is outside its supported range.");
    }
    this.fetcher = options.fetch ?? fetch;
    this.authorization = `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      const response = await this.fetcher(new URL(path, this.baseUrl), {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: this.authorization,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
      });
      if (!response.ok) throw new OpenCodeClientError(`OpenCode server returned HTTP ${response.status}.`, response.status);
      if (response.status === 204) return undefined as T;
      try {
        return await response.json() as T;
      } catch {
        throw new OpenCodeClientError("OpenCode server returned an invalid JSON response.", response.status);
      }
    } catch (error) {
      if (error instanceof OpenCodeClientError) throw error;
      throw new OpenCodeClientError("OpenCode server request failed.");
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    const info = await this.request<{ version?: unknown }>("/api/info");
    if (typeof info.version !== "string" || info.version.length === 0) {
      throw new OpenCodeClientError("OpenCode server info did not include a valid version.");
    }
    return { healthy: true, version: info.version };
  }

  async createSession(
    title: string,
    options: { providerID: string; modelID: string },
  ): Promise<OpenCodeSession> {
    if (!title || title.length > 200) throw new OpenCodeClientError("Session title is empty or too long.");
    if (!options.providerID || !options.modelID) throw new OpenCodeClientError("Provider and model are required for the selected read-only profile.");
    const result = await this.request<{ data?: OpenCodeSession }>("/api/session", {
      method: "POST",
      body: JSON.stringify({
        title,
        model: { providerID: options.providerID, id: options.modelID },
        agent: this.profile.openCodeConfig.default_agent,
      }),
    });
    if (!result.data || typeof result.data.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.data.id)) {
      throw new OpenCodeClientError("OpenCode server did not return a valid session.");
    }
    return result.data;
  }

  prompt(sessionId: string, message: string): Promise<OpenCodePromptAdmission> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || !message || message.length > 64 * 1024) {
      throw new OpenCodeClientError("Session id or prompt is invalid.");
    }
    return this.request(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: message, resume: true }),
    });
  }

  async messages(sessionId: string): Promise<OpenCodeMessage[]> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new OpenCodeClientError("Session id is invalid.");
    const result = await this.request<{ data?: OpenCodeMessage[] }>(
      `/api/session/${encodeURIComponent(sessionId)}/message?order=desc&limit=50`,
    );
    if (!Array.isArray(result.data)) throw new OpenCodeClientError("OpenCode server returned an invalid message page.");
    return result.data;
  }

  async abort(sessionId: string): Promise<boolean> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new OpenCodeClientError("Session id is invalid.");
    const result = await this.request<{ interrupted?: unknown }>(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
      method: "POST",
    });
    if (typeof result.interrupted !== "boolean") throw new OpenCodeClientError("OpenCode server returned an invalid interruption result.");
    return result.interrupted;
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new OpenCodeClientError("Session id is invalid.");
    await this.request<void>(`/api/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }
}
