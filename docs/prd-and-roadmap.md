# JARVIS v0.1 PRD and roadmap

Document version 1.9 • October 16, 2026 • Personal self-hosted product

## 1 Vision and intended outcome

JARVIS is an autonomous assistant whose first specialization is managing software development projects on GitHub. A planned post-MVP extension uses the same OpenCode engine for general-purpose conversation through separately authorized capability profiles. Its first objective is to reduce the time spent on Dependabot updates while keeping merge decisions explainable and controlled. It detects a PR, has OpenCode analyze its contents in a dedicated sandbox, applies deterministic rules, and merges only when every condition is met. A daily digest makes actions, blockers, and spending visible.

The product runs on a MacBook M2 Pro with Docker Engine inside a dedicated Colima VM profile named `jarvis`. Docker Compose deploys the persistent services; Docker Desktop is not required. The core is built in-house in TypeScript and Node.js, in a PNPM monorepo organized as a modular monolith. PostgreSQL stores state and the work queue; React provides the interface. OpenCode is the shared headless agent runtime, controlled through its SDK or API: no plugin and no dependency on a personal OpenCode session. The MVP admits only static code review; future conversation, author/reviewer and self-improvement profiles retain separate qualification, tools and authority.

This document defines product behavior, acceptance criteria, and the path to v0.1. The separate [JARVIS v0.1 Technical Architecture](technical-architecture.md) document describes the contracts, trust boundaries, and mechanisms needed to meet these commitments.

**Launch principle.** Version 0.1 starts in observation mode, then goes through a human approval phase before explicitly enabling automerge for an authorized subset of patch updates. A favorable LLM recommendation is required under this profile, but is never sufficient to authorize a merge.

Contributor changes use the [governance procedure](project-governance.md) to trace affected requirements/decisions and maintain relevant documents/backlog with actual authority and evidence. The [ADR index](adr/index.md) preserves significant technical decision history; Dxx entries remain the separate owner-decision register. This contributor process adds no product feature, runtime permission, semantic CI guarantee or MVP exit gate.

## 2 Initial decisions and product assumptions

### 2.1 Established constraints

- Local hosting on a Mac M2 Pro using Colima with the Docker runtime, a dedicated `jarvis` profile, and macOS directory sharing disabled at VM level. No personal folders are mounted into agents.
- A separate ephemeral sandbox for each task attempt; no Docker socket or GitHub secret in OpenCode.
- In-house orchestration, approval rules, memory, budgets and tracking; the MVP OpenCode profile is limited to static code analysis. A common runtime does not imply shared permissions between future profiles.
- Interchangeable LLM providers through configuration and adapters, with explicit authorization for destinations receiving private code.
- A GitHub App installed only on selected repositories, with minimal permissions and no ability to bypass protections.
- An MVP covering Dependabot monitoring, OpenCode reviews, strict automerge, and a daily digest.

### 2.2 Proposed assumptions for sizing the MVP

The values below are design targets to confirm at milestone J0; they are not measured performance results.

| Parameter | Proposed initial value |
| --- | --- |
| Users | One owner and a single administrator account |
| GitHub hosting | GitHub.com; GitHub Enterprise Server deferred |
| Pilot repositories | 1 initially, then 3 to 5 explicitly selected repositories |
| Nominal volume | 20 PRs per day, with a peak of 50 events in one minute |
| Automerge ecosystem | npm / PNPM, stable SemVer releases, patch updates only |
| Concurrency | One OpenCode sandbox at a time |
| Per-attempt quotas | 2 vCPUs, 4 GiB RAM, 256 processes, 30 minutes |
| Review profile | Static analysis, without installing or executing repository code |
| Reconciliation | Every 15 minutes while the Mac and Docker are running |
| Daily digest | 08:00, Europe/Paris time zone, available in the interface |
| Indicative budget | 2 currency units per review, 10 per day, 100 per month |

Budgets use the billing currency selected during configuration and include every attempt. No current provider price is assumed. The Mac's total memory is unknown, so quotas remain subject to measurement on the actual machine.

## 3 User and problems to solve

The owner maintains several repositories and wants to delegate repetitive tasks without giving an agent general access to the Mac or GitHub. They must be able to understand quickly why a PR was merged, rejected, or left pending. They must also be able to stop actions and control costs.

The priority problems are a backlog of dependency PRs, repetitive verification work, information scattered across GitHub and agent runs, and limited visibility into the consequences of automation. Autonomy is therefore measured by tasks correctly handled within the authorized scope, rather than by the number of actions performed.

### 3.1 Main user journey

1. The owner installs the GitHub App on a pilot repository and configures the expected checks, eligible dependencies, and budget.
2. JARVIS receives an authenticated webhook or detects a PR during reconciliation.
3. It verifies the Dependabot identity and metadata against GitHub, prepares a snapshot bound to the head and base SHAs, and starts OpenCode.
4. The interface displays the report, evidence, analysis limitations, and policy decision.
5. Depending on the repository mode, JARVIS waits for a human decision or requests a merge from GitHub after checking the conditions again.
6. The next day's digest shows the actual observed outcome, failures, and cost.

## 4 Scope and exclusions

### 4.1 Included capabilities

Version 0.1 monitors Dependabot PRs in authorized repositories, analyzes each relevant revision, proposes a decision, and can merge a strictly limited subset of patch updates. It provides a local interface, history, approvals bound to a specific revision, budgets, and an emergency stop. Webhooks are complemented by periodic reconciliation and reconciliation on restart.

A review may cover PRs that are ineligible for automerge: a major update can receive a report, but its merge remains manual in GitHub. The first automated classification adapter is limited to npm manifests and the PNPM lockfile. Other formats remain visible, with an explanation of their ineligibility.

The MVP also includes JARVIS-owned durable memory: task checkpoints, operational history, a bounded collection of repository knowledge, and explicit preferences. Only the core selects and persists reusable context; OpenCode sandboxes remain ephemeral. Knowledge retrieval starts with repository-scoped structured filters and PostgreSQL text search.

### 4.2 Explicit v0.1 exclusions

- General-purpose conversation, weather or other external personal capabilities; these are separately planned in J8.

- Autonomous issue resolution, feature development, CI repair, or code modification and publication by the agent.
- Model fine-tuning, a vector database, automatic knowledge promotion, unrestricted conversation retention, or cross-repository knowledge sharing.
- An OpenCode plugin, control of the owner's personal OpenCode instance, cooperating agents, or a general-purpose planner.
- Automerge of major/minor releases, prereleases, grouped updates, Git or URL dependencies, other ecosystems, or workflow changes.
- Merge queues, stacked PRs, forks, automatic branch updates, rebasing, or conflict resolution.
- Running repository scripts, tests, or installation steps in the MVP profile; test evidence comes from approved GitHub CI.
- GitHub administration, changing protections, software deployment, or access to macOS, SSH, the Keychain, or personal folders.
- Multi-user SaaS, high availability, or guaranteed operation while the Mac is powered off or asleep.
- Telegram, email, or Slack delivery. External notifications can be added after selecting a channel; the web digest is sufficient for the MVP.

## 5 Operating modes and decision policy

### 5.1 Progression toward greater autonomy

| Repository mode | Analysis | GitHub writes | Merge |
| --- | --- | --- | --- |
| Observation | Yes | None | None |
| Assisted | Yes | Optional report, enabled separately | JARVIS approval required for an eligible PR |
| Limited automerge | Yes | Optional report | Automatic if every control passes |
| Suspended | No new task | No new action | No new request |

Optional publication uses a review comment, never a GitHub approval intended to satisfy a required review rule artificially. Human reviews required by GitHub remain mandatory.

### 5.2 Cumulative merge conditions

**POL 01.** The repository, installation, and target branch are authorized; the mode is active; the global action switch is enabled; and budget is available. The PR is open, is not a draft, originates from the same repository, and its author matches the verified GitHub identity of Dependabot. A title or label never proves that identity.

**POL 02.** A single authorized direct dependency receives a stable patch update. The diff contains only the expected manifests and lockfiles. The parser determines the old and new versions and detects unrelated changes, scripts, registries, or sources. If the lockfile is incomplete, too complex, or changes dependencies outside the permitted scope, the decision is "needs review."

**POL 03.** The OpenCode report is valid, complete within its declared limits, and bound to the current head H and base B; it contains no blocking finding or reported uncertainty. A model verdict does not replace CI or repository rules.

**POL 04.** Every required check appears in an approved list with its expected provenance. All required results are completed and explicitly successful; failure, absence, pending status, cancellation, neutrality, or skipping prevents automerge. Legacy commit statuses are evaluated with their context and issuer. GitHub App provenance is a minimum requirement: for GitHub Actions, the expected workflow must also be identified.

**POL 05.** GitHub protections enforce checks, required reviews, and an up-to-date branch relative to the base; JARVIS is absent from every bypass list. A repository whose effective rules cannot be established stays in observation mode. If GitHub evaluates a test merge commit, its evidence is considered; an ambiguous SHA blocks the merge.

**POL 06.** There is no active request for changes, unresolved required conversation, conflict, or unknown mergeability state. In assisted mode, an authenticated, unexpired approval matches the same H, B, report, and rule set.

**POL 07.** A final GitHub read and a new policy evaluation occur less than 60 seconds before the merge request. The request specifies the expected head, allows no bypass, and is considered successful only after remote confirmation. The SHA parameter protects the head; it does not atomically compare the base. GitHub protections provide the final enforcement barrier. [G1](https://docs.github.com/en/rest/pulls/pulls), [G4](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [G5](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

A human decision cannot override these conditions inside JARVIS. The owner may handle an exception directly in GitHub under their own permissions; JARVIS subsequently records it as an external action.

### 5.3 Decision validity and stopping

A change to the head, base, report, or policy invalidates every pending local decision. Changes to checks or reviews trigger reevaluation. Approvals expire after 24 hours; review evidence also expires after 24 hours, even if the SHAs have not changed.

The emergency stop prohibits any new remote request and revokes task capabilities; it initiates sandbox shutdown. A request already accepted by GitHub may still complete: the interface must show operations awaiting confirmation and must never promise to cancel them.

## 6 Functional requirements and acceptance criteria

### F01 Configure authorized repositories

**User story.** As the owner, I want to select repositories and rules so that I delegate only the intended operations.

**Requirements.** Installing the App and enabling JARVIS are separate steps. A newly installed repository starts in observation mode. Configuration exposes the branch, dependencies, paths, expected checks and workflows, LLM provider, limits, and policy version. Every sensitive change is audited.

**Acceptance.** Across 10 events from repositories outside the selection, no sandbox or GitHub action is created. Enabling automerge is rejected if the check list is empty or the required protections cannot be verified. The interface shows the App's scope and the permissions actually needed.

### F02 Detect and reconcile Dependabot PRs

**User story.** I want updates to be detected even after an interruption on the Mac.

**Requirements.** Signed webhooks, durable storage before acknowledgment, deduplication by delivery identifier, reads of current GitHub state, and a scan of open PRs every 15 minutes. An updated PR supersedes the previous task.

**Acceptance.** A set of 100 events, including 30 duplicates and 20 out-of-order deliveries, produces only one logical task per revision and profile. A PR missed during one hour offline is visible within 15 minutes of recovery, excluding GitHub rate limiting. A missing or invalid signature triggers no processing. [G2](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [G3](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)

### F03 Perform an isolated review

**User story.** I want useful analysis without exposing my Mac or merge permissions to the agent.

**Requirements.** Each attempt uses a new environment, a fixed snapshot, and a controlled OpenCode configuration. The report contains a summary, examined files, findings with location and severity, limitations, separately referenced CI evidence, and a structured recommendation. The initial profile requires no dependency installation.

**Acceptance.** A patch fixture produces a report bound to H and B with verifiable paths. Invalid JSON or a truncated diff never produces an "allowed" verdict. The attempt stops at 30 minutes; its resources are removed within 5 minutes when Docker is responsive. Isolation tests N01 through N03 pass before the pilot. [O1](https://docs.opencode.ai/docs/server/), [O2](https://docs.opencode.ai/docs/sdk/)

### F04 Apply explainable rules

**User story.** I want to see the exact reason for a decision and the evidence supporting it.

**Requirements.** The engine returns allow, deny, or needs_human with stable reason codes, evidence, and the policy version. It executes no instruction from the report. Any unknown information prevents a merge.

**Acceptance.** The same fixed inputs always produce the same decision. A suite of at least 50 cases covers every POL condition and its failure cases. Displayed reasons distinguish missing checks, major updates, a new SHA, incorrect provenance, exhausted budget, and unreadable protections.

### F05 Manage approvals

**User story.** I want to approve a specific action after reading its report and be able to reject it.

**Requirements.** The approval view shows the repository, PR, H, B, report, reasons, cost, and expiry. Rejecting or suspending an action is possible without rerunning the model. An approval applies only to the named action and grants no additional permission.

**Acceptance.** A change to H or B between display and confirmation returns a conflict without merging. A double click consumes only one approval. An unauthenticated session or a request without CSRF protection cannot approve. An expired decision is never reused.

### F06 Merge and verify the outcome

**User story.** I want eligible patch updates to be integrated without repetitive verification, with a reliable audit trail.

**Requirements.** JARVIS alone holds merge authority, rechecks the evidence, and records the intent before the call. It then tracks remote state. An asynchronous acceptance response does not mean a merge succeeded.

**Acceptance.** Cases involving a changed head, changed base, degraded check, revoked approval, or blocking protection either prevent the request or make it fail on GitHub. A failure after the call does not cause a blind retry: the result is read again. The final record retains the merge SHA, method, evidence, and actor; simulated merges are never counted as real ones. [G1](https://docs.github.com/en/rest/pulls/pulls)

### F07 Produce a daily digest

**User story.** I want to understand within a few minutes what happened and which decisions need my attention.

**Requirements.** One digest per local date and scope groups detected PRs, reviews, confirmed merges, rejections, pending human decisions, incidents, tasks exceeding budget, and known or estimated spending. Each item links to its details. Totals come from PostgreSQL; LLM-written prose is optional.

Include token totals/breakdowns and estimated/unknown coverage from the same F09 ledger, including retries, failures and optional digest-generation usage. Late usage revises the original period with a visible watermark/correction, without a duplicate digest.

**Acceptance.** A fixture containing 12 PRs, 4 merges, and 2 failures reproduces exactly those totals. A daylight saving time change does not create two digests. If the Mac is asleep at 08:00, a catch-up digest is available within 5 minutes of recovery and identifies the period without monitoring. Several missed days are grouped without losing events.

### F08 Supervise and stop

**User story.** I want to see tasks and be able to stop autonomous activity quickly.

**Requirements.** A dashboard shows repositories, PRs, runs, approvals, health, budgets, the last reconciliation, and unconfirmed remote operations. Global stop and per-repository suspension are available. A redacted text or JSON report can be downloaded.

**Acceptance.** The durable stop takes effect for new calls in less than 2 seconds; process shutdown is requested within 10 seconds if components are responsive. Restarting preserves the suspended state. The interface distinguishes waiting for capacity, an unavailable dependency, permanent failure, and an unknown remote result.

### F09 Switch providers and control costs

**User story.** I want to choose a provider and know how much autonomous activity costs.

**Requirements.** The model and provider are selected per profile. Required capabilities, limits, and confidentiality rules are verified. No fallback to an unauthorized provider is allowed. Limits reserve the maximum estimated cost before starting and account for retries and digests.

Track each dispatched model request durably with provider/model, purpose, task/attempt and authorized repository/PR attribution. Preserve input/output totals, cache read/write and reasoning breakdowns where supported, without adding overlapping categories. Missing values are unknown/unsupported rather than zero; reported counts, estimates, reservations and monetary valuations remain distinct. Count failures, cancellations, retries and future agent/parent overhead once per actual request. Authenticated consumption views and exports support daily/monthly summaries and drilldown; no prompt or code content is needed for tracking. The [accounting contract](token-consumption.md) defines provenance, reconciliation, privacy and reuse by later capabilities.

**Acceptance.** Two authorized providers pass the same report contract test without changing the business domain. An incompatible provider blocks the task cleanly. Once the limit is reached, no new billable request is sent; a request already in flight may exceed its estimate and remains displayed as such.

Provider usage mappings and missing-value cases pass the accounting fixtures. Replaying a final observation 100 times or combining SDK/gateway observations never duplicates consumption; a separately billed retry does. A fixture of 1,000/100 plus 2,000/300 input/output tokens remains exactly 3,000/400 despite cache/reasoning subsets. Two concurrent 6-unit reservations against 10 available admit at most one, including restart/recovery cases. Unknown in-flight exposure remains accounted for. SQL, API, UI and digest totals agree with explicit period/currency/coverage; known persisted usage is visible within 60 seconds under normal operation. These are implementation targets, not current results; D05 retains actual limits/prices.

### F10 Retain and reuse controlled memory

**User story.** I want JARVIS to remember useful project context and past incidents across restarts and provider changes, and to let me inspect, correct, or forget it.

**Requirements.** PostgreSQL stores four distinct categories: task progress, historical outcomes, reusable repository knowledge, and explicit preferences/policies. Every reusable item has a source, repository, date, applicability conditions, version, and status. Agent conclusions remain observations or hypotheses until the owner validates them. Validation does not turn text into executable instructions, CI evidence, permissions, or approval. Current GitHub facts and deterministic policy remain authoritative for actions.

Before an attempt, the core retrieves only applicable, non-expired knowledge from the authorized repository and constructs a bounded context with citations. The initial additional-memory budget is at most 10 items, 4,000 tokens, and 32 KiB, within the runtime's total context allowance. Summaries remain linked to their sources and do not replace evidence. The authenticated interface supports creation, inspection, validation, correction, invalidation, and deletion. A provider change rebuilds context from JARVIS storage rather than relying on provider conversation history.

**Acceptance.** A two-repository fixture returns zero items from the other repository. All selected items have a source and version recorded in the task's context manifest. Expired, invalidated, deleted, or inapplicable items are never selected; contradictory applicable items are identified rather than silently collapsed. Attempts remain within all configured memory limits. An agent-written instruction to change merge policy creates neither a rule change nor an approval. A restart and provider switch preserve validated knowledge and task history; a new attempt uses fresh GitHub facts. Deletion removes an item and its search representation from active retrieval within 60 seconds, cancels affected active attempts, and leaves only content-free audit metadata. Restore acceptance verifies that forgotten items are not reactivated.

## 7 Non-functional requirements

| ID | Requirement | Acceptance measure |
| --- | --- | --- |
| N01 | Restrict Mac access | No macOS directory shares in the effective Colima VM configuration; no personal bind mount, device, Docker socket, privileged mode, or host namespace in 100% of inspected sandboxes |
| N02 | Isolate networking | Every direct access attempt from a sandbox to the Mac, LAN, Internet, external DNS, PostgreSQL, and other tasks fails, including IPv4 and IPv6 |
| N03 | Protect secrets | No real GitHub or provider secret in the environment, files, logs, or reports accessible to the agent; tested with canary secrets |
| N04 | Responsive ingestion | Webhook acknowledged in less than 2 seconds at p95 across 1,000 events at nominal volume, after persistence |
| N05 | Freshness | Queued within 60 seconds at p95 after valid receipt while the system is running; reconciliation lag below 15 minutes outside external outages |
| N06 | Analysis duration | 90% of fixtures with diffs below 200 KB complete within 10 minutes; hard limit of 30 minutes per attempt |
| N07 | Local availability | Successful probes at least 99% of the time over 7 days while the Mac is awake, Docker is running, and networking is available; downtime excluded and displayed |
| N08 | Recovery | Backup RPO of 24 hours, target RTO of 60 minutes after the Mac and dependencies become available; restore rehearsed before release |
| N09 | Traceability | 100% of GitHub writes linked to an intent, policy, actor, evidence, and a confirmed or unknown result |
| N10 | Maintainability | Tested adapter contracts, versioned migrations, reproducible ARM64 installation, and recovery documentation |
| N11 | Confidentiality | Provider authorized per repository, configurable retention, sanitized HTML, and no telemetry containing code by default |
| N12 | Resources | One sandbox, enforced limits; stop new starts with less than 10 GiB free in the VM or insufficient capacity |
| N13 | Memory integrity | 100% of reused items have repository scope, provenance, applicability, and version; no memory text can grant action authority; deletion and restore tests pass |

Colima provides the Linux VM hosting Docker Engine; the selected Docker runtime supports the Docker CLI and Compose. Use a dedicated profile, disable directory sharing with `mounts: null`, and verify the effective guest mounts before J1 acceptance. An empty `mounts: []` retains default sharing and is not an isolation control. Containers still share the guest kernel, and the sandbox controller remains highly privileged. This design assumes neither Docker Desktop Enhanced Container Isolation (ECI) nor equivalent additional isolation in Colima. A dedicated profile reduces exposure to unrelated containers but does not guarantee protection against VM, kernel, or controller compromise. [C1](https://colima.run/docs/runtimes/), [C2](https://colima.run/docs/profiles/), [C3](https://colima.run/docs/configuration/), [C4](https://github.com/abiosoft/colima/blob/main/environment/vm/lima/yaml.go)

## 8 Web experience and displayed information

The home screen prioritizes approvals, failures, and operations awaiting confirmation. A PR view distinguishes GitHub facts, model analysis, and the policy decision. Full SHAs are available; file and check links point to the reviewed revision.

A consumption view shows input/output tokens, supported cache/reasoning breakdowns, provider/model, task purpose, known/estimated/unknown coverage and reserved versus estimated/provider-reported spending. Period and repository/PR/task filters support drilldown; future agent/campaign views reuse it when delivered. Parent totals and child details cannot be added twice. Currency, price version, freshness and retention gaps remain visible; token savings alone do not prove quality gains.

Configuration must explain the permissions actually granted. Observation mode remains visible at all times. Enabling automerge shows the precise scope: repository, branch, patch updates, dependencies, expected CI, and limits. Blocking messages must suggest a useful action, such as "expected CI check missing" or "head changed; new analysis pending."

A repository memory view shows each item, source, status, applicability, review date, and tasks that used it. The owner can validate, correct, invalidate, or forget an item. The task view identifies which memory versions were supplied and any omissions caused by context limits.

The interface remains locally accessible through a browser and uses an authenticated session. Only the webhook endpoint may be exposed through an HTTPS relay, separately from administration. No OpenCode or PostgreSQL port is published on the Mac.

## 9 Risks and mitigations

| Risk | Initial level | Mitigation and launch condition |
| --- | --- | --- |
| Escape or abuse of the Docker controller | Critical | Separate controller, closed API, no unrestricted Docker parameters, pinned images, no socket in core or agents; J1 security acceptance |
| Injection in PRs or files | High | Content always untrusted, controlled OpenCode configuration, no merge authority in the runtime, validated output; J3 adversarial corpus |
| Persistent memory poisoning or stale knowledge | High | Source-bound versions, repository isolation, human validation, applicability checks, expiry, no policy authority; F10 adversarial and forgetting tests |
| Merge using stale evidence | Critical | H/B binding, invalidation, final read, expected head, and strict GitHub protections; J4 race tests |
| Malicious dependency despite a patch update and green CI | High | Narrow allowlist, diff/lockfile inspection, approved CI, assisted pilot; residual risk explicitly accepted before enabling automerge |
| Code disclosure to a provider | High | Providers authorized per repository, context limits, no implicit fallback; J0 confidentiality validation |
| Sleep, Docker outage, or network loss | Medium | Reconciliation, expiring leases, catch-up, unknown-result states; J2/J5 recovery tests |
| Excessive LLM spending or retries | Medium | Reservations, request/token limits, visible estimated cost; J3 budget-limit exercise |
| Incorrect CI provenance | High | Bound check, issuer, workflow, and SHA; no self-approval; J4 pilot repository audit |
| Networking and OpenCode transport complexity | High | Early isolated prototype; remain in observation mode if the safe transport cannot be validated |
| Personal maintenance burden | Medium | Monolith, one worker, no distributed bus or general-purpose planner in v0.1 |

## 10 Success metrics

Metrics are calculated per period and repository. The autonomy rate uses PRs actually eligible for the authorized scope as its denominator, rather than all Dependabot PRs. Costs include failed attempts.

| Metric | v0.1 release target |
| --- | --- |
| Merge action outside policy | Zero across the entire pilot and acceptance corpus |
| Duplicate GitHub effect caused by the system | Zero duplicate merges and zero duplicate comments in tested failure scenarios |
| Recovery of a missed PR | 100% of the corpus within N05's deadline after recovery |
| Useful report | At least 18 of 20 pilot reviews judged useful by the owner |
| Finding quality | No known critical finding omitted from the reference corpus; every uncertain case blocks |
| Human effort | Target 50% reduction in median time across 20 comparable PRs, against a baseline recorded in observation mode |
| Cost | At least 95% of reviews within the configured per-review limit; every overrun explained |
| Limited autonomy | At least 80% of eligible patch updates handled without intervention after activation |

These targets do not prove the absence of regressions. The corpus includes healthy changes, known breaking changes, injection attempts, and ambiguous cases; an LLM score alone does not measure safety.

## 11 Roadmap and milestones

Initial estimate for one person working full time: 8 to 10 weeks, excluding waits for permissions, budget, or availability. Weeks are relative to the start; no fixed calendar is committed. The critical path requires isolation, the OpenCode contract, and GitHub protections before automerge.

| Milestone | Period | Deliverable | Exit gate |
| --- | --- | --- | --- |
| J0 Scoping | Week 1 | Pilot repository, authorized scope, budget, data policy, test App | Decisions D01 through D06 recorded; check criteria known |
| J1 Isolation | Weeks 1 to 2 | Controller, ARM64 sandbox, LLM gateway, stop and cleanup | N01 through N03 pass; no Mac or Docker socket access from the agent |
| J2 Observation | Weeks 3 to 4 | Webhooks, reconciliation, storage, queue, and minimal UI | F01/F02, duplicates, reversed order, and recovery validated |
| J3 Review | Weeks 5 to 6 | OpenCode adapter, report, budget, bounded memory retrieval, and PR screen | F03/F04/F09 plus F10 retrieval and validation; adversarial corpus, memory isolation, and two providers validated |
| J4 Assisted actions | Weeks 7 to 8 | Approvals, intents, and verified merge on a test repository | F05/F06; SHA races, CI, and failures covered; at least 20 PRs observed |
| J5 v0.1 release | Weeks 9 to 10 | Pilot patch automerge, digest, memory management, backup, and operations guide | F07/F08/F10, forgetting and restore, 7-day pilot, and critical targets met |

Post-MVP tracking uses separate, undated native GitHub milestones. This mapping adds no v0.1 release criterion or calendar commitment:

| Milestone | Scope | Tracking |
| --- | --- | --- |
| J6 — v0.3 autonomous delivery | Bounded issue-to-PR delivery, independent review and guarded merge after the MVP gates | Parent [JV-044](https://github.com/grasdouble/Jarvis/issues/44), children JV-045–JV-048 |
| J7 — Post-v0.3 self-improvement | Evidence-driven improvement proposals, comparison and separately approved activation after v0.3 | Parent [JV-051](https://github.com/grasdouble/Jarvis/issues/51), children JV-052–JV-055 |
| J8 — General-purpose assistance | Shared OpenCode profiles, controlled read-only capabilities and authenticated conversation after the MVP; no committed version/date or dependency on J6/J7 solely by phase number | Parent [JV-064](https://github.com/grasdouble/Jarvis/issues/64), children JV-065–JV-068 |

Every repository issue must carry the appropriate native milestone under the [contributor policy](development-workflow.md#required-issue-milestones); body references alone do not assign it.

A failed security gate delays automerge. The system can remain useful in observation or assisted review mode; that mode is not a complete v0.1 until the requested safe merge capability has been validated.

### 11.1 Post-MVP evolution

**Proposed v0.2.** Evaluate semantic or hybrid memory retrieval against a labeled corpus before adding embeddings; keep the same provenance and authorization rules. Extend to other ecosystems and minor updates after operational feedback; merge queues and group checks; Telegram or another selected notification channel; test execution in a separate sandbox without an LLM key; better review evaluation.

**Planned v0.3 feature: bounded autonomous delivery.** Resolve an explicitly selected issue, prepare and publish a PR, obtain independent review, apply justified requested corrections, re-review each changed revision, and merge only eligible routine work. The owner selected autonomous routine delivery with human review retained for sensitive changes. This is a post-MVP commitment to plan and qualify, not an installed capability or a delivery date. Track the parent [JV-044](https://github.com/grasdouble/Jarvis/issues/44) and children JV-045 through JV-048. v0.1's exclusions, release criteria and static review profile remain unchanged.

**P11 user story.** I want an authorized issue delivered through independent review and bounded repairs without approving every routine PR, while retaining control of sensitive changes and spending.

**P11 requirements.** Separate author, read-only reviewer, credential-free test executor and trusted publisher/merge controller. Bind reports to exact head/base and policy; invalidate eligibility after any revision or material evidence change. Native GitHub approval is distinct from an agent assessment and remains subject to required reviewers. A model cannot grant publication/merge permission. Persist finite rounds, elapsed time and configured spend limits; stop/handoff on uncertainty, limited evidence, exhaustion, cancellation or revoked authority. Surface findings, fixes, costs and remote outcomes in the UI/digest.

**P11 measurable acceptance.** An authorized fixture issue produces one PR; a real blocking review finding triggers a tested fix and an independent new review before eligibility. Duplicate/reordered events and lost responses yield no duplicate PR or unauthorized merge. Routine eligibility requires current CI/provenance/protections and no blocking reviews; sensitive/unknown changes require current human approval. Every head/base change invalidates prior eligibility, and budgets/stop state survive restart. The agreed corpus contains at least 30 success/adversarial/recovery scenarios; a controlled pilot demonstrates correction/merge, sensitive handoff, exhaustion and lost-response recovery with zero unauthorized effects. Owner-approved profiles/budgets and the v0.1 gate precede writable implementation. See the [proposed architecture](technical-architecture.md#128-proposed-v03-autonomous-delivery) and [shared design](autonomous-delivery.md#product-v03-design-commitments).

**Contributor delivery available separately.** Agents developing JARVIS use the [session-driven independent review procedure](autonomous-delivery.md#contributor-review-loop). It is a development skill workflow with local host limitations; it does not establish that the sandboxed product feature is implemented.

**Planned after v0.3: evidence-driven self-improvement.** JARVIS may identify recurring failures, quality defects or inefficient work in its own authorized operational history, retain a sourced proposal and, under an accepted policy, improve its own code or versioned working configuration. Reuse the v0.3 delivery loop rather than granting an agent direct control over its running service. Track [JV-051](https://github.com/grasdouble/Jarvis/issues/51) with children [signals/proposals](https://github.com/grasdouble/Jarvis/issues/52), [evaluation/policy](https://github.com/grasdouble/Jarvis/issues/53), [controlled experiments](https://github.com/grasdouble/Jarvis/issues/54) and [rollout/qualification](https://github.com/grasdouble/Jarvis/issues/55). This is a planned post-v0.3 capability, not installed automation, a new MVP gate or a committed version/date.

**P12 user story.** I want JARVIS to propose and prove improvements to its own reliability, quality, duration or consumption while retaining control of objectives, permissions, spending and release activation.

**P12 requirements.** Observe → deduplicate a durable sourced proposal → authorize one bounded improvement campaign → integrate eligible task PRs into a temporary candidate branch → track real changes in one draft `self-update` main-promotion PR → independently review and compare the assembled candidate → require current human approval of promotion to main → separately authorize rollout/rollback. Every self-improvement promotion requires human approval, including routine changes; general v0.3 routine merging and current contributor delivery remain distinct. Define measurable objectives and quality/security guardrails before experimenting. Freeze incumbent/candidate revisions, workloads/corpus, environment/provider/evaluation profiles and decision criteria. Record sample sufficiency, variability, uncertainty and the total costs of every attempt, including failures. Missing, incomparable or inconclusive evidence yields no improvement eligibility; lower latency/tokens cannot compensate for dropped work, weaker tests or degraded correctness. A candidate cannot change its acceptance oracle to certify itself; reserved evaluation cases stay outside author context and writable scope.

The self-repository, target branch/paths and allowed actions require explicit policy. Keep the released core and trusted evaluator outside candidate writable scope. The author cannot approve itself, extend budgets, promote memory into authority, modify its own permissions or bypass protections. Sensitive/unknown changes, including criteria, execution/approval rules and credentials, retain current human approval. Scoped finite collection/proposal/experiment limits, cancellation and revocation survive restart. Existing memory validation/forgetting rules still apply; no model-weight training is implied.

Each actual improvement uses a detailed main-promotion PR labeled `self-update` and added to the [dedicated project view](https://github.com/orgs/grasdouble/projects/1/views/7); no operational issue or milestone is required. J7 issues remain the phase for building the capability. Before a real diff exists, keep sourced proposals and rejected/deferred dispositions in the durable ledger/UI, without an empty PR. Core enforces repository-scoped proposal/campaign uniqueness and at most one active promotion, retaining repair/supersession history. Browser and programmatic PRs use the same detailed content contract. Labels, views and skills cannot enforce or authorize this. The [versioned product skill source](../skills/jarvis-self-improvement/SKILL.md) prepares structured proposals/candidate artifacts under a qualified controller mission; trusted immutable bundle loading and runtime enforcement remain future JV-053/JV-054 work, separate from contributor skills and MVP static review.

The stable released controller retains trusted policy, credentials and the evaluator outside candidate write scope. Each campaign has one hypothesis, a durable proposal, a temporary integration branch and cumulative owner-configured scope/size/time/spend/attempt limits; each child retains its branch, sandbox and PR. Candidate integration is not Done. The [campaign design](self-improvement-campaigns.md) defines ownership, evidence, human promotion, delivery accounting and branch retirement. Main drift or conflicts freeze admission, trigger a separate reviewed repair branch, invalidate promotion eligibility and require renewed checks/comparison/review and current human approval within the same budget. Ambiguous intent, sensitive repairs or exhaustion hand off explicitly.

Merge and deployment remain separate states and permissions. A qualified limited-rollout profile must define artifact identity, environment, sample/window, success/abort criteria, task ownership, last-known-good artifact/config and schema compatibility. Replay/shadow evaluation cannot repeat mutating GitHub effects. Missing canary capacity, insufficient evidence or incompatible/irreversible migrations require a human recovery plan rather than claiming automatic rollback. No live self-update is enabled by this planning change.

**P12 measurable acceptance.** Duplicate/reordered events yield one durable proposal/campaign and at most one active promotion PR, with verified `self-update` label/project membership and equivalent content validation across clients. Pre-patch/rejected proposals create no empty PR or operational issue; ambiguous publication and conflicting claims reconcile before retry. Stale metadata and candidate skill substitution cannot authorize work. An eligible routine candidate cannot reach main without current human promotion approval; task integration cannot mark an undelivered campaign Done. Textual and semantic conflicts, main advancing during repair, conflicting claims, stale approvals/evidence, cancellation and lost merge responses preserve bounds and yield revalidation or handoff without an unauthorized effect. Promotion does not activate the candidate. A repeated-failure fixture creates one sourced proposal/campaign and, when real changes exist, at most one active promotion PR across duplicate/reordered observations; rejected/deferred work does not retrigger indefinitely. The same frozen comparison protocol accepts a genuine qualified improvement and rejects metric gaming, while sparse/noisy/missing evidence is explicitly inconclusive. Every revision, criterion, corpus or relevant profile change invalidates eligibility. All attempts consume the configured finite budget across retries/restarts; stop/revocation prevents new effects. At least 30 owner-agreed integrated success/adversarial/recovery cases and a controlled pilot cover accepted/rejected/inconclusive experiments, a sensitive human handoff, exhaustion and failed rollout/rollback with zero unauthorized effects. The UI/digest records sources, findings, comparisons, total cost and distinct merge/deployment results. Verified JV-044 delivery and D13 experiment-policy acceptance precede experiments; D13 rollout-policy acceptance separately precedes activation. See [architecture 12.9](technical-architecture.md#129-proposed-post-v03-self-improvement) and the [shared design](autonomous-delivery.md#planned-post-v03-self-improvement).

**Planned post-MVP: shared runtime and general-purpose assistance.** OpenCode handles conversation and tool selection as well as code missions under distinct trusted profiles; JARVIS retains durable memory, scheduling, secrets, budgets and effect authority. The first extension is authenticated conversation with approved read-only capabilities, qualified through weather in Nantes, France. It reuses the existing SDK adapter without a second conversational agent framework or Herdr dependency. Track [JV-064](https://github.com/grasdouble/Jarvis/issues/64) and children [profiles/policy](https://github.com/grasdouble/Jarvis/issues/65), [capability broker](https://github.com/grasdouble/Jarvis/issues/66), [conversation/context](https://github.com/grasdouble/Jarvis/issues/67) and [weather/pilot](https://github.com/grasdouble/Jarvis/issues/68) in J8. This plans capability, not an enabled runtime, new permission or v0.1 criterion.

**P13 user story.** I want to ask JARVIS an ordinary question, such as current weather in Nantes, and receive a sourced answer through authorized tools without giving that request access to my repositories, Mac or GitHub writes.

**P13 requirements.** Authenticate the request, create/reuse a durable owner/session turn, admit a released mission/profile/tool catalog and finite budget, run isolated OpenCode, validate tool requests in the core, execute only configured external calls through a trusted broker/executor, and return source/time/limitations with recorded usage. A simple answer can omit tool calls; fresh facts require an admitted source. Missing tools or ambiguous intent produce an explicit limitation or clarification. Models cannot install tools, select arbitrary endpoints, launch a broader profile or convert external text/memory into permission. General requests need no fabricated repository or issue; code work becomes a separately authorized mission with exact revisions and its own gates.

Maintain separate conversation and repository memory scopes with bounded context, provenance and accepted retention/forgetting; no reusable personal knowledge or persistent history is enabled before its policy is accepted. Keep agents without permanent credentials, host/repository access or direct networking. Qualify a narrow tool bridge separately from the model gateway; native OpenCode permissions alone do not prove isolation. Preserve cumulative model/tool costs, finite limits, stop/revocation and uncertain-effect reconciliation across duplicate messages, retries, disconnects, restarts and restore. Arbitrary browsing/shell, mutating personal integrations, external notifications and unattended personal monitoring remain excluded from this first extension.

**P13 measurable acceptance.** A controlled Nantes request yields a validated location/period, units, source, observation time where available, retrieval/cache freshness and a grounded answer or explicit limitation. Equivalent repeated client messages reuse one turn; unknown effects reconcile before bounded/accounted retries. The accepted corpus covers ambiguous place/time, stale/missing data, outages/rate limits, malformed/oversized/hostile output, forged identity/profile/catalog, unauthorized tools/destinations, cross-session/repository context, quota exhaustion, stop/deletion and pre-deletion restore, with zero unauthorized effects. Actual pinned runtime/Colima transport and egress tests demonstrate no host/LAN/core or credential access; simulated tests are identified separately. Existing static-review and future code/self-update gates still apply. Record real pilot latency and all model/tool usage against owner-accepted D14 limits before explicit enablement; JV-025 delivery and the corresponding accepted D14 policy precede live execution. See the [detailed design](common-agent-runtime.md) and [architecture 12.10](technical-architecture.md#1210-proposed-shared-runtime-and-general-purpose-assistance).

**Later.** Multiple concurrent runs, dedicated Linux hosting, multiple projects or users, and planning of more complex work. Each extension requires a new threat assessment and its own criteria.

## 12 Open decisions and fallback values

| ID | Decision | Proposal and owner | Deadline or fallback |
| --- | --- | --- | --- |
| D01 | Sandbox controller | Owner; dedicated container with Engine socket and closed API | J1; native option only if explicitly accepted |
| D02 | Providers and code processing | Owner; one primary provider and one authorized secondary | J0; no private code sent without selection |
| D03 | Repositories, branch, and required CI | Owner; one test repository, then a pilot | J0; observation if evidence is insufficient |
| D04 | Webhook reception | Owner; HTTPS relay limited to the webhook route | J2; reconciliation only in the meantime |
| D05 | Budget and currency | Owner; initial limits to adjust | J0; billable tasks suspended if no budget is configured |
| D06 | Colima version, RAM, and disk allocation | Owner; ARM64 measurements and effective VM configuration verification | J1; one task, lower quotas if necessary |
| D07 | Merge method | Owner; squash if permitted by the repository | J4; no merge if the method is undefined |
| D08 | Review publication | Owner; keep reports inside JARVIS initially | J4; no PR write permission without a need |
| D09 | Retention and backup | Owner; logs 30 days, reports/audit 90 days, 7 daily and 4 weekly dumps | J5; encrypted export to a dedicated directory |
| D10 | Local authentication | Developer; single account, strong password, and secure session | J2; administration inaccessible without authentication |
| D11 | Knowledge lifecycle and context budget | Owner; proposals 30 days, validated items reviewed at least every 90 days; 10 items / 4,000 tokens / 32 KiB per attempt | J3/J5; expired items excluded until revalidated; backup expiry and forgetting procedure documented |
| D12 | v0.3 writable delivery profiles, sensitive scope and finite budgets | Owner accepts the JV-045 threat/profile/policy proposal; routine autonomy with human sensitive gates is selected | Before writable v0.3 implementation; no writable/autonomous product run if unset |
| D13 | Post-v0.3 self-improvement objectives, evaluator, scope and rollout | Owner accepts campaign scope/limits, metrics, samples, evaluator, exact-digest human promotion gate and remediation profile in JV-053; separately accepts rollout/recovery profile and authority in JV-055 | Experiment policy before JV-054 trials; rollout policy before activation. Missing decisions defer the corresponding action |
| D14 | Post-MVP general-assistance profile and capability policy | Owner accepts JV-065/JV-068 profiles, pinned tool transport/runtime, provider and data processing, finite model/tool/time/cost limits, freshness/cache/retention rules and controlled pilot | Before affected live calls, conversation persistence or profile enablement; missing decisions disable that capability, never widen the MVP |

## 13 Release criteria

Version 0.1 is ready when F01 through F10 and N01 through N13 have acceptance evidence, milestone gates have passed, a restore has been completed, and the pilot has shown no out-of-policy action. The owner knows how to revoke the App, rotate secrets, suspend the system, and retrieve evidence for a merge.

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
