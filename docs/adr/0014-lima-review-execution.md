# ADR-0014: Trusted CI evidence for contributor review

- Status: Proposed
- Created: 2026-10-27; updated: 2026-10-28
- Decision owner: Owner
- Requirements and scope: Issue #214 authorized contributor-process evolution; reviewer-side destructive persistence validation only
- Related Dxx / legacy ADR / issue / PR: Issue #214; PR #275

## Context and decision needed

Issue #214 originally explored running candidate code only inside a fresh per-run ARM64 Linux Lima VM on this Mac, with PostgreSQL owned by that VM. The existing local-validation helper executes candidate code on macOS and uses `colima-jarvis`; neither route established the required isolation boundary. The Lima proposal required an exact immutable candidate snapshot and no host mounts, forwarded agent, host Docker/Colima socket, ports, secrets, or guest reachability to Mac/LAN/Internet/other runs. GitHub-hosted checks are a separate evidence source and cannot qualify local VM isolation.

On 2026-10-28, the repository owner revised issue #214 to accept hosted GitHub Actions Ubuntu 24.04 with a pinned PostgreSQL service as the reviewer test environment. Reviewers need not qualify Lima or execute candidate code locally. When the required CI evidence is absent or mismatched, the reviewer records the limitation; Mac, Lima, and Colima are not fallbacks. This is contributor-process scope only: it does not change JARVIS product runtime, D16, credential handling, merge authority, or native review gates.

## Options and trade-offs

1. Continue host/Colima execution: rejected; it contradicts the issue's original boundary and does not provide the required independent evidence.
2. Require a fresh Lima VM and prove isolation/cleanup: originally owner-authorized direction, but its qualification remained outstanding and it is no longer the required reviewer path under the owner's revised scope.
3. Use exact-revision hosted CI evidence and report missing/mismatched evidence as limited: selected for issue #214. This uses the trusted workflow's Ubuntu 24.04 and pinned PostgreSQL jobs without asserting local platform or deployment qualification.

## Decision and rationale

The owner selected the CI scope on 2026-10-28. Evidence must bind repository, trusted workflow/run, PR, base SHA, exact candidate head SHA, required jobs/scenarios, and report. A `pull_request` event may establish the PR relationship, but reviewers still inspect the run/check's evaluated SHA and actual required results/report. A manually dispatched run is acceptable only if trusted workflow configuration independently validates the intended PR, base, and exact expected head before checkout/test and produces a revision-bound report; `workflow_dispatch` alone does not select a PR head. Missing, mismatched, failed, or skipped required evidence is limited, with no local fallback.

The current workflow is `.github/workflows/repository-checks.yml`: `Repository configuration` runs on Ubuntu 24.04 with ephemeral PostgreSQL pinned to `postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c` and runs `pnpm --filter @jarvis/persistence test`. `PostgreSQL runtime integration` is a separate job that independently selects/verifies the candidate SHA, runs stop-runtime scenarios, and emits a revision-bound report/artifact with a failure gate. The actual required run evidence—not this description—must be inspected. Required scenarios need zero failures and no unexplained skips.

This ADR remains Proposed until its applicable formal review/adoption gates are satisfied. Recording owner direction and editing this candidate do not themselves formally adopt the ADR or satisfy those gates. The prior Lima proposal and PR #275 history are retained for provenance; that launcher is unqualified and superseded as the required reviewer-validation path. This decision does not qualify Lima, macOS, Colima, deployment, or product runtime.

## Consequences and verification

The canonical reviewer procedure is [direct validation: Issue #214 required CI evidence](../../.agents/skills/jarvis-review/references/direct-validation.md#issue-214-required-ci-evidence). It defines revision binding, `pull_request` and conditional manual-dispatch evidence, provenance categories, and treatment of failures, skips, and missing reports. The review skill links to that procedure rather than duplicating it. Preserve the independent reviewer, exact current B/H, human-review choice, native CI/approval, credential, and merge-protection gates.

Historical Lima feasibility evidence remains relevant only as evidence of the prior investigation, not as qualification or current acceptance. The contemporaneous record described Lima 2.2.1 with VZ Ubuntu 24.04 ARM64 and guest nftables default-drop rules; it reported blocked unprivileged probes, while IPv6 had no route. A later bounded guest probe reported host-initiated SSH continuity and timed-out guest probes, but did not test a host-loopback canary or a second live instance. These reports did not demonstrate a trusted controller, complete control-plane/cross-run denial, full IPv6 isolation, or lifecycle cleanup. Prior exact test counts and operational transcripts remain in the issue-delivery evidence record; they are not CI evidence and do not qualify Lima. PR #275's launcher history is retained as unqualified and is not required to execute for this issue.

## Follow-up

Reviewers inspect actual run/check identity, evaluated SHA, required job/scenario conclusions, and revision-bound report or artifact. For a dispatched run, verify trusted pre-checkout PR/base/head validation rather than treating the event name as sufficient. Record unavailable, mismatched, failed, or unexplained skipped evidence as limited and hand off without running candidate code on Mac, Lima, or Colima. Formal ADR adoption remains subject to the applicable governance and review gates.
