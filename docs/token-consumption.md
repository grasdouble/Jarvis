# Token consumption and usage accounting

**Status: specified, not implemented or enabled.** [JV-072](https://github.com/grasdouble/Jarvis/issues/72) elaborates existing PRD F09, F07/F08 and architecture section 17. The MVP implementation belongs to [JV-015](https://github.com/grasdouble/Jarvis/issues/15), its authenticated views to [JV-017](https://github.com/grasdouble/Jarvis/issues/17), daily summaries to [JV-022](https://github.com/grasdouble/Jarvis/issues/22) and operational qualification to [JV-024](https://github.com/grasdouble/Jarvis/issues/24). This installs no telemetry service, provider integration, package or billing access.

## Scope and ownership

Track each model request dispatched by JARVIS, including reviews, format repairs, retries and optional digest generation. Record failed, cancelled, interrupted and uncertain requests even when usage is absent. Future author/reviewer agents, context compaction, conversations and self-improvement experiments use the same accounting when their respective capabilities are delivered; their existence here creates no MVP requirement to implement them. Track model calls made to prepare context as well as the final answer. A tool response can enlarge subsequent model input; any separate tool fee is recorded separately from tokens.

Reuse `packages/llm` for normalization, pricing and accounting ports, domain/contracts for invariants, persistence for PostgreSQL transactions and observability for projections. The trusted gateway records actual outbound requests; the runtime adapter supplies bounded correlated SDK observations. The core owns reservations and the canonical ledger. Agent reports, candidate code and memory cannot write totals, release funds, choose prices or extend limits. No agent receives an accounting database connection, provider billing credential or new network access.

JARVIS tracks its own controlled traffic. It cannot infer token use by unrelated local OpenCode sessions, this contributor chat or outside account users. The UI states that coverage; shared-account invoices can differ from JARVIS totals.

## Per-request record and token semantics

Persist a request intent before dispatch. A logical operation has one `operationId`; every separately dispatched transport attempt that may be billed has a new durable `requestId`, including retries. Bind observations to that identity, authorized provider/model/profile, attempt and gateway allocation. A provider request identifier is optional evidence, not a sufficient cross-account/global deduplication key. Unknown dispatch outcomes reconcile before repeating an effect; local accounting cannot guarantee provider exactly-once billing.

| Field group | Required meaning |
| --- | --- |
| Identity and attribution | request/operation IDs; owner and optional repository, PR, task, attempt; purpose; provider, requested/resolved model, profile version; dispatch/completion UTC times |
| Future attribution | Optional agent/role, parent execution, conversation/turn or campaign identifiers only when those features exist; the same request retains one canonical charge |
| Token counters | `inputTotal`, `outputTotal`, `cacheReadInput`, `cacheWriteInput`, `reasoningOutput`: nullable nonnegative integers with per-field `reported`, `estimated`, `unknown` or `not_supported` status and normalization version |
| Evidence | Allowlisted numeric usage and opaque correlation metadata, source (`gateway`, `runtime`, `provider_reconciliation`), observation ID/revision, timestamp, mapping/coverage limitations; no prompt, response or reasoning text |
| Monetary valuation | Reservation, estimated charge and optional provider-reported charge kept distinct; currency, immutable price/version/effective date and valuation method; unknown price/amount remains null |
| Lifecycle | prepared, dispatched, succeeded, failed, cancelled or unknown; accounting completeness and reconciliation state are separate from task success |

Canonical input/output totals include their cache/reasoning subsets only where a qualified adapter can establish that relationship. Preserve cache reads/writes and reasoning as breakdowns, not additional amounts to add to those totals. If a provider reports mutually exclusive components, the adapter may derive a total using its tested mapping; if overlap or coverage is unclear, leave the affected total unknown and retain the supported components. Never sum five counters indiscriminately. A tokenizer estimate is labelled with its method/version; unknown and unsupported are distinct from an observed zero. Report coverage per counter: an available input count does not make missing output measured.

Keep aggregate tokens grouped by provider/model and normalization semantics, with estimated and missing components visible. Cross-model token counts are operational quantities, not equivalent work or comparable quality. Context-window occupancy is a separate last-request measure; accumulated billed tokens are not the current context size. Do not store reasoning content to measure reasoning tokens.

## Collection, reconciliation and duplicate protection

1. The core atomically acquires the applicable budget allocation and persists the request intent before the gateway can dispatch. An unavailable ledger prevents a new billable call. Existing in-flight calls may finish; they must be recovered as known or unknown, never fabricated as zero.
2. The gateway assigns each actual outbound request its durable identity and records the selected endpoint/profile. Bind runtime session/message/step identifiers through the trusted adapter. Enable only qualified retry behavior; hidden retries/compactions that cannot be observed and bounded prevent a claim of complete accounting or strict local enforcement.
3. Store observations using a unique `(request_id, source, observation_id, revision)` key. SDK updates can be cumulative snapshots, deltas or repeated final events: a versioned adapter defines which; projections replace the previous snapshot or apply a proven unique delta. Never add repeated cumulative totals.
4. Gateway and SDK observations for the same request corroborate or disagree; they are not two charges. Select a canonical value by the qualified adapter's documented source/coverage rules, retaining provenance and conflicts. SDK monetary estimates are not provider invoices. An unexplained discrepancy marks reconciliation incomplete; it cannot silently reduce recorded spending.
5. Persist canonical revisions and aggregate/outbox changes transactionally. Later authoritative corrections create a linked revision; historical price records and prior evidence remain identifiable. Validate numeric bounds and currency; negative usage is invalid, while a verified billing credit is a separate audited adjustment.
6. On restart or stream loss, recover pending requests and reservations, then reread bounded runtime/provider evidence only through authorized adapters. Reconciliation uses finite attempts/deadlines/backoff; exhaustion retains unknown usage and the unresolved reservation with a visible owner action. A task ending, timeout, restart or absent final event does not prove a request was free.

Runtime observations are operational inputs from an untrusted task environment. Validate schemas, quotas, identifiers and gateway correlation, compare with trusted transport/provider facts and never let an SDK cost field or model statement release budget on its own. A provider without reliable usage can remain explicitly estimated; an unknown upper spending bound cannot be presented as a strict guaranteed cap. Qualification must establish a safe enforceable bound or disable the affected billable profile.

## Budgets and pricing

Use existing owner-accepted D02/D05 provider, currency and limits. Reserve the maximum authorized request/output envelope before dispatch, transactionally across applicable global, repository and task scopes. Future parent/campaign limits use the same charge, without resetting on child creation, retry, restart or supersession. A group reservation allocates capacity to children: it is not an extra expense to add to their consumption. Token limits, request limits, elapsed time and monetary limits remain distinct configured controls.

Serialize concurrent reservations with a database transaction/lock or equivalent proven atomic invariant; checking an in-memory balance is insufficient. Deny new calls when committed usage plus active/uncertain reservations leaves insufficient capacity. Release only a confirmed unused allocation under the accounting policy; unknown calls retain conservative exposure until verified reconciliation or an explicit audited owner resolution. A late correction updates the same request, never another charge. An overrun suspends new eligible calls and remains displayed, including after a period boundary. Provider-side limits supplement local controls; in-flight charges and account activity outside JARVIS prevent promising an absolute invoice ceiling.

Calculate monetary estimates from mutually exclusive billable buckets and the exact price rule applying to the provider/model, context tier, cache operation and request time. Reasoning already included in billed output must not be charged twice. Missing prices, subscription allowances, discounts and local models require an explicit valuation status, not a false zero or an assumed retail invoice. Store decimal values; never add different currencies without an explicitly versioned conversion policy. The MVP can display separate currency totals and needs no FX or billing-admin integration. Prices are configured/explicitly updated; D05 decides actual values and token/currency limits. This document selects none.

## Query API, UI and daily digest

Proposed read-only routes use the existing owner session and authorization filters:

| Route | Result and constraints |
| --- | --- |
| `GET /api/v1/usage` | Summary by period/provider/model/purpose and authorized repository/PR/task; finite time range, IANA zone, explicit currency, validated closed filters and bounded group count |
| `GET /api/v1/usage/requests` | Cursor-paginated request details and provenance/status, maximum 100 rows per page; bounded time/filter scan; no raw model content or credentials |

Responses expose inclusive/exclusive period bounds, aggregation watermark/version, missing/estimated request and counter counts, token breakdowns, reservation exposure and separately labelled estimated/provider-reported monetary values. Exact high-cardinality identifiers stay in SQL detail queries and authorized traces, not metric labels. Repository/task filters are checked against stored ownership; arbitrary identifiers are not authority. Queries return only retained data and disclose retention gaps. Export uses the same authorization, bounds and redaction as the views.

The consumption view supports global → repository/PR → task/attempt drilldown, provider/model/purpose comparison, daily/monthly trends, cache breakdown and failed/abandoned-request costs. Known persisted updates appear within 60 seconds in normal operation; provider lag or unknown outcomes remain visible. Direct and inclusive parent/child totals are labelled; never add an inclusive parent to its children. Optional future agent views include orchestration/review overhead and unsuccessful work, rather than only the winning agent's output. Consumption may inform an improvement hypothesis, but fewer tokens never proves equivalent quality or authorizes a model/profile switch.

Daily digests use SQL accounting facts, including their own optional model generation. A pending digest-generation allocation is visible before dispatch; final usage is attached to that digest's persisted revision. Failure uses the deterministic template and retains any incurred/unknown charge. Attribute calls to their immutable dispatch instant for period grouping in the selected IANA zone; late observations revise that period's totals and watermark with a correction indicator. A new billing/usage observation is not a second digest occurrence. Show token and monetary budgets, configured alert thresholds (existing 80%/100% spend alerts), and unknown exposure separately.

## Retention, privacy and recovery

Use the existing D09/D11 retention/deletion and restore policies; do not select new durations here. Usage storage contains counters and opaque attribution, not code, prompts, tool bodies, secrets or personal reasoning. Keep only allowlisted metadata and bounded identifiers; ordinary logs redact credential-bearing headers and provider payloads. External telemetry remains off by default. A usage UI is not permission to expose a conversation or another repository.

Deletion purges forbidden identifying content/links under the accepted lifecycle; any retained aggregate or audit fact must be content-free and permitted by that policy. Restore reconciliation applies deletion markers and stop epochs before exposing data or dispatching work. Restore/retention cannot silently free uncertain spend: if a backup lacks newer financial exposure, suspend new billing until an authorized reconciliation or audited owner resolution establishes the applicable budget state. Retained period totals identify coverage/gaps and cannot claim a full invoice when detailed evidence was purged.

## Future acceptance evidence

These are targets for the owning implementation issues, not tests already run:

- Two authorized provider profiles pass mappings for ordinary, cached and reasoning usage, unsupported/missing fields and monetary valuation. Schema/normalization versions and real pinned SDK/server/provider compatibility are recorded. If a provider lacks a category, verify explicit unsupported/unknown handling rather than inventing data.
- A ten-request fixture has one ordinary request (1,000 input, 100 output), one cached request (2,000 input total including 1,500 cache reads and 200 cache writes; 300 output total including 100 reasoning), and eight zero-usage rejections confirmed before provider dispatch. The canonical measured totals are exactly 3,000 input and 400 output; cache/reasoning breakdowns are not added again. A separate interrupted request with absent usage has unknown counters and conservative exposure, not zero.
- Replay each final observation 100 times, replay cumulative updates and deliver gateway/SDK reports in both orders. Totals remain unchanged. A distinct billable retry is counted once in addition; conflicting/later corrected observations preserve revision history and missing coverage.
- Two concurrent requests each seeking 6 units against 10 available units admit at most one. Repeat across restart/lease replacement and period change; no second dispatch occurs without actual capacity. Unknown exposure cannot be automatically freed by a timeout or restore. Units are synthetic fixture values, not a selected real budget or currency.
- Aggregated API, UI and digest totals equal SQL canonical request totals under repository filters, mixed currencies, parent/child grouping and late corrections. Include digest-generation usage, failed/cancelled requests, DST and boundary fixtures; display known updates within 60 seconds. Export and metric labels contain no raw prompt/secret/high-cardinality leakage.
- Actual pinned Colima/OpenCode gateway integration demonstrates correlated outbound calls, cancellation/retry observability and crash recovery, beyond mocked tests. No new host mount, agent network route, credential or billing permission is introduced to collect usage.

## References and implementation limits

Official documentation checked October 16, 2026:

- [OpenCode SDK](https://docs.opencode.ai/docs/sdk/): typed client, generated types, session/message reads and events provide integration surfaces. It does not guarantee identical accounting fields or billing semantics for every provider/version.
- [OpenCode server](https://docs.opencode.ai/docs/server/): server API/OpenAPI discovery supports a pinned adapter contract. The J1/J3 prototype must inspect and test the actual selected schema; polling/events alone do not establish completeness.
- [OpenCode provider configuration](https://docs.opencode.ai/docs/providers/): provider choice is separately configured; supported providers are not automatically interchangeable accounting implementations.

JARVIS's ledger, normalization, atomic budgets, routes and acceptance fixtures above are proposed application behavior. No SDK plugin, current provider price, invoice reconciliation service or guarantee of measured financial completeness is assumed. Concrete limits, pricing, provider authorization and retention remain owner decisions at their existing gates.
