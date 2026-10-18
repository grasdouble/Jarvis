#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == "--profile" && "${2:-}" == "jarvis" && $# == 2 ]] || {
  printf 'usage: %s --profile jarvis\n' "$0" >&2
  exit 2
}

docker context inspect colima-jarvis >/dev/null
container_ids="$(docker --context colima-jarvis ps --quiet)"
[[ -n "$container_ids" ]] || {
  printf 'jarvis-colima: no UI container is running\n' >&2
  exit 1
}
ids=()
while IFS= read -r id; do ids+=("$id"); done <<<"$container_ids"
inspect="$(docker --context colima-jarvis inspect "${ids[@]}")"
python3 -c 'import json,sys
containers=json.load(sys.stdin)
ui=False
for container in containers:
    bindings=container.get("HostConfig",{}).get("PortBindings") or {}
    for port,mappings in bindings.items():
        for binding in mappings or []:
            if binding.get("HostIp") != "127.0.0.1":
                raise SystemExit(f"non-loopback host binding: {port} -> {binding}")
            if port == "3000/tcp" and binding.get("HostPort") == "3000":
                ui=True
if not ui:
    raise SystemExit("authenticated UI is not published at 127.0.0.1:3000")' <<<"$inspect"

listener="$(lsof -nP -iTCP:3000 -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 {print $9}')"
[[ -n "$listener" ]] || {
  printf 'jarvis-colima: no host listener on TCP 3000\n' >&2
  exit 1
}
while IFS= read -r endpoint; do
  [[ "$endpoint" == 127.0.0.1:3000 ]] || {
    printf 'jarvis-colima: unexpected host listener %s\n' "$endpoint" >&2
    exit 1
  }
done <<<"$listener"

response="$(curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code} %{redirect_url}' http://127.0.0.1:3000/)"
status="${response%% *}"
redirect="${response#* }"
[[ "$status" == 401 || ( "$status" == 302 && "$redirect" == http://127.0.0.1:3000/* ) ]] || {
  printf 'jarvis-colima: unauthenticated UI request was not denied (HTTP %s)\n' "$status" >&2
  exit 1
}
printf 'jarvis-colima: UI is loopback-only and denies unauthenticated requests (HTTP %s).\n' "$status"
