#!/usr/bin/env bash
set -euo pipefail

CONTEXT="colima-jarvis"
container="${1:-}"
operation="${2:-}"

[[ "$container" =~ ^jarvis-jv006-opencode-[A-Za-z0-9-]+$ ]] || {
  echo "A run-scoped OpenCode prototype container name is required" >&2
  exit 64
}

case "$operation" in
  health)
    docker --context "$CONTEXT" exec "$container" node -e '
      const password = process.env.OPENCODE_SERVER_PASSWORD;
      if (!password) process.exit(2);
      const authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
      fetch("http://127.0.0.1:4096/api/info", { headers: { authorization } })
        .then(async (response) => {
          if (!response.ok) process.exit(1);
          const info = await response.json();
          if (info.version !== "2.0.32") process.exit(1);
          process.stdout.write(JSON.stringify({ healthy: true, version: info.version }) + "\n");
        })
        .catch(() => process.exit(1));
    '
    ;;
  probe)
    docker --context "$CONTEXT" exec --user 10001:10001 "$container" env -u LLM_GATEWAY_ATTEMPT_CAPABILITY node /opt/jarvis/api-probe.mjs
    ;;
  *)
    echo "Unsupported fixed relay operation" >&2
    exit 64
    ;;
esac
