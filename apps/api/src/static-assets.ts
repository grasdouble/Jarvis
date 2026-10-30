import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { DashboardHttpRequest } from "./dashboard.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function createStaticAssetHandler(root: string): (request: DashboardHttpRequest) => Promise<{
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}> {
  const absoluteRoot = resolve(root);
  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return { status: 405, body: { error: "method_not_allowed" }, headers: { allow: "GET, HEAD", "cache-control": "no-store" } };
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url, "http://jarvis.invalid").pathname); }
    catch { return { status: 400, body: { error: "invalid_path" } }; }
    if (pathname.includes("\\") || pathname.includes("\0")) return { status: 404, body: { error: "not_found" } };
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const candidate = resolve(absoluteRoot, relative);
    if (candidate !== absoluteRoot && !candidate.startsWith(`${absoluteRoot}${sep}`)) return { status: 404, body: { error: "not_found" } };
    try {
      const rootReal = await realpath(absoluteRoot);
      let file = candidate;
      let data: Buffer;
      try { data = await readFile(file); }
      catch (error) {
        if (!pathname.endsWith("/") && extname(pathname) !== "") throw error;
        file = resolve(absoluteRoot, "index.html");
        data = await readFile(file);
      }
      const fileReal = await realpath(file);
      if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${sep}`)) return { status: 404, body: { error: "not_found" } };
      const contentType = CONTENT_TYPES[extname(fileReal)] ?? "application/octet-stream";
      return { status: 200, body: data, headers: { "content-type": contentType, "cache-control": fileReal.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } };
    } catch {
      return { status: 404, body: { error: "not_found" }, headers: { "cache-control": "no-store" } };
    }
  };
}
