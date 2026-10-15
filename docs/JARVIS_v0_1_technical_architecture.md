# JARVIS v0.1 Technical Architecture

Document version 1.0 • October 15, 2026 • Companion to the PRD and roadmap

## 1 Summary of design choices

JARVIS is a TypeScript and Node.js modular monolith deployed as several Docker processes, separated by privilege level. PostgreSQL holds state, the work queue, and audit records. The API serves the React interface; a worker executes the MVP's fixed workflows. An adapter controls headless OpenCode in a new container for every review attempt. GitHub decisions and actions belong exclusively to the deterministic core.

The proposed profile for the Mac M2 Pro uses a sandbox with `network_mode: none`, no mounted macOS files, no GitHub secret, and no provider key. An LLM gateway dedicated to the attempt is accessible through a Unix socket shared in a Docker volume. A local HTTP relay lets OpenCode use it as a provider endpoint. A trusted controller, the sole holder of the Engine socket, transports session commands through a fixed relay launched by Docker exec. This combination avoids opening an OpenCode server on the Mac or granting a network route to the control plane.

This is a proposed architecture to implement. The JARVIS contracts, hardening profiles, and thresholds below are not guaranteed native capabilities of OpenCode or Docker. The J1 prototype must demonstrate feasibility with the selected versions; any failure keeps the product in observation mode. Requirements F01 through F09, N01 through N12, and POL 01 through POL 07 refer to the separate [PRD and roadmap](JARVIS_v0_1_PRD_and_roadmap.md).

## 2 Architecture decisions

| Decision | v0.1 choice | Consequence |
| --- | --- | --- |
| ADR 01 Organization | Modular monolith, multiple processes and privilege zones | One repository, one domain model, no requirement for microservices |
| ADR 02 Persistence | PostgreSQL and a durable SQL queue | No Redis or external bus initially |
| ADR 03 Runtime | OpenCode through SDK/API, with server and SDK pinned together | No OpenCode plugin or shared personal session |
| ADR 04 Authority | Policy Engine without an LLM; dedicated GitHub executor | A report cannot trigger a write directly |
| ADR 05 Sandboxes | One ARM64 container per attempt, without IP networking | Local relay and gateway transport to prototype |
| ADR 06 Controller | Trusted container with Engine socket and restricted API | Explicit privileged-component risk; no socket in API, worker, or agent |
| ADR 07 Review | Static repository analysis, no execution | Approved GitHub CI provides test evidence |
| ADR 08 Merge | Asynchronous GitHub API, expected head, no bypass | Remote confirmation required; queues and stacked PRs excluded |
| ADR 09 Operations | One task at a time, initial observation mode | Match Mac resources; enable autonomy per repository |

Node.js 24 LTS is the proposed core baseline; a patch version and ARM64 image are pinned at J0. The OpenCode runtime retains its own dependencies, with no assumption about its internal JavaScript engine. PNPM uses an explicit workspace and `workspace:` internal dependencies; versions and the lockfile are checked into version control. [T1](https://nodejs.org/en/about/previous-releases), [T2](https://pnpm.io/workspaces)

## 3 Topology and trust boundaries

### 3.1 Component view

```text
Mac M2 Pro
  Browser -> 127.0.0.1:3000 -> API + React interface
  Optional HTTPS relay -> webhook ingress only

Docker Desktop / Linux VM
  Private core network
    ingress -> API -> PostgreSQL
                    -> worker / scheduler
                         -> GitHub executor -> GitHub API
                         -> controller -> Docker Engine

  Ephemeral resources for each attempt
    controller -> fixed Docker exec relay -> OpenCode on loopback
    OpenCode [network none] -> loopback HTTP bridge -> Unix socket
        dedicated transport volume -> LLM gateway -> authorized provider
    repository snapshot in a dedicated volume, mounted read-only
    separate OpenCode state and temporary files, destroyed at completion
```

The controller shares no network with an agent. The LLM gateway has only an outbound network, with no access to the core network. The transport volume contains only its socket, never a key. The Docker exec channel is a trusted transport initiated by the controller toward an identified container; no Docker API is exposed back into the sandbox.

### 3.2 Boundaries and assets

| Boundary | Data crossing the boundary | Controls and residual risk |
| --- | --- | --- |
| Internet to ingress | Webhooks untrusted before validation | TLS, size, HMAC, event, and installation; a signature does not make PR text trusted |
| Browser to API | Session, decisions, and configuration | Authentication, CSRF, Origin checks, expiry, and audit log |
| Core to GitHub | Reads and write intents | Restricted App, scoped tokens, protections, expected SHA, and verified response |
| Core to controller | Identifiers and bounded profiles | mTLS, mutual authentication, idempotence, closed schema, and quotas |
| Controller to Engine | Creation, exec, and destruction | Highly privileged access; compromise may affect all containers and shareable files |
| Repository to runtime | Potentially hostile text and files | Sanitized snapshot, no configuration code loaded, tools denied by default |
| Runtime to core | Untrusted report and event streams | Schemas, limits, SHA/path cross-checks, and no action authority |
| Runtime to provider | Code excerpts and prompts | Fixed destination, bounded gateway, budget, and repository authorization; confidentiality also depends on the provider |

GitHub secrets, effective policy configuration, approvals, and the database are control-plane assets. Repository code may be confidential but remains untrusted for execution. The system does not treat a "private" repository or a "Dependabot" PR as a source of trusted instructions.

### 3.3 Covered threats and limitations

The threat model includes a malicious PR, hostile instruction file, compromised dependency, manipulated LLM report, replayed event, stuck task, and compromised agent process. Controls must confine a compromised agent to its snapshot, ephemeral state, and LLM request allocation.

The security of the Mac, Docker Desktop, the guest kernel, and approved images remains an infrastructure assumption. Containers share the VM's Linux kernel; an escape vulnerability or controller compromise goes beyond OpenCode permissions. A dedicated Linux machine or an independent VM with a dedicated engine is a future option for executing more hostile arbitrary code.

## 4 Sandbox manager options

### 4.1 Comparison

| Option | Engine access | Benefit | Limitation and decision |
| --- | --- | --- | --- |
| A Containerized controller | Engine socket mounted only in this service | Every JARVIS component containerized; simple deployment | Recommended for the MVP, but highly privileged access must be isolated and audited |
| B Small macOS service | User's Docker Desktop context socket, through launchd | No socket in application containers; separate controller | Native exception to the all-Docker objective; Mac maintenance and permissions must be accepted |
| C Engine in a dedicated VM | Authenticated API or private channel to a separate engine | Reduces exposure of personal Docker Desktop and other projects | More RAM and administration; later hardening target |
| D Generic Docker API proxy | Proxy in front of Engine | Can restrict verbs or endpoints | Insufficient on its own: a container-creation POST can request bind mounts or privileges; not a sufficient security boundary |

Do not use privileged Docker-in-Docker, `privileged` mode, an Engine socket in the worker, or an unauthenticated remote Docker API. A socket mounted `:ro` is not a read-only API: the mount restriction does not prevent mutation calls. The Docker daemon is a privileged control surface. [D3](https://docs.docker.com/engine/security/)

### 4.2 Recommended controller contract

The worker calls an mTLS API reserved for the core network. It sends no `HostConfig`, host paths, unrestricted image, shell command, or agent-requested network. A request contains a task identifier, validated snapshot identifier, approved image digest selected through a profile, deadline, and resource limit selected from a finite set. Unknown fields are rejected.

The controller checks profiles against its own read-only configuration, enforces maximum limits, and generates its own volume names, labels, and identifiers. It does not trust caller-selected names. Its operations are create, health check, open a runtime session through a bounded protocol, cancel, inspect state, and destroy. No general-purpose `exec(command)` endpoint is exposed.

It retains a minimal registry of managed resources and reconstructs state using the labels `jarvis.managed`, `task_id`, `attempt_id`, and `expires_at`. An Engine identifier returned by an agent is never accepted. Cleanup removes only resources whose identity and labels match the registry; it never runs a global prune.

The controller container runs neither OpenCode, repository code, nor LLM prompts. It uses a minimal image, installs no package at runtime, publishes no port, and runs under a user with only the Unix socket access it needs. That access remains powerful despite the other hardening measures. With ECI, the socket-mount policy must be verified: any exception must target only the controller image and must not disable ECI globally. [D2](https://docs.docker.com/desktop/enterprise/hardened-desktop/enhanced-container-isolation/)

### 4.3 OpenCode transport without a control network

OpenCode listens only on `127.0.0.1:4096` inside its sandbox and requires a random per-attempt password. Through Engine, the controller invokes a fixed relay binary shipped in the image, with framed input and output. The relay communicates with the local server and transports the necessary operations: health, session creation, prompt, message/event reads, status, and cancellation. Remote URLs, arbitrary paths, configuration changes, MCP additions, and shell endpoints are prohibited by the JARVIS protocol.

The adapter can use `createOpencodeClient` with a `fetch` transport adapted to relay requests, or a limited HTTP mapping inside the same adapter. The SDK documents a client connected to an existing server and a customizable transport. The prototype checks streams, deadlines, backpressure, cancellation, and errors before this choice is pinned; no extension of OpenCode itself is required. [O2](https://docs.opencode.ai/docs/sdk/)

This transport requires additional JARVIS code. If streaming proves too complex, the first profile can use bounded messages with status polling. It keeps the same boundaries and does not publish the OpenCode port to work around the difficulty.

## 5 Sandbox profile and networking

### 5.1 Static sandbox

The controller applies the profile below to every review attempt. This example represents Engine constraints; it is not a complete Compose file for dynamically creating tasks.

```yaml
# Profile enforced by the controller
user: "10001:10001"
read_only: true
network_mode: none
cap_drop: [ALL]
security_opt: ["no-new-privileges:true"]
pids_limit: 256
mem_limit: 4g
cpus: 2
tmpfs:
  - /tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001
  - /run:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001
# Docker volumes created per attempt, with no macOS source
# /workspace    sanitized snapshot, read-only
# /state        dedicated XDG and HOME state, read/write
# /llm-transport Unix socket only, read-only on the agent side
# No ports, devices, Docker socket, host PID/IPC, or extra privileges
```

The profile retains default seccomp, without `unconfined`. It also sets an open-file limit and an Engine log limit. The state volume is bounded through size checks, deletion at expiry, and shutdown on overrun; an ordinary Docker volume does not itself provide a strict disk quota. Strict per-task disk allocation would require an additional compatible storage mechanism.

OpenCode's HOME and XDG config, data, and cache directories are explicitly redirected into `/state`. The authoritative configuration is shipped in the image or an immutable configuration volume. Business results return through the runtime protocol, not through freely selected paths. A read-only mount does not hide data: the agent can read everything its profile exposes.

### 5.2 Dedicated LLM gateway

The `none` driver leaves only loopback and provides no external network interface. [D4](https://docs.docker.com/engine/network/drivers/none/) The OpenCode container uses a local HTTP bridge on loopback, forwarding requests through the Unix socket in `/llm-transport`. The gateway, another trusted container dedicated to the attempt, listens on this socket and communicates with the provider over TLS. Mounting the directory read-only does not prevent socket connections; UID/GID permissions and Docker Desktop support are verified in the prototype.

The gateway exposes neither a CONNECT proxy nor an unrestricted destination URL. Its profile fixes the provider, base URL, model, permitted API routes, body size, request count, maximum tokens, concurrency, and deadline. It rejects redirects to other origins and any resolution to loopback, private, link-local, multicast, or metadata addresses; IPv6 and resolution after redirects are included. Destinations for a provider running locally on the Mac are prohibited by default and would require a separate network profile, still outside the MVP.

The actual provider secret resides in the gateway, injected at startup into memory or a tmpfs file with minimal permissions. The agent receives only a per-attempt capability with a bounded budget; if compromised, it can abuse that allocation but cannot obtain a permanent key. The gateway has no GitHub secret, PostgreSQL connection, or Engine socket. Its container is deleted and its capability revoked when the attempt ends.

The trusted secrets broker supplies the credential to the gateway through the controlled provisioning channel. A key appears in neither labels, command-line arguments, nor variables inspectable by the agent. The controller can still inspect resources through Engine, so it is inside the trusted secrets boundary. Per-project provider keys and provider-side limits reduce the consequences of its compromise.

### 5.3 Network variant and reasons for deferral

A variant using a Docker `internal` network, outbound proxy, and L3/L4 filtering can replace the socket if isolation is proven. `HTTP_PROXY` variables alone do not force an application to use the proxy. The network gateway must not route arbitrary packets; its administration plane is inaccessible to agents.

This variant requires rules enforced in the VM's actual network path, handling DNS, IPv6, QUIC, and gateway access. It is more difficult on Docker Desktop and is not the initial profile. Tests must demonstrate that the agent cannot reach `host.docker.internal`, `gateway.docker.internal`, Mac and LAN addresses, the core network, or neighboring networks. Docker Desktop's networking behavior makes assumed rules on the macOS firewall alone insufficient. [D5](https://docs.docker.com/desktop/features/networking/)

## 6 Docker Desktop precautions on Mac

Docker Desktop runs the daemon and containers inside a Linux VM. macOS files shared through bind mounts remain an explicit access path. Not mounting personal folders is therefore necessary, but does not provide absolute protection against a compromised daemon. [D1](https://docs.docker.com/desktop/setup/install/mac-permission-requirements/)

The Docker Desktop account can generally share more files than are actually mounted. Reduce directories permitted for sharing, disable unused features, and avoid hosting sensitive projects or containers in the same Engine. Mount neither the user's home directory, `.ssh`, the Keychain, nor cloud configuration. The only host files allowed for the core are explicitly inventoried bootstrap secrets in a dedicated directory; none is mounted in a sandbox.

Application ports bind explicitly to `127.0.0.1`, never to all interfaces. Host networking, devices, host namespaces, and additional sharing features are excluded. Docker Desktop's special addresses must be included in network-denial acceptance tests. Sleep suspends execution: no 24/7 SLA can be promised on a laptop.

ECI adds container isolation inside the VM and socket restrictions; availability depends on the Business offering and its configuration. Agents remain unprivileged and have no socket even with ECI. Docker Desktop, macOS, and image updates are tracked; every platform update requires isolation verification before automerge resumes. [D2](https://docs.docker.com/desktop/enterprise/hardened-desktop/enhanced-container-isolation/)

Prefer `linux/arm64` images, including OpenCode and its tools. Check native executables and each image's dependencies; amd64 emulation is not an acceptable performance assumption. An initial baseline to measure is 8 GiB of VM memory if physical RAM permits, one 4 GiB sandbox, and around 40 GiB free for images, the database, logs, and snapshots. Adjust after measurement rather than reserving most of the Mac's memory.

## 7 Monorepo modules and dependencies

```text
apps/
  api/                 HTTP, sessions, compiled interface
  worker/              workflows, scheduler, and GitHub executor
  sandbox-manager/     Engine control, no LLM business logic
  llm-gateway/         per-attempt bounded provider transport
  web/                 React
packages/
  domain/              entities, transitions, and pure invariants
  contracts/           types, JSON Schema, errors, and events
  policy/              deterministic evaluator and versioned profiles
  github/              Octokit, pagination, provenance, and merge
  runtime/             AgentRuntime and OpenCode adapter
  llm/                 profiles, capabilities, estimates, and redaction
  persistence/         SQL, migrations, and transactions
  queue/               leases, retries, and outbox
  observability/       structured logs, metrics, and traces
infra/
  compose/             deployment profiles
  images/              image build definitions and fixed relays
docs/                  ADRs, operations, and acceptance evidence
```

The domain imports neither Docker, the OpenCode SDK, nor the GitHub client. Workflows depend on typed ports, and adapters depend on those ports. The controller imports only contracts and its Engine client. The interface never accesses GitHub, PostgreSQL, or OpenCode directly. An architecture test verifies these import rules.

The API and worker can share the same image with different entry points. Process separation restricts permissions and resources; it does not introduce general-purpose distributed orchestration. The scheduler uses an SQL leadership lock to prevent duplicate scheduling during a restart with multiple workers.

## 8 TypeScript contracts and HTTP interfaces

### 8.1 Domain contracts

The following definitions are proposed JARVIS contracts, not native OpenCode signatures. Git SHAs are opaque strings validated against the supported format; configuration fingerprints are SHA-256 hashes of canonical JSON.

```typescript
type Revision = {
  repositoryId: string; pullNumber: number;
  headSha: string; baseSha: string; baseRef: string;
};
type ReviewRequest = {
  taskId: string; attemptId: string; revision: Revision;
  snapshotId: string; profileId: string;
  policyHash: string; modelProfileId: string;
  deadline: string; maxCostUnits: number;
};
type Finding = {
  severity: "info" | "low" | "medium" | "high" | "critical";
  path: string; line?: number;
  explanation: string; evidence: string;
};
type ReviewReport = {
  schemaVersion: 1; revision: Revision;
  summary: string; findings: Finding[];
  examinedPaths: string[]; limitations: string[];
  recommendation: "favorable" | "unfavorable" | "uncertain";
  complete: boolean;
};
interface AgentRuntime {
  review(req: ReviewRequest, signal: AbortSignal):
    Promise<{ report: ReviewReport; artifactDigest: string }>;
  cancel(attemptId: string): Promise<void>;
}
type Decision = {
  outcome: "allow" | "deny" | "needs_human";
  reasonCodes: string[]; evidenceSnapshotId: string;
  policyHash: string; actionDigest: string; expiresAt: string;
};
interface PolicyEngine {
  evaluate(input: TrustedPolicyInput): Decision;
}
```

`TrustedPolicyInput` is constructed exclusively by trusted adapters from GitHub snapshots, configuration, and the validated report. It contains revision facts, the classified diff, checks with provenance, reviews, protections, budget, suspension state, and any approval. Model statements cannot populate a "CI passed," "human approval," or "permissions granted" field.

The validator rejects unexpected fields, excessive lengths, non-finite numbers, absolute paths, `..` traversal, and locations absent from the snapshot. `complete: true` is cross-checked against the manifest of files actually provided; the model cannot certify coverage on its own. A narrative summary is never a valid substitute for a `ReviewReport`.

### 8.2 Sandbox contract

```typescript
type SandboxSpec = {
  taskId: string; attemptId: string;
  snapshotId: string; profileId: "review-static-v1";
  modelProfileId: string; deadline: string;
  leaseEpoch: number;
};
interface SandboxManager {
  create(spec: SandboxSpec, idempotencyKey: string):
    Promise<{ sandboxId: string; state: string }>;
  runtime(sandboxId: string, request: RuntimeEnvelope):
    AsyncIterable<RuntimeEvent>;
  inspect(sandboxId: string): Promise<SandboxStatus>;
  destroy(sandboxId: string, leaseEpoch: number): Promise<void>;
}
```

`RuntimeEnvelope` defines a closed set of session operations. The LLM gateway has a separate contract: prepare an allocation, record usage, and revoke. Neither the report nor the prompt can define a profile, provider URL, image, or longer deadline.

### 8.3 User and automation API

| Proposed method and route | Purpose | Constraints |
| --- | --- | --- |
| POST /webhooks/github | GitHub reception | Raw body, HMAC, maximum 25 MiB size, no cookie required |
| POST /api/v1/session | Local login | Rate limiting, hashed password, no secret in the response |
| GET /api/v1/repositories | Repositories and modes | Authenticated session, cursor pagination |
| PATCH /api/v1/repositories/:id | Settings and suspension | Expected version, CSRF, audit, permission validation |
| GET /api/v1/pulls/:id | State, report, and decision | Links to fixed revisions, sanitized content |
| POST /api/v1/pulls/:id/reviews | Explicit rerun | Idempotency-Key, expected SHA, budget and mode checked |
| POST /api/v1/approvals/:id/decision | Approve or reject | Expected ActionDigest and version, expiry, CSRF |
| POST /api/v1/control/pause | Durable global stop | Prioritized, authenticated, and audited |
| GET /api/v1/digests | Digests and costs | Explicit time zone and period |
| GET /api/v1/tasks/:id/events | SSE progress | Session, filtered events, no raw sensitive data |
| GET /health/live and /health/ready | Internal probes | Details not exposed publicly |

An API mutation returns `202` for scheduled work, `409` for an outdated version or revision, `422` for an invalid contract, and `429` for a local limit. A normal business-rule block is a persisted decision with a reason code, not a generic technical error. No "arbitrary merge" endpoint is exposed to the browser or runtime.

Controller routes are separate (`/internal/v1/sandboxes`) and are not published. A local network does not provide authentication: internal mTLS, certificate rotation, service identity verification, and route restrictions remain necessary.

## 9 GitHub App and permissions

### 9.1 Permissions by use case

| Repository permission | Minimum mode | Reason |
| --- | --- | --- |
| Metadata | Read | Repository and installation identification |
| Contents | Read in observation mode; write for merging | Snapshots and the merge endpoint |
| Pull requests | Read; write only when publishing reports | PRs, files, reviews; optional review comment |
| Checks | Read | Check run state and provenance |
| Commit statuses | Read | Legacy status contexts |
| Administration | Read only if needed to inspect effective protections | Branch verification; never write |
| Actions | Read only if needed to identify the expected workflow | Enable after endpoint-by-endpoint verification |

Issues write, Workflows write, Secrets, Deployments, and Administration write are absent. A review App can remain read-only and separate from the merge App for stronger credential separation; the MVP can use a single merge App, with tokens consistently narrowed by role. `Contents: write` grants more than a merge-only capability, so the executor must remain deterministic and inaccessible to agents. [G6](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)

The App is installed only on selected repositories and is not a bypass actor. The broker creates an installation token limited to one repository and the task's permissions. Tokens expire according to the returned `expires_at`; the documentation specifies one hour. Never assume a fixed token length. The App private key never leaves the trusted service responsible for authentication. [G7](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

### 9.2 Reading protections and events

The adapter first reads `GET /repos/{owner}/{repo}/rules/branches/{branch}` for active rules from applicable rulesets, including organization-level rules. This endpoint requires Metadata read permission. It supplements this with classic branch protections when present; inspecting these may require Administration read permission. A 403 does not prove that a rule is absent. The need for this additional permission is therefore assessed per repository rather than granted universally. [G10](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch)

Review conversations and their resolved state are read through a read-only GitHub adapter, using GraphQL if the selected REST endpoints cannot provide the required evidence. Missing usable data blocks merging when resolution is required. This contract is part of the live pilot repository test.

Subscribe only to events that are used: `pull_request`, `pull_request_review`, `check_run`, `check_suite`, `status`, installation and repository-access events; `push` for the target branch, and conversation events if tracked. Exact subscription and permission rules are validated with a test installation. Reconciliation also rereads missing or stale facts.

Dependabot detection uses the bot identity obtained from GitHub metadata and matches it against the platform's expected identity. It cross-checks branch origin and manifests without trusting the title, body, or labels. A signed event is still a change notification; current state is read from the API again.

## 10 OpenCode and interchangeable providers

### 10.1 Server and adapter

OpenCode documents `opencode serve`, default port 4096, HTTP Basic authentication through `OPENCODE_SERVER_PASSWORD`, and a `/doc` specification endpoint. Session and event operations support headless control. JARVIS binds the hostname to loopback, uses a different secret for every attempt, and records the version returned by the health probe. The server is never contacted from the user's browser. [O1](https://docs.opencode.ai/docs/server/)

The adapter uses only a client connected to the server already created by the controller; it does not call an SDK function that starts a local server inside the worker. The SDK/server pair is pinned and tested together. Differences in API shape across versions are confined to this adapter; every update passes contract tests before adoption. [O2](https://docs.opencode.ai/docs/sdk/)

Output is validated against a JARVIS JSON Schema. A native structured-output capability can help, but is not treated as a guarantee: parse errors, truncation, provider refusals, a missing final message, or a broken stream produce an explicit failure. At most one format-repair attempt is allowed within the same budget; it cannot turn incomplete analysis into complete evidence without reanalysis.

### 10.2 Controlled configuration and permissions

OpenCode has several configuration layers, including project files and `.opencode` directories. Setting only `OPENCODE_CONFIG` does not automatically neutralize repository configuration. [O3](https://opencode.ai/docs/config/) JARVIS therefore prepares a separate read-only analysis snapshot: no executable `.git` configuration, hooks, active OpenCode configuration, MCP, plugins, or automatic repository skill loading. Files of these types are retained as text in a neutralized location if they need to be analyzed.

The prototype also checks recognized instruction files, parent-directory searches, remote configuration, and custom agents. The image starts with no preexisting OpenCode user identity or stored credential. Managed settings in the selected version can supplement this approach, but a permission list is not enough to stop a plugin from executing at startup: loading must be prevented.

The profile starts by denying all tools and explicitly allows only the required file reads, file searches, and content searches. `bash`, edit, webfetch, websearch, task/subagents, skills, LSP, MCP, and custom commands are prohibited. No blanket automatic approval is enabled. An unexpected interactive permission request is denied and surfaced as a review limitation. OpenCode permissions are an application layer; the sandbox and remote permissions form the effective boundary. [O4](https://opencode.ai/docs/permissions/)

### 10.3 Two LLM abstraction levels

`ModelProfile` contains the provider, model, capabilities, maximum context, output limits, data rules, versioned prices, and authorized repository list. The core may use a `TextGenerator` port for an optional digest. Review is delegated to the `AgentRuntime` port; its adapter translates the profile into OpenCode provider configuration and the gateway endpoint.

OpenCode documents multiple providers and local models. This does not guarantee equivalent tool calling, streaming, or JSON behavior across every combination. [O5](https://opencode.ai/docs/providers/) The MVP compatibility matrix qualifies two authorized providers with the socket bridge, authentication, limits, and output contract. Switching providers remains a configuration operation without changing the domain.

Fallback is limited to a per-repository approved list with the same confidentiality level and a cost reservation. Provider unavailability never justifies automatically sending the repository to an additional destination. Using a model on the Mac through a route to the host requires a specific profile and remains deferred.

## 11 PostgreSQL data model

### 11.1 Main entities

| Table | Key fields | Constraints and purpose |
| --- | --- | --- |
| installations | github_id, app_id, state, revoked_at | Unique external identity; revocation immediately blocks tasks |
| repositories | github_id, installation_id, mode, config_version | Unique repository; references stable across renames |
| policies | id, version, canonical_json, hash, activated_at | Immutable versions; active configuration per repository |
| webhook_deliveries | delivery_id, event, payload_hash, received_at, state | Unique per App and delivery_id; payload redacted or purged promptly |
| pull_requests | repository_id, number, head_sha, base_sha, remote_state | Unique repository and number; current-state projection |
| evidence_snapshots | revision, checks_json, reviews_json, rules_json, fetched_at, hash | Immutable evidence from trusted adapters |
| tasks | revision, type, profile_hash, policy_hash, state, dedupe_key | Unique logical key per revision and profiles |
| task_attempts | task_id, ordinal, lease_epoch, lease_until, sandbox_id, state | Append-only attempt history; absolute deadline |
| review_reports | task_id, attempt_id, schema_version, report_json, digest | Immutable report; one accepted canonical version per task |
| policy_decisions | evidence_id, report_id, policy_hash, outcome, reasons, action_digest, expires_at | Decisions never modified in place |
| approvals | action_digest, actor_id, decision, expected_version, expires_at, consumed_at | Atomically consumed approval; explicit invalidation |
| action_intents | action_key, revision, decision_id, state, remote_uuid, merge_sha | Unique logical action; unknown result distinct from failure |
| outbox | id, aggregate_id, event_type, payload, available_at, delivered_at | Event written in the same transaction as domain state |
| scheduled_runs | schedule_id, local_date, period_start, period_end, state | Unique per schedule and logical occurrence |
| daily_digests | scope_id, local_date, source_watermark, body, totals_json | One current version per date; totals retain provenance |
| usage_ledger | attempt_id, provider, model, reserved, actual, currency, price_version | Reservations and spending; estimated/reconciled distinction |
| audit_events | actor, action, resource, correlation_id, occurred_at, details_hash | Insert-only for the application role; purge by a separate role |

GitHub identifiers are stored as `bigint` or text and serialized as API strings to avoid JavaScript precision loss. Monetary amounts use decimals or integer currency units with sufficient precision, never binary floating point. Timestamps use UTC `timestamptz`, with the schedule's IANA time zone stored separately. JSONB fields carry a schema version and do not replace columns needed for constraints.

### 11.2 Relationships and integrity

An installation has multiple repositories; a repository has multiple PRs and rule versions. A PR has several revision-bound tasks; a task has multiple attempts and reports, but only one active canonical decision per action. A decision references an evidence snapshot and a report. An approval references the action digest; a merge intent references the decision and retains the GitHub result.

Composite foreign keys, including repository and PR where necessary, prevent a report from repository A from authorizing an action on B. Transitions check within the transaction that the PR revision is still current. A partial index or domain-lock constraint prevents two active intents for the same PR. Deleting secrets and temporary artifacts is independent of retaining minimal audit evidence.

Application audit records are not tamper-proof against a PostgreSQL administrator or compromised Engine control. A hash chain and regular exports can make changes detectable; a regulatory guarantee would require dedicated external storage, outside scope.

## 12 State machines and workflows

### 12.1 States

A task follows `queued -> preparing -> running -> validating -> completed`. Alternative terminal states are `failed`, `cancelled`, `timed_out`, and `superseded`. A recoverable failure closes an attempt and requeues the task with a new attempt; it does not reuse a partially compromised sandbox. The merge policy decision is a separate entity.

A decision can deny an action, require human input, or authorize an intent. An intent follows `prepared -> dispatched -> pending_remote -> confirmed`, with alternative states `rejected`, `unknown`, and `cancelled_before_dispatch`. `unknown` is never treated as `failed`, because a remote effect may already have occurred.

### 12.2 Ingestion and reconciliation

1. Ingress limits size, retains the raw body bytes, and verifies HMAC-SHA256 before parsing JSON. Comparison uses constant time. [G2](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
2. It validates the type, action, and installation identifier, then inserts the delivery and outbox entry in a transaction. A known identifier with the same hash is acknowledged; a different hash triggers an alert and no additional work.
3. Ingress returns 2xx after commit. The internal target is below 2 seconds at p95; GitHub requires a response within 10 seconds. A persistence failure returns an error rather than acknowledging a delivery that would be lost. [G3](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
4. The worker rereads current GitHub state, updates the PR projection, and creates the task using its business key. An old event never resets the head to a previous SHA.
5. Every 15 minutes, and on recovery, a paginated scan of open PRs and unconfirmed operations compensates for lost events. It uses ETags where appropriate, periodic full audits, and rate limiting.

### 12.3 Snapshot preparation and review

The GitHub service resolves H and B and downloads the exact trees or archives with a read token. No clone token is given to the runtime. Downloads use approved GitHub origins and verified redirects; Authorization is not forwarded to an arbitrary host. Submodules and Git LFS are not resolved automatically.

A trusted preparer neutralizes absolute paths, traversal, special files, escaping symbolic links, excessive decompressed sizes, and malicious archives. The initial profile enforces limits of 250 MiB decompressed, 20,000 files, and a 200 KB diff; beyond these limits, a partial review is possible but automerge is rejected. Base and head snapshots and a manifest of exclusions are retained under opaque identifiers and hashes. The manifest parser works on original raw files; the runtime receives a sanitized view with traceable mappings.

The controller copies the validated snapshot into a dedicated volume through the Engine channel, without extracting repository data onto the Mac. The snapshot is mounted read-only in the agent. The controller creates the gateway, state, and sandbox, checks health and configuration, and then the adapter creates a session and sends the fixed mission. On receipt, the core validates the report, cross-checks paths and revision, persists usage and the result, and requests destruction even on failure. An independent janitor provides a second cleanup mechanism.

### 12.4 Decision and approval

For an immediate action, the engine receives a fact snapshot less than 60 seconds old. It checks every POL condition from the PRD, then builds `actionDigest` from the repository, PR number, H, B, target reference, method, report, policy, and validation profile. A material change to any of these invalidates the approval. Checks and reviews are reread at execution; any blocking difference cancels the action even if the approved digest still matches.

The API accepts a human decision with the expected version and an idempotency key. A transaction checks the session, current SHA, expiry, and unconsumed state, then records the decision. The approval is atomically consumed when preparing the intent; a network timeout does not reuse it for a different intent.

### 12.5 Merge and revision races

1. Acquire an exclusive action lease for the PR and reread suspension, mode, budget, and policy version.
2. Reread GitHub: H, B, state, classified diff, checks, reviews, and effective rules. If `mergeable` is unknown, wait and retry within a bounded window; never infer "true."
3. Reject any mismatch with the report or approval. Require active protections with no bypass and up-to-date CI according to the profile. Prepare the decision and intent in a durable transaction.
4. Send `PUT /repos/{owner}/{repo}/pulls/{number}/merge-async` with `sha: H`, the approved `merge_method`, `merge_action: direct_merge`, and `bypass_rules: false`. The profile excludes stacked PRs and branches requiring a merge queue. [G1](https://docs.github.com/en/rest/pulls/pulls)
5. Store the returned UUID, track `pending`, `merged`, or `failed`, then reread PR state. A `202` response indicates only acceptance for processing. A `409` indicating an existing operation must be reconciled with the intent, not automatically interpreted as a changed head.
6. Record the observed merge SHA and actor. If the network fails before the response is known, enter `unknown` and reconcile PR state; do not resend the request blindly.

The `sha` parameter is a precondition on the head. It does not atomically compare B with the base. GitHub rules requiring checks and an up-to-date branch remain the enforcement barrier at remote execution; the App must never be able to bypass them. If the repository requires human review, JARVIS analysis does not replace it. A local policy cannot guarantee cancellation of a request already accepted by GitHub.

Support for the asynchronous endpoint is verified against the chosen API version, recorded in configuration and tested on GitHub.com. The documentation consulted recommends this endpoint. Future GHES compatibility will require its own matrix; no silent fallback to another endpoint or merge mode is planned.

### 12.6 CI evidence and provenance

For each piece of evidence, JARVIS retains the evaluated SHA, name, type, run identifier, issuer, conclusion, and timestamps. Check runs and commit statuses are read separately and paginated. Absence is not success. An aggregate `success` result alone does not prove that a configured check exists. [G8](https://docs.github.com/en/rest/checks/runs), [G9](https://docs.github.com/en/rest/commits/statuses)

The profile verifies expected checks on the relevant commit. GitHub may require results on a test merge commit instead of H; JARVIS resolves this association and blocks if it cannot bind the evidence to the reviewed combination. GitHub may accept some neutral/skipped outcomes; JARVIS applies a stricter requirement for explicit success and also blocks skipped critical jobs when detectable. [G5](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

For GitHub Actions, a shared `app_id` does not distinguish two workflows: the pilot repository must identify the expected validation workflow and jobs. A workflow modified by the PR is excluded from automerge. Pipelines using PR code with powerful secrets, particularly unsafe uses of `pull_request_target`, are fixed or excluded from the pilot. JARVIS cannot make an insecurely designed CI system trustworthy.

### 12.7 Digest and catch-up

The scheduler determines the daily occurrence in Europe/Paris and records its UTC boundaries. Uniqueness is based on local date and scope, not a fixed 24-hour interval. On restart, it produces a catch-up digest covering missed days, indicating the interruption in monitoring.

Action totals and lists come from SQL queries over confirmed facts. Optional LLM-written prose receives these facts and links under a separate budget; if generation fails, a deterministic template remains available. Outbound links and Markdown are sanitized. Merges in `unknown` state are never presented as successful.

## 13 Idempotence and consistency

| Level | Key and mechanism | Intended guarantee |
| --- | --- | --- |
| Ingestion | Unique App + delivery_id, body hash | Replaying a delivery does not recreate work |
| Task | Repository + PR + H + B + type + hashes of profiles and policy | Coalesce semantically identical events |
| Attempt | task_id + ordinal, monotonic lease_epoch | Retry history and rejection of stale worker results |
| Sandbox creation | Unique attempt_id in the controller | A lost response does not create a second container |
| Decision | actionDigest + expected version | Approval limited to the reviewed action |
| GitHub effect | Unique action_key, durable intent, and reconciliation | Avoid repeating an effect after an unknown response |
| Digest | scope + local_date | One logical occurrence despite daylight saving time and recovery |

Internal delivery is at least once. The system does not promise distributed exactly-once behavior between PostgreSQL and GitHub. The outbox makes local state and the processing request atomic; remote effects are reconciled against their intent and the outcome actually observed.

For a published report, a stable action-bound marker makes it possible to find and update an existing comment after a failure. Before creation, the executor searches for that marker; if the result is uncertain, it waits for reconciliation. Permissions remain `Pull requests: write` and the review type is `COMMENT`; no `APPROVE` review is generated.

A task-completion event from an older lease epoch is retained for diagnostics, but cannot replace the canonical report or create an intent. A local lock alone is insufficient: the controller and transactions also verify the lease epoch.

## 14 Work queue and resilience

Workers claim short batches with `SELECT ... FOR UPDATE SKIP LOCKED`, record a lease, and release the transaction before any external call. PostgreSQL documents SKIP LOCKED as a way to reduce contention among queue consumers; it does not provide a consistent view for general business reads. [P1](https://www.postgresql.org/docs/current/sql-select.html)

The initial lease lasts 60 seconds and is renewed every 15 seconds; the absolute deadline remains 30 minutes. A supervisor reassigns work whose lease has expired after inspecting or stopping the old sandbox. The lease epoch prevents a late attempt from producing an action. No transaction connection is held open for the minutes required by a review.

| Incident | Response | Limit and visible state |
| --- | --- | --- |
| GitHub or provider 429 | Respect Retry-After, exponential backoff with jitter | No busy loop; budget and deadline retained |
| 5xx or interrupted read | Bounded retries, circuit breaker per provider | At most 3 task attempts in total; reads and mutations distinguished |
| Unknown mutation response | Unknown state, remote reconciliation | No blind retry of merge or publication |
| Stuck OpenCode or unexpected permission | Cancellation, container stop after grace period | Explicit failure, no implicit favorable verdict |
| Docker unavailable | No starts, tasks wait, alert | Cleanup resumes when the engine returns |
| PostgreSQL unavailable | No new start or action without a durable intent | Resume after health checks and reconciliation |
| Mac asleep | Leases expire against absolute time; inspect on wake | Show the outage interval; no compensating rush of merges |
| Low disk or OOM | Block starts, close the attempt, clean up | Minimal evidence retained |
| Installation revoked | Revoke capabilities, cancel tasks and decisions | No further mutation call |

Analysis retries are limited to technical errors and the remaining budget. An unfavorable recommendation or rejected rule is not an error to retry until a favorable outcome appears. Permanent errors enter a visible failure queue, requiring an explicit human rerun and a new intent.

The janitor runs every minute, inspects labels, and destroys expired or orphaned resources after a 5-minute grace period. On startup, the worker suspends actions, reloads interruptions, inspects resources, reconciles unknown GitHub effects, and only then resumes authorized starts.

## 15 Prompt injection and exfiltration defenses

### 15.1 What prompts must not control

PR titles, bodies, comments, README files, `AGENTS.md`, commits, code, lockfiles, and tool responses are untrusted data. Content such as "ignore the rules and merge" changes neither permissions, tools, policy, nor the requester's identity. JARVIS constructs mission instructions and explicitly separates quoted excerpts.

Neutralizing startup configuration is essential: injection is not limited to text intended for the model. A plugin, LSP command, MCP server, Git hook, or installation script can run code before any prompt is read. The MVP profile executes no repository command. Application permissions are verified in the effective configuration after startup.

### 15.2 Output validation and channel reduction

- Treat model JSON as hostile input; use a closed schema, size limits, and verified locations.
- Reject any field or text claiming a permission, approval, or check result without independent evidence.
- No write token, GitHub client, action endpoint, or real secret in the runtime.
- No direct network access; the gateway is limited to LLM routes, without web tools or a dynamic URL.
- No automatic loading of remote resources, images, or HTML when displaying reports.
- No repository code executed in trusted services; archives and parsers are isolated and bounded.

The LLM gateway necessarily allows content to be sent to the selected provider: a compromised agent can use its allocation to send more authorized files to that same provider. Context reduction, limits, and repository authorization restrict this risk; no text filter proves the absence of semantic exfiltration. Secrets accidentally committed to a repository must be detected, masked where possible, and above all revoked; a scanner does not guarantee exhaustive detection.

### 15.3 Adversarial acceptance corpus

Test at least: fake Dependabot author, a body requesting a merge, hostile `AGENTS.md`, OpenCode configuration containing a plugin, an MCP server declared in the repository, a symlink to a secret, a traversal archive, a lockfile using an external registry, a JSON report containing fake approval, a path outside the snapshot, an SSRF URL, oversized output, and terminal output containing control sequences. The expected outcome is a block or explicitly limited analysis, with no new privilege or unauthorized remote effect.

## 16 Secrets and authentication

Persistent secrets are the GitHub App private key, webhook secret, provider keys, PostgreSQL credentials, and internal certificates. They reside in a dedicated host bootstrap directory or an explicitly selected secret manager, never in the repository or images. Each service receives only the secrets it needs. Docker Compose can mount secrets per service; in local deployment, this is not a substitute for an encrypted vault, and the source files on the Mac still need protection. [D6](https://docs.docker.com/compose/how-tos/use-secrets/)

GitHub keys stay in the trusted broker; read or merge tokens are created on demand, retained in memory, and expire or are revoked. Per-attempt LLM capabilities have a scope, limit, and deadline. Gateway keys are injected into temporary storage and disappear when it is destroyed. A control prevents them from being written to events, logs, and artifacts.

Web administration uses a single account, a password hashed with an appropriate function, an opaque server-side session, HttpOnly and SameSite cookies, inactivity expiry, and CSRF protection. Cookie behavior is tested on the strictly loopback HTTP interface; any remote exposure requires TLS and a Secure cookie. Onboarding uses a one-time secret, never printed in logs, and then revokes it.

Rotation and revocation are documented: suspend starts, replace the secret, restart only its consumers, test reads, verify capabilities, and resume actions. Logging uses an allowlist of fields rather than only pattern matching for strings that resemble keys.

## 17 Observability and costs

### 17.1 Signals

Structured JSON logs carry `correlation_id`, repository, PR, task, attempt, revision, decision, and intent; timestamps are UTC with local display. Webhook bodies, prompts, code, authentication headers, and provider responses are not logged by default. Any retained raw output is encrypted, access-restricted, and subject to short retention.

Metrics include queue age, reconciliation lag, preparation and review duration, timeout rate, expired leases, orphaned resources, cleanup, errors per adapter, GitHub calls, rate-limit headroom, reserved/estimated/reconciled cost, refusals by reason, and `unknown` intents. PR identifiers are not used as high-cardinality metric labels; they remain in logs and traces.

Visible JARVIS alerts include: no reconciliation for more than 30 minutes while the system is active, an unknown merge result for more than 5 minutes, cleanup failing for 5 minutes, budget reaching 80% and then 100%, VM space below 10 GiB, and repeated authentication or isolation failures. External notifications are optional and deferred.

### 17.2 Cost model

```text
Cost per attempt =
  input tokens / 1,000,000 × input price
  + output tokens / 1,000,000 × output price
  + any explicitly accounted tool or cache fees

Monthly cost = sum of all attempts and digests
  + any Docker or relay subscriptions
  + energy, storage, and operational time
```

Purely arithmetic example, not a current price quote: at 2 units per million input tokens and 10 per million output tokens, a review using 50,000 input tokens and 5,000 output tokens costs 0.15 units. At 20 reviews per day for 30 days, this amounts to 90 units before retries, digests, taxes, and other fees. A 10% retry overhead would bring this component to approximately 99 units.

The reservation is calculated before starting from the maximum authorized requests and tokens. The gateway rejects a new request when the remaining reservation is insufficient and constrains output maxima; the worker does not merely alert after spending. Provider-reported usage is reconciled when available; otherwise usage remains estimated. An in-flight request can exceed an estimate; a strict provider-side spending limit supplements local controls.

The interface distinguishes per-PR cost, abandoned-attempt cost, currency, and price version. Prices are entered or explicitly updated, without relying on constants assumed to remain current. Local costs are measured through CPU time, memory, and storage; a local model adds consumption and RAM constraints rather than having zero cost.

## 18 Local deployment and development

### 18.1 Persistent services

Compose deploys PostgreSQL, the API, worker, controller, and optional webhook ingress. React is compiled and served by the API or a minimal frontend server. Gateways and sandboxes are created dynamically by the controller. The base network is private; only the interface at `127.0.0.1:3000` is published. PostgreSQL and the controller have no host port.

Persistent volumes contain the database and retained evidence. Temporary resources have per-attempt volumes. The Engine socket is mounted only in the controller; bootstrap secrets are assigned per service. No global source-tree or user-home mount is present in agent execution profiles.

Webhooks require an HTTPS endpoint reachable by GitHub. A relay or tunnel exposes only `/webhooks/github` to ingress, with signature verification at the JARVIS entry point. The relay provider remains an open decision. Without a relay, reconciliation supports observation but does not yet fulfill the webhook portion of the final release.

### 18.2 Installation sequence

1. Verify macOS and Docker Desktop versions, the offering in use, ARM64, memory, and free space; reduce sharing and unused features.
2. Build or retrieve images by approved digest, and verify provenance, vulnerabilities, and the software bill of materials.
3. Create the dedicated secrets directory with restrictive permissions, install the test App on a selected repository, and configure the webhook.
4. Start PostgreSQL, apply migrations using a temporary migration role, then start services in observation mode.
5. Verify probes, authenticated web access, signed reception, reconciliation, and a smoke-test task without GitHub writes.
6. Run isolation tests on the actual Mac, recovery scenarios, and a restore; record the results.
7. Enable assisted mode on the test repository, then on the pilot. Enable automerge only after the PRD gates have passed.

### 18.3 Development environment

The monorepo uses strict TypeScript, a PNPM lockfile, and reproducible formatting, lint, build, and test commands. Services may share a development mode, but agents continue to use dedicated ephemeral images and volumes. Mounting JARVIS sources for development is limited to trusted components and absent from sandboxes.

Unit tests use in-memory adapters; integration tests start a temporary database and fake GitHub/OpenCode server. Live scenarios use a test GitHub App and a disposable repository separate from the pilot. Production secrets are never available in JARVIS project CI workflows.

Images are pinned by digest, dependencies by lockfile, and `packageManager` by explicit version. Migrations maintain compatibility during deployment, adding columns before removing them later. An image rollback does not imply a destructive database rollback.

## 19 Backup retention and operations

Take a consistent daily PostgreSQL backup using the tool appropriate for the selected version, encrypt it before export to a dedicated authorized directory, and initially retain 7 daily and 4 weekly backups. Retained artifacts and configuration without secrets are backed up with their hashes. Docker's single virtual disk is not, by itself, a verified application backup. PostgreSQL distinguishes several backup strategies; the MVP uses a logical dump and a tested restore. [P2](https://www.postgresql.org/docs/current/backup.html)

Targets: a 24-hour RPO and 60-minute RTO after the Mac becomes available. A restore starts with every action suspended. It reloads evidence, revokes attempt capabilities, and reconciles PRs and GitHub effects before any resumption, to avoid replaying intents already consumed after the backup point.

Initial retention: snapshots and runtime state are deleted at attempt completion; raw diagnostic artifacts are disabled by default, otherwise retained for at most 7 days; operational logs for 30 days; reports, decisions, and audit for 90 days. Webhook payloads are minimized and purged after 7 days. Longer retention may be selected for merge evidence according to space and confidentiality needs. Secrets are not retained in these artifacts.

**Emergency stop.** The API persists the stop; the executor rereads it before every dispatch; leases and capabilities are revoked; sandboxes are stopped. If services are unresponsive, the owner can stop services and revoke the App in GitHub. Already accepted operations are tracked through confirmation, without a promise of recall.

**Update.** Suspend actions, wait for or cancel local tasks, back up, deploy compatible images and migrations, run probes and isolation acceptance tests, then resume in observation mode before reactivating repositories. An automatic restart must never reopen a previously suspended state.

## 20 Testing strategy and release gates

| Suite | Required scenarios | Gate |
| --- | --- | --- |
| Domain and policy | POL matrix, SemVer versions, unknown profiles, missing CI, neutral/skipped checks, stale approval | J3 then J4 |
| OpenCode contracts | Health, creation, prompt, report, interrupted stream, cancellation, permission denial, incompatible version | J1 and J3 |
| Provider contracts | Two providers, socket streaming, JSON, limits, interruption, no unauthorized fallback | J3 |
| Ingestion and queue | Raw HMAC, Unicode, duplicates, divergent hash, reversed order, pagination, lease expiry, and outbox | J2 |
| Real isolation | Mounts, UID, capabilities, socket, Mac/LAN/core/neighbor access, IPv4/IPv6, DNS, memory/process limits | J1, then after platform updates |
| Hostile input | Section 15 corpus, configuration, archives, injections, web rendering, and fake test results | J3 |
| Merge | Changed H/B, blocking ruleset, degraded CI, delay, lost response, remote pending state, revoked App, no bypass | J4 |
| Recovery | Crash before/after commit and before/after remote call, duplicated worker, Docker stopped, simulated sleep, dump restore | J2, J4, and J5 |
| Operations | Persistent stop, janitor, budget, missed digest, daylight saving time, low disk, and purge | J5 |

Race tests use a test barrier to change the PR or checks between the read and dispatch, then verify the remote precondition and protections. A test does not merely simulate an `allow` value. Effects are verified on a test repository, including the absence of a comment or merge when denied.

Performance acceptance uses a versioned corpus: 1,000 events for ingestion p95, 20 reviews with diffs below 200 KB for processing time, a hard 30-minute limit, and a peak of 50 events per minute. Offline periods and external limits are recorded separately. Security and recovery tests remain necessary even when unit tests pass.

## 21 Delivery sequence and remaining decisions

**Step 1 corresponding to J0/J1.** Pin profiles and versions, implement the minimal controller, bounded Docker exec transport, and socket gateway. Demonstrate a review without IP networking or real secrets in the agent. Qualify state paths and the absence of repository code loading.

**Step 2 corresponding to J2.** Implement the PostgreSQL schema, inbox/outbox, leases, webhooks, and reconciliation. Provide the observation interface, authentication, and persistent stop. GitHub write actions remain disabled.

**Step 3 corresponding to J3.** Finalize structured reports, the dependency-diff parser, pure policy rules, budget, and adversarial corpus. Qualify a second provider and the deterministic digest.

**Step 4 corresponding to J4.** Connect approvals, durable intents, and the asynchronous merge API. Verify protections and CI provenance on the test repository. Exercise races and lost-response failures before the assisted pilot.

**Step 5 corresponding to J5.** Add daily catch-up, final cleanup, backup/restore, cost views, and the operations guide. Enable limited automerge only after the 20 reference PRs and critical PRD gates.

Decisions D01 through D10 in the PRD remain the product decision register. Three technical points govern the start of implementation: compatibility of the socket transport with the selected providers; read access to effective protections without excessive administration permissions; and unambiguous identification of CI workflows. The fallback for each is to remain in observation or review mode without silently expanding permissions.

## 22 Verified technical references

Official sources consulted on October 15, 2026. References establish component capabilities, not guarantees of the proposed JARVIS architecture. Pages evolve: image, SDK, engine, and GitHub API versions must be recorded in the repository at J0.

- **O1** [OpenCode Server](https://docs.opencode.ai/docs/server/): headless mode, authentication, health, sessions, and events.
- **O2** [OpenCode SDK](https://docs.opencode.ai/docs/sdk/): TypeScript client, custom transport, and types.
- **O3** [OpenCode Config](https://opencode.ai/docs/config/): configuration layers, project configuration, and loaded directories.
- **O4** [OpenCode Permissions](https://opencode.ai/docs/permissions/): allow, ask, deny, and tool permissions.
- **O5** [OpenCode Providers](https://opencode.ai/docs/providers/): configurable providers and models.
- **G1** [GitHub REST Pull requests](https://docs.github.com/en/rest/pulls/pulls): asynchronous merge endpoint, expected SHA, no bypass, and remote states.
- **G2** [Validating GitHub webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries): raw body and HMAC-SHA256.
- **G3** [GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks): acknowledgment deadline and delivery identifier.
- **G4** [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches): controls and merge conditions.
- **G5** [GitHub required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks): SHA, check origin, and test merge commits.
- **G6** [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps): endpoint-by-endpoint matrix.
- **G7** [GitHub App installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app): repository scope, permissions, and expiry.
- **G8** [GitHub Check runs](https://docs.github.com/en/rest/checks/runs): checks on a Git reference and permissions.
- **G9** [GitHub Commit statuses](https://docs.github.com/en/rest/commits/statuses): contexts and status aggregation.
- **G10** [Active rules for a branch](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch): applicable rules and Metadata read permission.
- **D1** [Docker Desktop permissions on Mac](https://docs.docker.com/desktop/setup/install/mac-permission-requirements/): Linux VM and file sharing.
- **D2** [Enhanced Container Isolation](https://docs.docker.com/desktop/enterprise/hardened-desktop/enhanced-container-isolation/): hardening and socket access.
- **D3** [Docker Engine security](https://docs.docker.com/engine/security/): daemon control surface.
- **D4** [Docker none network driver](https://docs.docker.com/engine/network/drivers/none/): no external network.
- **D5** [Docker Desktop Networking](https://docs.docker.com/desktop/features/networking/): networking and host addresses.
- **D6** [Secrets in Docker Compose](https://docs.docker.com/compose/how-tos/use-secrets/): assigning secrets per service.
- **P1** [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html): row locks and SKIP LOCKED.
- **P2** [PostgreSQL Backup and Restore](https://www.postgresql.org/docs/current/backup.html): backup and restore methods.
- **T1** [Node.js releases](https://nodejs.org/en/about/previous-releases): choosing a maintained LTS branch.
- **T2** [PNPM Workspaces](https://pnpm.io/workspaces): monorepo and workspace protocol.
