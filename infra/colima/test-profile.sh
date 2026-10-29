#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
PROFILE=jarvis-test
CONTEXT=colima-jarvis-test
PROJECT=jarvis-test
COLIMA_HOME="${COLIMA_HOME:-$HOME/.colima}"
PROFILE_DIR="$COLIMA_HOME/$PROFILE"
fail() { printf 'jarvis-test: %s\n' "$*" >&2; exit 1; }

host_tool_preflight() {
  "$SCRIPT_DIR/bootstrap.sh" --check-host || fail 'supported-host and pinned-tool preflight failed'
}

context_guard() {
  local endpoint expected
  docker context inspect "$CONTEXT" >/dev/null || fail "required Docker context $CONTEXT is unavailable"
  endpoint="$(docker context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}')"
  expected="unix://$PROFILE_DIR/docker.sock"
  [[ "$endpoint" == "$expected" ]] || fail "context $CONTEXT targets unexpected Engine: $endpoint"
}

capacity_preflight() {
  local cpu_total memory_total page_size free_pages inactive_pages purgeable_pages available_bytes
  cpu_total="$(sysctl -n hw.ncpu)"
  memory_total="$(sysctl -n hw.memsize)"
  [[ "$cpu_total" =~ ^[0-9]+$ && "$memory_total" =~ ^[0-9]+$ ]] || fail 'cannot determine host CPU/memory capacity'
  local inventory reserved_cpus
  inventory="$(colima list --json)" || fail 'cannot enumerate Colima profiles for CPU capacity preflight'
  reserved_cpus="$(python3 -c '
import json, sys
records = [line for line in sys.stdin.read().splitlines() if line.strip()]
if not records:
    raise SystemExit("Colima profile inventory is empty")
total = 0
for line in records:
    try:
        record = json.loads(line)
    except json.JSONDecodeError as error:
        raise SystemExit(f"malformed Colima profile inventory record: {error}")
    if not isinstance(record, dict) or not all(key in record for key in ("name", "status", "cpus")):
        raise SystemExit("Colima profile inventory record lacks name, status, or cpus")
    if not isinstance(record["name"], str) or not record["name"] or not isinstance(record["status"], str):
        raise SystemExit("Colima profile inventory record has invalid name or status")
    if record["status"].lower() == "running":
        cpus = record["cpus"]
        if not isinstance(cpus, int) or isinstance(cpus, bool) or cpus < 1:
            name = record["name"]
            raise SystemExit(f"invalid CPU allocation for running profile {name}")
        total += cpus
print(total)
' <<<"$inventory")" || fail 'Colima profile inventory is missing or malformed; refusing capacity estimate'
  (( cpu_total - reserved_cpus >= 4 )) || fail "insufficient unallocated host CPUs for a full 4-CPU test VM (total $cpu_total, existing profile reservations $reserved_cpus); existing profiles will not be stopped or resized"
  page_size="$(pagesize)"
  read -r free_pages inactive_pages purgeable_pages < <(vm_stat | awk -F: '/Pages free/ {gsub(/[. ]/,"",$2); f=$2} /Pages inactive/ {gsub(/[. ]/,"",$2); i=$2} /Pages purgeable/ {gsub(/[. ]/,"",$2); p=$2} END {print f+0, i+0, p+0}')
  available_bytes=$(((free_pages + inactive_pages + purgeable_pages) * page_size))
  (( memory_total >= 8*1024*1024*1024 && available_bytes >= 8*1024*1024*1024 )) || fail "insufficient currently available host memory for a full 8-GiB test VM (available bytes $available_bytes); existing profiles will not be stopped or resized"
  local free_kib
  free_kib="$(df -Pk "$HOME" | awk 'NR == 2 {print $4}')"
  [[ "$free_kib" =~ ^[0-9]+$ ]] && (( free_kib >= 40*1024*1024 )) || fail 'need at least 40 GiB free host disk before provisioning the 80-GiB test VM'
}

ensure_test_profile_absent() {
  [[ ! -e "$PROFILE_DIR" && ! -L "$PROFILE_DIR" ]] || fail "refusing to modify existing or dangling-symlink test profile: $PROFILE_DIR"
  if docker context inspect "$CONTEXT" >/dev/null 2>&1; then
    fail "refusing to replace pre-existing context $CONTEXT"
  fi
}

require_clean_source() {
  local changes
  changes="$(git -C "$REPO_DIR" status --porcelain --untracked-files=all)" || fail 'cannot inspect source worktree cleanliness'
  [[ -z "$changes" ]] || fail 'source worktree has tracked or untracked changes; refusing to build an image labeled with the commit SHA'
}


verify_profile() {
  [[ -f "$PROFILE_DIR/colima.yaml" ]] || fail 'test profile configuration is missing'
  python3 - "$PROFILE_DIR/colima.yaml" <<'PY' || fail 'test profile configuration has missing, conflicting, duplicate, or wrongly scoped security settings'
import re
import sys

expected = {
    ("", "arch"): "aarch64",
    ("", "autoActivate"): "false",
    ("", "cpu"): "4",
    ("", "disk"): "80",
    ("", "forwardAgent"): "false",
    ("", "memory"): "8",
    ("", "mounts"): "null",
    ("", "runtime"): "docker",
    ("", "sshConfig"): "false",
    ("", "vmType"): "vz",
    ("kubernetes", "enabled"): "false",
    ("network", "address"): "false",
    ("network", "mode"): "shared",
}
found = {}
section = None
with open(sys.argv[1], encoding="utf-8") as config:
    for line in config:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"( *)([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?\s*", line.rstrip("\n"))
        if not match:
            continue
        indent, key, value = match.groups()
        path = ("", key) if not indent else (section, key) if len(indent) == 2 else ("<invalid>", key)
        if not indent and value == "":
            section = key
            continue
        if not indent:
            section = None
        if path not in expected:
            continue
        value = re.sub(r"[ \t]+#.*$", "", value or "").strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if path in found or value != expected[path]:
            raise SystemExit(1)
        found[path] = value
if found.keys() != expected.keys():
    raise SystemExit(1)
PY
  local status expected shared_mounts canary canary_result engine compose_version packages
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/versions.env"
  status="$(colima status --profile "$PROFILE" --json)"
  python3 -c 'import json,sys; s=json.load(sys.stdin); assert s["arch"] == "aarch64" and s["runtime"] == "docker" and s["cpu"] == 4 and s["memory"] == 8*1024**3 and s["disk"] == 80*1024**3' <<<"$status" || fail 'test profile is not exact ARM64 Docker 4 CPU/8 GiB/80 GiB'
  context_guard
  docker --context "$CONTEXT" info --format '{{.OSType}}/{{.Architecture}}' | grep -Fxq linux/aarch64 || fail 'test context Engine is not Linux ARM64'
  engine="$(docker --context "$CONTEXT" version --format '{{.Server.Version}}')" || fail 'could not inspect pinned Docker Engine version'
  [[ "$engine" == "$DOCKER_ENGINE_VERSION" ]] || fail "expected Docker Engine $DOCKER_ENGINE_VERSION, found $engine"
  packages="$(colima ssh --profile "$PROFILE" -- dpkg-query -W -f='${Package}=${Version}\n' docker-ce docker-ce-cli containerd.io)" || fail 'could not inspect pinned guest Docker packages'
  for expected in "docker-ce=$DOCKER_ENGINE_PACKAGE_VERSION" "docker-ce-cli=$DOCKER_CLI_PACKAGE_VERSION" "containerd.io=$CONTAINERD_PACKAGE_VERSION"; do
    grep -Fxq "$expected" <<<"$packages" || fail "missing pinned guest package $expected"
  done
  compose_version="$(colima ssh --profile "$PROFILE" -- docker compose version | sed -nE 's/^Docker Compose version v?([0-9.]+)$/\1/p')"
  [[ "$compose_version" == "$COMPOSE_VERSION" ]] || fail "expected Docker Compose $COMPOSE_VERSION, found $compose_version"
  shared_mounts="$(colima ssh --profile "$PROFILE" -- sh -c 'findmnt -rn -t virtiofs,9p,fuse.sshfs,sshfs; rc=$?; [ "$rc" -le 1 ]')" || fail 'could not inspect effective guest host mounts'
  [[ -z "$shared_mounts" ]] || fail "test VM has host-share mounts: $shared_mounts"
  colima ssh --profile "$PROFILE" -- sh -c 'test -z "${SSH_AUTH_SOCK:-}"' || fail 'SSH agent is visible inside the test VM'
  canary="$(mktemp "$HOME/.jarvis-test-host-canary.XXXXXXXX")"
  trap 'rm -f "$canary"' EXIT
  canary_result="$(colima ssh --profile "$PROFILE" -- sh -c 'if test -r "$1"; then printf readable; else printf unreadable; fi' sh "$canary")" || fail 'could not test host-share denial'
  [[ "$canary_result" == unreadable ]] || fail 'test VM can read the host-home canary'
  rm -f "$canary"
  trap - EXIT
}

case "${1:-}" in
  --check-host)
    host_tool_preflight
    capacity_preflight
    printf 'Host preflight passed; test VM capacity is available (4 CPU/8 GiB/80 GiB, with a 40 GiB host-free-space floor).\n'
    ;;
  --apply)
    host_tool_preflight
    ensure_test_profile_absent
    [[ -d "$COLIMA_HOME" && ! -L "$COLIMA_HOME" ]] || fail "Colima home must exist as a real directory: $COLIMA_HOME"
    capacity_preflight
    install -d -m 0700 "$PROFILE_DIR"
    install -m 0600 "$SCRIPT_DIR/colima-test.yaml" "$PROFILE_DIR/colima.yaml"
    colima start "$PROFILE" --activate=false || fail "Colima start failed; leaving $PROFILE_DIR untouched for explicit inspection"
    docker context inspect "$CONTEXT" >/dev/null || fail 'Colima did not create expected dedicated test context'
    "$SCRIPT_DIR/pin-engine.sh" --profile "$PROFILE"
    "$SCRIPT_DIR/install-compose.sh" --profile "$PROFILE"
    verify_profile
    colima ssh --profile "$PROFILE" -- sudo install -d -m 0700 /etc/jarvis-test/secrets
    umask 077
    openssl rand -hex 32 | colima ssh --profile "$PROFILE" -- sudo sh -c 'umask 077; tmp=$(mktemp /etc/jarvis-test/secrets/.password.XXXXXX); trap "rm -f \"$tmp\"" EXIT; cat > "$tmp"; chmod 0400 "$tmp"; chown root:root "$tmp"; mv "$tmp" /etc/jarvis-test/secrets/postgres_password; trap - EXIT'
    cat "$SCRIPT_DIR/compose-test.yaml" | colima ssh --profile "$PROFILE" -- sudo sh -c 'install -d -m 0750 /etc/jarvis-test; cat > /etc/jarvis-test/compose.yaml; chmod 0640 /etc/jarvis-test/compose.yaml'
    ;;
  --db-up)
    verify_profile
    colima ssh --profile "$PROFILE" -- sudo docker compose -p "$PROJECT" -f /etc/jarvis-test/compose.yaml up -d
    ;;
  --db-check)
    verify_profile
    colima ssh --profile "$PROFILE" -- sudo docker compose -p "$PROJECT" -f /etc/jarvis-test/compose.yaml ps --status running
    colima ssh --profile "$PROFILE" -- sudo docker exec "$(docker --context "$CONTEXT" ps -q --filter label=com.docker.compose.project="$PROJECT" --filter label=com.docker.compose.service=postgres)" pg_isready -U postgres -d jarvis_test
    ;;
  --verify)
    verify_profile
    ;;
  --cleanup)
    [[ "$PROFILE" == jarvis-test && "$CONTEXT" == colima-jarvis-test ]] || fail 'internal cleanup identity mismatch'
    context_guard
    verify_profile
    colima ssh --profile "$PROFILE" -- sudo docker compose -p "$PROJECT" -f /etc/jarvis-test/compose.yaml down --volumes --remove-orphans
    colima stop "$PROFILE"
    colima delete "$PROFILE" --force
    docker context inspect "$CONTEXT" >/dev/null 2>&1 && fail 'test context remains after deleting only jarvis-test'
    [[ ! -e "$PROFILE_DIR" ]] || fail 'test profile directory remains; refusing to remove it implicitly'
    ;;
  --run)
    [[ $# == 2 && "$2" =~ ^[0-9a-f]{40}$ ]] || fail 'usage: test-profile.sh --run <exact-40-character-source-sha>'
    verify_profile
    [[ "$(git -C "$REPO_DIR" rev-parse HEAD)" == "$2" ]] || fail 'requested SHA does not match checked-out source revision'
    require_clean_source
    [[ -f "$REPO_DIR/Dockerfile" ]] || fail "product Dockerfile is missing at $REPO_DIR/Dockerfile; cannot build a JARVIS API image"
    image="jarvis-test/api:$2"
    docker --context "$CONTEXT" buildx build --platform linux/arm64 --load --tag "$image" "$REPO_DIR"
    docker --context "$CONTEXT" image inspect "$image" --format '{{.Id}} {{.Os}}/{{.Architecture}}'
    printf 'Built image locally in %s only; no runtime or deployment was executed and no registry push was performed.\n' "$CONTEXT"
    ;;
  *) printf 'usage: %s --check-host|--apply|--verify|--run <exact-source-sha>|--cleanup\n' "$0" >&2; exit 2 ;;
esac
