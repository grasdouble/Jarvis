# Improvement proposal and promotion-content contract

Produce content for exactly one observed improvement hypothesis. Follow the trusted project profile for project-specific records, labels, branch names, content version and language; follow the controller mission for authorization, limits and approval policy. Before a candidate change exists, return a proposal through the controller's declared record store. After a real change exists, maintain the profile's promotion record with the same evidence. The controller validates equivalent content across clients.

Required content:

- **Problem and evidence:** observed failure or inefficiency, impact, source IDs/links, observation window and relevant source/artifact revisions; sanitized reproduction where known. Mark unknowns; do not invent measurements.
- **Hypothesis and expected outcome:** one falsifiable claim, why the proposed change could help and what would refute it.
- **Baseline and target:** incumbent artifact/configuration, observed measurements and proposed target/guardrails; target revision and evaluator/workload/profile references when available. Separate actual facts, desired thresholds and estimates.
- **Scope and manifest:** included changes/paths, exclusions, internal task slices/dependencies if needed, task record/original-to-integrated revision mappings and current candidate revision. No unrelated optimization in this promotion.
- **Acceptance and comparison:** measurable quality/security/completion requirements, gain metric, fixed protocol/sample sufficiency, uncertainty, actual checks and independent verification. Missing owner thresholds prevent execution rather than inviting invented limits; unavailable results keep the promotion incomplete.
- **Limits and authorization:** report controller-supplied scope, size, attempt, elapsed-time and resource bounds, consumption and current decision owner when present. A proposal requests a decision; it cannot authorize itself or define missing limits.
- **Risks and recovery:** regressions, data/schema/permission implications, stop criteria and recovery/rollback feasibility; source promotion and activation acceptance separately.
- **Tracking:** proposal/deduplication and campaign identity, prior related/rejected/deferred proposals, canonical promotion record when confirmed, task/repair records and supersession history, lifecycle stage, independent assessment and next owner/action. Use the profile's tracking convention; do not invent issue links or project identifiers.

The controller resolves native IDs from trusted configuration, validates profile-conforming content and reads back the saved promotion identity, target, labels and project membership. Labels, views, draft state and skill output never grant authority or satisfy an approval gate.

The durable controller record admits one campaign per project-scoped proposal key and at most one active promotion record per campaign. Reconcile ambiguous effects and existing records before creating replacements. Preserve linked superseded records and cumulative budgets when repair requires a new candidate; rejected/deferred proposals remain internal when the profile selects a controller-owned record store. A task integrated only into a candidate is not delivered. Apply the mission's explicit approval policy to the exact candidate digest; absence or ambiguity requires human review. Confirmed source integration records delivery only; activation requires separate authority and evidence.
