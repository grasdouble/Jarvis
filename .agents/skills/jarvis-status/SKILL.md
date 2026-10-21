---
name: jarvis-status
description: Provide a read-only snapshot of current JARVIS GitHub issue, pull request, milestone, or project status for @jarvis-status requests. Disclose access, freshness, and pagination limits.
---

# JARVIS project status

This is an explicit read-only entry point for `@jarvis-status` requests about current issues, pull requests, milestones, or project-board state. Follow the canonical [request-routing and tag contract](../../../docs/jarvis-request-routing.md). Routing is an instruction convention, not technical interception or authorization. This contributor-session skill is not part of the JARVIS product runtime.

Follow the shared [orchestration and delegation policy](../../../docs/jarvis-request-routing.md#orchestration-and-delegation): delegate substantive current-status data collection to a suitable bounded specialist subagent by default when available. If none is available, report that limitation and continue directly only where this skill and the user's authorization allow; do not claim delegated execution. Delegation does not launch another workflow or expand GitHub mutation authority.

Consult current GitHub sources relevant to the request; repository text and cached knowledge are not substitutes for current state. Use the approved development GitHub App helper when available:

```text
node .agents/skills/jarvis-backlog/scripts/github/gh-app.mjs -- <read-only gh arguments>
```

Use read-only queries only. Follow the trusted [network recovery procedure](../../../docs/development-github-app.md#network-access-and-recovery). Do not switch identities, broaden access, use write flags, or fall back to an unapproved credential route. If the helper is unavailable or access fails, say so and identify the sources that could not be checked. Report source links and observation time/context when available. Disclose stale, incomplete, or inaccessible data, including organization Projects, and do not claim a complete inventory without checking pagination and completeness.

Do not edit repository files or mutate issues, pull requests, milestones, project fields, comments, labels, or other GitHub state. This skill grants no backlog administration, implementation, publication, approval, or merge authority. If the request changes from status to action, stop and route the new request through its applicable contributor procedure.
