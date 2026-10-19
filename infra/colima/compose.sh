#!/usr/bin/env bash
set -euo pipefail

[[ $# -ge 1 ]] || {
  printf 'usage: %s <up|ps|logs|down> [Compose arguments...]\n' "$0" >&2
  exit 2
}
case "$1" in
  up|ps|logs|down) command="$1"; shift ;;
  *) printf 'jarvis-colima: unsupported Compose command: %s\n' "$1" >&2; exit 2 ;;
esac

colima status --profile jarvis >/dev/null
colima ssh --profile jarvis -- sudo docker compose -f /etc/jarvis/compose.yaml "$command" "$@"
