#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/versions.env"

[[ "${1:-}" == "--profile" && "${2:-}" == "jarvis" && $# == 2 ]] || {
  printf 'usage: %s --profile jarvis\n' "$0" >&2
  exit 2
}
colima ssh --profile jarvis -- sudo sh -c \
  'test ! -e /etc/jarvis/compose.yaml && test ! -e /etc/jarvis/app.compose.yaml' || {
  echo "jarvis-colima: refusing to overwrite an existing guest Compose manifest" >&2
  exit 1
}

tmp_dir="$(mktemp -d "${TMPDIR:-$HOME}/jarvis-compose.XXXXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT
binary="$tmp_dir/docker-compose"

curl --fail --location --silent --show-error --retry 2 --output "$binary" "$COMPOSE_URL"
actual_sha="$(shasum -a 256 "$binary" | awk '{print $1}')"
[[ "$actual_sha" == "$COMPOSE_SHA256" ]] || {
  printf 'jarvis-colima: Compose checksum mismatch (expected %s, got %s)\n' "$COMPOSE_SHA256" "$actual_sha" >&2
  exit 1
}

# Transfer through Colima's authenticated SSH channel; never use a Mac share.
colima ssh --profile jarvis -- sudo install -d -m 0755 /usr/local/lib/docker/cli-plugins
cat "$binary" | colima ssh --profile jarvis -- sudo sh -c \
  'cat > /usr/local/lib/docker/cli-plugins/docker-compose && chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose'
colima ssh --profile jarvis -- sudo install -d -m 0750 /etc/jarvis
cat "$SCRIPT_DIR/../compose/compose.yaml" | colima ssh --profile jarvis -- sudo sh -c \
  'cat > /etc/jarvis/compose.yaml && chmod 0640 /etc/jarvis/compose.yaml'
cat "$SCRIPT_DIR/../compose/app.compose.yaml" | colima ssh --profile jarvis -- sudo sh -c \
  'cat > /etc/jarvis/app.compose.yaml && chmod 0640 /etc/jarvis/app.compose.yaml'

actual="$(colima ssh --profile jarvis -- docker compose version | sed -nE 's/^Docker Compose version v?([0-9.]+)$/\1/p')"
[[ "$actual" == "$COMPOSE_VERSION" ]] || {
  printf 'jarvis-colima: expected Docker Compose %s, found %s\n' "$COMPOSE_VERSION" "$actual" >&2
  exit 1
}
