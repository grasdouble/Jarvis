#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home/.colima/jarvis-test"
cp "$SCRIPT_DIR/colima-test.yaml" "$tmp/home/.colima/jarvis-test/colima.yaml"
printf '\n# Colima normalizes its persisted configuration after first start.\ndns: []\n' >>"$tmp/home/.colima/jarvis-test/colima.yaml"
cat >"$tmp/bin/colima" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$COLIMA_LOG"
case "$*" in
  *'list --json')
    [[ "$INVENTORY_FAIL" == 0 ]] || exit 1
    if [[ -n "${INVENTORY_FILE:-}" && -f "$INVENTORY_FILE" ]]; then cat "$INVENTORY_FILE"; else printf '%s\n' '{"name":"default","status":"Running","cpus":2}' '{"name":"jarvis","status":"Running","cpus":2}'; fi
    ;;
  *'status --profile jarvis-test --json') printf '%s\n' '{"arch":"aarch64","runtime":"docker","cpu":4,"memory":8589934592,"disk":85899345920}' ;;
  *'docker compose version') printf 'Docker Compose version v5.6.0\n' ;;
  *'dpkg-query -W'*) printf '%s\n' 'docker-ce=5:29.5.2-1~ubuntu.24.04~noble' 'docker-ce-cli=5:29.5.2-1~ubuntu.24.04~noble' 'containerd.io=2.2.4-1~ubuntu.24.04~noble' ;;
  *'findmnt -rn'*) ;;
  *'test -z'*) ;;
  *'test -r'*) printf unreadable ;;
  *'delete jarvis-test'*) touch "$DELETE_MARKER"; rm -rf "$COLIMA_HOME/jarvis-test" ;;
  *'start jarvis-test'*) touch "$START_MARKER" ;;
esac
MOCK
cat >"$tmp/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
if [[ "$1 $2 $3" == 'context inspect colima-jarvis-test' ]]; then
  [[ "${ALLOW_MISSING_CONTEXT:-0}" == 0 || -e "$START_MARKER" ]] || exit 1
  [[ -e "$DELETE_MARKER" ]] && exit 1
  [[ -e "$WRONG_ENDPOINT_MARKER" ]] && printf '%s\n' "unix://$COLIMA_HOME/jarvis/docker.sock" || printf '%s\n' "$TEST_ENDPOINT"
  exit 0
fi
if [[ "$1 $2" == '--context colima-jarvis-test' ]]; then
  case "$3 $4" in
    'info --format') printf 'linux/aarch64\n' ;;
    'version --format') printf '29.5.2\n' ;;
  esac
  exit 0
fi
exit 1
MOCK
cat >"$tmp/bin/sysctl" <<'MOCK'
#!/usr/bin/env bash
case "$2" in
  hw.ncpu) printf '12\n' ;;
  hw.memsize) printf '17179869184\n' ;;
esac
MOCK
cat >"$tmp/bin/pagesize" <<'MOCK'
#!/usr/bin/env bash
printf '4096\n'
MOCK
cat >"$tmp/bin/vm_stat" <<'MOCK'
#!/usr/bin/env bash
printf 'Pages free: 3000000.\nPages inactive: 0.\nPages purgeable: 0.\n'
MOCK
cat >"$tmp/bin/df" <<'MOCK'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nmock 99999999 0 99999999 0%% /tmp\n'
MOCK
cat >"$tmp/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CURL_LOG"
[[ "$*" == *"$COMPOSE_URL"* ]] || exit 1
output=''
while (($#)); do
  if [[ "$1" == --output ]]; then shift; output="$1"; fi
  shift
done
printf 'mock compose binary\n' >"$output"
MOCK
cat >"$tmp/bin/shasum" <<'MOCK'
#!/usr/bin/env bash
[[ "${1:-}" == -a && "${2:-}" == 256 && $# == 3 ]] || exit 2
source "$TEST_VERSIONS"
[[ -f "$3" ]] || exit 1
printf '%s  %s\n' "$COMPOSE_SHA256" "$3"
MOCK
export TEST_VERSIONS="$SCRIPT_DIR/versions.env"
chmod +x "$tmp/bin/colima" "$tmp/bin/docker" "$tmp/bin/sysctl" "$tmp/bin/pagesize" "$tmp/bin/vm_stat" "$tmp/bin/df" "$tmp/bin/curl" "$tmp/bin/shasum"
export CURL_LOG="$tmp/curl.log" MOCK_DOWNLOAD="$tmp/download"
export INVENTORY_FILE="$tmp/inventory.jsonl" INVENTORY_FAIL=0 ALLOW_MISSING_CONTEXT=0 START_MARKER="$tmp/started"
export HOME="$tmp/home" COLIMA_HOME="$tmp/home/.colima" PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log" COLIMA_LOG="$tmp/colima.log" DELETE_MARKER="$tmp/deleted" WRONG_ENDPOINT_MARKER="$tmp/wrong-endpoint"
export TEST_ENDPOINT="unix://$COLIMA_HOME/jarvis-test/docker.sock"
printf 'mock compose binary\n' >"$MOCK_DOWNLOAD"
export COMPOSE_URL=https://example.invalid/mock-compose
export DOCKER_ENGINE_VERSION=29.5.2 DOCKER_ENGINE_PACKAGE_VERSION='5:29.5.2-1~ubuntu.24.04~noble' DOCKER_CLI_PACKAGE_VERSION='5:29.5.2-1~ubuntu.24.04~noble' CONTAINERD_PACKAGE_VERSION='2.2.4-1~ubuntu.24.04~noble' COMPOSE_VERSION=5.6.0 COMPOSE_SHA256="$(awk -F= '$1 == "COMPOSE_SHA256" {print $2}' "$SCRIPT_DIR/versions.env")"
"$SCRIPT_DIR/test-profile.sh" --verify
printf 'cpu: 8\n' >>"$COLIMA_HOME/jarvis-test/colima.yaml"
if "$SCRIPT_DIR/test-profile.sh" --verify >"$tmp/verify-output" 2>&1; then
  echo 'duplicate conflicting CPU setting was accepted' >&2; exit 1
fi
cp "$SCRIPT_DIR/colima-test.yaml" "$COLIMA_HOME/jarvis-test/colima.yaml"
awk '!/^arch:/' "$COLIMA_HOME/jarvis-test/colima.yaml" >"$tmp/wrong-scope.yaml"
printf '\nother:\n    arch: aarch64\n' >>"$tmp/wrong-scope.yaml"
cp "$tmp/wrong-scope.yaml" "$COLIMA_HOME/jarvis-test/colima.yaml"
if "$SCRIPT_DIR/test-profile.sh" --verify >"$tmp/verify-output" 2>&1; then
  echo 'wrongly scoped security setting was accepted' >&2; exit 1
fi
cp "$SCRIPT_DIR/colima-test.yaml" "$COLIMA_HOME/jarvis-test/colima.yaml"
run_provision_helper_checks() (
  mkdir -p "$tmp/helper-home/.colima/jarvis" "$tmp/helper-home/.colima/jarvis-test" "$tmp/helper-bin"
  export HOME="$tmp/helper-home" COLIMA_HOME="$tmp/helper-home/.colima" HELPER_COLIMA_LOG="$tmp/helper-colima.log" HELPER_DOCKER_LOG="$tmp/helper-docker.log"
  export HELPER_ENDPOINT="unix://$COLIMA_HOME/jarvis-test/docker.sock" COMPOSE_URL=https://example.invalid/mock-compose
  export PATH="$tmp/helper-bin:$PATH"
  cat >"$tmp/helper-bin/colima" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HELPER_COLIMA_LOG"
case "$*" in
  *'dpkg --print-architecture') printf arm64 ;;
  *VERSION_CODENAME*) printf noble ;;
  *'docker compose version') printf 'Docker Compose version v5.6.0\n' ;;
esac
MOCK
  cat >"$tmp/helper-bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HELPER_DOCKER_LOG"
if [[ "$1 $2 $3" == 'context inspect colima-jarvis-test' || "$1 $2 $3" == 'context inspect colima-jarvis' ]]; then
  [[ "${BAD_HELPER_ENDPOINT:-0}" == 0 ]] && printf '%s\n' "$HELPER_ENDPOINT"
  exit 0
fi
if [[ "$1 $2" == '--context colima-jarvis-test' || "$1 $2" == '--context colima-jarvis' ]]; then printf '29.5.2\n'; exit 0; fi
exit 1
MOCK
  cat >"$tmp/helper-bin/curl" <<'MOCK'
#!/usr/bin/env bash
output=''
while (($#)); do
  if [[ "$1" == --output ]]; then shift; output="$1"; fi
  shift
done
printf 'local mock payload\n' >"$output"
MOCK
  printf 'local mock payload\n' >"$tmp/helper-download"
  export COMPOSE_SHA256="$(awk -F= '$1 == "COMPOSE_SHA256" {print $2}' "$SCRIPT_DIR/versions.env")"
  chmod +x "$tmp/helper-bin/colima" "$tmp/helper-bin/docker" "$tmp/helper-bin/curl"
  : >"$HELPER_COLIMA_LOG"; : >"$HELPER_DOCKER_LOG"
  "$SCRIPT_DIR/pin-engine.sh" --profile jarvis-test
  "$SCRIPT_DIR/install-compose.sh" --profile jarvis-test
  grep -Fq 'apt-get install -y --allow-downgrades --allow-change-held-packages docker-ce=5:29.5.2-1~ubuntu.24.04~noble' "$HELPER_COLIMA_LOG" || { echo 'test profile did not install pinned packages' >&2; exit 1; }
  grep -Fq "cat > '/etc/jarvis-test/compose.yaml' && chmod 0640 '/etc/jarvis-test/compose.yaml'" "$HELPER_COLIMA_LOG" || { echo 'test Compose target was not profile-specific' >&2; exit 1; }
  grep -Fq 'context inspect colima-jarvis-test --format' "$HELPER_DOCKER_LOG" || { echo 'test helper did not inspect explicit context' >&2; exit 1; }
  for bad_profile in default arbitrary; do
    "$SCRIPT_DIR/pin-engine.sh" --profile "$bad_profile" >/dev/null 2>&1 && { echo "pin helper accepted $bad_profile" >&2; exit 1; }
    "$SCRIPT_DIR/install-compose.sh" --profile "$bad_profile" >/dev/null 2>&1 && { echo "Compose helper accepted $bad_profile" >&2; exit 1; }
  done
  export BAD_HELPER_ENDPOINT=1
  "$SCRIPT_DIR/pin-engine.sh" --profile jarvis-test >/dev/null 2>&1 && { echo 'pin helper accepted context/socket mismatch' >&2; exit 1; }
  unset BAD_HELPER_ENDPOINT
  export HELPER_ENDPOINT="unix://$COLIMA_HOME/jarvis/docker.sock"
  "$SCRIPT_DIR/pin-engine.sh" --profile jarvis
  "$SCRIPT_DIR/install-compose.sh" --profile jarvis
  grep -Fq "cat > '/etc/jarvis/compose.yaml' && chmod 0640 '/etc/jarvis/compose.yaml'" "$HELPER_COLIMA_LOG" || { echo 'jarvis Compose mapping changed' >&2; exit 1; }
)
run_provision_helper_checks
export INVENTORY_FAIL=1
: >"$COLIMA_LOG"
if "$SCRIPT_DIR/test-profile.sh" --apply >"$tmp/apply-output" 2>&1; then
  echo 'apply accepted an existing test profile' >&2; exit 1
fi
grep -Fq 'refusing to modify existing or dangling-symlink test profile' "$tmp/apply-output" || { cat "$tmp/apply-output" >&2; exit 1; }
if grep -Fq 'list --json' "$COLIMA_LOG"; then
  echo 'apply enumerated capacity before refusing the existing test profile' >&2; exit 1
fi
export INVENTORY_FAIL=0
touch "$WRONG_ENDPOINT_MARKER"
if "$SCRIPT_DIR/test-profile.sh" --verify >/dev/null 2>&1; then
  echo 'wrong-profile context was accepted' >&2; cat "$DOCKER_LOG" >&2; exit 1
fi
rm -f "$WRONG_ENDPOINT_MARKER"
if "$SCRIPT_DIR/test-profile.sh" --profile jarvis --cleanup >/dev/null 2>&1; then
  echo 'caller-selected profile was accepted' >&2; exit 1
fi
if "$SCRIPT_DIR/test-profile.sh" --run >"$tmp/run-output" 2>&1; then
  echo 'test run without source SHA was accepted' >&2; exit 1
fi
grep -Fxq 'jarvis-test: usage: test-profile.sh --run <exact-40-character-source-sha>' "$tmp/run-output" || { cat "$tmp/run-output" >&2; exit 1; }
mkdir -p "$tmp/git-bin"
cat >"$tmp/git-bin/git" <<'MOCK'
#!/usr/bin/env bash
case "$*" in
  *'status --porcelain'*) printf '%s\n' "$GIT_STATUS" ;;
  *'rev-parse HEAD'*) printf '%s\n' '0000000000000000000000000000000000000001' ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$tmp/git-bin/git"
PATH="$tmp/git-bin:$PATH" GIT_STATUS='?? untracked-source.txt' \
  "$SCRIPT_DIR/test-profile.sh" --run "$(printf '0%.0s' {1..39})1" >"$tmp/run-output" 2>&1 && {
    echo 'test run accepted an untracked working-tree file' >&2; exit 1;
  }
grep -Fq 'source worktree has tracked or untracked changes' "$tmp/run-output" || { cat "$tmp/run-output" >&2; exit 1; }
if grep -Fq 'buildx build' "$DOCKER_LOG"; then
  echo 'dirty source reached Docker buildx' >&2; exit 1
fi
PATH="$tmp/git-bin:$PATH" GIT_STATUS='' \
  "$SCRIPT_DIR/test-profile.sh" --run "$(printf '0%.0s' {1..39})1" >"$tmp/run-output" 2>&1 && {
    echo 'test run accepted a missing product Dockerfile' >&2; exit 1;
  }
grep -Fq "product Dockerfile is missing" "$tmp/run-output" || { cat "$tmp/run-output" >&2; exit 1; }
if grep -Fq 'buildx build' "$DOCKER_LOG"; then
  echo 'missing product Dockerfile reached Docker buildx' >&2; exit 1
fi
rm -f "$DELETE_MARKER"
: >"$DOCKER_LOG"
: >"$COLIMA_LOG"
"$SCRIPT_DIR/test-profile.sh" --cleanup
grep -Fq -- 'docker compose -p jarvis-test -f /etc/jarvis-test/compose.yaml down --volumes --remove-orphans' "$COLIMA_LOG" || { echo 'cleanup did not scope Compose removal to the test project and VM manifest' >&2; exit 1; }
if grep -Fq -- '--context colima-jarvis-test compose' "$DOCKER_LOG"; then
  echo 'cleanup used Docker Compose outside the test VM' >&2; exit 1
fi
grep -Fq 'ssh --profile jarvis-test' "$COLIMA_LOG" || { echo 'cleanup did not address the test VM' >&2; exit 1; }
grep -Fq 'stop jarvis-test' "$COLIMA_LOG" || { echo 'cleanup did not stop only the test profile' >&2; exit 1; }
grep -Fq 'delete jarvis-test --force' "$COLIMA_LOG" || { echo 'cleanup did not delete only the test profile' >&2; exit 1; }
if grep -E 'jarvis([[:space:]]|$)|default' "$COLIMA_LOG" "$DOCKER_LOG"; then
  echo 'cleanup crossed the test-profile boundary' >&2; exit 1
fi
rm -f "$DELETE_MARKER" "$START_MARKER"
rm -rf "$COLIMA_HOME/jarvis-test"
export ALLOW_MISSING_CONTEXT=1 INVENTORY_FAIL=1
: >"$COLIMA_LOG"
if "$SCRIPT_DIR/test-profile.sh" --apply >"$tmp/apply-output" 2>&1; then
  echo 'apply continued after Colima inventory command failure' >&2; exit 1
fi
grep -Fq 'cannot enumerate Colima profiles for CPU capacity preflight' "$tmp/apply-output" || { cat "$tmp/apply-output" >&2; echo 'apply rejected the missing test context before reaching the capacity preflight' >&2; exit 1; }
[[ ! -e "$START_MARKER" && ! -e "$COLIMA_HOME/jarvis-test" ]] || { echo 'inventory command failure performed destructive provisioning' >&2; exit 1; }
if grep -E 'start jarvis-test|delete ' "$COLIMA_LOG"; then
  echo 'inventory command failure invoked a Colima mutation' >&2; exit 1
fi
export INVENTORY_FAIL=0
printf '%s\n' '{"name":"default","status":"Running","cpus":4}' '{"name":"jarvis","status":"Running","cpus":4}' '{"name":"third-profile","status":"Running","cpus":1}' >"$INVENTORY_FILE"
: >"$COLIMA_LOG"
if "$SCRIPT_DIR/test-profile.sh" --apply >/dev/null 2>&1; then
  echo 'apply ignored CPU allocation from a third running Colima profile' >&2; exit 1
fi
[[ ! -e "$START_MARKER" && ! -e "$COLIMA_HOME/jarvis-test" ]] || { echo 'third-profile CPU guard performed destructive provisioning' >&2; exit 1; }
if grep -E 'start jarvis-test|delete ' "$COLIMA_LOG"; then
  echo 'third-profile CPU guard invoked a Colima mutation' >&2; exit 1
fi
printf 'test-profile boundary tests passed.\n'
