import assert from "node:assert/strict";
import { test } from "node:test";

import {
  estimatePreparedContextTokens, resolveProviderCatalog, resolveProviderSelection, validateAgentRuntimeRequest,
} from "../dist/index.js";

const capabilities = ["chat-completions", "streaming", "cancellation", "context-budget"];
const catalog = {
  activeProfileId: "copilot",
  profiles: {
    copilot: { modelId: "fixture-copilot", contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities },
    openai: { modelId: "fixture-openai", contextWindowTokens: 16384, maxOutputTokens: 2048, capabilities },
  },
};

test("trusted catalog requires both closed provider profiles and an explicit active selection", () => {
  const resolved = resolveProviderCatalog(catalog);
  assert.equal(resolved.active.id, "copilot");
  assert.equal(resolved.active.providerId, "github-copilot");
  assert.equal(resolved.active.modelId, "fixture-copilot");
  assert.equal(resolved.profiles.openai.providerId, "openai");
  assert.equal(resolveProviderCatalog({ ...catalog, activeProfileId: "openai" }).active.modelId, "fixture-openai");
  assert.throws(() => resolveProviderCatalog({ profiles: catalog.profiles }), /explicit active profile/);
  assert.throws(() => resolveProviderCatalog({ ...catalog, profiles: { copilot: catalog.profiles.copilot } }), /exactly Copilot and OpenAI/);
  assert.throws(() => resolveProviderCatalog({ ...catalog, extra: true }), /closed schema/);
  assert.throws(() => resolveProviderCatalog({
    ...catalog, profiles: { ...catalog.profiles, openai: { ...catalog.profiles.openai, capabilities: ["chat-completions"] } },
  }), /capabilities/);
});

test("downstream selected-profile parsing rejects provider/model identity mismatch", () => {
  const selected = resolveProviderCatalog(catalog).active;
  assert.deepEqual(resolveProviderSelection(selected), selected);
  assert.throws(() => resolveProviderSelection({ ...selected, providerId: "openai" }), /does not match/);
  assert.throws(() => resolveProviderSelection({ ...selected, modelId: "candidate-model", extra: true }), /unknown or missing/);
});

test("context estimate is derived from actual prepared messages and rejects understated input", () => {
  const messages = [{ role: "user", content: "x".repeat(9000) }];
  const estimated = estimatePreparedContextTokens(messages);
  assert.ok(estimated >= 9000);
  const selected = resolveProviderCatalog(catalog).active;
  assert.throws(() => validateAgentRuntimeRequest({
    mode: "plan", messages, maxOutputTokens: 512,
  }, selected), /context budget/);
  const valid = validateAgentRuntimeRequest({
    mode: "dev", messages: [{ role: "user", content: "synthetic" }], maxOutputTokens: 256,
  }, selected);
  assert.equal(valid.mode, "dev");
  assert.equal(Object.hasOwn(valid, "contextTokens"), false);
  assert.throws(() => validateAgentRuntimeRequest({
    mode: "dev", messages: [{ role: "user", content: "synthetic" }], maxOutputTokens: 2048,
  }, selected), /output limit/);
});
