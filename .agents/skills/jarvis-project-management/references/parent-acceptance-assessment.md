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

- `parentIssue` must match the command's issue number. Each `index` is the one-based position in the current parent checklist; `text` must match exactly. Provide an outcome breakdown for every criterion. Missing outcomes, mismatched text, incomplete inventory, unknown child IDs, malformed links, or ambiguous Markdown fail closed or leave the affected item unchecked.
- Outcome `status` is `validated`, `not_yet_validated`, or `unable_to_assess`; the latter two require a concise `rationale`. A criterion is `validated` only when every listed outcome is validated and supported. A claimed validation without evidence is downgraded; an open/abandoned cited child or an integration outcome with fewer than two native children remains unvalidated.
- `kind` is `child` (exactly one direct native child), `integration` (multiple direct native children and explicit integrated evidence), or `direct` (parent-level evidence with no child mapping). `childIssues` may cite only direct native children. Every evidence source is a direct HTTPS link under `github.com/grasdouble/Jarvis/`, with no query string, and has `sourceType` (`pull_request`, `workflow_run`, `check_run`, `commit`, `release`, `issue_comment`, or `other`) and the observed `status`; PR/run/check/commit sources require a full 40-character `revision`, and PR sources also require the exact `reviewedRevision`. For a PR, `revision` is its merge commit and `reviewedRevision` its reviewed head; for a run/check, `revision` is its head SHA. A commit/check URL must match its `revision`. For `child` and `integration` outcomes, each cited PR needs a `childIssue` mapping to an outcome child, every mapped child needs merged PR evidence, and a successful `workflow_run` or `check_run` for each PR must match its `reviewedRevision` and child. An `integration` outcome additionally needs a successful integrated `workflow_run` without `childIssue`; this is the explicit cross-child/fixture result, distinct from per-PR checks. Only `merged`, `success`, `present`, `published`, `available`, and `verified` respectively are positive evidence states. The caller still has to inspect the source and confirm that the status/revision and evidence actually support the outcome; the helper checks their shape, not their truth.
- For an owner-authorized scope change, retain the exact authorized criterion wording in `text` and add `scopeEvolution`:

  ```json
  {
    "previousText": "The previous exact criterion wording.",
    "authorizationUrl": "https://github.com/grasdouble/Jarvis/issues/34#issuecomment-9001",
    "rationale": "The owner explicitly approved the replacement."
  }
  ```

  The current parent text must match either `previousText` or the authorized replacement `text`. If it still has the previous wording, the first authorized recording pass reconciles the text but deliberately leaves the checkbox unchecked. Reread the aligned parent and submit a fresh assessment before validating/checking it. The script records the source/rationale. The caller—not the script—must confirm the source is an actual owner authorization. Never silently change a criterion to fit an implementation.

## Invocation and trust boundary

```bash
node /trusted/checkout/.agents/skills/jarvis-project-management/scripts/github/coordination-parent-acceptance.mjs 160 /path/to/assessment.json
node /trusted/checkout/.agents/skills/jarvis-project-management/scripts/github/coordination-parent-acceptance.mjs 160 /path/to/assessment.json --write
```

Default mode reads the current parent and fully paginated direct children, then prints the supplied per-criterion outcomes, rationales, and evidence links without mutation. `--write` is permitted only after an explicit user request to record/validate parent acceptance. It updates the issue body only, verifies exact readback, and never closes the issue or changes labels/project status. A plain status/readiness check does not authorize `--write`. If the write response/readback is uncertain, reread GitHub state before retrying. Keep input files in an approved temporary directory and do not include secrets in assessments or evidence labels.

The helper verifies issue identity, direct-child membership/state, exact criterion text, evidence URL/type/status/revision shape, child-to-PR/current-head-check mappings, and the presence of integrated-run evidence for composite outcomes. It does **not** retrieve cited PRs, runs, releases, or comments, verify their provenance/conclusion, or prove semantic sufficiency. Those checks remain the caller's responsibility and must be reported with exact links/revisions. A script result, checked box, completed child, or `eligible_to_close` structural result is not approval or closure authorization.
