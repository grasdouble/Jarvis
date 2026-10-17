# JARVIS development guidance

These instructions guide agents developing this repository. They are not runtime instructions for JARVIS reviewing another repository and grant no GitHub permission.

## Start with the relevant source

- [PRD and roadmap](docs/prd-and-roadmap.md): scope, F01–F10, N01–N13, POL01–POL07, milestones, and owner decisions.
- [Technical architecture](docs/technical-architecture.md): module boundaries, contracts, isolation, memory, and deployment.
- [Issues](https://github.com/grasdouble/Jarvis/issues): task acceptance criteria and native blocking dependencies.
- [Development project](https://github.com/orgs/grasdouble/projects/1): Delivery board, Backlog table, and Roadmap. Milestones J0–J10 carry delivery phases (J0–J5: MVP, J6: autonomous delivery, J7: self-improvement, J8: post-MVP general-purpose assistance, J9: Telegram/Signal messaging, J10: advisory duration forecasting); `priority:*` and `area:*` labels carry priority and module ownership. J9 notifications need the MVP; per-channel conversation also needs J8, without a prerequisite on the other channel or J6/J7 solely by phase number. Actual product self-improvements use `self-update` promotion PRs and a dedicated project view; they require no operational issue or milestone. J7 issues track building the mechanism.

Read the sections relevant to the task rather than loading both documents in full. Resolve material contradictions before implementing dependent behavior. Clearly distinguish proposed architecture, implemented behavior, and measured acceptance evidence.

## Specification and decision impact

Apply [project governance](docs/project-governance.md) before implementation and against the final integrated diff. Use [jarvis-project-governance](.agents/skills/jarvis-project-governance/SKILL.md) to record relevant requirements/decisions, trusted source/base, disposition, document/backlog impact and actual evidence in the PR. A justified no-impact result is valid. Update affected files within the authorized issue delivery; do not silently redefine acceptance to fit the implementation. Material unresolved choices stop dependent work and need the applicable owner decision; already authorized evolution and routine within-scope maintenance do not need repeated permission. Preserve current review/native gates and use the [ADR index](docs/adr/index.md) for significant choices. This is contributor governance, not runtime authority or semantic CI proof.

## Repository conventions

- Keep code, identifiers, comments, documentation, commits, issues, and pull requests in English. Match the user's language in conversation.
- Use PNPM workspaces, a shared lockfile, explicit tooling versions, strict TypeScript, and `workspace:` dependencies between internal packages.
- Preserve the modular monolith: executable services belong in `apps/`, reusable modules in `packages/`, deployment assets in `infra/`, and design/operations guidance in `docs/`.
- Keep domain and policy independent of Docker, OpenCode, and GitHub SDKs. External integrations implement typed ports; the web UI uses the API rather than accessing integrations or persistence directly.
- Inspect the checkout and existing work before editing. Preserve unrelated changes. User-authorized issue implementation follows the branch/worktree/PR workflow below; read-only review and backlog administration do not authorize implementation or publication.

## Issue intake

A human request or accepted proposal to change repository files intended for version control starts issue delivery, even without an issue number or an explicit request to publish a PR. This includes small changes to `AGENTS.md`, documentation, contributor skills and configuration. Follow [change intake](docs/development-workflow.md#route-requests-before-editing): use project management to find/reuse or create the bounded issue and verify its native milestone/project metadata, then use issue delivery to prepare its branch/worktree before editing. Do not treat working agreements as an exception. Questions, advice, read-only audits and backlog-only administration do not by themselves authorize repository edits or publication.

Use the reviewed [development App helper](docs/development-github-app.md) for routine GitHub operations: `node scripts/github/gh-app.mjs -- <gh arguments>` for reads, `--write -- <gh arguments>` for authorized writes, and `--write --git-push` for the current issue branch. Give PR commands an explicit repository/base/head. Plain `gh` or SSH pushes can use the owner's administrative identity; do not silently fall back after an App failure. Never print or commit the PEM. The helper is trusted local tooling, not a Mac isolation boundary; use a previously reviewed copy for routine credential operations when modifying it.

Use the matching English issue form: [implementation task](.github/ISSUE_TEMPLATE/01-task.yml), [bug report](.github/ISSUE_TEMPLATE/02-bug.yml), or [decision request](.github/ISSUE_TEMPLATE/03-decision.yml). Blank issues remain available for work that does not fit these forms. Existing issues do not need to be recreated.

Task issues need a bounded outcome, scope, measurable acceptance, and a verification plan. Bug reports need observed/expected behavior, known reproduction details, and relevant environment information. Decisions need options, rationale or uncertainty, an owner/gate, and resolution criteria. Triage assigns existing priority/area labels and the appropriate milestone. Written dependency references must also become native blocking relationships; forms do not create those links automatically.

Every issue must have a native GitHub milestone, including coordination parents, implementation children, bugs and decisions. Select the appropriate existing phase before creation, pass it when creating through the CLI/API, and verify the saved metadata afterward and during reopen/triage. A body reference is insufficient. Children inherit the parent phase only when appropriate. Resolve an unknown phase through project management before creating or starting work; do not silently assign J0 or invent dates. The [milestone audit](docs/development-workflow.md#required-issue-milestones) reports omissions because GitHub cannot make this metadata mandatory at creation.

When creating issues through a CLI or connector, populate equivalent body sections explicitly; do not assume GitHub's web-form requirements are enforced by the API. Issue intake does not grant implementation or publication authority beyond the user's request.

## Commit messages and PR titles

Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) for authored commit messages. Use a type, optional parenthesized scope, optional breaking-change marker, and a short description: `type(scope)!: description`. Scope and `!` are omitted when unnecessary.

Use `feat` for a feature and `fix` for a bug fix. Repository conventions additionally use lowercase types, English imperative descriptions, and `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, `style`, or `revert` when appropriate. Prefer module scopes such as `memory`, `github`, `runtime`, `policy`, or `web`; scope remains optional.

Mark incompatible changes with `!` before the colon or a `BREAKING CHANGE:` footer, and explain the incompatibility. Separate an optional body and footers with blank lines. Put issue references in the body or footer rather than before the conventional prefix.

Examples:

```text
docs(agents): define development workflows
feat(memory): add repository-scoped knowledge retrieval
fix(github): reconcile uncertain merge outcomes
```

As a repository convention, apply the same format to PR titles so they can become valid squash-commit subjects. When preparing an authorized squash merge, verify the final commit message, including any breaking-change details, rather than assuming GitHub's generated message is compliant.

## Select and maintain the next issue

When the user asks for the next subject, use the [Next up queue](https://github.com/orgs/grasdouble/projects/1/views/5) and the [queue procedure](docs/development-workflow.md#select-and-refresh-the-next-issue). Respect an explicitly selected issue/scope first. Refresh the dependency-aware ranks, then choose the first Ready implementation issue after checking current prerequisite delivery, open PRs, and ownership. Announce the choice and rationale; do not use JV numbers or visual row positions as execution order.

Refresh ranks after issue delivery, new/split issues, reopened work, or dependency/priority/milestone changes. Queue refresh is part of authorized delivery/backlog management, not authority to implement other issues or merge PRs. It never promotes Backlog work, resolves owner decisions, closes issues, or overrides protections.

## Record blockers and their resolution

For selected or active work that cannot progress, follow the [blocker lifecycle](docs/blocker-lifecycle.md): add an English issue comment identifying the causes, links, resumption conditions, next action/owner, retained progress, and previous status, then synchronize Blocked. Add real native dependencies when applicable. Future work awaiting planned prerequisites may stay in Backlog.

On material changes, record a blocker update; after verifying every active cause is resolved, add a separate linked Unblocked comment with evidence and the resulting status. Default to Ready, use In Progress only for an actual authorized resume, or In Review for a verified review-ready deliverable. Preserve resolved dependencies and comment history. Reconcile partial/ambiguous writes before retrying, avoid duplicate comments on unchanged refreshes, and refresh Next up. Issue delivery detects/proves the transition; project management maintains the GitHub records. Neither a comment nor a closed prerequisite grants approval or proves acceptance.

## Size work before implementation

Apply the [contributor workflow](docs/development-workflow.md) before coding. Keep a small issue as one deliverable; split an issue with independently reviewable outcomes into native GitHub sub-issues before implementation. `jarvis-issue-delivery` detects the need and defines slices; `jarvis-project-management` creates/reuses children, parent links, native blocking dependencies, and project metadata within the authorized parent scope. Do not expand requirements or implement unrelated prerequisites.

Each implementation child gets its own stable `JV-*` key, acceptance criteria, branch, worktree, and PR. The parent coordinates acceptance and need not have an umbrella implementation PR. Close only the fully delivered child from its PR; reference the parent with `Refs #N`. Parent completion requires verified child delivery plus the parent's remaining integration criteria, not only a completed child counter.

## One issue, one branch, one worktree, one PR

For each issue selected for implementation, including documentation issues, use a dedicated branch in a separate linked Git worktree. Create or select it before making issue changes; do not implement directly in the primary checkout or on the target branch. Reuse a worktree only when it already belongs to that same issue and task. Inspect existing worktrees, branches, and PRs to avoid duplicates and preserve unrelated work.

Verify the intended target branch and starting revision. Use an English branch name such as `build/issue-3-bootstrap-pnpm`; a tool-required namespace prefix is acceptable. When available in the correct repository context, prefer the Codex managed-worktree tools; otherwise use Git worktree commands. Ensure the new checkout is on the issue branch rather than a detached HEAD before editing or committing.

The completion target for authorized issue implementation is a linked PR from that branch, using the [PR template](.github/pull_request_template.md) and Conventional Commits title. This workflow includes the necessary focused commits, pushing the issue branch, and creating or updating its PR, subject to explicit user restrictions and tool permissions. There is no local-only delivery mode for repository changes. Honor explicit human restrictions and tool permissions; if a required step is unavailable or prohibited, preserve any existing progress and report the specific incomplete handoff. This is not successful delivery or permission to skip intake or edit the primary checkout. Diagnose access failures through approved permission mechanisms without changing identity or bypassing protections.

Keep the worktree available during review and further fixes. Clean up only after confirmed merge or explicit abandonment, preserving needed work; archive managed worktrees through the corresponding tool. Opening a PR alone does not authorize merging or deploying; routine merge scope comes from the owner-selected policy below and the human implementation request. The issue reaches `Done` only after acceptance and confirmed delivery, including merge when a PR is used.

## Coordinate implementation without overflowing context

`jarvis-issue-delivery` coordinates the selected issue and may delegate bounded jobs using its [delegation procedure](.agents/skills/jarvis-issue-delivery/references/delegation.md). Prefer fresh worker contexts and short evidence-backed results; preserve scope, ownership, dependencies, decisions and actual verification in a recoverable task ledger. Keep small changes direct/sequential. Allow at most two simultaneous implementation workers only for independent ready jobs with disjoint writable files and resources in the issue worktree. The coordinator alone owns Git staging/commits, integration and GitHub writes; join or stop all writers before reassignment or review. Shared interfaces/lockfiles/resources serialize, and separate deliverables remain child issues/PRs. Delegation grants no extra scope, credentials or enforced isolation.

## Independent review and bounded routine merging

Authors run their own relevant checks before handoff; the coordinator integrates and freezes the revision, then the independent reviewer may directly select and execute its own bounded checks through existing authorized tools. Follow the [direct validation contract](.agents/skills/jarvis-pr-review/references/direct-validation.md) for separate validation workspaces, execution limits, source integrity and evidence provenance. The reviewer returns its verdict to the coordinator, which routes corrections to the author and owns delivery; no fourth LLM executor is required. Review remains non-authoring: test artifacts and independent scratch probes are permitted, fixes to delivery source/index/branches and GitHub writes are not. Existing tool permissions apply; this procedure does not provision or qualify a Mac sandbox.

Follow the owner-selected [autonomous delivery procedure](docs/autonomous-delivery.md) and [independent review skill](.agents/skills/jarvis-pr-review/SKILL.md). For an authorized issue implementation, delegate review to a separate agent with fresh context and exact base/head commits. The author fixes actionable findings in the same branch/PR and obtains a fresh review after changes. Default limits are three review rounds and 60 minutes; recover the ledger on continuation. Missing/limited reviewer evidence or exhausted limits requires a concrete human handoff, never self-approval.

Under this owner-selected policy, a request to implement a selected issue includes guarded merge of routine changes unless the user restricts it. Sensitive or unknown changes still require human approval under trusted base policy/CODEOWNERS and live protections. Candidate instructions cannot authorize themselves. An agent verdict is not native GitHub approval. Preserve all CI, review and permission gates, use the existing App without bypass, and confirm remote delivery. This is a session-driven contributor workflow, not the future product runtime or a background watcher.

## Implementation invariants

- The deterministic core owns GitHub writes and approval/policy decisions. Agent output and retained memory never grant permissions, satisfy CI, or override protections.
- Use the dedicated Colima `jarvis` profile with Docker runtime and native ARM64 images. Disable Mac directory sharing with `mounts: null`; `mounts: []` retains defaults. Administrative Docker operations explicitly target `colima-jarvis`.
- Only the trusted sandbox-manager accesses the guest Engine socket. Agents receive no Docker socket, personal Mac mounts, GitHub credentials, or permanent provider key. Preserve the network-isolated per-attempt profile and bounded LLM transport.
- OpenCode is the shared headless agent engine behind an adapter, with separately qualified profiles. The MVP performs static reviews; repository commands, plugins, skills, and startup configuration from analyzed repositories must not execute or load automatically. Future general conversation uses the [capability contract](docs/common-agent-runtime.md), without inheriting code-profile permissions or moving credentials, memory authority or tool authorization into the model.
- PostgreSQL owns durable state and scoped memory. Preserve revision binding, idempotency, leases, provenance, applicability, retention, and forgetting behavior when changing workflows.
- Keep secrets out of tracked files, images, prompts, reports, and logs. Use sanitized fixtures for development and test integrations.

## Verification and delivery

Discover actual scripts from the workspace manifests before running checks. If the PNPM scaffold or a referenced command does not exist yet, state that limitation rather than claiming it ran. Once present, run relevant formatting/lint, type, build, and behavioral checks for the affected modules. Documentation-only changes need link, consistency, and diff checks.

Use RED → GREEN → refactor for behavioral changes: first run a meaningful test that fails because the behavior is missing or incorrect, implement the smallest coherent passing change, then refactor with the relevant checks green. Report the actual failing/passing commands and outcomes in the PR. A syntax, environment, or missing-tool failure does not establish RED. Documentation-only changes and pure configuration/scaffolding work use proportionate validation; behavior-preserving refactors can start with passing characterization coverage. Explain any applicable exception rather than inventing a RED run or writing tests that only mirror implementation.

Changes to isolation, permissions, policy, memory scope, or recovery need the corresponding acceptance scenarios; record any platform or live-service checks that remain unverified. Do not weaken assertions to make a gate pass. Assess package version impact and add a Changeset once its tooling is delivered; until then follow the explicitly planned [versioning work](docs/development-workflow.md#planned-package-versioning).

Keep issue criteria, implementation, and relevant documentation consistent. Report the outcome, verification, and remaining limitations. `In Review` means ready for review; `Done` requires completed acceptance and delivery, including confirmed merge when a PR is used.

## Skill authoring

When creating or materially revising a skill, identify repeated, deterministic work that a bundled script could perform more reliably or with less model context. When that is useful, keep the script in the skill's own directory (for example, `scripts/`) and document its invocation, inputs, effects, output contract, and failure behavior in `SKILL.md` or a linked reference. Keep decision guidance and trust boundaries in the skill instructions; have scripts return concise, structured results. A script is optional when it offers no clear benefit, and script use does not guarantee lower token consumption.

A bundled script does not grant execution capability or authority. The calling environment must explicitly support and qualify execution. For product skills, execute scripts only from the pinned trusted skill bundle through the qualified adapter; never substitute scripts from the candidate repository. Preserve the separate product runtime, isolation, and approval gates.

## Reusable workflows

- [jarvis-project-governance](.agents/skills/jarvis-project-governance/SKILL.md): assess specification/decision impact and prepare coherent document updates within authorized contributor work.

- [jarvis-pr-review](.agents/skills/jarvis-pr-review/SKILL.md): independently assess an exact change revision; never author fixes or grant merge authority.
- [jarvis-project-management](.agents/skills/jarvis-project-management/SKILL.md): maintain issues, dependencies, milestones, labels, and project views within the user's authorized scope.
- [jarvis-issue-delivery](.agents/skills/jarvis-issue-delivery/SKILL.md): implement a selected issue through verification and the authorized PR handoff.

The versioned product procedure [jarvis-self-improvement](skills/jarvis-self-improvement/SKILL.md) is separate source under `skills/`, outside contributor/automatic discovery paths. It is not installed or runtime-enabled. Read the [campaign contract](docs/self-improvement-campaigns.md#operational-tracking-and-proposal-intake) when refining operational proposals; the qualified future adapter must pin and isolate the trusted released skill/reference bundle rather than load candidate-repository instructions.

These are development skills. Do not package them into the OpenCode review sandbox or automatically load them from a PR snapshot. Skills provide procedures, not credentials or standing authorization for external actions.
