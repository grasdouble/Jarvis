# Sandbox manager

The sandbox manager is the only JARVIS service permitted to connect to the guest Docker Engine socket. It exposes a closed mTLS API for creating, inspecting, cancelling, expiring, and deleting per-attempt resources; it does not expose Docker's API, caller-provided commands, arbitrary host mounts, network modes, ports, privileges, image references, or Engine identifiers.

## Build without starting

With the dedicated `jarvis` Colima profile running and the root PNPM workspace installed:

```bash
infra/sandbox-manager/build-image.sh
```

The script verifies the `colima-jarvis` Engine is Linux ARM64, builds the package, and builds the manager image using the digest-pinned Node.js base into that Engine. It does **not** start the image or mount the socket. It never uses the globally selected Docker context.

## Runtime configuration

The Compose service is guarded by the `sandbox-manager` Compose profile and is not started by the ordinary PostgreSQL `up` command. Before deliberately enabling it, an operator must provision all of the following in the guest VM:

- `/etc/jarvis/sandbox-profiles.json`: owner-controlled profiles with unique profile IDs, approved immutable image digests for `linux/arm64`, explicit CPU/memory/PID quotas, a maximum lifetime, and workspace read-only mode. Never derive this file from a target repository or task request.
- `/etc/jarvis/secrets/sandbox_manager_tls_key` and `sandbox_manager_tls_cert`: the server key and certificate.
- `/etc/jarvis/secrets/sandbox_manager_client_ca`: a dedicated client CA whose trusted worker certificate contains the exact URI SAN `spiffe://jarvis/worker`.

The service requires mutual TLS, validates the worker identity, listens only on the private `core` network, and publishes no host port. Its process runs as UID 10001 with only the guest `docker` supplementary group needed to access `/var/run/docker.sock`. The Compose wrapper resolves that group ID from the running guest instead of assuming a host or container GID.

The public contract accepts only `POST /v1/sandboxes` with `Idempotency-Key`, `GET /v1/sandboxes/{manager-generated-uuid}`, `POST /v1/sandboxes/{uuid}/cancel` with the current `leaseEpoch`, and `DELETE /v1/sandboxes/{uuid}` with the current `leaseEpoch`. Request bodies are size-bounded and reject unknown fields. Profiles, labels, names, volumes, limits, and Docker options are selected or generated inside the manager. The Docker Engine adapter uses a fixed API version and constructs a bounded `linux/arm64` request without bind mounts, devices, published ports, host namespaces, or caller-controlled commands. The manager admits one live sandbox at a time, applies the selected profile's CPU/memory/PID/lifetime limits, reconstructs live attempts from ownership labels after a restart, and never calls a global prune.

## Qualification boundary

The Compose service is opt-in and its certificates/profile file are not provisioned by this change. Do not enable product tasks until the J01 owner/native review gates and live isolation scenarios pass. Unit tests cover recovery from synthetic Engine labels, but do not qualify actual Colima restart recovery, the guest Engine socket, mTLS certificate provisioning, Docker Engine behavior, image scanning, or the worker-to-manager network boundary.

## Dedicated Colima sandbox qualification

After the `jarvis` Colima profile is provisioned and running, run the live, synthetic-only profile check from the repository root:

```bash
pnpm --filter @jarvis/sandbox-manager build
node --test infra/sandbox-manager/qualification.test.mjs
node infra/sandbox-manager/qualify-colima.mjs --profile jarvis
```

The qualification command rejects every profile except `jarvis`, verifies the pinned ARM64 Colima profile, builds a temporary Node 24 probe image, and exercises the production `createSandboxManager` and Docker Engine adapter against the explicit `colima-jarvis` context. It creates a temporary internal-network witness and manager-owned attempts with a synthetic workspace only. The agent process tests IPv4/IPv6 routes and direct targets, DNS and Lima aliases, UID/GID, capabilities, namespaces, seccomp, read-only root/snapshot mounts, credential/socket absence, and effective CPU/memory/PID cgroups. It then exercises manager cancellation/destruction and deadline expiry, checking that each run's container and volumes are gone. Only run-labeled resources are targeted for cleanup; no global prune or Compose service start is used.

Discovered Mac, LAN-neighbor, Docker-network, and public IP addresses are passed only in the temporary synthetic snapshot and are not printed. No repository snapshot, actual project content, provider/GitHub credential, host bind mount, or Engine socket is exposed to the probe. A failure is a failed qualification, not an isolation pass. If the Engine stops responding, cleanup cannot promise the five-minute limit; reconcile the exact `jv007-` run labels before retrying.

This is live evidence for the fixed sandbox-manager profile and pinned local Colima/Engine only. It does not qualify production profile provisioning, the Compose mTLS service, secrets injection, the worker-to-manager boundary, a VM/kernel escape, platform updates, or a different host. The image is a synthetic fixture, not an approved product agent image. Keep product task actions disabled until the current J01 approval and qualification gates are met.
