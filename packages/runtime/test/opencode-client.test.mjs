import assert from "node:assert/strict";
import { test } from "node:test";

import { OpenCodeClient, OpenCodeClientError } from "../dist/index.js";

test("headless client authenticates, limits requests to loopback, and supports health/session/prompt/cancel", async () => {
  const calls = [];
  const client = new OpenCodeClient({
    baseUrl: "http://127.0.0.1:4096/",
    password: "per-attempt-password",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/info")) return globalThis.Response.json({ version: "2.0.32", pid: 1, urls: [], paths: { tmp: "/tmp" } });
      if (String(url).endsWith("/api/session") && init.method === "POST") return globalThis.Response.json({ data: { id: "session_1", title: "fixture" } });
      if (String(url).endsWith("/api/session/session_1/prompt")) return globalThis.Response.json({ data: { id: "input_1", text: "Review this synthetic fixture" } });
      if (String(url).includes("/api/session/session_1/message?")) return globalThis.Response.json({ data: [{ id: "message_1", type: "assistant", content: [{ type: "text", text: "synthetic" }] }] });
      if (String(url).endsWith("/api/session/session_1/interrupt")) return globalThis.Response.json({ interrupted: true });
      if (String(url).endsWith("/api/session/session_1") && init.method === "DELETE") return new globalThis.Response(null, { status: 204 });
      return new globalThis.Response(null, { status: 404 });
    },
  });

  assert.deepEqual(await client.health(), { healthy: true, version: "2.0.32" });
  const session = await client.createSession("fixture", { providerID: "mock", modelID: "fixture", agent: "build" });
  assert.equal(session.id, "session_1");
  assert.equal((await client.prompt(session.id, "Review this synthetic fixture")).data.id, "input_1");
  assert.equal((await client.messages(session.id))[0].content[0].text, "synthetic");
  assert.equal(await client.abort(session.id), true);
  await client.deleteSession(session.id);
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.match(call.url, /^http:\/\/127\.0\.0\.1:4096\//);
    assert.equal(call.init.headers.authorization, `Basic ${globalThis.Buffer.from("opencode:per-attempt-password").toString("base64")}`);
    assert.equal(call.init.redirect, "error");
  }
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    title: "fixture",
    model: { providerID: "mock", id: "fixture" },
    agent: "build",
  });
  assert.deepEqual(JSON.parse(calls[2].init.body), { text: "Review this synthetic fixture", resume: true });
});

test("headless client rejects remote servers, missing passwords, malformed ids and provider redirects", async () => {
  assert.throws(() => new OpenCodeClient({ baseUrl: "http://192.0.2.1:4096", password: "secret" }), OpenCodeClientError);
  assert.throws(() => new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", password: "" }), OpenCodeClientError);
  const client = new OpenCodeClient({
    baseUrl: "http://127.0.0.1:4096",
    password: "attempt",
    fetch: async () => globalThis.Response.redirect("http://example.test/", 302),
  });
  await assert.rejects(() => client.abort("../host"), OpenCodeClientError);
  await assert.rejects(() => client.health(), OpenCodeClientError);
});

test("headless client rejects malformed v2 responses instead of reporting success", async () => {
  const client = new OpenCodeClient({
    baseUrl: "http://127.0.0.1:4096",
    password: "attempt",
    fetch: async (url) => String(url).endsWith("/api/info")
      ? globalThis.Response.json({})
      : globalThis.Response.json({ data: "not-a-message-list" }),
  });
  await assert.rejects(() => client.health(), /valid version/);
  await assert.rejects(() => client.messages("session_1"), /invalid message page/);
});
