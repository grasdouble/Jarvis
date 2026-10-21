# Parent acceptance assessment input

`coordination-parent-acceptance.mjs` records a criterion-by-criterion assessment that the caller has already made from directly inspected delivery evidence. The script is a deterministic recorder, not a semantic reviewer or approval source. The caller must read the parent and all native children, inspect child acceptance outcomes and the cited merged PR revisions/current checks/integration results, and verify any owner authorization before preparing this file.

## Shape

```json
{
  "parentIssue": 160,
  "criteria": [
    {
      "index": 1,
      "text": "Exact current parent criterion text.",
      "outcomes": [
        {
          "description": "One separately verifiable outcome required by the criterion.",
          "status": "validated",
          "kind": "child",
          "childIssues": [161],
          "evidence": [
            {
              "url": "https://github.com/grasdouble/Jarvis/pull/162",
              "label": "Merged PR; required checks passed at the exact reviewed head.",
              "sourceType": "pull_request",
              "status": "merged",
              "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "reviewedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "childIssue": 161
            },
            {
              "url": "https://github.com/grasdouble/Jarvis/actions/runs/223",
              "label": "Required current-head checks passed.",
              "sourceType": "workflow_run",
              "status": "success",
              "revision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "childIssue": 161
            }
          ]
        }
      ]
    },
    {
      "index": 2,
      "text": "A second exact criterion.",
      "outcomes": [
        {
          "description": "The required cross-child rehearsal.",
          "status": "not_yet_validated",
          "kind": "integration",
          "childIssues": [161, 163],
          "evidence": [
            {
              "url": "https://github.com/grasdouble/Jarvis/actions/runs/222",
              "label": "The required fixture run failed at the second release step.",
              "sourceType": "workflow_run",
              "status": "failure",
              "revision": "0123456789abcdef0123456789abcdef01234567"
            }
          ],
          "rationale": "The fixture does not yet demonstrate the second release step."
        }
      ]
    }
  ]
}
```

- `parentIssue` must match the command's issue number. Each `index` is the one-based position in the current parent checklist; `text` must match exactly. Provide an outcome breakdown for every criterion and account for every direct native child in at least one outcome. Missing outcomes, omitted children, mismatched text, incomplete inventory, unknown child IDs, malformed links, or ambiguous Markdown fail closed. Existing checkbox states are parsed only as Markdown structure and are never changed or treated as acceptance evidence.
- Outcome `status` is `validated`, `not_yet_validated`, or `unable_to_assess`; the latter two require a concise `rationale`. A criterion is `validated` only when every listed outcome is validated and supported. A claimed validation without evidence is downgraded; an open/abandoned cited child or an integration outcome with fewer than two native children remains unvalidated.
- `kind` is `child` (exactly one direct native child) or `integration` (multiple direct native children and explicit integrated evidence); there is no parent-only `direct` outcome. Every direct native child must be mapped by at least one criterion outcome, including outcomes that are not yet validated. `childIssues` may cite only direct native children. Every evidence source is a direct HTTPS link under `github.com/grasdouble/Jarvis/`, with no query string, and has `sourceType` (`pull_request`, `workflow_run`, `check_run`, `commit`, `release`, `issue_comment`, or `other`) and the observed `status`; PR/run/check/commit sources require a full 40-character `revision`, and PR sources also require the exact `reviewedRevision`. For a PR, `revision` is its merge commit and `reviewedRevision` its reviewed head; for a run/check, `revision` is its head SHA. A commit/check URL must match its `revision`. For `child` and `integration` outcomes, each cited PR needs a `childIssue` mapping to an outcome child, every mapped child needs merged PR evidence, and a successful `workflow_run` or `check_run` for each PR must match its `reviewedRevision` and child. A PR number may be mapped to only one native child across the entire assessment (reusing the same child PR across criteria is valid); the caller must directly inspect and confirm that the PR actually delivers the declared child, because the helper does not fetch PR/issue relationships. An `integration` outcome additionally needs a successful integrated `workflow_run` without `childIssue`; this is the explicit cross-child/fixture result, distinct from per-PR checks. Parent-level fixture/release evidence can supplement a mapped child/integration outcome but cannot replace its child delivery PRs and checks. Only `merged`, `success`, `present`, `published`, `available`, and `verified` respectively are positive evidence states. The caller still has to inspect the source and confirm that the status/revision and evidence actually support the outcome; the helper checks their shape, not their truth.
- For an owner-authorized scope change, retain the exact authorized criterion wording in `text` and add `scopeEvolution`:

  ```json
  {
    "previousText": "The previous exact criterion wording.",
    "authorizationUrl": "https://github.com/grasdouble/Jarvis/issues/34#issuecomment-9001",
    "rationale": "The owner explicitly approved the replacement."
  }
  ```

  The current parent text must match either `previousText` or the authorized replacement `text`. If it still has the previous wording, the owner must make the separately authorized parent-body edit before recording; then reread the aligned parent and submit a fresh assessment. The recorder never changes criterion wording or checkboxes. The caller—not the script—must confirm the source is an actual owner authorization. Never silently change a criterion to fit an implementation.

## Invocation and trust boundary

```bash
node /trusted/checkout/.agents/skills/jarvis-project-management/scripts/github/coordination-parent-acceptance.mjs 160 /path/to/assessment.json
node /trusted/checkout/.agents/skills/jarvis-project-management/scripts/github/coordination-parent-acceptance.mjs 160 /path/to/assessment.json --write
```

Default mode reads the parent, complete native-child inventory, and paginated parent comments, then prints per-criterion outcomes, rationales, evidence links, child-comment actions, and whether a final assessment could be posted; it does not mutate GitHub. `--write` is permitted only after explicit user authorization to append acceptance comments. It posts an idempotent delivery-evidence comment for each completed child with a merged PR and successful checks matching every cited reviewed head. If any native child is open, it stops before final assessment. Once all children are closed as completed and have delivery comments, it posts a structured final assessment comment only when every exact current parent criterion is validated, including required integration evidence. Otherwise it reports gaps and posts no final assessment. The recorder never PATCHes the parent body, edits checkboxes, or closes the issue. Run one writer at a time; after an uncertain write, reread the complete comment inventory before retrying. The caller must inspect and substantiate every cited PR, check, fixture, release, or live-service result; the helper validates structure and provenance markers, not semantic truth. A status/readiness check does not authorize `--write`. Keep assessment files in an approved temporary directory and do not include secrets or sensitive details in labels/comments.

The recorder verifies issue identity, complete direct-child outcome coverage, child membership/state, exact criterion text, evidence URL/type/status/revision shape, one-child-per-PR mapping uniqueness, child-to-PR/current-head-check mappings, and integrated-run evidence for composite outcomes. It checks that comments are authored by the configured development App and that the final report's exact criterion text and child evidence match current issue data and the delivery comments. It does **not** retrieve cited PRs, runs, releases, or comments to verify their actual conclusions, confirm a PR's relationship to a child, or prove semantic sufficiency. Those checks remain the caller's responsibility and must be reported with exact links/revisions. A script result, checked box, completed child, or `eligible_to_close` structural result is not approval or closure authorization. App comments are append-only: duplicate/conflicting markers fail closed and must be reconciled without deleting or rewriting prior comments.
