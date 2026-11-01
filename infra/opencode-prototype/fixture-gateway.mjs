import { resolveProviderCatalog } from "@jarvis/llm";
import { createBoundedGateway, listenGatewaySocket } from "./gateway.js";

const socketPath = process.env.LLM_GATEWAY_SOCKET ?? "/run/jarvis-llm/gateway.sock";
const capability = process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY;
if (!capability) throw new Error("Synthetic per-attempt gateway capability is required.");
const capabilities = ["chat-completions", "streaming", "cancellation", "context-budget"];
const profile = resolveProviderCatalog({
  activeProfileId: "openai",
  profiles: {
    copilot: { modelId: "fixture-copilot", contextWindowTokens: 8192, maxOutputTokens: 256, capabilities },
    openai: { modelId: "fixture-model", contextWindowTokens: 8192, maxOutputTokens: 256, capabilities },
  },
}).active;

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
  profile,
  maxInputBytes: 64 * 1024,
  maxOutputTokens: 256,
  maxRequests: 10,
  requestTimeoutMs: 10_000,
  dispatchEnabled: true,
  dispatchToFilter: {
    dispatch: async ({ body: bodyBytes, signal }) => {
      const body = JSON.parse(Buffer.from(bodyBytes).toString("utf8"));
    if (body.model !== "fixture-model") throw new Error("Unexpected synthetic model.");
    const cancelProbe = body.messages?.some((message) => message.content === "__cancel_probe__") ?? false;
    const permissionProbe = body.messages?.some((message) => message.content === "__permission_probe__") ?? false;
    const permissionToolAlreadyAttempted = body.messages?.some((message) =>
      message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ?? false;
    if (permissionProbe && !permissionToolAlreadyAttempted) {
      console.log("JV006_FIXTURE_PERMISSION_PROBE");
      const encoder = new TextEncoder();
      const chunks = [
        `data: ${JSON.stringify({ id: "fixture-permission", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_fixture_shell", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "echo must-not-run" }) } }, { index: 1, id: "call_fixture_edit", type: "function", function: { name: "edit", arguments: JSON.stringify({ filePath: "/state/permission-probe.txt", content: "must-not-write" }) } }] }, finish_reason: "tool_calls" }] })}\n\n`,
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
        if (signal.aborted) {
          console.log("JV006_FIXTURE_PROVIDER_REQUEST_ABORTED");
          reject(new DOMException("Synthetic request aborted.", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
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
    },
});

listenGatewaySocket(gateway, socketPath);
