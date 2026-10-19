#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE="jarvis/sandbox-manager:local"

command -v docker >/dev/null || { echo "docker CLI is required" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required" >&2; exit 1; }

engine="$(docker --context colima-jarvis info --format '{{.OSType}}/{{.Architecture}}')"
[[ "$engine" == "linux/aarch64" ]] || {
  echo "Expected the dedicated colima-jarvis ARM64 Engine; found $engine" >&2
  exit 1
}

pnpm --dir "$REPO_ROOT" --filter @jarvis/sandbox-manager build
docker --context colima-jarvis build \
  --pull \
  --platform linux/arm64 \
  --file "$SCRIPT_DIR/Dockerfile" \
  --tag "$IMAGE" \
  "$REPO_ROOT"

printf 'Built %s for linux/arm64 in the dedicated colima-jarvis Engine. The image was not started.\n' "$IMAGE"
