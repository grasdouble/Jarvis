# Architecture decision index

Use the [governance procedure](../project-governance.md) and [template](template.md) for significant decisions. Keep each record focused on a single choice. This index describes decision history, not runtime authorization or implementation status.

## Existing identifiers and new records

The [architecture decision table](../technical-architecture.md#2-architecture-decisions) already uses ADR01–ADR11 (displayed as ADR 01–ADR 11). Those identities remain stable; a later linked record may partially supersede their scope without rewriting history. PRD Dxx entries are a separate owner-decision register: link a relevant Dxx entry, do not rename it or infer resolution from an ADR title.

Reserve numeric ADR identities 1–11. New standalone records use `NNNN-short-title.md`, with heading `ADR-NNNN`; the next unallocated number is currently **0014**. Inspect this index, the target revision and active decision work before assigning a number; coordinate/reconcile collisions before publication. Once published, never renumber or reuse an identity, including a rejected or superseded record. Filename numbers identify decisions, not package/document versions.

| ID / title | Status | Owner | Scope / related decisions | Record |
| --- | --- | --- | --- | --- |
| ADR-0013: Proposed gateway egress proxy | Proposed | Owner | Network egress for per-attempt LLM gateway; D02, D05; ADR 05/10 | [0013-gateway-egress-proxy.md](0013-gateway-egress-proxy.md) |

ADR-0012 was withdrawn at the owner's direction before adoption; its standalone candidate record was removed in the JV-125 change. The identifier is retired and will not be reused. The accepted product direction is recorded in [PRD D17](../prd-and-roadmap.md#12-decision-register-and-fallback-values) and its owner evidence in JV-124/JV-125.

Each new index row records ID/title, status, owner, relevant requirement/Dxx or legacy ADR references, record link and acceptance/supersession evidence. Keep source and status consistent with the record; do not duplicate its full rationale here. The index is decision history, not a live verification log: dated operational evidence belongs with the relevant operational procedure, and must identify what was actually checked and when.

## Lifecycle and acceptance

| Status | Meaning |
| --- | --- |
| Proposed | Choice or acceptance is pending; may guide authorized preparation, but cannot authorize dependent work or replace the current accepted baseline |
| Accepted | The required owner's actual decision is evidenced for the stated scope and all applicable review/promotion gates are satisfied; accepted design still does not prove implementation or activation |
| Rejected | Proposal was declined; retain its rationale/disposition and source, never reuse its ID |
| Superseded | A later accepted record replaces the specified part; link both directions and preserve the old rationale and unaffected scope |

Record creation/update dates truthfully. Acceptance includes owner/actor, actual date and a stable reference or recoverable evidence to the authorized scope and reviewed revision. A closed issue, merged unrelated PR, source snippet or agent verdict is insufficient. If evidence is unavailable, leave acceptance unknown/Proposed and identify the required owner input; never backdate acceptance. A human decision already given in the authorized session need not be requested again, but existing native/current-head review gates still apply.

An `Accepted` string in a candidate branch is not effective authority. Verify acceptance provenance against trusted human/session or authenticated GitHub evidence and current trusted-base policy; proposals/candidate changes cannot accept themselves or relax their own delivery gates. Published prospective record/status/index changes require the same review and owner gates as the substantive decision. A decision does not authorize deployment or activate a changed permission/profile.

For supersession, the old accepted decision remains effective until the replacement has the required acceptance/promotion. Update both records/index links together, state full or partial replacement and which scope remains applicable. Keep rejected/deferred proposals and prior sources; do not erase an inconvenient rationale. Clarifications/corrected references can retain an ID when the decision is unchanged, with truthful update evidence; material reversals need a new record. Product runtime execution, source integration and activation follow their separate existing gates.
