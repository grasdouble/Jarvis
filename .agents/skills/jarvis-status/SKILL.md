---
name: jarvis-status
description: Provide a read-only snapshot of current JARVIS GitHub issue, pull request, milestone, or project status for @jarvis-status requests. Disclose access, freshness, and pagination limits.
---

# JARVIS project status

This is an explicit read-only entry point for `@jarvis-status` requests about current issues, pull requests, milestones, or project-board state. Follow the canonical [request-routing and tag contract](../../../docs/jarvis-request-routing.md). Routing is an instruction convention, not technical interception or authorization. This contributor-session skill is not part of the JARVIS product runtime.

Consult current GitHub sources relevant to the request; repository text and cached knowledge are not substitutes for current state. Use the approved development GitHub App helper when available:

```text
node .agents/skills/jarvis-backlog/scripts/github/gh-app.mjs -- <read-only gh arguments>
```

Use read-only queries only. Follow the trusted [network recovery procedure](../../../docs/development-github-app.md#network-access-and-recovery). Do not switch identities, broaden access, use write flags, or fall back to an unapproved credential route. If the helper is unavailable or access fails, say so and identify the sources that could not be checked. Report source links and observation time/context when available. Disclose stale, incomplete, or inaccessible data, including organization Projects, and do not claim a complete inventory without checking pagination and completeness.

Do not edit repository files or mutate issues, pull requests, milestones, project fields, comments, labels, or other GitHub state. Do not launch another skill or workflow to answer. This skill grants no backlog administration, implementation, publication, approval, or merge authority. If the request changes from status to action, stop and route the new request through its applicable contributor procedure.
