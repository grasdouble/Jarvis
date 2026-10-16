# Contributor delivery workflow

This document governs development of JARVIS. It is not an instruction set for the untrusted OpenCode review runtime. Repository changes are maintained in English.

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

## Select and refresh the next issue

[Next up](https://github.com/orgs/grasdouble/projects/1/views/5) is the execution-order view. The project is the live source of work; this document defines the rule rather than copying a numbered backlog into Git. The table filters `is:issue is:open has:execution-order`, sorts Execution order ascending, and displays title, status, labels, milestone, and rank. Delivery/Backlog/Roadmap retain their existing purposes.

Ranks are derived from native blocking links plus parent/child structure. Treat open children as prerequisites of their coordination parent for ordering; give only open implementation issues ranks. Coordination parents and closed issues have their old rank cleared. Topologically order dependencies first; among the currently dependency-available nodes, choose milestone J0–J5, priority P0–P2, creation time, then GitHub issue number. Missing milestones/priorities sort last. JV identifiers remain stable references, not priority. This forecasts future execution as prerequisites finish; it does not claim they have already finished.

Run from a reviewed checkout with the configured development App:

```bash
# Read-only preview, including unmet prerequisite numbers and Ready candidates.
node scripts/github/sync-project-queue.mjs
# Authorized project maintenance: write changed ranks and reread them.
node scripts/github/sync-project-queue.mjs --write
```

The tool reads project 1 and the complete Jarvis issue inventory, paginates outer connections, and fails without writes if nested connections are truncated, dependencies/children are unavailable, a cycle exists, or an open repository issue lacks project membership. It rereads before mutation and verifies the resulting ranks. API writes are not atomic across batches: after a partial failure, inspect current state and rerun from fresh inputs. It uses the existing reviewed App helper without new scopes, personal-login fallback, or runtime sandbox access. Review tooling changes before using them with credentials.

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
