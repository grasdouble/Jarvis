# Shared OpenCode runtime and controlled capabilities

Status: owner-selected post-MVP design, specified by [JV-063](https://github.com/grasdouble/Jarvis/issues/63). No conversational endpoint, connector, broker, runtime profile or permission is installed by this document. The v0.1 Dependabot/static-review scope and release gates remain unchanged. J08 tracks general-purpose assistance; J06 tracks autonomous code delivery and J07 tracks self-improvement. J08 needs the verified MVP foundations but does not require J06/J07 solely because of its number. No version or date is committed.

## Responsibilities and profiles

OpenCode is the shared headless agent engine for understanding a request, interacting with an authorized model, selecting available tools and composing a result. JARVIS owns authenticated entry points, durable state/memory, scheduling, authorization, budgets, secrets, tool execution policy and verified external effects. Reuse the OpenCode SDK adapter rather than introducing a second conversational agent loop. Herdr is not a required component; no plugin or personal OpenCode session is involved.

The first future conversational slice supports ordinary questions and approved read-only capabilities. Weather in Nantes, France, is the qualification example. Neither model knowledge nor an unavailable tool is evidence of current weather. Arbitrary browsing/shell, mutating personal integrations, email/calendar actions, external notifications, unattended personal monitoring and an open-ended planner remain outside this slice.

[J09 messaging channels](messaging-channels.md) separately plan Telegram/Signal notifications and later owner-paired text entry points into this service. J09 conversation waits for verified JV-068 and D14 plus its D15 adapter/identity/privacy gates; notification-only delivery does not require J08. This leaves the first slice's tools and existing action/approval boundaries unchanged. Channel credentials stay outside OpenCode, and incoming messages cannot create a broader profile or native human approval.

| Trusted JARVIS profile | Intended use and allowed context/tools | Gate |
| --- | --- | --- |
| `review-static-v1` | MVP code review; sanitized read-only repository snapshot, bounded LLM transport, structured report; no capability broker or repository execution | Existing J01/J03 qualification |
| `assistant-readonly-v1` | Future conversation; bounded owner/session context and only explicitly admitted read-only capabilities; no repository mount, shell/edit tools, host files or GitHub write tools | J08 and accepted D14 profile |
| Future author/validation/reviewer profiles | Scoped code changes, separate credential-free validation and independent review attempts; each gets its own qualified context/tools | J06/D12, not granted by conversation |
| Future self-improvement profiles | Bounded proposal/candidate work, protected evaluator and trusted released skill; current human main promotion and separate activation | J07/D13 and the campaign contract |

These names describe JARVIS configuration contracts, not built-in OpenCode agents or shipped profiles. The trusted core selects a profile from released configuration and supplies an immutable tool catalog/model profile. A model may suggest intent or a capability, but cannot choose a new authority scope. Reject unknown/mismatched profiles and tools; never union tool sets to make a request succeed. General questions need no fabricated GitHub issue, repository or revision. A request to work on a repository becomes a separately scoped and authorized code mission only when that capability is available.

A runtime process/session has one bounded mission/profile. Conversation turns, authors and reviewers do not share a privileged OpenCode HOME, mutable configuration or author conversation. Native OpenCode subagents share their execution environment; they do not establish an isolation boundary. Disable uncontrolled `task` delegation and undeclared built-in tools in the general profile; only core may schedule separately authorized attempts with cumulative budgets. Different models per profile remain subject to selected provider/data-processing authorization.

## Request and result flow

```text
Authenticated React/API request
  -> durable conversation turn and mission claim
  -> trusted profile, bounded context, policy and budget reservation
  -> sandbox-manager starts an isolated OpenCode attempt
  -> OpenCode uses the bounded LLM gateway and requests an admitted tool
  -> core capability broker validates the invocation and records intent
  -> credential-holding executor calls the configured external service
  -> bounded validated data returns to OpenCode
  -> answer with source/time/limitations; core records outcome and usage
  -> attempt resources removed; durable conversation remains in PostgreSQL
```

For a question answerable without an external service, no capability call is needed. Fresh external facts require a suitable admitted tool. Missing capabilities return `unsupported`/a useful limitation; ambiguous location/time or materially different action scope requires clarification. The runtime never installs a tool, discovers arbitrary MCP services, writes a script or starts a developer profile to work around absence or denial.

The authenticated user request is an input to core authorization, not a blanket approval of every model-selected action. Tool output, retrieved memory, public pages, repository text and conversation summaries remain data with provenance; their instructions cannot expand permissions, substitute a profile or satisfy a human approval gate. Keep tool data separate from trusted instructions and validate structured output, arguments and references outside the model. Render answers/tool data safely in the web UI.

## Proposed contracts and module placement

Keep the domain independent of OpenCode and external provider SDKs. The MVP `AgentRuntime.review(ReviewRequest)` and SHA-bound review validator remain intact. Extend the runtime port with an explicitly versioned mission operation; do not make required review revision fields optional just to support conversation.

Proposed contract concepts, to finalize in the profile/policy slice:

| Contract | Required binding and content |
| --- | --- |
| `AgentMission` | User/owner, conversation/turn when applicable, mission/attempt IDs, released profile/policy/tool-catalog/model digests, context manifest, permitted capabilities/actions/data scope, cumulative limits/reservation, deadline, fenced lease and stop epoch; tagged payload is either a general request or an exact repository/revision task |
| `ToolInvocation` | Mission/attempt/turn/call identity, capability and schema version, validated typed arguments, expected policy/catalog digests and scoped invocation key; identity/authority come from authenticated transport, never model-supplied IDs alone |
| `ToolResult` | Invocation identity, bounded typed payload or explicit error, resolved subject/location, provider/source reference, observed/retrieved timestamps, units where relevant, cache/expiry state and usage/provenance; no executable instructions or secrets |
| `AgentResult` | Mission/input/profile binding, actual outcome (`completed`, `limited`, `needs_input`, `unsupported`, `failed`, `cancelled`), answer, tool-result references and limitations, actual/estimated usage; a completed answer grants no publication/deployment authority |

These are proposed JARVIS contracts, not exact OpenCode signatures or installed handlers. Current-weather data can lack an observation timestamp; treat that explicitly under accepted freshness policy rather than inventing one. Resolve schema/version mismatches before dispatch and reject oversized, unexpected or ill-typed fields. Code-profile outputs retain their stricter revision/coverage checks.

Use the existing PNPM modular monolith and typed ports:

- `packages/runtime`: common OpenCode adapter and per-profile protocol mapping; existing static review compatibility.
- `packages/contracts`, `packages/domain`, `packages/policy`: tagged missions/results, tool schemas, profile catalog and deterministic capability decisions.
- Proposed `packages/conversation`: owner/session turn lifecycle and bounded context selection through existing memory ports.
- Proposed `packages/capabilities`: admitted tool registry, invocation lifecycle and external-service adapters behind typed ports.
- `packages/memory`, `persistence`, `queue`, `llm`, `observability`: reuse scoped context, durable claims/intents, provider reservations and audit/usage; avoid a second database or agent framework.
- `apps/api`, `web`, `worker`: authenticated conversational entry/results/stop/delete, rendering and orchestration. A separately constrained capability-executor process/container performs external calls; core remains the decision/ledger owner. Exact deployment placement needs D14 qualification before enablement.

## Tool transport, networking and secrets

Preserve `network_mode: none` for the general agent. It receives no Mac/repository mount, Engine socket, database/GitHub credential, permanent provider key or route to the core/host/LAN. The existing LLM gateway stays limited to its model routes; it is not a generic capability proxy.

Qualify a separate narrow per-attempt tool transport, for example a guest-volume Unix socket with fixed framed requests to the trusted broker/executor path. The pinned OpenCode adapter may expose admitted tools through controlled MCP stdio or another qualified typed bridge. Only trusted released definitions/servers are loaded; no repository/global auto-discovery, runtime package installation, remote destination selection or personal credential reuse. A socket is a privileged entry point: authenticate the attempt, bind it to one mission/turn/catalog, bound frames/concurrency and reject arbitrary methods/paths. A claimed native permission is not proof of transport isolation.

The broker validates current authority, schema/arguments, user/session scope, released versions, reservation, expiry, fence and durable stop before every dispatch. A dedicated trusted executor receives only the bounded service request and scoped secret it needs. Constrain its outbound network to accepted TLS destinations/routes with response/time/size limits, redirect/DNS/IPv4/IPv6 checks and no route to host/LAN/core/neighbors. Where a service needs credentials, keep them outside the agent and LLM context; redact errors and logs. The transport/executor separation and cancellation path must be demonstrated on the pinned Colima/OpenCode stack; unavailable enforcement blocks the profile, not the whole MVP.

OpenCode supports agent-level permissions and MCP integration, but those features alone do not establish these JARVIS guarantees. Deny unrestricted `bash`, edits, web fetch/search, external directories, dynamic MCP registration and nested agent launching in the first general profile. Expose only accepted capability definitions; trusted profile/code changes follow the existing human-sensitive review/activation process.

## Conversation memory, costs and recovery

PostgreSQL owns durable owner/conversation/turn state. OpenCode state is ephemeral; reconstruct bounded context from authorized messages and references rather than relying on a persistent unrestricted agent session. Conversation scope is separate from repository knowledge; an explicit repo mission receives only separately admitted context. Personal statements and summaries do not automatically become validated knowledge, rules or approval. Record provenance, applicability, source time, sensitivity and forgetting/retention across raw turns, tool data, derived summaries, search representations and restored backups. Default to no reusable conversation knowledge until accepted D14 retention/consent rules exist; history limits must be configured before persistence is enabled.

Proposed records extend the existing persistence model with conversations/turns (owner, ordered client message IDs, source/trust, disposition), mission/context manifests, capability invocations (request digest, policy/catalog versions, reservation, state, result/provenance, expiry) and sanitized tool results. Unique keys scope client message retries to owner/conversation/message, and calls to mission/turn/call plus capability/schema/arguments digest. Preserve cumulative model steps/tokens/currency, tool calls, elapsed time and resource consumption across retries, process restarts and child attempts. D14 accepts numeric limits before live work; add tool costs to the same per-request/daily accounting rather than counting only LLM tokens.

Use durable states such as received → authorized → running → awaiting_tool → responding → completed/limited, with needs_input/unsupported/failed/cancelled and unknown remote outcomes retained. Persist inbox/outbox intents and fenced ownership before dispatch. Lost client/stream responses resume the existing turn and reread tool state before another effect. A repeated read cannot guarantee exactly-once billing: qualify whether a bounded reread is allowed, charge every accepted call and preserve provenance. Mutating tools remain outside the first slice and would need separate idempotency/approval qualification.

Stop/revocation invalidates future dispatch and capabilities; cancel runtime/executor work and retain partial/unknown outcomes. Already accepted external calls may finish and are reconciled/accounted without being treated as a new authorization. Restart, expired leases, UI reconnect and backup restore cannot revive revoked profiles, forgotten context, old approval or a fresh budget. The Mac sleep/offline limitation remains. Keep only sanitized logs/metadata needed for audit; profile/turn/call correlation, latency, failures, quota decisions and total usage are observable without dumping private prompts/results.

## Weather example and acceptance

For “What is the weather in Nantes?”, resolve the location/time intent or ask if ambiguous, then request the admitted weather capability. The connector uses the D14-selected provider, fixed request schema and allowed destination; it returns the resolved location, requested current/forecast period, units, available source observation time, retrieval time, source and cache state. The response cites the validated source/time and identifies stale or unavailable data. Weather tools provide information only and cannot start a code task, change permissions or create a self-update PR.

| Scenario | Required outcome before enablement |
| --- | --- |
| Nantes current weather, fresh provider result | One authorized logical turn; validated subject/units/source/time, grounded answer and accounted bounded calls |
| Ambiguous place or current-versus-forecast request | Clarify the material uncertainty; no invented location, period or data |
| Cached result, missing observation time, expired data | Apply accepted TTL/freshness policy and disclose age/limits; stale data is not silently described as current |
| Rate limit, timeout, malformed/oversized result, service outage | Bounded retries/reconciliation and explicit partial/unavailable outcome; no fabricated measurement or alternate unapproved destination |
| Tool output asks for secrets, shell or broader agent | Treat it as untrusted data; zero additional authority, repository access or code dispatch |
| Wrong user/session/fence/profile/catalog, unlisted tool or URL | Reject before external dispatch; retain sanitized reason |
| Redirect/DNS/IPv6 route to host/LAN/core or credential leakage | Enforced rejection in actual environment; no production secret in model/output/logs |
| Duplicate message/call, lost response, concurrent worker, restart | Reuse durable identity and reconcile existing effect; bound/account any qualified reread |
| Stop, exhausted limits, expiry, deletion or pre-deletion restore | No new dispatch or forgotten context reuse; retain reconciled accepted effects and cumulative consumption |
| Regression of review/developer/self-update profiles | Existing qualified gates stay intact; general conversation supplies no code-write or promotion authority |

Future implementation uses RED/GREEN behavioral tests with sanitized/fake-provider fixtures, pinned-adapter contract tests, authenticated API/UI integration, actual sandbox/egress qualification and a controlled live weather pilot. Mark simulated versus live results separately. Record actual latency/usage against owner-accepted thresholds and show zero unauthorized effects in the agreed corpus. This document has not executed those scenarios or measured weather data.

## Delivery and open decisions

[JV-064](https://github.com/grasdouble/Jarvis/issues/64) coordinates [profile/policy contracts JV-065](https://github.com/grasdouble/Jarvis/issues/65), [broker/adapter JV-066](https://github.com/grasdouble/Jarvis/issues/66), [conversation/context JV-067](https://github.com/grasdouble/Jarvis/issues/67) and [weather/pilot JV-068](https://github.com/grasdouble/Jarvis/issues/68). Each implementation child uses its own issue, branch/worktree and PR; its parent closes only after integrated acceptance. Start after verified JV-025 and this specification; J06/J07 features retain their own prerequisites and policies. The current task delivers design and backlog, not those runtime slices.

D14 must accept the pinned runtime/tool-transport/isolation profile, weather provider and data processing, tool schema/destinations, limits/timeout/freshness/cache/retention rules and pilot before affected live operations. If unset, the corresponding tool/history/profile remains disabled; ordinary supported requests can return a clear limitation. There is no blanket grant to add capabilities dynamically.

Official references checked October 16, 2026:

- [OpenCode server](https://opencode.ai/docs/server/): headless session/message/events APIs; the JARVIS adapter restricts the exposed surface.
- [OpenCode SDK](https://opencode.ai/docs/sdk/): JavaScript/TypeScript client and custom transport; pinned-version compatibility needs tests.
- [OpenCode agents](https://opencode.ai/docs/agents/): configurable prompts, models, permissions and subagents; isolation remains external.
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/): local/remote tools and configuration. JARVIS admits trusted definitions only, with a qualified narrow transport.
- [OpenCode permissions](https://opencode.ai/docs/permissions/): allow/ask/deny controls; deterministic authorization and sandbox enforcement remain JARVIS responsibilities.
