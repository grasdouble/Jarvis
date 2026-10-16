# Contributor delivery workflow

This document governs development of JARVIS. It is not an instruction set for the untrusted OpenCode review runtime. Repository changes are maintained in English.

## Keep specifications and decisions coherent

Use [project governance](project-governance.md) before implementation and again for the final diff. Delivery prepares the compact PR impact record and affected document/ADR updates; project management maintains live planning records; independent review checks the sources, authority and evidence. Routine work within accepted scope remains autonomous under current gates. Preserve actual owner authorization already given, stop only dependent unresolved work, and never change the specification solely to hide a defect. The [ADR index/template](adr/index.md) preserve significant decisions and supersession; current CI does not establish semantic alignment.

## Test-first behavior changes

Use RED → GREEN → refactor for features and bug fixes:

1. Translate one acceptance behavior into a focused test. Run it against the unchanged behavior and confirm the expected assertion fails. A missing runner, import, fixture, or syntax error is not behavioral RED.
2. Implement the smallest coherent change that makes that test pass. Run related tests to detect regressions.
3. Refactor with those checks green, then run the issue's required integration/security acceptance and repository checks.

For bug fixes, the RED test reproduces the defect. Test observable contracts rather than copying implementation details. Record actual commands, expected RED failure, GREEN result, and final checks in the PR; a deliberately failing commit need not be pushed. Never invent a RED observation after writing the implementation.

Documentation-only changes use links, consistency, and diff checks. Pure configuration/scaffolding work uses relevant validators and build/smoke evidence; behavioral scripts still warrant behavioral tests. Behavior-preserving refactors may begin with passing characterization tests. Explain the applicable exception and limitations. Unit tests alone do not establish real Colima isolation, remote permissions, or race/recovery acceptance.

## Slice issues into reviewable deliveries

A parent issue describes the complete outcome. Create native GitHub sub-issues when it contains several independently reviewable outcomes, crosses unrelated concerns, or requires a PR that cannot be understood and verified as one coherent change. Keep a small issue intact; no fixed line-count threshold substitutes for judgment.

`jarvis-issue-delivery` assesses size before coding, defines the slices and their acceptance, and invokes `jarvis-project-management` for issue creation/reuse, parent links, blocking dependencies, and project metadata. This stays within the human-authorized parent scope. Parent/child linkage describes scope; blocking links describe execution order. Do not make the parent block its children or create dependency cycles.

Each implementation child has its own stable `[JV-NNN]` planning key, scope, measurable acceptance, verification, priority/area labels, milestone, dedicated branch, linked worktree, and PR. Match new planning keys to the created GitHub issue number, checking existing keys for collisions; keep existing keys stable. Checklists within one issue are suitable for steps that belong in the same PR, not for independent deliveries.

Each child PR uses `Closes #child` only for full acceptance and `Refs #parent` for context. Merge sequentially into the verified target branch when slices depend on each other; refresh dependent branches and rerun checks. There is no mandatory umbrella implementation PR. A coordination parent remains open until required child deliveries and any integrated acceptance have been verified. A closed-as-abandoned child or a full progress counter is insufficient.

If scope grows, split remaining work before growing the PR. Backlog planning may create children but does not itself authorize their implementation. A request to implement the parent can include its necessary slices, subject to the user's scope and existing merge gates.

## Project views

[Delivery](https://github.com/orgs/grasdouble/projects/1/views/1) shows issues only (`is:issue`), including coordination parents and implementation children. [Pull requests](https://github.com/orgs/grasdouble/projects/1/views/4) shows PR items only (`is:pr`). Keep PR membership and issue links, including linked PR badges. Backlog and Roadmap retain their milestone grouping; dates require an agreed schedule.

An actionable implementation child moves through Ready → In Progress → In Review → Done. A coordination parent may remain In Progress across several child PRs and review cycles. Inspect project automations before setting Done; it can close the issue. Done requires verified acceptance and confirmed delivery, including merge when a PR is used.

## Delegate implementation and preserve context

Use `jarvis-issue-delivery` as a coordinator for a selected issue, with the [delegation procedure](../.agents/skills/jarvis-issue-delivery/references/delegation.md) for substantial bounded jobs. Fresh workers receive only relevant scope/files/constraints and return short reports with durable test evidence. Small changes can stay sequential. At most two implementation workers may run together when their ready tasks, writable files and test resources are independent; shared interfaces/lockfiles serialize. One issue keeps its dedicated branch/worktree/PR, the coordinator alone stages/commits/publishes, and separately reviewable outcomes still need native child issues. Join all writers, inspect the complete integrated diff, run integration checks and obtain a fresh reviewer who authored none of it.

This keeps the coordinator's working context smaller without promising unlimited memory or reduced aggregate cost. A recoverable ledger records ownership, dependencies, revisions, results and limits; a summary cannot replace actual acceptance evidence. This contributor procedure does not enable parallel product sandbox runs.

## Independent review and autonomous routine delivery

Follow [autonomous delivery](autonomous-delivery.md) for the owner-selected contributor loop: create PR → independent reviewer → fixes and new review when requested → verified routine merge, or owner approval for sensitive changes. [jarvis-pr-review](../.agents/skills/jarvis-pr-review/SKILL.md) provides the separate reviewer; issue delivery coordinates corrections and project management records evidence/statuses. Defaults are three review rounds and 60 minutes per selected issue run, recovered across continuations. Missing/limited evidence or exhausted limits hands off explicitly. No native self-approval, second App or unattended scheduler is installed. Future product runtime delivery is planned separately after v0.1.

## Blocking and resuming work

Use the [blocker lifecycle](blocker-lifecycle.md) for English Blocked, Blocker update, and Unblocked comments, their required evidence, and recoverable comment/status synchronization. Selected/active work with unmet resumption conditions is Blocked; future planned prerequisites may remain Backlog. Resolve every active cause before returning to Ready or actually resuming. Refresh the execution queue after the verified transition; the queue tool does not create comments or change statuses.

## Required issue milestones

Every issue must have a native GitHub milestone: coordination parents, implementation children, bugs and decisions, open or closed. Choose the phase before creation and verify the saved metadata afterward, on reopen/triage, and before Ready or implementation. CLI/API creation must pass the milestone explicitly. Children inherit the parent phase only when appropriate; document a different phase when needed. If the phase is unclear, resolve it through project management first. Never silently assign J0, substitute a body reference, or invent a due date.

J0–J5 cover the MVP, J6 covers v0.3 autonomous delivery, J7 covers post-v0.3 self-improvement, J8 covers post-MVP general-purpose assistance, J9 covers Telegram/Signal messaging, and J10 covers advisory duration forecasting after the MVP. J10 adds no automatic prerequisite on J6/J8/J9 and grants no dispatch/routing authority. J8 has no automatic dependency on J6/J7 solely by phase number. J9 notifications require the MVP; each channel's conversation additionally requires J8 qualification, without a dependency on the other channel or J6/J7 solely by phase number. Use the accepted roadmap and native prerequisites. These later milestones have no committed dates and add no MVP exit gate. A milestone is a delivery phase, not a promise of a calendar deadline.

GitHub's [issue form syntax](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms) cannot require native milestone metadata. Web/API users can temporarily create an issue without one or remove one afterward. The forms provide guidance; they do not enforce metadata. The [Issue milestone audit](../.github/workflows/issue-milestones.yml) runs on opening, reopening, milestone assignment/removal, main updates, manual dispatch and daily reconciliation. After merge, it fetches all open and closed repository issue pages, excludes PR records, and fails with issue links when any milestone is absent. Malformed input fails rather than reporting success. It uses read-only permissions and trusted main code, never issue text as commands, and never assigns arbitrary phases or posts comments. Failures are visible in Actions under the repository's existing notification settings; no separate notification service is installed.

Use the [CLI audit recipe](../.agents/skills/jarvis-project-management/references/github-cli.md#audit-required-issue-milestones) during backlog administration. Correct the native milestone, reread it, then verify the audit and refresh ranks. The queue additionally rejects any open issue without a milestone before preview or mutation, including coordination parents; closed history is checked by the broader audit. This detects drift and prevents incomplete queue updates; it does not atomically block GitHub issue creation.

## Select and refresh the next issue

[Next up](https://github.com/orgs/grasdouble/projects/1/views/5) is the execution-order view. The project is the live source of work; this document defines the rule rather than copying a numbered backlog into Git. The table filters `is:issue is:open has:execution-order`, sorts Execution order ascending, and displays title, status, labels, milestone, and rank. Delivery/Backlog/Roadmap retain their existing purposes.

Ranks are derived from native blocking links plus parent/child structure. Treat open children as prerequisites of their coordination parent for ordering; give only open implementation issues ranks. Coordination parents and closed issues have their old rank cleared. Topologically order dependencies first; among the currently dependency-available nodes, choose milestone phase numerically (`J0`, `J1`, …, `J7`, `J10`, …), priority P0–P2, creation time, then GitHub issue number. Named milestones follow all numeric phases; missing priorities sort last. Every open issue, including a coordination parent, must have a nonblank native milestone or the entire preview/write fails before rank mutation. JV identifiers remain stable references, not priority. This forecasts future execution as prerequisites finish; it does not claim they have already finished.

Run from a reviewed checkout with the configured development App:

```bash
# Read-only preview, including unmet prerequisite numbers and Ready candidates.
node scripts/github/sync-project-queue.mjs
# Authorized project maintenance: write changed ranks and reread them.
node scripts/github/sync-project-queue.mjs --write
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

## Planned package versioning

**Status: planned, not installed.** The repository currently has no PNPM workspace manifests or Changesets tooling. [#32](https://github.com/grasdouble/Jarvis/issues/32) coordinates three separate deliveries after the PNPM scaffold in [#3](https://github.com/grasdouble/Jarvis/issues/3):

| Delivery | Outcome |
| --- | --- |
| [#33](https://github.com/grasdouble/Jarvis/issues/33) | Pin Changesets, configure independent private workspace versions, document commands, and verify local versioning. |
| [#34](https://github.com/grasdouble/Jarvis/issues/34) | Add the dedicated Dependabot generator using the reviewed, SHA-pinned Lufa action. |
| [#35](https://github.com/grasdouble/Jarvis/issues/35) | Generate reviewed version PRs, then package tags/changelogs and intermediate releases through scoped authentication. |

Use independent versions (`fixed: []`, `linked: []`), `baseBranch: main`, and explicit private-package versioning. Keep the orchestration root and workspace packages `private: true` until publication is separately authorized. `privatePackages.version: true` allows versioning private packages; tagging is an explicit release decision tested by the release workflow. Preserve PNPM `workspace:` consistency and account for dependent-package propagation. Do not keep permanently private packages in the temporary `ignore` list.

Start versionable development packages at `0.0.0` so a first patch release can be `0.0.1`, then `0.0.2`. These are ordinary SemVer development versions, distinct from `alpha`/`beta` prereleases. Feature and incompatible changes still need an intentional bump; do not force every change to patch. A package version does not imply that the complete JARVIS product has reached the v0.1 acceptance gate. Product releases must identify their exact package/image revisions.

Once configured, an implementation PR includes an English changeset for each affected versionable package and its deliberate bump. Documentation-only, test-only, and tooling-only changes can justify no package bump when no delivered behavior changes. Conventional Commits remains the commit/PR title convention; Changesets explicitly records package release intent. Validate generated versions and changelogs in a version PR before creating tags or releases. Do not edit versions ad hoc in every implementation PR or publish packages merely because they have versions.

### Dependabot integration constraints

The inspected [Lufa action](https://github.com/grasdouble/Lufa-CICD/tree/d13c591aef751743f19240acdc79b7e9cb0cfe1a/actions/dependabot-changeset) generates a patch changeset at `.changeset/dependabot-pr-N.md` for workspaces whose `package.json` or `action.yml` changes. It discovers packages through `pnpm -r list --depth -1 --json`, excludes the repository root, and makes no commit when no workspace is affected. Root-only manifest, lockfile-only, Actions, and pip updates therefore need an explicit no-op or deliberate mapping. It does not install dependencies, choose credentials, or configure the caller's workflow permissions.

The caller supplies `base-sha`, `head-sha`, `head-branch`, `pull-request-number`, and `github-token`, with full history, a clean checkout, pinned Node/PNPM, and `persist-credentials: false`. Review the selected action and pin it to a full SHA at implementation time. Verify both the PR author's Dependabot identity and same-repository head; a rerun actor alone is insufficient. Check stale revisions, concurrency, idempotence, and preservation of manually authored changesets. Do not execute PR scripts or PR-controlled startup hooks/configuration with a write secret.

GitHub's ordinary Actions secrets are unavailable to Dependabot-triggered runs. The Lufa example uses a Dependabot secret named `LUFA_CI_SECRET_DEPENDABOT`; its actual provisioning and least-privilege alternative are part of #34. Do not assume the default `GITHUB_TOKEN` can write or retrigger all required checks after the generated commit. Verify current-head CI with the selected identity. The development App PEM on the Mac is not automatically a CI credential.

The current Actions allowlist permits GitHub-owned actions only. Enabling Lufa requires an explicitly reviewed exact-action allowance; the documentation PR does not change it. Release automation also needs a scoped identity capable of creating version PRs while preserving the prohibition on blanket Actions approvals and all branch protections. Missing access remains an explicit prerequisite, not a reason to bypass required checks or run untrusted PR code through `pull_request_target`.

## References

Checked on October 16, 2026:

- [Changesets configuration](https://changesets.dev/guide/config): independent groups, private versions/tags, and internal dependencies.
- [Versioning and publishing](https://changesets.dev/guide/versioning-and-publishing): changeset consumption, changelogs, tags, and publication boundaries.
- [GitHub sub-issues REST API](https://docs.github.com/en/rest/issues/sub-issues): native parent/child relations.
- [Dependabot on Actions](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions): token and secret restrictions.
- [Lufa Dependabot changeset action](https://github.com/grasdouble/Lufa-CICD/tree/d13c591aef751743f19240acdc79b7e9cb0cfe1a/actions/dependabot-changeset): inspected README and action inputs; a full code/security qualification remains part of #34.
