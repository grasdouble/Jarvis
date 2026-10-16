# Architecture decision index

Use the [governance procedure](../project-governance.md) and [template](template.md) for significant decisions. Keep each record focused on a single choice. This index describes decision history, not runtime authorization or implementation status.

## Existing identifiers and new records

The [architecture decision table](../technical-architecture.md#2-architecture-decisions) already uses ADR01–ADR11 (displayed as ADR 01–ADR 11). Those identities and rows remain in place; this change neither creates historical acceptance evidence nor bulk-migrates them. PRD [D01–D14](../prd-and-roadmap.md#12-open-decisions-and-fallback-values) are a separate owner-decision register: link a relevant Dxx entry, do not rename it or infer resolution from an ADR title.

Reserve numeric ADR identities 1–11. New standalone records use `NNNN-short-title.md`, with heading `ADR-NNNN`; the first unallocated number is currently **0012**. Inspect this index, the target revision and active decision work before assigning a number; coordinate/reconcile collisions before publication. Once published, never renumber or reuse an identity, including a rejected or superseded record. Filename numbers identify decisions, not package/document versions.

No standalone decision is introduced or newly accepted by this setup. The template is a reusable source, not a decision. Add a real record and an index row when actual significant work needs it; do not create a fictional decision to populate the directory. When an old choice needs extended context, preserve its legacy identifier and link its historical source instead of presenting it as a fresh accepted decision.

Each new index row records ID/title, status, owner, relevant requirement/Dxx or legacy ADR references, record link and acceptance/supersession evidence. Keep source and status consistent with the record; do not duplicate its full rationale here.

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
