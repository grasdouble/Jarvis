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

It uses a synthetic fixed snapshot and gateway, fresh guest volumes and a unique server password. The host-side `exec-relay.sh` accepts only `health` and `probe`; it rejects arbitrary commands. The qualification verifies the v2 API client, synthetic structured response, refused shell-tool attempt, cancellation, read-only snapshot/config, writable isolated state and cleanup on the dedicated `colima-jarvis` ARM64 Engine. It does not use repository content, provider/GitHub credentials, external networking from the agent, or billable provider calls. Do not use the host's OpenCode configuration or credentials; do not publish port 4096.

The harness is not integrated with the sandbox-manager and is not a production profile. It does not establish complete permission-policy coverage, real-provider compatibility, DNS-rebinding defense, durable F09 accounting, or cleanup/reconciliation across manager restart.
