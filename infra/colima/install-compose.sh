#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/versions.env"

[[ "${1:-}" == "--profile" && $# == 2 ]] || {
  printf 'usage: %s --profile {jarvis|jarvis-test}\n' "$0" >&2
  exit 2
}
profile="$2"
case "$profile" in
  jarvis|jarvis-test) ;;
  *) printf 'unsupported Colima profile: %s\n' "$profile" >&2; exit 2 ;;
esac
context="colima-$profile"
socket="${COLIMA_HOME:-$HOME/.colima}/$profile/docker.sock"
case "$profile" in
  jarvis) guest_config=/etc/jarvis/compose.yaml; host_compose="$SCRIPT_DIR/../compose/compose.yaml" ;;
  jarvis-test) guest_config=/etc/jarvis-test/compose.yaml; host_compose="$SCRIPT_DIR/compose-test.yaml" ;;
esac
guest_dir="${guest_config%/*}"

docker context inspect "$context" >/dev/null || {
  printf 'jarvis-colima: required Docker context %s is unavailable\n' "$context" >&2
  exit 1
}
endpoint="$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}')"
[[ "$endpoint" == "unix://$socket" ]] || {
  printf 'jarvis-colima: context %s targets unexpected Engine: %s\n' "$context" "$endpoint" >&2
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
colima ssh --profile "$profile" -- sudo install -d -m 0755 /usr/local/lib/docker/cli-plugins
cat "$binary" | colima ssh --profile "$profile" -- sudo sh -c \
  'cat > /usr/local/lib/docker/cli-plugins/docker-compose && chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose'
colima ssh --profile "$profile" -- sudo install -d -m 0750 "$guest_dir"
cat "$host_compose" | colima ssh --profile "$profile" -- sudo sh -c \
  "cat > '$guest_config' && chmod 0640 '$guest_config'"

actual="$(colima ssh --profile "$profile" -- docker compose version | sed -nE 's/^Docker Compose version v?([0-9.]+)$/\1/p')"
[[ "$actual" == "$COMPOSE_VERSION" ]] || {
  printf '%s-colima: expected Docker Compose %s, found %s\n' "$profile" "$COMPOSE_VERSION" "$actual" >&2
  exit 1
}
