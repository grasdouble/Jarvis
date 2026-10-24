import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("dashboard panel is independently renderable for hostile text safety checks", async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), server: { middlewareMode: true }, appType: "custom" });
  try {
    const app = await server.ssrLoadModule("/src/DashboardPanel.tsx");
    assert.equal(typeof app.DashboardPanel, "function");
    const markup = renderToStaticMarkup(createElement(app.DashboardPanel, {
      onExport() {},
      dashboard: { provenance: { source: "fixture", generatedAt: "2026-10-24T00:00:00.000Z" }, projects: [{
        id: "p1", repository: "<script>alert(1)</script>", state: "active", configVersion: null, health: "unknown",
        usage: null, observedAt: null, requests: [], pullRequests: [{ number: 7, state: "open", observedAt: null, url: "javascript:alert(1)" }],
      }] },
    }));
    assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(markup, /<h3><script>/);
    assert.match(markup, /Unknown \/ not observed/);
    assert.doesNotMatch(markup, /href="javascript:/i);
    assert.doesNotMatch(markup, /javascript:alert/);

    const safeMarkup = renderToStaticMarkup(createElement(app.DashboardPanel, {
      onExport() {},
      dashboard: { provenance: { source: "fixture", generatedAt: "2026-10-24T00:00:00.000Z" }, projects: [{
        id: "p2", repository: "safe/repo", state: "active", configVersion: 1, health: "unknown", usage: { modelRequestCount: 1, modelRequests: [{
          id: "11111111-1111-4111-8111-111111111111", provider: "OpenAI", model: "gpt-4.1", purpose: "task_execution",
          requestId: "22222222-2222-4222-8222-222222222222", taskId: "33333333-3333-4333-8333-333333333333",
          attemptId: "44444444-4444-4444-8444-444444444444", state: "completed", dispatchedAt: null, observations: [], ledger: null,
        }] }, observedAt: null,
        requests: [], pullRequests: [{ number: 42, state: "open", observedAt: null, url: "https://github.com/safe/repo/pull/42" }],
      }] },
    }));
    assert.match(safeMarkup, /href="https:\/\/github\.com\/safe\/repo\/pull\/42"/);
    assert.match(safeMarkup, /Provider\/model: OpenAI\/gpt-4\.1/);
    assert.match(safeMarkup, /Purpose: task_execution/);
    assert.match(safeMarkup, /Request: 22222222-2222-4222-8222-222222222222/);
    assert.match(safeMarkup, /Task: 33333333-3333-4333-8333-333333333333/);
    assert.match(safeMarkup, /Attempt: 44444444-4444-4444-8444-444444444444/);
  } finally {
    await server.close();
  }
});
