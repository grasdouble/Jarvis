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
  "default_agent": "review",
  "update": "disable",
  "model": "jarvis-fixture/fixture-model",
  "agents": {
    "plan": { "mode": "primary", "permissions": [{ "action": "*", "resource": "*", "effect": "deny" }, { "action": "read", "resource": "*", "effect": "allow" }, { "action": "glob", "resource": "*", "effect": "allow" }, { "action": "grep", "resource": "*", "effect": "allow" }, { "action": "edit", "resource": "*", "effect": "deny" }, { "action": "shell", "resource": "*", "effect": "deny" }] },
    "review": { "mode": "primary", "permissions": [{ "action": "*", "resource": "*", "effect": "deny" }, { "action": "read", "resource": "*", "effect": "allow" }, { "action": "glob", "resource": "*", "effect": "allow" }, { "action": "grep", "resource": "*", "effect": "allow" }, { "action": "edit", "resource": "*", "effect": "deny" }, { "action": "shell", "resource": "*", "effect": "deny" }] }
  },
  "permissions": [
    { "action": "*", "resource": "*", "effect": "deny" },
    { "action": "read", "resource": "*", "effect": "allow" },
    { "action": "glob", "resource": "*", "effect": "allow" },
    { "action": "grep", "resource": "*", "effect": "allow" },
    { "action": "edit", "resource": "*", "effect": "deny" },
    { "action": "shell", "resource": "*", "effect": "deny" }
  ],
  "plugin": ["/opt/jarvis/opencode-usage-plugin"],
  "mcp": {},
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
    fs.writeFileSync("/config/opencode/opencode.json", process.env.CONFIG_JSON, { mode: 0o444 });
    fs.mkdirSync("/transport", { recursive: true });
    fs.writeFileSync("/workspace/fixture.txt", "synthetic fixed snapshot: review-only fixture\n", { mode: 0o444 });
    fs.symlinkSync("/proc/1/environ", "/workspace/broker-environ");
    fs.mkdirSync("/workspace/.opencode/plugins", { recursive: true });
    fs.writeFileSync("/workspace/.opencode/plugins/candidate-project-plugin.mjs",
      "import { writeFileSync } from 'node:fs'; writeFileSync('/state/state/project-plugin-loaded', 'loaded'); export default async () => ({});");
    fs.mkdirSync("/workspace/.opencode/plugins/candidate-project-package", { recursive: true });
    fs.writeFileSync("/workspace/.opencode/plugins/candidate-project-package/package.json",
      JSON.stringify({ name: "candidate-project-plugin", type: "module", exports: "./index.mjs" }));
    fs.writeFileSync("/workspace/.opencode/plugins/candidate-project-package/index.mjs",
      "import { writeFileSync } from 'node:fs'; writeFileSync('/state/state/project-plugin-loaded', 'loaded'); export default async () => ({});");
    fs.writeFileSync("/workspace/.opencode/opencode.json", JSON.stringify({ plugin: ["./plugins/candidate-project-package"] }));
    fs.chownSync("/workspace", 0, 0);
    fs.chownSync("/workspace/fixture.txt", 0, 0);
    fs.chownSync("/config", 0, 0);
    fs.chownSync("/config/opencode", 0, 0);
    fs.chownSync("/config/opencode/opencode.json", 0, 0);
    fs.chownSync("/transport", 10001, 10001);
    fs.chmodSync("/transport", 0o770);
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
  --read-only --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges:true \
  --pids-limit 128 --memory 2g --cpus 1 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001 \
  --mount "type=volume,source=$WORK_VOLUME,target=/workspace,readonly" \
  --mount "type=volume,source=$STATE_VOLUME,target=/state" \
  --mount "type=volume,source=$CONFIG_VOLUME,target=/config,readonly" \
  --mount "type=volume,source=$TRANSPORT_VOLUME,target=/run/jarvis-llm,readonly" \
  --env "OPENCODE_SERVER_PASSWORD=$SERVER_PASSWORD" \
  --env "OPENCODE_CONFIG_PROJECT_DISABLE=true" \
  --env "LLM_GATEWAY_SOCKET=/run/jarvis-llm/gateway.sock" \
  --env "LLM_GATEWAY_ATTEMPT_CAPABILITY=$ATTEMPT_CAPABILITY" \
  --env "LLM_GATEWAY_BRIDGE_PORT=4010" \
  --env "JARVIS_GATEWAY_BRIDGE_DIAGNOSTICS=1" \
  "$OPENCODE_IMAGE" >/dev/null

docker --context "$CONTEXT" start "$GATEWAY" >/dev/null
docker --context "$CONTEXT" start "$SANDBOX" >/dev/null
socket_ready=false
for _ in $(seq 1 20); do
  if docker --context "$CONTEXT" exec "$GATEWAY" node -e '
    const fs = require("node:fs");
    if (!fs.statSync("/run/jarvis-llm/gateway.sock").isSocket()) process.exit(1);
  ' >/dev/null 2>&1; then
    socket_ready=true
    break
  fi
  sleep 0.1
done
[[ "$socket_ready" == true ]] || { echo "Synthetic gateway Unix socket did not become ready" >&2; exit 1; }
docker --context "$CONTEXT" exec --user 10001:10001 "$SANDBOX" node -e '
  const http = require("node:http");
  const request = http.request({ socketPath: "/run/jarvis-llm/gateway.sock", path: "/qualification-probe", method: "POST" }, (response) => {
    response.resume();
    response.on("end", () => process.exit(response.statusCode === 404 ? 0 : 2));
  });
  request.on("error", () => process.exit(3));
  request.end();
' >/dev/null || { echo "OpenCode UID cannot reach only the attempt gateway UDS" >&2; exit 1; }

inspect="$(docker --context "$CONTEXT" inspect "$SANDBOX" --format '{{.HostConfig.NetworkMode}} {{.Config.User}} {{json .HostConfig.CapDrop}} {{json .HostConfig.CapAdd}} {{json .HostConfig.PortBindings}} {{json .Mounts}}')"
[[ "$inspect" == *'none 0:0 ["ALL"]'* && "$inspect" == *'["CAP_KILL","CAP_SETGID","CAP_SETUID"]'* && "$inspect" == *' {} '* ]] || {
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
docker --context "$CONTEXT" exec --user 10001:10001 "$SANDBOX" node --input-type=module -e '
  import { request } from "node:http";
  const body = JSON.stringify({ model: "fixture-model", max_tokens: 16, messages: [{ role: "user", content: "synthetic socket probe" }] });
  const response = await new Promise((resolve, reject) => {
    const req = request({
      socketPath: "/run/jarvis-llm/gateway.sock",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
  if (response.status !== 200) {
    console.error(JSON.stringify(response));
    process.exit(1);
  }
' || { echo "Synthetic gateway UDS dispatch failed" >&2; exit 1; }
docker --context "$CONTEXT" exec --user 10001:10001 "$SANDBOX" env -u LLM_GATEWAY_ATTEMPT_CAPABILITY node -e '
  const fs = require("node:fs");
  if (process.getuid() !== 10001 || process.env.LLM_GATEWAY_ATTEMPT_CAPABILITY !== undefined) process.exit(2);
  for (const path of ["/proc/1/environ", "/workspace/broker-environ"]) {
    try {
      fs.readFileSync(path);
      process.exit(3);
    } catch (error) {
      if (error.code !== "EACCES" && error.code !== "EPERM") throw error;
    }
  }
' >/dev/null || { echo "OpenCode can read the broker capability environment" >&2; exit 1; }
docker --context "$CONTEXT" exec "$SANDBOX" node -e 'require("node:fs").access("/state/state/project-plugin-loaded", (error) => process.exit(error?.code === "ENOENT" ? 0 : 1))' \
  || { echo "Project-controlled OpenCode plugin was loaded despite project discovery being disabled" >&2; exit 1; }

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
docker --context "$CONTEXT" stop --time 10 "$SANDBOX" >/dev/null
shutdown_state="$(docker --context "$CONTEXT" inspect "$SANDBOX" --format '{{.State.Status}} {{.State.ExitCode}}')"
[[ "$shutdown_state" == "exited 0" ]] || {
  echo "Trusted entrypoint did not forward shutdown cleanly to OpenCode: $shutdown_state" >&2
  exit 1
}
printf 'Colima ARM64 prototype passed with OpenCode v2.0.32, network_mode=none, read-only synthetic snapshot, and no provider/GitHub secret.\n'
