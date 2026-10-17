# Telegram and Signal channels

**Status: owner-requested post-MVP design, not implemented or enabled.** [JV-074](https://github.com/grasdouble/Jarvis/issues/74) specifies P14/D15; [JV-075](https://github.com/grasdouble/Jarvis/issues/75) coordinates J09 implementation. Notifications come first per channel; bidirectional text conversation subsequently reuses qualified J08 services. J09 has no committed date/version and adds no v0.1 exit gate. Creating issues does not authorize bot registration, account linking, live messages or network exposure.

## Delivery slices and boundaries

| Slice | Capability | Prerequisites and owning work |
| --- | --- | --- |
| Shared foundation | Owner bindings, consent/settings, typed adapter ports, inbox/outbox and delivery policy | Verified JV-025 MVP, this specification and accepted corresponding D15 choices; [JV-076](https://github.com/grasdouble/Jarvis/issues/76) |
| Telegram notifications | Opted-in private daily digest, incidents, confirmed outcomes and pending-decision notices | Shared foundation and qualified Telegram transport/pilot; [JV-077](https://github.com/grasdouble/Jarvis/issues/77) |
| Signal notifications | The same bounded notification contract through a qualified bridge | Shared foundation plus actual bridge/account/ARM64 feasibility and pilot; [JV-078](https://github.com/grasdouble/Jarvis/issues/78) |
| Telegram conversation | Questions, scoped status and separately admitted task requests | Its notification adapter, verified JV-068/J08 acceptance and D14/D15; [JV-079](https://github.com/grasdouble/Jarvis/issues/79) |
| Signal conversation | The same owner-scoped text service through Signal | Its qualified bridge/notification adapter, verified JV-068/J08 acceptance and D14/D15; [JV-080](https://github.com/grasdouble/Jarvis/issues/80) |
| Integrated operations | Recovery/privacy/accounting corpus and runbooks for both channels | Both conversation slices; [JV-081](https://github.com/grasdouble/Jarvis/issues/81) verifies combined completion |

Notification-only delivery does not depend on J08 conversation, J06 coding or J07 self-improvement. Neither channel depends on the other. Individual pilots/enablement require their own accepted gates; combined JV-081 closure does not retroactively grant them. A request for code work remains unsupported until its J06/D12 mission is available and authorized; a request involving self-improvement retains J07/D13 and human promotion/separate activation. No second coding runtime, chatbot framework or OpenCode plugin is introduced.

The initial integration is one owner, explicitly paired private text chats and bounded templates. Groups, broadcast/multi-user access, attachments/voice, reading arbitrary chat history, contact/address-book import, account administration, arbitrary URL fetching and sensitive approval through chat are excluded. Unsupported payloads are rejected safely; the adapter must not download media or follow links to interpret them.

## Module and trust boundaries

Add `packages/channels` to the existing PNPM modular monolith for application ports, normalized envelopes and provider adapters; pure rules/types remain in domain/contracts. API/worker integrate authenticated management, durable ingestion and outbox dispatch using persistence/queue/policy. They reuse the existing conversation service, memory and [usage ledger](token-consumption.md). A Signal bridge, if selected, is a separately restricted integration component, not an agent or a reason to introduce general distributed orchestration.

```text
Confirmed core event -> scoped redacted notification intent -> durable outbox
  -> trusted connector with fixed recipient/endpoint -> Telegram or Signal

Provider update -> authenticated connector -> bounded journal and owner binding
  -> eligible J08 turn/profile + policy/budget -> isolated OpenCode
  -> validated bounded answer -> durable outbox -> same bound private chat
```

Core policy owns every action. Agents receive neither channel credentials nor a generic send-message tool; the core publishes a validated response only to the admitted turn's destination. Core-generated notifications use SQL facts/deterministic templates; optional digest prose and conversational generation consume their normal F09 allocations. Transport sends have separate finite limits and any applicable fees; a retry is not permission to start another model turn.

Bot tokens, refresh/account/device keys and decrypted Signal state remain in trusted connector/broker storage. Use restricted VM-local volumes, explicit service identities and fixed narrow egress, with no Engine socket or personal Mac mounts. Never copy the owner's existing Signal Desktop profile, personal OpenCode authentication or Keychain into an adapter. Limit a bridge RPC to qualified send/receive/health operations; account/link/admin operations belong to explicit trusted bootstrap. Raw RPC must not be accessible from agents, the browser, the LAN or a public listener. Candidate repositories and external messages cannot select endpoints, accounts or RPC methods.

## Identity, authorization and consent

The authenticated owner pairs a connection using a short-lived one-use challenge bound to owner, channel account, sender and private destination, with explicit confirmation in JARVIS. Store stable provider identifiers and a binding version/revocation epoch; a username, display name, phone-number text, forwarded author or quoted message cannot establish owner identity. A valid transport secret authenticates a connector, not every message sender. Validate sender and destination from qualified provider metadata on every admitted event. Reject group/anonymous/own-device echo and unpaired input before any LLM call. Binding or account identity changes invalidate pending turns/sends and require revalidation.

Owner preferences explicitly select event categories, disclosure level, recipients, quiet hours where wanted, expiry and unsubscribe/pause controls. Start with bounded status and safe links, no code/diff, prompt, secret, private conversation transcript or bearer approval token. Disclosure to each provider is a separate D15 data-processing choice; a recipient address alone is not consent. Do not infer equivalent confidentiality from the shared channel interface. Bot tokens embedded in Telegram request paths also require URL redaction in logs/traces.

Questions and status reads are bounded by the paired owner's current authorization. New task requests pass the same core scope/profile/budget admission as the web API. Ordinary text such as "approve", buttons, reactions and a notification receipt do not consume an approval or satisfy native GitHub review. In this first channel plan, sensitive human approvals stay in the existing authenticated UI/GitHub workflow with current revision/evidence checks. Links carry no action authority and use the same permission gates on opening.

Mobile access to the Mac-local UI is not assumed. Prefer authorized GitHub evidence links where appropriate; label JARVIS links that need local access. Exposing administration or adding a remote-access path requires a separately accepted access design; do not publish the API or relax loopback binding merely to make a notification link work.

## Provider options and qualification

**Telegram.** The documented Bot API offers `sendMessage` and either `getUpdates` polling or webhooks. D15 chooses the intake method; polling is a concrete option without a public inbound route. If webhooks are selected, publish only the narrow bounded intake, require HTTPS and validate the configured `X-Telegram-Bot-Api-Secret-Token`; keep administration private. Persist normalized updates before advancing the polling offset/acknowledging durable receipt. Scope deduplication by connection/bot and provider update identity, not message text or an assumption that sequence numbers remain contiguous. Telegram documents limited update retention, so laptop sleep cannot promise lossless receipt of arbitrary old messages. [T1](https://core.telegram.org/bots/api#getting-updates), [T2](https://core.telegram.org/bots/api#setwebhook)

**Signal.** `signal-cli` describes itself as unofficial and documents JSON-RPC/stdin or daemon transports. It is a candidate to evaluate, not an official Signal Bot API or an accepted dependency. Pin a maintained version/image and prove native ARM64 dependencies, receive/reconnect behavior, identity metadata and limited RPC access on the actual Colima profile. Select an explicitly provisioned account or consciously accepted linked-device setup through D15; do not assume permission to link a personal account. Bridge event replay may be in-memory or transport-specific, so raw connection sequence IDs cannot substitute for durable provider-message identity. Treat gaps after a restart as missing coverage. Maintenance/update/requalification and restricted state backup are part of acceptance. If infeasible, retain the limitation and dependent issue rather than silently switching transports or weakening isolation. [S1](https://github.com/AsamK/signal-cli), [S2](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc)

## Durable contracts, idempotence and recovery

Proposed records extend PostgreSQL rather than create a second event store:

| Record | Identity and purpose |
| --- | --- |
| `channel_connections` | Owner, provider/account reference, transport/profile versions, consent/settings version, state and revocation epoch; no raw key in application JSON |
| `channel_bindings` | Owner/connection plus stable sender/private-recipient IDs, pairing lifecycle, scopes and version; unique active binding, audited revocation |
| `channel_inbox` | Connection + qualified provider event/message identity, bounded body digest, timestamps, coverage, binding version and admission state; duplicate events reuse the recorded disposition/turn |
| `channel_deliveries` | Unique logical event-or-turn + binding + message kind/version, policy/consent hash, recipient digest, expiry, lease/stop epoch, observed remote ID and result |
| `channel_delivery_attempts` | Parent delivery, ordinal, request correlation, transport version, timestamps and confirmed/failed/unknown result; bounded retry and fee history |

Adapter ports normalize inbound envelopes and expose a closed send/status contract. Their versioned schemas include channel/account identity, immutable provider IDs, timestamps, bounded text, payload class and transport evidence; a claimed sender field inside message text is ignored. Store only permitted content under D14/D15 retention. Enforce request/body/text sizes, allowed formatting, redirects, timeouts and rate limits outside the model. Escape Markdown/HTML and prevent unexpected link previews/mentions or media fetches.

Commit inbox admission, durable turn/notification intent and outbox changes transactionally. Acknowledge provider intake only after its durable disposition where supported. Lease/fence cursor ownership across workers; preserve processed identities and disclose receive gaps after outages/restore. Distinct channel namespaces prevent ID collisions; cross-channel messages are not automatically merged by semantic similarity. Each channel remains a separate conversation unless the owner explicitly requests an authorized context transfer.

Before dispatch, recheck binding/recipient, consent, stop/revocation epoch, expiry, budget/rate capacity and event applicability. Suppress an expired/stale pending-approval notice or replace it only through a qualified versioned policy; an old notice cannot authorize a current action. Persist the send intent before network I/O. Record provider acceptance separately from delivery/read evidence; missing evidence stays unknown. The first adapters do not assume provider idempotency: a timeout after a possible successful send produces `unknown`, bounded reconciliation or owner-visible resolution, never a blind resend or a promise of external exactly-once delivery. Proven pre-dispatch/definitive failures may retry within the same intent's finite policy; retain all attempts and backoff/rate-limit evidence.

Sleep/outages retain bounded pending work. Resume only currently applicable opted-in messages; show gaps and use an owner-agreed catch-up summary rather than flood every old event. Late digest/usage corrections follow an explicit correction/supersession policy and source watermark, not another unbounded notification series. Stop/revocation prevents new effects; unavailable transport leaves the web digest/history usable and never blocks core GitHub ingestion or creates fictitious delivery success.

Forgetting purges channel payloads and identifying links as required by accepted D14/D15, including derived context/search and bridge state where applicable. Keep only permitted content-free audit/deduplication markers. Restore reconciles deletion/revocation/stop markers and unknown deliveries before replay; it cannot re-pair an old recipient or resend a supposedly forgotten backlog. Deleting local data is distinct from deleting messages already held by a recipient/provider; disclose the qualified remote-deletion limits rather than promise erasure everywhere. Model/tool usage, failed generations and transport fees remain attributable without duplicating parent/child or replay costs.

## Owner decisions and future evidence

D15 accepts accounts/bridge/transport, sender-pairing and recipient scopes, channel-specific disclosure/privacy, retention/expiry and payload limits, finite send/intake/model budgets, catch-up/unknown-result policy, pilot and explicit per-capability enablement. Do not invent these values in the implementation or treat this approved roadmap as their acceptance. D14 remains required for conversation/model/data policy; D12/D13 and native approval gates still govern subsequent effects.

Implementation targets, not tests run by this document:

- A ten-event fixture creates exactly eight unique notification intents when two categories are unsubscribed. Replaying each accepted event 100 times creates no additional intent; provider acceptance, failure and unknown outcomes remain distinct. A lost send acknowledgement causes no automatic duplicate send.
- Receiving the same authenticated message 100 times across reconnect/restart creates one canonical turn and one admitted generation allocation. Reject unbound/revoked/forged/group/forwarded/echo or unsupported payloads before a model/tool call, with zero unauthorized disclosure or action.
- Concurrent dispatch, credential rotation, stop/revocation, rate exhaustion, expired work, reordered/edited updates and uncertain receive/send states preserve ownership, scope and finite accounting. Modified updates never silently mutate a running mission or its approval.
- Deletion followed by restore cannot resurrect bindings, retained payloads, context, local message queues or spending capacity; late corrections, timezone changes and sleep recovery show gaps and bounded catch-up without duplicate core tasks.
- Each adapter has an actual pinned Colima/account pilot proving identity binding, bounded egress/state access, pause/unsubscribe and transport recovery; Signal feasibility is measured separately. Notifications may qualify before J08, but no channel conversation runs before its own J08/D14/D15 evidence and explicit enablement.
- JV-081 records at least 30 owner-agreed integrated success/adversarial/recovery cases, SQL/usage agreement, credential-free agents, redacted diagnostics and update/requalification runbooks. Mock fixtures and actual external transport evidence are identified separately.

## References

Primary documentation checked October 16, 2026: [Telegram Bot API](https://core.telegram.org/bots/api), [signal-cli maintainer README](https://github.com/AsamK/signal-cli), [signal-cli JSON-RPC manual](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc), and [Signal protocol documentation](https://signal.org/docs/). Protocol documentation does not establish an application bot contract. These sources describe possible integration surfaces; the JARVIS pairing, schemas, durable guarantees, policy and qualification above are application design, not supplied provider guarantees.
