#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# This file contains trusted, reviewable literal pins only.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/versions.env"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/docker-cli-version.sh"

PROFILE=jarvis
COLIMA_HOME="${COLIMA_HOME:-$HOME/.colima}"
PROFILE_DIR="$COLIMA_HOME/$PROFILE"
MIN_FREE_KIB=$((40 * 1024 * 1024))
MIN_MEMORY_BYTES=$((8 * 1024 * 1024 * 1024))
MIN_CPUS=4

fail() {
  printf 'jarvis-colima: %s\n' "$*" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "required tool not found: $1"
}

check_host() {
  [[ "$(uname -s)" == Darwin ]] || fail "this bootstrap requires macOS"
  [[ "$(uname -m)" == arm64 ]] || fail "this bootstrap requires an ARM64 Mac"
  require_tool sw_vers
  local macos_major
  macos_major="$(sw_vers -productVersion | cut -d. -f1)"
  [[ "$macos_major" =~ ^[0-9]+$ ]] && (( macos_major >= 13 )) || fail "Colima's vz runtime requires macOS 13 or newer"
  require_tool sysctl
  local memory_bytes cpu_count
  memory_bytes="$(sysctl -n hw.memsize)"
  cpu_count="$(sysctl -n hw.ncpu)"
  [[ "$memory_bytes" =~ ^[0-9]+$ ]] || fail "could not determine physical memory"
  [[ "$cpu_count" =~ ^[0-9]+$ ]] || fail "could not determine physical CPU count"
  (( memory_bytes >= MIN_MEMORY_BYTES )) || fail "host needs at least 8 GiB RAM for the selected VM profile"
  (( cpu_count >= MIN_CPUS )) || fail "host needs at least 4 logical CPUs for the selected VM profile"
  local free_kib
  free_kib="$(df -Pk "$HOME" | awk 'NR == 2 {print $4}')"
  [[ "$free_kib" =~ ^[0-9]+$ ]] || fail "could not determine free disk space"
  (( free_kib >= MIN_FREE_KIB )) || fail "host needs at least 40 GiB free disk space"

  require_tool colima
  require_tool limactl
  require_tool docker
  local colima_actual lima_actual docker_actual
  colima_actual="$(colima version | sed -n '1s/^colima version //p')"
  lima_actual="$(limactl --version | awk '{print $3}')"
  docker_actual="$(docker --version | sed -E 's/^Docker version ([^,]+).*/\1/')"
  [[ "$colima_actual" == "$COLIMA_VERSION" ]] || fail "Colima $COLIMA_VERSION required; found ${colima_actual:-unknown}"
  [[ "$lima_actual" == "$LIMA_VERSION" ]] || fail "Lima $LIMA_VERSION required; found ${lima_actual:-unknown}"
  docker_cli_version_is_compatible "$docker_actual" || fail "Docker CLI version must be a valid ${DOCKER_CLI_COMPATIBLE_MAJOR}.x.y release (selected baseline: $DOCKER_CLI_VERSION); found ${docker_actual:-unknown}"
}

case "${1:---check-host}" in
  --check-host)
    check_host
    printf 'Host preflight passed. Colima %s, Lima %s, Docker CLI major %s (selected baseline %s), Engine %s, Compose %s; profile %s uses 4 CPU/8 GiB/80 GiB with a 40 GiB host-free-space floor.\n' \
      "$COLIMA_VERSION" "$LIMA_VERSION" "$DOCKER_CLI_COMPATIBLE_MAJOR" "$DOCKER_CLI_VERSION" "$DOCKER_ENGINE_VERSION" "$COMPOSE_VERSION" "$PROFILE"
    ;;
  --apply)
    check_host
    [[ ! -e "$PROFILE_DIR" ]] || fail "refusing to change existing Colima profile: $PROFILE_DIR"
    install -d -m 0700 "$PROFILE_DIR"
    install -m 0600 "$SCRIPT_DIR/colima.yaml" "$PROFILE_DIR/colima.yaml"
    colima start "$PROFILE" --activate=false
    "$SCRIPT_DIR/pin-engine.sh" --profile "$PROFILE"
    "$SCRIPT_DIR/install-compose.sh" --profile "$PROFILE"
    "$SCRIPT_DIR/verify.sh" --profile "$PROFILE"
    ;;
  *)
    fail "usage: $0 [--check-host|--apply]"
    ;;
esac
