#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/versions.env"
PROFILE=jarvis
REQUIRE_UI=false

[[ "${1:-}" == "--profile" && "${2:-}" == "$PROFILE" ]] || {
  printf 'usage: %s --profile jarvis [--require-ui]\n' "$0" >&2
  exit 2
}
if [[ "${3:-}" == "--require-ui" && $# == 3 ]]; then
  REQUIRE_UI=true
elif [[ $# != 2 ]]; then
  printf 'usage: %s --profile jarvis [--require-ui]\n' "$0" >&2
  exit 2
fi
"$SCRIPT_DIR/bootstrap.sh" --check-host

profile_config="${COLIMA_HOME:-$HOME/.colima}/$PROFILE/colima.yaml"
grep -Eq '^mounts:[[:space:]]*null[[:space:]]*$' "$profile_config" || {
  printf 'jarvis-colima: profile config must set mounts: null\n' >&2
  exit 1
}
grep -Eq '^forwardAgent:[[:space:]]*false[[:space:]]*$' "$profile_config" || {
  printf 'jarvis-colima: profile config must disable SSH-agent forwarding\n' >&2
  exit 1
}
grep -Eq '^autoActivate:[[:space:]]*false[[:space:]]*$' "$profile_config" || {
  printf 'jarvis-colima: profile config must not activate a global Docker context\n' >&2
  exit 1
}

status="$(colima status --profile "$PROFILE" --json)"
python3 -c 'import json,sys; s=json.load(sys.stdin); assert s["arch"] == "aarch64" and s["runtime"] == "docker" and s["cpu"] == 4 and s["memory"] == 8*1024**3 and s["disk"] == 80*1024**3' <<<"$status" || {
  printf 'jarvis-colima: profile state/resources differ from the selected baseline\n' >&2
  exit 1
}

context_endpoint="$(docker context inspect colima-jarvis --format '{{.Endpoints.docker.Host}}')"
expected_socket="unix://${COLIMA_HOME:-$HOME/.colima}/jarvis/docker.sock"
[[ "$context_endpoint" == "$expected_socket" ]] || {
  printf 'jarvis-colima: Docker context does not target the dedicated profile socket\n' >&2
  exit 1
}

[[ "$(docker --context colima-jarvis version --format '{{.Client.Version}}')" == "$DOCKER_CLI_VERSION" ]] || {
  printf 'jarvis-colima: Docker CLI version mismatch\n' >&2
  exit 1
}
[[ "$(docker --context colima-jarvis version --format '{{.Server.Version}}')" == "$DOCKER_ENGINE_VERSION" ]] || {
  printf 'jarvis-colima: Docker Engine version mismatch\n' >&2
  exit 1
}
[[ "$(docker --context colima-jarvis info --format '{{.OSType}}/{{.Architecture}}')" == linux/aarch64 ]] || {
  printf 'jarvis-colima: Docker Engine is not Linux ARM64\n' >&2
  exit 1
}
compose_actual="$(colima ssh --profile "$PROFILE" -- docker compose version | sed -nE 's/^Docker Compose version v?([0-9.]+)$/\1/p')"
[[ "$compose_actual" == "$COMPOSE_VERSION" ]] || {
  printf 'jarvis-colima: Docker Compose version mismatch\n' >&2
  exit 1
}
for package in docker-ce docker-ce-cli containerd.io; do
  case "$package" in
    docker-ce) expected="$DOCKER_ENGINE_PACKAGE_VERSION" ;;
    docker-ce-cli) expected="$DOCKER_CLI_PACKAGE_VERSION" ;;
    containerd.io) expected="$CONTAINERD_PACKAGE_VERSION" ;;
  esac
  actual="$(colima ssh --profile "$PROFILE" -- dpkg-query -W -f='${Version}' "$package")"
  [[ "$actual" == "$expected" ]] || {
    printf 'jarvis-colima: %s version mismatch (expected %s, found %s)\n' "$package" "$expected" "$actual" >&2
    exit 1
  }
done

shared_mounts="$(colima ssh --profile "$PROFILE" -- sh -c 'findmnt -rn -t virtiofs,9p,fuse.sshfs,sshfs; rc=$?; [ "$rc" -le 1 ]')"
[[ -z "$shared_mounts" ]] || {
  printf 'jarvis-colima: unexpected host-share mounts found in the VM\n%s\n' "$shared_mounts" >&2
  exit 1
}
colima ssh --profile "$PROFILE" -- sh -c 'test -z "${SSH_AUTH_SOCK:-}"' || {
  printf 'jarvis-colima: SSH agent is visible inside the VM\n' >&2
  exit 1
}

canary="$(mktemp "$HOME/.jarvis-host-canary.XXXXXXXX")"
trap 'rm -f "$canary"' EXIT
canary_result="$(colima ssh --profile "$PROFILE" -- sh -c 'if test -r "$1"; then printf readable; else printf unreadable; fi' sh "$canary")"
if [[ "$canary_result" != unreadable ]]; then
  printf 'jarvis-colima: host canary is readable from the VM\n' >&2
  exit 1
fi

# No container may publish a non-loopback host listener. A missing UI is
# reported separately; this check does not claim application authentication.
container_ids="$(docker --context colima-jarvis ps --quiet)"
if [[ -n "$container_ids" ]]; then
  ids=()
  while IFS= read -r id; do ids+=("$id"); done <<<"$container_ids"
  inspect="$(docker --context colima-jarvis inspect "${ids[@]}")"
  python3 -c 'import json,sys
containers=json.load(sys.stdin)
for container in containers:
    bindings=container.get("HostConfig",{}).get("PortBindings") or {}
    for port,mappings in bindings.items():
        for binding in mappings or []:
            if binding.get("HostIp") != "127.0.0.1":
                raise SystemExit(f"non-loopback host binding: {port} -> {binding}")' <<<"$inspect" || {
    printf 'jarvis-colima: a container publishes a non-loopback listener\n' >&2
    exit 1
  }
fi
if [[ "$REQUIRE_UI" == true ]]; then
  "$SCRIPT_DIR/verify-listener.sh" --profile "$PROFILE"
elif [[ -z "$container_ids" ]]; then
  printf 'jarvis-colima: no application containers deployed; UI and authentication remain unverified\n' >&2
fi

printf 'jarvis-colima: profile, pinned runtime, ARM64 engine, no-share, SSH-agent, and host-canary checks passed.\n'
