import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "./opencode-usage-plugin.mjs";

test("runtime adapter reports allowlisted OpenAI counters with the response dispatch ID", async () => {
  const originalFetch = globalThis.fetch;
  const originalCapability = process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY;
  const originalProfile = process.env.LLM_GATEWAY_PROFILE_ID;
  const requests = [];
  process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY = "attempt-capability";
  process.env.LLM_GATEWAY_PROFILE_ID = "openai";
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  };
  try {
    const hooks = await plugin();
    const dispatchId = "f6a6d82b-5d4a-4dc2-b780-6d331458e108";
    const response = Response.json({
      choices: [{ message: { content: "secret response text" } }],
      usage: { prompt_tokens: 17, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 }, completion_tokens_details: { reasoning_tokens: 2 } },
    }, { headers: { "x-jarvis-dispatch-id": dispatchId } });
    await hooks["http.response"]({ response });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:4010/__jarvis/usage");
    assert.equal(requests[0].init.headers["content-type"], "application/json");
    assert.equal(Object.hasOwn(requests[0].init.headers, "authorization"), false, "broker keeps its bearer secret out of OpenCode");
    assert.deepEqual(requests[0].body, {
      dispatchId,
      usage: { inputTotal: 17, outputTotal: 5, cacheReadInput: 8, reasoningOutput: 2 },
    });
    assert.equal(JSON.stringify(requests[0].body).includes("secret response text"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCapability === undefined) delete process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY;
    else process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY = originalCapability;
    if (originalProfile === undefined) delete process.env.LLM_GATEWAY_PROFILE_ID;
    else process.env.LLM_GATEWAY_PROFILE_ID = originalProfile;
  }
});

test("runtime adapter leaves OpenAI-shaped counters unknown for Copilot", async () => {
  const originalFetch = globalThis.fetch;
  const originalCapability = process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY;
  const originalProfile = process.env.LLM_GATEWAY_PROFILE_ID;
  const requests = [];
  process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY = "attempt-capability";
  process.env.LLM_GATEWAY_PROFILE_ID = "copilot";
  globalThis.fetch = async (...args) => { requests.push(args); return new Response(null, { status: 204 }); };
  try {
    const hooks = await plugin();
    await hooks["http.response"]({ response: Response.json({
      usage: { prompt_tokens: 17, completion_tokens: 5 },
    }, { headers: { "x-jarvis-dispatch-id": "f6a6d82b-5d4a-4dc2-b780-6d331458e108" } }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCapability === undefined) delete process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY;
    else process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY = originalCapability;
    if (originalProfile === undefined) delete process.env.LLM_GATEWAY_PROFILE_ID;
    else process.env.LLM_GATEWAY_PROFILE_ID = originalProfile;
  }
});

test("runtime observation does not delay or pre-consume incremental provider response chunks", async () => {
  const originalFetch = globalThis.fetch;
  const originalCapability = process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY;
  const originalProfile = process.env.LLM_GATEWAY_PROFILE_ID;
  const requests = [];
  let releaseSecondChunk;
  let secondChunkReleased = false;
  const secondChunk = new Promise((resolve) => { releaseSecondChunk = resolve; });
  process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY = "attempt-capability";
  process.env.LLM_GATEWAY_PROFILE_ID = "openai";
  globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); };
  try {
    let pulls = 0;
    const response = new Response(new ReadableStream({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('{"usage":{"prompt_tokens":17,'));
          return;
        }
        await secondChunk;
        secondChunkReleased = true;
        controller.enqueue(new TextEncoder().encode('"completion_tokens":5}}'));
        controller.close();
      },
    }), { headers: { "x-jarvis-dispatch-id": "f6a6d82b-5d4a-4dc2-b780-6d331458e108" } });
    const hooks = await plugin();
    await hooks["http.response"]({ response });
    assert.equal(secondChunkReleased, false, "hook returns without awaiting provider stream completion");
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), '{"usage":{"prompt_tokens":17,');
    releaseSecondChunk();
    const delivered = [first.value];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      delivered.push(value);
    }
    assert.equal(new TextDecoder().decode(Buffer.concat(delivered)), '{"usage":{"prompt_tokens":17,"completion_tokens":5}}');
    for (let index = 0; index < 20 && requests.length === 0; index += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requests, [{
      dispatchId: "f6a6d82b-5d4a-4dc2-b780-6d331458e108",
      usage: { inputTotal: 17, outputTotal: 5 },
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCapability === undefined) delete process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY;
    else process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY = originalCapability;
    if (originalProfile === undefined) delete process.env.LLM_GATEWAY_PROFILE_ID;
    else process.env.LLM_GATEWAY_PROFILE_ID = originalProfile;
  }
});

test("runtime observation abandons oversized bodies without reporting", async () => {
  const originalFetch = globalThis.fetch;
  const originalCapability = process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY;
  const originalProfile = process.env.LLM_GATEWAY_PROFILE_ID;
  const requests = [];
  process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY = "attempt-capability";
  process.env.LLM_GATEWAY_PROFILE_ID = "openai";
  globalThis.fetch = async (...args) => { requests.push(args); return new Response(null, { status: 204 }); };
  try {
    let pulls = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(256 * 1024));
      },
    }), { headers: { "x-jarvis-dispatch-id": "f6a6d82b-5d4a-4dc2-b780-6d331458e108" } });
    const hooks = await plugin();
    await hooks["http.response"]({ response });
    for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
    const observedPulls = pulls;
    for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pulls, observedPulls, "observer stops pulling after its bounded observation is discarded");
    assert.ok(pulls <= 12, "observer does not buffer the complete oversized response");
    assert.equal(requests.length, 0);
    assert.equal((await response.body.getReader().read()).done, false, "provider response remains independently readable");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCapability === undefined) delete process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY;
    else process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY = originalCapability;
    if (originalProfile === undefined) delete process.env.LLM_GATEWAY_PROFILE_ID;
    else process.env.LLM_GATEWAY_PROFILE_ID = originalProfile;
  }
});

test("runtime adapter does not report absent IDs, missing usage or response text", async () => {
  const originalFetch = globalThis.fetch;
  const originalCapability = process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY;
  const originalProfile = process.env.LLM_GATEWAY_PROFILE_ID;
  const requests = [];
  process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY = "attempt-capability";
  process.env.LLM_GATEWAY_PROFILE_ID = "openai";
  globalThis.fetch = async (...args) => { requests.push(args); return new Response(null, { status: 204 }); };
  try {
    const hooks = await plugin();
    await hooks["http.response"]({ response: Response.json({ text: "secret" }) });
    await hooks["http.response"]({ response: Response.json({ usage: {} }, { headers: { "x-jarvis-dispatch-id": "f6a6d82b-5d4a-4dc2-b780-6d331458e108" } }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCapability === undefined) delete process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY;
    else process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY = originalCapability;
    if (originalProfile === undefined) delete process.env.LLM_GATEWAY_PROFILE_ID;
    else process.env.LLM_GATEWAY_PROFILE_ID = originalProfile;
  }
});
