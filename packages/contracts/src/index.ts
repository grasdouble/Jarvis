
export type PlanResult = {
  summary: string;
  steps: Array<{ description: string; sources: string[] }>;
  affectedAreas: string[];
  assumptions: string[];
  risks: string[];
  questions: string[];
  limitations: string[];
};
export type PatchResult = {
  summary: string;
  artifactId: string;
  patchDigest: string;
  changedPaths: string[];
  limitations: string[];
};
export type ResultAttribution = {
  schemaVersion: 1;
  requestId: string;
  taskId: string;
  attemptId: string;
  leaseEpoch: number;
  mode: "plan" | "dev";
  sourceRevision: string;
  snapshotDigest: string;
  provider: string;
  model: string;
  resultId: string;
};
export type TrustedResultAttribution = Omit<ResultAttribution, "schemaVersion" | "resultId">;
export type PlanTaskResult = ResultAttribution & { mode: "plan"; payload: PlanResult };
export type DevTaskResult = ResultAttribution & { mode: "dev"; payload: PatchResult };
export type TaskResult = PlanTaskResult | DevTaskResult;
export type TrustedSnapshotBinding = { repository: string; revision: string; snapshotDigest: string; includedPaths: readonly string[] };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
const MAX_BYTES = 32 * 1024;
const MAX_ITEMS = 50;
const MAX_TEXT = 4096;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}
function text(v: unknown, label: string, max = MAX_TEXT): asserts v is string {
  if (typeof v !== "string" || v.length === 0 || utf8ByteLength(v) > max) throw new TypeError(`${label} is invalid or exceeds its limit`);
}
function strings(v: unknown, label: string, path = false): string[] {
  if (!Array.isArray(v) || v.length > MAX_ITEMS) throw new TypeError(`${label} must be a bounded list`);
  for (const item of v) {
    text(item, label);
    if (path && (item.startsWith("/") || item.includes("\\") || /^[A-Za-z]:/.test(item) || item.split("/").some((part: string) => !part || part === "." || part === ".."))) throw new TypeError(`${label} contains an invalid path`);
  }
  return v as string[];
}
function validatePlan(value: unknown, snapshot: TrustedSnapshotBinding): PlanResult {
  const keys = ["summary", "steps", "affectedAreas", "assumptions", "risks", "questions", "limitations"];
  if (!object(value) || !exact(value, keys)) throw new TypeError("Plan payload is not a closed PlanResult");
  text(value.summary, "plan summary");
  if (!Array.isArray(value.steps) || value.steps.length > MAX_ITEMS) throw new TypeError("Plan steps exceed their limit");
  const steps = value.steps.map((step) => {
    if (!object(step) || !exact(step, ["description", "sources"])) throw new TypeError("Plan step is invalid");
    text(step.description, "step description");
    const sources = strings(step.sources, "step sources", true);
    if (sources.some((source) => !snapshot.includedPaths.includes(source))) throw new TypeError("Plan cites a path outside its trusted snapshot");
    return { description: step.description, sources };
  });
  return { summary: value.summary, steps, affectedAreas: strings(value.affectedAreas, "affected areas"), assumptions: strings(value.assumptions, "assumptions"), risks: strings(value.risks, "risks"), questions: strings(value.questions, "questions"), limitations: strings(value.limitations, "limitations") };
}
function validatePatch(value: unknown): PatchResult {
  const keys = ["summary", "artifactId", "patchDigest", "changedPaths", "limitations"];
  if (!object(value) || !exact(value, keys)) throw new TypeError("Dev payload is not a closed PatchResult");
  text(value.summary, "patch summary");
  if (typeof value.artifactId !== "string" || !ID.test(value.artifactId) || typeof value.patchDigest !== "string" || !DIGEST.test(value.patchDigest)) throw new TypeError("Dev artifact reference is invalid");
  return { summary: value.summary, artifactId: value.artifactId, patchDigest: value.patchDigest, changedPaths: strings(value.changedPaths, "changed paths", true), limitations: strings(value.limitations, "limitations") };
}
/** Validate untrusted output against mandatory core attribution and a trusted plan snapshot binding. */
export function validateTaskResult(value: unknown, options: { snapshot?: TrustedSnapshotBinding; expected: TrustedResultAttribution }): TaskResult {
  if (!object(value) || !exact(value, ["schemaVersion", "requestId", "taskId", "attemptId", "leaseEpoch", "mode", "sourceRevision", "snapshotDigest", "provider", "model", "resultId", "payload"])) throw new TypeError("Task result envelope is not closed");
  if (value.schemaVersion !== 1 || ![value.requestId, value.taskId, value.attemptId, value.resultId].every((id) => typeof id === "string" && ID.test(id))) throw new TypeError("Task result identity is invalid");
  if (!Number.isSafeInteger(value.leaseEpoch) || (value.leaseEpoch as number) < 1 || (value.mode !== "plan" && value.mode !== "dev") || typeof value.sourceRevision !== "string" || !REVISION.test(value.sourceRevision)) throw new TypeError("Task result lease, mode, or revision is invalid");
  text(value.provider, "provider", 80); text(value.model, "model", 120);
  if (typeof value.snapshotDigest !== "string" || !DIGEST.test(value.snapshotDigest)) throw new TypeError("Task result snapshot digest is invalid");
  for (const [key, expected] of Object.entries(options.expected)) if (value[key] !== expected) throw new TypeError(`Task result ${key} attribution mismatch`);
  let payload: PlanResult | PatchResult;
  if (value.mode === "plan") {
    if (!options.snapshot || options.snapshot.revision !== value.sourceRevision || options.snapshot.snapshotDigest !== value.snapshotDigest ||
        !REVISION.test(options.snapshot.revision) || !DIGEST.test(options.snapshot.snapshotDigest)) throw new TypeError("Plan result lacks its trusted snapshot binding");
    payload = validatePlan(value.payload, options.snapshot);
  } else payload = validatePatch(value.payload);
  const result = { schemaVersion: 1 as const, requestId: value.requestId as string, taskId: value.taskId as string, attemptId: value.attemptId as string, leaseEpoch: value.leaseEpoch as number, mode: value.mode, sourceRevision: value.sourceRevision, snapshotDigest: value.snapshotDigest, provider: value.provider as string, model: value.model as string, resultId: value.resultId as string, payload } as TaskResult;
  if (utf8ByteLength(JSON.stringify(result)) > MAX_BYTES) throw new TypeError(`Task result exceeds ${MAX_BYTES} bytes`);
  return result;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function canonicalizeTaskResult(result: TaskResult): string { return canonicalJson(result); }
