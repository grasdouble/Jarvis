#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE="jarvis/opencode-prototype:2.0.32"
GATEWAY_IMAGE="jarvis/llm-gateway-fixture:2.0.32"

command -v docker >/dev/null || { echo "docker CLI is required" >&2; exit 1; }
engine="$(docker --context colima-jarvis info --format '{{.OSType}}/{{.Architecture}}')"
[[ "$engine" == "linux/aarch64" ]] || {
  echo "Expected the dedicated colima-jarvis ARM64 Engine; found $engine" >&2
  exit 1
}

pnpm --dir "$REPO_ROOT" --filter @jarvis/llm build
pnpm --dir "$REPO_ROOT" --filter @jarvis/llm-gateway build
pnpm --dir "$REPO_ROOT" --filter @jarvis/runtime build

docker --context colima-jarvis build \
  --pull \
  --platform linux/arm64 \
  --file "$SCRIPT_DIR/Dockerfile" \
  --tag "$IMAGE" \
  "$REPO_ROOT"

docker --context colima-jarvis build \
  --pull \
  --platform linux/arm64 \
  --file "$SCRIPT_DIR/Dockerfile.gateway" \
  --tag "$GATEWAY_IMAGE" \
  "$REPO_ROOT"

docker --context colima-jarvis run --rm --network none \
  --platform linux/arm64 \
  --tmpfs /state:rw,nosuid,nodev,size=64m,uid=10001,gid=10001 \
  --tmpfs /config:rw,nosuid,nodev,size=16m,uid=10001,gid=10001 \
  --entrypoint /usr/local/bin/opencode "$IMAGE" --version
