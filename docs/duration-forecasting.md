# Task duration forecasting

**Status: post-MVP design, not implemented or calibrated.** [JV-083](https://github.com/grasdouble/Jarvis/issues/83) specifies P15; undated J10 parent [JV-084](https://github.com/grasdouble/Jarvis/issues/84) coordinates measurements (JV-085), estimates/API (JV-086), presentation (JV-087) and validation/operations (JV-088). The MVP already plans request timestamps and operational durations; this elaboration adds no new MVP exit criterion. J10 follows verified JV-025 but has no automatic dependency on J6/J8/J9 solely by phase number.

## Position in the workflow

```text
Authorized request -> classify/prepare -> advisory preflight estimate
  -> existing admission/reservation/queue -> actual execution
  -> conditional updates as observed stages change -> actual/forecast comparison
```

The trusted core may refine an estimate after a normal authorized plan becomes available, without running an extra model call solely to predict duration. No forecast is required to admit a task: cold starts/unavailable estimates leave current policy, quotas, deadlines and queue order unchanged. Existing task planning/model calls remain accounted for normally. The estimator is a bounded statistical component using existing llm/domain/contracts/persistence/observability modules, not another service, agent loop or training job.

Show preflight, current state/elapsed time and completion comparison in the task and queue views. Future J8/J9 responses may reuse the same scoped service once those capabilities exist, without making messaging a prerequisite. An estimate is a range for a defined outcome, not a promise or a measured percentage complete. Never silently select a model, reduce effort, reorder tasks, extend a timeout/budget or substitute an approval because a configuration looks faster. Alternative comparisons include only already admitted profiles, clearly distinct from the selected execution configuration and its measured quality.

## Measurement and attribution

Use canonical task/attempt/request/stage identities, UTC instants and versioned observed intervals. Within a process, monotonic clocks measure elapsed intervals; reconcile restarts/clock changes through persisted state and flag gaps. Record task creation, dispatch and terminal outcomes, stage transitions, parent/child topology, provider/model/resolved version, runtime/profile/effort mapping version and safe numeric workload features available at that point (for example diff bytes/file count, context-size estimate, task kind). Do not store prompts, code excerpts, reasoning text or private paths as estimator features.

Capture the requested effort and the qualified profile/provider mapping actually used; unsupported or unobservable settings stay explicit. A configured value does not prove the model's internal reasoning work. Retain cache, provider-load or quota signals only where observable and permitted; do not invent their values. Cross-provider/model effort labels are not equivalent speed multipliers. A changed model/runtime/profile or unknown effective configuration invalidates an unsupported cohort comparison.

Separate the forecast target and its coverage:

| Measure | Meaning |
| --- | --- |
| Task wall time | Creation to observed terminal state, including waits/gaps, with incomplete evidence identified |
| Execution elapsed | Observed preparation/model/provider/tool/validation work, including I/O/provider latency; this is not CPU time |
| Waiting | Separate queue/capacity, external CI, human response and explicit suspension intervals, where observed |
| Unknown time | Missing transitions, clock/restart/sleep/provider-observation gaps; never silently relabelled model work or zero |

Mac sleep may outlast a provider operation; unless reliable timestamps establish its actual end, keep completion timing uncertain. Missing first-token or detailed tool timings remain null. Summaries must state whether waits/unknowns are included; no numeric total is promised if evidence cannot support it. Persist finite retries/failures/abandoned attempts rather than only successful work. A timeout or lost terminal event supplies a censored/lower-bound observation, not an exact successful completion duration.

For parallel children, use observed spans and known dependencies/critical paths, not a sum of all agents' elapsed time. Aggregate compute/token cost remains a separate quantity. Quantiles cannot generally be added or combined by taking a maximum: estimate the actual end-to-end target from comparable workflow evidence or a separately validated dependency model. Unknown topology/correlation yields limited coverage rather than a fabricated parent ETA.

## Initial estimator and calibration

Start with scoped empirical cohorts and a simple historical baseline. Group comparable task kind/workload, provider/model/version, profile and qualified effort configuration, with environment/concurrency conditions when available. Use only authorized history; default to repository/owner scope. Cross-repository pooled statistics require an explicitly permitted aggregate policy and cannot reveal another repository's workload, sample count or context. Version cohort rules, feature availability, sample/freshness thresholds, quantile definition and fallback procedure as implementation configuration; no universal fixed multiplier or accuracy target is selected here.

Return a central estimate and, when justified, an interval/upper empirical percentile, sample count, as-of time, data window, estimator/calibration version, excluded/censored/unknown coverage and status (`insufficient_data`, `partial`, `stale`, `calibrated`, `unavailable`). An empirical p90 is a historical quantile, not a guarantee of future 90% coverage; a data-sufficiency label is not a statistical confidence interval. A broad fallback must identify its separate source/validation and low-confidence status. Otherwise abstain. Old model or changed-profile data cannot silently inherit a calibrated label.

Predicting completion from successful runs is conditional on that outcome: expose the unsuccessful/censored population and do not interpret a fast failure as a completed task. Evaluate errors, interval coverage/width and exclusions against representative chronological holdouts using features available at the prediction timestamp. No leakage from realized future output tokens, actual duration or later repairs into a preflight feature snapshot. Freeze/version the evaluation protocol and retain hard/long cases; a model's own assessment cannot establish calibration. Quality/success rates remain distinct from speed, and apparent gains cannot come from dropped work or weaker acceptance.

Remaining-time estimates condition on the task still running, observed stage, elapsed history and work left. Subtracting elapsed time from an original median is not sufficient. When a conditional model is unsupported, show elapsed plus the original forecast with its age/limitations, and leave remaining time unknown. Never present a negative remaining time or a zero prediction as evidence that work finished. Preserve every issued snapshot and compare it against its actual target; later predictions cannot overwrite an earlier error. Coalesce unchanged evidence rather than writing a forecast on every streamed token.

JV-088 records chronological holdout and actual-runtime evidence before production forecasting is enabled. Testable sufficiency/calibration acceptance is documented at implementation; do not promise an arbitrary error percentage now. Monitor drift, stale profiles, holdout coverage, absolute error and interval width; downgrade/disable misleading estimates while core work continues under its existing controls. No unbounded live benchmarks, paid comparative calls or automatic profile optimization are authorized by this design.

## Contracts, data and presentation

Proposed `execution_timings` link normalized interval observations to existing canonical tasks/attempts/requests with source, version, state and completeness; deduplication/correction projections cannot add repeated or overlapping spans. Proposed `duration_forecasts` bind task/attempt, prediction phase/as-of evidence digest, target definition, profile/workload digest, scope, estimator/calibration version, nullable central/range/percentile/remaining seconds, expiry and coverage/status. Unique logical snapshots make repeated reads idempotent. `forecast_calibrations` retain method/cohort/data-window/holdout digests, metrics and scope; immutable actual-versus-predicted comparisons link existing outcome evidence rather than duplicate raw task content.

An authenticated bounded `GET /api/v1/tasks/:id/estimates` returns current and cursor-paginated historical snapshots with validated scope/profile filters (at most 100 records/page); it exposes no arbitrary endpoint/model selection or raw evidence. Missing/ineligible estimates are explicit data states, not task failure. The UI shows forecast target, range/median, evidence freshness/sample size, calibration status and separated waits; a local-time completion date requires a justified end-to-end estimate and displayed timezone. Human/CI waits without evidence remain unknown. Use the same read contract for future messaging with its existing disclosure policy.

Retain/delete numeric feature, cohort and prediction data under existing D09/D11 and applicable conversation/channel policies; thresholds do not grant new retention or cross-scope authority. Deletion invalidates affected feature/cohort/calibration caches and projections; immutable provenance can retain only permitted content-free markers. Restore applies forgetting/revocation first and marks missing/newer timing evidence stale/unknown. Historical predictions may remain as permitted audit facts, but revoked evidence cannot supply a current estimate or a false calibrated label. Bound scans, sample windows, update frequency, pagination and compute; estimator outages cannot consume unlimited worker capacity or block safety controls. F09 reservations and actual usage remain authoritative regardless of forecast error.

## Future verification cases

- A synthetic complete same-cohort sample of 20 durations 10,20,...,200 seconds yields median 105 seconds and nearest-rank p90=180seconds. Those numbers are fixture arithmetic, not measured provider performance. Replaying each observation 100 times adds no sample or elapsed time.
- Sparse/empty history, unknown effort, changed model/profile/runtime, stale data and forbidden cross-repository history cannot produce a calibrated label; per-field coverage and fallback/abstention are checked.
- Parallel observed children spanning 0–20 and 0–30 seconds have 30 seconds of parent execution elapsed, not 50. Unknown topology or overlapping wait classification preserves limitations rather than silently summing.
- Failed/cancelled/timed-out/unfinished cases remain visible; chronological holdouts cannot see later realized tokens or outcomes. Median, interval coverage, width/error and censoring statistics match a fixed oracle.
- Conditional remaining estimates cover long-running/stage-changing cases; missing conditional evidence never becomes `max(0, original-estimate - elapsed)` labelled as a calibrated ETA. Clock jumps, restarts, sleep, retries, deletion/restore and unsupported metadata preserve immutable provenance.
- API/UI and optional channel presentation agree on forecast target/scope/status; no forecast can override budget, configured timeout, profile, queue priority or human/native approval. Real calibration evidence is separate from mocked/synthetic tests.

## Reference and limits

[OpenCode model variants](https://opencode.ai/docs/models/#variants), checked October 16, 2026, document provider/model-dependent effort configuration. They do not define task-duration multipliers or forecast accuracy. The statistical design, contracts and future evidence above are JARVIS application work. No provider speed, real sample count, measured accuracy, SLA or enabled predictor is claimed.
