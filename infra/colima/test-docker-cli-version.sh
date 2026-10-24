#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/versions.env"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/docker-cli-version.sh"

for version in 29.9.1 29.9.2 29.0.0 29.123.456; do
  docker_cli_version_is_compatible "$version" || {
    printf 'expected Docker CLI version to be accepted: %s\n' "$version" >&2
    exit 1
  }
done

for version in '' unknown 28.9.1 30.0.0 29.9 29.9.1.2 v29.9.1 29.x.1; do
  if docker_cli_version_is_compatible "$version"; then
    printf 'expected Docker CLI version to be rejected: %s\n' "${version:-<empty>}" >&2
    exit 1
  fi
done

for caller in bootstrap.sh verify.sh; do
  grep -Fq 'source "$SCRIPT_DIR/docker-cli-version.sh"' "$SCRIPT_DIR/$caller" &&
    grep -Fq 'docker_cli_version_is_compatible' "$SCRIPT_DIR/$caller" || {
    printf 'Docker CLI compatibility helper not sourced and used by %s\n' "$caller" >&2
    exit 1
  }
done

[[ "$DOCKER_CLI_VERSION" == 29.9.1 && "$DOCKER_CLI_COMPATIBLE_MAJOR" == 29 ]] || {
  printf 'selected Docker CLI baseline and compatible major must remain distinct\n' >&2
  exit 1
}
printf 'Docker CLI version compatibility tests passed.\n'
