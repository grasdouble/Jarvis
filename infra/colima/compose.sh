#!/usr/bin/env bash
set -euo pipefail

compose_profile=""
if [[ "${1:-}" == "--profile" ]]; then
  [[ $# -ge 2 && "$2" == "sandbox-manager" ]] || {
    echo "Only the sandbox-manager Compose profile is supported" >&2
    exit 2
  }
  compose_profile="$2"
  shift 2
fi
[[ $# -ge 1 ]] || {
  printf 'usage: %s [--profile sandbox-manager] <up|ps|logs|down> [Compose arguments...]\n' "$0" >&2
  exit 2
}
case "$1" in
  up|ps|logs|down) command="$1"; shift ;;
  *) printf 'jarvis-colima: unsupported Compose command: %s\n' "$1" >&2; exit 2 ;;
esac
: "${JARVIS_APP_IMAGE:?set JARVIS_APP_IMAGE to a trusted immutable image@sha256:digest reference}"
[[ "$JARVIS_APP_IMAGE" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || {
  echo "jarvis-colima: JARVIS_APP_IMAGE must be an immutable repository@sha256:digest reference" >&2
  exit 2
}

colima status --profile jarvis >/dev/null
socket_gid="$(colima ssh --profile jarvis -- getent group docker | awk -F: '$1 == "docker" {print $3}')"
[[ "$socket_gid" =~ ^[0-9]+$ ]] || {
  echo "Could not resolve the guest docker group for the Engine socket" >&2
  exit 1
}
compose_profile_args=()
[[ -z "$compose_profile" ]] || compose_profile_args+=(--profile "$compose_profile")
colima ssh --profile jarvis -- sudo env "DOCKER_SOCKET_GID=$socket_gid" "JARVIS_APP_IMAGE=$JARVIS_APP_IMAGE" \
  docker compose "${compose_profile_args[@]}" -f /etc/jarvis/compose.yaml -f /etc/jarvis/app.compose.yaml "$command" "$@"
