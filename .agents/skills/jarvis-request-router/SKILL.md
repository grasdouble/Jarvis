---
name: jarvis-request-router
description: Apply the canonical tag-based routing convention to new JARVIS contributor-session requests and select the appropriate downstream specialist without granting permissions.
---

# JARVIS request router

Use this lightweight contributor-session router when handling JARVIS requests. The canonical registry and full contract are in [jarvis-request-routing.md](../../../docs/jarvis-request-routing.md). Read the registry from that source; do not maintain a second copy.

## Decide before routing

1. Identify whether this is a new JARVIS-related request or a clearly linked follow-up to an already routed request. A linked follow-up retains the previous tag; a new request needs its own tag.
2. If a new request has no canonical tag, do not infer one from its content. Ask which tag applies, show the registry with brief descriptions, and wait without starting a workflow. The sole exception is a request whose only intent is to list the tags: load `jarvis-tags` and return only that registry. Clarify a combined tag-list and other task request before acting.
3. If a supplied tag is missing, mismatched, or still leaves material ambiguity, ask a concise clarification before loading the downstream workflow.
4. Treat tags as intent, never as permission. Apply the user's actual authorization and trusted repository/GitHub policies independently.

## Dispatch one appropriate downstream skill

| Tag | Downstream route |
| --- | --- |
| `@jarvis-info` | `jarvis-project-info`, repository explanation mode; read-only. |
| `@jarvis-status` | `jarvis-project-info`, current GitHub status mode; read-only and disclose inaccessible/stale/incomplete sources. |
| `@jarvis-plan` | `jarvis-project-governance` with an explicit no-edits/no-GitHub-mutations constraint; return options and recommendation only. |
| `@jarvis-delivery` | `jarvis-issue-delivery`; follow full issue intake and delivery gates. |
| `@jarvis-review` | If part of a current delivery, `jarvis-issue-delivery` coordinates it. Otherwise start a fresh independent `jarvis-pr-review` context with scope, criteria, and exact base/head. Never create a delivery issue just to review. |
| `@jarvis-backlog` | `jarvis-project-management`; perform only the requested authorized project-management work, not implementation by implication. |
| `@jarvis-tags` | `jarvis-tags` only; return the canonical list, with no repository inspection or workflow. |

## Review boundary

The reviewer must not have authored any part of the candidate. The reviewer receives exact revisions and the authorized scope, does not modify the candidate or delivery branch, and does not publish GitHub state or merge. If the current session participated in the change, delegate autonomous review to a fresh independent reviewer; if none is available, report a limited review rather than claiming independence. Delivery-linked review remains coordinated through issue delivery, with corrections owned by the delivery coordinator/author and a fresh review after each changed revision.

## OpenCode capability boundary

This skill is an instruction procedure, not a request hook or policy engine. OpenCode may discover it as a skill and a model/user may load it, but a normal session is not technically forced to invoke it. The custom `@jarvis-*` tags are not native OpenCode dispatch syntax; follow the root `AGENTS.md` entry point in ordinary repository sessions and be honest about unavailable/ignored instructions. Contributor-session agents/tools are distinct from the JARVIS product runtime. The product OpenCode profiles documented in [technical architecture §10.2](../../../docs/technical-architecture.md#102-controlled-configuration-and-permissions) disable task/subagent tools; do not claim the product can start one spontaneously. J06 is separately gated and uses its planned attempt/session model.
