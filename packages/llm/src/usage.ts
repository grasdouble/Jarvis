export type UsageField = "inputTotal" | "outputTotal" | "cacheReadInput" | "cacheWriteInput" | "reasoningOutput";
export type UsageCoverage = "reported" | "estimated" | "unknown" | "not_supported";
export type NormalizedUsage = Readonly<{
  mappingVersion: string;
  counters: Readonly<Record<UsageField, number | null>>;
  coverage: Readonly<Record<UsageField, UsageCoverage>>;
}>;

const unknownCoverage = (): Record<UsageField, UsageCoverage> => ({
  inputTotal: "unknown", outputTotal: "unknown", cacheReadInput: "unknown", cacheWriteInput: "unknown", reasoningOutput: "unknown",
});
const unknownCounters = (): Record<UsageField, number | null> => ({
  inputTotal: null, outputTotal: null, cacheReadInput: null, cacheWriteInput: null, reasoningOutput: null,
});

/** Normalize only the fixed OpenAI-compatible usage envelope; never inspect or retain request/response content. */
export function normalizeOpenAIChatUsage(value: unknown): NormalizedUsage {
  const coverage = unknownCoverage();
  const counters = unknownCounters();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {
    mappingVersion: "openai-chat-completions-v1", counters, coverage,
  };
  const record = value as Record<string, unknown>;
  const usage = record.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return {
    mappingVersion: "openai-chat-completions-v1", counters, coverage,
  };
  const fields = usage as Record<string, unknown>;
  const assign = (field: UsageField, candidate: unknown): void => {
    if (Number.isSafeInteger(candidate) && (candidate as number) >= 0) {
      counters[field] = candidate as number;
      coverage[field] = "reported";
    }
  };
  assign("inputTotal", fields.prompt_tokens);
  assign("outputTotal", fields.completion_tokens);
  const details = fields.prompt_tokens_details;
  if (typeof details === "object" && details !== null && !Array.isArray(details)) {
    assign("cacheReadInput", (details as Record<string, unknown>).cached_tokens);
  }
  const completion = fields.completion_tokens_details;
  if (typeof completion === "object" && completion !== null && !Array.isArray(completion)) {
    assign("reasoningOutput", (completion as Record<string, unknown>).reasoning_tokens);
  }
  return { mappingVersion: "openai-chat-completions-v1", counters, coverage };
}
