# JARVIS request routing for contributor sessions

This document is the canonical source for contributor-session request tags and their routing contract. It describes an instruction-following convention for humans and agents working on this repository; it is not an authorization system, runtime feature, or technically enforced interception layer.

## Canonical tags

| Tag | Intent |
| --- | --- |
| `@jarvis-info` | Questions about JARVIS, its code, or its documentation. |
| `@jarvis-status` | Current status of issues, pull requests, milestones, or the project board. |
| `@jarvis-plan` | Study a potential evolution and propose an approach without modifying the repository. |
| `@jarvis-delivery` | Request a repository change through the contributor delivery workflow. |
| `@jarvis-review` | Request a review of a change. |
| `@jarvis-backlog` | Consult or manage issues and the project within the authorization given. |
| `@jarvis-tags` | Display the available canonical tags. |

For skill-aware clients, the text after `@` is the corresponding skill ID. This is an explicit entry-point naming convention, not a universal invocation syntax.

Tags express intent only. They do not grant permissions, expand the user's request, or override repository, GitHub, review, or approval policy.

## Routing contract

- For every new JARVIS-related contributor-session request without a canonical tag, do not infer the workflow from its wording. Ask which tag applies, return this canonical registry with brief descriptions, and wait before taking action.
- Exception: when the request's sole intent is to list or explain the available tags, answer directly through `jarvis-tags`; no other workflow is started. If a tag-list request is combined with another task, clarify which intent to handle before acting.
- If a supplied tag does not clearly match the request, or the request remains materially ambiguous, ask for clarification before loading or acting on a workflow.
- A follow-up that is clearly part of an already routed request retains that tag. A distinct new request needs its own route.
- `@jarvis-info` is the direct entry point to the read-only [`jarvis-info`](../.agents/skills/jarvis-info/SKILL.md) skill. It explains repository code and docs, citing sources and separating documented intent from implemented/evidenced behavior.
- `@jarvis-status` is the direct entry point to the separate read-only [`jarvis-status`](../.agents/skills/jarvis-status/SKILL.md) skill. It checks current relevant GitHub data and states access, pagination, and freshness limitations.
- `@jarvis-plan` is the direct entry point to [`jarvis-plan`](../.agents/skills/jarvis-plan/SKILL.md), which assesses requirements, decisions, risks, and options without editing files, creating an issue/branch/PR, or mutating GitHub solely to plan.
- `@jarvis-delivery` is the direct entry point to [`jarvis-delivery`](../.agents/skills/jarvis-delivery/SKILL.md), including duplicate-aware intake, issue sizing, dedicated branch/worktree, implementation, verification, independent review, and PR handoff under all current gates.
- `@jarvis-review` is the direct entry point to [`jarvis-review`](../.agents/skills/jarvis-review/SKILL.md). A review linked to an active delivery remains coordinated by `jarvis-delivery`; an autonomous review uses a fresh independent reviewer context without creating an artificial delivery issue. The reviewer receives the authorized scope, criteria, and exact base/head revisions; it does not modify delivery source, publish, or merge. A session that authored any part of the change cannot review it independently. If a suitable independent reviewer is unavailable, report the review as limited, not independent.
- `@jarvis-backlog` is the direct entry point to [`jarvis-backlog`](../.agents/skills/jarvis-backlog/SKILL.md). Backlog consultation/maintenance remains project management and does not imply implementation.
- `@jarvis-tags` routes only to [`jarvis-tags`](../.agents/skills/jarvis-tags/SKILL.md), which returns this registry and starts no other workflow.

## Orchestration and delegation

### Coordinator and specialist subagents {#orchestration-and-delegation}

For every tagged contributor-session request, the primary session remains the coordinator: it invokes the matching specialist skill, owns the end-to-end request, integrates evidence, and answers the user. For substantive work, it delegates bounded specialist analysis/work to an appropriately qualified subagent when suitable capacity is available. Give each subagent only the minimum sanitized context needed for its assignment; provide no credentials and no extra tools or permissions. Delegation is within the selected workflow, not launching a second copy of that workflow, and does not relax its scope, read-only, write, review, or approval gates.

Credentialed GitHub reads, all GitHub writes, commits, and publication are performed and owned by the primary coordinator under the selected skill and actual authorization. The coordinator may delegate analysis of sanitized data returned from credentialed reads, but must not pass credentials or authenticated access to a subagent. Status and backlog delegation is therefore limited to bounded analysis of sanitized returned data (or other non-credentialed context); it grants no authenticated access or mutation authority. The same minimum-context and no-extra-permissions rule applies to every specialist.

Do not spawn a worker for `@jarvis-tags`' exact registry-only response or a clarification-only turn. If suitable worker capacity or tooling is unavailable, report that limitation explicitly; direct handling without a worker cannot be called delegated. The primary session may proceed only as allowed by the selected skill and user authorization.

This convention applies to contributor sessions only. It is not technically enforced, does not grant permissions, and does not add delegation capability or behavior to the JARVIS product runtime.

Information, status, planning, and read-only audit requests do not start issue delivery. A repository change does, even if it is a small documentation or skill edit. A review report is not a GitHub approval or merge authorization.

## Skill entry points and enforcement limits

The root [`AGENTS.md`](../AGENTS.md) provides the instruction entry point for repository contributor sessions and points to this contract. Each canonical tag now has a same-named skill ID and procedure under `.agents/skills/<id>/SKILL.md`; this makes the intended entry point directly addressable in skill-aware clients. OpenCode v2 discovers `.agents/skills` and supports explicit `@skill-id` invocation, so these aligned IDs can be invoked there. This is not a general tag-dispatch protocol shared by every client: another environment must support loading skills by ID and its own invocation syntax. OpenCode also discovers project `AGENTS.md` instructions, but those instructions do not force invocation. The contributor environment used for this delivery also provided subagent tooling; that availability is session/profile-dependent and is not part of tag routing.

Inspection of the contributor environment for this change found OpenCode v2.0.32 and this repository's `AGENTS.md` and `.agents/skills` directory. No project `.opencode` configuration/agent definitions were found; a user-level plugin was present but its inspected hooks reported session lifecycle rather than request intent. System/MDM-managed configuration was not inspected. Matching tag and skill IDs improve discoverability and make direct invocation possible in compatible clients, but no mechanism here technically requires a tag on every request or prevents a user/session from directly invoking another available skill. Other clients, sessions outside the repository, disabled/unavailable skill discovery, additional user/system configuration, and model non-compliance remain outside this guidance's guarantee.

## Contributor sessions are not the JARVIS product runtime

These skills, session tools, and routing instructions belong to contributor workflows. They are not installed into JARVIS product sessions. The documented product OpenCode plan/development profiles intentionally disable task/subagent tools, repository skill loading, and commands; do not claim the product model can spontaneously launch a subagent. Product J06 autonomous delivery is a separately specified and gated capability (JV-044–JV-048) using its planned bounded attempts/sessions, not this contributor-session delegation facility. No product runtime behavior, tool permission, or automatic request route is added by this document.

## Keep the registry synchronized

This file alone defines the tag spellings and descriptions. `AGENTS.md` and `jarvis-request-router` reference this section rather than copying the registry. `jarvis-tags` must return only this section's registry and brief descriptions, without maintaining another copy. When changing tags or routing, update this source first, then review the route table/instructions and the `jarvis-tags` contract together; validate all local links and skill references. A copied list in another file is a derived rendering, never an independent source of truth.
