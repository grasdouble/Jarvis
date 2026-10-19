import { createBoundedGateway } from "./gateway.js";

const socketPath = process.env.LLM_GATEWAY_SOCKET ?? "/run/jarvis-llm/gateway.sock";
const capability = process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY;
if (!capability) throw new Error("Synthetic per-attempt gateway capability is required.");

const report = JSON.stringify({
  schemaVersion: 1,
  summary: "Synthetic OpenCode and gateway transport check completed.",
  findings: [],
  examinedPaths: ["fixture.txt"],
  limitations: ["The synthetic provider did not perform semantic code analysis."],
  recommendation: "uncertain",
  complete: false,
});

const gateway = createBoundedGateway({
  socketPath,
  capability,
  providerUrl: "https://fixture.invalid/v1/chat/completions",
  providerApiKey: "non-provider-fixture-key",
  model: "fixture-model",
  maxInputBytes: 64 * 1024,
  maxOutputTokens: 256,
  maxRequests: 10,
  requestTimeoutMs: 10_000,
  maxResponseBytes: 64 * 1024,
  fetchProvider: async (url, init) => {
    if (String(url) !== "https://fixture.invalid/v1/chat/completions" || init.method !== "POST") {
      throw new Error("Unexpected synthetic provider route.");
    }
    const body = JSON.parse(Buffer.from(init.body).toString("utf8"));
    if (body.model !== "fixture-model") throw new Error("Unexpected synthetic model.");
    const cancelProbe = body.messages?.some((message) => message.content === "__cancel_probe__") ?? false;
    const permissionProbe = body.messages?.some((message) => message.content === "__permission_probe__") ?? false;
    const permissionToolAlreadyAttempted = body.messages?.some((message) =>
      message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ?? false;
    if (permissionProbe && !permissionToolAlreadyAttempted) {
      console.log("JV006_FIXTURE_PERMISSION_PROBE");
      const encoder = new TextEncoder();
      const chunks = [
        `data: ${JSON.stringify({ id: "fixture-permission", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_fixture_denied", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "echo must-not-run" }) } }] }, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(new ReadableStream({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk === undefined) controller.close();
          else controller.enqueue(encoder.encode(chunk));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
    }
    if (cancelProbe) {
      console.log("JV006_FIXTURE_PROVIDER_REQUEST_STARTED");
      await new Promise((resolve, reject) => {
        if (init.signal.aborted) {
          console.log("JV006_FIXTURE_PROVIDER_REQUEST_ABORTED");
          reject(new DOMException("Synthetic request aborted.", "AbortError"));
          return;
        }
        init.signal.addEventListener("abort", () => {
          console.log("JV006_FIXTURE_PROVIDER_REQUEST_ABORTED");
          reject(new DOMException("Synthetic request aborted.", "AbortError"));
        }, { once: true });
      });
    }
    const encoder = new TextEncoder();
    const chunks = [
      `data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: report }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    return new Response(new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
  },
});

gateway.listen(socketPath);
