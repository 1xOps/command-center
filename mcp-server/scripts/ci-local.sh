#!/bin/sh
# `task mcp:ci-local` — the Linux CI job (npm ci, tests, audit, supply-chain gate) in a
# container on the product's pinned Wolfi base, before spending GitHub Actions minutes.
# The repo is mounted read-only and copied, so the run never changes the working tree.
# macOS and Windows cannot run in local containers; CI covers them.
set -eu
BASE=$(sed -n 's/^ARG WOLFI_BASE=//p' Dockerfile)
exec docker run --rm -v "$(cd .. && pwd):/repo:ro" "$BASE" sh -c '
  set -eu
  apk add --no-cache nodejs-24 npm ripgrep >/dev/null
  adduser -D ci
  mkdir /work && cd /repo && tar --exclude=node_modules --exclude=dist --exclude=tmp -cf - . | tar -xf - -C /work
  chown -R ci /work
  su ci -c "set -eu; cd /work/mcp-server; npm ci --no-audit --no-fund; npm test; npm audit --audit-level=high; node scripts/supply-chain.mjs --release"
'
