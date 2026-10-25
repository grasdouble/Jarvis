# Development repository security

This is the concise security baseline for `grasdouble/Jarvis`; the [development App guide](development-github-app.md) is canonical for local App credentials and helper operations, and the [package-release App guide](package-release-app-setup.md) is canonical for CI release credentials and workflow limitations. Tracked configuration is delivered by issue #26; live settings are verified separately through GitHub. A JSON ruleset file is not enforcement until GitHub accepts it with `active` status. This document describes intended/current tracked policy, not a fresh live-settings inspection.

## Main and ordinary delivery

The `JARVIS main protection` ruleset targets the default branch only, with an empty bypass list. It requires a PR, resolved review threads, current successful checks from GitHub Actions, and forbids deletion and force pushes. Squash is the intended merge method. No commit-signing requirement, global human approval, or restriction on creating ordinary issue branches is introduced.

Required checks have stable job names: `Repository configuration`, `Conventional PR title`, and `Secret scan`. Configure their GitHub Actions integration ID from an actual successful check run, not a guessed value. Enable required checks only after a real run reports all three. Strict mode requires checks against the current base. These checks run on every PR without path filters, including documentation PRs.

The baseline validates YAML, local documentation links, skill metadata, workflow permissions/action pinning, and Conventional Commits PR titles. The required `Secret scan` gate uses Gitleaks 8.30.1 with its checked-in archive SHA-256 and fully redacted, no-banner output. On pull requests it requires the event's exact base and head commits, computes their merge-base, and scans only `merge-base..head`; missing commits or a missing merge-base fail clearly. The explicit Gitleaks log range omits `--all`, so findings reachable only from unrelated refs do not enter the PR scan. Pushes to `main` and manual workflow runs retain the full available-history scan. The scanner is not an application test suite. Issue #3 must add PNPM lockfile installation, type/lint/build checks, and relevant tests before application work relies on CI evidence. The tracked Dependabot configuration covers Actions, the CI Python requirement, and npm updates for the PNPM workspace; npm package PRs still need valid Changesets. Scanner binary/digest updates are owner-reviewed maintenance.

## Targeted human review

CODEOWNERS selects explicit CI/control files (workflows/actions, CODEOWNERS, pinned CI dependencies and Dependabot configuration), executable contributor/product-skill scripts, root agent instructions, infrastructure, the named self-improvement skill entrypoint and promotion reference, listed security/authority documents and the future policy/runtime/GitHub boundary packages. It no longer owns all GitHub templates, contributor guidance, product-skill documents/assets or ADR indexes/templates/records. CODEOWNERS groups these rules by repository role and explains each protection; the unimplemented runtime modules retain their whole-module coverage until real layouts support narrower rules. The PR rule requires code-owner approval for matching paths, with zero general approving reviews. Even an editorial change in a still-owned path needs native approval. Changes use ownership from the PR's base branch; this refinement cannot authorize its own adoption.

Uncovered files require content-based classification under [autonomous delivery](autonomous-delivery.md#authority-and-sensitivity). Editorial/reference maintenance can be routine; changing instruction authority, permissions, enforcement or merge controls remains sensitive even in a template or uncovered skill. At the start of each newly handled issue, record the [human-review choice](autonomous-delivery.md#per-issue-human-review-choice). A declined optional review permits only routine guarded delivery; pending input blocks merge, and a requested review needs current-revision owner approval. Native approvals and sensitive/unknown gates remain mandatory in every mode. This is a contributor procedure, not a new server-side semantic enforcement check.

Owner approval is bound to the reviewed revision by dismissal of stale approvals. Required last-push approval is not enabled globally, which would impose a reviewer on ordinary PRs. A green check from the GitHub Actions App alone does not identify trustworthy workflow contents; ownership protects the workflow and its validation scripts against being weakened within the same PR.

Bootstrap the first configuration PR while the base has no CODEOWNERS file, validate its exact head, then activate code-owner enforcement when the configuration is delivered. Do not add an agent bypass to resolve later approval failures. With a sole human owner and PRs authored using that same account, sensitive changes may need a second eligible reviewer or a separately authenticated agent identity; GitHub does not let an author approve their own PR.

## Actions and secrets

Default `GITHUB_TOKEN` permissions are read-only, and Actions cannot create or approve PRs; this does not constrain external `gh` or GitHub App tokens. Any additional rights must be explicitly declared and reviewed. The [canonical Dependabot Changesets procedure](development-workflow.md#dependabot-changesets) documents the permissionless, candidate-controlled signal and trusted-main writer, its validation and key/environment setup, and the requirement to keep `Repository configuration` required: the signal is not merge readiness. Never check out or execute candidate code in a privileged path. Its [historical qualification records](development-workflow.md#dependabot-changesets) document a live Changeset write, generated-head checks, and an idempotent no-op, but do not establish current settings or credentials. Keep the writer key restricted server-side to `main` and out of PR/repository secrets; test untrusted code on hosted ephemeral runners without production secrets. Never attach an administrative token to a PR test job.

The `.gitignore` prevents ordinary accidental inclusion of local credentials; it is not a secret detector. Gitleaks is a CI detection gate, not server-side push prevention. Enable GitHub Secret Protection/push protection only if the organization already has the entitlement or the owner explicitly accepts its cost. A disabled licensed feature must not be reported as protected by the local scanner. Dependabot alerts and automated security fixes are separate live settings.

## Dedicated development identity

The private development App `jarvis-development-grasdouble` is intended for `grasdouble/Jarvis` only. Read the [App setup and key-storage guide](development-github-app.md) for its recorded configuration, key-handling contract, authentication commands, rotation, and verification. The owner's personal OAuth login remains available for authorized administration; its rights can still change protections, so the local helper is not an OS isolation boundary. Configuration recorded here is not proof of current live settings.

See the [canonical App configuration](development-github-app.md#app-configuration) for the recorded permission set and verification procedure; those values are point-in-time evidence, not current live settings. Do not grant repository Administration, organization administration, Members write, secret management, or rule bypass. Organization Projects permission remains organization-scoped and may require a separate identity when board isolation matters; repository scoping of installation tokens does not narrow that permission. Keep the private key in a protected store outside the checkout and credentials separate from candidate code, PR test jobs, and OpenCode review sandboxes; use only short-lived installation tokens scoped to this repository where GitHub supports repository scoping, through the reviewed helper. Do not silently replace the owner's global `gh` login. Re-verify the effective grant and denied administration when changing the identity.

The production JARVIS App in issue #10 is a separate runtime concern and must not inherit these development permissions. Organization-wide 2FA enforcement affects other repositories and members; review that rollout separately with organization owners.

## Autonomous merging

Repository permission to merge is not user authorization for an agent to do so. The owner selected the [bounded contributor review loop](autonomous-delivery.md): after this policy is adopted, a human request to implement a selected issue includes independent review/corrections and guarded merging of routine changes subject to the per-issue human-review choice and any restrictions. Existing sensitive paths and any unknown/sensitive content still require owner approval under the trusted base and effective GitHub rules. This policy's adoption PR uses the previous rules and human gate.

Agent reviewer verdicts are distinct from native GitHub approvals; the author App publishes an identified assessment comment and cannot approve itself. No second App, bypass or new credential is installed. Never use `--admin`, lower review/check requirements or treat proposed policy as its own authority. Revision/CI/protection checks must be current and remote MERGED confirmed before Done. Contributor subagents are not an enforced security boundary; the product's future role sandboxes require separate qualification.

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
