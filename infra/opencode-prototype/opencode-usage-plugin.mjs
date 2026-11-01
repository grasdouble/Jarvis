const MAX_USAGE_BYTES = 1024 * 1024;
const MAX_COUNTER = 2_147_483_647;

function numeric(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTER ? value : undefined;
}

function usageFrom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = numeric(value.prompt_tokens ?? value.input_tokens);
  const output = numeric(value.completion_tokens ?? value.output_tokens);
  const cacheRead = numeric(value.prompt_tokens_details?.cached_tokens ?? value.input_tokens_details?.cached_tokens);
  const cacheWrite = numeric(value.prompt_tokens_details?.cache_write_tokens ?? value.input_tokens_details?.cache_write_tokens);
  const reasoning = numeric(value.completion_tokens_details?.reasoning_tokens ?? value.output_tokens_details?.reasoning_tokens);
  const result = {};
  if (input !== undefined) result.inputTotal = input;
  if (output !== undefined) result.outputTotal = output;
  if (cacheRead !== undefined) result.cacheReadInput = cacheRead;
  if (cacheWrite !== undefined) result.cacheWriteInput = cacheWrite;
  if (reasoning !== undefined) result.reasoningOutput = reasoning;
  return Object.keys(result).length === 0 ? undefined : result;
}

async function runtimeUsage(response) {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_USAGE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  try {
    const parsed = JSON.parse(text);
    const usage = usageFrom(parsed?.usage);
    if (usage) return usage;
  } catch { /* The response may be an SSE stream. */ }
  let latest;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      const usage = usageFrom(parsed?.usage);
      if (usage) latest = usage;
    } catch { /* Ignore non-JSON SSE events and retain no event content. */ }
  }
  return latest;
}

function reportRuntimeUsage(response, dispatchId) {
  void (async () => {
    try {
      const usage = await runtimeUsage(response.clone());
      if (!usage) return;
      await fetch("http://127.0.0.1:4010/__jarvis/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dispatchId, usage }),
        signal: AbortSignal.timeout(3_000),
      });
    } catch { /* Missing runtime evidence remains unknown; never affect model response handling. */ }
  })();
}

export const JarvisUsagePlugin = async () => ({
  "http.response": async ({ response }) => {
    const dispatchId = response.headers.get("x-jarvis-dispatch-id");
    if (!dispatchId || process.env.LLM_GATEWAY_PROFILE_ID !== "openai") return;
    reportRuntimeUsage(response, dispatchId);
  },
});

export default JarvisUsagePlugin;
