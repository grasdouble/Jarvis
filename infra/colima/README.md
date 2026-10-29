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
- `verify.sh` reads the live Colima/Engine state, checks exact package/tool versions, ARM64 identity, effective guest mounts, SSH-agent absence, a temporary host-home canary, and rejects all non-loopback container port bindings. `--require-ui` additionally requires the application listener check below. No command deletes a profile or changes `default`.
- `verify-listener.sh --profile jarvis` requires a running UI on `127.0.0.1:3000`, checks the host-side listener is bound only to `127.0.0.1`, rejects other published host addresses, and checks that an unauthenticated HTTP request is denied (401 or a same-origin login redirect). A positive authenticated login and a negative test from another LAN device still require the later authenticated UI and a second device; this script cannot establish either by itself.

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

`jarvis-test` is separate from the accepted `jarvis` baseline and `default`. It has its own Colima config and Engine context (`colima-jarvis-test`), Compose project (`jarvis-test`), database secret path (`/etc/jarvis-test/secrets/postgres_password`), network and persistent volume. It uses ARM64 Docker, Kubernetes off, four CPUs, 8 GiB, 80 GiB, `autoActivate: false`, `mounts: null`, and no SSH-agent forwarding. No test helper falls back to the active context or targets the production profile.

The test-profile preflight reserves capacity for the complete VM, including checking physical CPU count against all running Colima profiles, currently available host memory, and free host disk. It fails rather than changing another profile or reducing the requested VM. Run it before provisioning:

```bash
infra/colima/test-profile.sh --check-host
infra/colima/test-profile.sh --apply
infra/colima/test-profile.sh --verify
infra/colima/test-profile.sh --db-up
infra/colima/test-profile.sh --db-check
```

Provisioning refuses existing test-profile configuration or an existing `colima-jarvis-test` context and starts only `jarvis-test` with activation disabled. Verification checks the exact config, VM allocation, context socket identity and ARM64 engine. Never point the test workflow at `colima-jarvis` or rely on Docker's active context.

`infra/colima/test-profile.sh --run <40-character-source-SHA>` requires the argument to match the checked-out commit and refuses any tracked or untracked worktree changes before building. It also fails with a direct prerequisite message unless the root product `Dockerfile` exists; that Dockerfile/API runtime image is currently absent, so no JARVIS image, deployment, or runtime result is available. When the build input exists, the command asks Buildx to build for `linux/arm64`, load in the test Engine, and report the local image ID and platform. It never pushes or logs into a registry. `--apply` creates a random synthetic PostgreSQL password directly in the VM through SSH without printing it. The test Compose project uses an isolated PostgreSQL volume and internal network, with no published host port. Existing ordinary PostgreSQL integration tests continue to use their existing ephemeral/disposable database setup.

Cleanup is deliberately explicit and test-only:

```bash
infra/colima/test-profile.sh --cleanup
```

It verifies the test context points to the exact test socket, invokes `docker compose -p jarvis-test ... down --volumes` inside the test VM, then stops and deletes only `jarvis-test`. It does not prune Docker resources or remove any other profile/context. Preserve before/after snapshots of `colima list`, Docker contexts, and container/volume inventories when performing a native smoke; compare both `jarvis` and `default` as unchanged. Behavioral boundary checks: `bash infra/colima/test-profile-boundaries.sh`.

## Evidence and limitations

Record the source SHA, exact local image ID and architecture, commands, exit statuses, and test output with each validation run. Report PostgreSQL readiness, API health/authentication, DB behavior, loopback-only listener behavior, and whether a separate LAN device was available as separate observations; do not infer one from another. The current workspace does not provide a production API deployment image or a complete authenticated product deployment, so those runtime behaviors must be stated unavailable rather than claimed by the profile bootstrap. No separate-device check is possible from the Mac itself.

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

The application Compose overlay extends the baseline manifest with an API serving the built React UI, a database-role bootstrap job, and a one-shot migration job. Only the API publishes `127.0.0.1:3000`; PostgreSQL and the application jobs have no host ports and share only the internal `core` network. The bootstrap uses the PostgreSQL administrator secret only to create distinct `jarvis_migrator` and `jarvis_runtime` login roles. Migrations run under the migrator; the API receives only the runtime password and the one-time owner-onboarding secret.

Before starting the overlay, place the operator-generated `postgres_password`, `jarvis_migrator_password`, `jarvis_runtime_password`, and `owner_onboarding_secret` in the VM secret directory using the trusted secret-source procedure above. Choose passwords outside this chat and provide an onboarding secret of at least 32 UTF-8 bytes. The owner chooses the account password through the UI; no password is preconfigured.

Build `infra/compose/Dockerfile` from the trusted reviewed revision for `linux/arm64`, publish it to the approved image registry, and use the returned digest (not a tag or invented digest) as `JARVIS_APP_IMAGE`. The Dockerfile pins its Node.js base image and the Compose manifests and wrapper require an immutable `repository@sha256:<64-hex-digest>` reference. Set `JARVIS_APP_IMAGE=registry.example/path/jarvis-app@sha256:<registry-returned-digest>` in the trusted local deployment environment, then run `infra/colima/compose.sh up -d`. The wrapper passes only this non-secret image reference and the guest socket group through the VM SSH command; DB credentials and onboarding material remain mounted from VM-local files.

The API container runs with a read-only root filesystem and all Linux capabilities dropped. The local file-backed Compose secret mounts are root-owned VM files, so the API process runs as container root to read them; it has no host socket or bind mount. Keep the Compose files and all secret files VM-local; never copy them to a Mac-shared path.

The PostgreSQL service is internal-only and has no host port. `db-bootstrap` and `migrate` must complete successfully before the API starts. The runtime login is granted membership in the migration-created `jarvis_app` role and does not receive migration credentials. The runtime uses only the existing owner-auth, dashboard, and stop-control boundaries; it does not enable workers or product tasks.

The sandbox-manager is an opt-in Compose profile, not started by ordinary `up`. Its build script verifies the explicit ARM64 `colima-jarvis` Engine and builds a digest-pinned Node.js 24.22.0 image without starting it. The Compose definition mounts the guest Engine socket only into the manager, uses the guest Docker group resolved by the wrapper, drops capabilities, uses a read-only root filesystem, exposes no host port, and attaches only to the internal `core` network. It cannot start until the owner-controlled profile file and TLS server key/certificate/client CA are provisioned in the guest. These files are not created by `bootstrap.sh` or this change. Do not enable the profile or product tasks until J01 security review and live isolation qualification pass; static configuration and mock API tests are not proof of runtime isolation. See [`infra/sandbox-manager/README.md`](../sandbox-manager/README.md).

The API and React UI production composition is now present in source, but this does not establish a deployed image digest, a running UI listener, a successful owner login, or LAN isolation. The deployment wrapper's host-side forwarding and the separate-device negative test require the selected Mac and a second LAN device; those live checks remain outstanding.

## Recovery and limitations

The active `default` profile was observed running before implementation; it is intentionally untouched. If `jarvis` already exists, inspect it manually and do not delete it to make the script pass. Recreate a profile only under an explicit owner-directed recovery procedure after preserving any data. The bootstrap requires exact Colima and Lima versions, and accepts Docker CLI versions compatible with major 29 (29.x.y); Docker CLI 29.9.1 remains the selected baseline. It fails closed on other version drift and does not install or upgrade host tools.

No runtime profile is automatically started by CI. Static tests cover the checked-in configuration and mocked host guards; effective VM mounts, canary denial, engine package pins, port-forward behavior, authenticated access, and LAN reachability require direct platform evidence from the selected Mac and remain separate from static checks.
