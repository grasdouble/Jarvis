import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { t as listTar, x as extractTar } from "tar";
import { computeSnapshotDigest, type RepositoryBinding, type SnapshotFile } from "./advisory-results.js";

export type SnapshotLimits = { compressedBytes: number; expandedBytes: number; entries: number; diffBytes: number; manifestBytes?: number };
export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = Object.freeze({ compressedBytes: 16 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024, entries: 10_000, diffBytes: 2 * 1024 * 1024, manifestBytes: 2 * 1024 * 1024 });
export type SnapshotManifest = Readonly<{ repository: string; revision: string; snapshotDigest: string; files: readonly Readonly<SnapshotFile>[]; excludedPaths: readonly string[]; diffSha256: string; diffBytes: number }>;
export type PreparedSnapshot = Readonly<{ sourceRoot: string; diffPath: string; manifest: SnapshotManifest; cleanup: () => Promise<void> }>;

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith("/") && !/^[a-zA-Z]:/.test(path) && !path.includes("\\") && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}
function excluded(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const base = parts.at(-1) ?? "";
  return parts.some((part) => [".git", ".github", ".agents", ".opencode", ".claude", ".vscode", ".husky", ".githooks", ".lefthook", ".pre-commit", "plugins", "plugin", "hooks", "skills", "commands"].includes(part)) || base.startsWith(".env") || ["agents.md", ".gitmodules", ".npmrc", ".pre-commit-config.yaml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"].includes(base) || /^\.?opencode\.(json|jsonc)$/.test(base);
}

/** Prepare a private extracted snapshot. Only the caller owns cleanup(), which is idempotent. */
export async function prepareSnapshot(archive: Uint8Array, binding: RepositoryBinding, diff: Uint8Array, limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS): Promise<PreparedSnapshot> {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]{0,98}[a-z0-9])?$/.test(binding.repository)) throw new Error("A canonical lowercase owner/repository is required.");
  if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(binding.revision)) throw new Error("A 40- or 64-character hexadecimal revision is required.");
  const effectiveLimits = { ...DEFAULT_SNAPSHOT_LIMITS, ...limits };
  const allowedLimitKeys = new Set(Object.keys(DEFAULT_SNAPSHOT_LIMITS));
  for (const [key, limit] of Object.entries(effectiveLimits)) {
    const maximum = DEFAULT_SNAPSHOT_LIMITS[key as keyof SnapshotLimits];
    if (!allowedLimitKeys.has(key) || maximum === undefined || !Number.isSafeInteger(limit) || limit <= 0 || limit > maximum) throw new Error("Snapshot limits must be positive safe integers no greater than the trusted defaults.");
  }
  if (archive.byteLength > effectiveLimits.compressedBytes) throw new Error("Compressed archive exceeds its byte limit.");
  if (diff.byteLength > effectiveLimits.diffBytes) throw new Error("Diff exceeds its actual byte limit.");
  const manifestLimit = effectiveLimits.manifestBytes ?? DEFAULT_SNAPSHOT_LIMITS.manifestBytes!;
  const root = await mkdtemp(join(tmpdir(), "jarvis-snapshot-"));
  const archivePath = join(root, "input.tar");
  const output = join(root, "source");
  const diffPath = join(root, "diff.patch");
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = rm(root, { recursive: true, force: true }).catch((error: unknown) => {
        cleanupPromise = undefined;
        throw error;
      });
    }
    return cleanupPromise;
  };
  try {
    await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
    await mkdir(output, { mode: 0o700 });
    const excludedPaths: string[] = [];
    const accepted = new Set<string>();
    let count = 0;
    await writeFile(diffPath, diff, { flag: "wx", mode: 0o600 });
    let expanded = 0;
    const seenPaths = new Set<string>();
    const seenFilesystemPaths = new Set<string>();
    let manifestBytes = 0;
    let scanFailure: Error | undefined;
    await listTar({ file: archivePath, strict: true, maxMetaEntrySize: 64 * 1024, onReadEntry(entry) {
      count += 1;
      const path = entry.path.replace(/\/$/, "");
      const filesystemPath = path.normalize("NFKC").toLowerCase();
      if (count > effectiveLimits.entries) scanFailure ??= new Error("Archive entry count exceeds its limit.");
      else if (!safePath(path)) scanFailure ??= new Error("Archive contains an absolute, traversal, or malformed path.");
      else if (seenPaths.has(path)) scanFailure ??= new Error("Archive contains a duplicate path.");
      else if (seenFilesystemPaths.has(filesystemPath)) scanFailure ??= new Error("Archive contains filesystem-equivalent paths.");
      else if (!Number.isSafeInteger(entry.size) || entry.size < 0) scanFailure ??= new Error("Archive entry has an invalid size.");
      else if (entry.type === "SymbolicLink" || entry.type === "Link") scanFailure ??= new Error("Archive links are not accepted.");
      else if (entry.type !== "File" && entry.type !== "Directory") scanFailure ??= new Error("Archive contains a special file.");
      if (!scanFailure) {
        seenPaths.add(path);
        seenFilesystemPaths.add(filesystemPath);
        manifestBytes += Buffer.byteLength(path, "utf8") + (entry.type === "File" ? 64 : 0);
        if (manifestBytes > manifestLimit) scanFailure ??= new Error("Snapshot manifest exceeds its byte limit.");
        if (entry.type === "File") {
          expanded += entry.size;
          if (expanded > effectiveLimits.expandedBytes) scanFailure ??= new Error("Archive expanded bytes exceed their limit.");
        }
      }
      if (!scanFailure) {
        if (excluded(path)) excludedPaths.push(path);
        else if (entry.type === "File") accepted.add(path);
      }
    } });
    if (scanFailure) throw scanFailure;
    await extractTar({ file: archivePath, cwd: output, strict: true, maxMetaEntrySize: 64 * 1024, preservePaths: false, preserveOwner: false, unlink: true, maxDepth: 64, filter(path, entry) {
      const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
      return "type" in entry && safePath(normalized) && !excluded(normalized) && (entry.type === "File" || entry.type === "Directory");
    } });
    const files: SnapshotFile[] = [];
    for (const path of accepted) {
      const bytes = await readFile(resolve(output, path));
      files.push({ path, sha256: digest(bytes) });
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const diffSha256 = digest(diff);
    const excludedManifest = [...new Set(excludedPaths)].sort();
    const snapshotDigest = computeSnapshotDigest(binding.repository, binding.revision, files, excludedManifest, diffSha256, diff.byteLength);
    const immutableFiles = Object.freeze(files.map((file) => Object.freeze({ ...file })));
    const immutableExcluded = Object.freeze([...excludedManifest]);
    const manifest: SnapshotManifest = Object.freeze({ ...binding, snapshotDigest, files: immutableFiles, excludedPaths: immutableExcluded, diffSha256, diffBytes: diff.byteLength });
    const sourceRoot = output;
    return Object.freeze({ sourceRoot, diffPath, manifest, cleanup });
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Verify a cited path and digest against exactly the prepared manifest. */
export function verifySnapshotFile(manifest: SnapshotManifest, repository: string, revision: string, path: string, contents: Uint8Array): boolean {
  return manifest.repository === repository && manifest.revision === revision && manifest.files.some((file) => file.path === path && file.sha256 === digest(contents));
}
