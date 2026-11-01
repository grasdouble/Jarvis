# JARVIS v0.1 PRD and roadmap

Document version 1.21 • October 25, 2026 • Personal self-hosted product

## 1 Vision and intended outcome

JARVIS handles explicit requests about software projects the owner has authorized in its internal configuration. The owner selects a plan (`jarvis plan`) or development task (`jarvis dev`) for each request. JARVIS clarifies the project, intent, or mode before acting when any is ambiguous. Project-skill instructions require explicit owner approval for their exact revision, recorded internally. Development tasks may result in a pull request; JARVIS does not merge it.

The product runs on a MacBook M2 Pro with Docker Engine inside a dedicated Colima VM profile named `jarvis`. Docker Compose deploys the persistent services; Docker Desktop is not required. The core is built in-house in TypeScript and Node.js, in a PNPM monorepo organized as a modular monolith. PostgreSQL stores state, the internal project/skill configuration, and the work queue; React provides the interface. OpenCode is the shared headless agent runtime, controlled through its SDK or API: no plugin and no dependency on a personal OpenCode session. Plan and development missions use separately qualified profiles. The development profile may author code in an isolated task workspace and request PR publication through the deterministic core; it receives no GitHub credentials and has no merge authority.

This document defines product behavior, acceptance criteria, and the path to v0.1. The separate [JARVIS v0.1 Technical Architecture](technical-architecture.md) document describes the contracts, trust boundaries, and mechanisms needed to meet these commitments.

**Launch principle.** Version 0.1 accepts an explicit project-scoped request in plan or development mode. Plan mode is read-only. Development mode may create a scoped code change and open a PR after deterministic authorization and validation; merging remains outside JARVIS. A model response, project skill, or repository file cannot grant project access, approve a skill, or authorize an external effect.

Contributor changes use the [governance procedure](project-governance.md) to trace affected requirements/decisions and maintain relevant documents/backlog with actual authority and evidence. The [ADR index](adr/index.md) preserves significant technical decision history; Dxx entries remain the separate owner-decision register. This contributor process adds no product feature, runtime permission, semantic CI guarantee or MVP exit gate.

## 2 Initial decisions and product assumptions

### 2.1 Established constraints

- Local hosting on a Mac M2 Pro using Colima with the Docker runtime, a dedicated `jarvis` profile, and macOS directory sharing disabled at VM level. No personal folders are mounted into agents.
- A separate ephemeral sandbox for each task attempt; no Docker socket or GitHub secret in OpenCode.
- In-house orchestration, project authorization, skill approvals, memory, budgets and tracking. Plan and code-authoring profiles are separate; a shared OpenCode engine does not imply shared permissions.
- Interchangeable LLM providers through configuration and adapters, with explicit authorization for destinations receiving private code.
- A GitHub App installed only on selected repositories, with minimal permissions and no ability to bypass protections.
- An MVP covering user-directed project requests, plan-only analysis, bounded code authoring and pull-request creation, with no product-side merge.

### 2.2 Proposed assumptions for sizing the MVP

The values below are design targets to confirm at milestone J00; they are not measured performance results.

| Parameter | Proposed initial value |
| --- | --- |
| Users | One owner and a single administrator account |
| GitHub hosting | GitHub.com; GitHub Enterprise Server deferred |
| Initial project set | `grasdouble/Jarvis-Test` only, as selected by the owner; the JARVIS source repository is not an initial project target |
| Nominal volume | 20 user requests per day; peak request rate remains to be measured |
| Repository state | The owner reports `Jarvis-Test` currently contains only `README.md`; repository and product-App access still require verification |
| Concurrency | One OpenCode sandbox at a time |
| Per-attempt quotas | 2 vCPUs, 4 GiB RAM, 256 processes, 30 minutes |
| Plan profile | Read-only project context and approved skill instructions; no repository writes |
| Development profile | Isolated writable task workspace; PR publication through the trusted core; no merge |
| Daily digest | 08:00, Europe/Paris time zone, available in the interface |
| Consumption visibility | Report only request usage/quota returned by normal provider/runtime traffic, with provider/model, provenance, freshness and unknown coverage |

Provider subscriptions and credits remain provider-managed. JARVIS does not impose monetary reservations/ceilings, access billing/admin APIs, poll provider quotas, or infer balances or invoices. Context, token, request, time and infrastructure quotas remain separate safety limits. Provider dispatch remains disabled until its isolated route is qualified.

## 3 User and problems to solve

The owner maintains several repositories and wants to delegate project work without giving an agent general access to the Mac or GitHub. They must be able to understand what JARVIS planned or changed, what it published, what remains uncertain, and what usage was actually observed. They must also be able to stop actions.

The priority problem is the effort required to turn a request about a project into an actionable plan or a reviewed code change. JARVIS should use project-specific context without granting an agent general access to the Mac, other repositories, or GitHub credentials. The owner must be able to see what JARVIS did, what it changed, which skills and evidence it used, and what remains uncertain.

### 3.1 Main user journey

1. The owner adds repositories to JARVIS's internal project allowlist and configures the permissions and skill-consent policy for each project.
2. The owner submits a project-scoped request in plan or development mode. If the project, requested outcome, or mode is ambiguous, JARVIS asks before acting.
3. JARVIS resolves the selected project's current revision and applicable approved context, then creates a bounded task attempt in the matching isolated profile.
4. In plan mode, it returns a sourced plan, affected areas, risks and uncertainties without changing the project. In development mode, it edits an isolated task branch/workspace and returns its proposed diff and checks/evidence.
5. The trusted core validates scope and revision, then may publish one PR for the development request. JARVIS records the confirmed or unknown remote result; it does not merge the PR.
6. The owner inspects the plan or PR and decides what to do next; task history records sources, skills, changes, limitations and observed usage.

## 4 Scope and exclusions

### 4.1 Included capabilities

Version 0.1 handles explicitly submitted requests for repositories listed in JARVIS's internal project configuration. The owner selects plan-only analysis or development that edits code and opens a PR. Requests are scoped to one configured project; ambiguity requires clarification. The product provides authenticated task history, bounded project context, per-project skill configuration, safely observed provider usage, and an emergency stop. PR publication is a trusted-core effect bound to the task, repository, base/head and policy; merge is not an MVP capability.

Plan mode inspects project material and proposes work without writing. Requests may cover repository changes, pull-request analysis, dependency updates, or other scoped project tasks, subject to project authorization and the selected mode.

The MVP also includes JARVIS-owned durable memory: task checkpoints, operational history, a bounded collection of repository knowledge, and explicit preferences. Only the core selects and persists reusable context; OpenCode sandboxes remain ephemeral. Knowledge retrieval starts with repository-scoped structured filters and PostgreSQL text search.

### 4.2 Explicit v0.1 exclusions

- General-purpose conversation, weather or other external personal capabilities; these remain separately planned in J08.

- Unrequested background issue discovery, autonomous task selection, code modification, or PR publication. Code changes and PRs require an explicit development-mode user request.
- Model fine-tuning, a vector database, automatic knowledge promotion, unrestricted conversation retention, or cross-repository knowledge sharing.
- Product-side PR merging or bypassing repository review/protection rules.
- An OpenCode plugin, control of the owner's personal OpenCode instance, cooperating agents, or an unrestricted general-purpose planner.
- Merge queues, stacked PRs, forks, automatic branch updates, rebasing, or conflict resolution.
- Automatic execution of project-provided scripts, tests, installation steps, plugins, MCP servers, or startup configuration. Project-skill instruction approval alone does not authorize command execution. The execution/validation policy remains a separate qualification and owner-decision gate; until accepted, no repository command is run by the product profile.
- GitHub administration, changing protections, software deployment, or access to macOS, SSH, the Keychain, or personal folders.
- Multi-user SaaS, high availability, or guaranteed operation while the Mac is powered off or asleep.
- Telegram/Signal messaging, email or Slack delivery. J09 separately plans Telegram/Signal notifications and subsequent conversation; the web digest is sufficient for the MVP.

## 5 Request modes and authorization policy

### 5.1 User-selected request mode

| Request mode | Analysis | Project writes | GitHub writes | Merge |
| --- | --- | --- | --- | --- |
| `plan` | Read-only project analysis and plan | None | None | None |
| `dev` | Analysis needed for the explicit request | Isolated task branch/workspace only | Trusted core may open a PR for this task | Never by JARVIS |
| Suspended | No new task | None | None | None |

The v0.1 request commands are `jarvis plan "prompt"` and `jarvis dev "prompt"`. If the selected project or intended outcome is ambiguous, JARVIS asks before starting work or producing an effect. A development request authorizes only its bounded task and PR handoff, not merge, branch-protection changes, or unrelated administration. Required human review and GitHub protections remain authoritative.

### 5.2 Project and skill authorization

The project allowlist is held in JARVIS's internal, owner-controlled configuration, not in the repository being processed. Configuration changes are authenticated, versioned, and audited. Repository files, issue text, skills, model responses, and PR content cannot add a project or change its permissions.

JARVIS may use its own qualified skills and project-specific skill instructions. A project skill is usable only after the owner explicitly approves it; JARVIS records that decision only in its internal project configuration, bound to the exact skill revision. A changed or unverifiable revision is not covered by an earlier approval. Approval to use instructions is separate from permission to execute scripts or commands described by a skill; neither grants wider project or host access. Skills, plugins, MCP servers, and startup hooks are not activated merely because they exist in a repository.

**POL 08.** Every task and effect is bound to a repository identity in the current JARVIS-internal allowlist. Authorization is checked by the deterministic core; repository content and model output cannot alter it.

**POL 09.** Plan tasks are read-only: the core rejects project writes and GitHub effects, regardless of tool/model requests.

**POL 10.** Development work is bound to the selected repository, request, starting revision, policy, and approved context. Material scope or revision changes require revalidation; the agent cannot modify the authorization record.

**POL 11.** A project skill is usable only when its exact revision is approved in JARVIS's internal configuration. A changed or unverifiable revision is excluded until the owner approves that exact revision.

**POL 12.** OpenCode and project-skill content receive no credentials or direct host/GitHub authority. The core validates scope, patch paths, revision, and output before publication. Repository commands, scripts, plugins, and MCP servers remain disabled unless a separate execution policy is accepted and qualified.

**POL 13.** The core may create a PR only for the authorized development task, after validation, using a revision-bound idempotent intent and remote reconciliation after uncertain responses. PR creation grants neither review approval nor merge authority. JARVIS does not merge in v0.1.

### 5.3 Decision validity and stopping

A change to repository, task scope, base/head, profile, policy, or selected skill revision invalidates dependent context and pending publication eligibility. The emergency stop prohibits new model and GitHub requests, revokes task capabilities, and initiates sandbox shutdown. A request already accepted by GitHub may still complete: the interface shows operations awaiting confirmation and never promises to cancel them.

## 6 Functional requirements and acceptance criteria

### F01 Configure authorized repositories

**User story.** As the owner, I want to authorize projects in JARVIS so requests can access only the intended repositories.

**Requirements.** The owner adds/removes repositories through authenticated JARVIS configuration. The allowlist is stored internally, versioned, audited, and keyed by stable repository identity; repository content cannot modify it. Per-project branch, provider/data handling, limits and permissions are separately configured as accepted. App installation alone does not authorize a project task.

**Acceptance.** In a 10-project fixture, no task, sandbox, provider dispatch, or GitHub effect occurs for an unlisted project. Renames preserve identity; removal blocks new work and effects. Configuration changes require authentication, expected-version checks, and audit. The interface shows authorized projects and effective permissions.

### F03 Perform a read-only pull-request review

An explicitly requested PR review can reuse the bounded, isolated read-only analysis profile. This does not itself authorize a code change, PR publication, or merge.

**Requirements.** Where this profile is used, each attempt uses a new environment, a fixed snapshot, and controlled OpenCode configuration. Repository code is not executed. The report is bound to its source revision and identifies examined files, findings, limitations, and uncertainty.

**Acceptance.** A selected review fixture produces a revision-bound report with verifiable paths; malformed or incomplete input is explicitly limited. Isolation gates N01–N03 apply. This profile is not a substitute for plan or dev acceptance.

### F07 Produce a daily digest

**User story.** I want to understand within a few minutes what happened and which decisions need my attention.

**Requirements.** One digest per local date and scope groups user requests, plans, development tasks, opened PRs, blocks, failures, incidents, task limits and observed provider usage. Each item links to its details. Totals come from PostgreSQL; LLM-written prose is optional.

Include supported token totals/breakdowns and observed/unknown coverage only when returned on the normal provider/runtime request path. Late observations may revise the original period with a visible watermark/correction, without a duplicate digest. Monetary values, balances, invoices and quota not returned by that path are not included.

**Acceptance.** A fixture containing 12 requests, 4 opened PRs, and 2 failures reproduces exactly those totals. A daylight saving time change does not create two digests. If the Mac is asleep at 08:00, a catch-up digest is available within 5 minutes of recovery and identifies the period. Several missed days are grouped without losing events.

### F08 Supervise and stop

**User story.** I want to see project tasks and be able to stop JARVIS activity quickly.

**Requirements.** A dashboard shows authorized projects, requests, plans, development runs, opened PRs, health, configured request/runtime limits, observed provider usage and unconfirmed remote operations. Global stop and per-project suspension are available. A redacted text or JSON report can be downloaded.

**Acceptance.** The durable stop takes effect for new calls in less than 2 seconds; process shutdown is requested within 10 seconds if components are responsive. Restarting preserves the suspended state. The interface distinguishes waiting for capacity, an unavailable dependency, permanent failure, and an unknown remote result.

### F09 Select providers and observe usage

**User story.** I want to select the authorized model provider and observe supported request usage without treating it as an invoice or monetary limit.

**Requirements.** The owner selects one of two permitted provider configurations, GitHub Copilot or OpenAI, through trusted configuration; changing providers requires an explicit trusted configuration change. Plan and dev use the same mission/report, streaming, cancellation and context-budget contracts. Required capabilities and confidentiality rules are checked before dispatch; an incompatible profile or outage fails explicitly and never falls back. Private code may be sent only to the configured provider. Record provider/model usage and quota only when returned by ordinary request/runtime traffic, with provenance, freshness and explicit unknown/unsupported states. Provider subscriptions and credits remain provider-managed: JARVIS does not reserve or cap money, read billing/admin APIs, or poll quotas. Token/request/runtime bounds remain distinct from monetary controls. Detailed request accounting, API/UI/digest acceptance and reconciliation remain separately unimplemented work in #301 / JV-072; this decision does not claim those features.

F09 usage records are a separate future accounting deliverable. They may retain only safe provider/model attribution and usage/quota observations actually returned through ordinary runtime traffic, with field-level provenance, freshness and unknown/unsupported coverage; no request content or billing/admin API data is needed or authorized. No provider-side subscription allowance or monetary value may be inferred from token counts.

**Acceptance.** Synthetic fixtures exercise both trusted provider profiles through the same versioned plan/dev result contract, bounded durable queue reference, streaming, cancellation and trusted context-budget behavior. Incompatible capability, malformed result and unavailable selected-provider cases fail explicitly without dispatching to another provider. Only trusted configuration can select a provider; request content, repository contents and agent output cannot override it or grant authority. Production dispatch remains disabled until the per-attempt egress implementation and pinned Colima/Lima qualification pass.

Accounting details remain separately owned future work: usage normalization, durable per-request ledger, projections, corrections and UI/digest behavior are not implemented by this issue. When implemented, synthetic fixtures must preserve source/freshness/unknown status, avoid duplicate observations and expose only usage actually observed on the normal provider/runtime request path. Provider subscriptions, balances, quotas not returned by that path, invoices and charges are outside JARVIS; no monetary reservation, ceiling, billing credential/API, or quota polling is authorized. No result here constitutes live provider qualification.

### F10 Retain and reuse controlled memory

**User story.** I want JARVIS to remember useful project context and past incidents across restarts and provider changes, and to let me inspect, correct, or forget it.

**Requirements.** PostgreSQL stores four distinct categories: task progress, historical outcomes, reusable repository knowledge, and explicit preferences/policies. Every reusable item has a source, repository, date, applicability conditions, version, and status. Agent conclusions remain observations or hypotheses until the owner validates them. Validation does not turn text into executable instructions, CI evidence, permissions, or approval. Current GitHub facts and deterministic policy remain authoritative for actions.

Before an attempt, the core retrieves only applicable, non-expired knowledge from the authorized repository and constructs a bounded context with citations. The initial additional-memory budget is at most 10 items, 4,000 tokens, and 32 KiB, within the runtime's total context allowance. Summaries remain linked to their sources and do not replace evidence. The authenticated interface supports creation, inspection, validation, correction, invalidation, and deletion. A provider change rebuilds context from JARVIS storage rather than relying on provider conversation history.

**Acceptance.** A two-project fixture returns zero items from the other project. All selected items have a source and version recorded in the task's context manifest. Expired, invalidated, deleted, or inapplicable items are never selected; contradictory applicable items are identified rather than silently collapsed. Attempts remain within all configured memory limits. An agent-written instruction to change project permissions or policy creates neither a configuration change nor an approval. A restart and provider switch preserve validated knowledge and task history; a new attempt uses fresh project facts. Deletion removes an item and its search representation from active retrieval within 60 seconds, cancels affected active attempts, and leaves only content-free audit metadata. Restore acceptance verifies that forgotten items are not reactivated.

### F11 Accept and clarify project requests

**User story.** I want to submit a request for an authorized project and have JARVIS ask before acting when the project, intent, or mode is unclear.

**Requirements.** Each durable request identifies an authenticated owner, one allowlisted project, prompt, selected `plan` or `dev` mode, and immutable policy/configuration versions. Missing or conflicting project/mode/intent yields a clarification without starting an agent attempt or external effect. Duplicate submissions are idempotent.

**Acceptance.** A fixed corpus of at least 20 clear, ambiguous, unauthorized, malformed, duplicate, and stale-configuration requests produces the expected task/clarification/block with zero unauthorized task or external effects. Clarification response resumes only the same authorized request after revalidation.

### F12 Produce a read-only plan

**User story.** I want a sourced plan for a request without JARVIS changing the project.

**Requirements.** The plan profile receives only the selected project's bounded snapshot and applicable approved context. It returns proposed steps, affected areas, assumptions, risks, and unresolved questions. It cannot write files or call GitHub mutation endpoints.

**Acceptance.** Plan fixtures produce source/revision-bound results; attempts to write files, publish a PR, or expand scope are denied by the effective profile and trusted core. Plan output is labeled advisory and is not treated as authorization for a later dev task.

### F13 Develop a bounded change and open a PR

**User story.** I want JARVIS to implement an explicit development request and hand me a PR to inspect.

**Requirements.** A separately qualified author profile works in an isolated writable task workspace. The trusted core validates repository, revision, diff paths, task scope, limits, and publication policy, then may open one PR. JARVIS does not merge. Repository commands and tests are not run unless the separate D16 execution policy is accepted and qualified; until then, validation evidence and limitations are stated without running them.

**Acceptance.** An authorized fixture yields a scoped patch and at most one PR. Out-of-scope paths, changed authorization/revision, malformed output, exhausted limits, or revoked access prevent publication. Duplicate/lost-response cases reconcile to one remote PR or an explicit unknown state, never blind retry. The PR is linked to its task and exact base/head; merge is never requested.

### F14 Discover and approve project skills

**User story.** I want JARVIS to use useful project-specific skills only after I approve the exact version and only within existing permissions.

**Requirements.** Skills may be discovered as untrusted project content and presented for inspection. A project skill requires explicit owner approval, stored only in JARVIS's internal project configuration and bound to an immutable skill revision/content digest. Approval to use instructions is not approval to execute scripts or commands. Repository skills cannot self-approve, alter the allowlist, permissions, provider, or execution policy. JARVIS skills are sourced from a separately trusted/pinned bundle.

**Acceptance.** Tests cover absent, approved, changed, unverifiable, revoked, and cross-project skill revisions; only an explicitly approved exact revision is included. Skill content and model output cannot create approvals or capabilities. No skill script/command runs under this requirement.

## 7 Non-functional requirements

| ID | Requirement | Acceptance measure |
| --- | --- | --- |
| N01 | Restrict Mac access | No macOS directory shares in the effective Colima VM configuration; no personal bind mount, device, Docker socket, privileged mode, or host namespace in 100% of inspected sandboxes |
| N02 | Isolate networking | Every direct access attempt from a sandbox to the Mac, LAN, Internet, external DNS, PostgreSQL, and other tasks fails, including IPv4 and IPv6 |
| N03 | Protect secrets | No real GitHub or provider secret in the environment, files, logs, or reports accessible to the agent; tested with canary secrets |
| N04 | Responsive request intake | Authenticated request is durably accepted or rejected in less than 2 seconds at p95 across 1,000 request fixtures at nominal volume |
| N05 | Task-start freshness | An admitted request queues within 60 seconds at p95 while the system and provider are available; clarify/block states are never queued as authorized work |
| N06 | Task duration | Record plan and dev attempt durations separately; retain a hard 30-minute attempt limit pending measured workload qualification |
| N07 | Local availability | Successful probes at least 99% of the time over 7 days while the Mac is awake, Docker is running, and networking is available; downtime excluded and displayed |
| N08 | Recovery | Backup RPO of 24 hours, target RTO of 60 minutes after the Mac and dependencies become available; restore rehearsed before release |
| N09 | Traceability | 100% of GitHub writes linked to an intent, policy, actor, evidence, and a confirmed or unknown result |
| N10 | Maintainability | Tested adapter contracts, versioned migrations, reproducible ARM64 installation, and recovery documentation |
| N11 | Confidentiality | Provider authorized per repository, configurable retention, sanitized HTML, and no telemetry containing code by default |
| N12 | Resources | One sandbox, enforced limits; stop new starts with less than 10 GiB free in the VM or insufficient capacity |
| N13 | Memory integrity | 100% of reused items have repository scope, provenance, applicability, and version; no memory text can grant action authority; deletion and restore tests pass |
| N14 | Project and request authorization | 100% of attempts/effects bind to an internally allowlisted stable project identity and explicit request/mode; unlisted or ambiguous requests create no attempt/effect |
| N15 | Skill consent integrity | Every consented project skill is bound to its exact content revision in internal configuration; no repository/model content can grant skill, script, or command authority |

Colima provides the Linux VM hosting Docker Engine; the selected Docker runtime supports the Docker CLI and Compose. Use a dedicated profile, disable directory sharing with `mounts: null`, and verify the effective guest mounts before J01 acceptance. An empty `mounts: []` retains default sharing and is not an isolation control. Containers still share the guest kernel, and the sandbox controller remains highly privileged. This design assumes neither Docker Desktop Enhanced Container Isolation (ECI) nor equivalent additional isolation in Colima. A dedicated profile reduces exposure to unrelated containers but does not guarantee protection against VM, kernel, or controller compromise. [C1](https://colima.run/docs/runtimes/), [C2](https://colima.run/docs/profiles/), [C3](https://colima.run/docs/configuration/), [C4](https://github.com/abiosoft/colima/blob/main/environment/vm/lima/yaml.go)

## 8 Web experience and displayed information

The home screen prioritizes active requests, clarifications, failures, and operations awaiting confirmation. A task view distinguishes owner input, repository facts, model output, core decisions, and published PRs. Full revisions and source links are available.

A usage view may show input/output tokens, supported cache/reasoning breakdowns, provider/model, task purpose, source/freshness and reported/unknown/unsupported coverage. Period and repository/PR/task filters may support drilldown; future agent/campaign views reuse it when delivered. Parent totals and child details cannot be added twice. It does not show inferred currency valuation, balances, invoices, reservations or monetary ceilings; token savings alone do not prove quality gains.

Configuration must explain which projects are authorized, where configuration is stored, current skill approvals and their revisions, and the permissions actually granted. Project suspension remains visible. Blocking messages suggest a useful next step, such as clarifying the requested mode, approving a specific skill revision, or resolving a changed base/head.

A repository memory view shows each item, source, status, applicability, review date, and tasks that used it. The owner can validate, correct, invalidate, or forget an item. The task view identifies which memory versions were supplied and any omissions caused by context limits.

The interface remains locally accessible through a browser and uses an authenticated session. V0.1 project requests do not require an externally exposed webhook. No OpenCode or PostgreSQL port is published on the Mac.

## 9 Risks and mitigations

| Risk | Initial level | Mitigation and launch condition |
| --- | --- | --- |
| Escape or abuse of the Docker controller | Critical | Separate controller, closed API, no unrestricted Docker parameters, pinned images, no socket in core or agents; J01 security acceptance |
| Injection in project/skill content | High | Content always untrusted, controlled OpenCode configuration, no authority in runtime, validated output; J03/J04 adversarial corpus |
| Persistent memory poisoning or stale knowledge | High | Source-bound versions, repository isolation, human validation, applicability checks, expiry, no policy authority; F10 adversarial and forgetting tests |
| Publishing a change against stale or wrong scope | Critical | Project/task/revision binding, invalidation, patch-path validation and GitHub protections; J04 race tests |
| Code disclosure to a provider | High | Providers authorized per repository, context limits, no implicit fallback; J00 confidentiality validation |
| Sleep, Docker outage, or network loss | Medium | Reconciliation, expiring leases, catch-up, unknown-result states; J02/J05 recovery tests |
| Provider request exhaustion or unobserved retries | Medium | Keep request/token/context/time and infrastructure limits distinct; expose only actually returned usage and unknown coverage; no JARVIS monetary controls or assumed invoice ceiling |
| Incorrect CI provenance | High | Bound check, issuer, workflow, and SHA; no self-approval; J04 pilot repository audit |
| Networking and OpenCode transport complexity | High | Early isolated prototype; block the affected task profile if the safe transport cannot be validated |
| Personal maintenance burden | Medium | Monolith, one worker, no distributed bus or general-purpose planner in v0.1 |

## 10 Success metrics

Usage metrics are calculated per period and authorized project from observed request data; unknown coverage remains visible. MVP utility is measured on explicit user requests, not unattended PR or merge volume.

| Metric | v0.1 release target |
| --- | --- |
| Unauthorized project/task/effect | Zero across the acceptance corpus and pilot |
| Duplicate PR publication | Zero duplicate PRs in tested duplicate/lost-response scenarios |
| Useful plan or change | At least 18 of 20 owner-selected pilot requests judged useful; plan and dev outcomes reported separately |
| Scope integrity | Zero accepted out-of-scope file changes or unapproved skill revisions in the acceptance corpus |
| Human effort | Measure median request-to-usable-plan/PR time against a recorded manual baseline; target set after baseline |
| Provider usage | Report observed request-level usage/quota only where returned, with provenance and explicit unknown coverage; do not infer monetary values or invoice totals |

These targets do not prove the absence of regressions. The corpus includes clear and ambiguous requests, hostile repository/skill content, scope violations, and uncertain remote outcomes; an LLM score alone does not measure safety.

## 11 Roadmap and milestones

No delivery date or duration estimate is committed. MVP qualification requires project authorization, isolation, qualified plan/development profiles, and safe PR publication.

| Milestone | Period | Deliverable | Exit gate |
| --- | --- | --- | --- |
| J00 Scoping | No date committed | Authorized initial project, provider/data handling, consumption observation, execution and publication decisions | D01–D06 and applicable new decisions recorded; no unresolved gate is bypassed |
| J01 Isolation | No date committed | Controller, ARM64 task profiles, provider gateway, stop and cleanup | N01–N03 pass; no Mac or Docker socket access from agent profiles |
| J02 Project and request foundation | No date committed | Internal project configuration, authenticated request intake, storage, queue, minimal UI | F01/F11, N14, duplicates, ambiguity and unauthorized-project cases validated |
| J03 Planning and context | No date committed | Read-only plan profile, OpenCode adapter, bounded memory and provider profiles | F03/F09/F10/F12, N15; isolation, hostile-input, memory and provider cases validated |
| J04 Development and PR handoff | No date committed | Writable task workspace, deterministic scope validation, PR publisher | F13/F14, POL 08–13; revision/scope races and uncertain publication cases covered; no merge capability |
| J05 — MVP qualification and operations | No date committed | Request dashboard/digest, skill consent UX, backup, recovery and operations guide | F07/F08/F11–F14, N14/N15, restore, pilot and all accepted critical gates met |

Milestone names describe delivery outcomes, independently of release numbers. J05 qualifies the project-request product; J06 covers autonomous issue-to-PR delivery and its separate review/merge policy. JV-126 aligns native issue and milestone assignments with this roadmap. Package versions and release numbers follow the [planned Changesets workflow](development-workflow.md#package-versioning-and-releases); no milestone reserves a particular package version.

Post-MVP tracking uses separate, undated native GitHub milestones. This mapping adds no MVP release criterion or calendar commitment:

| Milestone | Scope | Tracking |
| --- | --- | --- |
| J06 — Autonomous delivery | Agent-selected/issue-driven autonomous delivery, independent review and any separately authorized merge policy beyond explicit user-directed MVP tasks | Parent [JV-044](https://github.com/grasdouble/Jarvis/issues/44), children JV-045–JV-048 |
| J07 — Self-improvement | Evidence-driven improvement proposals, comparison and separately approved activation after verified J06 delivery | Parent [JV-051](https://github.com/grasdouble/Jarvis/issues/51), children JV-052–JV-055 |
| J08 — General-purpose assistance | Shared OpenCode profiles, controlled read-only capabilities and authenticated conversation following J05; no committed version/date or dependency on J06/J07 solely by phase number | Parent [JV-064](https://github.com/grasdouble/Jarvis/issues/64), children JV-065–JV-068 |
| J09 — Messaging channels | Telegram/Signal notifications following J05, then each channel's authenticated conversation after J08; no cross-channel or J06/J07 prerequisite solely by phase number | Parent [JV-075](https://github.com/grasdouble/Jarvis/issues/75), children JV-076–JV-081 |
| J10 — Duration forecasting | Measured task/stage history, model/effort estimates, conditional remaining-time display and calibration following J05; advisory only, with no committed date/version | Parent [JV-084](https://github.com/grasdouble/Jarvis/issues/84), children JV-085–JV-088 |

Every repository issue must carry the appropriate native milestone under the [contributor policy](development-workflow.md#required-issue-milestones); body references alone do not assign it. Apply the shared [selection and creation rules](development-workflow.md#milestone-selection-and-creation): J00 covers initial MVP scoping, while feature-specific specifications remain with their product phase even when delivered early. Contributor-only work uses the thematic DEV track matching its primary scope or a bounded one-off outcome, separate from J00–J10. The ongoing tracks cover delivery/planning, tooling/validation, and governance/review; they remain open while their areas remain active. The former shared `DEV — Contributor foundation` track is superseded, while its historical issue and PR assignments remain intact. For any milestone type, reopen a matching closed milestone in place when its original scope still applies to new work, preserving its identity and completed issue history and reapplying its acceptance/exit gate. DEV adds no product phase, MVP gate or calendar commitment; completed design issues do not prove runtime qualification.

A failed security or execution-policy gate blocks only the corresponding capability. Plan-only use may be qualified independently; v0.1 is not complete until the selected development and PR-publication path is validated. No degraded mode is described as full qualification.

### 11.1 Post-MVP evolution

**Potential later extensions (not a committed release).** Evaluate semantic or hybrid memory retrieval against a labeled corpus before adding embeddings; keep the same provenance and authorization rules. Extend to other ecosystems and minor updates after operational feedback; merge queues and group checks; test execution in a separate sandbox without an LLM key; better review evaluation. Telegram/Signal notifications now have the separate owner-requested J09/P14 plan below, with no committed version/date.

**Planned J06 capability: bounded autonomous delivery.** Resolve an explicitly selected issue, prepare and publish a PR, obtain independent review, apply justified requested corrections, re-review each changed revision, and merge only eligible routine work. The owner selected autonomous routine delivery with human review retained for sensitive changes. This is a post-MVP commitment to plan and qualify, not an installed capability or a delivery date. Track the parent [JV-044](https://github.com/grasdouble/Jarvis/issues/44) and children JV-045 through JV-048. J06 does not expand the v0.1 explicit-request scope or change its no-merge boundary.

**P11 user story.** I want an authorized issue delivered through independent review and bounded repairs without approving every routine PR, while retaining control of sensitive changes and spending.

**P11 requirements.** Separate author, read-only reviewer, credential-free test executor and trusted publisher/merge controller. Bind reports to exact head/base and policy; invalidate eligibility after any revision or material evidence change. Native GitHub approval is distinct from an agent assessment and remains subject to required reviewers. A model cannot grant publication/merge permission. Persist finite rounds, elapsed time and configured spend limits; stop/handoff on uncertainty, limited evidence, exhaustion, cancellation or revoked authority. Surface findings, fixes, costs and remote outcomes in the UI/digest.

**P11 measurable acceptance.** An authorized fixture issue produces one PR; a real blocking review finding triggers a tested fix and an independent new review before eligibility. Duplicate/reordered events and lost responses yield no duplicate PR or unauthorized merge. Routine eligibility requires current CI/provenance/protections and no blocking reviews; sensitive/unknown changes require current human approval. Every head/base change invalidates prior eligibility, and budgets/stop state survive restart. The agreed corpus contains at least 30 success/adversarial/recovery scenarios; a controlled pilot demonstrates correction/merge, sensitive handoff, exhaustion and lost-response recovery with zero unauthorized effects. Owner-approved profiles/budgets and the v0.1 gate precede writable implementation. See the [proposed architecture](technical-architecture.md#128-proposed-autonomous-delivery) and [shared design](autonomous-delivery.md#product-autonomous-delivery-design-commitments).

**Contributor delivery available separately.** Agents developing JARVIS use the [session-driven independent review procedure](autonomous-delivery.md#contributor-review-loop). It is a development skill workflow with local host limitations; it does not establish that the sandboxed product feature is implemented.

**Planned J07 capability: evidence-driven self-improvement.** JARVIS may identify recurring failures, quality defects or inefficient work in its own authorized operational history, retain a sourced proposal and, under an accepted policy, improve its own code or versioned working configuration. Reuse the J06 delivery loop rather than granting an agent direct control over its running service. Track [JV-051](https://github.com/grasdouble/Jarvis/issues/51) with children [signals/proposals](https://github.com/grasdouble/Jarvis/issues/52), [evaluation/policy](https://github.com/grasdouble/Jarvis/issues/53), [controlled experiments](https://github.com/grasdouble/Jarvis/issues/54) and [rollout/qualification](https://github.com/grasdouble/Jarvis/issues/55). This is a planned J07 capability, not installed automation, a new MVP gate or a committed version/date.

**P12 user story.** I want JARVIS to propose and prove improvements to its own reliability, quality, duration or consumption while retaining control of objectives, permissions, spending and release activation.

**P12 requirements.** Observe → deduplicate a durable sourced proposal → authorize one bounded improvement campaign → integrate eligible task PRs into a temporary candidate branch → track real changes in one draft `self-update` main-promotion PR → independently review and compare the assembled candidate → require current human approval of promotion to main → separately authorize rollout/rollback. Every self-improvement promotion requires human approval, including routine changes; general autonomous-delivery routine merging and current contributor delivery remain distinct. Define measurable objectives and quality/security guardrails before experimenting. Freeze incumbent/candidate revisions, workloads/corpus, environment/provider/evaluation profiles and decision criteria. Record sample sufficiency, variability, uncertainty and the total costs of every attempt, including failures. Missing, incomparable or inconclusive evidence yields no improvement eligibility; lower latency/tokens cannot compensate for dropped work, weaker tests or degraded correctness. A candidate cannot change its acceptance oracle to certify itself; reserved evaluation cases stay outside author context and writable scope.

The self-repository, target branch/paths and allowed actions require explicit policy. Keep the released core and trusted evaluator outside candidate writable scope. The author cannot approve itself, extend budgets, promote memory into authority, modify its own permissions or bypass protections. Sensitive/unknown changes, including criteria, execution/approval rules and credentials, retain current human approval. Scoped finite collection/proposal/experiment limits, cancellation and revocation survive restart. Existing memory validation/forgetting rules still apply; no model-weight training is implied.

Each actual improvement uses a detailed main-promotion PR labeled `self-update` and added to the [dedicated project view](https://github.com/orgs/grasdouble/projects/1/views/7); no operational issue or milestone is required. J07 issues remain the phase for building the capability. Before a real diff exists, keep sourced proposals and rejected/deferred dispositions in the durable ledger/UI, without an empty PR. Core enforces repository-scoped proposal/campaign uniqueness and at most one active promotion, retaining repair/supersession history. Browser and programmatic PRs use the same detailed content contract. Labels, views and skills cannot enforce or authorize this. The [versioned product skill source](../skills/jarvis-self-improvement/SKILL.md) separates reusable procedure from a declarative [project-profile contract](../skills/jarvis-self-improvement/references/project-profile.schema.json) and the [JARVIS profile](../skills/jarvis-self-improvement/profiles/jarvis.json). A qualified controller supplies and digest-binds the selected trusted profile; it cannot grant policy, permissions, scope, budgets, approval or activation authority. Trusted bundle/profile loading and runtime enforcement remain future JV-053/JV-054 work, separate from contributor skills and the explicitly requested read-only PR analysis in F03.

The stable released controller retains trusted policy, credentials and the evaluator outside candidate write scope. Each campaign has one hypothesis, a durable proposal, a temporary integration branch and cumulative owner-configured scope/size/time/spend/attempt limits; each child retains its branch, sandbox and PR. Candidate integration is not Done. The [campaign design](self-improvement-campaigns.md) defines ownership, evidence, human promotion, delivery accounting and branch retirement. Main drift or conflicts freeze admission, trigger a separate reviewed repair branch, invalidate promotion eligibility and require renewed checks/comparison/review and current human approval within the same budget. Ambiguous intent, sensitive repairs or exhaustion hand off explicitly.

Merge and deployment remain separate states and permissions. A qualified limited-rollout profile must define artifact identity, environment, sample/window, success/abort criteria, task ownership, last-known-good artifact/config and schema compatibility. Replay/shadow evaluation cannot repeat mutating GitHub effects. Missing canary capacity, insufficient evidence or incompatible/irreversible migrations require a human recovery plan rather than claiming automatic rollback. No live self-update is enabled by this planning change.

**P12 measurable acceptance.** Duplicate/reordered events yield one durable proposal/campaign and at most one active promotion PR, with verified `self-update` label/project membership and equivalent content validation across clients. Pre-patch/rejected proposals create no empty PR or operational issue; ambiguous publication and conflicting claims reconcile before retry. Stale metadata and candidate skill/profile substitution cannot authorize work; missing, stale or untrusted profile digests yield a limited or human-required result. An eligible routine candidate cannot reach main without current human promotion approval; task integration cannot mark an undelivered campaign Done. Textual and semantic conflicts, main advancing during repair, conflicting claims, stale approvals/evidence, cancellation and lost merge responses preserve bounds and yield revalidation or handoff without an unauthorized effect. Promotion does not activate the candidate. A repeated-failure fixture creates one sourced proposal/campaign and, when real changes exist, at most one active promotion PR across duplicate/reordered observations; rejected/deferred work does not retrigger indefinitely. The same frozen comparison protocol accepts a genuine qualified improvement and rejects metric gaming, while sparse/noisy/missing evidence is explicitly inconclusive. Every revision, criterion, corpus or relevant profile change invalidates eligibility. All attempts consume the configured finite budget across retries/restarts; stop/revocation prevents new effects. At least 30 owner-agreed integrated success/adversarial/recovery cases and a controlled pilot cover accepted/rejected/inconclusive experiments, a sensitive human handoff, exhaustion and failed rollout/rollback with zero unauthorized effects. The UI/digest records sources, findings, comparisons, total cost and distinct merge/deployment results. Verified JV-044 delivery and D13 experiment-policy acceptance precede experiments; D13 rollout-policy acceptance separately precedes activation. See [architecture 12.9](technical-architecture.md#129-proposed-self-improvement) and the [shared design](autonomous-delivery.md#planned-self-improvement).

**Planned post-MVP: shared runtime and general-purpose assistance.** OpenCode handles conversation and tool selection as well as code missions under distinct trusted profiles; JARVIS retains durable memory, scheduling, secrets, budgets and effect authority. The first extension is authenticated conversation with approved read-only capabilities, qualified through weather in Nantes, France. It reuses the existing SDK adapter without a second conversational agent framework or Herdr dependency. Track [JV-064](https://github.com/grasdouble/Jarvis/issues/64) and children [profiles/policy](https://github.com/grasdouble/Jarvis/issues/65), [capability broker](https://github.com/grasdouble/Jarvis/issues/66), [conversation/context](https://github.com/grasdouble/Jarvis/issues/67) and [weather/pilot](https://github.com/grasdouble/Jarvis/issues/68) in J08. This plans capability, not an enabled runtime, new permission or v0.1 criterion.

**P13 user story.** I want to ask JARVIS an ordinary question, such as current weather in Nantes, and receive a sourced answer through authorized tools without giving that request access to my repositories, Mac or GitHub writes.

**P13 requirements.** Authenticate the request, create/reuse a durable owner/session turn, admit a released mission/profile/tool catalog and finite budget, run isolated OpenCode, validate tool requests in the core, execute only configured external calls through a trusted broker/executor, and return source/time/limitations with recorded usage. A simple answer can omit tool calls; fresh facts require an admitted source. Missing tools or ambiguous intent produce an explicit limitation or clarification. Models cannot install tools, select arbitrary endpoints, launch a broader profile or convert external text/memory into permission. General requests need no fabricated repository or issue; code work becomes a separately authorized mission with exact revisions and its own gates.

Maintain separate conversation and repository memory scopes with bounded context, provenance and accepted retention/forgetting; no reusable personal knowledge or persistent history is enabled before its policy is accepted. Keep agents without permanent credentials, host/repository access or direct networking. Qualify a narrow tool bridge separately from the model gateway; native OpenCode permissions alone do not prove isolation. Preserve cumulative model/tool costs, finite limits, stop/revocation and uncertain-effect reconciliation across duplicate messages, retries, disconnects, restarts and restore. Arbitrary browsing/shell, mutating personal integrations, external notifications and unattended personal monitoring remain excluded from this first extension.

**P13 measurable acceptance.** A controlled Nantes request yields a validated location/period, units, source, observation time where available, retrieval/cache freshness and a grounded answer or explicit limitation. Equivalent repeated client messages reuse one turn; unknown effects reconcile before bounded/accounted retries. The accepted corpus covers ambiguous place/time, stale/missing data, outages/rate limits, malformed/oversized/hostile output, forged identity/profile/catalog, unauthorized tools/destinations, cross-session/repository context, quota exhaustion, stop/deletion and pre-deletion restore, with zero unauthorized effects. Actual pinned runtime/Colima transport and egress tests demonstrate no host/LAN/core or credential access; simulated tests are identified separately. Repository authoring and self-improvement use the separately qualified J06/J07 profiles and gates. Record real pilot latency and all model/tool usage against owner-accepted D14 limits before explicit enablement; JV-025 delivery and the corresponding accepted D14 policy precede live execution. See the [detailed design](common-agent-runtime.md) and [architecture 12.10](technical-architecture.md#1210-proposed-shared-runtime-and-general-purpose-assistance).

**Planned post-MVP: Telegram and Signal channels (P14).** The owner wants opted-in outbound notifications first, then authenticated bidirectional text conversation through the same core. [JV-075](https://github.com/grasdouble/Jarvis/issues/75) coordinates shared policy/identity/inbox/outbox (JV-076), Telegram notifications (JV-077), Signal bridge qualification/notifications (JV-078), respective J08 conversation adapters (JV-079/JV-080) and integrated operations (JV-081). Neither channel requires the other; notifications wait on verified JV-025, while conversation additionally waits on verified JV-068 and accepted D14. Preserve the initial P13 slice: J09 provides a separately qualified transport, not an implicit expansion of its tools or authority. No J06/J07 dependency exists solely by milestone number.

**P14 requirements.** Pair the authenticated owner with explicit private sender/recipient identities, scoped consent and revocable bindings. Use trusted adapters with secrets/egress outside agents, durable intake and notification/answer intents, bounded retries, expiry/rate/budget controls and honest failed/unknown delivery. Reuse J08 memory/context/profile and F09 usage; do not create another agent loop. Channel text/buttons/reactions cannot satisfy native GitHub review or human sensitive approval; use existing authenticated UI/GitHub gates. Code work still requires available J06/D12, self-update retains J07/D13 and human promotion/separate activation. No groups, attachments/voice, account administration, arbitrary history import or implicit public administration access in the first integration. Signal's unofficial bridge candidate needs separate pinned feasibility and owner acceptance. See [the detailed contract](messaging-channels.md).

**P14 measurable acceptance.** Ten input events with two unsubscribed categories produce eight canonical notification intents; 100 replays add none. Repeated authenticated input 100 times creates one turn/allocation, with zero model/tool calls for rejected identities or payloads. Forgery/forwarding, echoes, edits/reordering, concurrent workers, lost acknowledgements, rate limits, stop/revocation, stale notices, outages/sleep and deletion/restore preserve scope and finite accounting; unknown sends never become assumed success or blind duplicate retries. Per-channel real pinned transport/Colima pilots precede owner enablement; at least 30 owner-agreed integrated success/adversarial/recovery cases verify zero unauthorized disclosure/action and SQL/usage agreement. Missing bridge feasibility leaves Signal unavailable without weakening boundaries or blocking independently qualified Telegram. D15 accepts accounts/transport, privacy/retention, numeric limits and corresponding pilot/activation before live work. These are future targets, not runtime evidence or a new MVP gate.

**Planned post-J05: task duration forecasting (P15).** [JV-084](https://github.com/grasdouble/Jarvis/issues/84) and children JV-085–JV-088 deliver measurements, an empirical estimator/API, task/queue presentation and calibration. Reuse F08/F09 timestamps, PostgreSQL and the existing core modules. Provide preflight/post-plan predictions, conditional remaining-time updates when supported and actual-versus-predicted comparison; future J08/J09 surfaces may reuse these results when available. Verified JV-025 precedes J10; no other phase is a prerequisite solely by its number. Forecasting is not a J05 acceptance criterion.

**P15 requirements.** Version task/attempt/request timing and observable provider/model/profile/effort metadata; unsupported values remain unknown. Separate execution elapsed from queue/CI/human/suspension and missing intervals; account for retries, failures/censoring, sleep and parallel critical paths without double counting. Predict from scoped comparable historical observations available at that instant, with a range/central estimate, sample/freshness/calibration provenance and explicit abstention for sparse/stale data. Preserve issued predictions and qualify chronological holdout error/coverage without future-feature leakage or hiding hard/failed cases. Current limits, provider/profile choices, priorities, memory/privacy and human/native approval gates remain authoritative. Forecasts cause no extra inference, automatic routing or budget/deadline extension. See the [duration contract](duration-forecasting.md).

**P15 measurable acceptance.** A synthetic cohort of 20 durations 10..200 seconds yields median 105 and nearest-rank p90=180; 100 replays add no sample/time. Parallel spans 0–20 and 0–30 seconds yield 30 seconds of parent execution elapsed. Empty/stale/changed-profile/unknown-effort and unauthorized-history cases do not get a calibrated label. Failures/censored outcomes and unknown waits remain visible; remaining-time updates are conditioned on observed work and survival, not simple subtraction relabelled as calibrated. API/UI snapshots match scoped SQL provenance through restart/clock gaps, sleep, deletion and restore; model/profile/budget/priority/approval rules remain authoritative. JV-088 freezes method/acceptance and records chronological holdout plus actual-runtime error/coverage before production estimates, without a universal accuracy promise. These are future targets, not measured performance.

**Later.** Multiple concurrent runs, dedicated Linux hosting, multiple projects or users, and planning of more complex work. Each extension requires a new threat assessment and its own criteria.

## 12 Decision register and fallback values

| ID | Decision | Proposal and owner | Deadline or fallback |
| --- | --- | --- | --- |
| D01 | Sandbox controller | Owner selected the dedicated containerized controller as the sole Engine-socket holder, with a closed API; recorded in [JV-005](https://github.com/grasdouble/Jarvis/issues/5#issuecomment-6264239969) on October 19, 2026 | J01; implement and qualify the restricted controller before project use; no Engine socket in API, worker, or agent |
| D02 | Providers and code processing | Owner selected GitHub Copilot and OpenAI as the only permitted provider configurations; trusted configuration selects exactly one, switching is explicit, private code is sent only to that selected provider, and automatic failover is forbidden. Owner decision: current delivery session and #15. | Selection is accepted; implementation and qualification of the isolated provider route remain required before any private content or billable dispatch |
| D03 | Repositories, branch, and required CI | Owner selected `grasdouble/Jarvis-Test` as the only initial project target; the owner reports a local checkout with only `README.md`. `grasdouble/Jarvis` is the product source repository, not the initial JARVIS-operated project. | J00 plan work requires authorized project access and approved provider/data processing; no development task or PR publication until product access, target base branch, required CI, and provenance are verified |
| D04 | Unsolicited event intake | None; tasks start from authenticated owner requests | No external event-intake endpoint is exposed |
| D05 | Consumption monitoring and spending controls | Owner selected provider-managed subscriptions/credits with no JARVIS monetary reservation/ceiling, billing/admin credential, billing API or quota polling. Usage/quota may be recorded only if returned by ordinary provider/runtime traffic, with provenance and freshness. Owner decision: current delivery session and #15. | Implement safe usage observation/accounting as separately scoped #301/JV-072 work; no inferred balance/invoice or JARVIS monetary enforcement |
| D06 | Colima deployment baseline | Owner accepted 4 VM CPUs, 8 GiB RAM if host capacity permits, an 80 GiB VM disk, at least 40 GiB free host disk, and a 2-CPU/4-GiB per-sandbox target; contributor-selected exact version pins are recorded in the [technical architecture §6](technical-architecture.md#6-colima-deployment-and-mac-isolation). The owner decision is recorded in [JV-004](https://github.com/grasdouble/Jarvis/issues/4#issuecomment-6255994904). | J01; verify ARM64 host capacity, effective VM settings and isolation. Do not silently lower the accepted allocation. |
| D07 | Product-side merge authority | None for v0.1 | JARVIS may open a validated PR; subsequent review and merge remain outside its authority |
| D08 | PR publication mechanism and permissions | Owner-selected dev-mode PR handoff; exact branch creation/push strategy and minimum GitHub App permissions remain to be qualified | Before enabling PR publication; no merge/bypass permission |
| D09 | Retention and backup | Owner; logs 30 days, reports/audit 90 days, 7 daily and 4 weekly dumps | J05; encrypted export to a dedicated directory |
| D10 | Local authentication | Developer; single account, strong password, and secure session | J02; administration inaccessible without authentication |
| D11 | Knowledge lifecycle and context budget | Owner; proposals 30 days, validated items reviewed at least every 90 days; 10 items / 4,000 tokens / 32 KiB per attempt | J03/J05; expired items excluded until revalidated; backup expiry and forgetting procedure documented |
| D12 | J06 writable delivery profiles, sensitive scope and finite budgets | Owner accepts the JV-045 threat/profile/policy proposal; routine autonomy with human sensitive gates is selected | Before writable J06 implementation; no writable/autonomous product run if unset |
| D13 | J07 self-improvement objectives, evaluator, scope and rollout | Owner accepts campaign scope/limits, metrics, samples, evaluator, exact-digest human promotion gate and remediation profile in JV-053; separately accepts rollout/recovery profile and authority in JV-055 | Experiment policy before JV-054 trials; rollout policy before activation. Missing decisions defer the corresponding action |
| D14 | Post-MVP general-assistance profile and capability policy | Owner accepts JV-065/JV-068 profiles, pinned tool transport/runtime, provider and data processing, finite model/tool/time/cost limits, freshness/cache/retention rules and controlled pilot | Before affected live calls, conversation persistence or profile enablement; missing decisions disable that capability, never widen the MVP |
| D15 | Telegram/Signal accounts, transport and channel policy | Owner accepts JV-076 policy and respective adapter pilots: pairing/recipients/consent, Signal bridge/account feasibility, intake method, disclosure/retention/expiry, finite limits, unknown-delivery/catch-up policy and per-capability enablement | Before corresponding account provisioning, data persistence or live sends/intake; conversation also retains D14/J08. No chat-based sensitive approval or public administration is selected |
| D16 | Repository command and validation execution | Owner accepts whether/how project commands, scripts, tests, dependency acquisition, and network access may run in a separately qualified credential-free profile | Before any product-side project command execution; until accepted and qualified, do not execute repository-provided commands |
| D17 | v0.1 project-request direction and project-skill consent | Owner selected explicit project-scoped `plan`/`dev` requests, internal JARVIS project authorization, explicit exact-revision approval before using project-skill instructions, and dev PR handoff without JARVIS merge; recorded in JV-124/JV-125 and the October 18, 2026 development conversation | Accepted product direction; implementation details remain subject to D01–D16 and applicable qualification/review gates |

### J00 decision status for JV-001

The owner selected `grasdouble/Jarvis-Test` as the only initial project target for the revised project-request MVP; `grasdouble/Jarvis` is the source repository used by contributors to develop JARVIS, not a project JARVIS will operate on. `Jarvis-Demo` is not selected. The owner reports that a local `Jarvis-Test` checkout contains only `README.md`; this has not been independently verified and does not prove GitHub/product-App access, branch protection, or qualification. The current owner clarification is recorded in [issue #1](https://github.com/grasdouble/Jarvis/issues/1#issuecomment-6254649247), superseding the earlier initial-project selection.

The owner selected GitHub Copilot and OpenAI as the two permitted providers. Trusted owner configuration selects one profile; switching requires an explicit configuration change, and private content may go only to that selection. There is no primary/secondary role or automatic failover. This resolves provider choice and data-processing selection for D02; it does not qualify a live route or authorize credentials/private content before the isolated transport gates pass.

Provider subscriptions and credits remain provider-managed under D05. JARVIS does not reserve/cap monetary amounts, use billing/admin credentials or APIs, or poll provider quota. Only provider usage/quota signals actually returned on ordinary runtime traffic may be recorded, with provenance, freshness and unknown states; no balance or invoice may be inferred. Detailed accounting is separately owned by #301/JV-072 and remains unimplemented.

`Jarvis-Test` is the only selected initial project for MVP requests. A `plan` request still requires verified authorized project access and an approved provider/data-processing route. The repository identity is selected, but product-App access, the `dev` base branch, required CI identities, and provenance must still be verified before a development task or PR publication. The README-only report is not evidence that those gates pass. D01's controller topology is selected; implementation and qualification of the restricted controller, plus D06's effective Colima configuration/isolation verification, remain J01 gates. Unsolicited events remain excluded under D04.

| Decision | Current disposition | Remaining gate |
| --- | --- | --- |
| D01 | Owner selected a dedicated containerized controller as the sole Engine-socket holder with a closed API in [JV-005](https://github.com/grasdouble/Jarvis/issues/5#issuecomment-6264239969) on October 19, 2026. | Implement and qualify the restricted controller at J01; the agent receives no Engine socket. This design selection alone does not qualify or activate the controller. |
| D02 | Owner selected GitHub Copilot and OpenAI as the two allowed configurations; trusted configuration chooses one, with explicit changes and no automatic failover. Private code may be sent only to the selected provider. | Keep dispatch disabled until the isolated egress route is implemented and pinned Colima/Lima bypass resistance is qualified; no live provider qualification is claimed. |
| D03 | `grasdouble/Jarvis-Test` is selected as the only initial project target; the owner reports its local checkout contains only `README.md`. `grasdouble/Jarvis` is the contributor source repository, not a JARVIS-operated project. | Verify product-App project access and configuration. Verify the target base branch, required CI identities, and provenance before any `dev` task or PR publication. |
| D04 | Start work only from authenticated owner requests; no unsolicited event intake. | Keep external event ingress disabled. |
| D05 | Provider-managed subscriptions/credits; no JARVIS monetary reservation/ceiling, billing/admin credential/API or quota polling. Actual usage/quota signals may be recorded only when returned by normal provider/runtime traffic, with provenance and freshness. | Detailed accounting remains #301/JV-072 work; no inferred balances, invoices, or charges. |
| D06 | Owner-selected 4-CPU/8-GiB (if available)/80-GiB VM baseline, >=40 GiB free host disk, 2-CPU/4-GiB sandbox target; contributor-selected version pins in architecture §6. | Verify actual host capacity, effective VM configuration, and isolation at J01; sandbox quotas remain a target until enforced and measured. |

This is a record of current owner direction and remaining J00 gates, not runtime implementation, provider qualification, budget enforcement, or permission to dispatch product tasks. Unresolved gates disable their dependent actions.

## 13 Release criteria

Version 0.1 is ready when F01, F03, F07–F14 and N01–N15 have acceptance evidence, milestone gates have passed, a restore has been completed, and the pilot has shown no out-of-policy action. The owner knows how to revoke the App, rotate secrets, suspend the system, and inspect opened PRs. Repository command execution is not required unless D16 is accepted and separately qualified; no executed-check claim is made without that gate.

The release package contains pinned images and versions, configuration without secrets, migrations, tests, installation and recovery guidance, the acceptance report, and accepted residual risks. Blocking open decisions must be resolved before enabling the corresponding behavior.

## 14 References and verification scope

Official documentation consulted on October 15, 2026; Colima references C1 through C4 were checked on October 16, 2026. The capabilities cited below were verified; the thresholds, profiles, estimates, and milestones in this PRD are proposed design choices. Reference identifiers are shared with the architecture document. API details must be tested against the versions pinned for development.

- **O1** [OpenCode Server](https://docs.opencode.ai/docs/server/): headless server, authentication, and HTTP API.
- **O2** [OpenCode SDK](https://docs.opencode.ai/docs/sdk/): TypeScript client for controlling the server.
- **G1** [GitHub REST Pull requests](https://docs.github.com/en/rest/pulls/pulls): merge permissions, expected head, and asynchronous merge tracking.
- **G2** [Validating GitHub webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries): HMAC signature over the received body.
- **G3** [GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks): asynchronous processing, delivery identifier, and redelivery.
- **G4** [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches): required checks and branch protection.
- **G5** [Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks): evaluated SHA, check origin, and test merge commits.
- **C1** [Colima runtimes](https://colima.run/docs/runtimes/): Docker runtime and Compose compatibility.
- **C2** [Colima profiles](https://colima.run/docs/profiles/): separate VMs, resources, and Docker contexts.
- **C3** [Colima configuration](https://colima.run/docs/configuration/): mounts, agent forwarding, and platform settings.
- **C4** [Colima Lima configuration implementation](https://github.com/abiosoft/colima/blob/main/environment/vm/lima/yaml.go): default mount behavior and guest/host socket forwarding; verify against the pinned release.
