# GitHub CLI operations for the JARVIS backlog

Use only the recipes needed by the authorized task. Commands were checked against `gh 2.102.0`; consult local `--help` for newer or older versions. Snippets are independent examples, not a batch to execute. Set each `task_*` variable from inspected state or the user's request before using it. Keep temporary body/payload files outside tracked source files.

## App authentication for these recipes

Use the reviewed [development App helper](../../../../docs/development-github-app.md) for routine operations. Replace a read recipe's leading `gh` with `node /trusted/checkout/.agents/skills/jarvis-project-management/scripts/github/gh-app.mjs --`, or use `--write --` for an authorized mutation. The trusted checkout path must identify an actually reviewed helper, not an untrusted PR copy. For publication, replace an ordinary SSH `git push` with `node /trusted/checkout/.agents/skills/jarvis-project-management/scripts/github/gh-app.mjs --write --git-push`, run from the issue worktree. PR creation must specify base and head explicitly. These are command prefixes, not additional commands to run after the recipes. `gh auth status` below inspects the human login; use the helper's `--verify` to check the App. Do not silently fall back to the owner's credentials.

Before authenticating or retrying a transport failure, follow the [network access and recovery procedure](../../../../docs/development-github-app.md#network-access-and-recovery). Use the reviewed helper’s `--check-network` without credentials; exit 75 with `JARVIS_GITHUB_NETWORK:` requires current-context diagnosis and approved access, not key rotation. Reconcile remote state before repeating writes. For offline command discovery, invoke plain `gh … --help` rather than the authenticated wrapper.

## Access and discovery

Use the [README authentication setup](../../../../README.md#github-cli-setup-for-development) when credentials need configuration. Scope changes require the user's authorization; these examples do not initiate login.

```bash
task_repo='grasdouble/Jarvis'
task_owner='grasdouble'
task_project_number=1
gh --version
git remote -v
gh auth status --hostname github.com
gh repo view "$task_repo" --json nameWithOwner,defaultBranchRef,viewerPermission
gh issue list --repo "$task_repo" --state all --limit 100 --json number,title,state,url,labels,milestone
gh label list --repo "$task_repo" --limit 100
gh api --method GET "repos/$task_repo/milestones?state=all&per_page=100" --paginate
gh project view "$task_project_number" --owner "$task_owner" --format json
gh project field-list "$task_project_number" --owner "$task_owner" --limit 100 --format json
gh project item-list "$task_project_number" --owner "$task_owner" --limit 100 --format json
```

Increase CLI limits or paginate until the relevant inventory is complete before deciding that an issue, field, milestone, or item is absent. `gh api --paginate` handles REST pages; use GraphQL cursors for connections. Do not combine `gh api --slurp` with `--jq` on this checked CLI version; parse the collected JSON separately if needed. Quote API paths containing `?` so zsh does not expand them.

## Issue content and classification

Inspect the selected issue, including comments and native dependencies, before editing. The REST issue `id` is a numeric database ID; `node_id` is a GraphQL ID. Neither is the issue's display number.

```bash
gh issue view "$task_issue_number" --repo "$task_repo" --comments
gh api --method GET "repos/$task_repo/issues/$task_issue_number"
gh api --method GET "repos/$task_repo/issues/$task_issue_number/dependencies/blocked_by?per_page=100" --paginate
gh api --method GET "repos/$task_repo/issues/$task_issue_number/dependencies/blocking?per_page=100" --paginate
```

Prepare an English UTF-8 issue body matching the selected task, bug, or decision form. Set the title, body-file path, existing labels, and milestone title from the authorized scope. Add `--label bug` or `--label question` when appropriate; API creation does not apply web-form defaults automatically.

```bash
gh issue create --repo "$task_repo" --title "$task_issue_title" \
  --body-file "$task_issue_body_file" --label "$task_area_label" \
  --label "$task_priority_label" --milestone "$task_milestone_title"
```

The milestone flag is mandatory for every new issue, including coordination parents and children. Resolve the appropriate scope before creation; do not use J00 as a fallback. Inspect all open and closed milestones and reuse an existing one whose original scope covers the issue. Reopen a closed matching milestone in place, regardless of type, when its scope remains applicable; leave completed issues closed and record the scope match and reason. Do not reopen retired, superseded or unrelated milestones. Capture the returned issue URL and reread `milestone` using `gh issue view "$task_issue_number" --repo "$task_repo" --json number,milestone` before further writes. Verify the expected title; a reference in the body does not assign metadata. For an existing issue, edit only intended attributes; `--body-file` replaces the entire body, so first preserve unaffected sections in the edited file. Omit metadata flags that should remain unchanged.

```bash
gh issue edit "$task_issue_number" --repo "$task_repo" --body-file "$task_issue_body_file"
gh issue edit "$task_issue_number" --repo "$task_repo" \
  --add-label "$task_priority_label" --remove-label "$task_previous_priority_label" \
  --milestone "$task_milestone_title"
```

Use current labels rather than creating duplicates. Create or update a label only when that taxonomy change belongs to the request; colors are six hexadecimal digits without `#`.

```bash
gh label create "$task_label_name" --repo "$task_repo" \
  --color "$task_label_color" --description "$task_label_description"
gh label edit "$task_label_name" --repo "$task_repo" \
  --color "$task_label_color" --description "$task_label_description"
```

## Audit required issue milestones

Fetch the complete all-state REST inventory; PR records are excluded by the audit. Apply the trusted App read prefix above to the `gh` recipe. Set the temporary path outside tracked source. Do not combine `--slurp` and `--jq`.

```bash
gh api --method GET "repos/$task_repo/issues?state=all&per_page=100" \
  --paginate --slurp > "$task_issue_inventory_file"
node .agents/skills/jarvis-project-management/scripts/github/check-issue-milestones.mjs "$task_issue_inventory_file"
```

Exit 0 means every supplied issue has a milestone, 1 lists omissions, and 2 means invalid input or usage. The caller must fetch all pages; arbitrary supplied data cannot prove completeness. The [read-only workflow](../../../../docs/development-workflow.md#required-issue-milestones) reports drift without choosing phases or commenting automatically. Correct actual native metadata, reread it, and rerun the audit and queue refresh.

## Milestones and native dependencies

Milestones use REST. Apply [selection and creation rules](../../../../docs/development-workflow.md#milestone-selection-and-creation) before these commands. Inspect open and closed milestones by title, identity, scope and exit gate. Reuse an open match. If a closed milestone's original scope covers the new issue and remains applicable, reopen the same milestone in place by its stable number, regardless of type; preserve its identity/history and leave completed issues closed. Record the scope match and reason and update its description if needed. Do not reopen a retired, superseded or unrelated milestone. Reapply its acceptance/exit gate to the new work before closing it again. A new authorized outcome needs an English title, scope and non-overlap rationale, plus an exit gate when bounded. Use two-digit `JNN` indices for accepted product phases and `DEV — <track>` for ongoing contributor areas or `DEV — <outcome>` for bounded contributor work; neither J00 nor DEV is a fallback. Rename existing milestones by their stable native number, never by deleting/recreating them; update current references and affected project filters and verify equivalent queue ordering with the reviewed padded/legacy parser. Update only supplied fields; leave dates unset unless agreed. Reread after creation/assignment, synchronize linked PR metadata and refresh the queue.

```bash
gh api --method POST "repos/$task_repo/milestones" \
  --raw-field title="$task_milestone_title" --raw-field description="$task_milestone_description"
gh api --method PATCH "repos/$task_repo/milestones/$task_milestone_number" \
  --raw-field description="$task_milestone_description"
# Reopen a matching applicable milestone in place; do not reopen its completed issues.
gh api --method PATCH "repos/$task_repo/milestones/$task_milestone_number" \
  --raw-field state=open --raw-field description="$task_milestone_description"
```

For `A` blocked by `B`, edit `A` with `--add-blocked-by B`. Verify direction and check for a path from `B` back to `A` before adding the edge. Removal is a separate authorized change, not part of adding a dependency.

```bash
gh issue edit "$task_issue_number" --repo "$task_repo" --add-blocked-by "$task_blocker_number"
gh issue edit "$task_issue_number" --repo "$task_repo" --remove-blocked-by "$task_blocker_number"
```

If the installed CLI lacks these flags, use the documented REST endpoint. For addition, obtain the blocker's numeric `id` from its REST issue response; do not send its display number or GraphQL ID as `issue_id`.

```bash
gh api --method GET "repos/$task_repo/issues/$task_blocker_number" --jq .id
gh api --method POST "repos/$task_repo/issues/$task_issue_number/dependencies/blocked_by" \
  --field issue_id="$task_blocker_database_id"
```

Reread `dependencies/blocked_by` after a write. `--field` encodes a numeric value as a JSON number. A dependency link written in an issue body does not create this native relationship.

## Blocker comments and transition recovery

Follow the shared [blocker lifecycle](../../../../docs/blocker-lifecycle.md) and its English comment structures. Apply the App authentication prefix above; comment creation is a write operation included only in an authorized issue-management/delivery task. Before a new event or retry, inspect the issue, complete paginated comment history, native blockers, and actual project status. Match the prepared episode/transition marker and its content; an arbitrary comment or marker is not resolution evidence.

```bash
gh issue view "$task_issue_number" --repo "$task_repo" --comments
gh api --method GET "repos/$task_repo/issues/$task_issue_number/comments?per_page=100" --paginate
gh issue comment "$task_issue_number" --repo "$task_repo" --body-file "$task_comment_body_file"
```

Prepare the UTF-8 body with the real cause/evidence and a stable episode/transition marker before posting. Capture the returned comment URL and reread it in the comment inventory. Reuse a confirmed matching comment after an ambiguous result; do not create a duplicate. Then apply the appropriate status using the project recipes and refresh the queue. If only one operation succeeded, finish the missing operation from reread state; do not repeat the whole sequence blindly. If the ambiguity remains unresolved, report it and stop retrying that transition until state/access is clear.

Keep the opening and resolution comments separate. Do not use `--edit-last`/`--delete-last` to rewrite blocker history or assume the latest App comment is the intended episode. Preserve other authors' comments, resolved dependency links, and unrelated metadata. Correct a factual mistake explicitly rather than erasing the event. No additional polling/scheduled commenting is implied.

References: [issue comments CLI](https://cli.github.com/manual/gh_issue_comment) and [issue comments REST API](https://docs.github.com/en/rest/issues/comments).

## Native sub-issues

Inspect existing children and the intended child's current parent before linking. Creating a child issue uses the same intake requirements and stable `JV-*` naming as any other issue. Use its numeric REST `id`, not its display number or GraphQL node ID. Link only within the authorized parent scope; do not reparent an existing child silently.

```bash
gh api --method GET "repos/$task_repo/issues/$task_parent_number/sub_issues?per_page=100" --paginate
gh api --method GET "repos/$task_repo/issues/$task_child_number/parent"
gh api --method GET "repos/$task_repo/issues/$task_child_number" --jq .id
gh api --method POST "repos/$task_repo/issues/$task_parent_number/sub_issues" \
  --field sub_issue_id="$task_child_database_id"
```

The parent lookup returns 404 when no parent exists; distinguish this from inaccessible content. Recheck the child list and parent after linking. Add each child to the project and set its appropriate status separately. Add actual blocking dependencies using the dependency recipes above; parent links do not create them. Do not auto-close the parent from a partial child PR.

After confirming a child PR has merged, or when the user asks for an issue-state check, use the read-only [`check-coordination-parent.mjs`](bundled-scripts.md#command-entry-points) helper to inspect the native parent, all paginated children, and parent comments. Its `eligible_to_close` result is structural only: every child is `CLOSED` / `COMPLETED`, each has at least one valid App-authored delivery snapshot, and one App-authored final assessment matches the current exact criteria with all outcomes validated. Child-mapped PR/check evidence in the final report must match a validated snapshot; contradictory child-to-PR assignments fail closed. Checklist boxes are neither changed nor required to be checked. The result does not prove that cited evidence is true or semantically sufficient. On an explicit parent-acceptance validation/recording request, follow the evidence-mapping procedure in [`jarvis-project-management`](../SKILL.md#check-coordination-parent-acceptance-on-demand); a status/readiness-only request remains read-only. JV-032 is not specially excluded. If the user separately instructs closure, rerun the structural check immediately before the authorized close, require `eligible_to_close`, then verify the saved issue state:

```bash
node .agents/skills/jarvis-project-management/scripts/github/check-coordination-parent.mjs "$task_child_number"
node /trusted/checkout/.agents/skills/jarvis-project-management/scripts/github/gh-app.mjs --write -- \
  api --method PATCH "repos/$task_repo/issues/$task_parent_number" \
  --field state=closed --field state_reason=completed
node /trusted/checkout/.agents/skills/jarvis-project-management/scripts/github/gh-app.mjs -- \
  api "repos/$task_repo/issues/$task_parent_number"
```

Do not run the PATCH for a routine status check, an ineligible/ambiguous result, or without explicit user closure authorization. The second read must confirm `state: closed` and `state_reason: completed`; a concurrent child/body edit can race the close, so reconcile the latest state rather than claiming an atomic guarantee. Use the reviewed helper path from a trusted checkout and follow network recovery; never fall back to plain `gh` credentials.

For explicit acceptance recording, use the dedicated assessment helper's preview by default. `--write` appends an idempotent evidence snapshot for each completed child, recording missing/insufficient evidence when necessary. If evidence changes, a new snapshot is appended; existing comments are never edited or deleted. Only after every native child has a validated snapshot and every criterion validates does it append one final assessment comment. It does not edit the parent body/checklist or issue state. Require explicit user authorization, run one writer at a time, and after an uncertain write reread the complete comment inventory before retrying. An eligible structural result still does not authorize closing.

Reference: [sub-issues REST API](https://docs.github.com/en/rest/issues/sub-issues).

## Project membership and status

Set `task_item_url` to the actual issue or PR URL, not the project URL. Inspect membership first and add only if absent. After an ambiguous result, reread before retrying.

```bash
gh project item-add "$task_project_number" --owner "$task_owner" \
  --url "$task_item_url" --format json
gh project item-edit "$task_project_number" --owner "$task_owner" \
  --url "$task_item_url" --field 'Status' --value "$task_status"
gh project item-list "$task_project_number" --owner "$task_owner" --limit 100 --format json
```

Choose `task_status` using the skill's status definitions and inspect existing project automations before transitions. `Done` requires confirmed delivery and can automatically close the issue. Move the issue's item as well as any separately tracked PR item only when each transition is appropriate; these are distinct project items.

If name-based `item-edit` flags are unavailable, discover live IDs from `project view`, `field-list`, and `item-list` JSON. Match the item by its content URL, the field by its name, and the option by its exact status name. Do not reuse IDs from another project or assume an issue node ID is a project item ID.

```bash
gh project item-edit --project-id "$task_project_id" --id "$task_item_id" \
  --field-id "$task_status_field_id" --single-select-option-id "$task_status_option_id"
```

For API operations beyond CLI coverage, use `gh api graphql` with variables or `gh api --input` with a prepared JSON payload. Keep GraphQL queries literal (single-quoted or in a file) so shell expansion cannot corrupt `$variables`. Discover IDs and available mutations from the current API; do not guess field-edit commands.

## Execution order refresh

From a reviewed Jarvis checkout, use `node .agents/skills/jarvis-project-management/scripts/github/sync-project-queue.mjs` for preview and add `--write` for authorized rank synchronization. It uses the dedicated App helper internally; do not wrap it in another `gh` invocation. Follow [the selection procedure](../../../../docs/development-workflow.md#select-and-refresh-the-next-issue), not a numeric issue sort. Restore missing membership or inspect incomplete/dependency data before rerunning a failed refresh. Preserve the Next up saved filter/sort and existing other views.

## Views and built-in automations

Preserve existing Delivery, Backlog, and Roadmap views. Creating a missing organization project view is supported by REST; this is not a general update-view command. Only create one after verifying that it is absent and the configuration change is authorized. The prepared JSON payload must contain `name` and `layout` (`table`, `board`, or `roadmap`), with optional filters/grouping using IDs accepted by this endpoint. Resolve REST field IDs rather than substituting GraphQL node IDs.

```bash
gh api --method POST "orgs/$task_owner/projectsV2/$task_project_number/views" \
  --input "$task_view_payload_file"
```

To update an existing view, first discover its native view ID and inspect `UpdateProjectV2ViewInput` in the live schema. The supported `updateProjectV2View` mutation accepts `viewId`, `name`, `layout`, `filter` and `configuration`; send only the intended fields through a prepared GraphQL request/variables file, then read back all views to verify unrelated settings. This avoids recreating a view just to change its filter. See the [Projects schema reference](https://docs.github.com/en/graphql/reference/projects).

Use the documented API or authenticated browser for settings not exposed by dedicated commands. Built-in Projects automation configuration is documented through the web interface; `gh workflow` controls GitHub Actions instead. Do not recreate views or add an Actions workflow merely to work around an unsupported setting without task scope for that change.

## Verify results

Reread the affected issue, milestone, dependency list, and project item as applicable. Compare changed attributes with the intended values, preserving unrelated metadata. Creation of an issue does not prove project membership or a correct status. Inspect partial results after any timeout or error before retrying a mutation.

References: [issue editing](https://cli.github.com/manual/gh_issue_edit), [milestones REST API](https://docs.github.com/en/rest/issues/milestones), [dependency REST API](https://docs.github.com/en/rest/issues/issue-dependencies), [project item editing](https://cli.github.com/manual/gh_project_item-edit), [Projects GraphQL](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects), [view creation](https://docs.github.com/en/rest/projects/views), and [built-in automations](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations).

## Synchronize PR Issue and Milestone

Use the [PR metadata procedure](../../../../docs/pr-project-metadata.md) from a reviewed checkout after authorized issue-link or milestone edits. The command already uses the App helper; no extra authentication prefix is needed. Scope to the actual selected PR number; omit `--pr NUMBER` only for authorized project-wide catch-up.

```bash
node .agents/skills/jarvis-project-management/scripts/github/sync-pr-project-metadata.mjs --pr NUMBER
node .agents/skills/jarvis-project-management/scripts/github/sync-pr-project-metadata.mjs --pr NUMBER --write
```

Read diagnostics, verify the native relationship and resolve ambiguity instead of choosing a primary issue from prose. The command derives the reserved Issue field and native PR milestone only, preserving the self-update exception. It never changes Status or creates issue links. Workflow activation and secure CI credential provisioning follow the linked procedure.

## Synchronize observed Roadmap dates

Follow the [actual-date contract](../../../../docs/roadmap-actual-dates.md) after authorized native status/state changes. Replace NUMBER with the selected issue; the reviewed command uses the App helper itself. Do not prefix it with `gh` or supply owner credentials.

```bash
node .agents/skills/jarvis-project-management/scripts/github/sync-pr-project-metadata.mjs --roadmap --issue NUMBER
node .agents/skills/jarvis-project-management/scripts/github/sync-pr-project-metadata.mjs --roadmap --issue NUMBER --write
```

Project-wide backfill omits `--issue NUMBER` only within corresponding maintenance scope. Verify diagnostics and both saved actual dates; unknown history stays unknown, planned date fields remain unchanged and no status transition is performed by this command.
