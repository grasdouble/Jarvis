import { TextEncoder } from "node:util";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { c as createTar } from "tar";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestSnapshotFile, prepareSnapshot } from "../dist/index.js";

async function archive(entries) {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-fixture-"));
  try {
    for (const [name, contents] of Object.entries(entries)) {
      const path = join(dir, name);
      await (await import("node:fs/promises")).mkdir(join(path, ".."), { recursive: true });
      await (await import("node:fs/promises")).writeFile(path, contents);
    }
    const archivePath = join(dir, "fixture.tar");
    await createTar({ cwd: dir, file: archivePath }, Object.keys(entries));
    return await readFile(archivePath);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const binding = { repository: "grasdouble/jarvis", revision: "a".repeat(40) };

test("extracts a bounded snapshot, excludes inert configuration and cleans up idempotently", async () => {
  const bytes = await archive({ "src/a.ts": "export const a=1", "skills/agent.md": "hostile", "plugins/p.js": "hostile", "commands/x.md": "hostile", "hooks/start.sh": "hostile", "AGENTS.md": "hostile", ".env.production": "secret", ".git/config": "inert", ".github/workflow.yml": "inert", ".agents/a.md": "inert", ".opencode/opencode.json": "inert", ".claude/settings.json": "inert", ".vscode/settings.json": "inert", ".husky/pre-commit": "inert", ".githooks/post-checkout": "inert", ".lefthook/pre-commit": "inert", ".pre-commit/config": "inert", ".pre-commit-config.yaml": "inert", ".npmrc": "inert", "package.json": "inert", "pnpm-lock.yaml": "inert", "pnpm-workspace.yaml": "inert", "tsconfig.json": "inert", "opencode.json": "inert" });
  const prepared = await prepareSnapshot(bytes, binding, new TextEncoder().encode("+ change"));
  try {
    assert.equal(await readFile(join(prepared.sourceRoot, "src/a.ts"), "utf8"), "export const a=1");
    assert.equal(prepared.manifest.files.length, 1);
    assert.deepEqual(prepared.manifest.excludedPaths, [".agents/a.md", ".claude/settings.json", ".env.production", ".git/config", ".githooks/post-checkout", ".github/workflow.yml", ".husky/pre-commit", ".lefthook/pre-commit", ".npmrc", ".opencode/opencode.json", ".pre-commit-config.yaml", ".pre-commit/config", ".vscode/settings.json", "AGENTS.md", "commands/x.md", "hooks/start.sh", "opencode.json", "package.json", "plugins/p.js", "pnpm-lock.yaml", "pnpm-workspace.yaml", "skills/agent.md", "tsconfig.json"]);
    assert.match(prepared.manifest.files[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(prepared.manifest), true);
    assert.equal(Object.isFrozen(prepared.manifest.files), true);
    assert.equal(Object.isFrozen(prepared.manifest.files[0]), true);
    assert.equal(Object.isFrozen(prepared.manifest.excludedPaths), true);
    assert.equal(prepared.manifest.diffBytes, 8);
  } finally { await prepared.cleanup(); await prepared.cleanup(); }
});

test("rejects compressed, expanded, entry-count, diff and path violations", async () => {
  const bytes = await archive({ "src/a.ts": "123456789", "src/b.ts": "x" });
  await assert.rejects(prepareSnapshot(bytes, binding, new Uint8Array(), { compressedBytes: Math.floor(bytes.length / 2), expandedBytes: 100, entries: 10, diffBytes: 100 }), /Compressed/);
  await assert.rejects(prepareSnapshot(bytes, binding, new Uint8Array(), { compressedBytes: 100000, expandedBytes: 4, entries: 10, diffBytes: 100 }), /expanded/);
  await assert.rejects(prepareSnapshot(bytes, binding, new Uint8Array(), { compressedBytes: 100000, expandedBytes: 100, entries: 1, diffBytes: 100 }), /entry count/);
  await assert.rejects(prepareSnapshot(bytes, binding, new Uint8Array(2), { compressedBytes: 100000, expandedBytes: 100, entries: 10, diffBytes: 1 }), /Diff/);
  await assert.rejects(prepareSnapshot(bytes, binding, new Uint8Array(), { compressedBytes: 100000, expandedBytes: 100, entries: 10, diffBytes: 100, manifestBytes: 1 }), /manifest/);
  await assert.rejects(prepareSnapshot(new Uint8Array(), binding, new Uint8Array(), { compressedBytes: 17 * 1024 * 1024, expandedBytes: 1, entries: 1, diffBytes: 1 }), /trusted defaults/);
  const traversal = await archive({ "../escape": "bad" });
  await assert.rejects(prepareSnapshot(traversal, binding, new Uint8Array()), /path/);
});

test("rejects archive symlink escapes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-link-fixture-"));
  try {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "target"), "outside");
    await symlink("../../../../outside", join(dir, "src/escape"));
    const archivePath = join(dir, "links.tar");
    await createTar({ cwd: dir, file: archivePath }, ["target", "src/escape"]);
    await assert.rejects(prepareSnapshot(await readFile(archivePath), binding, new Uint8Array()), /links/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("rejects malformed archives and removes temporary snapshot directories on failure", async () => {
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("jarvis-snapshot-")));
  await assert.rejects(prepareSnapshot(new Uint8Array([1, 2, 3]), binding, new Uint8Array()));
  const after = (await readdir(tmpdir())).filter((name) => name.startsWith("jarvis-snapshot-"));
  assert.deepEqual(after.filter((name) => !before.has(name)), []);
});

test("rejects archive special files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-special-fixture-"));
  try {
    const fifo = join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    const archivePath = join(dir, "special.tar");
    execFileSync("tar", ["-cf", archivePath, "-C", dir, "pipe"]);
    await assert.rejects(prepareSnapshot(await readFile(archivePath), binding, new Uint8Array()), /special file/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("exposes diff bytes only as a cleanup-owned artifact bound to a canonical revision", async () => {
  const bytes = await archive({ "src/a.ts": "a" });
  const diff = new TextEncoder().encode("diff content");
  const prepared = await prepareSnapshot(bytes, binding, diff);
  try {
    assert.deepEqual(new Uint8Array(await readFile(prepared.diffPath)), diff);
    assert.equal(prepared.manifest.repository, "grasdouble/jarvis");
    assert.equal(prepared.manifest.revision, binding.revision);
    assert.equal(prepared.manifest.diffSha256, digestSnapshotFile(diff));
    assert.match(prepared.manifest.snapshotDigest, /^[a-f0-9]{64}$/);
  } finally { await prepared.cleanup(); }
  await assert.rejects(prepareSnapshot(bytes, { ...binding, repository: "bad/path/too/many" }, diff), /repository/);
  await assert.rejects(prepareSnapshot(bytes, { ...binding, revision: "g".repeat(40) }, diff), /revision/);
});

test("rejects duplicate archive paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-duplicate-fixture-"));
  try {
    await writeFile(join(dir, "same.txt"), "content");
    const archivePath = join(dir, "duplicate.tar");
    await createTar({ cwd: dir, file: archivePath }, ["same.txt", "same.txt"]);
    await assert.rejects(prepareSnapshot(await readFile(archivePath), binding, new Uint8Array()), /duplicate path/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
