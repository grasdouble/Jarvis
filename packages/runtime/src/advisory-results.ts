import { createHash } from "node:crypto";

export type RepositoryBinding = { repository: string; revision: string };
export type SnapshotFile = { path: string; sha256: string };
export type AdvisorySnapshotBinding = RepositoryBinding & { snapshotDigest: string; diffSha256: string; diffBytes: number; excludedPaths: readonly string[]; files: readonly SnapshotFile[] };
export type PlanResult = RepositoryBinding & { kind: "plan"; snapshotDigest: string; complete: boolean; limitations: string[]; steps: Array<{ description: string; sourcePaths: string[] }>; affectedAreas: string[]; assumptions: string[]; risks: string[]; unresolvedQuestions: string[] };
export type PrAnalysisResult = RepositoryBinding & { kind: "pr-analysis"; snapshotDigest: string; complete: boolean; limitations: string[]; uncertainty: string[]; examinedPaths: string[]; findings: Array<{ severity: "info" | "low" | "medium" | "high"; summary: string; sourcePaths: string[] }> };
export type AdvisoryEvidence = PlanResult | PrAnalysisResult;

export const PLAN_CAPABILITIES = Object.freeze({ repositoryRead: true, diffRead: true, githubRead: false, workspaceWrite: false, githubMutation: false, publication: false, devEscalation: false, pluginAutoload: false, commandAutoload: false });
export const PR_ANALYSIS_CAPABILITIES = Object.freeze({ repositoryRead: true, diffRead: true, githubRead: false, workspaceWrite: false, githubMutation: false, publication: false, devEscalation: false, pluginAutoload: false, commandAutoload: false });
const readonlyPermissions = Object.freeze([
  Object.freeze({ action: "*", resource: "*", effect: "deny" }),
  Object.freeze({ action: "read", resource: "*", effect: "allow" }),
  Object.freeze({ action: "glob", resource: "*", effect: "allow" }),
  Object.freeze({ action: "grep", resource: "*", effect: "allow" }),
  Object.freeze({ action: "edit", resource: "*", effect: "deny" }),
  Object.freeze({ action: "shell", resource: "*", effect: "deny" }),
]);
type ReadOnlyOpenCodeConfig = Readonly<{ default_agent: "plan" | "review"; agents: Readonly<Record<string, Readonly<{ mode: "primary"; permissions: typeof readonlyPermissions }>>>; permissions: typeof readonlyPermissions; plugin: readonly string[]; mcp: Readonly<Record<string, never>> }>;
const readonlyConfig = (agent: "plan" | "review"): ReadOnlyOpenCodeConfig => Object.freeze({
  default_agent: agent,
  agents: Object.freeze({
    [agent]: Object.freeze({
      mode: "primary",
      permissions: readonlyPermissions,
    }),
  }),
  permissions: readonlyPermissions,
  plugin: Object.freeze([] as string[]),
  mcp: Object.freeze({}),
});
export const READ_ONLY_ANALYSIS_PROFILES = Object.freeze({
  plan: Object.freeze({ profile: "advisory-plan-read-only", agent: "plan", repositoryRead: true, diffRead: true, githubRead: false, workspaceWrite: false, githubMutation: false, publication: false, tools: Object.freeze(["read", "glob", "grep"]), pluginAutoload: false, skillAutoload: false, commandAutoload: false, devEscalation: false, openCodeConfig: readonlyConfig("plan") }),
  prAnalysis: Object.freeze({ profile: "advisory-pr-analysis-read-only", agent: "review", repositoryRead: true, diffRead: true, githubRead: false, workspaceWrite: false, githubMutation: false, publication: false, tools: Object.freeze(["read", "glob", "grep"]), pluginAutoload: false, skillAutoload: false, commandAutoload: false, devEscalation: false, openCodeConfig: readonlyConfig("review") }),
});
export type ReadOnlyAnalysisMode = "plan" | "pr-analysis";
export function getReadOnlyAnalysisProfile(mode: ReadOnlyAnalysisMode): ReadOnlyAnalysisProfile {
  if (mode === "plan") return READ_ONLY_ANALYSIS_PROFILES.plan;
  if (mode === "pr-analysis") return READ_ONLY_ANALYSIS_PROFILES.prAnalysis;
  throw new AdvisoryResultError("An explicit plan or PR-analysis mode is required.");
}
export type ReadOnlyAnalysisProfile = typeof READ_ONLY_ANALYSIS_PROFILES[keyof typeof READ_ONLY_ANALYSIS_PROFILES];

export class AdvisoryResultError extends Error {
  constructor(message: string) { super(message); this.name = "AdvisoryResultError"; }
}

const canonicalRepository = (value: unknown): boolean => typeof value === "string" && value.length <= 140 && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]{0,98}[a-z0-9])?$/.test(value);
const validPath = (path: unknown): boolean => typeof path === "string" && path.length <= 1024 && path.length > 0 && !path.startsWith("/") && !/^[a-zA-Z]:/.test(path) && !path.includes("\\") && !path.split("/").some((part) => part === "" || part === "." || part === "..");
const validBinding = (repository: unknown, revision: unknown): boolean => canonicalRepository(repository) && typeof revision === "string" && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(revision);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const utf8Size = (value: string): number => Buffer.byteLength(value, "utf8");
const LIMITS = Object.freeze({ itemCount: 50, itemBytes: 4096, totalBytes: 32 * 1024 });

export function computeSnapshotDigest(repository: string, revision: string, files: readonly SnapshotFile[], excludedPaths: readonly string[], diffSha256: string, diffBytes: number): string {
  if (!canonicalRepository(repository) || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(revision) || !Array.isArray(files) || files.length > 10_000 || !Array.isArray(excludedPaths) || excludedPaths.length > 10_000 || !Number.isSafeInteger(diffBytes) || diffBytes < 0 || !/^[a-f0-9]{64}$/.test(diffSha256)) throw new AdvisoryResultError("Snapshot identity fields exceed limits or are invalid.");
  let manifestBytes = 0;
  const pathKeys = new Set<string>();
  for (const candidate of files as readonly unknown[]) {
    if (!record(candidate) || !exactKeys(candidate, ["path", "sha256"]) || !validPath(candidate.path) || typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256)) throw new AdvisoryResultError("Snapshot path manifest contains malformed file data.");
    const path = candidate.path as string;
    const filesystemPath = path.normalize("NFKC").toLowerCase();
    if (pathKeys.has(filesystemPath)) throw new AdvisoryResultError("Snapshot paths are filesystem-equivalent.");
    pathKeys.add(filesystemPath);
    manifestBytes += utf8Size(path) + 64;
  }
  for (const path of excludedPaths) {
    if (!validPath(path)) throw new AdvisoryResultError("Excluded path is malformed.");
    manifestBytes += utf8Size(path);
  }
  if (manifestBytes > 2 * 1024 * 1024) throw new AdvisoryResultError("Snapshot path manifest exceeds its byte limit.");
  return createHash("sha256").update(JSON.stringify({ repository, revision, files, excludedPaths, diffSha256, diffBytes }), "utf8").digest("hex");
}

function validateStringList(value: unknown, label: string, pathList = false): string[] {
  if (!Array.isArray(value) || value.length > LIMITS.itemCount) throw new AdvisoryResultError(`${label} exceeds its item limit.`);
  let total = 0;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || (pathList && !validPath(item))) throw new AdvisoryResultError(`${label} contains malformed text or path.`);
    const bytes = utf8Size(item);
    total += bytes;
    if (bytes > LIMITS.itemBytes || total > LIMITS.totalBytes || seen.has(item)) throw new AdvisoryResultError(`${label} exceeds byte limits or contains duplicates.`);
    seen.add(item);
  }
  return [...value] as string[];
}

function validatePlanSteps(value: unknown, included: ReadonlySet<string>): PlanResult["steps"] {
  if (!Array.isArray(value) || value.length > LIMITS.itemCount) throw new AdvisoryResultError("Plan steps exceed their item limit.");
  let totalBytes = 0;
  return value.map((step) => {
    if (!record(step) || !exactKeys(step, ["description", "sourcePaths"]) || typeof step.description !== "string" || step.description.length === 0 || utf8Size(step.description) > LIMITS.itemBytes) throw new AdvisoryResultError("Plan step is malformed or over limit.");
    const sourcePaths = validateStringList(step.sourcePaths, "step sourcePaths", true);
    if (sourcePaths.length === 0 || sourcePaths.some((path) => !included.has(path))) throw new AdvisoryResultError("Every plan step must cite included source paths.");
    totalBytes += utf8Size(step.description) + sourcePaths.reduce((sum, path) => sum + utf8Size(path), 0);
    if (totalBytes > LIMITS.totalBytes) throw new AdvisoryResultError("Plan step evidence exceeds its aggregate byte limit.");
    return { description: step.description, sourcePaths };
  });
}

/** Validate untrusted model output against an exact snapshot identity and included-file manifest. */
export function validateAdvisoryResult(value: unknown, snapshot: AdvisorySnapshotBinding, expectedKind: "plan" | "pr-analysis"): AdvisoryEvidence {
  if (expectedKind !== "plan" && expectedKind !== "pr-analysis") throw new AdvisoryResultError("Unknown advisory result kind.");
  if (!validBinding(snapshot.repository, snapshot.revision) || !/^[a-f0-9]{64}$/.test(snapshot.snapshotDigest) || !/^[a-f0-9]{64}$/.test(snapshot.diffSha256) || !Number.isSafeInteger(snapshot.diffBytes) || snapshot.diffBytes < 0 || !Array.isArray(snapshot.files) || snapshot.files.length > 10_000 || !Array.isArray(snapshot.excludedPaths) || snapshot.excludedPaths.length > 10_000) throw new AdvisoryResultError("Snapshot binding is malformed.");
  let previousPath = "";
  for (const file of snapshot.files) {
    const path = file.path;
    const sha256 = file.sha256;
    if (!record(file) || !exactKeys(file, ["path", "sha256"]) || typeof path !== "string" || !validPath(path) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) || path <= previousPath) throw new AdvisoryResultError("Snapshot file manifest is invalid, duplicate, or unsorted.");
    previousPath = path;
  }
  let previousExcludedPath = "";
  for (const path of snapshot.excludedPaths) {
    if (!validPath(path) || path <= previousExcludedPath) throw new AdvisoryResultError("Excluded paths are invalid, duplicate, or unsorted.");
    previousExcludedPath = path;
  }
  if (computeSnapshotDigest(snapshot.repository, snapshot.revision, snapshot.files, snapshot.excludedPaths, snapshot.diffSha256, snapshot.diffBytes) !== snapshot.snapshotDigest) throw new AdvisoryResultError("Snapshot identity does not match its manifest and diff.");
  const base = ["kind", "repository", "revision", "snapshotDigest", "complete", "limitations"];
  const keys = expectedKind === "plan" ? [...base, "steps", "affectedAreas", "assumptions", "risks", "unresolvedQuestions"] : [...base, "uncertainty", "examinedPaths", "findings"];
  if (!record(value) || !exactKeys(value, keys) || value.kind !== expectedKind || value.repository !== snapshot.repository || value.revision !== snapshot.revision || value.snapshotDigest !== snapshot.snapshotDigest || typeof value.complete !== "boolean") throw new AdvisoryResultError("Advisory result has an invalid or mismatched closed schema.");
  const limitations = validateStringList(value.limitations, "limitations");
  if (value.complete === true && limitations.length !== 0) throw new AdvisoryResultError("A limited result cannot be declared complete.");
  if (value.complete === false && limitations.length === 0) throw new AdvisoryResultError("An incomplete result must declare its limitations.");
  if (expectedKind === "plan") {
    const included = new Set(snapshot.files.map((file) => file.path));
    const steps = validatePlanSteps(value.steps, included);
    const affectedAreas = validateStringList(value.affectedAreas, "affectedAreas", true);
    if (affectedAreas.some((path) => !included.has(path))) throw new AdvisoryResultError("Plan affected areas must reference included snapshot files.");
    return { kind: "plan", repository: snapshot.repository, revision: snapshot.revision, snapshotDigest: snapshot.snapshotDigest, complete: value.complete, limitations,
      steps, affectedAreas, assumptions: validateStringList(value.assumptions, "assumptions"), risks: validateStringList(value.risks, "risks"), unresolvedQuestions: validateStringList(value.unresolvedQuestions, "unresolvedQuestions") };
  }
  const included = new Set(snapshot.files.map((file) => file.path));
  const uncertainty = validateStringList(value.uncertainty, "uncertainty");
  const examinedPaths = validateStringList(value.examinedPaths, "examinedPaths", true);
  if (examinedPaths.some((path) => !included.has(path))) throw new AdvisoryResultError("Analysis references a source outside the bound snapshot.");
  if (!Array.isArray(value.findings) || value.findings.length > LIMITS.itemCount) throw new AdvisoryResultError("Findings exceed their item limit.");
  let totalBytes = 0;
  const findings = value.findings.map((item) => {
    if (!record(item) || !exactKeys(item, ["severity", "summary", "sourcePaths"]) || !["info", "low", "medium", "high"].includes(String(item.severity)) || typeof item.summary !== "string" || item.summary.length === 0 || utf8Size(item.summary) > LIMITS.itemBytes || !Array.isArray(item.sourcePaths) || item.sourcePaths.length === 0 || item.sourcePaths.length > LIMITS.itemCount || !item.sourcePaths.every((path) => validPath(path) && included.has(path))) throw new AdvisoryResultError("Finding is malformed, over limit, or outside the bound snapshot.");
    totalBytes += utf8Size(item.summary) + item.sourcePaths.reduce((sum, path) => sum + utf8Size(path), 0);
    if (totalBytes > LIMITS.totalBytes || new Set(item.sourcePaths).size !== item.sourcePaths.length) throw new AdvisoryResultError("Findings exceed byte limits or contain duplicate paths.");
    return { severity: item.severity as PrAnalysisResult["findings"][number]["severity"], summary: item.summary, sourcePaths: [...item.sourcePaths] as string[] };
  });
  return { kind: "pr-analysis", repository: snapshot.repository, revision: snapshot.revision, snapshotDigest: snapshot.snapshotDigest, complete: value.complete, limitations, uncertainty, examinedPaths, findings };
}

export function digestSnapshotFile(contents: Uint8Array): string { return createHash("sha256").update(contents).digest("hex"); }
