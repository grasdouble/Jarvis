# ADR-0015: VM-local authenticated UI loopback proxy

- Status: Proposed
- Created: 2026-10-30
- Decision owner: Owner
- Requirements and scope: Issue #132 local dedicated-`jarvis` development POC; preserve the internal-only application network while making the authenticated UI available on Mac loopback
- Related Dxx / legacy ADR / issue / PR: Issue #132; PR #288; PRD v1.21 F01/F08/F11/N01/N03/N14; technical architecture §6, §16 and §18.2

## Context and decision needed

The owner authorized a local development POC and selected a VM-local proxy after live evidence that Docker Engine 29.5.2 does not publish ports for containers attached exclusively to a Compose network marked `internal: true`. The application API and PostgreSQL must remain on that internal-only network, while the owner needs the authenticated UI at Mac `127.0.0.1:3000`. Removing `internal: true` or adding an externally attached proxy container would change the intended network boundary. The choice here is limited to the POC; it does not revise PRD acceptance or authorize production deployment.

## Options and trade-offs

1. Publish the API container port directly: rejected for this topology because Engine 29.5.2 suppressed the requested binding on the internal-only network (`NetworkSettings.Ports` was null).
2. Add a non-internal Docker network or proxy container: rejected because it would extend container network reachability beyond the selected internal-only Compose network.
3. Run a trusted TCP forwarder on the Colima guest host: selected by the owner. It binds VM loopback and connects to a fixed API address on the existing internal-only network. The guest process must not access Docker's control socket; only the trusted sandbox-manager retains Engine socket access.

## Decision and rationale

The Compose API has no `ports:` mapping. After successful `infra/colima/compose.sh up`, the wrapper installs the helper and systemd unit and enables/starts the unit. API is assigned `172.30.132.10` in the internal `core` subnet `172.30.132.0/24`; the guest helper connects only to that address on port 3000 and listens only on `127.0.0.1:3000`. It uses neither Docker CLI/API nor AF_UNIX; systemd runs it as a dynamic unprivileged user restricted to `AF_INET`, preserving exclusive sandbox-manager access to the guest Engine socket. TCP connect/read behavior is bounded and unavailable API connections return 503. The fixed target avoids privileged service discovery, but requires that the static route be usable on the guest after Compose network creation; this route has not been runtime-verified. On `down`, the wrapper stops the proxy before Compose down.

The choice was made by the owner in the authorized issue #132 scope. This candidate record remains Proposed until applicable review/adoption gates pass; source implementation and this record do not formally adopt it. PRD acceptance remains unchanged; issue #132's acceptance correction removes the separate-device denial test for this POC.

## Consequences and verification

The host-facing endpoint depends on both the Lima loopback forward and guest service. API health is independent of proxy readiness; failed TCP connections return HTTP 503. Source tests cover forwarding, unavailable-upstream failure, loopback binding, static target consistency, and wrapper ordering. Prior Engine 29.5.2 evidence showed a requested API `PortBinding` with `NetworkSettings.Ports` null on the internal-only API; a temporary guest loopback server was reachable from Mac loopback. These observations do not verify the new static target route or persistent unit.

The October 30 isolated app/auth HTTP smoke used a transient test proxy, not this checked-in implementation; it relied on Docker target discovery. It evidences the isolated app/auth flow, internal API/database health and no host bindings, guest-loopback-to-Mac-loopback mechanism, and guest DNS only. It does not validate the fixed static target, subnet routing after Compose network creation, persistent service installation, or other H5 runtime items, which remain unverified. No second LAN device was used; an external-device test is not required for the POC. Production validation remains out of scope.

Acceptance for the local POC verifies host-side listener binding to `127.0.0.1:3000` and no Docker-published application ports; an external-client test is not required. The current H5 host-listener check and other H5 runtime items remain unverified. ADR-0015 remains Proposed; this scope correction does not claim implementation or qualification.
