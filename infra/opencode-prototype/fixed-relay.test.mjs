import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { dispatchFixedOpenCode } from "./fixed-relay.mjs";

const password = "synthetic-password";
const sessionID = "session_1";

test("maps all closed relay operations to authenticated fixed loopback routes", async () => {
  const cases = [
    [{ operation: "health" }, "GET", "/api/info", undefined, { version: "2.0.32" }],
    [{ operation: "session.create", title: "synthetic" }, "POST", "/api/session", { title: "synthetic" }, { data: { id: sessionID } }],
    [{ operation: "prompt", sessionID, text: "hello" }, "POST", `/api/session/${sessionID}/prompt`, { text: "hello", resume: true }, { data: { id: "message_1" } }],
    [{ operation: "messages", sessionID }, "GET", `/api/session/${sessionID}/message?order=desc&limit=50`, undefined, { data: [] }],
    [{ operation: "status", sessionID }, "GET", "/api/session/status", undefined, { [sessionID]: { type: "busy" } }],
    [{ operation: "cancel", sessionID }, "POST", `/api/session/${sessionID}/interrupt`, undefined, { interrupted: true }],
  ];
  for (const [request, method, path, body, result] of cases) {
    let captured;
    const fetcher = async (url, init) => {
      captured = { url: String(url), init };
      return new globalThis.Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
    };
    const response = await dispatchFixedOpenCode(request, { fetcher, password });
    assert.equal(captured.url, `http://127.0.0.1:4096${path}`);
    assert.equal(captured.init.method, method);
    assert.equal(captured.init.redirect, "error");
    assert.equal(captured.init.headers.authorization, `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);
    assert.deepEqual(captured.init.body === undefined ? undefined : JSON.parse(captured.init.body), body);
    assert.equal(typeof response, "object");
  }
});

test("rejects unknown operations, extra fields, and malformed session identity before fetch", async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; throw new Error("must not fetch"); };
  await assert.rejects(dispatchFixedOpenCode({ operation: "exec", command: "id" }, { fetcher, password }));
  await assert.rejects(dispatchFixedOpenCode({ operation: "health", url: "http://elsewhere.invalid" }, { fetcher, password }));
  await assert.rejects(dispatchFixedOpenCode({ operation: "messages", sessionID: "../other" }, { fetcher, password }));
  assert.equal(calls, 0);
});
