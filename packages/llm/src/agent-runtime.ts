import type { ProviderProfile, ProviderProfileId } from "./profiles.js";

export type AgentMode = "plan" | "dev";
export type AgentMessage = Readonly<{ role: string; content: unknown }>;
export type AgentRuntimeRequest = Readonly<{
  mode: AgentMode;
  messages: readonly AgentMessage[];
  maxOutputTokens: number;
}>;
export type ProviderUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  provenance: "opencode-response";
  observedAt: string;
}>;

/** Shared, deliberately untrusted model-result transport envelope for plan and dev. */
export type AgentRuntimeResult = Readonly<{
  mode: AgentMode;
  profileId: ProviderProfileId;
  providerId: ProviderProfile["providerId"];
  modelId: string;
  resultText: string;
  usage?: ProviderUsage;
}>;

/**
 * Conservative context estimate for the exact serialized message payload sent to OpenCode/the gateway.
 * UTF-8 bytes are counted as at most one text token each, plus framing allowance per message and request.
 * This is not an exact provider tokenizer and must not be presented as provider-reported token usage.
 */
export function estimatePreparedContextTokens(messages: unknown): number {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 256) {
    throw new TypeError("Prepared message list is invalid or exceeds its item bound.");
  }
  let serialized: string;
  try { serialized = JSON.stringify(messages); }
  catch { throw new TypeError("Prepared messages are not JSON serializable."); }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  const estimate = bytes + messages.length * 16 + 256;
  if (!Number.isSafeInteger(estimate)) throw new TypeError("Prepared message context estimate is invalid.");
  return estimate;
}

/** Validate caller-side mode/output shape; context is always derived from actual prepared messages downstream. */
export function validateAgentRuntimeRequest(value: unknown, profile: ProviderProfile): AgentRuntimeRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Agent runtime request is invalid.");
  const request = value as Record<string, unknown>;
  if (Object.keys(request).sort().join(",") !== ["maxOutputTokens", "messages", "mode"].join(",") ||
      (request.mode !== "plan" && request.mode !== "dev") || !Array.isArray(request.messages) ||
      !Number.isSafeInteger(request.maxOutputTokens) || (request.maxOutputTokens as number) < 1 ||
      (request.maxOutputTokens as number) > profile.maxOutputTokens) {
    throw new TypeError("Agent runtime request has an invalid mode, schema, or output limit.");
  }
  const estimate = estimatePreparedContextTokens(request.messages);
  if (estimate + (request.maxOutputTokens as number) > profile.contextWindowTokens) {
    throw new RangeError("Prepared messages and output limit exceed the selected profile context budget.");
  }
  return Object.freeze({
    mode: request.mode,
    messages: request.messages as AgentMessage[],
    maxOutputTokens: request.maxOutputTokens as number,
  });
}
