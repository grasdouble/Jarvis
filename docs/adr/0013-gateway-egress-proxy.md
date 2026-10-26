# ADR-0013: Proposed gateway egress proxy

- Status: Proposed
- Created: October 26, 2026
- Decision owner: Repository owner
- Requirements and scope: PRD F08/N05/N09/N12/N14 and relevant POL; per-attempt LLM gateway egress only
- Related Dxx / legacy ADR / issue / PR: D02, D05, ADR 05 and ADR 10; #253, #254; owner direction recorded in #253 and the active delivery session

## Context and decision needed

The existing design uses an OpenCode sandbox with `network_mode: none` and a per-attempt gateway reached over a Unix socket. The technical architecture also described a networked gateway/proxy variant but deferred it because application proxy settings do not force traffic through the proxy, and the actual Colima/Lima guest network path had not been shown to prevent bypass.

The owner selected the proxy direction for a proposal: a trusted egress proxy/filter per attempt, explicit authorized-provider allowlist, deny by default, and network topology that prevents gateway bypass. OpenCode remains `network_mode: none`. This ADR records that owner-selected design direction; it does not accept the ADR, resolve D02/D05, authorize a provider, or establish implementation or qualification. D02 (provider and data-processing selection) and D05 (hard spending ceiling) remain open and continue to gate provider dispatch.

## Options and trade-offs

1. **Retain socket-only gateway transport.** This avoids giving OpenCode an IP network path, but does not provide the selected network-filter design and still requires validating socket sharing and gateway destination controls.
2. **Use the proposed per-attempt egress proxy/filter.** This supports centrally enforced destination and protocol restrictions, but correctness depends on guest-network topology and filter enforcement, not proxy environment variables. Misconfiguration or an alternate route could expose destinations outside the allowlist.
3. **Give the agent ordinary outbound networking with proxy configuration.** Rejected: an agent can ignore proxy settings or use other protocols, so configuration alone is not an enforcement boundary.

## Decision and rationale

The proposed architecture is a trusted, per-attempt egress proxy/filter with an explicit allowlist of owner-authorized provider destinations and API routes; all other egress is denied. The proxy is the only networked path from the attempt to an authorized provider. OpenCode stays on `network_mode: none` and accesses the gateway through its bounded local transport; it receives no network attachment, route, credentials, proxy administration interface, or ability to alter the allowlist.

The network topology must make bypass impossible rather than merely discouraged: isolate the gateway's provider-facing interface from core, host, LAN, and neighboring networks; permit only the required provider egress through filtering enforced in the actual Colima/Lima guest path; and deny direct agent-to-gateway, direct-address, alternate-interface, and other bypass paths. The gateway accepts only configured provider/API destinations, validates resolution and destination addresses, rejects redirects outside the allowlist, and does not provide CONNECT or arbitrary URL forwarding.

Each attempt receives a separately bounded gateway/proxy allocation with its own authorization, limits, deadline, and revocable capability. Trusted control-plane components provision it; agent input cannot select a provider, destination, route, or limit. On completion, cancellation, expiry, stop, or policy failure, stop admitting requests, revoke the capability, terminate the attempt's gateway allocation, and remove its resources. Fail closed when authorization, filtering, accounting, cancellation, or cleanup cannot be confirmed. A request with an uncertain remote outcome remains unknown/reconciliation-required; do not retry automatically, infer that no billable effect occurred, or silently switch provider. Preserve evidence for reconciliation while keeping further dispatch stopped.

## Consequences and verification

The sandbox-manager entrypoint now accepts an optional closed-schema trusted sidecar profile with immutable gateway/filter image digests and inert provider/model IDs; when absent, the sidecars remain inactive. With the profile present, source provisions manager-labeled per-attempt config/socket volumes, an unnetworked config-writer, gateway/filter containers, and separate internal and provider-facing networks. The gateway entrypoint loads the trusted per-attempt config and constructs its fixed filter client; production rejects enabled gateway dispatch, the generated provider allowlist is empty, and filter dispatch is disabled. Synthetic tests verify configuration wiring, the configured internal filter endpoint, disabled 503 behavior, Engine request ordering, read-only runtime config mounts, the attachment graph, rollback, cleanup, recovery, and the worker stop gate around the fixed manager relay. These tests do not demonstrate Docker/Colima behavior, no-bypass enforcement, or provider dispatch qualification.

Before enabling provider dispatch, qualify the pinned Colima/Lima and Docker Engine network path with synthetic targets and no private repository data or real provider credentials. Demonstrate both authorized-path success and deny-by-default behavior, including: DNS resolution and rebinding; IPv4 and IPv6; QUIC/UDP and other non-HTTP traffic; direct IP and hostname access; redirects and alternate ports; gateway and resolved gateway addresses; `host.lima.internal`, `host.docker.internal`, and `gateway.docker.internal` where present; Mac, LAN, core, and neighboring networks; and attempts to bypass the proxy/filter from the agent and gateway. Verify filter failure is closed, cancellation/revocation stops new requests, cleanup removes per-attempt resources, and uncertain in-flight outcomes remain stopped and reconcilable. A failed DNS lookup alone is not proof of isolation. Repeat qualification after relevant pinned platform or network configuration changes.

The prior JV-006 synthetic gateway prototype remains historical evidence only: it exercised a synthetic provider through Unix-socket/loopback transport, was not wired to Compose or the sandbox-manager lifecycle, and did not pin DNS against rebinding or qualify this networked egress path. It is not evidence for the selected proxy design. Existing JV-007 synthetic sandbox qualification likewise does not qualify gateway egress or product readiness. No live provider or GitHub operation, Docker/Colima qualification, or service start was performed for this proposal.

The technical architecture's §5.3 deferred-variant rationale is retained as historical context, narrowed to explain the earlier deferral; this proposal supersedes that deferral only if accepted, and does not change the PRD or existing acceptance criteria. D02 and D05 remain unresolved. Provider dispatch remains gated until their applicable owner decisions and enforcement/qualification gates are satisfied. Qualification alone does not authorize provider use.

## Acceptance and history

The owner-selected direction is evidenced by the active owner decision recorded in issue #253 and the delivery session on October 26, 2026. This is not acceptance of this ADR. Required: human review and owner acceptance of the exact reviewed ADR revision under current repository gates. Until then, status remains Proposed; no runtime authority follows from this candidate record.

## Follow-up

Update the architecture proposal and retain the applicable open D02/D05 decisions. Any implementation, pinned-platform qualification, provider authorization, or dispatch activation requires its own authorized work and existing review/acceptance gates. Stop if the required topology cannot demonstrate prevention of gateway bypass.
