# Actual dates in the Roadmap

The [Roadmap](https://github.com/orgs/grasdouble/projects/1/views/3) displays observed realization through two reserved DATE fields: **Actual start** and **Actual completion**. The existing **Start date** and **Target date** fields remain available for agreed future planning and are not modified. No milestone deadline or product duration forecast is inferred.

## Meaning and evidence

- Actual start is the first recorded **In Progress** transition for the issue in this exact project. Other projects' history and transitions after the current closure are ignored. Issue/PR creation, first commit, assignment and item creation are not substitutes. Missing evidence remains an empty start.
- Actual completion requires the issue to be currently **CLOSED / COMPLETED** and **Done** in this project. The last native closure must match `closedAt` within five seconds (GitHub can timestamp its timeline event one second later). A closing PR must be merged; its `mergedAt` supplies the completion. A native manual/commit closure uses `closedAt`. Unmerged closing PRs, missing closure evidence or a start after completion report an error without changing either date for that issue.
- Reopening or abandoning an issue clears its derived completion. Its first observed start is retained when present. These fields describe recorded elapsed calendar spans, including waiting, blocking and review; they do not measure active coding time, prove acceptance or grant approval.
- Dates use **Europe/Paris**, including daylight-saving changes. GitHub DATE fields have day precision, not hours/minutes. The immutable source timestamps remain in GitHub's timeline. A task crossing midnight UTC may still fall on one Paris calendar day, or the reverse.

These are reserved derived fields: reconciliation restores values from complete native history, including clearing unsupported old values. Do not manually add guessed historical starts. Unknown-start completions can be displayed as an endpoint without a fabricated duration. The tool never writes planned date fields, Status, issue/PR state, milestone, labels, links, reviews, permissions or source. Native statuses remain governed by the existing delivery workflow; merely setting a date cannot close an issue.

## Contributor commands

Use a reviewed checkout and the existing [development App](development-github-app.md), with Node.js 24+ and GitHub CLI. The shared command's ordinary PR-metadata mode is unchanged; `--roadmap` selects this separate date-only mutation contract.

```bash
# Preview the historical project inventory without effects.
node scripts/github/sync-pr-project-metadata.mjs --roadmap
# Authorized project maintenance/backfill, followed by readback.
node scripts/github/sync-pr-project-metadata.mjs --roadmap --write
# Selected-issue maintenance; replace 93 with the actual issue.
node scripts/github/sync-pr-project-metadata.mjs --roadmap --issue 93
node scripts/github/sync-pr-project-metadata.mjs --roadmap --issue 93 --write
```

`--issue` restricts effects to one existing Jarvis issue member; initial membership discovery reads the project inventory. It never adds missing membership. `--pr` cannot be combined with roadmap mode. Before starting, reviewing or confirming delivery, skills preview and synchronize the selected issue after its native state/status change. Recheck the JSON diagnostics and saved dates; idempotent reruns produce zero writes. Missing source/history is not an invitation to invent one.

Scope is fixed to Jarvis, Project 1 and the recorded identities/names/types of the two DATE fields. A renamed/recreated/wrong-type field stops the run. Item inventories are paginated in batches of twenty; issue event histories follow every cursor. Connections stop explicitly at 100 pages or 10,000 nodes, and incomplete field inventory stops before mutation. Duplicate memberships, malformed native events and invalid dates fail closed. PR/draft items and other repositories remain untouched.

Every planned issue reloads source and destinations before writing and after any response, including failures. A native state/status/history/identity change stops stale writes. At most two date-field mutations for one issue share a request; partial/uncertain responses are reread, and only still-missing changes can be retried. Known transient transport failures get at most three failed attempts with short delays, within eight mutation attempts per issue. Permanent errors, unreadable recovery and exhausted limits stop. A final reread must show no pending changes before success. Reported semantic errors yield a nonzero command exit; independent valid issues can still synchronize.

This is optimistic reconciliation, not a GitHub transaction or a lock against manual writers. Partial confirmed changes can remain. After failure inspect current evidence and preview again before another authorized write. Avoid concurrent local backfills; the workflow concurrency group only serializes its own runs. Pagination is complete at read time but cannot provide an atomic history snapshot during concurrent edits.

## Automatic maintenance and UI configuration

The existing [PR project metadata workflow](../.github/workflows/pr-project-metadata.yml) also reconciles Roadmap dates, with the same protected-main checkout, App identity, explicit token scope and opt-in gate. The date step can run after a PR-metadata diagnostic failure, but only if token creation and installation identity verification succeeded. It receives no extra permissions and runs no candidate code. Native project-only status changes do not directly trigger a repository Actions event; contributor skills update immediately, and hourly/manual catch-up covers external board edits. Scheduling is eventual, not a strict deadline.

The [CI environment/key activation prerequisites](pr-project-metadata.md#workflow-and-credential-activation) remain unchanged. Merging this code does not provision a key or enable unattended CI. Until that activation is qualified, the reviewed command and skill hooks provide session-driven updates; no background synchronization is claimed.

Roadmap Date fields must map Start date → **Actual start**, Target date → **Actual completion**, saved for the shared view. This is a view setting, not an instruction to fill the planned fields. Keep `is:issue`, milestone grouping, other views and their columns unchanged. Show a suitable week/month range and expand the completed milestone group to inspect short spans; the chart does not create planned dates for unstarted backlog work. Preserve native event evidence rather than dragging actual bars to guessed dates.

## Verification and source documentation

The initial authorized backfill records its observed issue counts, source/date plan, verified mutations and zero-write repetition outside tracked source. Unit/integration evidence covers timezone/DST, native initial empty-status transitions, reopening/abandonment, source drift, partial effects, pagination, scope and credential boundaries. UI readback and live credential qualification are separate evidence; synthetic tests cannot establish them.

GitHub documentation checked 2026-10-17: [roadmap custom date fields](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-roadmap-layout), [project status timeline events](https://docs.github.com/en/graphql/reference/projects#projectv2itemstatuschangedevent), [issue timeline API](https://docs.github.com/en/graphql/reference/issues), and [Projects field mutations](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects).
