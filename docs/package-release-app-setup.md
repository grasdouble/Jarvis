# Provision the package-release GitHub App

This guide is for an authorized organization/repository administrator provisioning the CI identity used by the Changesets version-PR and package-release workflows. Registering an organization App requires an organization owner or delegated GitHub App manager; installation and environment configuration may require organization-owner or repository-admin access. It does not authorize an agent to create or modify GitHub settings.

The CI App is separate from both the local [`Jarvis Development Grasdouble` App](development-github-app.md) and the future product App in issue [#10](https://github.com/grasdouble/Jarvis/issues/10). Do not reuse the local development App or its Mac PEM, and do not use a personal token.

## 1. Register the organization-owned App

In the [`grasdouble` organization settings](https://github.com/organizations/grasdouble/settings/apps), open **Developer settings → GitHub Apps → New GitHub App**. You need permission to manage organization Apps.

Use these registration values:

| Field | Value |
| --- | --- |
| GitHub App name | `Jarvis Package Release Automation` |
| Description | `Creates reviewed version PRs and GitHub Releases for private packages in grasdouble/Jarvis. Does not publish packages to registries or deploy products.` |
| Homepage URL | `https://github.com/grasdouble/Jarvis` |
| Callback / Redirect URL | Leave empty; this App does not authenticate users. |
| Setup URL | Leave empty; no post-install setup redirect is needed. |
| Webhook **Active** | Unchecked; leave the URL and secret empty and do not subscribe to events. |
| Allow wildcard matching | Unchecked; no callback URL is configured. |
| Expire user authorization tokens | Leave the default checked; the App does not use user authorization tokens. |
| Request user authorization (OAuth) during installation | Unchecked. |
| Enable Device Flow | Unchecked. |
| Where can this GitHub App be installed? | **Only on this account** (`@grasdouble`), not **Any account**. |

The current App slug is `jarvis-package-release-automation`. GitHub derives the slug from the App name; confirm the actual slug after registration and use that exact value below. The slug is not the App ID or Client ID.

## 2. Set minimum permissions and install on Jarvis only

Under **Repository permissions**, set:

| Permission | Access |
| --- | --- |
| Contents | Read and write |
| Pull requests | Read and write |
| Every other repository permission | No access |

Leave organization and account permissions at **No access**. GitHub grants the required Metadata read access automatically. The workflows request narrower per-job installation tokens: Contents and Pull requests write for the version-PR job, then Contents write only for post-merge tag/Release creation. The post-merge path no longer reads PR details. The App does not need Actions or Workflows permission.

After creating the App, open its **Install App** page, install it on `@grasdouble`, and choose **Only select repositories → Jarvis**. Do not choose all repositories. If installation is already present, open its **Configure** page and verify that `Jarvis` is the only selected repository.

## 3. Generate the CI private key

On the App settings page, open **Private keys → Generate a private key**. GitHub downloads a PEM file; GitHub does not retain a copy of the private portion. This is a CI-only key, not the local development App's key.

Keep the downloaded file private while entering its full contents into the environment secret in the next step. Never paste the key into chat, an issue, a PR, a terminal transcript, a tracked file, or a workflow variable. Do not put it in `~/Library/Application Support/Jarvis Development/credentials`. Remove any temporary local copy according to the owner's secure-retention practice after provisioning.

For rotation, generate an additional App key, replace the environment secret, verify an authorized workflow run, and then revoke the old key in App settings. App private keys do not expire automatically. See GitHub's [private-key management guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).

## 4. Create and configure the Actions environment

In the `Jarvis` repository, open **Settings → Environments → New environment** and create the exact name:

```text
package-releases
```

The two release workflows reference this environment directly. The version-PR job invokes the pinned Lufa Changesets release action from trusted `main`; that invocation has an empty publish command and GitHub Releases disabled. After the closed-event metadata filters pass and the workflow checks out the event merge SHA, the post-merge workflow invokes the same pinned Lufa action, which wraps the pinned nested Changesets action. It supplies `python3 scripts/release/tag_private_packages.py --cli node_modules/.bin/changeset` as `publish-command` and enables GitHub Releases; the action's default version command remains in effect. The wrapper executes the pinned CLI's `tag` command, not registry publication. Add these **environment variables** (not repository-level variables):

| Variable | Value and where to find it |
| --- | --- |
| `PACKAGE_RELEASE_APP_CLIENT_ID` | The App's **Client ID** on its General settings page. Do not substitute the numeric App ID. |
| `PACKAGE_RELEASE_APP_SLUG` | The exact generated App slug; currently `jarvis-package-release-automation`. |
| `PACKAGE_RELEASE_APP_INSTALLATION_ID` | The numeric ID for the installation on `grasdouble/Jarvis`. Find it on the installation's **Configure** page in the URL after `/settings/installations/`. |

Add this **environment secret**:

| Secret | Value |
| --- | --- |
| `PACKAGE_RELEASE_APP_PRIVATE_KEY` | The complete PEM contents of the CI App key generated in step 3, including its begin/end lines. |

Do not add an environment approval gate or a ruleset bypass for any other actor. Existing main-branch protections, CODEOWNERS, workflow guards, and review of the generated version PR remain in force; the environment only scopes the release credentials to the two jobs that declare it.

## 4a. Protect the Lufa-managed release branch

Create the dedicated repository ruleset through repository settings (an administrator action; the workflow never creates or changes rulesets):

| Setting | Required value |
| --- | --- |
| Name | `Changesets release branch — package release App` |
| Enforcement | Active |
| Target | Branch, with only `refs/heads/changeset-release/main` included and no exclusions |
| Rules | `creation`, `update`, `deletion`, and `non_fast_forward` |
| Bypass | Only the `Jarvis Package Release Automation` GitHub App, with **Always allow** |

Do not add users, teams, repository roles, organization administrators, or another integration as bypass actors. This branch-scoped ruleset prevents other writers from pre-creating, modifying, deleting, or force-updating the branch while allowing the Lufa action's required updates by the release App. It does not bypass PR review or main-branch protections.

Before invoking Lufa, the workflow uses its existing repository-scoped App token to read the ruleset listing and matching details. GitHub's rules API requires repository Metadata read, which GitHub grants automatically to installed Apps; no Administration permission is requested. The check fails closed unless the named ruleset is unique, repository-scoped, active, targets exactly the managed ref, and contains all four required rule types. It does not infer or inspect bypass actors: GitHub may omit `bypass_actors` when the caller lacks ruleset write access, and the workflow token must not be given that access. An authorized administrator must verify and retain evidence of the App-only **Always allow** bypass in repository settings; the owner-provided current settings screenshot is that setup evidence.

## 5. Verify safely

The [Package version PR workflow](../.github/workflows/package-version-pr.yml) runs from trusted `main` when Changesets are detected and uses the immutable Lufa action with publication disabled. Before that action can write, the workflow verifies the release-branch ruleset and a read-only App-token preflight checks the managed branch and its latest PR history. A first run is allowed only when neither exists; an existing branch/PR is accepted only when it is the expected same-repository `main` PR authored by the configured App, has the expected title and matching current branch/head SHA, and its tip commit has the expected App author/committer and release commit message. The PR must remain open or be confirmed merged. Unmatched, closed-unmerged, inconsistent, or truncated state fails closed. The Lufa action's built-in force update then applies only to its `changeset-release/main` branch, protected by the dedicated App-only bypass ruleset above. The previously closed, unmerged #195 uses `changesets/version`, which the new action does not target. The [Package releases workflow](../.github/workflows/changeset-releases.yml) is triggered only by a closed PR and filters for merged same-repository PRs into `main` from either recognized Changesets version branch. It checks out the event `merge_commit_sha` and retains the separate installed-App identity check. It no longer calls a post-merge PR identity/generated-diff preflight and does not assert at runtime that checkout `HEAD` or `github.sha` equals the event merge SHA. Accordingly, it does not revalidate the PR author or generated diff after merge. Release operation relies on the trusted event metadata, protected pre-merge review/CI/branch rules, configured checkout ref, and separate App identity check.

For a real package change, verify the version workflow's environment checks, App-token creation, and App slug/installation identity check. A successful run that only validates credentials does **not** prove that it created or updated a version PR. Actual version-PR and post-merge tag/Release writes are verified only when a legitimate package Changeset flows through the reviewed version PR and its protected merge. Do not add an artificial package bump or test Release to exercise production credentials.

The automation creates package tags and GitHub Releases only; it does not publish packages to a registry or deploy the product. Changesets `git-tag` includes all eligible private packages lacking tags, including unchanged packages. When tag creation succeeds, the action creates the tag at its workflow context SHA. GitHub supplies the merge commit as that context SHA for a merged pull-request event, but this workflow no longer explicitly verifies the context SHA against the checked-out or event merge SHA. For packages without a changelog file, the runner-local wrapper writes fallback changelogs into the ephemeral job checkout; it leaves them there for the action to read, but never commits them. Tag-push failures can be warnings while Release creation continues. In that case, the Release attempt may use an already-existing tag that points somewhere other than the confirmed merge commit; if the tag does not exist, GitHub's Release API may create it at the default branch. Therefore, exact-SHA binding is expected from the event context only after successful tag creation, not runtime-verified; it is not guaranteed on tag-push failure. The action does not reconcile existing Releases, so duplicate creation can fail on reruns. These limitations are accepted; do not assume fail-closed mismatch handling or idempotent recovery. The initial live provisioning run [39314538994](https://github.com/grasdouble/Jarvis/actions/runs/39314538994) verified the provisioned environment and App identity, but had no versionable Changeset to process and therefore made no version-PR or Release write.

If a job reports a missing value, check that the name is exact and that the values are configured on the `package-releases` environment. If token creation or identity verification fails, confirm the App slug, Client ID, installation ID, repository selection, and granted permissions. Never print the private key to diagnose a failure; replace it through the owner-managed rotation process if necessary. The workflows fail closed and have no personal-token or Mac-key fallback.

## References

- [Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
- [Choose GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/choosing-permissions-for-a-github-app)
- [Install a GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)
- [Manage GitHub Actions environments](https://docs.github.com/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [Use secrets in GitHub Actions](https://docs.github.com/actions/security-guides/using-secrets-in-github-actions)
- [Package release workflow decisions and acceptance](https://github.com/grasdouble/Jarvis/issues/35)
