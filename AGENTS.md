# JARVIS development guidance

These instructions guide agents developing this repository. They are not runtime instructions for JARVIS reviewing another repository and grant no GitHub permission.

## Start with the relevant source

- [PRD and roadmap](docs/prd-and-roadmap.md): scope, F01–F10, N01–N13, POL01–POL07, milestones, and owner decisions.
- [Technical architecture](docs/technical-architecture.md): module boundaries, contracts, isolation, memory, and deployment.
- [Issues](https://github.com/grasdouble/Jarvis/issues): task acceptance criteria and native blocking dependencies.
- [Development project](https://github.com/orgs/grasdouble/projects/1): Delivery board, Backlog table, and Roadmap. Milestones J0–J5 carry delivery phases; `priority:*` and `area:*` labels carry priority and module ownership.

Read the sections relevant to the task rather than loading both documents in full. Resolve material contradictions before implementing dependent behavior. Clearly distinguish proposed architecture, implemented behavior, and measured acceptance evidence.

## Repository conventions

- Keep code, identifiers, comments, documentation, commits, issues, and pull requests in English. Match the user's language in conversation.
- Use PNPM workspaces, a shared lockfile, explicit tooling versions, strict TypeScript, and `workspace:` dependencies between internal packages.
- Preserve the modular monolith: executable services belong in `apps/`, reusable modules in `packages/`, deployment assets in `infra/`, and design/operations guidance in `docs/`.
- Keep domain and policy independent of Docker, OpenCode, and GitHub SDKs. External integrations implement typed ports; the web UI uses the API rather than accessing integrations or persistence directly.
- Inspect the checkout and existing work before editing. Preserve unrelated changes. User-authorized issue implementation follows the branch/worktree/PR workflow below; read-only review and backlog administration do not authorize implementation or publication.

## Issue intake

Use the matching English issue form: [implementation task](.github/ISSUE_TEMPLATE/01-task.yml), [bug report](.github/ISSUE_TEMPLATE/02-bug.yml), or [decision request](.github/ISSUE_TEMPLATE/03-decision.yml). Blank issues remain available for work that does not fit these forms. Existing issues do not need to be recreated.

Task issues need a bounded outcome, scope, measurable acceptance, and a verification plan. Bug reports need observed/expected behavior, known reproduction details, and relevant environment information. Decisions need options, rationale or uncertainty, an owner/gate, and resolution criteria. Triage assigns existing priority/area labels and the appropriate milestone. Written dependency references must also become native blocking relationships; forms do not create those links automatically.

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

## One issue, one branch, one worktree, one PR

For each issue selected for implementation, including documentation issues, use a dedicated branch in a separate linked Git worktree. Create or select it before making issue changes; do not implement directly in the primary checkout or on the target branch. Reuse a worktree only when it already belongs to that same issue and task. Inspect existing worktrees, branches, and PRs to avoid duplicates and preserve unrelated work.

Verify the intended target branch and starting revision. Use an English branch name such as `build/issue-3-bootstrap-pnpm`; a tool-required namespace prefix is acceptable. When available in the correct repository context, prefer the Codex managed-worktree tools; otherwise use Git worktree commands. Ensure the new checkout is on the issue branch rather than a detached HEAD before editing or committing.

The completion target for authorized issue implementation is a linked PR from that branch, using the [PR template](.github/pull_request_template.md) and Conventional Commits title. This workflow includes the necessary focused commits, pushing the issue branch, and creating or updating its PR, subject to explicit user restrictions and tool permissions. Read-only tasks and edits to working agreements outside an implementation issue do not imply commit/push/publication authorization. If publication is blocked, preserve the local work and report the unmet handoff rather than claiming completion.

Keep the worktree available during review and further fixes. Clean up only after confirmed merge or explicit abandonment, preserving needed work; archive managed worktrees through the corresponding tool. Opening a PR does not authorize merging or deploying. The issue reaches `Done` only after acceptance and confirmed delivery, including merge when a PR is used.

## Implementation invariants

- The deterministic core owns GitHub writes and approval/policy decisions. Agent output and retained memory never grant permissions, satisfy CI, or override protections.
- Use the dedicated Colima `jarvis` profile with Docker runtime and native ARM64 images. Disable Mac directory sharing with `mounts: null`; `mounts: []` retains defaults. Administrative Docker operations explicitly target `colima-jarvis`.
- Only the trusted sandbox-manager accesses the guest Engine socket. Agents receive no Docker socket, personal Mac mounts, GitHub credentials, or permanent provider key. Preserve the network-isolated per-attempt profile and bounded LLM transport.
- OpenCode is a headless runtime behind an adapter. The MVP performs static reviews; repository commands, plugins, skills, and startup configuration from analyzed repositories must not execute or load automatically.
- PostgreSQL owns durable state and scoped memory. Preserve revision binding, idempotency, leases, provenance, applicability, retention, and forgetting behavior when changing workflows.
- Keep secrets out of tracked files, images, prompts, reports, and logs. Use sanitized fixtures for development and test integrations.

## Verification and delivery

Discover actual scripts from the workspace manifests before running checks. If the PNPM scaffold or a referenced command does not exist yet, state that limitation rather than claiming it ran. Once present, run relevant formatting/lint, type, build, and behavioral checks for the affected modules. Documentation-only changes need link, consistency, and diff checks.

Use focused tests for changed behavior. Changes to isolation, permissions, policy, memory scope, or recovery need the corresponding acceptance scenarios; record any platform or live-service checks that remain unverified. Do not weaken assertions to make a gate pass.

Keep issue criteria, implementation, and relevant documentation consistent. Report the outcome, verification, and remaining limitations. `In Review` means ready for review; `Done` requires completed acceptance and delivery, including confirmed merge when a PR is used.

## Reusable workflows

- [jarvis-project-management](.agents/skills/jarvis-project-management/SKILL.md): maintain issues, dependencies, milestones, labels, and project views within the user's authorized scope.
- [jarvis-issue-delivery](.agents/skills/jarvis-issue-delivery/SKILL.md): implement a selected issue through verification and the authorized PR handoff.

These are development skills. Do not package them into the OpenCode review sandbox or automatically load them from a PR snapshot. Skills provide procedures, not credentials or standing authorization for external actions.
