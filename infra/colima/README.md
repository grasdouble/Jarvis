# Dedicated Colima profile

This directory provisions the JARVIS-only Colima profile. It never changes or activates the user's `default` profile/context.

## Selected baseline

`versions.env` records the selected baseline: Colima 0.10.3, Lima 2.2.1, Docker CLI 29.9.1, Docker Engine 29.5.2 (Ubuntu Noble ARM64 packages, API 1.54), containerd 2.2.4, and Docker Compose 5.6.0. The host preflight and profile verifier accept any syntactically valid Docker CLI `29.x.y` version; 29.9.1 remains the selected/tested baseline, not an exact host CLI requirement. All other listed tool, guest engine/package, API, and Compose pins remain exact. Compose is downloaded for `linux-aarch64`, checked against its release SHA-256, then streamed over Colima SSH into the guest. The Compose manifest pins PostgreSQL 18.6-bookworm by multi-platform digest and explicitly selects `linux/arm64`.

The owner-selected resource baseline is 4 VM CPUs, 8 GiB RAM, an 80 GiB VM disk, at least 40 GiB free on the Mac before provisioning, and a 2-CPU/4-GiB per-sandbox target. The bootstrap refuses a host below those CPU, memory, architecture, macOS, or free-space requirements. These are selected targets, not a claim that product sandbox quotas are implemented or qualified.

## CI validation boundary

Pull requests and pushes to `main` validate the merged base/application Compose configuration and build and inspect the real API image for `linux/arm64`. CI does not publish the image, produce a registry digest, access a VM or guest, or deploy/start services. Until an operator selects a registry and resolves its pull-authentication requirements, producing and deploying a registry image remains an operator task; live deployment checks described below are not performed by CI.

## Commands and effects

Run from the repository root:

```bash
infra/colima/bootstrap.sh --check-host
infra/colima/bootstrap.sh --apply
infra/colima/verify.sh --profile jarvis
infra/colima/verify.sh --profile jarvis --require-ui
```

- `--check-host` is read-only. It verifies the Mac and pinned host tools and reports the chosen configuration.
- `--apply` creates the new `~/.colima/jarvis` configuration, starts the isolated named profile without activating a global context, pins guest Engine packages, installs the checksummed Compose plugin, and copies both `infra/compose/compose.yaml` and `infra/compose/app.compose.yaml` through the profile's SSH channel. It fails rather than overwriting any existing `jarvis` profile. The standalone Compose installer also refuses to overwrite either existing guest manifest. It does not start product services or create secrets.
- `verify.sh` reads the live Colima/Engine state, checks exact package/tool versions, ARM64 identity, effective guest mounts, SSH-agent absence, and a temporary host-home canary. It rejects all Docker-published container host ports; the owner-facing VM-host loopback proxy is separate from Docker port publication. `--require-ui` additionally requires the application listener check below. No command deletes a profile or changes `default`.
- `verify-listener.sh --profile jarvis` requires exactly one running Compose API service without Docker-published ports, checks that the Mac-side host listener binds only to `127.0.0.1:3000`, and checks that an unauthenticated request to the protected `/api/v1/dashboard` endpoint is denied (401 or a same-origin login redirect). The static UI shell at `/` is public and is not an authentication check. It verifies the host-side listener binding and forwarded endpoint, not a positive authenticated login. No external-client test is required for the local POC.

## On-demand profile lifecycle

The named `jarvis` and `jarvis-test` profiles do not need to run continuously. Start only the profile needed for the current authorized validation. Use an explicit name and disable activation so startup never changes the global Docker context:

```bash
colima start jarvis --activate=false
infra/colima/verify.sh --profile jarvis
colima stop jarvis
```

For a previously provisioned, stopped test profile, run the full-capacity preflight before starting it, then verify its identity:

```bash
infra/colima/test-profile.sh --check-host
colima start jarvis-test --activate=false
infra/colima/test-profile.sh --verify
colima stop jarvis-test
```

`colima stop` preserves the VM, containers, and volumes for the next session. First-time provisioning of an absent profile uses the `--apply` flow above; do not rerun `--apply` for an existing stopped profile. `test-profile.sh --cleanup` is different: it explicitly removes the `jarvis-test` VM and its Compose volumes. Use cleanup only after retaining needed evidence and confirming test data can be discarded.

At task start, inspect the Colima inventory. Do not stop a profile that was already running unless the owner has authorized that run's scheduling; stop only a profile started for the current task after its workloads are no longer needed. The test preflight counts every running profile and fails closed; neither helper automatically stops or resizes another profile. If capacity is insufficient, do not reduce allocations or touch `default`; coordinate an on-demand schedule and rerun preflight.

## Isolated local test profile

`jarvis-test` is separate from the accepted `jarvis` baseline and `default`. It has its own Colima config and Engine context (`colima-jarvis-test`), Compose project (`jarvis-test`), database secret path (`/etc/jarvis-test/secrets/postgres_password`), network and persistent volume. It uses ARM64 Docker, Kubernetes off, four CPUs, 8 GiB, 80 GiB, `autoActivate: false`, `mounts: null`, and no SSH-agent forwarding. No test helper falls back to the active context or targets the primary local `jarvis` POC profile.

The test-profile preflight reserves capacity for the complete VM, including checking physical CPU count against all running Colima profiles, currently available host memory, and free host disk. It fails rather than changing another profile or reducing the requested VM. Run it before provisioning:

```bash
infra/colima/test-profile.sh --check-host
infra/colima/test-profile.sh --apply
infra/colima/test-profile.sh --verify
infra/colima/test-profile.sh --db-up
infra/colima/test-profile.sh --db-check
```

Provisioning refuses existing test-profile configuration or an existing `colima-jarvis-test` context and starts only `jarvis-test` with activation disabled. Verification checks the exact config, VM allocation, context socket identity and ARM64 engine. Never point the test workflow at `colima-jarvis` or rely on Docker's active context.

`infra/colima/test-profile.sh --run <40-character-source-SHA>` requires an exact clean worktree and currently expects a repository-root `Dockerfile`; it cannot build this branch's API image at `infra/compose/Dockerfile`. To build the API image for a local test-profile smoke, first verify the issue worktree revision and cleanliness, then use the explicit test context from the worktree root:

```bash
sha="$(git rev-parse --short HEAD)"
docker --context colima-jarvis-test build --platform linux/arm64 \
  --file infra/compose/Dockerfile --tag "jarvis-test/api:${sha}" .
docker --context colima-jarvis-test image inspect "jarvis-test/api:${sha}" \
  --format '{{.Id}} {{.Os}}/{{.Architecture}}'
```

This builds and loads locally in the test Engine; it does not publish an image or deploy services. `--apply` creates a random synthetic PostgreSQL password directly in the VM through SSH without printing it. The test Compose project uses an isolated PostgreSQL volume and internal network, with no published host port. Existing ordinary PostgreSQL integration tests continue to use their existing ephemeral/disposable database setup.

### Guest DNS troubleshooting

`network.dns` configures resolver addresses for the Colima VM, but an existing guest can retain a stale `/etc/resolv.conf` that points to an unresponsive Lima resolver. If `getent ahostsv4 registry-1.docker.io` fails, inspect the guest resolver file and test name resolution from inside that profile. Use only DNS servers approved for the current host/network; the addresses below were the validating Mac's current resolvers, not universal defaults:

```yaml
network:
  dns: [1.1.1.1, 1.0.0.1]

provision:
  - mode: system
    script: |
      cat > /etc/resolv.conf <<'EOF'
      nameserver 1.1.1.1
      nameserver 1.0.0.1
      EOF
```

Replace both address lists with the same approved resolver set. Keep this change in the selected profile's local `~/.colima/<profile>/colima.yaml`; do not edit Colima's global template or the `default` profile. The startup provisioning script rewrites only that VM's `/etc/resolv.conf`. Restart only the authorized target profile when its services can be stopped safely, using `colima start <profile> --activate=false`, then confirm the resolver file and `getent` lookup. `colima stop` preserves the VM and volumes; never delete the profile to repair DNS. This host/VM resolver setup does not authorize external DNS or network access from task/sandbox containers; preserve their separate network-isolation gates.

Cleanup is deliberately explicit and test-only:

```bash
infra/colima/test-profile.sh --cleanup
```

It verifies the test context points to the exact test socket, invokes `docker compose -p jarvis-test ... down --volumes` inside the test VM, then stops and deletes only `jarvis-test`. It does not prune Docker resources or remove any other profile/context. Preserve before/after snapshots of `colima list`, Docker contexts, and container/volume inventories when performing a native smoke; compare both `jarvis` and `default` as unchanged. Behavioral boundary checks: `bash infra/colima/test-profile-boundaries.sh`.

## Evidence and limitations

Record the source SHA, exact local image ID and architecture, commands, exit statuses, and test output with each validation run. Report PostgreSQL readiness, API health/authentication, DB behavior, loopback-only listener behavior, and other checks as separate observations; do not infer one from another. The PR #288 `jarvis-test` smoke verifies only that separate local test profile. The October 30, 2026 local smoke exercised isolated project `jarvis-poc-132-fresh` on `jarvis` (see [local proxy smoke — October 30, 2026](#local-proxy-smoke-october-30-2026)): healthy DB/API, internal network, no container host bindings, synthetic owner onboarding/authentication/logout HTTP flow, Mac loopback listener, missing-project 503, and `jarvis` DNS resolution from the running guest were verified. It used a transient guest loopback proxy only; installation and lifecycle of the checked-in persistent systemd unit/wrapper remain unverified. Managed Chromium displayed the sign-in page only; no authenticated browser login was performed. The smoke's unverified H5 runtime items still apply; a separate-device check does not. No external production deployment or validation is in scope.

## VM-local secrets

Provision a secret only from a trusted local secret source, piping the value through stdin:

```bash
secret-manager read jarvis/postgres-password | infra/colima/provision-secret.sh postgres_password
```

The value is never a process argument, environment variable, host file, or log entry. It is written by root over Colima SSH to `/etc/jarvis/secrets/<name>` with mode `0400` in a `0700` directory. Existing names are refused unless `--replace` is explicitly given. Do not use `echo`, shell tracing, or a tracked `.env` file. No real secret was provisioned by this change.
Build and push the application image from the reviewed repository revision using the dedicated ARM64 Engine and the approved registry:

```bash
docker --context colima-jarvis buildx build --platform linux/arm64 \
  --file infra/compose/Dockerfile --tag "$JARVIS_APP_TAG" --push .
docker --context colima-jarvis buildx imagetools inspect "$JARVIS_APP_TAG"
```

Record the actual manifest digest returned by the registry inspection and use its `repository@sha256:...` value for `JARVIS_APP_IMAGE`. A mutable tag is only a build/lookup input; never invent or copy a digest from another build. These commands are deployment guidance, not checks run by this source change.

The application Compose overlay extends the baseline manifest with an API serving the built React UI, a database-role bootstrap job, and a one-shot migration job. The API, PostgreSQL, and application jobs share only internal `core` (`172.30.132.0/24`); API is fixed at `172.30.132.10`, and none has a Docker-published host port. Docker Engine 29.5.2 does not publish a port for a container attached only to an `internal: true` network. After successful `up`, the wrapper installs a guest-host systemd TCP proxy with `DynamicUser=true` and `RestrictAddressFamilies=AF_INET`; the helper has no Docker CLI/API discovery and connects only to `172.30.132.10:3000`. Its listener is fixed to guest `127.0.0.1:3000`; connection failures return 503. The proxy cannot access the Unix Engine socket by address-family restriction. Compose network routing to this subnet after creation, persistent service installation and runtime behavior remain unverified without platform execution.

Before starting the overlay, place the operator-generated `postgres_password`, `jarvis_migrator_password`, `jarvis_runtime_password`, and `owner_onboarding_secret` in the VM secret directory using the trusted secret-source procedure above. Choose passwords outside this chat and provide an onboarding secret of at least 32 UTF-8 bytes. The owner chooses the account password through the UI; no password is preconfigured.

Build `infra/compose/Dockerfile` from the trusted reviewed revision for `linux/arm64`, publish it to the approved image registry, and use the returned digest (not a tag or invented digest) as `JARVIS_APP_IMAGE`. The Dockerfile pins its Node.js base image and the Compose manifests and wrapper require an immutable `repository@sha256:<64-hex-digest>` reference. Set `JARVIS_APP_IMAGE=registry.example/path/jarvis-app@sha256:<registry-returned-digest>` in the trusted local deployment environment, then run `infra/colima/compose.sh up -d`. The wrapper passes this non-secret image reference and guest socket group through the VM SSH command; DB credentials and onboarding material remain mounted from VM-local files. After Compose succeeds, it installs the fixed-address helper and restricted systemd unit. The helper has no Docker CLI/API calls or AF_UNIX access; only the trusted sandbox-manager accesses the guest Engine socket.

The API container runs with a read-only root filesystem and all Linux capabilities dropped. The local file-backed Compose secret mounts are root-owned VM files, so the API process runs as container root to read them; it has no host socket or bind mount. Keep the Compose files and all secret files VM-local; never copy them to a Mac-shared path.

The PostgreSQL service is internal-only and has no host port. `db-bootstrap` and `migrate` must complete successfully before the API starts. The runtime login is granted membership in the migration-created `jarvis_app` role and does not receive migration credentials. The runtime uses only the existing owner-auth, dashboard, and stop-control boundaries; it does not enable workers or product tasks.

The sandbox-manager is an opt-in Compose profile, not started by ordinary `up`. Its build script verifies the explicit ARM64 `colima-jarvis` Engine and builds a digest-pinned Node.js 24.22.0 image without starting it. The Compose definition mounts the guest Engine socket only into the manager, uses the guest Docker group resolved by the wrapper, drops capabilities, uses a read-only root filesystem, exposes no host port, and attaches only to the internal `core` network. It cannot start until the owner-controlled profile file and TLS server key/certificate/client CA are provisioned in the guest. These files are not created by `bootstrap.sh` or this change. Do not enable the profile or product tasks until J01 security review and live isolation qualification pass; static configuration and mock API tests are not proof of runtime isolation. See [`infra/sandbox-manager/README.md`](../sandbox-manager/README.md).

### Local proxy smoke (October 30, 2026)

The October 30 local app/auth HTTP smoke used a transient test proxy, not the checked-in implementation, and relied on Docker target discovery (the privileged pattern rejected in review). It evidences the isolated app/auth flow, internal API/DB health and no host ports, guest-loopback-to-Mac-loopback forwarding mechanism, and guest DNS only. It does not validate the fixed-address/no-socket helper, static subnet routing, persistent service installation, or other unverified H5 runtime items. No second LAN device was tested; a separate-device check is not required for this POC. No external production deployment or validation is implied.

## Recovery and limitations

The active `default` profile was observed running before implementation; it is intentionally untouched. If `jarvis` already exists, inspect it manually and do not delete it to make the script pass. Recreate a profile only under an explicit owner-directed recovery procedure after preserving any data. The bootstrap requires exact Colima and Lima versions, and accepts Docker CLI versions compatible with major 29 (29.x.y); Docker CLI 29.9.1 remains the selected baseline. It fails closed on other version drift and does not install or upgrade host tools.

No runtime profile is automatically started by CI. Static tests cover the checked-in configuration and mocked host guards; effective VM mounts, canary denial, engine package pins, port-forward behavior, authenticated access, and other H5 runtime checks require direct platform evidence from the selected Mac and remain separate from static checks. Production validation is out of scope.
