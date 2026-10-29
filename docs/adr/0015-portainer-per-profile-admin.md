# ADR-0015: Per-profile Portainer contributor administration

- Status: Proposed
- Created: 2026-10-29
- Updated: 2026-10-29
- Decision owner: Owner
- Requirements and scope: PRD D01; contributor-only Engine administration for Colima profiles `jarvis` and `jarvis-test`; product agent, API, worker, and candidate-repository boundaries remain unchanged
- Related Dxx / legacy ADR / issue / PR: PRD D01 and D06; ADR 06; JV-288; issue #290; blocked implementation task #291

## Context and decision needed

The JARVIS sandbox-manager design uses one fixed `/var/run/docker.sock` and one Engine for its product agent path. A sandbox profile is not an Engine-selection mechanism. The guest Engines in Colima profiles `jarvis` and `jarvis-test` are separate. Centralizing Portainer over both Engines would therefore require new authenticated multi-Engine routing and broaden the cross-profile trust boundary; neither capability is implemented or qualified.

The owner explicitly selected, in the active contributor session for JV-288 on 2026-10-29, one Portainer per Colima profile for on-demand trusted local contributor administration, with full Engine-administrator authority limited to each instance's corresponding Engine. This source is the owner's active-session choice; no GitHub comment or PR review is claimed. This choice records topology, on-demand use, and matching-Engine administrative authority. The required human review before merge and native delivery gates remain pending. A decision record does not provision, activate, or qualify Portainer.

## Options and trade-offs

1. **One Portainer per Colima profile (selected).** Each instance connects directly to only its own guest Engine. This aligns with the existing one-socket trust model and limits a single instance's Engine authority to one profile. It requires maintaining two instances, separate credentials, local ports, independent state and qualification, and careful profile/context selection.
2. **One central Portainer controlling both Engines (not selected).** This could provide one administrative console but needs authenticated multi-Engine routing not present in the current architecture and creates a broader cross-profile trust boundary and compromise impact.
3. **No Portainer.** This avoids introducing another highly privileged management surface but does not meet the owner's selected contributor-administration topology.

Full Engine administration remains powerful: compromise or mistaken context selection can affect the corresponding profile's containers, data, and secrets. Per-profile separation reduces cross-profile exposure but is not itself proof of isolation.

## Decision and rationale

The owner selected one on-demand Portainer instance in each Colima profile, `jarvis` and `jarvis-test`, attached directly only to that profile's guest Engine socket and carrying full administrator authority only over that Engine. The consoles are trusted local contributor/admin tools, not a central controller and not part of JARVIS product runtime. No remote or unauthenticated Engine API, central route, or cross-profile control is selected.

The dedicated sandbox-manager remains the sole Engine-socket/control interface for the JARVIS product agent path. The Portainer exception is contributor-only and does not grant Engine access to the product API, worker, agent, or candidate repositories, nor alter product runtime authorization. D06's Colima resource/profile baseline is preserved; no blanket socket rule or other product requirement is changed.

## Consequences and verification

Before any implementation or use, a separate implementation issue must qualify these conservative requirements; none is asserted as verified behavior:

- Use Portainer's built-in authentication and exactly one owner-only account per instance. Use distinct strong credentials for each profile, stored in the macOS Keychain and never exposed to agents or tracked files. Do not add other users. Treat each console as a full administrator of its corresponding Engine.
- For normal credential rotation, change the password through authenticated Portainer administration and update the matching profile credential in the macOS Keychain.
- Attach each instance directly to only its own Colima profile's guest Engine socket. Do not configure remote or unauthenticated Engine API access.
- Expose only the authenticated Portainer web UI over HTTPS on a loopback-only listener, use unique local ports, and verify there is no LAN exposure. Do not expose the Docker Engine API remotely or without authentication.
- State and credential recovery: Do not back up or restore Portainer state or copy it across profiles. State is disposable. On state loss, VM recreation, or lost/compromised credentials, stop Portainer and reinitialize only that profile's instance and authentication, invalidating old credentials without touching Engine resources; recreate its owner-only account and access. Any later backup need requires a separately accepted scope.
- Before administration, explicitly select the Colima profile/context and verify the expected Engine identity; never rely on the globally active context.
- Pin an immutable ARM64 image digest and make updates deliberate/manual. Qualify an update on `jarvis-test` before updating `jarvis`.
- Start the consoles only on demand and stop them after administration. No agent, worker, or candidate repository may access Portainer or its socket.
- Qualify authentication, listener binding/forwarding, expected Engine checks, state-loss recovery, image handling, and cross-profile isolation on the actual pinned Colima/Engine setup, including negative LAN and cross-profile access tests.

These are future qualification requirements, not evidence that Portainer supports or enforces them in the selected deployment. Until implementation and qualification gates pass, neither instance is authorized or activated.

Impact: D01 is an authorized evolution scoped to contributor administration; its product-agent-path controller design and closed API remain. D06's accepted profile/resource baseline is unchanged. No product feature, product runtime permission, or blanket security rule changes. The per-profile topology selection does not satisfy or bypass any existing native review, human review, or qualification gate.

## Acceptance and history

The owner made this topology choice on 2026-10-29 in the active contributor session for JV-288. This candidate records that source accurately and does not claim a GitHub comment or PR review. ADR status remains Proposed pending publication of this decision-record PR, required human review, and applicable native gates. Owner selection is recorded separately from ADR adoption, implementation qualification, and activation.

## Follow-up

Issue #291 is the separate bounded implementation task, currently Backlog and natively blocked by #289 and #290. It remains blocked until #289 and this decision PR for #290 are delivered; this ADR does not select it for implementation or authorize provisioning. Its acceptance must independently demonstrate, for both profiles, matching Engine identity and socket isolation, authenticated HTTPS loopback UI with LAN denial, credential rotation and recovery, no state backup/restore or cross-profile copy, qualifying ARM64 image digest, on-demand lifecycle, and negative cross-profile access. Preserve the no-socket product API/worker/agent/candidate boundaries throughout.
