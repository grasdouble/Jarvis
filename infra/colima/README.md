# Dedicated Colima profile

This directory provisions the JARVIS-only Colima profile. It never changes or activates the user's `default` profile/context.

## Selected baseline

`versions.env` is the reviewed version lock: Colima 0.10.3, Lima 2.2.1, Docker CLI 29.9.1, Docker Engine 29.5.2 (Ubuntu Noble ARM64 packages), containerd 2.2.4, and Docker Compose 5.6.0. Compose is downloaded for `linux-aarch64`, checked against its release SHA-256, then streamed over Colima SSH into the guest. The Compose manifest pins PostgreSQL 18.6-bookworm by multi-platform digest and explicitly selects `linux/arm64`.

The owner-selected resource baseline is 4 VM CPUs, 8 GiB RAM, an 80 GiB VM disk, at least 40 GiB free on the Mac before provisioning, and a 2-CPU/4-GiB per-sandbox target. The bootstrap refuses a host below those CPU, memory, architecture, macOS, or free-space requirements. These are selected targets, not a claim that product sandbox quotas are implemented or qualified.

## Commands and effects

Run from the repository root:

```bash
infra/colima/bootstrap.sh --check-host
infra/colima/bootstrap.sh --apply
infra/colima/verify.sh --profile jarvis
infra/colima/verify.sh --profile jarvis --require-ui
```

- `--check-host` is read-only. It verifies the Mac and pinned host tools and reports the chosen configuration.
- `--apply` creates the new `~/.colima/jarvis` configuration, starts the isolated named profile without activating a global context, pins guest Engine packages, installs the checksummed Compose plugin, and copies `infra/compose/compose.yaml` through the profile's SSH channel. It fails rather than overwriting any existing `jarvis` profile. It does not start product services or create secrets.
- `verify.sh` reads the live Colima/Engine state, checks exact package/tool versions, ARM64 identity, effective guest mounts, SSH-agent absence, a temporary host-home canary, and rejects all non-loopback container port bindings. `--require-ui` additionally requires the application listener check below. No command deletes a profile or changes `default`.
- `verify-listener.sh --profile jarvis` requires a running UI on `127.0.0.1:3000`, checks the host-side listener is bound only to `127.0.0.1`, rejects other published host addresses, and checks that an unauthenticated HTTP request is denied (401 or a same-origin login redirect). A positive authenticated login and a negative test from another LAN device still require the later authenticated UI and a second device; this script cannot establish either by itself.

## VM-local secrets

Provision a secret only from a trusted local secret source, piping the value through stdin:

```bash
secret-manager read jarvis/postgres-password | infra/colima/provision-secret.sh postgres_password
```

The value is never a process argument, environment variable, host file, or log entry. It is written by root over Colima SSH to `/etc/jarvis/secrets/<name>` with mode `0400` in a `0700` directory. Existing names are refused unless `--replace` is explicitly given. Do not use `echo`, shell tracing, or a tracked `.env` file. No real secret was provisioned by this change.

The current Compose manifest defines only the ARM64 PostgreSQL service and keeps it on an internal network without host ports. After provisioning the DB password, start it with `infra/colima/compose.sh up -d`; this wrapper invokes Compose through `sudo` inside the VM so root-only secret and manifest paths are readable. The API/UI image and its authentication are not implemented in the current workspace; consequently no UI listener or positive login is claimed by this bootstrap. Product services must retain the same loopback-only UI port and no other host port when added.

## Recovery and limitations

The active `default` profile was observed running before implementation; it is intentionally untouched. If `jarvis` already exists, inspect it manually and do not delete it to make the script pass. Recreate a profile only under an explicit owner-directed recovery procedure after preserving any data. The bootstrap checks an exact Colima/Lima/CLI version and fails closed on drift; it does not install or upgrade host tools.

No runtime profile is automatically started by CI. Static tests cover the checked-in configuration and mocked host guards; effective VM mounts, canary denial, engine package pins, port-forward behavior, authenticated access, and LAN reachability require direct platform evidence from the selected Mac and remain separate from static checks.
