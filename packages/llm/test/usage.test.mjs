import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeOpenAIChatUsage } from "../dist/index.js";

test("OpenAI usage totals include cache and reasoning subsets without double counting", () => {
  const usage = normalizeOpenAIChatUsage({ usage: {
    prompt_tokens: 2_000,
    completion_tokens: 300,
    prompt_tokens_details: { cached_tokens: 1_500 },
    completion_tokens_details: { reasoning_tokens: 100 },
  } });
  assert.deepEqual(usage.counters, {
    inputTotal: 2_000, outputTotal: 300, cacheReadInput: 1_500, cacheWriteInput: null, reasoningOutput: 100,
  });
  assert.deepEqual(usage.coverage, {
    inputTotal: "reported", outputTotal: "reported", cacheReadInput: "reported",
    cacheWriteInput: "unknown", reasoningOutput: "reported",
  });
});

test("missing and malformed usage remains unknown and zero is reported, not missing", () => {
  const missing = normalizeOpenAIChatUsage({ usage: { prompt_tokens: -1, completion_tokens: "0" } });
  assert.equal(missing.counters.inputTotal, null);
  assert.equal(missing.coverage.inputTotal, "unknown");
  assert.equal(missing.counters.outputTotal, null);
  assert.equal(missing.coverage.outputTotal, "unknown");
  const zero = normalizeOpenAIChatUsage({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
  assert.equal(zero.counters.inputTotal, 0);
  assert.equal(zero.coverage.inputTotal, "reported");
  assert.equal(zero.counters.outputTotal, 0);
  assert.equal(zero.coverage.outputTotal, "reported");
});
