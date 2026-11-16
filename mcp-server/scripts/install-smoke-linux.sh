#!/bin/sh
# `task mcp:install-smoke:linux` — the timed clean install in a throwaway node:24-slim container.
# git and CA certificates are added before the timer starts (the machine is "Node 24 and git").
# The repo is mounted read-only; results land in tmp/install-smoke/linux-<client> on the host.
#   CLIENT=claude ENV_FILE=<file with ANTHROPIC_API_KEY=…>   (the key never appears on a command line)
#   CLIENT=codex  CODEX_AUTH=<path to auth.json>              (mounted read-only, copied in)
set -eu
CLIENT=${CLIENT:-claude}
REPO=$(cd .. && pwd)
OUT="$REPO/tmp/install-smoke/linux-$CLIENT"
mkdir -p "$OUT"
# A path given as ~/… (zsh does not expand ~ after `NAME=` in a task argument) is resolved here.
abs() { case "$1" in "~/"*) printf "%s/%s" "$HOME" "${1#\~/}";; *) printf "%s" "$1";; esac; }
set -- --rm --init -v "$REPO:/repo:ro" -v "$OUT:/out"
[ -n "${ENV_FILE:-}" ] && set -- "$@" --env-file "$(abs "$ENV_FILE")"
EXTRA=""
if [ "$CLIENT" = codex ]; then
  : "${CODEX_AUTH:?set CODEX_AUTH to the Codex auth.json}"
  set -- "$@" -v "$(abs "$CODEX_AUTH"):/codex-auth.json:ro"
  EXTRA="--codex-auth /codex-auth.json --codex-bypass"   # bypass only inside this throwaway container
fi
exec docker run "$@" node:24-slim sh -c "
  set -eu
  apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null
  # Run on the container's own filesystem: npm's cache lock fails on a host bind mount (ECOMPROMISED,
  # measured 2026-11-16). Only the evidence is copied out, whatever the exit code.
  rc=0; node /repo/mcp-server/scripts/install-smoke.mjs --client $CLIENT --isolate --out /tmp/run $EXTRA \$* || rc=\$?
  rm -rf /out/run && mkdir -p /out/run && cp -r /tmp/run/result.json /tmp/run/logs /tmp/run/files /out/run/ 2>/dev/null || true
  exit \$rc
" sh ${CLI_ARGS:-}
