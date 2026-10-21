---
name: jarvis-request-router
description: Resolve missing, mismatched, or ambiguous JARVIS contributor-request tags and explain the canonical tag-to-skill entry points without granting permissions.
---

# JARVIS request router

Use this lightweight fallback when a contributor-session request lacks a tag, has a mismatched tag, or remains ambiguous. For a supplied matching tag, invoke the skill with the aligned ID directly instead of routing through this meta-skill. The canonical registry and full contract are in [jarvis-request-routing.md](../../../docs/jarvis-request-routing.md). Read the registry from that source; do not maintain a second copy. Follow its [coordinator and specialist delegation contract](../../../docs/jarvis-request-routing.md#orchestration-and-delegation) for tagged requests.

## Decide before routing

1. Identify whether this is a new JARVIS-related request or a clearly linked follow-up to an already routed request. A linked follow-up retains the previous tag; a new request needs its own tag.
2. If a new request has no canonical tag, do not infer one from its content. Ask which tag applies, show the registry with brief descriptions, and wait without starting a workflow. The sole exception is a request whose only intent is to list the tags: load `jarvis-tags` and return only that registry. Clarify a combined tag-list and other task request before acting.
3. If a supplied tag is missing, mismatched, or still leaves material ambiguity, ask a concise clarification before loading the downstream workflow.
4. Treat tags as intent, never as permission. Apply the user's actual authorization and trusted repository/GitHub policies independently.

## Dispatch one appropriate downstream skill

| Tag | Main-session coordinator and specialist subagent |
| --- | --- |
| `@jarvis-info` | Main session coordinates `jarvis-info`; delegate substantive repository explanation to a bounded info specialist. |
| `@jarvis-status` | Main session coordinates `jarvis-status` and obtains any authorized credentialed GitHub data; delegate bounded analysis of sanitized returned data and non-credentialed research to a status specialist, disclosing inaccessible/stale/incomplete sources. |
| `@jarvis-plan` | Main session coordinates `jarvis-plan`; delegate substantive governance assessment to a bounded planning specialist; remain read-only. |
| `@jarvis-delivery` | Main session coordinates `jarvis-delivery`; delegate bounded implementation work to an appropriate implementation specialist under the full issue intake and delivery gates. |
| `@jarvis-review` | Main session coordinates `jarvis-review`; delegate review to a fresh independent review specialist. If part of a current delivery, `jarvis-delivery` coordinates it. Never create a delivery issue just to review. |
| `@jarvis-backlog` | Main session coordinates `jarvis-backlog` and performs any authorized credentialed GitHub reads or writes; delegate bounded analysis of sanitized returned data and non-credentialed research to a backlog specialist, not mutations or implementation by implication. |
| `@jarvis-tags` | `jarvis-tags` only; exact registry-only response. Do not spawn a worker or start another workflow. |

Give each specialist only the minimum sanitized context needed for its assignment; provide no credentials and no extra tools or permissions. The main session integrates the specialist's evidence and answers the user. Credentialed GitHub reads, all GitHub writes, commits, and publication are performed and owned by the primary coordinator under the selected skill and actual authorization. The coordinator may delegate analysis of sanitized data returned from credentialed reads, but does not pass credentials or authenticated access. In particular, status/backlog specialists may analyze sanitized returned data, not perform authenticated reads or mutations. Delegation is within the selected workflow, not a second workflow, and never changes the skill's authority or gates. Clarification-only turns do not spawn workers. If suitable worker capacity/tooling is unavailable, state that explicitly; direct handling without a worker cannot be called delegated. Continue directly only where the selected skill and user authorization permit.

## Review boundary

The reviewer must not have authored any part of the candidate. The reviewer receives exact revisions and the authorized scope, does not modify the candidate or delivery branch, and does not publish GitHub state or merge. If the current session participated in the change, delegate autonomous review to a fresh independent reviewer; if none is available, report a limited review rather than claiming independence. Delivery-linked review remains coordinated through issue delivery, with corrections owned by the delivery coordinator/author and a fresh review after each changed revision.

## OpenCode capability boundary

This skill is a fallback instruction procedure for missing, mismatched, or ambiguous tags, not a request hook or policy engine. The canonical tag-aligned skills are the direct entry points when the user invokes them through a compatible skill-aware client. OpenCode v2 supports skill invocation by ID; other clients may use different syntax or not support it. Neither aligned IDs nor this router require every message to start with a tag or prevent direct invocation of other available skills. Contributor-session agents/tools are distinct from the JARVIS product runtime. The product OpenCode profiles documented in [technical architecture §10.2](../../../docs/technical-architecture.md#102-controlled-configuration-and-permissions) disable task/subagent tools; do not claim the product can start one spontaneously. J06 is separately gated and uses its planned attempt/session model.
