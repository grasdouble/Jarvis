# JARVIS

A self-hosted assistant for owner-directed work on internally authorized software projects, built in-house with TypeScript and Node.js. Version 0.1 supports explicit read-only `plan` and bounded `dev` requests, requested read-only pull-request analysis, validated PR publication without JARVIS merge, and a daily digest.

The repository is maintained in English.

## Workspace foundation

The repository uses Node.js 24.22.0 and PNPM 12.5.1 in a strict TypeScript workspace. Install the pinned workspace dependencies, then run the shared checks from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
```

The `apps/` tree contains the API, web interface, worker, sandbox-manager, and LLM gateway entry points. Reusable modules live in `packages/`; their intended responsibilities and dependency direction are documented in [architecture §7](docs/technical-architecture.md#7-monorepo-modules-and-dependencies). The current entry points and packages are scaffolding only: they do not claim product service behavior or isolation qualification.

## Documentation

- [JARVIS v0.1 PRD and roadmap](docs/prd-and-roadmap.md)
- [JARVIS v0.1 Technical Architecture](docs/technical-architecture.md)
- [Contributor workflow, TDD, task slicing, and planned versioning](docs/development-workflow.md)
- [Project governance and specification alignment](docs/project-governance.md)
- [Architecture decision index and lifecycle](docs/adr/index.md)
- [Independent review, repair loops and autonomous routine delivery](docs/autonomous-delivery.md)
- [Bounded self-improvement campaigns and conflict remediation](docs/self-improvement-campaigns.md)
- [Shared OpenCode runtime and controlled capabilities](docs/common-agent-runtime.md)
- [Token consumption, usage attribution and budget accounting](docs/token-consumption.md)
- [Telegram/Signal notifications and conversation channels](docs/messaging-channels.md)
- [Task duration estimates, timing and calibration](docs/duration-forecasting.md)
- [Development repository security](docs/repository-security.md)
- [Development App, local key storage, and authentication](docs/development-github-app.md)
- [PR Issue/Milestone synchronization and CI activation](docs/pr-project-metadata.md)
- [Observed Roadmap dates and historical backfill](docs/roadmap-actual-dates.md)
- [Security reporting](SECURITY.md)

The product roadmap also plans [evidence-driven self-improvement after autonomous delivery](docs/prd-and-roadmap.md#111-post-mvp-evolution), tracked by [JV-051](https://github.com/grasdouble/Jarvis/issues/51). It is future work with fixed evaluation, human-sensitive gates and separately authorized rollout; no runtime optimizer is installed.

## Shared agent runtime

OpenCode is the planned common engine for conversation, code review/development and self-improvement through separate trusted profiles. JARVIS owns permissions, memory, budgets, scheduling and external effects. Version 0.1 supports explicit project-scoped `plan`/`dev` requests, including requested read-only pull-request analysis; repository commands remain disabled absent accepted D16 and qualification. [J08 general-purpose assistance](https://github.com/grasdouble/Jarvis/issues/64) plans authenticated conversation and approved read-only tools, with weather as the first qualification example. No chat/tool broker/connector is enabled and Herdr is not a dependency. See the [runtime design](docs/common-agent-runtime.md).

## Messaging channels

J09 separately plans opted-in Telegram/Signal notifications after the MVP, then authenticated text conversation reusing qualified J08 services. [JV-075](https://github.com/grasdouble/Jarvis/issues/75) tracks the work; neither channel is enabled and Signal bridge feasibility remains to be qualified. See the [messaging contract](docs/messaging-channels.md). Channel messages grant no additional GitHub, approval or deployment authority.

## Self-update pull requests

Actual product self-improvements are tracked directly by a detailed promotion PR carrying `self-update`, with no mandatory operational issue or milestone. The [Self-update project view](https://github.com/orgs/grasdouble/projects/1/views/7) filters `repo:grasdouble/Jarvis is:pr label:self-update`; the controller must also add each PR to the project. J07 issues track building the capability. One bounded hypothesis has one campaign and at most one active main-promotion PR; technical task PRs remain linked in its manifest. See the [tracking/skill contract](docs/self-improvement-campaigns.md#operational-tracking-and-proposal-intake) and [PR content contract](skills/jarvis-self-improvement/references/proposal.md). The versioned [product skill source](skills/jarvis-self-improvement/SKILL.md) is prepared for future qualified integration; no loader, autonomous proposal service or self-update is enabled.

## Next development subject

Use [Next up](https://github.com/orgs/grasdouble/projects/1/views/5) for the dependency-aware execution order. Agents refresh it before selecting the first eligible Ready issue and after delivery or planning changes. The [selection and refresh procedure](docs/development-workflow.md#select-and-refresh-the-next-issue) explains readiness, ownership, and maintenance. JV numbers identify issues; they do not define execution order.

Every issue must have an appropriate native GitHub milestone, including coordination parents and implementation children. See the [milestone policy and audit](docs/development-workflow.md#required-issue-milestones).

## GitHub CLI setup for development

For routine issue delivery and backlog management, use the [dedicated development App](docs/development-github-app.md). Its helper defaults to read-only tokens and supports explicit authorized writes and App-authenticated branch pushes. Keep its PEM in `$HOME/Library/Application Support/Jarvis Development/credentials` with directory/file permissions `700`/`600`.

```bash
node .agents/skills/jarvis-backlog/scripts/github/gh-app.mjs --verify
node .agents/skills/jarvis-backlog/scripts/github/gh-app.mjs -- issue list --repo grasdouble/Jarvis
```

The helper’s `--check-network` public probe needs no key and confirms transport only. Check the current environment’s network permissions before authenticating; follow [network recovery](docs/development-github-app.md#network-access-and-recovery) for `fetch failed` or exit 75, without switching identities or blindly retrying writes.

The OAuth setup below is for the human owner's personal CLI and authorized administration; it is separate from the development App identity.

Install [GitHub CLI](https://cli.github.com/) and use a GitHub account with write access to `grasdouble/Jarvis` and [JARVIS — Development](https://github.com/orgs/grasdouble/projects/1). The development skills use this access to manage issues, labels, milestones, dependencies, pull requests, and project items.

For an existing GitHub CLI login, add the scopes used by the development workflow:

```bash
gh auth refresh --hostname github.com --scopes repo,read:org,project,workflow
```

Follow the instructions in the terminal and approve the requested access in your browser. This adds scopes to the active account's stored credentials while preserving existing scopes. If you use multiple accounts, select the intended one with `gh auth switch --hostname github.com` first.

For a first-time login, use this command instead:

```bash
gh auth login --hostname github.com --web --scopes repo,read:org,project,workflow
```

| Scope | Purpose |
| --- | --- |
| `repo` | Work with the private repository, issues, labels, milestones, dependencies, pull requests, and checks. |
| `read:org` | Read organization and team membership information needed by organization-related operations. |
| `project` | Read and update user and organization Projects, including items and field values. It includes project read access. |
| `workflow` | Create or update GitHub Actions workflow files when implementing CI changes. It is not needed for backlog-only management. |

These are OAuth scopes for the local contributor setup. GitHub CLI also requests its default scopes, including `gist`. Granted scopes remain subject to the account's repository/project permissions and organization policies; OAuth scopes are not restricted to this repository alone. Complete organization approval or SSO authorization if GitHub requires it.

Verify the active login and read access:

```bash
gh auth status --hostname github.com
gh repo view grasdouble/Jarvis
gh issue list --repo grasdouble/Jarvis --limit 5
gh project view 1 --owner grasdouble
gh project field-list 1 --owner grasdouble
```

The repository and project commands should return their details without authentication or scope errors. These checks confirm read access; successful writes also require write permissions on the target resource.

If `GH_TOKEN` or `GITHUB_TOKEN` is set, it may override stored credentials. Update that token's permissions separately or remove the override to use the browser-based login; `gh auth refresh` does not expand a fine-grained personal access token's permissions. Never put tokens in tracked files or command examples.

Use dedicated `gh issue`, `gh label`, `gh pr`, and `gh project` commands where available, then `gh api` for REST or GraphQL operations. Some built-in Projects automation settings still require the web interface. `gh workflow` manages GitHub Actions workflows.

This setup is for contributors developing JARVIS. The running application uses its separately configured GitHub App with limited permissions; OpenCode review sandboxes receive no contributor credentials.

References: [authentication setup](https://cli.github.com/manual/gh_auth_login), [adding scopes](https://cli.github.com/manual/gh_auth_refresh), [OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps), and [Projects commands](https://cli.github.com/manual/gh_project).
