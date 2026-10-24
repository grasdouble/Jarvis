import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { OwnerAuthBoundary, OwnerAuthHttpRequest, OwnerAuthHttpResponse } from "./auth.js";
import type { DashboardHttpRequest } from "./dashboard.js";

const MAX_REQUEST_BYTES = 64 * 1024;

export type DashboardHttpHandler = (request: DashboardHttpRequest) => Promise<OwnerAuthHttpResponse>;
export type StopControlHttpHandler = (request: OwnerAuthHttpRequest & { readonly method: string; readonly projectId?: string }) => Promise<OwnerAuthHttpResponse>;

/** Creates a real listener composing existing owner-session and dashboard boundaries; bind policy belongs to deployment. */
export function createOperationalDashboardServer(options: { readonly dashboard: DashboardHttpHandler; readonly auth: OwnerAuthBoundary; readonly stopControls?: StopControlHttpHandler }): Server {
  return createServer((request, response) => {
    void dispatch(request, response, options);
  });
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  options: { readonly dashboard: DashboardHttpHandler; readonly auth: OwnerAuthBoundary; readonly stopControls?: StopControlHttpHandler },
): Promise<void> {
  try {
    const body = await readBody(request);
    if (body === null) {
      send(response, { status: 413, body: { error: "request_too_large" } });
      return;
    }
    let parsedBody: unknown;
    if (body.length > 0 && /application\/json/i.test(request.headers["content-type"] ?? "")) {
      try { parsedBody = JSON.parse(body.toString("utf8")) as unknown; }
      catch {
        send(response, { status: 400, body: { error: "invalid_json" } });
        return;
      }
    }
    const headers = normalizeHeaders(request.headers);
    const httpRequest: DashboardHttpRequest = {
      method: request.method ?? "",
      url: request.url ?? "/",
      headers,
      ...(parsedBody === undefined ? {} : { body: parsedBody }),
      ...(request.socket.remoteAddress === undefined ? {} : { remoteAddress: request.socket.remoteAddress }),
    };
    const result = await dispatchRoute(httpRequest, options);
    send(response, result);
  } catch {
    if (!response.headersSent) send(response, { status: 500, body: { error: "internal_error" } });
    else response.destroy();
  }
}

async function dispatchRoute(
  request: DashboardHttpRequest,
  options: { readonly dashboard: DashboardHttpHandler; readonly auth: OwnerAuthBoundary; readonly stopControls?: StopControlHttpHandler },
): Promise<OwnerAuthHttpResponse> {
  const path = request.url.split("?", 1)[0] ?? "/";
  const stopPath = /^\/api\/v1\/stop(?:\/projects\/([0-9a-f-]{36}))?$/.exec(path);
  if (stopPath) {
    if (!options.stopControls) return { status: 404, body: { error: "not_found" } };
    if (request.method !== "GET" && request.method !== "POST") return { status: 405, body: { error: "method_not_allowed" }, headers: { allow: "GET, POST" } };
    return options.stopControls({ ...request, method: request.method, ...(stopPath[1] ? { projectId: stopPath[1] } : {}) });
  }
  const routes: Record<string, { readonly handle: (request: OwnerAuthHttpRequest) => Promise<OwnerAuthHttpResponse> }> = {
    "/api/v1/session": {
      handle: request.method === "GET" ? options.auth.getSession : options.auth.login,
    },
    "/api/v1/session/onboard": { handle: options.auth.onboard },
    "/api/v1/session/logout": { handle: options.auth.logout },
  };
  if (path in routes) {
    const route = routes[path]!;
    const methodAllowed = path === "/api/v1/session" ? request.method === "GET" || request.method === "POST" : request.method === "POST";
    if (!methodAllowed) return { status: 405, body: { error: "method_not_allowed" }, headers: { allow: path === "/api/v1/session" ? "GET, POST" : "POST" } };
    return route.handle(request);
  }
  if (path.startsWith("/api/v1/session/")) return { status: 404, body: { error: "not_found" } };
  return options.dashboard(request);
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)) {
    request.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) oversized = true;
    else if (!oversized) chunks.push(buffer);
  }
  if (oversized) return null;
  return Buffer.concat(chunks, size);
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) result[name] = name === "cookie" ? value.join("; ") : value.join(", ");
    else result[name] = value;
  }
  return result;
}

function send(response: ServerResponse, result: OwnerAuthHttpResponse): void {
  const status = Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : 500;
  const bodyAllowed = status !== 204 && status !== 304;
  const payload = !bodyAllowed ? "" : typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? null);
  response.statusCode = status;
  const headers = result.headers ?? {};
  for (const [name, rawValue] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const safeValues = values.filter((value): value is string => typeof value === "string" && !/[\r\n]/.test(value));
    if (safeValues.length === 0) continue;
    if (name.toLowerCase() === "set-cookie") response.setHeader(name, safeValues);
    else response.setHeader(name, safeValues.join(", "));
  }
  response.setHeader("cache-control", "no-store");
  if (bodyAllowed) {
    if (!response.hasHeader("content-type")) response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("content-length", Buffer.byteLength(payload, "utf8"));
  }
  response.end(payload);
}
