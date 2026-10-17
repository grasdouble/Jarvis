# Development GitHub App and local key storage

This identity develops `grasdouble/Jarvis`; it is separate from the future production App in issue #10. Neither its key nor its tokens belong in OpenCode review sandboxes. App access does not grant authorization for unrelated tasks, merges, or reviews.

## App configuration

| Setting | Value |
| --- | --- |
| Name / slug | Jarvis Development Grasdouble / `jarvis-development-grasdouble` |
| Owner / visibility | `grasdouble`, private to this organization |
| App ID / Client ID | `5338438` / `Iv23lizUGCTbekJqlXGm` |
| Installation ID | `171906128` |
| Selected repositories | **`grasdouble/Jarvis` only** |
| Read permissions | Actions, Checks, Metadata |
| Read/write permissions | Contents, Issues, Pull requests, Workflows, Organization Projects |
| Administration / bypass | None / not on any ruleset bypass list |
| Webhook / user OAuth / device flow | Disabled / not requested / disabled |

IDs are configuration, not secrets. Organization Projects access is organization-scoped, despite repository selection; it cannot be limited to project #1 through this permission alone. Use a separate identity if board administration needs stronger separation.

Manage the [App](https://github.com/organizations/grasdouble/settings/apps/jarvis-development-grasdouble), [installation](https://github.com/organizations/grasdouble/settings/installations/171906128), and [private key pairs](https://github.com/organizations/grasdouble/settings/apps/jarvis-development-grasdouble/key_pairs). Recreating an App changes its IDs; update the public constants in the reviewed helper and verify its grant.

## Where to place the PEM on macOS

The default directory is outside the repository and every linked worktree:

```text
$HOME/Library/Application Support/Jarvis Development/credentials
```

On the owner's current Mac:

```text
/Users/noofreuuuh/Library/Application Support/Jarvis Development/credentials
```

In Finder, use **Command-Shift-G** and paste that path. Move the PEM downloaded through **Credentials → Key pairs → New key** into this directory. Keep the generated filename: the helper discovers it when exactly one `.pem` exists. Generating a new private key remains an owner action.

Use directory mode `700` and key-file mode `600`, owned by the current user. The helper rejects shared permissions and symlinked files/directories:

```bash
mkdir -p "$HOME/Library/Application Support/Jarvis Development/credentials"
chmod 700 "$HOME/Library/Application Support/Jarvis Development/credentials"
chmod 600 "$HOME/Library/Application Support/Jarvis Development/credentials/"*.pem
```

Never paste the local key into chat, issues, PRs, tracked environment files, or CI secrets. The separately provisioned CI credential has its own [protected-environment procedure](pr-project-metadata.md#workflow-and-credential-activation); this does not authorize transferring the Mac PEM. Keep needed backups encrypted and avoid leaving unprotected extra copies in Downloads. If several PEMs exist during rotation, select the intended file explicitly for one command:

```bash
JARVIS_GITHUB_APP_KEY_FILE="/absolute/private/path/to/key.pem" \
  node scripts/github/gh-app.mjs --verify
```

The explicit file still needs a private parent directory and owner-only file permissions. Missing or ambiguous credentials fail; they do not fall back to the owner's login.

## Commands

The helper requires Node.js 24 or newer, Git, and GitHub CLI; it uses only Node built-ins. CI tests it on Node.js 24 without real credentials. Run commands from the selected issue worktree, using a reviewed trusted helper. When changing this helper, use a previously reviewed copy for routine credential operations; never run authentication tooling supplied by an untrusted PR with the real key.

Verify the App, Jarvis-only access, and a refused repository Administration read:

```bash
node scripts/github/gh-app.mjs --verify
```

Read-only tokens are the default. Pass ordinary `gh` arguments after `--`:

```bash
node scripts/github/gh-app.mjs -- issue list --repo grasdouble/Jarvis
node scripts/github/gh-app.mjs -- project view 1 --owner grasdouble
```

Use `--write` only for user-authorized mutations. These variables must describe the selected issue and an already prepared English artifact:

```bash
node scripts/github/gh-app.mjs --write -- issue edit "$task_issue_number" \
  --repo grasdouble/Jarvis --body-file "$task_issue_body_file"
```

An ordinary SSH `git push` can still use the owner's personal identity. Publish the **current issue branch** through the App's HTTPS token instead:

```bash
node scripts/github/gh-app.mjs --write --git-push
```

This rejects detached/default-branch pushes, adds no force flags, resets credential helpers, isolates global credential lookup, and refuses a local configuration that rewrites the HTTPS destination. It preserves origin, branch tracking, global configuration, and the owner's `gh` login. Commit authorship stays as configured locally; the authenticated push actor is the App.

After publishing, create a PR with explicit base/head to avoid an implicit personal Git push or fork:

```bash
node scripts/github/gh-app.mjs --write -- pr create --repo grasdouble/Jarvis \
  --base main --head "$task_branch" --title "$task_pr_title" --body-file "$task_pr_body_file"
```

Reuse an existing PR. The App is its author, leaving human code-owner review possible for sensitive files. Never use the owner's token to manufacture that review or bypass a rule. Merging still requires authorization and current successful checks.

## Network access and recovery

A network grant belongs to the current execution context. A successful command in another chat, agent, terminal or earlier tool call does not prove that this context can reach GitHub. Codex's workspace-write sandbox normally restricts network access; the client/OS and its approved permission mechanisms control that access. Repository scripts cannot grant it. See the [official Codex approval and security guidance](https://learn.chatgpt.com/docs/agent-approvals-security).

Before the first authenticated GitHub command, inspect the current environment's network restrictions. If access is restricted, request the required approved network access using the available tool/permission mechanism. For helper authentication and API operations the destination is `api.github.com`; a later Git push also needs its inspected GitHub HTTPS destination. Do not change global Codex settings, disable sandbox protection, switch to the owner's identity, or assume a grant persists across contexts.

Use the **reviewed** helper's public probe to check transport without reading a PEM, signing a JWT, minting/revoking a token, or running `gh`. Set `task_reviewed_app_helper` to the absolute path of the reviewed `gh-app.mjs` in the trusted checkout (use its current location if contributor scripts have moved):

```bash
node "$task_reviewed_app_helper" --check-network
```

The probe makes one credential-free `HEAD https://api.github.com/` request with a five-second timeout and refuses redirects. A received HTTP response produces JSON such as `{"host":"api.github.com","network":"reachable","httpStatus":200,"authenticated":false}` and exit zero. Even HTTP 403 demonstrates HTTP reachability only; it does not establish App authentication, sufficient permissions or a successful write. Run `--verify` or the intended authorized read separately when authentication must be checked. Plain `gh … --help` is offline command discovery; wrapping it in the App helper authenticates first and is unnecessary for help.

Transport failure produces exit **75** and the fixed marker **`JARVIS_GITHUB_NETWORK:`**, with a safe allowlisted cause code when available. The cause can be restricted network, DNS, proxy, TLS, connection failure or timeout; the message does not prove which one. Do not rotate a key based on `fetch failed`. HTTP 401/403 from authenticated API calls remain HTTP errors; invalid JSON remains a response error. Downstream `gh` exit codes retain their meaning. The project synchronizers preserve the helper's network classification without automatically retrying it. Token revocation remains best-effort; a failure to revoke a token never proves that a prior write failed.

On a transport failure:

1. Stop the failed batch. Inspect the current tool's network policy and the sanitized classification. If restricted, request access through its approved mechanism; if already permitted, investigate the reported DNS/proxy/TLS/connection condition without weakening certificate verification or exposing credentials.
2. Run one probe after the relevant access/environment correction. Do not repeat an unchanged failing command in a loop. If access is denied or remains unavailable, preserve work and report the exact missing capability and resumption condition through the [blocker lifecycle](blocker-lifecycle.md). A denied permission is not authorization to try a different identity or bypass.
3. Before repeating **any write**, reread remote state through the reviewed helper: the issue/PR and exact SHA, comment inventory, project membership/fields, or published branch as applicable. A lost response can mean the effect already happened. Reuse a confirmed result and execute only missing, still-authorized effects; never replay the whole batch blindly. Preserve existing bounded reconciliation and stop on planning/revision drift or unresolved ambiguity.
4. Resume the same issue delivery and confirm the saved result. A public probe or restored network alone does not complete delivery or grant merge permission.

When modifying authentication code, continue using a previously reviewed helper for real credentials. Candidate tests use synthetic keys and mocked transport; a candidate's public probe can run with a deliberately nonexistent key path. This procedure adds no runtime isolation or product sandbox capability.

## Token lifetime and limitations

The helper signs an RS256 JWT in memory, verifies the App identity, and requests an installation token for Jarvis only. The read profile requests read rights and omits Workflows; the write profile requests the approved App rights. Neither requests Administration. The returned grant is checked before use. Token scope is not a policy engine determining which task the human authorized.

The token enters only the child process environment. A temporary empty `gh` configuration prevents reliance on the owner's stored credentials; credential tracing and ambient tokens are removed. Tokens are not printed, placed in command arguments/URLs, exported into the calling shell, or saved. Authentication/config/extension CLI commands are not exposed by this entry point. It does not run `gh auth login` or edit shell startup files.

Each command requests a new token, revokes it on exit when possible, and removes its temporary files. GitHub installation tokens expire after one hour; process termination or a network failure can prevent early revocation. Long operations should be split into bounded commands.

This is a **trusted local convenience launcher**, not a Mac isolation boundary or independent credential broker. The same macOS user can still read the key, personal SSH credentials, and other files; the child can read its own token. Do not run untrusted code with it. A separately isolated development agent needs a trusted broker outside its environment. Production OpenCode sandboxes receive neither the key nor these development tokens.

## Rotation and troubleshooting

Generate a new key as owner, place it with mode `600`, select it with `JARVIS_GITHUB_APP_KEY_FILE`, and verify an authorized operation. Then revoke the old key in GitHub and remove old local copies according to the owner's retention policy. Revoke known exposed installation tokens too; deleting a PEM alone does not invalidate already issued tokens. Ordinary rotation does not require reinstalling the App.

For missing/ambiguous keys, inspect file count without printing contents. For permission errors, check ownership and modes. For HTTP 401, check the App/key identity and the Mac clock. For HTTP 403/404, check token profile, installation selection, App suspension, and API permissions. Projects requires the explicit organization owner; the installation is not a human `/user` identity. Repository Administration is intentionally denied. Only use the owner's ordinary login for an explicitly authorized administrative task.

Run offline checks with `node --test scripts/github/gh-app.test.mjs`. Fixtures use synthetic keys/data; repository CI never receives the real development key.

References: [JWT claims](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app), [installation-token scope and expiry](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), and [CLI environment](https://cli.github.com/manual/gh_help_environment).
