#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/versions.env"

[[ "${1:-}" == "--profile" && "${2:-}" == "jarvis" && $# == 2 ]] || {
  printf 'usage: %s --profile jarvis\n' "$0" >&2
  exit 2
}

colima status --profile jarvis >/dev/null || {
  printf 'jarvis-colima: the jarvis Colima profile must be running\n' >&2
  exit 1
}
[[ "$(colima ssh --profile jarvis -- dpkg --print-architecture)" == arm64 ]] || {
  printf 'jarvis-colima: guest package architecture must be arm64\n' >&2
  exit 1
}
[[ "$(colima ssh --profile jarvis -- sh -c '. /etc/os-release; printf %s "$VERSION_CODENAME"')" == noble ]] || {
  printf 'jarvis-colima: pinned Docker packages require Ubuntu Noble\n' >&2
  exit 1
}

# Colima installs its runtime during first start. Replace that moving apt
# candidate with the reviewed exact ARM64 package versions before workloads run.
colima ssh --profile jarvis -- sudo apt-get update
colima ssh --profile jarvis -- sudo apt-get install -y --allow-downgrades --allow-change-held-packages \
  "docker-ce=$DOCKER_ENGINE_PACKAGE_VERSION" \
  "docker-ce-cli=$DOCKER_CLI_PACKAGE_VERSION" \
  "containerd.io=$CONTAINERD_PACKAGE_VERSION"
colima ssh --profile jarvis -- sudo apt-mark hold docker-ce docker-ce-cli containerd.io

actual="$(docker --context colima-jarvis version --format '{{.Server.Version}}')"
[[ "$actual" == "$DOCKER_ENGINE_VERSION" ]] || {
  printf 'jarvis-colima: expected Docker Engine %s, found %s\n' "$DOCKER_ENGINE_VERSION" "$actual" >&2
  exit 1
}
