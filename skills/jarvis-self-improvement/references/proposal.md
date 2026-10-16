# Improvement proposal and PR content contract

Produce English content for exactly one observed improvement hypothesis. Before a real candidate diff exists, return a durable proposal draft; after that, use the same content to maintain its draft main-promotion PR. No operational issue, JV key or milestone is required. Controller validation applies equally to browser and programmatic publication.

Required content:

- **Problem and evidence:** observed failure/inefficiency, impact, source IDs/links, observation window and relevant source/artifact revisions; sanitized reproduction where known. Mark unknowns; do not invent measurements.
- **Hypothesis and expected outcome:** one falsifiable claim, why the proposed change could help and what would refute it.
- **Baseline and target:** deployed incumbent S/artifact/config, observed measurements and proposed target/guardrails; target main B and evaluator/workload/profile references when available. Separate actual facts, desired thresholds and estimates.
- **Scope and manifest:** included changes/paths, exclusions, internal task slices/dependencies if needed, task PR/original-to-integrated revision mappings and current candidate H. No unrelated optimization in this promotion.
- **Acceptance and comparison:** measurable quality/security/completion requirements, gain metric, fixed protocol/sample sufficiency, uncertainty, actual checks and independent verification. Missing owner thresholds prevent execution rather than inviting invented limits; unavailable results keep the PR draft.
- **Limits and authorization:** proposed/accepted scope, size, attempt, elapsed-time, token/currency/resource bounds, consumption and current decision owner. A proposal requests a decision; it cannot authorize itself.
- **Risks and recovery:** regressions, data/schema/permission implications, stop criteria and recovery/rollback feasibility; source promotion and activation acceptance separately.
- **Tracking:** proposal/deduplication and campaign identity, prior related/rejected/deferred proposals, canonical promotion PR when confirmed, task/repair PR links and supersession history, lifecycle stage, independent assessment and next owner/action. Do not add fictional closing issue references.

Core resolves native IDs, assigns `self-update` to the main-promotion PR, adds it to the project and verifies saved PR/base/head/label/membership. The dedicated view filters existing project items with `repo:grasdouble/Jarvis is:pr label:self-update`; filtering alone imports nothing. Technical task PRs do not receive the label unless they become the promotion candidate. All states remain visible for audit; closed/superseded is not successful delivery or activation.

The durable ledger admits one campaign per repository-scoped proposal key and at most one active main-promotion PR per campaign. Reconcile ambiguous effects and existing PRs before creating replacements. Preserve linked superseded PRs and cumulative budgets when repair requires a new head; rejected/deferred proposals remain internal without an empty PR. A task integrated only into the candidate is not delivered. Every promotion, including routine changes, needs current human approval of the exact digest and all native gates. Confirmed main integration records source delivery only; activation requires its separate authority and evidence.
