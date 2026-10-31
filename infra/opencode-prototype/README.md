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

The harness defines explicit `plan` and `review` agents under OpenCode v2's `agents` configuration field, with global and agent-level deny-all/read-glob-grep-only permissions. The probe compares each agent config with the reusable runtime profile and requests denied shell/edit tools in sessions created with each explicit mode. This probes only the configured permission behavior in this synthetic harness. The v2.0.32 pin predates v2.2.3; it does not provide newer plugin/skill/MCP policy controls. Snapshot exclusions are finite and documented in [`technical-architecture.md`](../../docs/technical-architecture.md#43-opencode-transport-without-a-control-network); unknown config conventions are not autodetected.

The latest `infra/opencode-prototype/qualify-colima.sh` run passed on the dedicated ARM64 `colima-jarvis` context with the pinned OpenCode v2.0.32 image and synthetic fixture. This is prototype qualification only: it is not integrated with the sandbox-manager or product callsites and is not a qualified product profile. It does not establish real-provider compatibility, DNS-rebinding defense, durable F09 accounting, or cleanup/reconciliation across manager restart.
