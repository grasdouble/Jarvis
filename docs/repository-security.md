# Development repository security

This document describes the intended baseline for `grasdouble/Jarvis`. Tracked configuration is delivered by issue #26; live settings are verified separately through GitHub. A JSON ruleset file is not enforcement until GitHub accepts it with `active` status.

## Main and ordinary delivery

The `JARVIS main protection` ruleset targets the default branch only, with an empty bypass list. It requires a PR, resolved review threads, current successful checks from GitHub Actions, and forbids deletion and force pushes. Squash is the intended merge method. No commit-signing requirement, global human approval, or restriction on creating ordinary issue branches is introduced.

Required checks have stable job names: `Repository configuration`, `Conventional PR title`, and `Secret scan`. Configure their GitHub Actions integration ID from an actual successful check run, not a guessed value. Enable required checks only after a real run reports all three. Strict mode requires checks against the current base. These checks run on every PR without path filters, including documentation PRs.

The baseline validates YAML, local documentation links, skill metadata, workflow permissions/action pinning, and Conventional Commits PR titles. Gitleaks scans full available history with redaction using a version and independently recorded archive digest. It is not an application test suite. Issue #3 must add PNPM lockfile installation, type/lint/build checks, and relevant tests before application work relies on CI evidence. Dependabot currently monitors Actions and the CI Python requirement; add its npm ecosystem when PNPM manifests exist. Scanner binary/digest updates are owner-reviewed maintenance.

## Targeted human review

CODEOWNERS selects CI, security guidance, agent instructions, infrastructure, and the future policy/runtime/GitHub boundary packages. The PR rule requires code-owner approval for matching paths, with zero general approving reviews. Routine uncovered files remain eligible for delivery after checks. Changes to the CI or to CODEOWNERS itself use ownership from the PR's base branch.

Owner approval is bound to the reviewed revision by dismissal of stale approvals. Required last-push approval is not enabled globally, which would impose a reviewer on ordinary PRs. A green check from the GitHub Actions App alone does not identify trustworthy workflow contents; ownership protects the workflow and its validation scripts against being weakened within the same PR.

Bootstrap the first configuration PR while the base has no CODEOWNERS file, validate its exact head, then activate code-owner enforcement when the configuration is delivered. Do not add an agent bypass to resolve later approval failures. With a sole human owner and PRs authored using that same account, sensitive changes may need a second eligible reviewer or a separately authenticated agent identity; GitHub does not let an author approve their own PR.

## Actions and secrets

Default `GITHUB_TOKEN` permissions are read-only, and Actions cannot create or approve PRs. This does not remove PR creation from an external contributor's `gh` or GitHub App token. Jobs that later need extra rights must declare them explicitly and receive the sensitive-file review. Only GitHub-owned actions are needed by this baseline; remote actions use full commit SHAs, checkout does not persist credentials, and each job has a timeout. Test untrusted code on hosted ephemeral runners without production secrets; never attach an administrative token to a PR test job.

The `.gitignore` prevents ordinary accidental inclusion of local credentials; it is not a secret detector. Gitleaks is a CI detection gate, not server-side push prevention. Enable GitHub Secret Protection/push protection only if the organization already has the entitlement or the owner explicitly accepts its cost. A disabled licensed feature must not be reported as protected by the local scanner. Dependabot alerts and automated security fixes are separate live settings.

## Dedicated development identity

The private development App `jarvis-development-grasdouble` is registered and installed only on `grasdouble/Jarvis`. Its key is held in an owner-only macOS directory outside Git. Read the [App setup and key-storage guide](development-github-app.md) for IDs, paths, authentication commands, rotation, and verification. The owner's personal OAuth login remains available for authorized administration; its rights can still change protections, so the local helper is not an OS isolation boundary.

The approved development App permissions are:

| Permission | Level | Need |
| --- | --- | --- |
| Metadata | Read | Repository identity |
| Contents | Read/write | Issue branches, commits, and allowed merges |
| Pull requests | Read/write | PR publication and authorized delivery |
| Issues | Read/write | Backlog, labels, milestones, and dependencies |
| Actions and Checks | Read | CI evidence |
| Workflows | Read/write | Only if the agent implements CI changes |
| Organization Projects | Read/write | Only for the development board |

Do not grant repository Administration, organization administration, Members write, secret management, or rule bypass. Projects permission is organization-scoped; grant this capability separately from ordinary issue delivery when board isolation is required. Use short-lived installation tokens issued by a trusted credential broker, scoped to this repository and required permissions. Keep the App private key in a protected credential store outside the checkout; never pass it to application code, PR test jobs, or OpenCode review sandboxes. Ordinary commands use the installation token through an isolated process environment. Do not silently replace the owner's global `gh` login.

Owner registration, installation, and key provisioning are complete. Verify reads, issue-branch publication, PR creation, denied administration, and absence from bypass lists when changing the identity. The local helper is delivered through issue #29; use a reviewed copy for routine credentials operations. App-authenticated pushes trigger CI normally, unlike many writes made using a workflow's `GITHUB_TOKEN`.

The production JARVIS App in issue #10 is a separate runtime concern and must not inherit these development permissions. Organization-wide 2FA enforcement affects other repositories and members; review that rollout separately with organization owners.

## Autonomous merging

Repository permission to merge is not user authorization for an agent to do so. Existing AGENTS.md rules still apply: authorized implementation ends in a PR unless the user also authorizes merging. Once authorized for a class of routine work, the agent may merge only after current checks and protections permit it. Sensitive changes continue to need the owner review. Never use `--admin`; verify the final merged state before marking delivery Done.

## Verify live settings

```bash
gh api repos/grasdouble/Jarvis/rulesets
gh api repos/grasdouble/Jarvis/rules/branches/main
gh api repos/grasdouble/Jarvis/actions/permissions
gh api repos/grasdouble/Jarvis/actions/permissions/workflow
gh api repos/grasdouble/Jarvis/automated-security-fixes
gh api repos/grasdouble/Jarvis/vulnerability-alerts
```

Read native secret-scanning status through the repository's `security_and_analysis` field. No secrets belong in verification receipts. Review effective inherited organization rules too. Existing Apps installed organization-wide retain their own permissions; a new development identity does not revoke those installations.

References: [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets), [rules API](https://docs.github.com/en/rest/repos/rules), [Actions permissions](https://docs.github.com/en/rest/actions/permissions), [CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners), [Actions security](https://docs.github.com/en/actions/reference/security/secure-use), [Gitleaks](https://github.com/gitleaks/gitleaks), and [installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).
