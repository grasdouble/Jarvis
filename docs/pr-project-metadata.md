# Pull request project metadata

This contributor tool maintains the visible **Issue** column and native **Milestone** in the [Pull requests view](https://github.com/orgs/grasdouble/projects/1/views/4). It is separate from the future JARVIS runtime. Delivery/project-management skills call it during authorized publication; the opt-in workflow reconciles later changes and PRs created outside those skills.

## Source and mutation contract

The only source is GitHub's native `closingIssuesReferences` relationship, not an issue-looking title, branch, comment or arbitrary URL in a PR body. For ordinary contributor delivery, use `Closes #N` for the actual implementation issue and verify the resulting native relationship. A `Refs #parent` context reference does not select the parent. The issue's native milestone is authoritative; no fallback to J00 or a phase inferred from the PR text is permitted.

| Native relationship | Result |
| --- | --- |
| One Jarvis issue with a milestone | Add missing PR project membership; copy the issue milestone onto the PR; set Issue to `JV-091 · https://github.com/grasdouble/Jarvis/issues/91` for issue 91. |
| Destinations already match | No writes. |
| Several issues, foreign issue, or issue without a milestone | Report an error for that PR; do not choose a source or partially fill its destinations. Independent valid PRs can still synchronize; the command exits unsuccessfully to expose unresolved errors. |
| No native issue, including ordinary unlinked Dependabot PRs | Report a notice; do not add membership or assign/change a milestone. If already a member, clear only an exactly generated stale Issue value. Preserve other text and report it as an error. |
| `self-update` label | Exempt: preserve membership, Issue and milestone, with a notice. The product controller owns its PR-only intake. |

**Issue is a reserved derived field.** A valid native source replaces destination edits, including a manually changed PR milestone or Issue text. Unlinking clears only a previously generated Issue value: it preserves the milestone because the tool cannot prove ownership of that native value. Select or correct the native link/milestone yourself, then rerun; the tool never creates issue links. Ordinary `Refs`-only PRs need a proper native implementation relationship before synchronization.

Scope is fixed in reviewed code to `grasdouble/Jarvis`, organization Project 1, its expected project ID and the existing Issue TEXT field ID. Missing/renamed/recreated fields, malformed data, duplicate memberships and incomplete pagination fail closed. Open, merged and closed repository PRs are included; other repositories' project items and issue items remain untouched. Connection pagination has explicit limits of 100 pages and 10,000 nodes per connection; reaching either fails rather than silently omitting items.

In ordinary PR-metadata mode, writes are restricted to project membership, this one text field, and native PR milestones. No Status, issue state, labels, links, reviews, source changes or protection updates are issued. Existing GitHub project automations can still react to membership changes; the tool does not override their status decisions. View layout, permissions, other fields and the execution queue remain separate.

## Local publication and reconciliation

Use a reviewed checkout with Node.js 24, GitHub CLI and the [development App helper](development-github-app.md). When reviewing a change to these scripts, inspect it before running it with credentials. No dependency installation or PNPM scaffold is required for this contributor tool.

```bash
# Read-only preview of one published PR.
node .agents/skills/jarvis-project-management/scripts/github/sync-pr-project-metadata.mjs --pr 92
# Within the authorized publication scope, apply and reread its derived metadata.
node .agents/skills/jarvis-project-management/scripts/github/sync-pr-project-metadata.mjs --pr 92 --write
# Authorized project-wide catch-up, including historical PRs.
node .agents/skills/jarvis-project-management/scripts/github/sync-pr-project-metadata.mjs
node .agents/skills/jarvis-project-management/scripts/github/sync-pr-project-metadata.mjs --write
```

Replace 92 with the actual published PR number; never run an example blindly. Local execution uses the existing App helper with read/write profiles, without personal-token fallback. `--pr` scopes initial, recovery and final reads and effects to that PR; prefer it while another agent owns a different issue. No CLI option changes the repository, project or field.

Read the JSON result: `mode`, attempted writes, verified PR count, pending PR count and per-PR diagnostic codes. Preview reports differences without effects. Notices distinguish intentionally skipped work; errors yield a nonzero exit. Success with zero writes does not prove an unlinked PR has an issue. Request errors are sanitized rather than exposing API bodies or credentials.

Mutations are sequential and small. Before every write and after every response (including a failure), reload native source and destinations. Detect a changed PR identity, native relationship/milestone or self-update status and stop. An uncertain add already observed in GitHub is not added twice. Retry only classified transient timeouts/service failures, up to three failed attempts per PR, with short delays and a hard limit of twelve mutation attempts per PR. Unreadable recovery state, permanent errors and changed sources stop the run. A final reread must show no remaining eligible changes before reporting synchronization.

This is optimistic reconciliation, not an atomic GitHub transaction or a lock against manual/local writers. Partial confirmed changes can remain after failure. Inspect the reported PRs, rerun preview and only then repeat an authorized write. Stop competing local runs; the Actions concurrency group serializes workflow runs only. Native edits immediately after a reread can race with a mutation and require a subsequent reconciliation.

## Workflow and credential activation

[PR project metadata](../.github/workflows/pr-project-metadata.yml) runs on main-target PR metadata events, issue changes, an hourly catch-up and manual dispatch. Relevant events made by an App can trigger Actions. Idempotence prevents repeated milestone writes after convergence. Scheduled runs can be delayed by GitHub and do not provide a strict synchronization deadline. Native link edits without a useful event are caught by catch-up or the local command.

The workflow is **off by default** until repository Actions variable `JARVIS_PROJECT_SYNC_ENABLED` equals `true`. Adding a workflow file does not provision credentials. Activation requires owner administration; contributor App permissions remain unchanged. Do the following only after this change has been reviewed and merged:

1. Verify that this private repository's GitHub plan supports **environment secrets and deployment branch rules**. Public availability does not prove private availability. If unavailable, leave the workflow disabled and use the reviewed local command; choose a separately reviewed credential design before unattended CI. Do not move the key to repository/organization secrets to bypass this requirement.
2. Create the environment `jarvis-project-sync` in repository Settings → Environments. Select **Selected branches and tags**, allow exactly branch **main**, and add **no tag or `refs/pull/*` rules**. Do not use unrestricted or generic protected-branches-only access. Server-side restrictions protect the secret even if a candidate branch modifies the workflow. A required reviewer on each metadata run is optional, not needed for this unattended design.
3. As App owner, generate a **separate key** for the existing `jarvis-development-grasdouble` App. Store it only as environment secret **`PROJECT_SYNC_APP_PRIVATE_KEY`** in `jarvis-project-sync`, using GitHub's secure UI. Keep the Mac key local. Do not paste a PEM into chat/PRs, commit it, automatically upload it or create a repository-level copy. A separate key still represents the same App and can mint its approved installation permissions; rotate/revoke it as an App credential, not as a narrowly scoped project-only key.
4. Verify the App installation is still `171906128`, limited to Jarvis. The workflow explicitly requests **organization Projects write**, **Pull requests write**, **Issues read** and **Metadata read**. It requests no Contents write, Workflows write, Administration or bypass. Organization Projects permission is organization-scoped, not limited by GitHub to Project 1; fixed code destinations and protected trusted source reduce that residual scope.
5. Set repository Actions variable `JARVIS_PROJECT_SYNC_ENABLED=true`. It must be a repository variable because the job's pre-environment condition uses it. Dispatch this workflow on **main**. Check the App/installation identity check, logs and actual native PR milestone/project Issue values. Run a second dispatch and verify zero writes. Exercise a later issue-milestone/link change on an owner-approved test item; synthetic tests alone do not qualify this live CI path.
6. Keep the secret, workflow and environment restrictions under owner control. Disable the variable to stop new runs; it does not cancel an active job. Cancel an active job if needed, inspect partial progress, revoke the CI key/known tokens if compromised, and reconcile with the local tool before reactivation.

Each privileged run checks out explicit reviewed `refs/heads/main`, without persisted Git credentials. It runs no PR checkout, cache, artifact, dependency installation, repository hook or candidate script. GitHub-owned actions are pinned to full SHAs. The default `GITHUB_TOKEN` has Contents read; the separately minted token is revoked by the action after the job and otherwise expires within one hour. A 15-minute job limit bounds execution. Candidate refs are rejected both by the job/CLI and by the environment's server-side main-only rule. No ordinary contributor credential or Mac PEM is a CI fallback.

The workflow creates a GitHub environment deployment record for this metadata job; it does not deploy JARVIS. Missing credential/environment/plan support is an explicit activation prerequisite, not evidence that CI is already operational. Local synchronization remains usable before CI activation. No checks, code-owner requirements or human approval gates are weakened.

The same protected workflow also runs the separate [Roadmap actual-date mode](roadmap-actual-dates.md). That mode only derives the two reserved issue DATE fields; it does not expand ordinary PR-mode writes or add credential permissions. Native project-only status edits use skill hooks plus eventual scheduled catch-up.

## Verification and references

Behavioral tests cover deterministic planning, idempotence, malformed/ambiguous input, scoped transport, pagination, source drift, lost responses, retry exhaustion and CLI context. Workflow tests characterize the actual trusted-main checkout, protected environment and restricted token inputs, including unsafe variants. They cannot prove server-side environment configuration, plan support, credential provisioning or live token permissions. Record those separately during activation.

Documentation checked on 2026-10-17:

- [GitHub linking semantics](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue) and [GraphQL schema](https://docs.github.com/en/graphql/reference): native relationships are authoritative.
- [Update an issue](https://docs.github.com/en/rest/issues/issues#update-an-issue): PRs are issue resources; milestone updates accept Pull requests write or Issues write.
- [Projects GraphQL API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects): membership and field operations.
- [Secure Actions use](https://docs.github.com/en/actions/reference/security/secure-use): least privilege, trusted source and privileged-event risks.
- [Environments and branch rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments): server-side branch filtering and private-plan requirements.
- [Create GitHub App token](https://github.com/actions/create-github-app-token): explicit installation/repository permissions and token revocation. v3 action source checked at the pinned commit in the workflow.
