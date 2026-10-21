---
name: jarvis-request-router
description: Resolve missing, mismatched, or ambiguous JARVIS contributor-request tags and explain the canonical tag-to-skill entry points without granting permissions.
---

# JARVIS request router

Use this lightweight fallback when a contributor-session request lacks a tag, has a mismatched tag, or remains ambiguous. For a supplied matching tag, invoke the skill with the aligned ID directly instead of routing through this meta-skill. The canonical registry and full contract are in [jarvis-request-routing.md](../../../docs/jarvis-request-routing.md). Read the registry from that source; do not maintain a second copy.

## Decide before routing

1. Identify whether this is a new JARVIS-related request or a clearly linked follow-up to an already routed request. A linked follow-up retains the previous tag; a new request needs its own tag.
2. If a new request has no canonical tag, do not infer one from its content. Ask which tag applies, show the registry with brief descriptions, and wait without starting a workflow. The sole exception is a request whose only intent is to list the tags: load `jarvis-tags` and return only that registry. Clarify a combined tag-list and other task request before acting.
3. If a supplied tag is missing, mismatched, or still leaves material ambiguity, ask a concise clarification before loading the downstream workflow.
4. Treat tags as intent, never as permission. Apply the user's actual authorization and trusted repository/GitHub policies independently.

## Dispatch one appropriate downstream skill

| Tag | Downstream route |
| --- | --- |
| `@jarvis-info` | Directly invoke `jarvis-info`; repository explanation, read-only. |
| `@jarvis-status` | Directly invoke `jarvis-status`; current GitHub status, read-only, disclose inaccessible/stale/incomplete sources. |
| `@jarvis-plan` | Directly invoke `jarvis-plan`; read-only governance assessment and options. |
| `@jarvis-delivery` | Directly invoke `jarvis-delivery`; follow full issue intake and delivery gates. |
| `@jarvis-review` | Directly invoke `jarvis-review`. If part of a current delivery, `jarvis-delivery` coordinates it; otherwise use a fresh independent reviewer context. Never create a delivery issue just to review. |
| `@jarvis-backlog` | Directly invoke `jarvis-backlog`; perform only the requested authorized project-management work, not implementation by implication. |
| `@jarvis-tags` | `jarvis-tags` only; return the canonical list, with no repository inspection or workflow. |

## Review boundary

The reviewer must not have authored any part of the candidate. The reviewer receives exact revisions and the authorized scope, does not modify the candidate or delivery branch, and does not publish GitHub state or merge. If the current session participated in the change, delegate autonomous review to a fresh independent reviewer; if none is available, report a limited review rather than claiming independence. Delivery-linked review remains coordinated through issue delivery, with corrections owned by the delivery coordinator/author and a fresh review after each changed revision.

## OpenCode capability boundary

This skill is a fallback instruction procedure for missing, mismatched, or ambiguous tags, not a request hook or policy engine. The canonical tag-aligned skills are the direct entry points when the user invokes them through a compatible skill-aware client. OpenCode v2 supports skill invocation by ID; other clients may use different syntax or not support it. Neither aligned IDs nor this router require every message to start with a tag or prevent direct invocation of other available skills. Contributor-session agents/tools are distinct from the JARVIS product runtime. The product OpenCode profiles documented in [technical architecture §10.2](../../../docs/technical-architecture.md#102-controlled-configuration-and-permissions) disable task/subagent tools; do not claim the product can start one spontaneously. J06 is separately gated and uses its planned attempt/session model.
