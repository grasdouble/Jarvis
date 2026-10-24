import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { OwnerAuthHttpResponse } from "./auth.js";
import type { DashboardHttpRequest } from "./dashboard.js";

const MAX_REQUEST_BYTES = 64 * 1024;

export type DashboardHttpHandler = (request: DashboardHttpRequest) => Promise<OwnerAuthHttpResponse>;

/** Creates a real Node HTTP listener for the dashboard routes only; host/bind policy belongs to deployment. */
export function createOperationalDashboardServer(options: { readonly dashboard: DashboardHttpHandler }): Server {
  return createServer((request, response) => {
    void dispatch(request, response, options.dashboard);
  });
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  dashboard: DashboardHttpHandler,
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
    const result = await dashboard({
      method: request.method ?? "",
      url: request.url ?? "/",
      headers,
      ...(parsedBody === undefined ? {} : { body: parsedBody }),
      ...(request.socket.remoteAddress === undefined ? {} : { remoteAddress: request.socket.remoteAddress }),
    });
    send(response, result);
  } catch {
    if (!response.headersSent) send(response, { status: 500, body: { error: "internal_error" } });
    else response.destroy();
  }
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
  const payload = typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? null);
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
  if (!response.hasHeader("content-type")) response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(payload, "utf8"));
  response.end(payload);
}
