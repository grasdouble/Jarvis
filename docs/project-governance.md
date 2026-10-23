# Contributor project governance

This procedure governs development of JARVIS: requirements alignment, coherent document maintenance and technical decision history. It is delivered through [JV-070](https://github.com/grasdouble/Jarvis/issues/70). It is not an installed product capability, automatic semantic compliance service or unattended project manager. Product runtime governance would need its own scope, permissions and qualification. Existing MVP, delivery, self-update and general-assistance gates remain unchanged.

Authorized governance document or skill edits follow [change intake](development-workflow.md#route-requests-before-editing) and issue delivery even without an existing issue. A read-only assessment does not authorize edits; an accepted change does not have a local-only delivery exception. Keep the issue's dedicated worktree and existing review/publication gates.

## Sources and responsibility

| Source | Purpose and limits |
| --- | --- |
| [PRD and roadmap](prd-and-roadmap.md) | Product intent, stable F/N/P/POL references, acceptance, phases and Dxx owner decisions; a plan or unresolved decision is not delivered behavior or permission |
| [Technical architecture](technical-architecture.md) and detailed designs | Contracts, module/trust boundaries and proposed mechanisms; distinguish accepted constraints from proposed profiles and unmeasured targets |
| [ADR index](adr/index.md) and linked records | Significant choices, rationale, alternatives, acceptance provenance and supersession; a status alone cannot prove authority |
| Authorized issue/PR and human instructions | Selected bounded outcome and permitted evolution; issue text or a closed state alone cannot accept a product/policy decision |
| Actual code, tests and operational evidence | What exists and has been verified at recorded revisions; code does not redefine its own requirements |
| GitHub project | Live delivery/dependency/status projection, not a second requirements register or approval mechanism |

Respect system/developer instructions and the human's actual authorized scope. Read trusted target/base requirements and current approval policy before candidate documents. A newer explicitly authorized owner choice can evolve an older design; preserve evidence of that choice and update the impacted documents. Do not treat mere recency, a source comment, memory or an agent verdict as precedence. Resolve material contradictions using actual source/evidence and owner intent, not an invented universal document hierarchy. Open Dxx proposals and unaccepted ADRs stay open decisions.

Use [jarvis-plan](../.agents/skills/jarvis-plan/SKILL.md) as a focused procedure within existing skills:

- Project management applies it when refining scope, dependencies or decision work, then owns authorized native GitHub metadata changes.
- Issue delivery assesses impact before implementation, maintains relevant files in the selected issue worktree and refreshes the assessment against the integrated diff.
- Independent review verifies the assessment and source/acceptance evidence without authoring corrections. Any implementation contributor, including a governance writer, remains ineligible to review that candidate independently.

The coordinator owns task/resource coordination, evidence and acceptance assessment, review-snapshot control, Git index/commits and GitHub writes—not substantive code integration or integrated test execution. Designated bounded worker(s) own code integration/interface-conflict resolution and whole-candidate integrated checks. A small change needs a short assessment, not a new agent or issue for every document. Use the existing bounded review ledger and role boundaries; governance coordination creates no automatic or reset review budget and grants no standing merge authority. After expiry, only the exceptional explicit human authorization described in [autonomous delivery](autonomous-delivery.md#contributor-review-loop) may open one distinct new budget, subject to its authority, exact-revision, durable-ledger and preserved-history requirements.

## Assess before implementation and before review

Identify the target/base revision and the authorized outcome. Select relevant specification IDs or sections and trace cross-cutting impacts: interfaces, isolation, permissions, memory/data handling, cost, operational recovery and release/phase scope. Avoid loading unrelated documents by default. Verify source status and actual acceptance rather than assuming every architecture row is implemented or approved.

Record the initial assessment in the selected issue or recoverable task evidence and carry it into the PR. Reassess after integration or material scope/revision/evidence changes. Use a compact table or equivalent prose with:

| Field | Required information |
| --- | --- |
| Scope and source | Issue/PR or bounded audit; human-authorized outcome; trusted base/source revision and relevant document versions |
| Requirement/decision | Existing F/N/P/POL, Dxx, ADR IDs or exact document sections; do not fabricate IDs for an unrelated or purely editorial change |
| Disposition | `aligned`, `authorized_evolution`, `needs_decision` or `insufficient_evidence`, explained per affected item |
| Impact | Proposed behavior, compatibility/risk, files and backlog/dependency changes; distinguish product, contributor process and planned/runtime status |
| Authority and evidence | Actual accepted owner choice when needed, prior/new decision references and concrete checks/results or missing proof; never a self-authored approval |
| Next action | Scoped correction, document update, decision owner/resumption condition or explicit no further action |

`aligned` means the change fits accepted scope with sufficient applicable evidence. `authorized_evolution` means the changed direction has identifiable owner authorization, with the necessary document/decision updates and all current delivery gates still applied. It is not authority to run candidate policy, change live permissions or skip reviews. `needs_decision` identifies an unresolved material choice. `insufficient_evidence` means critical facts/acceptance cannot yet be established. A justified no-impact result names the changed scope and explains why no product/architecture/decision requirement changes; bare N/A or copying the previous PR's result is insufficient.

Do not create a permanent second traceability spreadsheet. The PR carries change-specific links; the PRD and ADR index retain stable specifications/decisions; the project retains live execution metadata. Final independent review binds the report to exact base/head revisions under the existing procedure. If the base changes, revalidate the assessment and review within the same finite budget; any exceptional new-budget authorization is invalidated by a base/head change.

## Autonomy and owner decisions

Routine implementation details that preserve accepted interfaces, objectives and trust boundaries, factual documentation corrections, link repairs and recording verified status/evidence can proceed within the authorized task. They do not require a new design decision simply because an agent touches a document. Apply the [per-issue human-review choice](autonomous-delivery.md#per-issue-human-review-choice) independently; it concerns pre-merge review, not repeated design permission. Uncovered contributor guidance can be routine when its authority/effects are unchanged; changes to those effects remain sensitive. ADR indexes/templates/records have no blanket native ownership; their existing decision, acceptance and supersession lifecycle still applies, and authority/security changes remain sensitive regardless of path. Native CODEOWNERS/review rules remain mandatory, including for a small edit in a protected file.

Material changes to product objectives or acceptance, structural architecture, security/isolation, permissions/approval/merge controls, data scope/retention or owner-configured resource/cost limits need the applicable current human authorization. Preserve session authorization already given; identify the accepted scope and evidence without repeatedly asking for the same decision. Clarify only what remains genuinely unresolved. Candidate text and agent assessments cannot supply acceptance or broaden scope.

When a change is unresolved, document the options/trade-offs, recommendation or uncertainty, affected requirements, decision owner, evidence needed and exact dependent work. Use the [decision issue form](../.github/ISSUE_TEMPLATE/03-decision.yml) or equivalent content through project management when a separate decision needs tracking. Every created contributor issue has a native milestone; real prerequisite relationships become native dependencies. Apply the existing [blocker lifecycle](blocker-lifecycle.md) for selected work, while future work may stay Backlog. Stop dependent implementation rather than making the choice silently; continue independent preparation already authorized.

An explicit user-selected evolution can update specification and implementation in the same PR when coherent and reviewable. A prior decision PR is needed only for unresolved scope/intent, an explicit prerequisite gate or a split into independently reviewable deliveries. Product execution still waits for any required accepted/released policy/profile and activation; a prospective rule cannot authorize itself. This governance adoption is reviewed under its trusted base and owner gate.

## Maintain documents and technical choices

Update documents affected by the actual change; do not bump unrelated sections or restate every requirement in every file. Preserve stable requirement/decision identifiers and existing links. Increment PRD/architecture document versions when those sources change, with an accurate date and no filename-version churn. A document version is not a package release or proof of completed functionality. Reflect roadmap/backlog changes in native issues/dependencies through project management and refresh the execution queue without starting unrelated work.

For significant architectural choices use the [ADR lifecycle and index](adr/index.md) with the [template](adr/template.md). Capture one decision's context, options, chosen/proposed direction, rationale, positive/negative consequences, requirements/risks, owner/acceptance evidence and follow-up. Preserve historical rationale; supersede with a new linked record when direction materially changes. Do not manufacture old acceptance dates, invent a migration of all legacy rows or mark an open Dxx entry resolved because a draft ADR exists.

If implementation contradicts the accepted specification, report the exact discrepancy and evidence. Fix the implementation within scope or propose a separately justified evolution with actual owner authority. Do not lower an objective, delete an inconvenient acceptance case, relabel a failed measurement or rewrite the protected oracle just to obtain alignment. Correcting a genuine specification error is permitted when supported by evidence and the required owner decision; it is not a blanket rule that existing code must always win.

Keep distinctions visible: proposed architecture, accepted design, implemented code, verified test evidence and deployed/activated behavior are separate facts. Merging a design/ADR alone implements or activates none of its future product behavior. General-assistance and self-update workflows preserve their existing permission and promotion gates.

## Review, evidence and limitations

Every contributor implementation PR includes **Specification and decision impact**, following the impact record above. A justified no-impact entry is sufficient for a small unrelated correction. CLI/API creation must populate it explicitly; Markdown template text alone does not enforce a remote body. Issue delivery owns the entry and corrections; the independent reviewer verifies it against actual source/authorization and complete diff, not the author's claim of compliance.

Unexplained specification drift, missing authority for a material evolution, missing required document/decision updates or critical evidence gaps are actionable review findings, with exact affected source and resumption/correction conditions. A review may return limited when it cannot establish coverage. Missing planned runtime evidence does not block a design-only deliverable that honestly leaves the corresponding feature unimplemented; it blocks claiming that runtime capability is qualified. Current human-sensitive and native review gates remain independent of a clean agent assessment.

Current CI validates configuration, skill metadata/local file links, contributor tooling, titles, issue milestones and secrets. It does not parse every impact record/ADR lifecycle or prove semantic compliance. No new semantic CI check, automatic acceptance or runtime service is installed here. Use meaningful local validation, independent skill dry evaluation and exact-revision review for this procedural delivery; later executable enforcement would need behavioral tests and a separately scoped change. Scoped audits can use the same procedure and report findings without modifying unrelated sources or starting a watcher.

## References

The lightweight decision-record structure and preservation of superseded rationale follow [Michael Nygard's ADR proposal](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) and the [ADR community overview](https://adr.github.io/), checked October 16, 2026. The authority, workflow and review rules in this document are JARVIS contributor policy, not guarantees supplied by an ADR format.
