# Per-attempt LLM gateway prototype

This package contains a bounded HTTP-to-provider gateway core intended to listen on a per-attempt Unix socket, plus a fetch transport restricted to the corresponding fixed loopback API route. It authenticates the per-attempt capability, pins the provider URL/model in trusted startup configuration, rejects redirects, bounds request/response sizes, output tokens, request count and deadline, and streams response chunks with backpressure. The provider key is read from a file at startup; it is never accepted from an agent request or logged.

Run its unit suite with `pnpm --filter @jarvis/llm-gateway test`.

## Qualification limits

The Colima harness in `infra/opencode-prototype/` builds pinned ARM64 OpenCode and synthetic-gateway images, runs them as isolated containers, and qualifies the HTTP-to-Unix-socket path, OpenCode v2 session flow, fixture response, cancellation, read-only snapshot/config, writable isolated state, and cleanup. Its host-side exec relay accepts only fixed health and qualification-probe operations; it is not yet integrated into the sandbox-manager lifecycle. The harness uses only named guest volumes and synthetic values; it does not use production Compose, private code, a real provider key, or a billable provider call. The host test runner may use a different Node version; the actual prototype images run Node 24.22.0.

This is not a production profile. The synthetic model's attempted `shell` tool is refused because the sandbox configuration does not expose that tool, and no sentinel is written; this is not a substitute for all permission-policy scenarios. The gateway does not pin resolved provider addresses against DNS rebinding, or implement durable F09 usage accounting, reservations, provider capability negotiation, token counting, concurrency sharing, or cancellation/reconciliation across a manager restart. Do not mount a real key or send private repository data through this prototype. Provider/account selection (D02) and billable-use policy (D05) remain open; this qualification neither resolves those decisions nor qualifies product dispatch.
