# Contributor delivery workflow

This document governs development of JARVIS. It is not an instruction set for the untrusted OpenCode review runtime. Repository changes are maintained in English.

## Route requests before editing

For JARVIS-related contributor-session requests, apply the [canonical tag-based routing contract](jarvis-request-routing.md) before this delivery intake. An absent or mismatched tag requires clarification before choosing a workflow; a tag-list request is answered directly. Routing is an instruction convention for normal repository sessions, not a technically guaranteed interception mechanism. Information, status, planning, and read-only audits do not themselves create delivery issues or branches; a concrete repository change still follows the complete workflow below.

A human request or acceptance of a concrete repository change starts the contributor delivery workflow, even when the human supplies no issue number and does not explicitly say "create a PR". This covers new files intended for version control and edits to code, configuration, documentation, `AGENTS.md` and contributor skills, regardless of size. A follow-up such as "OK, add that" after discussing a change is implementation authorization within that agreed scope; do not ask the human to restate the workflow.

1. Inspect the checkout, existing worktrees/branches/PRs and matching open/closed issues. Use project management to reuse suitable active work or create one bounded English issue with acceptance and verification, the appropriate native milestone, existing labels, stable JV key and project membership. Verify the saved metadata, prerequisite outcomes and ownership before starting; do not reopen delivered work merely to avoid a new issue.
2. Use issue delivery for governance assessment and sizing, then select/create the issue's dedicated branch in a separate worktree before any repository edits. Preserve unrelated changes in the primary checkout. Continue through focused commits, independent review and a linked PR under current publication and merge gates. By default, review a locally validated unpublished candidate on its exact immutable revision, resolve findings and obtain a fresh review before publishing; create the PR ready for review and verify its base/head still match. If exact local review is technically unavailable, use the published-PR review path without weakening any gate. Small documentation or working-agreement changes use the same route; they do not need separate issues for each file.
3. If intake, access, review or publication cannot be completed, diagnose the actual constraint and follow the blocker/handoff procedure. Distinguish network restrictions from authentication failures and use the environment's approved permission mechanisms where available; never silently switch to owner credentials. If no issue can be established, keep preparation read-only and retain the exact resumption condition outside tracked source. Preserve already existing progress in its worktree; do not use a failure to justify edits on the primary checkout.

There is no local-only delivery option. Retained uncommitted or unpublished work is incomplete progress, not a successful substitute for a PR. Explicit human limits (for example, no push or publication) and tool permissions still take precedence: honor them, explain the unmet delivery step, and do not claim completion or bypass the restriction. Routine review waiting remains In Review; an actual access or authorization blocker follows the [blocker lifecycle](blocker-lifecycle.md).

Pure questions, advice and read-only audits remain read-only. Backlog-only administration may maintain GitHub records within its own authorization without starting implementation. Neither path grants permission to edit repository files. Product `self-update` promotions retain their separate [operational intake contract](self-improvement-campaigns.md#operational-tracking-and-proposal-intake); they are not a contributor local-only exception.

| Human request or observed constraint | Required routing |
| --- | --- |
| "What do you think of this approach?" | Advice only; no file edits, issue or PR solely for the question |
| "OK, add that" after a concrete change proposal, without an issue number | Duplicate-aware issue intake with native milestone, then branch/worktree, review and PR |
| A small `AGENTS.md`, documentation or contributor skill edit | The same issue-to-PR workflow; no working-agreement exemption |
| GitHub read fails before intake | Diagnose access; if unresolved, read-only preparation and a specific blocked handoff, no primary-checkout edits |
| Unrelated changes already exist on the primary branch | Preserve them; create the selected issue's isolated worktree and exclude unrelated changes |
| Human explicitly prohibits publication | Respect the limit; report the incomplete delivery boundary, never publish or label local progress as delivered |

These are contributor routing expectations for review and skill evaluation, not an installed technical enforcement mechanism.

## Choose human review for each issue

At the start of every new issue delivery, including an issue created from a human request, ask whether the human wants review before merge. Record an already explicit answer for that issue instead of asking twice. Apply the [per-issue choice contract](autonomous-delivery.md#per-issue-human-review-choice): retain the answer across resumes, obtain a choice for each newly selected child unless explicitly covered, record its source in the ledger/PR, and never merge while it is pending. A declined optional review does not waive sensitive/unknown or native required approval. Continue independent authorized preparation while awaiting the answer.

## Wait for command completion

Execution tools may return control while a command continues in a session. When a result includes a session identifier or indicates that execution is still running, retain that identifier and resume or poll the same session until it returns a terminal result. If the orchestration call itself yields a running cell identifier, wait for that cell too, then inspect its final result and any underlying command session. Capture the final output and exit status; an intermediate output chunk or missing exit status does not establish completion or success.

Do not start a dependent read, write, retry, preview, or verification while the earlier command is still running. In particular, wait for a project mutation to finish before previewing or rereading its result. If a wrapper or orchestration layer is used, preserve and return the session identifier instead of dropping it. After a terminal failure or an ambiguous mutation, inspect the result and current state before deciding whether to retry. If the session can no longer be resumed, report the operation as incomplete and reconcile its state before restarting it. This is a contributor instruction, not technical enforcement by the repository.

## Keep specifications and decisions coherent

Use [project governance](project-governance.md) before implementation and again for the final diff. Delivery prepares the compact PR impact record and affected document/ADR updates; project management maintains live planning records; independent review checks the sources, authority and evidence. Routine work within accepted scope remains autonomous under current gates. Preserve actual owner authorization already given, stop only dependent unresolved work, and never change the specification solely to hide a defect. The [ADR index/template](adr/index.md) preserve significant decisions and supersession; current CI does not establish semantic alignment.

## Test-first behavior changes

Use RED → GREEN → refactor for features and bug fixes:

1. Translate one acceptance behavior into a focused test. Run it against the unchanged behavior and confirm the expected assertion fails. A missing runner, import, fixture, or syntax error is not behavioral RED.
2. Implement the smallest coherent change that makes that test pass. Run related tests to detect regressions.
3. Refactor with those checks green, then run the issue's required integration/security acceptance and repository checks.

For bug fixes, the RED test reproduces the defect. Test observable contracts rather than copying implementation details. Record actual commands, expected RED failure, GREEN result, and final checks in the PR; a deliberately failing commit need not be pushed. Never invent a RED observation after writing the implementation.

Documentation-only changes use links, consistency, and diff checks. Pure configuration/scaffolding work uses relevant validators and build/smoke evidence; behavioral scripts still warrant behavioral tests. Behavior-preserving refactors may begin with passing characterization tests. Explain the applicable exception and limitations. Unit tests alone do not establish real Colima isolation, remote permissions, or race/recovery acceptance.

## Run repository checks locally

The repository configuration validator and its Python unit checks require the pinned PyYAML dependency. Bootstrap an isolated environment with CPython 3.9–3.14 from the existing hash-verified requirements, then run the same checks used by CI:

```bash
python3 scripts/ci/bootstrap_validation_env.py "$PWD" --python python3.14
.venv/bin/python scripts/ci/check_repository.py
.venv/bin/python -m unittest discover -s scripts/ci -p 'test_*.py'
```

The helper reads requirements only from its own trusted checkout and installs with `--require-hashes --only-binary=:all:`. When preparing another checkout, invoke the helper from a reviewed trusted checkout and pass the target checkout path; never run a candidate PR's copy as a trusted setup tool or use its requirements as the trusted source. The `.venv/` is local to each target worktree/reviewer workspace, ignored by Git, and must be prepared separately after a fresh checkout/session. If trusted main does not yet contain the helper, follow the manual hash-verified setup below as a temporary fallback, inspecting `.github/requirements-ci.txt` from trusted base first:

```bash
python3.14 -m venv .venv
.venv/bin/python -m pip install --require-hashes --only-binary=:all: -r .github/requirements-ci.txt
```

The requirements file retains the Ubuntu CI wheel hash and includes verified macOS ARM64 and x86_64 wheels for CPython 3.9–3.14. Do not install the validator dependency into the system Python.

## Slice issues into reviewable deliveries

A parent issue describes the complete outcome. Create native GitHub sub-issues when it contains several independently reviewable outcomes, crosses unrelated concerns, or requires a PR that cannot be understood and verified as one coherent change. Keep a small issue intact; no fixed line-count threshold substitutes for judgment.

`jarvis-delivery` assesses size before coding, defines the slices and their acceptance, and invokes `jarvis-backlog` for issue creation/reuse, parent links, blocking dependencies, and project metadata. This stays within the human-authorized parent scope. Parent/child linkage describes scope; blocking links describe execution order. Do not make the parent block its children or create dependency cycles.

Each implementation child has its own stable `[JV-NNN]` planning key, scope, measurable acceptance, verification, priority/area labels, milestone, dedicated branch, linked worktree, and PR. Match new planning keys to the created GitHub issue number, checking existing keys for collisions; keep existing keys stable. Checklists within one issue are suitable for steps that belong in the same PR, not for independent deliveries.

Each child PR uses `Closes #child` only for full acceptance and `Refs #parent` for context. Merge sequentially into the verified target branch when slices depend on each other; refresh dependent branches and rerun checks. There is no mandatory umbrella implementation PR. After confirming child delivery, the project-management skill can append an App-authored evidence snapshot to the parent for every completed native child. A snapshot records whether merged PR/current-head checks are validated; missing or insufficient evidence is recorded explicitly rather than omitted. If stronger evidence is later available, append a new content-addressed snapshot without editing the earlier comment. The on-demand structural check reads every native child and parent comment; eligibility requires all children `CLOSED` / `COMPLETED`, a validated child snapshot matching each child-mapped PR/check in the final report, and a final App-authored assessment whose structured record matches every exact current parent criterion as validated. Conflicting PR-to-child mappings across snapshots fail closed. Parent checklist boxes are neither edited nor required to be checked. This structural check does not prove semantic truth or evidence quality. When explicitly asked to validate/record acceptance, inspect every parent criterion against mapped child PR/revision/check evidence and any required end-to-end evidence. A PR may support multiple criteria for one child but must never be attributed to multiple child issues; verify its actual child relationship directly. Closed children, checked child boxes, or a progress counter alone do not establish parent acceptance. The append-only recorder adds a snapshot for each completed child, stops before final assessment while any native child remains open or any current delivery snapshot lacks evidence, and posts the final assessment only when every criterion is validated. Otherwise it reports gaps without posting a final assessment. It never edits parent body/checklist or closes the parent. Status/readiness remains read-only; closure requires separate explicit user authorization and a fresh structural check. Run one comment writer at a time; reconcile the complete comment inventory after an uncertain write before retrying. There is no event listener, background job, or CI check for parent status. The parent check does not specially exclude any issue number; tests use synthetic fixtures rather than mutating a live parent. It does not change child issues, labels, milestones, dependencies, or project fields. Parent closure does not replace integrated acceptance review or required human/native PR review.

If scope grows, split remaining work before growing the PR. Backlog planning may create children but does not itself authorize their implementation. A request to implement the parent can include its necessary slices, subject to the user's scope and existing merge gates.

## Project views

[Delivery](https://github.com/orgs/grasdouble/projects/1/views/1) shows issues only (`is:issue`), including coordination parents and implementation children. [Pull requests](https://github.com/orgs/grasdouble/projects/1/views/4) shows PR items only (`is:pr`). Keep PR membership and issue links, including linked PR badges. Backlog and Roadmap retain their milestone grouping; planned dates require an agreed schedule. The [actual-date contract](roadmap-actual-dates.md) separately derives observed realization from native project/closure history and defines backfill, reopen handling and automatic maintenance.

The Pull requests table displays native Milestone and a reserved derived **Issue** text column with the implementation issue's JV key and clickable URL. Follow [PR metadata synchronization](pr-project-metadata.md) at publication and after authorized link/milestone changes. Its reviewed command uses native closing-issue relationships, copies the issue milestone and never guesses a source or changes Status. The opt-in main-only workflow provides later reconciliation after secure credential/environment activation; it is separate from the session-driven delivery/review loop and the future runtime.

An actionable implementation child moves through Ready → In Progress → In Review → Done. A coordination parent may remain In Progress across several child PRs and review cycles. Inspect project automations before setting Done; it can close the issue. Done requires verified acceptance and confirmed delivery, including merge when a PR is used.

## Delegate implementation and preserve context

The [shared orchestration contract](jarvis-request-routing.md#orchestration-and-delegation) governs coordinator ownership and bounded delegation. For issue implementation, follow the [delivery coordination procedure](../.agents/skills/jarvis-delivery/SKILL.md#coordinate-bounded-implementation-work): record worker/integrator/validation ownership and evidence in the ledger; workers own substantive integration and whole-candidate validation; the coordinator retains acceptance assessment, review, Git and delivery controls. If suitable integration/validation capacity is unavailable, hand off rather than substituting the coordinator. One issue keeps one branch/worktree/PR; separately reviewable outcomes need child issues. Delegation does not enable product sandbox runs.

## Independent review and autonomous routine delivery

Follow the canonical [contributor review loop](autonomous-delivery.md#contributor-review-loop) and [direct validation contract](../.agents/skills/jarvis-review/references/direct-validation.md). Authors validate; the bounded integrator runs whole-candidate checks; the coordinator assesses evidence and freezes exact revisions; an independent reviewer directly selects/runs checks and must have authored none of the candidate. The review loop governs correction, publication, native gates and routine merge. In particular, each budget is limited to 60 elapsed minutes from first dispatch; expiry requires explicit owner acceptance bound to the exact run/PR/base/head and a confirmed App-authored audit comment before another dispatch. That trace is not authority or approval. Missing evidence or capacity requires handoff. These session procedures do not enforce isolation or timing, create a background service, or change product-runtime policy.

## Blocking and resuming work

Use the [blocker lifecycle](blocker-lifecycle.md) for English Blocked, Blocker update, and Unblocked comments, their required evidence, and recoverable comment/status synchronization. Selected/active work with unmet resumption conditions is Blocked; future planned prerequisites may remain Backlog. Resolve every active cause before returning to Ready or actually resuming. Refresh the execution queue after the verified transition; the queue tool does not create comments or change statuses.

## Required issue milestones

Every issue must have a native GitHub milestone: coordination parents, implementation children, bugs and decisions, open or closed. Apply [milestone selection and creation](#milestone-selection-and-creation) before creation and verify the saved metadata afterward, on reopen/triage, and before Ready or implementation. CLI/API creation must pass the milestone explicitly. A body reference is insufficient; an unknown destination must be resolved through project management before starting work.

J00–J05 cover the MVP, J06 covers autonomous delivery, J07 covers self-improvement, J08 covers post-MVP general-purpose assistance, J09 covers Telegram/Signal messaging, and J10 covers advisory duration forecasting after the MVP. J10 adds no automatic prerequisite on J06/J08/J09 and grants no dispatch/routing authority. J08 has no automatic dependency on J06/J07 solely by phase number. J09 notifications require the MVP; each channel's conversation additionally requires J08 qualification, without a dependency on the other channel or J06/J07 solely by phase number. Use the accepted roadmap and native prerequisites. These later milestones have no committed dates and add no MVP exit gate. A milestone is a delivery phase, not a promise of a calendar deadline.

GitHub's [issue form syntax](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms) cannot require native milestone metadata. Web/API users can temporarily create an issue without one or remove one afterward. The forms provide guidance; they do not enforce metadata. The [Issue milestone audit](../.github/workflows/issue-milestones.yml) runs on opening, reopening, milestone assignment/removal, main updates, manual dispatch and daily reconciliation. After merge, it fetches all open and closed repository issue pages, excludes PR records, and fails with issue links when any milestone is absent. Malformed input fails rather than reporting success. It uses read-only permissions and trusted main code, never issue text as commands, and never assigns arbitrary phases or posts comments. Failures are visible in Actions under the repository's existing notification settings; no separate notification service is installed.

Use the [CLI audit recipe](../.agents/skills/jarvis-backlog/references/github-cli.md#audit-required-issue-milestones) during backlog administration. Correct the native milestone, reread it, then verify the audit and refresh ranks. The queue additionally rejects any open issue without a milestone before preview or mutation, including coordination parents; closed history is checked by the broader audit. This detects drift and prevents incomplete queue updates; it does not atomically block GitHub issue creation.

### Milestone selection and creation

A product-phase or bounded one-off milestone groups a delivery outcome and its exit gate. A thematic DEV track groups continuing contributor work in one area and remains open for that area's evolution. Select the milestone from what the issue actually delivers, not the date of the request, its priority, the earliest prerequisite, or the fact that its files are documentation. Labels describe area/priority; native dependencies describe prerequisites. Milestone membership grants no implementation or merge authority.

Before creating or triaging an issue, inspect the roadmap and existing open and closed milestones/issues, then use these rules:

| Issue outcome | Destination |
| --- | --- |
| Initial MVP scope, owner decisions, threat model or acceptance plan | J00. It is not a general planning, documentation or maintenance bucket. |
| Product implementation, qualification or feature-specific design/decision | The accepted product phase whose outcome the issue advances. A specification delivered early still belongs with its feature; closing it does not satisfy runtime or milestone qualification gates. |
| Contributor-only repository security, development App, CI, project tooling, skills or governance | The thematic `DEV` track that matches the primary deliverable, separate from product phases. Reuse its open track for related work over time. Use a bounded `DEV — <outcome>` milestone only when the work has a distinct exit gate and does not fit an ongoing track. |
| Product workspace, package versioning or release foundation | J01 when it delivers the planned product foundation; contributor validation/administration alone follows DEV. |
| Bug or follow-up | The outcome whose next acceptance gate includes the repair, rather than automatically the component's historical phase or J00. |

For mixed or cross-phase work, identify the primary independently verifiable deliverable and record the destination rationale in the issue, with references to the other phases. For example, the shared token-accounting specification [JV-072](https://github.com/grasdouble/Jarvis/issues/72) belongs to J03, while digest/operations implementation remains in J05; self-improvement specifications belong to J07. Split independently reviewable outcomes through the existing issue-slicing procedure instead of forcing them into one milestone. A coordination parent follows its integrated outcome; each child is assessed separately and inherits only when appropriate. A decision belongs to the outcome it unlocks. An unresolved material owner choice remains unresolved, regardless of assignment.

Reuse an existing open milestone when its scope fits. Do not create a duplicate merely for one issue, a document type, a priority or a new request. Inspect closed milestones too. If a new issue falls within the original scope of a closed milestone that is still applicable, reopen that milestone in place by its stable native number and assign the issue to it. This applies to product-phase milestones and contributor DEV milestones alike. Record the scope match and reason; update the milestone description if needed to clarify its scope or lifecycle. Reopening does not reopen completed issues or rewrite their history. The milestone's original acceptance or exit gate applies again, and the new issue must pass it before the milestone can close. Do not reopen a milestone whose scope is retired, superseded or unrelated; create a distinct milestone when no existing scope fits.

A thematic DEV track remains open while its contributor area is active; completing every currently assigned issue does not close the track. Close an ongoing track only when its scope is retired or superseded by an explicit owner decision. Product-phase milestones and bounded one-off DEV milestones may close when their defined acceptance or exit gate is verified; a later in-scope issue reopens that same milestone and returns its gate to active work.

The ongoing contributor tracks are:

| Track | Included scope | Excluded scope |
| --- | --- | --- |
| [DEV — Delivery & planning](https://github.com/grasdouble/Jarvis/milestone/16) | Issue intake and sizing; native dependencies and milestone selection; execution queue; issue/PR/project planning metadata and Roadmap planning synchronization. | CI, development environments, validation tooling, ownership policy and review/merge rules. |
| [DEV — Tooling & validation](https://github.com/grasdouble/Jarvis/milestone/17) | Development App and network tooling; CI and repository security automation; contributor scripts; development environments; validation execution, checks and disposable review workspaces. | Issue/milestone/queue administration; specification and decision governance; CODEOWNERS and human-review/merge policy. |
| [DEV — Governance & review](https://github.com/grasdouble/Jarvis/milestone/18) | Specification and decision traceability; CODEOWNERS and ownership gates; human and independent review, approval and merge policy; contributor process and skill guidance. | CI or validation tooling implementation; project planning and queue administration. Script/tool implementation bundled with a skill belongs to Tooling & validation; process and policy guidance belongs here. |

For mixed work, choose the primary independently verifiable outcome and record the rationale. Split independently reviewable outcomes into separate issues and assign each issue to its own track. If tightly coupled work cannot be split, assign the primary deliverable's track and explain the cross-track scope in the issue.

`DEV — Contributor foundation` ([milestone #13](https://github.com/grasdouble/Jarvis/milestone/13)) is retained as closed historical tracking after these three tracks are established. Its existing issues and linked PRs keep their historical milestone assignment. It is superseded and must not be reopened for new thematic work; assign future work to the applicable track. The closed `DEV — Milestone ordering` and `DEV — Contributor review controls` milestones remain their original bounded outcomes and are not repurposed as thematic tracks. Reopen either only for new work within its original scope, under the rule above.

Select the destination by scope across the complete open and closed milestone inventory, not by milestone type or title similarity. Historical reclassification is a separate metadata correction.

Create a milestone only when no existing applicable open or closed milestone covers the work. A new bounded milestone needs an authorized distinct outcome, English title, included/excluded scope, measurable exit gate, non-overlap rationale and relevant prerequisite references. A new thematic DEV track needs an authorized continuing contributor area, English title, scope, lifecycle condition and non-overlap rationale. Routine creation within already authorized delivery/planning needs no repeated permission; a new product objective, acceptance gate or unresolved phase choice needs the applicable owner decision first. Reuse or reopen an existing matching milestone if one appears during the final reread.

Use `JNN — <outcome>` only for an accepted product roadmap phase, with two digits for indices 0–99, maintaining existing identities and roadmap mapping. Before exceeding two digits, qualify a common wider format and its queue compatibility. Do not invent a phase number for contributor work. Use an existing thematic `DEV — <track>` for continuing contributor areas and `DEV — <outcome>` for a bounded one-off contributor delivery that fits no ongoing track. Leave due dates unset without an agreed schedule; package versions are independent of milestone names.

The previous unpadded names `J0`–`J9` are historical aliases for `J00`–`J09`, not new phases. The queue accepts both spellings during migration and for historical data, comparing their numeric values. Deliver the compatible parser to trusted main through the existing review/merge gates before renaming live milestones; a reviewed candidate alone does not update other agents or main-based automation. Older checkouts that cannot read the new spelling must update before refreshing ranks. Renaming a native milestone in place updates issue/PR membership and project groups automatically; update current repository guidance, active issue titles/bodies, project README and affected saved filters, then verify identity, membership and equivalent queue ranks. Preserve closed discussions and historical decision text instead of rewriting acceptance evidence.

After assignment or creation, reread the saved native metadata and verify title, scope/exit gate and project membership. Record a short issue rationale for a new milestone, mixed scope, child/parent divergence or historical move; routine unambiguous assignments need no duplicate commentary. Synchronize linked delivery PRs through the [PR metadata contract](pr-project-metadata.md) and refresh Next up. Preserve statuses, dependencies and observed dates unless their change is separately justified. Named milestones, including DEV, currently sort after numeric J phases; an explicitly selected issue still takes precedence. Do not rename milestones or invent dependencies to manipulate ranks; a queue-ordering change is a separate authorized change.

The missing-milestone audit checks presence, not whether this semantic choice is correct. Contributor assessment and independent review provide the selection evidence; these rules install no semantic classifier or background service.

## Select and refresh the next issue

[Next up](https://github.com/orgs/grasdouble/projects/1/views/5) is the execution-order view. The project is the live source of work; this document defines the rule rather than copying a numbered backlog into Git. The table filters `is:issue is:open has:execution-order`, sorts Execution order ascending, and displays title, status, labels, milestone, and rank. Delivery/Backlog/Roadmap retain their existing purposes.

A successful write-mode queue refresh also attempts the reviewed helper's safe local `main` refresh; this is best-effort and never changes the queue result. See [safe local main refresh](development-github-app.md#safe-local-main-refresh). Do not use it in place of exact-SHA issue-base verification.

Ranks are derived from native blocking links plus parent/child structure. Treat open children as prerequisites of their coordination parent for ordering; give only open implementation issues ranks. Coordination parents and closed issues have their old rank cleared. Topologically order dependencies first. Among currently dependency-available issues, compare the coordination parent's milestone phase and priority first when the issue is a child; otherwise use that issue's own phase and priority as its context. Then compare the issue's own milestone phase and priority, creation time, and GitHub issue number. This lets a child such as JV-034 use its J01/P1 parent's ordering context while retaining its own DEV milestone and P1 label; no issue metadata is copied or changed. A child's own phase/priority break ties within the parent context. Legacy unpadded aliases have the same numeric value; named milestones follow numeric phases and missing priorities sort last. Parenthood remains hierarchy, not a native blocking edge; only actual blocking links add dependency constraints. Every open issue, including a coordination parent, must have a nonblank native milestone or the entire preview/write fails before rank mutation. JV identifiers remain stable references, not priority. This forecasts future execution as prerequisites finish; it does not claim they have already finished.

Run from a reviewed checkout with the configured development App:

```bash
# Read-only preview, including unmet prerequisite numbers and Ready candidates.
node .agents/skills/jarvis-backlog/scripts/github/sync-project-queue.mjs
# Authorized project maintenance: write changed ranks and reread them.
node .agents/skills/jarvis-backlog/scripts/github/sync-project-queue.mjs --write
```

The tool reads project 1 and the complete Jarvis issue inventory, paginates outer connections, and fails without writes if nested connections are truncated, dependencies/children are unavailable, a cycle exists, or an open repository issue lacks project membership. It rereads before mutation and verifies the resulting ranks. API writes are not atomic across batches. Writes use sequential batches of at most five field changes, with at least one second between mutative requests. After a recognized transient transport/HTTP 500/502/503/504 or GraphQL timeout, the tool waits, rereads the complete snapshot, and retries only missing intended changes with smaller batches (five, two, then one). It permits at most three recovery rounds, with exponential waits starting at one second; successful responses also require a final reread and use the same bounded recovery budget if ranks are missing. A lost response after complete success needs no further mutation.

Recovery stops on changed planning inputs/membership, unexpected rank edits, unreadable/incomplete reconciliation state, permanent/unknown errors, or exhausted recovery. Permission, validation and rate-limit failures are not automatically retried; follow GitHub's reset/Retry-After guidance before a later manual refresh. Confirmed partial progress remains in GitHub. After a stopped run, inspect the current project and run a fresh preview before another authorized `--write`. Only a verified run emits an updated result. Snapshot checks are optimistic, not a transaction or exclusive lock: avoid concurrent queue writers; a concurrent edit equal to the original or intended rank cannot be distinguished from this run's observed state. It uses the existing reviewed App helper without new scopes, personal-login fallback, or runtime sandbox access. Review tooling changes before using them with credentials. Timeout recovery is tested with injected, credential-free transports; it does not deliberately cause a live outage or guarantee GitHub availability.

References: [GitHub GraphQL timeouts, resource limits and mutation pacing](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api). GitHub may terminate requests after ten seconds and return partial results; smaller requests reduce exposure but cannot eliminate service failures.

An agent asked to handle the next subject must:

1. Honor an explicit issue or module scope in the human request.
2. Refresh the queue; find the lowest-rank Ready implementation issue in that scope. Skip In Progress, In Review, Blocked, Done, and work owned by another active agent. The preview's candidate flag checks status and GitHub completion metadata only.
3. Recheck actual prerequisite outcomes and acceptance evidence, outstanding owner decisions, issue discussion/assignees, linked open PRs, and existing branch/worktree. Closed-as-not-planned does not satisfy a prerequisite. A rank or Completed metadata is not itself acceptance evidence.
4. Announce the chosen issue and reason, then move it to In Progress and follow the issue delivery workflow. Recheck immediately before claiming; the project field is not an atomic lock. Resolve any collision before duplicate implementation.
5. If no Ready issue qualifies, inspect the earliest dependency-available Backlog item through project management. Promote only when scope/decisions/evidence are satisfied; otherwise report what is missing and continue only independent authorized preparation. Never select a blocked lower number or invent owner decisions to avoid asking.

Refresh after creating/splitting/reopening issues, changing native dependencies/priorities/milestones, starting/reviewing work, and confirming a delivery. New closed/status-filtered rows disappear through GitHub's view filter; ranks are recalculated by the contributor command. This is agent-maintained on those operations, not a continuously running scheduler: changes made outside these workflows require a refresh before the next selection. Do not maintain a conflicting hand-edited rank list or assume visual/manual board order is authoritative. Explicit owner reprioritization still respects real dependencies.

A coordination parent whose children are complete may still need integrated acceptance; inspect it separately before closing it. One next-subject request is not standing authorization to process the whole backlog.

## Package versioning and releases

**Current contract.** Versionable workspaces in `apps/*` and `packages/*` use independent private versions; the orchestration root is not released. Keep release workspaces private, use `fixed: []`, `linked: []`, `baseBranch: main`, `privatePackages.version: true`, `privatePackages.tag: true`, `updateInternalDependencies: patch`, and `bumpVersionsWithWorkspaceProtocolOnly: true`. Start development packages at `0.0.0`; select deliberate SemVer changesets for package behavior/API changes rather than forcing every change to patch. A development package patch sequence can be `0.0.1`, then `0.0.2`; these package versions do not imply npm publication or completion of the product v0.1 gate. Product releases identify exact package/image revisions.

Create an English Changeset for each affected versionable package with `pnpm changeset`; inspect pending intent with `pnpm changeset status`. `pnpm changeset version` consumes entries and updates package versions, changelogs and internal ranges; run `pnpm install --lockfile-only` if a workspace range change requires lockfile updates. Review generated output in the separate version PR. Changes outside workspaces and the configured test/documentation exclusions do not require entries; changed package paths require deliberate release intent. See the [local/CI Changesets validator](../scripts/ci/check_changeset_pr.py) and its tests for the exact current exclusions and generated-output rules. CI requires coverage for changed head-present workspaces, using the PR base for changed paths and the exact PR head for workspace identity. A removed workspace does not require a Changeset; changed entries for packages absent at head fail. Generated version PRs are exempt from the source gate only after strict generated-output validation succeeds.

### Version PR and release automation

The trusted-main version workflow creates/updates a reviewed `changeset-release/main` PR when Changesets are pending. The pinned Lufa action consumes entries, updates the lockfile and validates generated output. Human review, current-head CI, CODEOWNERS and native protections remain mandatory. The post-merge workflow accepts only its configured merged-PR event/branch conditions, checks out the event merge SHA, and uses the dedicated release App. The post-merge release workflow no longer repeats that generated-diff validation. Provision its variables/secret and environment only as specified in [the release App setup guide](package-release-app-setup.md); there is no Mac PEM or personal-token fallback. Its App identity is checked separately. No package is uploaded to npm and no product deployment occurs.

The private-package tagging flow uses Changesets' default `pnpm changeset publish` command to emit tag events; the nested action creates tags and Releases from those events. Package tag events are unfiltered: they include eligible private packages without existing tags, including unchanged packages. Keep a current-version `CHANGELOG.md` in every eligible private workspace. **Known limitation:** the post-merge workflow no longer asserts at runtime that checkout `HEAD`/`github.sha` equals the event merge SHA, or validates the generated diff again after merge. Successful tag creation targets the action context `github.sha`; this relies on GitHub's event-context contract, not an explicit equality check. Tag-push failures can be warnings and release creation continues; the action does not verify an existing tag's target and can therefore use a pre-existing tag that points elsewhere. If no tag exists, GitHub's Release API may create one at the default branch. Exact-SHA binding is therefore not guaranteed on that failure path. This procedure documents the observed implementation, not a stronger runtime guarantee.

### Dependabot Changesets

Dependabot Changesets use a permissionless `pull_request` signal and a trusted-main `workflow_run` writer. The privileged writer reads and validates current PR metadata through GitHub's API, never checks out or executes PR code/artifacts, and adds only the canonical `.changeset/dependabot-pr-N.md` commit through a non-forced ref update after revalidating the PR head. Keep the required `Repository configuration` check enabled: the signal is not merge readiness, and the generated head must pass current required checks. The writer uses a separate dedicated App with `Contents: write` in environment `dependabot-changesets`, restricted server-side to branch `main`; its private key is not a Dependabot, repository, or PR-job secret. No external Lufa Dependabot action is used, so the trusted writer needs no Lufa allowlist exception. Follow the workflow's exact environment/variable setup and preserve fail-closed behavior for changed heads and noncanonical content. `pull_request_target` and candidate checkout in the privileged workflow remain prohibited. The [workflow definitions](../.github/workflows/dependabot-changesets.yml) and [trusted writer](../.github/workflows/dependabot-changesets-writer.yml) are authoritative for implementation detail.

Historical delivery and qualification evidence: [Changesets setup #33](https://github.com/grasdouble/Jarvis/issues/33), [Dependabot writer #34](https://github.com/grasdouble/Jarvis/issues/34), [release automation #35](https://github.com/grasdouble/Jarvis/issues/35), [version PR #154](https://github.com/grasdouble/Jarvis/pull/154), [package release run](https://github.com/grasdouble/Jarvis/actions/runs/39448858054), and [Dependabot writer qualification](https://github.com/grasdouble/Jarvis/actions/runs/39411834767). These records document particular runs only; they do not prove current credentials, protections, or live workflow configuration.

## References

Checked on October 20, 2026:

- [Changesets configuration](https://changesets.dev/guide/config): independent groups, private versions/tags, and internal dependencies.
- [Versioning and publishing](https://changesets.dev/guide/versioning-and-publishing): changeset consumption, changelogs, tags, and publication boundaries.
- [GitHub sub-issues REST API](https://docs.github.com/en/rest/issues/sub-issues): native parent/child relations.
- [Dependabot on Actions](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-on-actions): token and secret restrictions.
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use): privileged `workflow_run` boundaries and untrusted code/artifact handling.
- [Git database API](https://docs.github.com/en/rest/git): creating the stable Changeset commit and non-forced ref update.
