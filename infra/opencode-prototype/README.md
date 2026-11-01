# OpenCode Colima prototype image

This ARM64-only prototype image pins Node.js 24.22.0 by the digest already used by the sandbox-manager and OpenCode v2.0.32 by the SHA-256 published in OpenCode's update metadata (`https://opencode.ai/update/api/latest/cli/opencode`, checked October 19, 2026). It is separate from the production sandbox-manager image and is not a product profile or an approval to run a repository task.

Build and verify the image without starting it:

```bash
infra/opencode-prototype/build-image.sh
```

The build targets only the `colima-jarvis` ARM64 Engine, verifies the fixed archive checksum during download, and runs only `opencode --version` with `--network none`. No host mount, API key, provider request, GitHub credential or task snapshot is used by this build check.

Run the actual Colima qualification with:

```bash
infra/opencode-prototype/qualify-colima.sh
```

The JARVIS image sets `OPENCODE_CONFIG_PROJECT_DISABLE=true` for the pinned v2.0.32 server process, disabling project config and project plugin discovery. The trusted usage plugin is copied into the image and selected by the manager-generated config; project snapshots cannot supply that path. The manager gives the per-attempt capability only to a root-owned entrypoint; it runs OpenCode as UID 10001 without the capability environment, with the root-owned supervisor boundary protecting `/proc/*/environ`, including a repository symlink to `/proc/1/environ`. The gateway UDS is explicitly mode 0660; the trusted parent uses its socket-owning group to reach it. The container drops all capabilities except SETUID/SETGID to transition UID and KILL to forward shutdown, with network isolation, read-only rootfs, and `no-new-privileges`; candidate tools still have no shell or API-accounting-socket mount. The ARM64 synthetic Colima qualification passed on OpenCode v2.0.32, exercising plan/review, the runtime plugin through loopback bridge → gateway UDS → API UDS using synthetic responses, candidate plugin suppression, permission denials, the environment/symlink boundary, and clean shutdown. This does not establish live provider compatibility, production enablement, DNS-rebinding defense, PostgreSQL-backed accounting, or cleanup/reconciliation across manager restart. The v2.0.32 pin predates newer plugin/skill/MCP policy controls, so permission checks and project discovery suppression are not conflated. Snapshot exclusions are finite and documented in [`technical-architecture.md`](../../docs/technical-architecture.md#43-opencode-transport-without-a-control-network).
