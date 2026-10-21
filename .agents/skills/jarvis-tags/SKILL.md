---
name: jarvis-tags
description: Return the canonical JARVIS request-tag list and its brief descriptions when invoked by @jarvis-tags or when the user asks for the tag list. No other function.
---

# JARVIS request tags

Use only when invoked by `@jarvis-tags` or asked for the JARVIS request-tag list. Return exactly the canonical tag registry and brief descriptions from [Canonical tags](../../../docs/jarvis-request-routing.md#canonical-tags), with no additions, omissions, commentary, or workflow launch. The routing document is the sole source of truth; do not maintain a second registry here. If that source is unavailable, report that the canonical list cannot be retrieved rather than reconstructing or guessing it.

Do not inspect other repository files, query GitHub or project status, or launch any workflow. This skill returns the registry only. Tag routing is an instruction convention, not technical interception or authority, and contributor-session behavior is distinct from the JARVIS product runtime.
