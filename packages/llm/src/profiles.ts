export const PROVIDER_PROFILE_IDS = ["copilot", "openai"] as const;
export type ProviderProfileId = typeof PROVIDER_PROFILE_IDS[number];
export type ProviderCapability = "chat-completions" | "streaming" | "cancellation" | "context-budget";
export const REQUIRED_PROVIDER_CAPABILITIES: readonly ProviderCapability[] = Object.freeze([
  "chat-completions", "streaming", "cancellation", "context-budget",
]);

export type ProviderProfileConfiguration = Readonly<{
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  capabilities: readonly ProviderCapability[];
}>;
export type TrustedProviderCatalogConfiguration = Readonly<{
  activeProfileId: ProviderProfileId;
  profiles: Readonly<Record<ProviderProfileId, ProviderProfileConfiguration>>;
}>;
export type ProviderProfile = Readonly<{
  id: ProviderProfileId;
  providerId: "github-copilot" | "openai";
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  capabilities: readonly ProviderCapability[];
}>;
export type ProviderCatalog = Readonly<{
  activeProfileId: ProviderProfileId;
  profiles: Readonly<Record<ProviderProfileId, ProviderProfile>>;
  active: ProviderProfile;
}>;

const PROVIDERS: Readonly<Record<ProviderProfileId, ProviderProfile["providerId"]>> = Object.freeze({
  copilot: "github-copilot",
  openai: "openai",
});
const profileKeys = ["capabilities", "contextWindowTokens", "maxOutputTokens", "modelId"];
const catalogKeys = ["activeProfileId", "profiles"];

function parseProfile(id: ProviderProfileId, input: unknown): ProviderProfile {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Trusted provider profile must be an object.");
  }
  const config = input as Record<string, unknown>;
  if (Object.keys(config).sort().join(",") !== profileKeys.join(",")) {
    throw new TypeError("Trusted provider profile has unknown or missing fields.");
  }
  if (typeof config.modelId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(config.modelId)) {
    throw new TypeError("Trusted provider model identifier is invalid.");
  }
  const contextWindowTokens = config.contextWindowTokens;
  const maxOutputTokens = config.maxOutputTokens;
  if (!Number.isSafeInteger(contextWindowTokens) || (contextWindowTokens as number) < 1 ||
      (contextWindowTokens as number) > 1_000_000 || !Number.isSafeInteger(maxOutputTokens) ||
      (maxOutputTokens as number) < 1 || (maxOutputTokens as number) > 1_000_000 ||
      (maxOutputTokens as number) >= (contextWindowTokens as number)) {
    throw new TypeError("Trusted provider profile context/output budget is invalid.");
  }
  if (!Array.isArray(config.capabilities) || config.capabilities.some((capability) => typeof capability !== "string") ||
      new Set(config.capabilities).size !== config.capabilities.length) {
    throw new TypeError("Trusted provider profile capabilities are invalid.");
  }
  const capabilities = config.capabilities as string[];
  if (capabilities.some((capability) => !REQUIRED_PROVIDER_CAPABILITIES.includes(capability as ProviderCapability)) ||
      REQUIRED_PROVIDER_CAPABILITIES.some((capability) => !capabilities.includes(capability))) {
    throw new TypeError("Selected provider profile does not meet the required runtime capabilities.");
  }
  return Object.freeze({
    id,
    providerId: PROVIDERS[id],
    modelId: config.modelId,
    contextWindowTokens: contextWindowTokens as number,
    maxOutputTokens: maxOutputTokens as number,
    capabilities: Object.freeze([...REQUIRED_PROVIDER_CAPABILITIES]),
  });
}

/** Resolve a closed owner-controlled catalog with both providers and one explicit active profile. */
export function resolveProviderCatalog(input: unknown): ProviderCatalog {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Trusted provider catalog must be an object.");
  }
  const config = input as Record<string, unknown>;
  if (Object.keys(config).sort().join(",") !== catalogKeys.join(",") ||
      (config.activeProfileId !== "copilot" && config.activeProfileId !== "openai")) {
    throw new TypeError("Trusted provider catalog requires one explicit active profile and a closed schema.");
  }
  if (typeof config.profiles !== "object" || config.profiles === null || Array.isArray(config.profiles)) {
    throw new TypeError("Trusted provider catalog must contain both profile configurations.");
  }
  const rawProfiles = config.profiles as Record<string, unknown>;
  if (Object.keys(rawProfiles).sort().join(",") !== [...PROVIDER_PROFILE_IDS].sort().join(",")) {
    throw new TypeError("Trusted provider catalog must contain exactly Copilot and OpenAI profiles.");
  }
  const profiles = Object.freeze({
    copilot: parseProfile("copilot", rawProfiles.copilot),
    openai: parseProfile("openai", rawProfiles.openai),
  });
  const activeProfileId = config.activeProfileId;
  return Object.freeze({ activeProfileId, profiles, active: profiles[activeProfileId] });
}

/** Parse a serialized selected profile at a downstream trusted boundary and verify derived provider identity. */
export function resolveProviderSelection(input: unknown): ProviderProfile {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Selected provider profile must be an object.");
  }
  const value = input as Record<string, unknown>;
  const keys = ["capabilities", "contextWindowTokens", "id", "modelId", "providerId", "maxOutputTokens"];
  if (Object.keys(value).sort().join(",") !== keys.sort().join(",")) {
    throw new TypeError("Selected provider profile has unknown or missing fields.");
  }
  if (value.id !== "copilot" && value.id !== "openai") throw new TypeError("Selected provider profile is unsupported.");
  const { providerId, ...configWithId } = value;
  const config = { ...configWithId };
  delete config.id;
  const profile = parseProfile(value.id, config);
  if (providerId !== profile.providerId) throw new TypeError("Selected provider identity does not match its trusted profile.");
  return profile;
}
