import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveProviderCatalog, resolveProviderSelection } from "@jarvis/llm";
import { createBoundedGateway, createUnixSocketFetch } from "../dist/gateway.js";

const capabilities = ["chat-completions", "streaming", "cancellation", "context-budget"];
const configFor = (activeProfileId) => ({
  activeProfileId,
  profiles: {
    copilot: { modelId: "fixture-copilot", contextWindowTokens: 4096, maxOutputTokens: 512, capabilities },
    openai: { modelId: "fixture-openai", contextWindowTokens: 4096, maxOutputTokens: 512, capabilities },
  },
});
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;

for (const profileId of ["copilot", "openai"]) {
  test(`${profileId} active catalog profile binds provider/model, bounded plan/dev payload and no-failover atomically`, async () => {
    const catalog = resolveProviderCatalog(configFor(profileId));
    const selected = catalog.active;
    const directory = await mkdtemp(join(tmpdir(), "jarvis-provider-profile-"));
    const socketPath = join(directory, "gateway.sock");
    const dispatches = [];
    const gateway = createBoundedGateway({
      socketPath, capability: "fixture-attempt-capability", profile: selected,
      maxInputBytes: 16 * 1024, maxOutputTokens: selected.maxOutputTokens, maxRequests: 4,
      dispatchToFilter: {
        async dispatch(request) {
          dispatches.push({ providerId: request.providerId, body: JSON.parse(globalThis.Buffer.from(request.body).toString("utf8")) });
          return new globalThis.Response(new globalThis.ReadableStream({
            start(controller) {
              controller.enqueue(new globalThis.TextEncoder().encode(event({ model: selected.modelId, choices: [{ delta: { content: "synthetic report" } }] })));
              controller.enqueue(new globalThis.TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
            },
          }), { status: 200, headers: { "content-type": "text/event-stream" } });
        },
      },
    });
    try {
      await new Promise((resolve) => gateway.listen(socketPath, resolve));
      const send = (model, mode) => createUnixSocketFetch(socketPath)("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer fixture-attempt-capability", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 128, stream: true, messages: [{ role: "user", content: `synthetic ${mode}` }] }),
      });
      for (const mode of ["plan", "dev"]) {
        const response = await send(selected.modelId, mode);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /synthetic report/);
      }
      const override = await send(profileId === "copilot" ? "fixture-openai" : "fixture-copilot", "dev");
      assert.equal(override.status, 400);
      assert.deepEqual(dispatches.map(({ providerId }) => providerId), [selected.providerId, selected.providerId]);
      assert.ok(dispatches.every(({ body }) => body.model === selected.modelId));
      assert.throws(() => resolveProviderSelection({
        ...selected, providerId: selected.providerId === "openai" ? "github-copilot" : "openai",
      }), /does not match/);
    } finally {
      await new Promise((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("prepared gateway messages, not a caller count, determine the conservative context budget", async () => {
  const selected = resolveProviderCatalog(configFor("openai")).active;
  const directory = await mkdtemp(join(tmpdir(), "jarvis-context-budget-"));
  const socketPath = join(directory, "gateway.sock");
  let dispatches = 0;
  const gateway = createBoundedGateway({
    socketPath, capability: "attempt", profile: selected,
    maxInputBytes: 16 * 1024, maxOutputTokens: selected.maxOutputTokens, maxRequests: 2,
    dispatchToFilter: { async dispatch() { dispatches++; return globalThis.Response.json({}); } },
  });
  try {
    await new Promise((resolve) => gateway.listen(socketPath, resolve));
    const response = await createUnixSocketFetch(socketPath)("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer attempt", "content-type": "application/json" },
      body: JSON.stringify({
        model: selected.modelId, max_tokens: 128, stream: true,
        messages: [{ role: "user", content: "x".repeat(5000) }],
        contextTokens: 1,
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "profile_or_context_budget_rejected");
    assert.equal(dispatches, 0);
  } finally {
    await new Promise((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const profileId of ["copilot", "openai"]) {
  test(`${profileId} selected-provider outage fails without fallback or exposing a second provider`, async () => {
    const selected = resolveProviderCatalog(configFor(profileId)).active;
    const directory = await mkdtemp(join(tmpdir(), "jarvis-provider-outage-"));
    const socketPath = join(directory, "gateway.sock");
    const dispatches = [];
    const gateway = createBoundedGateway({
      socketPath, capability: "fixture-attempt-capability", profile: selected,
      maxInputBytes: 4096, maxOutputTokens: selected.maxOutputTokens, maxRequests: 1,
      dispatchToFilter: { async dispatch(request) { dispatches.push(request.providerId); throw new Error("synthetic outage"); } },
    });
    try {
      await new Promise((resolve) => gateway.listen(socketPath, resolve));
      const response = await createUnixSocketFetch(socketPath)("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer fixture-attempt-capability", "content-type": "application/json" },
        body: JSON.stringify({ model: selected.modelId, max_tokens: 128, stream: true, messages: [{ role: "user", content: "synthetic" }] }),
      });
      assert.equal(response.status, 502);
      assert.deepEqual(dispatches, [selected.providerId]);
    } finally {
      await new Promise((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
