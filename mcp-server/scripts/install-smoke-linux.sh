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
set -- --rm --init -v "$REPO:/repo:ro" -v "$OUT:/out"
[ -n "${ENV_FILE:-}" ] && set -- "$@" --env-file "$ENV_FILE"
EXTRA=""
if [ "$CLIENT" = codex ]; then
  : "${CODEX_AUTH:?set CODEX_AUTH to the Codex auth.json}"
  set -- "$@" -v "$CODEX_AUTH:/codex-auth.json:ro"
  EXTRA="--codex-auth /codex-auth.json --codex-bypass"   # bypass only inside this throwaway container
fi
exec docker run "$@" node:24-slim sh -c "
  set -eu
  apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null
  node /repo/mcp-server/scripts/install-smoke.mjs --client $CLIENT --out /out/run $EXTRA \$*
" sh ${CLI_ARGS:-}
