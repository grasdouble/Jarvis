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

Tags express intent only. They do not grant permissions, expand the user's request, or override repository, GitHub, review, or approval policy.

## Routing contract

- For every new JARVIS-related contributor-session request without a canonical tag, do not infer the workflow from its wording. Ask which tag applies, return this canonical registry with brief descriptions, and wait before taking action.
- Exception: when the request's sole intent is to list or explain the available tags, answer directly through `jarvis-tags`; no other workflow is started. If a tag-list request is combined with another task, clarify which intent to handle before acting.
- If a supplied tag does not clearly match the request, or the request remains materially ambiguous, ask for clarification before loading or acting on a workflow.
- A follow-up that is clearly part of an already routed request retains that tag. A distinct new request needs its own route.
- `@jarvis-info` and `@jarvis-status` route to the read-only [`jarvis-project-info`](../.agents/skills/jarvis-project-info/SKILL.md) skill. Information answers may inspect repository code/docs and explain observed behavior. Status answers check current relevant GitHub data and state access, pagination, and freshness limitations.
- `@jarvis-plan` routes to read-only use of [`jarvis-project-governance`](../.agents/skills/jarvis-project-governance/SKILL.md) and relevant specification documents. It may assess requirements, decisions, risks, and options, but does not edit files, create an issue/branch/PR, or mutate GitHub solely to plan.
- `@jarvis-delivery` routes to [`jarvis-issue-delivery`](../.agents/skills/jarvis-issue-delivery/SKILL.md), including duplicate-aware intake, issue sizing, dedicated branch/worktree, implementation, verification, independent review, and PR handoff under all current gates.
- `@jarvis-review` uses the delivery coordinator only when reviewing or correcting a change in an active delivery. An autonomous review goes through the router to [`jarvis-pr-review`](../.agents/skills/jarvis-pr-review/SKILL.md) in a fresh independent reviewer context, without creating an artificial delivery issue. The reviewer receives the authorized scope, criteria, and exact base/head revisions; it does not modify delivery source, publish, or merge. A session that authored any part of the change cannot review it independently. If a suitable independent reviewer is unavailable, report the review as limited, not independent.
- `@jarvis-backlog` routes to [`jarvis-project-management`](../.agents/skills/jarvis-project-management/SKILL.md). Backlog consultation/maintenance remains project management and does not imply implementation.
- `@jarvis-tags` routes only to [`jarvis-tags`](../.agents/skills/jarvis-tags/SKILL.md), which returns this registry and starts no other workflow.

Information, status, planning, and read-only audit requests do not start issue delivery. A repository change does, even if it is a small documentation or skill edit. A review report is not a GitHub approval or merge authorization.

## OpenCode entry point and enforcement limits

The intended entry point for ordinary OpenCode sessions working in this repository is the root [`AGENTS.md`](../AGENTS.md), which points to this contract. In OpenCode v2, project `AGENTS.md` files are discovered as instructions, while `.agents/skills/<id>/SKILL.md` is a compatible skill source; skills are advertised by description and loaded when the model selects/calls the skill tool or the user mentions `@skill-id`. OpenCode can also create child sessions through its subagent tool when the current agent's tool permissions allow it; this contributor environment provided that facility for this delivery. Tool availability is session/profile-dependent and does not automatically route requests. The `@jarvis-*` request tags in this document are **not** native OpenCode routing directives. Of the canonical tags, only `@jarvis-tags` is itself a skill ID. `jarvis-project-info` and `jarvis-request-router` are downstream skill IDs, not canonical tags. The route from other tags to their skills is instruction content for the model to follow.

Inspection of the contributor environment for this change found OpenCode v2.0.32, this repository's `AGENTS.md` and `.agents/skills` directory, no project `.opencode` configuration/agent definitions, and no user-level `opencode.json(c)`, agent/skill directories, or `AGENTS.md` under `~/.config/opencode`. A user-level plugin was present; inspection of its hooks showed session-lifecycle reporting, not message-intent routing. System/MDM-managed configuration was not inspected. Therefore this repository can provide an automatically discovered instruction entry point in normal OpenCode project sessions, but no project mechanism was found that technically intercepts every new request or forces the model to obey the tag rule. Other clients, sessions outside the repository, disabled project configuration, additional user/system configuration, unavailable skills, and model non-compliance are outside this guidance's guarantee. A session can also explicitly load a downstream skill; instructions still require the route contract to be followed.

## Contributor sessions are not the JARVIS product runtime

These skills, session tools, and routing instructions belong to contributor workflows. They are not installed into JARVIS product sessions. The documented product OpenCode plan/development profiles intentionally disable task/subagent tools, repository skill loading, and commands; do not claim the product model can spontaneously launch a subagent. Product J06 autonomous delivery is a separately specified and gated capability (JV-044–JV-048) using its planned bounded attempts/sessions, not this contributor-session delegation facility. No product runtime behavior, tool permission, or automatic request route is added by this document.

## Keep the registry synchronized

This file alone defines the tag spellings and descriptions. `AGENTS.md` and `jarvis-request-router` reference this section rather than copying the registry. `jarvis-tags` must return only this section's registry and brief descriptions, without maintaining another copy. When changing tags or routing, update this source first, then review the route table/instructions and the `jarvis-tags` contract together; validate all local links and skill references. A copied list in another file is a derived rendering, never an independent source of truth.
