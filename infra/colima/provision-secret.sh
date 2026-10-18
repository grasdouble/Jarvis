#!/usr/bin/env bash
set -euo pipefail

replace=false
if [[ "${1:-}" == "--replace" ]]; then
  replace=true
  shift
fi
name="${1:-}"
[[ "$name" =~ ^[a-z][a-z0-9_-]{0,62}$ ]] || {
  printf 'usage: %s [--replace] <secret-name> < secret-value\n' "$0" >&2
  exit 2
}
[[ ! -t 0 ]] || {
  printf 'jarvis-colima: provide the secret through stdin; interactive input is not accepted\n' >&2
  exit 2
}

# The value travels only over Colima's SSH channel and is never an argv value,
# environment variable, tracked file, or log message.
replace_guard='test ! -e "$destination" || { echo "secret already exists; use --replace explicitly" >&2; exit 1; }'
if [[ "$replace" == true ]]; then
  replace_guard=':'
fi
colima ssh --profile jarvis -- sudo sh -c \
  "set -eu; umask 077; install -d -m 0700 /etc/jarvis/secrets; destination=/etc/jarvis/secrets/${name}; ${replace_guard}; tmp=\$(mktemp /etc/jarvis/secrets/.${name}.XXXXXX); trap 'rm -f \"\$tmp\"' EXIT; cat > \"\$tmp\"; test -s \"\$tmp\"; chmod 0400 \"\$tmp\"; chown root:root \"\$tmp\"; mv -f \"\$tmp\" \"\$destination\"; trap - EXIT"
