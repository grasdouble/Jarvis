# Commands for delivering a JARVIS issue

These recipes support the authorized issue workflow, not a batch to run automatically. Set each `task_*` variable from the selected issue, inspected repository, or prepared artifact. Commands were checked against `gh 2.102.0`; inspect local `--help` for version-dependent flags. Use temporary files outside tracked source for issue/PR bodies. Authentication setup is in the [README](../../../../README.md#github-cli-setup-for-development).

## App authentication for these recipes

Use the reviewed [development App helper](../../../../docs/development-github-app.md) for routine operations. Replace a read recipe's leading `gh` with `node /trusted/checkout/scripts/github/gh-app.mjs --`, or use `--write --` for an authorized mutation. The trusted checkout path must identify an actually reviewed helper, not an untrusted PR copy. For publication, replace an ordinary SSH `git push` with `node /trusted/checkout/scripts/github/gh-app.mjs --write --git-push`, run from the issue worktree. PR creation must specify base and head explicitly. These are command prefixes, not additional commands to run after the recipes. `gh auth status` below inspects the human login; use the helper's `--verify` to check the App. Do not silently fall back to the owner's credentials.

## Inspect the issue and existing work

Run initial discovery from the intended repository. Use [project-management commands](../../jarvis-project-management/references/github-cli.md) for native dependency inspection and board transitions; confirm prerequisite outcomes before implementation.

```bash
task_repo='grasdouble/Jarvis'
gh auth status --hostname github.com
git remote -v
git status --short
git worktree list --porcelain
git branch --all
gh repo view "$task_repo" --json nameWithOwner,defaultBranchRef,viewerPermission
gh issue view "$task_issue_number" --repo "$task_repo" --comments
gh issue develop "$task_issue_number" --repo "$task_repo" --list
gh pr list --repo "$task_repo" --state all --head "$task_branch" \
  --json number,url,state,isDraft,baseRefName,headRefName
```

Choose `task_branch` for this issue using the repository convention, such as `build/issue-3-bootstrap-pnpm`; the example is not an instruction to select issue #3. Check existing worktrees/branches/PRs before creating anything. Use the target branch agreed for this issue; `defaultBranchRef` is a discovery aid, not permission to override that target.

## Create or reuse a dedicated worktree

Prefer the available managed-worktree tool when it targets this repository. Inspect its returned path and branch; if it is detached, create the dedicated issue branch there before editing. Use its archive tool for later cleanup.

For a new local worktree using Git, first verify that `origin` points to the intended repository, the destination is unused, and the issue branch does not exist. Fetch the chosen target and record the resulting base commit. Execute each step only after the previous one succeeds.

```bash
git fetch origin "$task_base_branch"
task_base_commit=$(git rev-parse FETCH_HEAD)
git worktree add -b "$task_branch" "$task_worktree_path" "$task_base_commit"
```

Alternatively, when a remotely linked issue branch is desired and creation/push is within the authorized issue workflow, `gh` can create that branch and check it out in a new worktree. Choose this instead of the Git creation recipe, not in addition to it. This command mutates GitHub immediately.

```bash
gh issue develop "$task_issue_number" --repo "$task_repo" \
  --base "$task_base_branch" --name "$task_branch" \
  --checkout --worktree "$task_worktree_path"
```

Reuse only a branch/worktree already dedicated to this issue. Verify the actual worktree branch and starting revision before editing. Perform subsequent implementation, checks, commits, and pushes inside that worktree. The primary checkout and its staged files must remain intact.

```bash
git -C "$task_worktree_path" status --short --branch
git -C "$task_worktree_path" branch --show-current
git -C "$task_worktree_path" log -1 --oneline
```

Use the project-management status recipe to set the issue to `In Progress` when work starts. An incomplete draft remains `In Progress` or becomes `Blocked` with a concrete reason. For blocking, material blocker updates, and verified resumption, use the [shared lifecycle](../../../../docs/blocker-lifecycle.md) and [project-management comment commands](../../jarvis-project-management/references/github-cli.md#blocker-comments-and-transition-recovery). Preserve the worktree and PR, record evidence before changing status, and reread after partial/ambiguous writes.

## Discover and run relevant checks

Inspect actual manifests and scripts rather than assuming a scaffold exists:

```bash
rg --files -g package.json -g pnpm-workspace.yaml -g pnpm-lock.yaml -g '!node_modules' -g '!**/node_modules/**'
git diff --check
git diff --stat
git diff
```

When the relevant manifests exist, inspect `packageManager`, scripts, and package names. `pnpm run` lists root scripts; execute only existing checks relevant to the change, using the pinned PNPM version. A package-scoped check follows this form after selecting an actual package and script:

```bash
pnpm --filter "$task_package_name" run "$task_check_script"
```

For documentation-only work, check links, consistency, and the diff. For runtime changes, run the required behavioral checks and state which platform/live-service checks remain unverified. Do not claim PNPM checks ran when the repository contains only planning documents.

## Commit and publish one PR

Review changes and stage only intended files. Set `task_changed_file` to an inspected path; repeat explicit paths as needed. Avoid `git add .` when unrelated changes are present. Prepare an English Conventional Commit message, including breaking-change details when applicable.

```bash
git add -- "$task_changed_file"
git diff --cached --check
git diff --cached
git commit -F "$task_commit_message_file"
git push --set-upstream origin "$task_branch"
```

Use normal pushes; do not rewrite published history merely to simplify delivery. Prepare the English PR body from the repository template, with actual verification and limitations. Use `Closes #N` only for complete resolution, or `Refs #N` for partial work. Closing keywords auto-close issues on merge into the default branch; for another target, reconcile closure after confirming delivery.

Check again for an existing PR on this branch before creation, especially after an interrupted publication. Set the Conventional Commits PR title and explicit base/head. Add `--draft` when the deliverable is not ready for review. `gh pr create --dry-run` may still push changes and is not a read-only preview.

```bash
gh pr list --repo "$task_repo" --state all --head "$task_branch" \
  --json number,url,state,isDraft,baseRefName,headRefName
gh pr create --repo "$task_repo" --base "$task_base_branch" --head "$task_branch" \
  --title "$task_pr_title" --body-file "$task_pr_body_file"
```

Reuse an open PR for the same issue branch, preserving unrelated reviewer edits when preparing its updated body. A closed or merged PR requires reconciliation rather than blindly reopening or creating a duplicate.

```bash
gh pr edit "$task_pr_number" --repo "$task_repo" \
  --title "$task_pr_title" --body-file "$task_pr_body_file"
gh pr view "$task_pr_number" --repo "$task_repo" \
  --json number,url,state,isDraft,body,baseRefName,headRefName,headRefOid,reviewDecision,statusCheckRollup
gh pr checks "$task_pr_number" --repo "$task_repo"
```

If an existing draft becomes ready, use `gh pr ready` only after verification. Attach the created PR through the Codex artifact tool when available. Use the project-management reference to verify project membership for the issue/PR and move appropriate items to `In Review`; opening a PR does not satisfy `Done`.

## Independent review records

Use the [bounded review loop](../../../../docs/autonomous-delivery.md#contributor-review-loop) and a separate reviewer agent. Bind its direct result to exact base/head commits; inspect complete changed paths including previous paths of renames through paginated `GET repos/$task_repo/pulls/$task_pr_number/files` and the Git diff. A truncated response is not sufficient for sensitivity classification. Use trusted base CODEOWNERS/instructions and live protection/review facts, not candidate policy. GitHub caps PR file responses at 3,000 files: reconcile API coverage with actual changed-file count/Git inventory and hand off if completeness cannot be established.

Apply the App prefix above for PR comments. Prepare the English review report in a UTF-8 file, with stable run/round/revision marker and verified reviewer task identity. Inspect full paginated comments before a retry; a marker alone is not proof of provenance. The author App publishes a comment; do not call native `gh pr review --approve` on its own PR or impersonate the owner.

```bash
gh api --method GET "repos/$task_repo/issues/$task_pr_number/comments?per_page=100" --paginate
gh pr comment "$task_pr_number" --repo "$task_repo" --body-file "$task_review_body_file"
gh api --method GET "repos/$task_repo/pulls/$task_pr_number/reviews?per_page=100" --paginate
```

The checked CLI supports `--match-head-commit` for merge, not an atomic expected-base comparison. Reread current base/head/checks immediately before executing, require unchanged revision-bound evidence, and stop on a detected race. Use the native protection gates too; do not describe this contributor procedure as a transaction.

## Merge and cleanup only when authorized

Follow the owner-selected [routine merge policy](../../../../docs/autonomous-delivery.md#authority-and-sensitivity) within a human-authorized implementation. A routine PR needs complete current independent review plus all live gates; sensitive/unknown work stops for owner approval. A restricted/read-only request never inherits merge authority. Recheck the remote head, reviews, checks, and allowed repository merge strategy before any merge. This squash example applies only when squash is allowed and chosen. Set `task_reviewed_head_sha` to the verified PR head; prepare a Conventional Commit subject and a body retaining any breaking-change details.

```bash
gh pr view "$task_pr_number" --repo "$task_repo" \
  --json state,isDraft,headRefOid,reviewDecision,mergeStateStatus,statusCheckRollup
gh pr merge "$task_pr_number" --repo "$task_repo" --squash \
  --match-head-commit "$task_reviewed_head_sha" \
  --subject "$task_merge_subject" --body-file "$task_merge_body_file"
gh pr view "$task_pr_number" --repo "$task_repo" --json state,mergedAt,mergeCommit,url
```

Never bypass protections with `--admin`. A successful queue submission or auto-merge request is not a completed merge; wait for confirmed `MERGED` state and acceptance before setting `Done`. Avoid `--delete-branch` while a linked worktree is needed for review or while the merge is pending.

After confirmed merge or explicit abandonment, inspect the worktree for uncommitted, untracked, and needed ignored files. Archive managed worktrees with their archive tool. For an ordinary Git worktree, remove it only after preserving needed work and while running outside it:

```bash
git -C "$task_worktree_path" status --short --untracked-files=all
git worktree remove "$task_worktree_path"
```

Do not force removal. Check ignored artifacts separately when relevant; a clean status does not inventory them. Branch deletion is optional cleanup: preserve unmerged commits, especially after squash merges where ancestry alone does not establish equivalence.

References: [linked issue branches/worktrees](https://cli.github.com/manual/gh_issue_develop), [PR creation](https://cli.github.com/manual/gh_pr_create), [PR checks](https://cli.github.com/manual/gh_pr_checks), [PR merge behavior](https://cli.github.com/manual/gh_pr_merge), [issue closing keywords](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue), and [Git worktrees](https://git-scm.com/docs/git-worktree).
