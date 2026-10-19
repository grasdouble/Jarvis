#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTEXT="colima-jarvis"
OPENCODE_IMAGE="jarvis/opencode-prototype:2.0.32"
GATEWAY_IMAGE="jarvis/llm-gateway-fixture:2.0.32"
SUFFIX="$$-$(date +%s)"
SANDBOX="jarvis-jv006-opencode-$SUFFIX"
GATEWAY="jarvis-jv006-gateway-$SUFFIX"
WORK_VOLUME="jarvis-jv006-work-$SUFFIX"
STATE_VOLUME="jarvis-jv006-state-$SUFFIX"
CONFIG_VOLUME="jarvis-jv006-config-$SUFFIX"
TRANSPORT_VOLUME="jarvis-jv006-transport-$SUFFIX"
ATTEMPT_CAPABILITY="jv006-synthetic-attempt-$SUFFIX"
SERVER_PASSWORD="jv006-synthetic-server-$SUFFIX"
created_volumes=()

docker --context "$CONTEXT" info --format '{{.OSType}}/{{.Architecture}}' | grep -Fx 'linux/aarch64' >/dev/null || {
  echo "Expected the dedicated colima-jarvis ARM64 Engine" >&2
  exit 1
}
docker --context "$CONTEXT" image inspect "$OPENCODE_IMAGE" >/dev/null || {
  echo "Build the pinned OpenCode prototype images first" >&2
  exit 1
}
docker --context "$CONTEXT" image inspect "$GATEWAY_IMAGE" >/dev/null || {
  echo "Build the pinned OpenCode prototype images first" >&2
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT
  if ((status != 0)); then
    for container in "$SANDBOX" "$GATEWAY"; do
      if docker --context "$CONTEXT" inspect "$container" >/dev/null 2>&1; then
        echo "--- sanitized prototype logs: $container ---" >&2
        docker --context "$CONTEXT" logs --tail 60 "$container" >&2 || true
      fi
    done
  fi
  docker --context "$CONTEXT" rm -f "$SANDBOX" "$GATEWAY" >/dev/null 2>&1 || true
  if ((${#created_volumes[@]})); then
    docker --context "$CONTEXT" volume rm "${created_volumes[@]}" >/dev/null 2>&1 || true
  fi
  if ((status != 0)); then
    echo "JV-006 Colima prototype failed; only this run's containers and named volumes were targeted for cleanup." >&2
  fi
  exit "$status"
}
trap cleanup EXIT

for volume in "$WORK_VOLUME" "$STATE_VOLUME" "$CONFIG_VOLUME" "$TRANSPORT_VOLUME"; do
  docker --context "$CONTEXT" volume create "$volume" >/dev/null
  created_volumes+=("$volume")
done

CONFIG_JSON='{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "build",
  "update": "disable",
  "model": "jarvis-fixture/fixture-model",
  "permissions": [
    { "action": "*", "resource": "*", "effect": "deny" },
    { "action": "read", "resource": "*", "effect": "allow" },
    { "action": "glob", "resource": "*", "effect": "allow" },
    { "action": "grep", "resource": "*", "effect": "allow" }
  ],
  "providers": {
    "jarvis-fixture": {
      "name": "JARVIS synthetic fixture",
      "env": ["LLM_GATEWAY_ATTEMPT_CAPABILITY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:4010/v1", "encoding": "none" },
      "models": {
        "fixture-model": {
          "name": "Synthetic fixture model",
          "limit": { "context": 8192, "output": 256 }
        }
      }
    }
  }
}'

docker --context "$CONTEXT" run --rm --network none --platform linux/arm64 --user 0 \
  --mount "type=volume,source=$WORK_VOLUME,target=/workspace" \
  --mount "type=volume,source=$STATE_VOLUME,target=/state" \
  --mount "type=volume,source=$CONFIG_VOLUME,target=/config" \
  --mount "type=volume,source=$TRANSPORT_VOLUME,target=/transport" \
  --env "CONFIG_JSON=$CONFIG_JSON" \
  --entrypoint node "$OPENCODE_IMAGE" -e '
    const fs = require("node:fs");
    fs.mkdirSync("/workspace", { recursive: true });
    fs.mkdirSync("/state/home", { recursive: true });
    for (const path of ["data", "cache", "state"]) fs.mkdirSync(`/state/${path}`, { recursive: true });
    fs.mkdirSync("/config/opencode", { recursive: true });
    fs.mkdirSync("/transport", { recursive: true });
    fs.writeFileSync("/workspace/fixture.txt", "synthetic fixed snapshot: review-only fixture\n", { mode: 0o444 });
    fs.writeFileSync("/config/opencode/opencode.json", process.env.CONFIG_JSON, { mode: 0o444 });
    fs.chownSync("/workspace", 0, 0);
    fs.chownSync("/workspace/fixture.txt", 0, 0);
    fs.chownSync("/config", 0, 0);
    fs.chownSync("/config/opencode", 0, 0);
    fs.chownSync("/config/opencode/opencode.json", 0, 0);
    fs.chownSync("/transport", 10001, 10001);
    fs.chmodSync("/transport", 0o700);
    for (const path of ["/state", "/state/home", "/state/data", "/state/cache", "/state/state"]) {
      fs.chownSync(path, 10001, 10001);
    }
  ' >/dev/null

docker --context "$CONTEXT" run --rm --network none --platform linux/arm64 --user 0 \
  --entrypoint sh "$OPENCODE_IMAGE" -c 'id; test -x /usr/local/bin/opencode' >/dev/null

docker --context "$CONTEXT" create --name "$GATEWAY" --platform linux/arm64 --network none \
  --read-only --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 64 --memory 128m --cpus 0.5 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001 \
  --mount "type=volume,source=$TRANSPORT_VOLUME,target=/run/jarvis-llm" \
  --env "LLM_GATEWAY_SOCKET=/run/jarvis-llm/gateway.sock" \
  --env "LLM_GATEWAY_ATTEMPT_CAPABILITY=$ATTEMPT_CAPABILITY" \
  "$GATEWAY_IMAGE" >/dev/null

docker --context "$CONTEXT" create --name "$SANDBOX" --platform linux/arm64 --network none \
  --read-only --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 128 --memory 2g --cpus 1 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001 \
  --mount "type=volume,source=$WORK_VOLUME,target=/workspace,readonly" \
  --mount "type=volume,source=$STATE_VOLUME,target=/state" \
  --mount "type=volume,source=$CONFIG_VOLUME,target=/config,readonly" \
  --mount "type=volume,source=$TRANSPORT_VOLUME,target=/run/jarvis-llm,readonly" \
  --env "OPENCODE_SERVER_PASSWORD=$SERVER_PASSWORD" \
  --env "LLM_GATEWAY_SOCKET=/run/jarvis-llm/gateway.sock" \
  --env "LLM_GATEWAY_ATTEMPT_CAPABILITY=$ATTEMPT_CAPABILITY" \
  --env "LLM_GATEWAY_BRIDGE_PORT=4010" \
  "$OPENCODE_IMAGE" >/dev/null

docker --context "$CONTEXT" start "$GATEWAY" >/dev/null
docker --context "$CONTEXT" start "$SANDBOX" >/dev/null

inspect="$(docker --context "$CONTEXT" inspect "$SANDBOX" --format '{{.HostConfig.NetworkMode}} {{.Config.User}} {{json .HostConfig.CapDrop}} {{json .HostConfig.PortBindings}} {{json .Mounts}}')"
[[ "$inspect" == *'none 10001:10001 ["ALL"] {}'* ]] || {
  echo "Sandbox inspection did not match expected isolation: $inspect" >&2
  exit 1
}
if [[ "$inspect" == *'"Type":"bind"'* || "$inspect" == *'docker.sock'* ]]; then
  echo "Sandbox unexpectedly has a host bind or Docker socket" >&2
  exit 1
fi

ready=false
for _ in $(seq 1 40); do
  if "$SCRIPT_DIR/exec-relay.sh" "$SANDBOX" health >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.5
done
[[ "$ready" == true ]] || { echo "OpenCode loopback server did not become healthy" >&2; exit 1; }

docker --context "$CONTEXT" exec "$SANDBOX" node -e '
  const fs = require("node:fs");
  try {
    fs.writeFileSync("/workspace/permission-probe.txt", "must not be written");
    process.exit(2);
  } catch (error) {
    if (!new Set(["EROFS", "EACCES", "EPERM"]).has(error.code)) throw error;
  }
  try {
    fs.writeFileSync("/config/permission-probe.json", "must not be written");
    process.exit(3);
  } catch (error) {
    if (!new Set(["EROFS", "EACCES", "EPERM"]).has(error.code)) throw error;
  }
' >/dev/null

"$SCRIPT_DIR/exec-relay.sh" "$SANDBOX" probe
gateway_logs="$(docker --context "$CONTEXT" logs "$GATEWAY" 2>&1)"
grep -Fx 'JV006_FIXTURE_PROVIDER_REQUEST_STARTED' <<<"$gateway_logs" >/dev/null
grep -Fx 'JV006_FIXTURE_PROVIDER_REQUEST_ABORTED' <<<"$gateway_logs" >/dev/null
grep -Fx 'JV006_FIXTURE_PERMISSION_PROBE' <<<"$gateway_logs" >/dev/null
printf 'Colima ARM64 prototype passed with OpenCode v2.0.32, network_mode=none, read-only synthetic snapshot, and no provider/GitHub secret.\n'
