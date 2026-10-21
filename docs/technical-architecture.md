# JARVIS v0.1 Technical Architecture

Document version 1.22 • October 21, 2026 • Companion to the PRD and roadmap

## 1 Summary of design choices

JARVIS is a TypeScript and Node.js modular monolith deployed as several Docker processes, separated by privilege level. PostgreSQL holds owner-controlled project/skill configuration, task state, the work queue, and audit records. The API serves the React interface; a worker handles explicit project requests in plan or development mode. An adapter controls headless OpenCode in a new container for every attempt. Plan and writable author profiles are separate and require independent qualification. GitHub reads and effects belong exclusively to the deterministic core; the v0.1 effect ceiling is opening a validated PR, never merging it.

The proposed profile for the Mac M2 Pro uses a sandbox with `network_mode: none`, no mounted macOS files, no GitHub secret, and no provider key. An LLM gateway dedicated to the attempt is accessible through a Unix socket shared in a Docker volume. A local HTTP relay lets OpenCode use it as a provider endpoint. A trusted controller, the sole holder of the Engine socket, transports session commands through a fixed relay launched by Docker exec. This combination avoids opening an OpenCode server on the Mac or granting a network route to the control plane.

This is a proposed architecture to implement. The JARVIS contracts, hardening profiles, and thresholds below are not guaranteed native capabilities of OpenCode or Docker. The J01 prototype must demonstrate feasibility with selected versions; failure blocks the corresponding capability. Requirements and policies refer to the separate [PRD and roadmap](prd-and-roadmap.md); detailed profile, execution, publication and storage decisions remain proposals unless explicitly recorded as owner-selected there.

## 2 Architecture decisions

The existing ADR01–ADR11 identities below remain stable. Use [project governance](project-governance.md) and the [ADR index/lifecycle](adr/index.md) to record significant evolution, actual acceptance provenance and linked supersession without inventing historical decisions. Proposed mechanisms and accepted choices remain distinct from implementation/qualification; this contributor process grants no runtime authority.

| Decision | v0.1 choice | Consequence |
| --- | --- | --- |
| ADR 01 Organization | Modular monolith, multiple processes and privilege zones | One repository, one domain model, no requirement for microservices |
| ADR 02 Persistence | PostgreSQL and a durable SQL queue | No Redis or external bus initially |
| ADR 03 Runtime | OpenCode through SDK/API, with server and SDK pinned together; separate plan and development profiles | No OpenCode plugin or shared personal session; profiles qualify independently |
| ADR 04 Authority | Policy Engine without an LLM; dedicated GitHub executor | A report cannot trigger a write directly |
| ADR 05 Sandboxes | One ARM64 container per attempt, without IP networking | Local relay and gateway transport to prototype |
| ADR 06 Controller | Owner-selected trusted container with Engine socket and restricted API (PRD D01) | Explicit privileged-component risk; no socket in API, worker, or agent; J01 implementation and qualification remain required |
| ADR 07 Review | Static repository analysis remains available; requested plan/development work has distinct contracts | No repository command execution absent separate D16 acceptance and qualification |
| ADR 08 Product merge authority | JARVIS does not merge pull requests in v0.1 | Human/GitHub review and merge remain outside JARVIS's authority |
| ADR 09 Operations | One explicit user-directed task at a time; project allowlist is internal to JARVIS | Match Mac resources; project suspension and global stop remain core-controlled |
| ADR 10 Host runtime | Colima Docker runtime, dedicated `jarvis` profile, native ARM64 | No Docker Desktop dependency; no macOS directory sharing; validate isolation on the pinned platform |
| ADR 11 Durable memory | Core-owned PostgreSQL history, checkpoints, and scoped knowledge | Bounded context rebuilt per attempt; no persistent agent home or automatic policy learning |

The owner-selected request modes and project-skill consent model are recorded in [PRD D17](prd-and-roadmap.md#12-decision-register-and-fallback-values). Implementation mechanisms remain proposed and do not grant runtime permissions. The PRD defines the active product requirements and authorization policies.

Node.js 24 LTS is the proposed core baseline; a patch version and ARM64 image are pinned at J00. The OpenCode runtime retains its own dependencies, with no assumption about its internal JavaScript engine. PNPM uses an explicit workspace and `workspace:` internal dependencies; versions and the lockfile are checked into version control. [T1](https://nodejs.org/en/about/previous-releases), [T2](https://pnpm.io/workspaces)

## 3 Topology and trust boundaries

### 3.1 Component view

```text
Mac M2 Pro
  Browser -> 127.0.0.1:3000 -> API + React interface
  `jarvis plan` / `jarvis dev` CLI -> authenticated request API
  Owner-authenticated request/configuration UI

Colima profile jarvis / Linux VM / Docker Engine
  Private core network
    API -> PostgreSQL (internal project/skill config, requests, audit)
        -> worker -> GitHub reader/publisher -> GitHub API
                 -> controller -> Docker Engine

  Ephemeral resources for each attempt
    controller -> fixed Docker exec relay -> OpenCode on loopback
    OpenCode [network none] -> loopback HTTP bridge -> Unix socket
        dedicated transport volume -> LLM gateway -> authorized provider
    plan snapshot mounted read-only OR dev task workspace mounted writable
    separate OpenCode state and temporary files, destroyed at completion
```

The controller shares no network with an agent. The LLM gateway has only an outbound network, with no access to the core network. The transport volume contains only its socket, never a key. The Docker exec channel is a trusted transport initiated by the controller toward an identified container; no Docker API is exposed back into the sandbox. Internal allowlist and skill-consent configuration is read only by trusted core services and is never sourced from a target repository.

### 3.2 Boundaries and assets

| Boundary | Data crossing the boundary | Controls and residual risk |
| --- | --- | --- |
| Owner to API | Authenticated requests and configuration changes | Authentication, CSRF, Origin checks, expected versions, and audit log |
| Browser to API | Session, requests, decisions, and configuration | Authentication, CSRF, Origin checks, expiry, and audit log |
| Core to GitHub | Reads and task-bound PR publication intents | Restricted App, scoped tokens, expected revision, idempotence, and verified response |
| Core to controller | Identifiers and bounded profiles | mTLS, mutual authentication, idempotence, closed schema, and quotas |
| Controller to Engine | Creation, exec, and destruction | Highly privileged access; compromise may affect all containers and shareable files |
| Repository to runtime | Potentially hostile text, skill instructions, and files | Sanitized snapshot, no automatic config/plugin/skill loading; exact user-approved skill revision only |
| Runtime to core | Untrusted report and event streams | Schemas, limits, SHA/path cross-checks, and no action authority |
| Runtime to provider | Code excerpts and prompts | Fixed destination, bounded gateway, budget, and repository authorization; confidentiality also depends on the provider |

GitHub secrets, project allowlist, skill-consent records, effective policy configuration, and database are control-plane assets. Repository code and skill instructions may be confidential but remain untrusted for execution and authority. A repository cannot authorize itself or alter the internal allowlist.

### 3.3 Covered threats and limitations

The threat model includes a malicious PR, hostile instruction file, compromised dependency, manipulated LLM report, replayed event, stuck task, and compromised agent process. Controls must confine a compromised agent to its snapshot, ephemeral state, and LLM request allocation.

The security of the Mac, Colima/Lima virtualization, Docker Engine, the guest kernel, and approved images remains an infrastructure assumption. Containers share the VM's Linux kernel; an escape vulnerability or controller compromise goes beyond OpenCode permissions. A dedicated Linux machine or an independent VM with a dedicated engine is a future option for executing more hostile arbitrary code.

## 4 Sandbox manager options

### 4.1 Comparison

| Option | Engine access | Benefit | Limitation and decision |
| --- | --- | --- | --- |
| A Containerized controller | Engine socket mounted only in this service | Every JARVIS component containerized; simple deployment | Owner-selected for the MVP (PRD D01); highly privileged access must be isolated, audited, and qualified at J01 |
| B Small macOS service | Colima profile's macOS-side Docker context socket, through launchd | No socket in application containers; separate controller | Native exception to the all-Docker objective; Mac maintenance and permissions must be accepted |
| C Separate execution VM or Linux host | Authenticated API or private channel to a separate engine | Separates agent execution from the core VM and its data | Stronger separation than the baseline dedicated Colima profile; more RAM and administration |
| D Generic Docker API proxy | Proxy in front of Engine | Can restrict verbs or endpoints | Insufficient on its own: a container-creation POST can request bind mounts or privileges; not a sufficient security boundary |

Do not use privileged Docker-in-Docker, `privileged` mode, an Engine socket in the worker, or an unauthenticated remote Docker API. A socket mounted `:ro` is not a read-only API: the mount restriction does not prevent mutation calls. The Docker daemon is a privileged control surface. [D3](https://docs.docker.com/engine/security/)

### 4.2 Recommended controller contract

The worker calls an mTLS API reserved for the core network. It sends no `HostConfig`, host paths, unrestricted image, shell command, or agent-requested network. A request contains a task identifier, validated snapshot identifier, approved image digest selected through a profile, deadline, and resource limit selected from a finite set. Unknown fields are rejected.

The controller checks profiles against its own read-only configuration, enforces maximum limits, and generates its own volume names, labels, and identifiers. It does not trust caller-selected names. Its operations are create, health check, open a runtime session through a bounded protocol, cancel, inspect state, and destroy. No general-purpose `exec(command)` endpoint is exposed.

It retains a minimal registry of managed resources and reconstructs state using the labels `jarvis.managed`, `task_id`, `attempt_id`, and `expires_at`. An Engine identifier returned by an agent is never accepted. Cleanup removes only resources whose identity and labels match the registry; it never runs a global prune.

The controller container runs neither OpenCode, repository code, nor LLM prompts. It uses a minimal image, installs no package at runtime, publishes no port, and runs under a user with only the Unix socket access it needs. That access remains powerful despite the other hardening measures. In the Colima deployment, only this container binds the guest socket `/var/run/docker.sock`. The macOS-side socket used by the Docker CLI is a forwarded endpoint, not the bind source for this container. Resolve the host endpoint from the `colima-jarvis` context rather than assuming a path. [C4](https://github.com/abiosoft/colima/blob/main/environment/vm/lima/yaml.go)

The JV-005 implementation uses a fixed mutual-TLS worker API, immutable profile image digests, manager-generated names and ownership labels, a one-sandbox capacity, bounded per-profile CPU/memory/PID/lifetime values, and manager-owned workspace/state volumes. It recovers live attempts from Engine labels and removes only resources whose labels match its registry; its Docker adapter constructs only fixed, non-networked, non-privileged container requests. This describes candidate implementation behavior, not proof of the live Compose mount, TLS provisioning, Docker Engine enforcement, or complete J01 qualification.

### 4.3 OpenCode transport without a control network

OpenCode listens only on `127.0.0.1:4096` inside its sandbox and requires a random per-attempt password. Through Engine, the controller invokes a fixed relay binary shipped in the image, with framed input and output. The relay communicates with the local server and transports the necessary operations: health, session creation, prompt, message/event reads, status, and cancellation. Remote URLs, arbitrary paths, configuration changes, MCP additions, and shell endpoints are prohibited by the JARVIS protocol.

The adapter can use `createOpencodeClient` with a `fetch` transport adapted to relay requests, or a limited HTTP mapping inside the same adapter. The SDK documents a client connected to an existing server and a customizable transport. The prototype checks streams, deadlines, backpressure, cancellation, and errors before this choice is pinned; no extension of OpenCode itself is required. [O2](https://docs.opencode.ai/docs/sdk/)

The JV-006 prototype includes an authenticated loopback HTTP client for the v2 API, a fixed-route Unix-socket gateway transport, and a loopback bridge for OpenCode's provider endpoint. A checksum-pinned OpenCode v2.0.32 ARM64 image runs with a synthetic provider and isolated named volumes on `colima-jarvis`; the checked qualification exercises the actual client for health, session creation, prompt admission, message reads, cancellation and deletion, plus synthetic structured output, network-none, read-only workspace/config, writable isolated state and cleanup. Its host-side fixed exec relay allows only health and qualification-probe operations, but remains a standalone harness rather than a sandbox-manager integration. The synthetic model's shell-tool attempt is refused because the tool is unavailable under the sandbox profile; this does not prove broader policy behavior. It validates no real provider and does not resolve D02/D05. This is prototype evidence, not product readiness.

This transport requires additional JARVIS code. If streaming proves too complex, the first profile can use bounded messages with status polling. It keeps the same boundaries and does not publish the OpenCode port to work around the difficulty.

## 5 Sandbox profile and networking

### 5.1 Static sandbox

The controller applies a pinned mode-specific profile to each attempt. The example below is the read-only plan/review baseline; it is not a complete Compose file. A separate development profile must explicitly add only its isolated writable task volume, never a host mount or broader network/credential capability.

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

The `none` driver leaves only loopback and provides no external network interface. [D4](https://docs.docker.com/engine/network/drivers/none/) The OpenCode container uses a local HTTP bridge on loopback, forwarding requests through the Unix socket in `/llm-transport`. The gateway, another trusted container dedicated to the attempt, listens on this socket and communicates with the provider over TLS. Mounting the directory read-only does not prevent socket connections; UID/GID permissions and socket sharing through Linux named volumes on the pinned Colima/Engine versions are verified in the prototype.

The gateway exposes neither a CONNECT proxy nor an unrestricted destination URL. Its profile fixes the provider, base URL, model, permitted API routes, body size, request count, maximum tokens, concurrency, and deadline. It rejects redirects to other origins and any resolution to loopback, private, link-local, multicast, or metadata addresses; IPv6 and resolution after redirects are included. Destinations for a provider running locally on the Mac are prohibited by default and would require a separate network profile, still outside the MVP.

The actual provider secret resides in the gateway, injected at startup into memory or a tmpfs file with minimal permissions. The agent receives only a per-attempt capability with a bounded budget; if compromised, it can abuse that allocation but cannot obtain a permanent key. The gateway has no GitHub secret, PostgreSQL connection, or Engine socket. Its container is deleted and its capability revoked when the attempt ends.

The JV-006 gateway prototype reads the provider key from a startup file and does not accept it in request data; unit tests use a synthetic key and injected provider response. A separate Colima harness runs a synthetic gateway beside OpenCode through the Unix socket and loopback bridge, but is not wired to Compose or the sandbox-manager lifecycle. It does not pin DNS results against rebinding, provide durable F09 accounting or accepted provider configuration, or qualify permission behavior beyond confirming that the configured profile does not expose shell and OpenCode rejects a synthetic shell-tool attempt. It must not receive private repository data or a real provider key until D02, D05 and the relevant J01/J03 qualification gates are satisfied.

The trusted secrets broker supplies the credential to the gateway through the controlled provisioning channel. A key appears in neither labels, command-line arguments, nor variables inspectable by the agent. The controller can still inspect resources through Engine, so it is inside the trusted secrets boundary. Per-project provider keys and provider-side limits reduce the consequences of its compromise.

### 5.3 Network variant and reasons for deferral

A variant using a Docker `internal` network, outbound proxy, and L3/L4 filtering can replace the socket if isolation is proven. `HTTP_PROXY` variables alone do not force an application to use the proxy. The network gateway must not route arbitrary packets; its administration plane is inaccessible to agents.

This variant requires rules enforced in the actual Colima/Lima VM network path, handling DNS, IPv6, QUIC, and gateway access, and is not the initial profile. Tests must demonstrate that the agent cannot reach `host.lima.internal`, `host.docker.internal`, `gateway.docker.internal` where defined, resolved gateway addresses, Mac and LAN addresses, the core network, or neighboring networks. Test direct addresses as well as names; a failed DNS lookup alone proves no network isolation. Do not rely on the macOS firewall alone to control guest traffic. [C5](https://lima-vm.io/docs/config/network/user/)

## 6 Colima deployment and Mac isolation

Use the Docker runtime in a dedicated Colima profile named `jarvis`. A profile has its own VM and container data. Explicitly select `docker --context colima-jarvis` for administrative operations and assert the expected Engine identity before creating resources. Do not depend on the user's globally active context. Colima replaces Docker Desktop; the Engine API, Compose services, named volumes, and per-attempt container model remain applicable. [C1](https://colima.run/docs/runtimes/), [C2](https://colima.run/docs/profiles/)

Before first startup, prepare the profile configuration with `runtime: docker`, `arch: aarch64`, `vmType: vz` on a compatible macOS version, `mounts: null`, and `forwardAgent: false`. Keep Kubernetes disabled and avoid bridged networking or a reachable VM address unless a separately reviewed use case requires them. Disabling a reachable address is not an egress firewall. Verify the exact settings against the pinned release. [C3](https://colima.run/docs/configuration/)

**Default-sharing trap.** Colima's default mount configuration can expose the user's home directory as writable inside the VM. `mounts: []` does not disable these defaults; `mounts: null` is the documented opt-out. Inspect the effective guest mounts and verify that a Mac-side canary file cannot be read from the VM or a sandbox. Fail startup if a macOS directory share is present. Never forward the SSH agent, mount `.ssh`, or expose cloud configuration or Keychain access. [C3](https://colima.run/docs/configuration/), [C4](https://github.com/abiosoft/colima/blob/main/environment/vm/lima/yaml.go)

Keep snapshots, state, transport sockets, and database data in Linux named volumes. Build contexts can be uploaded by the Docker client without a permanent Mac directory share. Provision bootstrap secrets through a trusted administrative transfer into restricted VM-local files; Compose secret file sources must exist where the daemon can resolve them. No broad Mac mount is introduced to make provisioning work. Section 16 defines ownership and rotation.

Application ports bind explicitly to `127.0.0.1`. Verify both the guest bindings and the forwarded Mac listeners, including a negative connection test from another LAN device. Publish neither PostgreSQL, the controller, nor OpenCode. Host networking, devices, host namespaces, and additional sharing features are excluded. Sleep suspends execution: no 24/7 SLA can be promised on a laptop.

Docker Desktop ECI is not part of this deployment, and no equivalent extra boundary is assumed. All task containers share the Colima VM kernel. The dedicated profile separates JARVIS from personal containers, but a compromised controller can still control the entire JARVIS Engine. Track macOS, Colima, Lima, Engine, and image versions; rerun isolation acceptance after platform updates before affected profiles or publication are re-enabled.

Prefer native `linux/arm64` images, including OpenCode and its tools. The owner-selected D06 baseline is 4 VM CPUs, 8 GiB VM memory if host capacity permits, an 80 GiB VM disk, at least 40 GiB free host disk before provisioning, and a 2-CPU/4-GiB per-sandbox target. Verify native dependencies, volume socket transport, resource limits, mount denial, and network denial at J01 on the actual Mac.

**JV-007 synthetic qualification evidence (October 19, 2026).** On the dedicated Colima 0.10.3 / Lima 2.2.1 / Docker Engine 29.5.2 ARM64 profile, the sandbox-manager and Docker Engine adapter created two temporary `network_mode: none` attempts from a fixed synthetic image. The running probe observed UID/GID 10001, zero effective/permitted/inheritable/bounding/ambient capabilities, `no_new_privs`, seccomp mode 2, distinct PID/network/mount/IPC/UTS namespaces, a read-only root and snapshot, no accessible Engine socket/secret paths or credential-like environment variables, and effective cgroup limits of 2 CPUs, 4 GiB memory, and 128 PIDs. Twenty-two direct IPv4/IPv6 targets (including discovered Mac/LAN/Docker peers and public addresses) and five DNS/Lima aliases were denied. Cancellation/destruction completed in 5.322 seconds; deadline expiry completed in 13.554 seconds, with the attempt containers and volumes removed. The host canary/share/SSH-agent checks also passed.

This is measured evidence for the synthetic manager profile on that pinned local host, not production readiness: the probe received no repository or real credential, and the Compose mTLS manager, production profile/secret provisioning, image scanning, worker boundary, VM/kernel escape resistance, LAN-device listener checks, and requalification after platform updates remain unverified. Product actions remain disabled until applicable owner and native review gates pass. The qualification procedure and limitations are in [`infra/sandbox-manager/README.md`](../infra/sandbox-manager/README.md).

**Selected J01 bootstrap pins (October 19, 2026).** The contributor-selected baseline is Colima 0.10.3, Lima 2.2.1, Docker CLI 29.9.1, Docker Engine 29.5.2 with Ubuntu Noble ARM64 packages and Engine API 1.54, containerd 2.2.4, and Docker Compose 5.6.0. The Compose binary is SHA-256 checked before transfer into the VM. The bootstrap PostgreSQL image is `postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c`, selected with `platform: linux/arm64`. The sandbox-manager runtime base is Node.js 24.22.0 Bookworm slim, pinned to the ARM64 manifest digest recorded in its Dockerfile. Exact values and bootstrap instructions are maintained in [`infra/colima/versions.env`](../infra/colima/versions.env). These pins are reproducible inputs, not evidence that the profile is provisioned, images are scanned, or isolation is qualified.

## 7 Monorepo modules and dependencies

```text
apps/
  api/                 HTTP, sessions, compiled interface
  cli/                 authenticated `jarvis plan` and `jarvis dev` request client
  worker/              workflows, scheduler, and GitHub executor
  sandbox-manager/     Engine control, no LLM business logic
  llm-gateway/         per-attempt bounded provider transport
  web/                 React
packages/
  domain/              entities, transitions, and pure invariants
  contracts/           types, JSON Schema, errors, and events
  policy/              deterministic evaluator and versioned profiles
  github/              Octokit, project reads, and task-bound PR publication
  runtime/             AgentRuntime and common OpenCode adapter
  conversation/        proposed J08 owner/session turns and context lifecycle
  capabilities/        proposed J08 tool registry, broker and provider adapters
  channels/            proposed J09 identity, notification and messaging adapters
  llm/                 profiles, capabilities, estimates, and redaction
  memory/              scoped knowledge lifecycle and bounded context assembly
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
type ProjectRequest = {
  requestId: string; projectId: string; mode: "plan" | "dev";
  prompt: string; projectConfigVersion: number; policyHash: string;
  sourceRevision: string; selectedSkillDigests: string[];
  deadline: string; maxCostUnits: number;
};
type PlanResult = {
  summary: string; steps: Array<{ description: string; sources: string[] }>;
  affectedAreas: string[]; assumptions: string[]; risks: string[];
  questions: string[]; limitations: string[];
};
type PatchResult = {
  summary: string; artifactId: string; patchDigest: string;
  changedPaths: string[]; limitations: string[];
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
  plan(req: ProjectRequest, signal: AbortSignal):
    Promise<{ plan: PlanResult; artifactDigest: string }>;
  develop(req: ProjectRequest, signal: AbortSignal):
    Promise<{ patch: PatchResult; artifactDigest: string }>;
  cancel(attemptId: string): Promise<void>;
}
type Decision = {
  outcome: "allow" | "deny" | "needs_human";
  reasonCodes: string[]; evidenceSnapshotId: string;
  policyHash: string; effectDigest: string; validUntil: string;
};
interface PolicyEngine {
  evaluate(input: TrustedPolicyInput): Decision;
}
```

`TrustedPolicyInput` is constructed exclusively by trusted adapters from the authenticated request, internal project configuration, source revision, and validated plan/patch. It includes explicit mode, project/configuration identity, task path scope, budget and stop state. Model statements cannot populate a "project authorized," "skill approved," "human consent," or "permissions granted" field.

The validator rejects unexpected fields, excessive lengths, non-finite numbers, absolute paths, `..` traversal, and patch paths absent from the task workspace or allowed scope. The plan/patch schema is mode-specific; plan output can never be interpreted as an edit or PR intent.

### 8.2 Sandbox contract

```typescript
type SandboxSpec = {
  taskId: string; attemptId: string;
  snapshotId: string; profileId: "plan-readonly-v1" | "dev-author-v1";
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
| POST /api/v1/session | Local login | Rate limiting, hashed password, no secret in the response |
| GET /api/v1/projects | Internally authorized project list | Owner session, cursor pagination; no repository-derived additions |
| POST /api/v1/projects | Add a project to the internal allowlist | Owner session, stable GitHub identity validation, CSRF, audit |
| PATCH /api/v1/projects/:id | Project settings, allowlist state and suspension | Expected version, CSRF, audit, policy validation |
| POST /api/v1/requests | Submit an explicit plan/dev request | Idempotency-Key, owner session, project/mode validation; ambiguity creates clarification only |
| POST /api/v1/requests/:id/clarification | Answer a pending clarification | Same owner/request, expected version, reauthorize before queueing |
| GET /api/v1/tasks/:id | Request, plan/patch, status and linked PR | Scoped authorization; sanitized output and immutable revision links |
| GET /api/v1/projects/:id/skills | Inspect candidate skill revisions | Read-only discovery; content remains untrusted and non-executable |
| PUT /api/v1/projects/:id/skills/:skillId/approval | Approve/revoke exact skill revision | Explicit owner action, digest/version, CSRF, audit; no command permission |
| POST /api/v1/control/pause | Durable global stop | Prioritized, authenticated, and audited |
| GET /api/v1/digests | Digests and costs | Explicit time zone and period |
| GET /api/v1/usage | Consumption summary and groupings | Authenticated scope, bounded period/groups, IANA zone, currencies and completeness |
| GET /api/v1/usage/requests | Request usage, attribution and provenance | Authenticated filters, cursor pagination, at most 100 rows, no raw model content |
| GET /api/v1/tasks/:id/estimates | Proposed J10 current/historical duration snapshots | Scoped authentication, bounded filters/pagination, target/coverage/calibration, explicit unknown values; no dispatch authority |
| GET /api/v1/repositories/:id/memories | Scoped knowledge and provenance | Authenticated, status filters, cursor pagination |
| POST /api/v1/repositories/:id/memories | Create an observation or owner-authored note | Closed schema, bounded text, Idempotency-Key, CSRF, no policy fields |
| POST /api/v1/memories/:id/revisions | Correct, validate, or invalidate knowledge | Owner session, expected version, source and applicability required, audited |
| DELETE /api/v1/memories/:id | Forget knowledge | Owner session, expected version, CSRF, active-attempt cancellation and purge |
| GET /api/v1/tasks/:id/events | SSE progress | Session, filtered events, no raw sensitive data |
| GET /health/live and /health/ready | Internal probes | Details not exposed publicly |

An API mutation returns `202` for scheduled work, `409` for an outdated version or revision, `422` for an invalid contract, and `429` for a local limit. Ambiguity is a persisted clarification, while authorization blocks carry stable reason codes. There is no merge endpoint and no runtime publication endpoint; only the core's validated dev-task workflow can request PR publication.

Controller routes are separate (`/internal/v1/sandboxes`) and are not published. A local network does not provide authentication: internal mTLS, certificate rotation, service identity verification, and route restrictions remain necessary.

## 9 GitHub App and permissions

### 9.1 Permissions by use case

| Repository permission | Minimum mode | Reason |
| --- | --- | --- |
| Metadata | Read | Repository and installation identification |
| Contents | Read for project snapshots; narrowly scoped write capability may be required to publish a task branch | Snapshot retrieval and, if selected, deterministic branch publication; exact publication path/permission needs owner/configuration validation |
| Pull requests | Read; write for the owner-selected dev-mode PR handoff | PR facts and creation for an authorized task; never approve or merge |
| Checks | Read | Check run state and provenance |
| Commit statuses | Read | Legacy status contexts |
| Administration | Read only if needed to inspect effective protections | Branch verification; never write |
| Actions | Read only if needed to identify the expected workflow | Enable after endpoint-by-endpoint verification |

Issues write, Workflows write, Secrets, Deployments, and Administration write are absent. Merge permissions/endpoints are not part of v0.1. Branch publication and PR creation permissions must be minimized for the selected implementation and validated on a test installation; agent containers never receive tokens. Any `Contents: write` capability remains in a deterministic executor inaccessible to agents. [G6](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)

The initial `@jarvis/github` adapter endpoint/permission matrix is deliberately narrow:

| Endpoint | Adapter operation | App permission (minimum) | Qualification/status |
| --- | --- | --- | --- |
| `GET /repos/{owner}/{repo}/pulls/{pull_number}` | Explicit PR-state read | Pull requests: read | Implemented; installation and live permission behavior not qualified |
| `GET /repos/{owner}/{repo}/pulls?head=…&base=…&state=all&per_page=100` | Reconcile a potentially uncertain PR creation; an incomplete paginated search is unknown, never absence | Pull requests: read | Implemented; no automatic retry on not-found |
| `POST /repos/{owner}/{repo}/pulls` | Create/open a task-bound PR | Pull requests: write | Implemented behind deterministic adapter; live disposable App qualification outstanding |
| Branch/ref/contents write endpoints | Publish task branch before PR creation | **Not implemented / not qualified** | Exact strategy and minimum permission remain an implementation qualification item; no `Contents: write` is implied by this PR endpoint |

Every API effect rechecks both the current internal project allowlist and current installation authorization through trusted ports; removals or inability to establish either authorization fail closed. The trusted token port receives the canonical repository and exact `pull-requests:read` or `pull-requests:write` operation permission so it can provide a repository/operation-scoped installation token; it does not expose credentials to the agent. A lost create response is reconciled by exact repository/head/base/title identity, using GitHub's `owner:head-ref` filter and a detail GET for a match. A complete search with no result is returned as `unknown` with reason `not-found`; failed search or incomplete pagination also remains `unknown`. Even a complete no-match is **not authorization to retry**. The adapter never retries automatically. No issue/event discovery, webhook ingestion, approval, merge, or administrative write endpoint is exposed. These adapter tests do not qualify real App permissions, branch publication, protections, or a disposable installation.

The App is installed only on selected repositories and is not a bypass actor. The broker creates an installation token limited to one repository and the task's permissions. Tokens expire according to the returned `expires_at`; the documentation specifies one hour. Never assume a fixed token length. The App private key never leaves the trusted service responsible for authentication. [G7](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

### 9.2 Reading protections and events

The adapter first reads `GET /repos/{owner}/{repo}/rules/branches/{branch}` for active rules from applicable rulesets, including organization-level rules. This endpoint requires Metadata read permission. It supplements this with classic branch protections when present; inspecting these may require Administration read permission. A 403 does not prove that a rule is absent. The need for this additional permission is therefore assessed per repository rather than granted universally. [G10](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch)

Review conversations and their resolved state may be read for explicit PR-analysis tasks through a read-only GitHub adapter. Missing evidence is surfaced as a limitation; no JARVIS merge decision is made.

Read current GitHub facts when admitting an explicit task and immediately before publication. A repository-provided label or other repository content never substitutes for current trusted state.

## 10 OpenCode and interchangeable providers

### 10.1 Server and adapter

OpenCode v2 documents `opencode serve`, default port 4096, HTTP Basic authentication through `OPENCODE_SERVER_PASSWORD`, and an HTTP API described by its versioned OpenAPI document. The prototype client uses `/api/info`, `/api/session`, prompt admission, message reads, interruption and deletion. JARVIS binds the hostname to loopback, uses a different secret for every attempt, and records the version returned by the info probe. The server is never contacted from the user's browser. [O1](https://opencode.ai/v2/docs/api/)

The adapter uses only a client connected to the server already created by the controller; it does not call an SDK function that starts a local server inside the worker. The SDK/server pair is pinned and tested together. Differences in API shape across versions are confined to this adapter; every update passes contract tests before adoption. [O2](https://docs.opencode.ai/docs/sdk/)

Output is validated against a JARVIS JSON Schema. A native structured-output capability can help, but is not treated as a guarantee: parse errors, truncation, provider refusals, a missing final message, or a broken stream produce an explicit failure. At most one format-repair attempt is allowed within the same budget; it cannot turn incomplete analysis into complete evidence without reanalysis.

### 10.2 Controlled configuration and permissions

OpenCode has several configuration layers, including project files and `.opencode` directories. Setting only `OPENCODE_CONFIG` does not automatically neutralize repository configuration. [O3](https://opencode.ai/docs/config/) JARVIS therefore prepares profile-specific workspaces: a read-only plan snapshot and a separate writable dev task workspace. Neither loads repository `.git` configuration, hooks, active OpenCode configuration, MCP servers, plugins, or skills automatically. Candidate project skills are treated as data and inspected; only an exact revision explicitly approved in JARVIS's internal project configuration may supply instructions. Files not loaded are retained as inert text only when needed for the task.

The prototype also checks recognized instruction files, parent-directory searches, remote configuration, and custom agents. The image starts with no preexisting OpenCode user identity or stored credential. Managed settings in the selected version can supplement this approach, but a permission list is not enough to stop a plugin from executing at startup: loading must be prevented.

The plan profile denies all tools except required reads/searches. The development profile allows only isolated workspace editing and required reads/searches; no GitHub tool, host tool, arbitrary shell, plugin, MCP, task/subagent, or command is enabled. Repository scripts/tests remain disabled pending D16. JARVIS skills are loaded only from a pinned trusted bundle; project skills are supplied as inert, consented instruction content, not executable runtime configuration. No blanket automatic approval is enabled. An unexpected permission request is denied and surfaced. OpenCode permissions are an application layer; sandbox and remote permissions form the effective boundary. [O4](https://opencode.ai/docs/permissions/)

Contributor-session tag routing and skills documented in [`jarvis-request-routing.md`](jarvis-request-routing.md) are not part of these product profiles. In particular, the product profiles disable OpenCode task/subagent tools: product JARVIS cannot spontaneously launch a contributor subagent. Autonomous J06 delivery is separately gated and specified as bounded attempts/sessions in JV-044–JV-048; contributor agent delegation is not evidence that the product capability exists.

### 10.3 Two LLM abstraction levels

`ModelProfile` contains the provider, model, capabilities, maximum context, output limits, data rules, versioned prices, and authorized project set. The core may use a `TextGenerator` port for an optional digest. Plan and dev missions are delegated to distinct qualified `AgentRuntime` profiles; an adapter translates the trusted profile into OpenCode configuration and gateway endpoint. Runtime output cannot select the project or change task authorization.

OpenCode documents multiple providers and local models. This does not guarantee equivalent tool calling, streaming, or JSON behavior across every combination. [O5](https://opencode.ai/docs/providers/) The MVP compatibility matrix qualifies two authorized providers with the socket bridge, authentication, limits, and output contract. Switching providers remains a configuration operation without changing the domain.

Fallback is limited to a per-repository approved list with the same confidentiality level and a cost reservation. Provider unavailability never justifies automatically sending the repository to an additional destination. Using a model on the Mac through a route to the host requires a specific profile and remains deferred.

## 11 PostgreSQL data model

### 11.1 Main entities

| Table | Key fields | Constraints and purpose |
| --- | --- | --- |
| installations | github_id, app_id, state, revoked_at | Unique external identity; revocation immediately blocks tasks |
| projects | github_id, owner_id, state, config_version | Internal owner-controlled allowlist; stable identity, never provisioned from repository files |
| project_config_versions | project_id, version, policy_hash, provider_profile, limits, permissions, created_by | Immutable audited internal project configuration |
| project_skill_approvals | project_id, skill_id, revision_digest, decision, actor_id, config_version, decided_at | Exact revision consent stored internally; revocation/change invalidates selection |
| requests | request_id, owner_id, project_id, mode, prompt_digest, state, idempotency_key | Authenticated explicit request; clarification is not an admitted task |
| policies | id, version, canonical_json, hash, activated_at | Immutable core-controlled policies; agent output cannot write |
| pull_requests | project_id, number, head_sha, base_sha, remote_state | Unique project and number; current-state projection |
| evidence_snapshots | revision, checks_json, reviews_json, rules_json, fetched_at, hash | Immutable evidence from trusted adapters |
| tasks | project_id, request_id, mode, revision, profile_hash, policy_hash, config_version, state, dedupe_key | Explicit request and mode bound to allowlist/configuration snapshot |
| task_attempts | task_id, ordinal, lease_epoch, lease_until, sandbox_id, state | Append-only attempt history; absolute deadline |
| task_checkpoints | task_id, attempt_id, lease_epoch, step, schema_version, state_json, created_at | Core-authored bounded workflow state; no arbitrary command or provider session replay |
| knowledge_items | repository_id, id, current_version, lifecycle_state, deleted_at | Stable identity, scoped authorization, lifecycle serialization |
| knowledge_versions | repository_id, item_id, version, claim_kind, content, source_ref, source_hash, applicability_json, review_after, validated_by, created_at, search_vector | Immutable bounded revisions; content purge supported through a privileged retention role |
| task_contexts | task_id, attempt_id, repository_id, schema_version, profile_hash, input_hashes, selected_versions, omissions, budget, created_at | Manifest of inputs and memory versions; no duplicate raw excerpts |
| forgotten_items | repository_id, item_id, forgotten_at | Content-free deletion markers, also exported separately for restore reconciliation |
| review_reports | task_id, attempt_id, schema_version, report_json, digest | Immutable report; one accepted canonical version per task |
| policy_decisions | request_id, evidence_id, artifact_digest, policy_hash, outcome, reasons, effect_digest | Decisions never modified in place |
| action_intents | action_key, task_id, revision, kind, state, remote_id | Unique logical publication action; unknown result distinct from failure; no merge intent in v0.1 |
| outbox | id, aggregate_id, event_type, payload, available_at, delivered_at | Event written in the same transaction as domain state |
| scheduled_runs | schedule_id, local_date, period_start, period_end, state | Unique per schedule and logical occurrence |
| daily_digests | scope_id, local_date, source_watermark, body, totals_json | One current version per date; totals retain provenance |
| model_requests | request_id, operation_id, scope_ids, attempt_id, purpose, provider, model, profile_version, dispatched_at, state | Persist before dispatch; distinct billable retries have distinct identities; optional future agent/parent attribution |
| usage_allocations | allocation_id, parent_id, scope_id, period, limits, held_exposure, state, version | Durable scoped reservations; transactional child allocation without counting reservations as spending |
| usage_observations | request_id, source, observation_id, revision, numeric_usage, mapping_version, coverage, observed_at | Unique request/source/observation/revision; bounded allowlist, no prompt text; snapshots are not summed |
| usage_ledger | request_id, canonical_revision, reserved, token_counts, field_statuses, estimated_charge, provider_reported_charge, currency, price_version, reconciliation_state | One canonical charge per request, immutable correction evidence and uncertain exposure; atomic reservation/projection updates |
| audit_events | actor, action, resource, correlation_id, occurred_at, details_hash | Insert-only for the application role; purge by a separate role |

GitHub identifiers are stored as `bigint` or text and serialized as API strings to avoid JavaScript precision loss. Monetary amounts use decimals or integer currency units with sufficient precision, never binary floating point. Timestamps use UTC `timestamptz`, with the schedule's IANA time zone stored separately. JSONB fields carry a schema version and do not replace columns needed for constraints.

### 11.2 Relationships and integrity

An installation can serve multiple internally allowlisted projects. A project has immutable configuration versions, exact-revision skill-consent records, requests, and pull requests. Each task binds the project identity/configuration, explicit mode, task prompt digest, source revision, profile, policy, and selected skill digests. A decision references the request and evidence. Publication intents reference one authorized dev task; no merge intent is defined for v0.1.

Composite foreign keys and authorization checks prevent a report, skill approval, or task from project A authorizing an action on B. Task admission and effect dispatch recheck current project authorization, configuration version, skill revision, task mode, and expected source revision. A partial unique key prevents duplicate PR-publication intents for one task. No memory, skill content, or model message can insert or mutate internal authorization rows. Deleting secrets and temporary artifacts is independent of retaining minimal audit evidence.

Application audit records are not tamper-proof against a PostgreSQL administrator or compromised Engine control. A hash chain and regular exports can make changes detectable; a regulatory guarantee would require dedicated external storage, outside scope.

### 11.3 Memory ownership and categories

JARVIS owns durable memory in PostgreSQL volumes. A fresh OpenCode container receives a selected context, produces a report, and is deleted; its HOME, raw conversation, and provider session are not the long-term store. Provider changes do not change knowledge identifiers or require migration of a provider's private conversation state. No model training or weight update is implied.

| Category | Authoritative storage | Lifecycle and use |
| --- | --- | --- |
| Working state | Tasks, attempts, leases, core-authored checkpoints | Resume the workflow at a safe boundary; recreate the sandbox after a crash |
| Operational history | Reports, observed GitHub outcomes, decisions, audit, usage | Evidence and prior incidents; preserve the distinction between analysis and observed results |
| Repository knowledge | Knowledge items and immutable versions | Conventions, architecture facts, sensitive paths, past regressions, and hypotheses with provenance |
| Preferences and rules | Versioned repository configuration and policies | Owner-controlled authority; not writable through knowledge APIs or agent output |

The memory module owns lifecycle transitions, scope checks, retrieval, and context manifests. The worker invokes it through a typed port; agents and LLM gateways have neither SQL access nor a general memory API. Owner-authored notes enter as observations and may be validated through an explicit authenticated action. Automatically extracted notes are proposals with `claim_kind` observation or hypothesis; a model's confidence score never substitutes for validation. Validation records an actor and supporting source but grants no execution authority to text.

### 11.4 Applicability, provenance, and context assembly

Each knowledge version records its repository, source type and identifier, source revision/hash, creation date, claim kind, dependency/version or path applicability, review deadline, and optional superseded version. GitHub facts retain their revision and observation date. Model summaries retain their source links and limitations; a summarized assertion does not become a verified fact merely because it appears in several reports. Do not automatically follow URLs stored in memories.

For each attempt, the core performs the following bounded procedure:

1. Resolve the authorized repository and current H/B through trusted adapters; read the active policy separately from knowledge.
2. Filter by repository, lifecycle state, review deadline, source validity, and applicability to the current dependency, paths, and revisions. The initial default supplies only owner-validated knowledge as additional memory; recent unvalidated reports remain visible in history and may inform a proposal, not automatic reuse.
3. Rank eligible items using exact metadata matches and PostgreSQL full-text search, with deterministic recency and identifier tie-breaking. PostgreSQL supports indexed text matching and relevance ranking; JARVIS must implement the authorization and lifecycle filters itself. [P3](https://www.postgresql.org/docs/current/textsearch-intro.html)
4. Select at most 10 items within 4,000 tokens and 32 KiB in total. These are proposed defaults within the selected runtime's complete input/output context allowance. Use the provider/model tokenizer or a conservative bound; no known token budget means no start. Required mission and current evidence take priority. If critical input cannot fit, return an explicitly limited plan or stop development before publication. Record omitted items and contradictions without generating an unsupported consensus.
5. Persist a context manifest containing input hashes, knowledge versions, retrieval/profile version, and limits. Deliver selected excerpts as explicitly quoted, untrusted reference data through the controller transport; do not provide database access or a searchable history dump to the agent.
6. Bind the accepted report to that manifest. Before accepting it, verify that the selected versions have not been deleted, invalidated, expired, or superseded. A conflicting edit cancels the attempt and schedules fresh analysis if authorized. Current GitHub checks and protections are still reread before any action.

The initial retrieval path requires neither embeddings nor a vector database. Later semantic retrieval must retain the same scope and deletion filters, pass a relevance and leakage corpus, and account for the confidentiality and cost of any external embedding provider.

### 11.5 Knowledge lifecycle, forgetting, and recovery

Use `proposed`, `validated`, `invalidated`, `expired`, and `deleted` lifecycle states; `claim_kind` separately distinguishes an observation from a hypothesis. Owner validation or correction requires an expected version, source, applicability, and review date. Each transition records an audit event in the same transaction and increments the item version. Repeated proposal ingestion is deduplicated by repository, source version, and normalized content hash. Contradictory claims remain distinguishable; a later date alone is not proof that one is correct.

Proposals initially expire after 30 days. Validated items require review within 90 days and are excluded after that deadline unless explicitly revalidated. Changed supporting files/revisions invalidate revision-specific claims; dependency claims apply only within their declared version range. When the core cannot establish applicability or supporting evidence has been purged, it excludes the item and requests review. Revalidation must retain a minimal supporting citation under the selected knowledge retention policy rather than copying entire expired reports.

Deletion atomically marks an item forgotten and makes it immediately ineligible for new context selection. The worker cancels affected active attempts, invalidates pending task/publication eligibility that depended on its context, purges content and derived search data within 60 seconds, and clears in-process caches. Context manifests keep only identifiers and hashes. Historical reports containing the forgotten content must also be purged or redacted; the interface explains the scope. Retained audit metadata contains no memory text. Knowledge deletion does not retract an already accepted GitHub effect, which remains tracked through its outcome.

Encrypted backup copies disappear according to the documented backup rotation rather than instant physical erasure. Keep a minimal content-free forgetting ledger in a separate trusted administrative export, updated before confirming completion. On restore, reconcile that ledger and reapply deletions before exposing memory or resuming tasks. Test this procedure with a backup made before deletion; never claim immediate removal from provider-side retention or immutable backups.

Task recovery uses a lease-bound core checkpoint, not an agent-written command list or trusted chain of thought. Reconcile unknown GitHub effects before retrying, reread current remote state, recreate ephemeral resources, and build a new context manifest. A previous report remains historical evidence and does not become a new approval.

## 12 State machines and workflows

### 12.1 States

A request follows `received -> clarifying` or `authorized -> queued -> preparing -> running -> validating -> completed/limited/blocked`. A plan task can only return a plan; a dev task may validate a patch and prepare a PR intent. Alternative terminal states include `failed`, `cancelled`, `timed_out`, and `superseded`. A recoverable failure closes an attempt and requeues with a new attempt; it does not reuse a partially compromised sandbox.

A decision can deny an action, require human input, or authorize an intent. An intent follows `prepared -> dispatched -> pending_remote -> confirmed`, with alternative states `rejected`, `unknown`, and `cancelled_before_dispatch`. `unknown` is never treated as `failed`, because a remote effect may already have occurred.

### 12.2 Ingestion and reconciliation

1. The authenticated API validates request size, owner session, idempotency key, selected project identity, and explicit `plan`/`dev` mode.
2. The core reads the current internal allowlist/configuration. If the project or intent/mode is ambiguous, it records a clarification request without creating a model attempt or external effect.
3. For an authorized request, the core persists the immutable request, configuration version and task intent transactionally, then rereads current project/revision facts through trusted adapters.
4. A task is created with a unique business key. Duplicate requests return the existing canonical task; old or stale source revisions cannot silently reset a task's binding.
5. On restart, reconcile leases and unconfirmed PR-publication operations before resuming authorized work.

### 12.3 Snapshot preparation and task execution

The GitHub service resolves H and B and downloads the exact trees or archives with a read token. No clone token is given to the runtime. Downloads use approved GitHub origins and verified redirects; Authorization is not forwarded to an arbitrary host. Submodules and Git LFS are not resolved automatically.

A trusted preparer neutralizes absolute paths, traversal, special files, escaping symbolic links, excessive decompressed sizes, and malicious archives. Base/source snapshots and a manifest of exclusions are retained under opaque identifiers and hashes. The plan profile mounts the sanitized snapshot read-only. The dev profile mounts a separate per-attempt writable task workspace; its output is treated as an untrusted patch and validated against path, size, symlink, and task-scope limits before any publication. Repository commands, installation and tests remain disabled until D16 is accepted and an execution profile is qualified.

The controller copies validated inputs into dedicated volumes through the Engine channel, without extracting repository data onto the Mac. The controller creates the gateway, state, and mode-specific workspace, checks health and effective configuration, and then the adapter sends the fixed mission with bounded context assembled under section 11.4. The core validates report or patch, cross-checks project/mode/path/revision and selected skill digests, persists usage/result, and destroys the sandbox even on failure. An independent janitor provides a second cleanup mechanism.

### 12.4 Request authorization and skill consent

Admission is performed by the deterministic core against authenticated owner identity and the current internal project allowlist. The admitted task records project stable identity, request/mode, project configuration version, policy/profile digests, source revision, and selected context. Any ambiguity is returned for owner clarification before an attempt is created.

Project skills are enumerated as untrusted data. Before use, the owner sees the skill identity and exact digest/revision; the core stores explicit approval only in internal project configuration. Admission checks that same digest before including its instruction text. A changed, revoked, or unverifiable revision is excluded until its exact revision is approved. Skill consent does not confer command execution, provider, filesystem, GitHub, or broader project permissions.

### 12.5 PR publication and revision races

1. Acquire an exclusive task/publication lease; recheck owner/project authorization, suspension, mode, configuration and policy versions, budget, and stop epoch.
2. Reread repository identity and target/base revision through the trusted GitHub adapter. A changed authorization, source revision, or task scope invalidates the candidate and requires revalidation or a new attempt.
3. Validate the patch independently of the model: permitted project and task, exact path set, file types, size, symlinks, diff integrity, and source/base binding. A dev profile cannot request broader scope or add an approval.
4. Persist an idempotent PR-publication intent bound to the task, base/head, patch digest, target branch, selected policy and publisher profile. Use only a trusted executor with a narrowly scoped installation token; no token enters OpenCode.
5. Publish the branch/PR using the selected GitHub API strategy. The exact branch-write mechanism and minimum App permissions remain an implementation qualification item; do not grant merge or bypass permissions. Record the remote PR identity and reconcile after uncertain responses before any retry.
6. Return confirmed, failed, or unknown publication status. An unknown result is never treated as failure or retried blindly. JARVIS does not call any merge endpoint in v0.1; subsequent human/GitHub review and merge remain external.

GitHub branch protections and required reviews remain authoritative. A PR creation result does not mean checks passed, review was granted, or merge is authorized. Endpoint/API version and selected write permissions must be tested on a disposable repository before publication is enabled.

### 12.6 CI evidence and provenance

For each piece of evidence, JARVIS retains the evaluated SHA, name, type, run identifier, issuer, conclusion, and timestamps. Check runs and commit statuses are read separately and paginated. Absence is not success. An aggregate `success` result alone does not prove that a configured check exists. [G8](https://docs.github.com/en/rest/checks/runs), [G9](https://docs.github.com/en/rest/commits/statuses)

When a request asks for CI context, the adapter binds each reported check to its evaluated SHA and displays missing/ambiguous evidence as a limitation. JARVIS v0.1 does not convert check state into merge eligibility. [G5](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

For GitHub Actions, a shared `app_id` does not distinguish workflows. A user-requested validation assessment must identify expected workflows/jobs and disclose if a workflow is changed by the candidate. Pipelines using PR code with powerful secrets, particularly unsafe uses of `pull_request_target`, remain a project risk; JARVIS cannot make an insecure CI design trustworthy.

### 12.7 Digest and catch-up

The scheduler determines the daily occurrence in Europe/Paris and records its UTC boundaries. Uniqueness is based on local date and scope, not a fixed 24-hour interval. On restart, it produces a catch-up digest covering missed days, indicating the interruption in monitoring.

Task and PR totals/lists come from SQL queries over confirmed facts. Optional LLM-written prose receives these facts and links under a separate budget; if generation fails, a deterministic template remains available. Outbound links and Markdown are sanitized. PR-publication operations in `unknown` state are never presented as successful.

<!-- Preserve previously published section links. -->
<a id="128-proposed-v03-autonomous-delivery"></a>

### 12.8 Proposed autonomous delivery

This extension is planned in [JV-044](https://github.com/grasdouble/Jarvis/issues/44), with profile/policy, autonomous issue selection, independent review/repair and qualification slices JV-045–JV-048. It is distinct from the v0.1 explicit user-requested dev workflow: J06 adds autonomous issue-to-PR delivery and its separately selected routine merge policy, not the first writable product profile. The session-driven [contributor procedure](autonomous-delivery.md) is a separate development capability.

Reuse domain/policy, orchestration, runtime ports, sandbox-manager, persistence and GitHub executor modules in the PNPM modular monolith. Keep role-specific adapters behind typed ports; no OpenCode plugin or second general-purpose planner is required. Core alone selects context, validates outputs and owns credentials/effects.

- **Author attempt:** isolated writable task volume; sanitized scoped issue/base snapshot; export a bounded patch/artifact. No host shares, Engine socket, GitHub credentials or permanent provider key. A trusted validator rejects traversal, symlinks, unexpected artifacts and out-of-scope changes before publication.
- **Reviewer attempt:** new read-only snapshot/context bound to exact base/head and accepted criteria, separate from author conversation/state. The core verifies coverage, paths and reviewer-attempt provenance. Findings and `approved`/`changes_requested`/`limited` are model assessments; no field becomes native approval or merge authority.
- **Validation executor:** separately qualified repository-command environment, without LLM gateway or GitHub/provider credentials. Dependency acquisition, egress, quotas and artifact channels need an accepted profile; do not inherit or silently widen the v0.1 dev profile.
- **Publisher/merge controller:** extends v0.1 trusted PR publication for autonomous issue delivery and any separately accepted merge capability. It validates scope and CI/protection/review facts, prepares durable intents, and rechecks revision-bound eligibility. Routine automation requires explicit per-project policy; sensitive/unknown changes retain human approval. No author/reviewer bypass or personal credential fallback.

Proposed durable records extend the existing schema with `delivery_runs` (issue/PR/branch claim, authorization/policy versions, state, limits/spend/start/deadline, stop epoch), `delivery_rounds` (run/round/base/head, author/reviewer attempt IDs, validated report digest), `delivery_findings` (stable ID, location, blocking severity, disposition/evidence) and publication intents. Unique keys bind run/round/role and remote effect targets; leases and inbox/outbox prevent duplicate work. A PR comment is an audit projection, not the authoritative run ledger. Validate final schemas in JV-045 rather than declaring these tables installed.

Transitions: authoring → validating → publishing → reviewing; requested fixes go through fixing → validating → reviewing on a new revision. Complete evidence goes to eligible or needs_human under J06 policy, then a separately authorized merge intent where policy allows. Persist limited/blocked/exhausted/cancelled and uncertain-effect states explicitly. Every relevant revision/policy/evidence change invalidates eligibility. Reread/reconcile PRs, refs, reviews and merge outcomes before retrying ambiguous effects; never reuse an approval for a different action digest.

The core enforces owner-configured finite review-round, time, token/currency and resource limits across crashes and retries. Exceeding a limit stops the run and records the required owner action; model output cannot extend it. Cancellation/revocation invalidates leases and future effects. UI/digest expose rounds, findings/dispositions, costs, head/base, approval gates and actual remote results. Qualification includes stale reviews, malicious suggestions, CI/protection changes, forked/renamed paths, duplicate events, lost responses, restore/revocation and zero unauthorized effects in a controlled pilot. See P11 and D12 in the PRD.

<!-- Preserve previously published section links. -->
<a id="129-proposed-post-v03-self-improvement"></a>

### 12.9 Proposed self-improvement

Track [JV-051](https://github.com/grasdouble/Jarvis/issues/51) and children JV-052–JV-055 after verified JV-044 delivery. P12/D13 define the J07 gate; the contributor skills and MVP/J06 delivery plans do not implement this capability. Reuse the memory/observability inputs, domain/policy, orchestration, durable queue, qualified runtime/validation ports and GitHub executor in the PNPM modular monolith. The core controls proposal selection, evaluation decisions and remote effects; no new unrestricted planner, model training or live self-edit endpoint is implied.

**Signals and selection.** Ingest only authorized, sanitized operational observations with repository/run/revision/window provenance. Persist deduplicated proposals with hypothesis, expected measurable outcome, risk, uncertainty, source validity and optional canonical promotion PR once real changes exist. Bound ingestion/proposal volume, use cooldowns and retain rejected/deferred dispositions so a recurring metric does not create endless work. Observation text and memory cannot change policy, select an unauthorized repository or promote themselves into validated knowledge. F10 forgetting/retention applies to evidence and derived proposals; unavailable evidence prevents selection/reuse.

**Independent comparison.** A trusted evaluation controller pins the released incumbent, candidate commit/artifact, protocol/corpus, environment/provider/check profile and thresholds outside candidate write scope. Compare equivalent authorized workloads, account for stochastic variability and sufficient samples, and include correctness/security/completion guardrails alongside latency/tokens/currency. Preserve unsuccessful attempts and total spending, not just winning trials. Changed or incomparable inputs, missing measurement or insufficient confidence produce inconclusive/rejected, never an agent assertion of improvement. Keep reserved evaluation cases outside the author context and writable workspace; record exposure and control repeated-trial overfitting. Candidate edits to tests or prompts do not replace the protected acceptance corpus; changes to evaluation criteria require a separate human-approved protocol version and a new comparison.

**Isolated delivery.** Select only a bounded policy-authorized proposal and reuse the qualified author/test/reviewer/publication workflow from section 12.8. Agents receive no GitHub/deployment credentials, protected evaluator write access or writable released core. The independent reviewer authored none of the candidate and examines functional regressions as well as claimed gains. Eligibility binds the complete evidence/protocol/policy digest and current head/base; every relevant change invalidates it. Finite cumulative experiment/time/token/currency/resource budgets, stop epochs and leases persist across crashes and cannot be extended by a candidate. Sensitive or unknown execution/permission/approval changes retain human gates.

**Operational tracking and skill.** Persist repository-scoped unique proposal/campaign identities and at most one active promotion, with native label/project/view IDs. Keep pre-patch or rejected/deferred proposals internal; a real candidate diff permits one draft main-promotion PR labeled `self-update`, added to the dedicated project view and maintained with detailed evidence. No operational issue or milestone is required; J07 issues build the mechanism. The controller validates the same content for browser and programmatic publication and reads back PR/base/head/label/project metadata. A saved filter does not import PRs into the project or grant authority. Reconcile missing/drifted metadata and partial/superseded effects without creating another campaign or budget; the [campaign contract](self-improvement-campaigns.md) specifies uniqueness, draft readiness and audit history.

Use the versioned [product skill source](../skills/jarvis-self-improvement/SKILL.md) only through the future qualified J07 adapter. Supply its released procedure/reference bundle and selected [project profile](../skills/jarvis-self-improvement/references/project-profile.schema.json) read-only from trusted controller configuration; bind separate bundle and profile digests into the context manifest and exclude candidate/project/global skill or profile substitution. The profile describes repository, branch, tracking and content/result conventions only; controller-owned policy retains permissions, writable scope, budgets, thresholds and all approval/publication/activation decisions. The skill returns structured proposal/patch/result intents; core owns tools, credentials and effects. No loader/tool handler or OpenCode plugin is installed. Static MVP skill loading remains disabled; profile/schema/loader qualification in JV-053/JV-054 precedes enablement.

**Campaign promotion and repair.** Implement the [bounded campaign contract](self-improvement-campaigns.md) through the existing orchestration/GitHub ports. The stable controller owns claims, policy and credentials; author/test candidates cannot mutate it or their evaluator. Pin deployed incumbent `S`, target main `B` and assembled candidate `H` separately. One temporary integration branch per hypothesis accepts authorized independently reviewed task PRs, with serialized fenced publication and child-to-integrated revision mappings. Even routine self-improvement needs current human approval of the final main promotion digest; native review/check protections still apply. Preserve the ordinary autonomous-delivery/contributor policy outside this mode.

Freeze admission on drift/conflicts. A separately claimed repair branch reconciles latest main using a qualified ancestry-preserving strategy without rewriting shared history, preserves both sides' acceptance, reruns full-diff tests/comparison and independent review, and publishes through a guarded repair PR. A squash-only target uses a fresh main-based promotion candidate with manifest-backed replay and linked PR supersession; it cannot assume squashing a repair into an old campaign preserves main ancestry. Rebind evidence to the resulting integrated SHA before renewed human promotion approval. Semantic conflicts need the same treatment even without Git markers. Races, unknown effects, exhausted cumulative budgets, revoked authority or unresolved intent stop and reconcile/handoff. Candidate-integrated internal tasks remain undelivered until verified main delivery and their acceptance; record activation separately and retire the short-lived branch after promotion/abandonment. The campaign contract specifies future scenario evidence, not an installed remediation service.

**State and persistence.** Proposed records are `improvement_proposals` (source/deduplication key, hypothesis, scope, disposition, optional canonical promotion PR), `improvement_experiments` (proposal, immutable comparison manifest, attempts/budgets, measured results/uncertainty, decision) and `rollout_intents` (authorized artifact/config, environment/cohort, ownership/lease, abort/recovery profile, observed outcome). Extend delivery/experiment records with the campaign manifest, `S/B/H`, child PR/revision mappings, fenced owner/stop epoch, cumulative limits, protocol/evidence/policy digests, human promotion digest and repair episodes; keep activation intents separate. Existing delivery runs/reports and inbox/outbox remain authoritative for PR effects. Transitions are observed → proposed → selected/deferred/rejected → assembling/candidate-integrated → experimenting/evaluating → improved/inconclusive/rejected → awaiting-human-promotion → promoting → merged/pending-rollout → authorized rollout → confirmed/aborted/recovered/needs_human. Unique keys and reconciliation prevent duplicate proposal/PR/experiment/rollout effects. Stop/deletion/restore rechecks applicability and invalidates pending actions rather than reviving old eligibility.

**Activation and rollback.** Merge neither deploys nor hot-reloads source/prompts/configuration. A separate trusted release controller accepts only an explicitly authorized immutable artifact and qualified bounded rollout profile; it does not inherit an experiment's publication authority. The incumbent remains available as last-known-good. Replay/shadow tests disable external writes; a live canary partitions task ownership/leases and action budgets so two versions cannot perform the same mutation. Local Colima resource/canary feasibility must be measured; if the environment cannot support a meaningful bounded comparison, hand off instead of inventing a successful rollout. Verify artifact/config/schema compatibility and a tested backup/restore path before activation. An irreversible migration or incompatible downgrade requires an explicit human recovery plan; automatic rollback cannot be asserted from image availability alone.

UI/digest show every proposal and disposition, sources, revisions, fixed protocol, baseline/candidate measurements, uncertainty, total cost, independent review/human gates, and separate merge/deployment/recovery results. JV-055 qualifies the integrated corpus and controlled pilot before owner enablement. The release design draws on [Google SRE canary guidance](https://sre.google/workbook/canarying-releases/), checked October 16, 2026: limited rollout and comparison against a control inform release decisions. That guidance does not establish that JARVIS or its local Colima deployment already supports canaries.

### 12.10 Proposed shared runtime and general-purpose assistance

[JV-064](https://github.com/grasdouble/Jarvis/issues/64) and children JV-065–JV-068 plan a post-MVP conversational capability in J08, with no committed version/date and no automatic dependency on J06/J07. The [shared runtime/capability contract](common-agent-runtime.md) defines full profiles, contracts, trust boundaries, recovery and qualification. Reuse the PNPM modular monolith and headless OpenCode adapter; JARVIS retains deterministic authorization, persistence/memory, budgets, scheduling, secrets and external-effect ownership. No second agent framework, Herdr service or OpenCode plugin is required.

Keep v0.1 plan/dev request contracts and exact repository/revision binding distinct from J08 conversational turns. Add a versioned tagged mission/result port for general requests, bound to authenticated owner/session/turn/attempt, trusted released profile/policy/tool/model digests, context manifest, reservation, deadline, fence and stop epoch. General requests require neither repository nor issue. Model-suggested tools/profile changes are requests for deterministic admission; unsupported or ambiguous requests return limits/clarification, not escalation. Conversation, v0.1 code author, independent reviewer and self-improvement use distinct attempts and context/tool scopes.

The future `assistant-readonly-v1` profile has no repository/host mount, Engine socket, shell/edit/delegation tools, permanent key, GitHub writes or direct network. Expose only admitted typed capabilities through a separately qualified narrow per-attempt transport, such as a guest-volume socket with controlled MCP stdio or a typed adapter bridge. Core validates identity, schema, catalog/policy, arguments, scope, limits and current stop/lease before a trusted executor calls the allowlisted service. Keep service secrets and outbound networking outside the agent, and constrain redirects, DNS/IPv4/IPv6, response sizes and timeouts. Do not turn the LLM gateway into a generic proxy or load repository/global tool configuration. Missing proof under pinned OpenCode/Colima disables the new profile while leaving the MVP restrictions in place.

Extend proposed records with owner-scoped conversations/turns and capability invocations/results, using existing persistence, queue, memory, policy and observability ports. Unique message and invocation keys, fenced claims, durable intents and remote rereads reconcile duplicates, reconnect/restart and unknown effects without resetting limits. Conversation context is bounded and separate from repository knowledge; provenance, sensitivity, expiry and forgetting apply to raw/derived data and restored backups. Conversation persistence and reusable knowledge need accepted D14 retention/consent. Record model plus tool costs and partial/cancelled/unknown outcomes without raw private log dumps. A model answer, closed turn or tool result cannot authorize GitHub actions, promotion or activation.

The first read-only weather connector resolves Nantes/location and current-versus-forecast intent, then returns validated source/location/time/units/freshness or explicit stale/unavailable/ambiguous data. Tests and a controlled live pilot must qualify the detailed corpus, actual transport/egress isolation, scoped memory, stop/restore and cumulative usage with zero unauthorized effects. Numeric limits, provider/data processing, tool transport/profile, freshness and retention remain D14 decisions before the relevant live operation. This specification installs no chat route, connector, MCP server or executable profile; all capabilities remain subject to their applicable authorization, isolation and qualification gates.

### 12.11 Proposed messaging channels

J09/P14 plans Telegram and Signal as separate trusted transport adapters, with [JV-075](https://github.com/grasdouble/Jarvis/issues/75) and children JV-076–JV-081. The [messaging contract](messaging-channels.md) defines notification-first delivery, later per-channel J08 conversation, owner pairing/consent, closed interfaces, candidate Signal bridge qualification and D15 gates. Reuse the PNPM modular monolith with `packages/channels`, existing API/worker/domain/contracts/persistence/queue, conversation and F09 accounting. No OpenCode plugin or second model loop is required. Notifications depend on MVP delivery; conversation also depends on J08 qualification. Neither adapter requires the other or J06/J07 solely by phase number.

Trusted connectors hold bot/account/device secrets, restrict egress and normalize provider identity; agents retain no network or credential access. A selected Signal bridge runs with restricted VM-local state and narrow authenticated RPC, without personal Mac/profile mounts or raw browser/agent access. Telegram polling is an option without inbound publication; a selected webhook requires HTTPS, configured secret-header validation and a narrowly exposed intake only. Existing administration loopback bindings remain unchanged; a mobile message link does not justify exposing the UI/API.

Proposed PostgreSQL records are `channel_connections`, `channel_bindings`, `channel_inbox`, `channel_deliveries` and `channel_delivery_attempts`, keyed by owner/connection/provider message or logical event/turn and binding. Transactional intake/outbox and fenced claims coalesce repeated observations, retain all attempts and reconcile unknown effects. Do not assume exactly-once external sends, indefinite provider replay or remote deletion. Expiry, budget, consent/revocation and forgetting/restore apply before dispatch/replay. High-cardinality recipient/content facts stay outside telemetry; no raw credential-bearing URLs or chat transcripts in logs by default.

The paired private sender maps to existing owner scope, not a broader approval role. Questions/status use qualified J08 profiles; code requests become separately admitted J06 missions only when available, and self-update retains current human promotion/activation rules. Sensitive approvals remain in authenticated UI/GitHub; text, buttons and reactions cannot approve a revision. D15 leaves actual accounts/bridge/transport, limits, retention/disclosure and pilot/enablement unresolved; no live integration or new permission is installed here. Qualification includes hostile/duplicate/edited/echo inputs, unknown delivery, sleep, rate limits, stop, deletion/restore and actual per-channel transport evidence.

## 13 Idempotence and consistency

| Level | Key and mechanism | Intended guarantee |
| --- | --- | --- |
| Request intake | Owner + Idempotency-Key + request digest | A replay returns the canonical request; a changed payload conflicts |
| Task | request_id + project/configuration/policy/profile versions + source revision | A replay returns the canonical task; retries create new leased attempts only under core policy |
| Attempt | task_id + ordinal, monotonic lease_epoch | Retry history and rejection of stale worker results |
| Sandbox creation | Unique attempt_id in the controller | A lost response does not create a second container |
| Authorization | request_id + mode + project/configuration/policy revision | Core rechecks current allowlist and task scope; skills cannot grant permission |
| PR publication | dev_task_id + patch digest + base/target revision, durable intent | Reconcile unknown outcomes before retry; no merge or approval intent |
| Digest | scope + local_date | One logical occurrence despite daylight saving time and recovery |

Internal delivery is at least once. The system does not promise distributed exactly-once behavior between PostgreSQL and GitHub. The outbox makes local state and the processing request atomic; remote effects are reconciled against their intent and the outcome actually observed.

A task-completion event from an older lease epoch is retained for diagnostics, but cannot replace the canonical task result or create a publication intent. A local lock alone is insufficient: the controller and transactions also verify the lease epoch.

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

The janitor runs every minute, inspects labels, and destroys expired or orphaned resources after a 5-minute grace period. On startup, the worker suspends actions, reloads interruptions, inspects resources, reconciles unknown GitHub publication effects, and only then resumes authorized starts.

## 15 Prompt injection and exfiltration defenses

### 15.1 What prompts must not control

PR titles, bodies, comments, README files, `AGENTS.md`, commits, code, lockfiles, tool responses, retained memories, and generated summaries are untrusted data. Persisting or owner-validating a memory never turns embedded instructions into policy authority. Content such as "ignore the rules and merge" changes neither permissions, tools, policy, nor the requester's identity. JARVIS constructs mission instructions and explicitly separates quoted excerpts.

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

Use the versioned [v0.1 acceptance corpus](acceptance-corpus.md) as the scenario inventory and requirement-to-evidence index. It expands the hostile-input cases below into stable IDs, deterministic expected outcomes, and J00–J05 evidence ownership. Test at least: an unlisted project request, ambiguous-mode prompt, project file requesting access expansion, hostile `AGENTS.md`, OpenCode configuration containing a plugin, an MCP server declared in the repository, project skill self-approval, changed/revoked skill digest, a skill requesting shell execution, a symlink to a secret, a traversal archive, a fake approval in model output, a patch path outside scope, an SSRF URL, oversized output, and terminal output containing control sequences. Also test poisoned summaries, cross-project retrieval, contradictory/expired notes, a source-version change, deletion during an attempt, stale configuration/revision, lost PR response, cancellation, and restore from backup. The expected outcome is a block or explicitly limited result, with no new privilege or unauthorized remote effect. Corpus presence is not execution evidence.

## 16 Secrets and authentication

Persistent secrets are the GitHub App private key, provider keys, PostgreSQL credentials, and internal certificates. The authoritative copies reside in a protected Mac bootstrap location or an explicitly selected secret manager, never in the repository or images. A trusted bootstrap step transfers only required secrets through authenticated administrative transport into restricted VM-local files; it does not share the Mac directory. Compose assigns these VM-local secret sources per service. Validate daemon-side paths, permissions, rotation, and cleanup at J01; local Compose secrets are not an encrypted vault. VM administrators and the controller remain trusted. [D6](https://docs.docker.com/compose/how-tos/use-secrets/)

GitHub keys stay in the trusted broker; read/PR-publication tokens are created on demand, retained in memory, and expire or are revoked. No merge token/capability is provisioned for v0.1. Per-attempt LLM capabilities have a scope, limit, and deadline. Gateway keys are injected into temporary storage and disappear when it is destroyed. A control prevents them from being written to events, logs, and artifacts.

Web administration uses a single account, a password hashed with an appropriate function, an opaque server-side session, HttpOnly and SameSite cookies, inactivity expiry, and CSRF protection. Cookie behavior is tested on the strictly loopback HTTP interface; any remote exposure requires TLS and a Secure cookie. Onboarding uses a one-time secret, never printed in logs, and then revokes it.

Rotation and revocation are documented: suspend starts, replace the secret, restart only its consumers, test reads, verify capabilities, and resume actions. Logging uses an allowlist of fields rather than only pattern matching for strings that resemble keys.

## 17 Observability and costs

### 17.1 Signals

Structured JSON logs carry `correlation_id`, repository, PR, task, attempt, revision, decision, and intent; timestamps are UTC with local display. Webhook bodies, prompts, code, authentication headers, and provider responses are not logged by default. Any retained raw output is encrypted, access-restricted, and subject to short retention.

Metrics include queue age, reconciliation lag, preparation and review duration, timeout rate, expired leases, orphaned resources, cleanup, errors per adapter, GitHub calls, rate-limit headroom, reserved/estimated/reconciled cost, refusals by reason, and `unknown` intents. PR identifiers are not used as high-cardinality metric labels; they remain in logs and traces.

Consumption metrics additionally expose token totals, supported cache/reasoning breakdowns, request failures and missing/estimated usage coverage by bounded provider/model/purpose dimensions. Detailed task/agent/campaign attribution stays in authenticated SQL-backed views. The [token accounting contract](token-consumption.md) specifies canonical per-request collection, no duplicate parent/child aggregation, read APIs, daily corrections and retention/restore handling. Reuse existing llm/contracts/domain/persistence/observability modules; no separate analytics service is required.

Visible JARVIS alerts include: an unknown PR-publication result for more than 5 minutes, cleanup failing for 5 minutes, budget reaching 80% and then 100%, VM space below 10 GiB, and repeated authentication or isolation failures. External notifications are optional and deferred.

### 17.2 Cost model

```text
Model estimate per request =
  sum over mutually exclusive billable buckets b of
    (tokens_b / 1,000,000 × versioned_price_b)

Period spend = sum of canonical request charges attributed to that period
  + separately accounted non-token fees not already included
  + any relay or other optional infrastructure subscriptions
  + energy, storage, and operational time
```

Purely arithmetic example, not a current price quote: at 2 units per million input tokens and 10 per million output tokens, a review using 50,000 input tokens and 5,000 output tokens costs 0.15 units. At 20 reviews per day for 30 days, this amounts to 90 units before retries, digests, taxes, and other fees. A 10% retry overhead would bring this component to approximately 99 units.

The reservation is calculated before starting from the maximum authorized requests and tokens. The core persists a request intent and atomically reserves capacity across applicable scopes before the gateway dispatches; concurrent calls cannot both spend the same balance. The gateway rejects a new request when the remaining reservation is insufficient and constrains output maxima; the worker does not merely alert after spending. Provider-reported usage is reconciled when available; otherwise usage remains estimated or explicitly unknown. Crashes, cancellation and missing stream endings retain uncertain exposure, including across restore or budget-period boundaries. An in-flight request can exceed an estimate; a strict provider-side spending limit supplements local controls.

The interface distinguishes per-PR cost, abandoned-attempt cost, currency, and price version. Prices are entered or explicitly updated, without relying on constants assumed to remain current. Local costs are measured through CPU time, memory, and storage; a local model adds consumption and RAM constraints rather than having zero cost.

Input/output totals and cache/reasoning subsets use qualified provider-specific mappings; overlapping categories are never charged twice. Gateway and OpenCode events for the same actual request update one canonical record, not separate expenses. Every retry, format repair, digest and later agent call is attributable, including failed/unknown outcomes. Runtime-reported cost is evidence to cross-check, not authority to release funds or an invoice guarantee. Unknown prices/subscription valuation and different currencies remain explicit. D02/D05/D09/D11 retain provider, configured token/currency limits and retention choices. JV-015/JV-017/JV-022/JV-024 own MVP implementation and acceptance; this detailed specification enables no runtime behavior.

### 17.3 Proposed task duration forecasting

J10/P15 ([JV-084](https://github.com/grasdouble/Jarvis/issues/84), children JV-085–JV-088) adds a bounded statistical component in existing llm/domain/contracts/persistence/observability modules, after verified MVP delivery. The [duration contract](duration-forecasting.md) defines preflight/post-plan estimates, conditional remaining-time updates and actual comparison. Reuse task/attempt/request timestamps and qualified effective model/effort metadata; distinguish provider/version/profile, safe workload features, unknown settings and observed environment. No second runtime, forecasting service or model-training/inference call is required.

Proposed `execution_timings`, `duration_forecasts` and `forecast_calibrations` bind canonical interval/feature observations, immutable issued predictions and chronological evaluation evidence to scope, task/profile/estimator versions and completeness. Separate queue/CI/human/suspension/unknown intervals from execution elapsed; use monotonic local timing with explicit restart/clock/sleep gaps and end-to-end critical paths for parallel work. Do not sum overlapping spans, infer completion from a timeout, or add marginal percentiles as a workflow guarantee. Retain failed/censored cases and calibration limitations.

Scoped empirical cohorts return central/range/optional percentile with sample count, as-of/freshness, method/calibration version and abstention/stale states. No universal effort-speed factor, guessed current model throughput or unsupported accuracy label. Remaining time conditions on observed stage/elapsed survival; otherwise it remains unknown. Bound queries/updates and enforce deletion/restore on derived data. The existing authenticated task/queue view and future qualified J08/J09 surfaces can display results, while unavailable estimates leave dispatch policy, ranking, limits, selected profile and approval gates unchanged. JV-088 validates chronological holdout and actual runtime evidence before production forecasting; no estimator or accuracy evidence is installed here.

## 18 Local deployment and development

### 18.1 Persistent services

Compose deploys PostgreSQL, the API, worker, and controller inside the dedicated `jarvis` VM. For consistent secret-file resolution without Mac sharing, the trusted bootstrap provisions a pinned Compose CLI plugin and deployment manifest inside the VM, then runs Compose there against its local Engine. Mac-side administrative Docker operations explicitly select `colima-jarvis`. React is compiled and served by the API or a minimal frontend server. Gateways and mode-specific sandboxes are created dynamically by the controller. The base network is private; only the interface at `127.0.0.1:3000` is published. PostgreSQL and the controller have no host port.

The initial infrastructure delivery currently includes only the pinned PostgreSQL service; API/web/controller container images and authentication are separate implementation work. Do not claim an authenticated UI listener until those services exist and the unauthenticated/authenticated and host-forwarding checks pass.

Persistent volumes contain the database and retained evidence. Temporary resources have per-attempt volumes. The Engine socket is mounted only in the controller; bootstrap secrets are assigned per service. No global source-tree or user-home mount is present in agent execution profiles.

The owner-facing interface remains local and authenticated. The v0.1 explicit request flow has no webhook-reachability prerequisite; any later webhook integration requires a separate accepted need and narrowly exposed endpoint.

### 18.2 Installation sequence

1. Check the pinned macOS/Colima/Lima/Engine/CLI/Compose baseline. Prepare the dedicated `jarvis` profile before first startup with Docker runtime, native ARM64, directory sharing disabled, no SSH-agent forwarding, and the owner-selected CPU/memory/disk allocation. Verify effective mounts, context, memory, and free space.
2. Build or retrieve images by approved digest, and verify provenance, vulnerabilities, and the software bill of materials.
3. Provision the pinned Compose CLI plugin and manifest inside the VM. Transfer bootstrap secrets through trusted administrative transport to a dedicated VM-local directory with restrictive permissions; run Compose from inside the VM and verify secret paths. The initial manifest must publish no database/controller host ports; the later authenticated UI is the only permitted loopback publication. Install the test App on a selected authorized repository and verify read/PR-publication scopes on a disposable test project; no webhook is required.
4. Start PostgreSQL, apply migrations using a temporary migration role, then start services with project tasks suspended.
5. Verify probes, authenticated web/CLI request access, internal configuration persistence, and a plan smoke-test without GitHub writes.
6. Run isolation tests on the actual Mac, recovery scenarios, and a restore; record the results.
7. Enable plan tasks on an authorized test project after the read-only profile passes. Enable dev-mode PR publication only after D08/publication configuration and all relevant PRD gates pass. Never enable product-side merge.

### 18.3 Development environment

The monorepo uses strict TypeScript, a PNPM lockfile, and reproducible formatting, lint, build, and test commands. Services may share a development mode, but agents continue to use dedicated ephemeral images and volumes. Use image rebuilds or bounded source uploads for development in the isolated `jarvis` profile. Any optional development profile with Mac source sharing is separate, restricted to trusted components, and excluded from production acceptance and agent execution.

Unit tests use in-memory adapters; integration tests start a temporary database and fake GitHub/OpenCode server. Live scenarios use a test GitHub App and a disposable repository separate from the pilot. Production secrets are never available in JARVIS project CI workflows.

Images are pinned by digest, dependencies by lockfile, and `packageManager` by explicit version. Migrations maintain compatibility during deployment, adding columns before removing them later. An image rollback does not imply a destructive database rollback.

## 19 Backup retention and operations

Take a consistent daily PostgreSQL backup using the tool appropriate for the selected version, encrypt it before export to a dedicated authorized directory, and initially retain 7 daily and 4 weekly backups. Retained artifacts and configuration without secrets are backed up with their hashes. Export backups through a trusted administrative stream without enabling Mac directory sharing. Colima's virtual disk is not, by itself, a verified application backup. PostgreSQL distinguishes several backup strategies; the MVP uses a logical dump and a tested restore. [P2](https://www.postgresql.org/docs/current/backup.html)

Targets: a 24-hour RPO and 60-minute RTO after the Mac becomes available. A restore starts with every action suspended. It reloads evidence, revokes attempt capabilities, and reconciles PRs and GitHub effects before any resumption, to avoid replaying intents already consumed after the backup point.

Initial retention: snapshots and runtime state are deleted at attempt completion; raw diagnostic artifacts are disabled by default, otherwise retained for at most 7 days; operational logs for 30 days; task results, decisions, and audit for 90 days. Longer retention may be selected according to space and confidentiality needs. Secrets are not retained in these artifacts. Knowledge proposals and validated knowledge follow the separate review deadlines in section 11.5; expired content is purged according to the configured retention job and storage cap. Completed task checkpoint payloads are removed with temporary state; minimal step and context-manifest metadata follow task history retention. Forgetting purges content and search representations without waiting for ordinary retention, and backup restore reapplies the forgetting ledger.

**Emergency stop.** The API persists the stop; the executor rereads it before every dispatch; leases and capabilities are revoked; sandboxes are stopped. If services are unresponsive, the owner can stop services and revoke the App in GitHub. Already accepted operations are tracked through confirmation, without a promise of recall.

**Update.** Suspend project tasks, wait for or cancel local attempts, back up, deploy compatible images and migrations, run probes and isolation acceptance tests, then resume only the previously authorized task profiles. An automatic restart must never reopen a previously suspended state.

## 20 Testing strategy and release gates

| Suite | Required scenarios | Gate |
| --- | --- | --- |
| Domain and policy | Versioned corpus scenarios AC-001–AC-006, AC-017–AC-025; POL 08–13, project allowlist, mode separation, clarification, skill-revision consent, path/revision validation | J02–J04 |
| OpenCode contracts | Health, creation, prompt, report, interrupted stream, cancellation, permission denial, incompatible version | J01 and J03 |
| Provider contracts | Two providers, socket streaming, JSON, limits, interruption, no unauthorized fallback | J03 |
| Memory | Two-repository leakage, provenance, applicability, expiry, contradiction, context limits, provider switch, restart, poisoned notes, concurrent invalidation, forgetting and pre-deletion backup restore | J03 and J05 |
| Request and queue | Authenticated project binding, ambiguity/clarification, idempotence, stale config/revision, lease expiry, and outbox | J02 |
| Real isolation | Effective Colima mounts, Mac-file canary, context identity, UID, capabilities, socket, Mac/LAN/core/neighbor access including Lima host aliases, IPv4/IPv6, DNS, forwarded listeners, memory/process limits | J01, then after platform updates |
| Hostile input | Section 15 corpus / AC-007–AC-013 and AC-018–AC-021, configuration, archives, injections, web rendering, and fake test results | J03 |
| PR publication | Out-of-scope patch, changed project/revision, duplicate intent, lost response, revoked App, no merge call | J04 |
| Project-skill consent | Exact digest approval, changed/revoked/unverifiable skill, cross-project substitution, no command execution | J03–J05 |
| Recovery | AC-019, AC-024–AC-027; crash before/after commit and before/after PR call, duplicated worker, Docker stopped, simulated sleep, dump restore | J02, J04, and J05 |
| Operations | Persistent stop, janitor, budget, missed digest, daylight saving time, low disk, and purge | J05 |

Race tests use a test barrier to change project authorization, configuration, skill revision, source revision, or task scope between validation and dispatch. A test does not merely simulate an `allow` value. PR effects are verified on a disposable test repository, including no publication when denied and no merge request under any fixture.

Performance acceptance uses a versioned request corpus and records plan/dev duration, cost and failures separately. Request baselines and target thresholds remain to be measured and accepted. Offline periods and external limits are recorded separately. Security and recovery tests remain necessary even when unit tests pass.

## 21 Delivery sequence and remaining decisions

**Step 1 corresponding to J00/J01.** Pin profiles and versions, implement the minimal controller, bounded Docker exec transport, and socket gateway. Demonstrate plan and author attempts without IP networking or real secrets in the agent. Qualify state paths and the absence of repository code/configuration loading.

**Step 2 corresponding to J02.** Implement internal project/configuration records, request/clarification intake, checkpoints, scoped knowledge, queue/leases, authentication, and persistent stop. GitHub writes remain disabled.

**Step 3 corresponding to J03.** Qualify the read-only plan profile, structured plans, scoped context and memory, project-skill consent UX/digest binding, pure authorization policy, budget, and adversarial corpus. Qualify selected provider profiles and deterministic digest.

**Step 4 corresponding to J04.** Qualify the isolated writable author profile, patch validation, scoped GitHub publisher, durable PR intents, and lost-response reconciliation on a disposable repository. Do not add a merge API or run repository commands without accepted D16 and separate qualification.

**Step 5 corresponding to J05.** Add request/task views and digest, final cleanup, memory/skill configuration inspection and revocation, backup/restore, cost views, and the operations guide. Complete accepted F/N gates and a controlled project-request pilot; JARVIS merge remains excluded.

Decisions D01 through D17 in the PRD remain the product decision register; D12 gates J06 autonomous delivery, D13 gates J07 self-improvement, D14 gates post-MVP general assistance, and D16 gates any repository command execution. D17 records accepted product direction, not implementation permission. PR-publication permissions, provider qualification, internal configuration protection, and socket transport remain implementation/qualification gates; an unresolved gate blocks the corresponding effect rather than widening permissions.

**Post-MVP delivery.** After v0.1 qualification, accept D12 and JV-045 before implementing writable authoring (JV-046), durable independent review/repair (JV-047) and qualification/operations (JV-048). See section 12.8; contributor skills do not satisfy those product isolation/runtime gates.

**Self-improvement (J07).** After verified JV-044 delivery, implement bounded signals/proposals (JV-052), accept D13 experiment policy and qualify fixed evaluation (JV-053), reuse delivery for controlled candidates (JV-054), then accept D13 rollout policy and qualify activation/rollback and operational evidence (JV-055). No deployment authority or background optimizer is enabled by this plan.

**Post-MVP general assistance (J08).** After verified JV-025, qualify shared profile/policy contracts (JV-065), the bounded tool broker/adapter (JV-066), authenticated conversation and scoped memory (JV-067), then weather/pilot acceptance (JV-068). D14 must accept the corresponding tool/provider/retention/profile limits before live execution. J06/J07 remain separate capabilities.

## 22 Verified technical references

Official sources consulted on October 15, 2026; Colima/Lima references C1 through C5 and PostgreSQL text-search reference P3 were checked on October 16, 2026. References establish component capabilities, not guarantees of the proposed JARVIS architecture. Pages evolve: image, SDK, engine, and GitHub API versions must be recorded in the repository at J00.

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
- **C1** [Colima runtimes](https://colima.run/docs/runtimes/): Docker runtime and Compose compatibility.
- **C2** [Colima profiles](https://colima.run/docs/profiles/): separate VMs, resources, and Docker contexts.
- **C3** [Colima configuration](https://colima.run/docs/configuration/): VM settings, directory sharing, and SSH-agent forwarding.
- **C4** [Colima Lima configuration implementation](https://github.com/abiosoft/colima/blob/main/environment/vm/lima/yaml.go): default mounts and guest/host socket forwarding; qualify against the pinned release.
- **C5** [Lima user-mode network](https://lima-vm.io/docs/config/network/user/): host reachability and `host.lima.internal`.
- **D3** [Docker Engine security](https://docs.docker.com/engine/security/): daemon control surface.
- **D4** [Docker none network driver](https://docs.docker.com/engine/network/drivers/none/): no external network.
- **D6** [Secrets in Docker Compose](https://docs.docker.com/compose/how-tos/use-secrets/): assigning secrets per service.
- **P1** [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html): row locks and SKIP LOCKED.
- **P2** [PostgreSQL Backup and Restore](https://www.postgresql.org/docs/current/backup.html): backup and restore methods.
- **P3** [PostgreSQL full-text search](https://www.postgresql.org/docs/current/textsearch-intro.html): indexed text matching and relevance ranking; repository scope and memory trust are JARVIS responsibilities.
- **T1** [Node.js releases](https://nodejs.org/en/about/previous-releases): choosing a maintained LTS branch.
- **T2** [PNPM Workspaces](https://pnpm.io/workspaces): monorepo and workspace protocol.
