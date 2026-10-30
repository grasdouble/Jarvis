#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
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
: "${JARVIS_APP_IMAGE:?set JARVIS_APP_IMAGE to the local Docker image ID (sha256:<64 lowercase hex>)}"
[[ "$JARVIS_APP_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "jarvis-colima: JARVIS_APP_IMAGE must be a local Docker image ID (sha256:<64 lowercase hex>)" >&2
  exit 2
}

colima status --profile jarvis >/dev/null
socket_gid="$(colima ssh --profile jarvis -- getent group docker | awk -F: '$1 == "docker" {print $3}')"
[[ "$socket_gid" =~ ^[0-9]+$ ]] || {
  echo "Could not resolve the guest docker group for the Engine socket" >&2
  exit 1
}
compose_args=(docker compose)
[[ -z "$compose_profile" ]] || compose_args+=(--profile "$compose_profile")
compose_args+=(-f /etc/jarvis/compose.yaml -f /etc/jarvis/app.compose.yaml)

if [[ "$command" == down ]]; then
  colima ssh --profile jarvis -- sudo sh -c 'if systemctl cat jarvis-ui-proxy.service >/dev/null 2>&1; then systemctl disable --now jarvis-ui-proxy.service; fi'
fi

colima ssh --profile jarvis -- sudo env "DOCKER_SOCKET_GID=$socket_gid" "JARVIS_APP_IMAGE=$JARVIS_APP_IMAGE" \
  "${compose_args[@]}" "$command" "$@"

if [[ "$command" == up ]]; then
  colima ssh --profile jarvis -- sudo install -D -m 0755 /dev/stdin /usr/local/sbin/jarvis-ui-proxy \
    < "$SCRIPT_DIR/ui-proxy.py"
  colima ssh --profile jarvis -- sudo install -D -m 0644 /dev/stdin /etc/systemd/system/jarvis-ui-proxy.service \
    < "$SCRIPT_DIR/ui-proxy.service"
  colima ssh --profile jarvis -- sudo systemctl daemon-reload
  colima ssh --profile jarvis -- sudo systemctl enable jarvis-ui-proxy.service
  colima ssh --profile jarvis -- sudo systemctl restart jarvis-ui-proxy.service
fi
