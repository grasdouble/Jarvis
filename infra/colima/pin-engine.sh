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

docker context inspect "$context" >/dev/null || {
  printf 'jarvis-colima: required Docker context %s is unavailable\n' "$context" >&2
  exit 1
}
endpoint="$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}')"
[[ "$endpoint" == "unix://$socket" ]] || {
  printf 'jarvis-colima: context %s targets unexpected Engine: %s\n' "$context" "$endpoint" >&2
  exit 1
}

colima status --profile "$profile" >/dev/null || {
  printf '%s-colima: the %s Colima profile must be running\n' "$profile" "$profile" >&2
  exit 1
}
[[ "$(colima ssh --profile "$profile" -- dpkg --print-architecture)" == arm64 ]] || {
  printf '%s-colima: guest package architecture must be arm64\n' "$profile" >&2
  exit 1
}
[[ "$(colima ssh --profile "$profile" -- sh -c '. /etc/os-release; printf %s "$VERSION_CODENAME"')" == noble ]] || {
  printf '%s-colima: pinned Docker packages require Ubuntu Noble\n' "$profile" >&2
  exit 1
}

# Colima installs its runtime during first start. Replace that moving apt
# candidate with the reviewed exact ARM64 package versions before workloads run.
colima ssh --profile "$profile" -- sudo apt-get update
colima ssh --profile "$profile" -- sudo apt-get install -y --allow-downgrades --allow-change-held-packages \
  "docker-ce=$DOCKER_ENGINE_PACKAGE_VERSION" \
  "docker-ce-cli=$DOCKER_CLI_PACKAGE_VERSION" \
  "containerd.io=$CONTAINERD_PACKAGE_VERSION"
colima ssh --profile "$profile" -- sudo apt-mark hold docker-ce docker-ce-cli containerd.io

actual="$(docker --context "$context" version --format '{{.Server.Version}}')"
[[ "$actual" == "$DOCKER_ENGINE_VERSION" ]] || {
  printf '%s-colima: expected Docker Engine %s, found %s\n' "$profile" "$DOCKER_ENGINE_VERSION" "$actual" >&2
  exit 1
}
