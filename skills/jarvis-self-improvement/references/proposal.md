# Improvement issue contract

Produce English issue content for exactly one observed improvement hypothesis. Controller validation applies equally to agent/API-created issues; a completed web form alone is not authorization.

Required draft fields:

- **Problem and evidence:** observed failure/inefficiency, impact, source IDs/links, observation window and relevant source/artifact revisions; sanitized reproduction where known. Mark unknowns; do not invent measurements.
- **Hypothesis and expected outcome:** one falsifiable claim, why the proposed change could help and what would refute it.
- **Baseline and target:** deployed incumbent S/artifact/config, observed measurements and proposed target/guardrails; target main B and evaluator/workload/profile references when available. Separate actual baselines, desired thresholds and estimates.
- **Scope:** included changes/paths, exclusions, candidate/task slices if needed and dependencies. No unrelated optimization in this root.
- **Acceptance and comparison:** measurable quality/security/completion requirements, gain metric, fixed comparison protocol/sample sufficiency, uncertainty and independent verification. Missing owner thresholds prevent execution rather than inviting invented limits.
- **Limits and authorization:** proposed/accepted scope, size, attempt, elapsed-time, token/currency/resource bounds and current decision owner. A proposal requests a decision; it cannot declare itself authorized.
- **Risks and recovery:** regressions, data/schema/permission implications, stop criteria and recovery/rollback feasibility; source promotion versus activation acceptance separately.
- **Tracking:** proposal/deduplication identity, prior related/rejected/deferred proposals, canonical root issue/campaign when confirmed, child and promotion PR links/history, stage and next owner/action.

The trusted controller assigns native `Self-improvement` milestone and `kind:self-improvement` label to the root, verifies project membership and records immutable native IDs. This label identifies root proposals for the dedicated view; task children inherit the operational milestone but do not receive the root label automatically. The future controller preserves native dependencies and candidate-local prerequisite evidence without falsely closing global issues.

The ledger admits at most one canonical root per proposal key, one campaign per root and one active main-promotion PR per campaign/root. Resolve ambiguous effects and reconcile existing PRs before creating replacements. Preserve linked superseded PRs and budgets when repair needs another head; rejected/deferred/abandoned roots retain their disposition, not a fabricated delivery. Rejected/inconclusive proposals need not produce a PR. Fully delivered source work reaches Done only after confirmed main integration and its acceptance; an issue requiring activation waits for that separately confirmed outcome.
