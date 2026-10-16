# JARVIS

A self-hosted assistant for managing GitHub development projects, built in-house with TypeScript and Node.js. The v0.1 MVP covers Dependabot monitoring, isolated OpenCode reviews, strict automerge, and a daily digest.

The repository is maintained in English.

## Documentation

- [JARVIS v0.1 PRD and roadmap](docs/prd-and-roadmap.md)
- [JARVIS v0.1 Technical Architecture](docs/technical-architecture.md)
- [Contributor workflow, TDD, task slicing, and planned versioning](docs/development-workflow.md)
- [Independent review, repair loops and autonomous routine delivery](docs/autonomous-delivery.md)
- [Development repository security](docs/repository-security.md)
- [Development App, local key storage, and authentication](docs/development-github-app.md)
- [Security reporting](SECURITY.md)

## Next development subject

Use [Next up](https://github.com/orgs/grasdouble/projects/1/views/5) for the dependency-aware execution order. Agents refresh it before selecting the first eligible Ready issue and after delivery or planning changes. The [selection and refresh procedure](docs/development-workflow.md#select-and-refresh-the-next-issue) explains readiness, ownership, and maintenance. JV numbers identify issues; they do not define execution order.

## GitHub CLI setup for development

For routine issue delivery and backlog management, use the [dedicated development App](docs/development-github-app.md). Its helper defaults to read-only tokens and supports explicit authorized writes and App-authenticated branch pushes. Keep its PEM in `$HOME/Library/Application Support/Jarvis Development/credentials` with directory/file permissions `700`/`600`.

```bash
node scripts/github/gh-app.mjs --verify
node scripts/github/gh-app.mjs -- issue list --repo grasdouble/Jarvis
```

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
