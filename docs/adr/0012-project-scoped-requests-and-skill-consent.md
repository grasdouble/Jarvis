# ADR-0012: Project-scoped requests and revision-bound skill consent

- Status: Accepted (product direction); implementation mechanisms remain proposed
- Created: 2026-10-18
- Updated: 2026-10-18
- Decision owner: JARVIS owner
- Requirements and scope: PRD §§1, 4–7; F01, F11–F14; POL 08–13; N14–N15; v0.1 request scope only
- Related Dxx / legacy ADR / issue / PR: D01–D06, D08, D16; ADR 03, 04, 07, 08; JV-001 / draft PR #90 (preserved, not superseded); JV-124, JV-125
- Supersedes / superseded by: Partially supersedes the Dependabot-first/automerge product objective in PRD v1.14 and the corresponding v0.1 scope in architecture v1.13. Does not supersede the J06 autonomous-delivery plan or its separate policy gates.

## Context and decision needed

The prior v0.1 objective centered on unattended Dependabot PR monitoring and product-side merge decisions. The owner selected a different product outcome: handle explicit requests about authorized projects, either by preparing a plan or by implementing the request and opening a PR. The owner also selected that project authorization and project-skill consent belong to JARVIS's internal configuration, and that consent to use a project skill is revision-specific and distinct from permission to execute its scripts or commands.

The accepted source is the owner's direction in the development conversation on October 18, 2026, captured in JV-124/JV-125. Existing JV-001 and draft PR #90 record earlier provider, budget, pilot and other J00 inputs; they are preserved and do not independently approve this product architecture. No claim is made that the selected capabilities are implemented, tested, or qualified.

The following remain separate open gates: exact GitHub App branch/PR permissions and publication mechanism; provider and confidentiality qualification; how the previously selected €2/review, €10/day, and €100/month caps apply to plan/dev tasks; repository command/test execution (D16); and any product-side review/merge policy beyond the selected v0.1 PR handoff.

## Options and trade-offs

1. Keep Dependabot monitoring and automerge as the v0.1 center. This preserves the former roadmap but does not meet the owner's selected project-request outcome.
2. Make all project work autonomous/background-driven. This could reduce interaction but would expand scope and authority beyond the explicit request and mode choice.
3. Center v0.1 on explicit user requests with distinct plan and development modes; keep project access internal to JARVIS, require clarification when needed, permit validated PR creation for dev tasks, and exclude JARVIS merge. Treat project skills as untrusted content unless the owner approves the exact revision; keep command execution separately gated.

Option 3 is selected. It makes user intent and project identity explicit while preserving the deterministic core, sandbox, secret and native GitHub protection boundaries. It trades unattended processing/merging for a human-directed plan or PR handoff.

## Decision and rationale

- The owner selects `plan` for a read-only plan and `dev` for a requested code change that may result in a PR. If project, intent or mode is ambiguous, JARVIS asks before starting the corresponding task/effect.
- JARVIS's internal, owner-controlled configuration is the authority for the project allowlist and project-skill approvals. Target repository contents cannot authorize themselves or change these records.
- A project skill can be used only after explicit owner approval is recorded internally and bound to its exact revision. Approval to use its instructions does not authorize execution of scripts/commands or grant any additional project, host, provider or GitHub permission.
- Development mode may author in an isolated task workspace and, after trusted validation, open a PR through the deterministic core. JARVIS does not merge in v0.1. Native branch protections and required review remain authoritative.
- Product-side execution of repository commands, tests, installers, plugins and MCP servers remains disabled until D16 and a separate profile qualification are complete. This is a safety fallback, not an assumption that all tasks can be validated without execution.
- Dependabot analysis remains available only as an explicitly requested task where applicable; unattended detection and automerge are not v0.1 gates.

The PRD and architecture describe proposed mechanisms where implementation detail is not owner-selected. In particular, stable repository identity/configuration schema, skill digest algorithm and discovery UI, exact GitHub branch-publishing API/permissions, and numeric task budgets require implementation review and applicable gates. This ADR does not create those permissions or claim a running feature.

## Consequences

- PRD requirements, POL identifiers, non-functional criteria, success measures and J00–J05 milestones distinguish explicit project work from historical Dependabot/automerge behavior.
- The architecture requires separate plan and development profiles, an internal configuration boundary, skill-revision provenance, deterministic patch validation, and task-bound PR publication without merge authority.
- JV-126 reconciles affected issue acceptance, milestones, dependencies and project metadata after this specification is integrated. Historical issue/PR discussions and stable identifiers remain intact.
- J06 remains the separate post-MVP autonomous issue-delivery capability; its own author/reviewer, execution, merge and human-approval policy is not imported into v0.1 by phase number.
- Design acceptance is not implementation evidence, qualification, permission provisioning, or product activation.

## Acceptance evidence

Owner direction was explicitly accepted in the development conversation on October 18, 2026 (`jarvis plan`/`jarvis dev`, internal project authorization, project-skill consent bound to a revision, and PR handoff without merge). The issue-specific human-review preference is recorded separately for JV-124 and its children. The exact integrated PR revision and independent review evidence are recorded in the linked PR; no runtime acceptance is claimed here.
