# Token consumption and usage accounting

**Status: specified, not implemented or enabled.** [JV-072](https://github.com/grasdouble/Jarvis/issues/72) elaborates F09 and architecture section 17. The owner-selected D02/D05 boundary for issue #300 supersedes any conflicting monetary-control proposal in this document: trusted configuration selects exactly Copilot or OpenAI, with no automatic failover; provider subscriptions/credits stay provider-managed. JARVIS does not reserve/cap money, access billing/admin credentials or APIs, poll quotas, or infer balances/invoices. Only usage/quota actually returned through ordinary provider/runtime traffic may be recorded, with provenance and freshness; #301 remains separate future accounting work. This installs no telemetry service, provider integration, package or billing access.

This document's older cost, reservation, pricing, billing-reconciliation and monetary-ceiling examples are not currently authorized requirements; they do not override D05. Future usage accounting must stay within the boundary above and requires its own accepted scope.

## Scope and ownership

Future usage observation may cover each model request dispatched by JARVIS, including retries and optional digest generation; a missing observation remains unknown rather than zero. Future author/reviewer agents, context compaction, conversations and self-improvement use the same observation rules when delivered; their existence here creates no MVP requirement. Preserve request/provider/model attribution and supported usage returned by normal traffic; tool fees, monetary cost, provider balances and invoice totals are outside this scope.

Reuse `packages/llm` for provider/profile contracts and future usage normalization, domain/contracts for invariants, persistence for transactions and observability for safe projections. Only the trusted gateway/runtime adapter may supply bounded observations. No agent receives an accounting database connection, provider billing credential or new network access; there is no monetary ledger or price-setting port.

JARVIS tracks only its own controlled traffic. It cannot infer token usage for unrelated local OpenCode sessions, this contributor chat or outside account users, nor infer shared-account charges/invoices from JARVIS observations.

[J10 duration forecasting](duration-forecasting.md) may reuse timestamps and qualified model/profile/effort observations after MVP delivery. Forecasts are separate advisory records, never authority for provider selection, monetary spending or deadlines. Future measurement/calibration cannot turn estimated or unknown usage into reported data.

## Per-request record and token semantics

Persist a request intent before dispatch as future #301 work. A logical operation has one `operationId`; every separately dispatched transport attempt has a new durable `requestId`, including retries. Bind observations to that identity, authorized provider/model/profile and task attempt. A provider request identifier is optional evidence, not a sufficient cross-account/global deduplication key. Unknown dispatch outcomes reconcile before repeating an effect; JARVIS does not determine provider billing.

| Field group | Required meaning |
| --- | --- |
| Identity and attribution | request/operation IDs; owner and optional repository, PR, task, attempt; purpose; provider, requested/resolved model, profile version; dispatch/completion UTC times |
| Future attribution | Optional agent/role, parent execution, conversation/turn or campaign identifiers only when those features exist; each request retains its own observation history |
| Token counters | `inputTotal`, `outputTotal`, `cacheReadInput`, `cacheWriteInput`, `reasoningOutput`: nullable nonnegative integers with per-field `reported`, `unknown` or `not_supported` status and normalization version |
| Evidence | Allowlisted usage and opaque correlation metadata actually returned through normal provider/runtime traffic; source, observation ID/revision, timestamp, mapping/coverage limitations; no prompt, response, reasoning text, billing/admin data or inferred values |
| Financial fields | Not authorized by D05: no monetary reservation, pricing/valuation, charge, balance, invoice or provider billing/admin read |
| Lifecycle | prepared, dispatched, succeeded, failed, cancelled or unknown; observation completeness is separate from task success |

Canonical input/output totals include cache/reasoning subsets only where a qualified adapter can establish that relationship. Preserve supported breakdowns, not additional amounts to add to those totals. If a provider reports mutually exclusive components, a future adapter may derive a total using a tested mapping; if overlap or coverage is unclear, leave the affected total unknown and retain supported components. Never sum five counters indiscriminately. No token estimate or monetary value is inferred. Unknown and unsupported are distinct from an observed zero; report coverage per counter.

Keep observed tokens grouped by provider/model and normalization semantics, with missing components visible. Cross-model counts are operational quantities, not equivalent work or comparable quality. Context-window occupancy is distinct from accumulated observed tokens. Do not store reasoning content to measure reasoning tokens.

## Collection, reconciliation and duplicate protection

1. A future implementation may persist request intent before dispatch. The trusted selected-provider route and request/token/context/time bounds are distinct controls; no monetary allocation or billing ledger is authorized.
2. The gateway/runtime adapter may expose actual request observations. Bind them to the trusted selected profile and attempt; only values actually returned on ordinary provider/runtime traffic are eligible. Hidden retries/compactions that cannot be observed prevent claims of complete request coverage.
3. Store observations using a unique `(request_id, source, observation_id, revision)` key. SDK updates can be cumulative snapshots, deltas or repeated final events: a versioned adapter defines which; projections replace previous snapshots or apply a proven unique delta. Never add repeated cumulative totals.
4. Corroborating gateway/runtime observations for the same request are not separate usage. Retain source, freshness and conflicts; do not turn token counts into charges, balances, invoices or quotas.
5. Persist permitted observation revisions and aggregate/outbox changes transactionally. Validate numeric bounds; unsupported, missing and unknown values remain explicit.
6. On restart or stream loss, reconcile available bounded runtime evidence only through authorized adapters. Exhaustion retains unknown usage; a task ending, timeout, restart or absent final event does not prove zero consumption.

Runtime observations are untrusted inputs. Validate schemas, limits, identifiers and gateway correlation. A provider without reliable usage remains explicitly unknown; no accounting procedure may infer a monetary exposure or claim a strict invoice cap.

## Limits and provider-managed charges

JARVIS enforces no monetary reservation, ceiling or spend control under the owner's D05 decision. Provider subscriptions/credits and any account quotas remain provider-managed; JARVIS does not provision billing/admin credentials, query billing APIs or poll quota. Record only supported usage/quota returned by normal provider/runtime traffic, with provenance, observation time/freshness and explicit unknown/unsupported state. No balance, invoice, price or charge is inferred.

Request, token, output, context and deadline bounds remain distinct runtime safety controls. Any future #301 usage record may attribute the actual selected provider/model and observed usage, but must not add monetary fields, billing sources or provider-account control-plane integration without a new owner decision.

## Query API, UI and daily digest

Proposed read-only routes use the existing owner session and authorization filters:

| Route | Result and constraints |
| --- | --- |
| `GET /api/v1/usage` | Summary of actually observed provider/runtime usage by period/provider/model/purpose and authorized repository/PR/task; finite time range, IANA zone, validated closed filters and bounded group count; no monetary valuation |
| `GET /api/v1/usage/requests` | Cursor-paginated request details and provenance/status, maximum 100 rows per page; bounded time/filter scan; no raw model content or credentials |

Responses may expose inclusive/exclusive period bounds, aggregation watermark/version, missing request/counter counts, token breakdowns and source/freshness. Exact high-cardinality identifiers stay in SQL detail queries and authorized traces, not metric labels. Repository/task filters are checked against stored ownership; arbitrary identifiers are not authority. Queries return only retained data and disclose retention gaps. No monetary reservation or spend totals are returned.

The future usage view can support global → repository/PR → task/attempt drilldown, provider/model/purpose comparison, daily/monthly trends, cache breakdown and failed/abandoned-request coverage. Direct and inclusive parent/child totals are labelled; never add an inclusive parent to its children. Consumption may inform an improvement hypothesis, but fewer tokens never proves quality gains or authorizes a model/profile switch.

Daily digests may summarize actual usage observations and their provenance, including failed/cancelled/unknown requests, with period/correction watermarks. They do not reserve a monetary allocation, include charges or monetary alert thresholds, or infer an invoice. Provider billing/usage observations not returned on the normal request path are excluded.

## Retention, privacy and recovery

Use the existing D09/D11 retention/deletion and restore policies; do not select new durations here. Usage storage contains counters and opaque attribution, not code, prompts, tool bodies, secrets or personal reasoning. Keep only allowlisted metadata and bounded identifiers; ordinary logs redact credential-bearing headers and provider payloads. External telemetry remains off by default. A usage UI is not permission to expose a conversation or another repository.

Deletion purges forbidden identifying content/links under the accepted lifecycle; any retained aggregate or audit fact must be content-free and permitted by that policy. Restore reconciliation applies deletion markers and stop epochs before exposing data or dispatching work. Missing post-backup observations remain an explicit coverage gap; no monetary exposure or budget state is inferred from the restored usage record.

## Future acceptance evidence

These are targets for the owning implementation issues, not tests already run:

- Two selected provider profiles pass mappings for ordinary, cached and reasoning usage, unknown/missing fields, provenance and freshness. Pricing, monetary valuation, invoice reconciliation and provider billing/API integration are excluded.
- A ten-request fixture has one ordinary usage observation (1,000 input, 100 output), one cached observation (2,000 input total including 1,500 cache reads and 200 cache writes; 300 output total including 100 reasoning), and eight zero-usage rejections confirmed before provider dispatch. Canonical observed totals are exactly 3,000 input and 400 output; cache/reasoning breakdowns are not added again. An interrupted request with absent usage has unknown counters, not zero.
- Replay each observation 100 times, replay cumulative updates and deliver gateway/runtime reports in both orders. Observed totals remain unchanged. A separately dispatched retry has a distinct request identity; conflicting/later corrected observations preserve revision history and missing coverage. No charge or monetary exposure is calculated.
- Aggregated API/UI/digest usage totals equal the future canonical observed-request totals under repository filters, parent/child grouping and late corrections. Include digest-generation usage, failed/cancelled requests, DST and period boundaries. Export and metric labels contain no prompt/secret/high-cardinality leakage.
- Actual pinned Colima/OpenCode gateway integration demonstrates correlated outbound calls, cancellation/retry observability and crash recovery, beyond mocked tests. No new host mount, agent network route, credential or billing permission is introduced to collect usage.

## References and implementation limits

Official documentation checked October 16, 2026:

- [OpenCode SDK](https://docs.opencode.ai/docs/sdk/): typed client, generated types, session/message reads and events provide integration surfaces. It does not guarantee identical accounting fields or billing semantics for every provider/version.
- [OpenCode server](https://docs.opencode.ai/docs/server/): server API/OpenAPI discovery supports a pinned adapter contract. The J01/J03 prototype must inspect and test the actual selected schema; polling/events alone do not establish completeness.
- [OpenCode provider configuration](https://docs.opencode.ai/docs/providers/): provider choice is separately configured; supported providers are not automatically interchangeable accounting implementations.

Any future usage ledger/normalization and its fixtures remain proposed behavior, not implemented evidence. This contract does not authorize monetary budgets/pricing, provider billing access, or quota polling. D02's allowed provider choices are Copilot/OpenAI under trusted selection; live dispatch remains gated by isolated egress implementation and pinned-platform qualification. Existing retention decisions continue to govern any later accepted persistence.
