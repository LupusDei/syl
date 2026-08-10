#!/bin/bash
#
# The auto-deploy, as launchd runs it.
#
# Every ten minutes this asks whether `origin/main` has moved AND whether that
# commit's GitHub checks have PASSED, and it deploys only when the answer to
# both is an unambiguous yes. The second question is the whole design: "if HEAD
# moved, build and restart" would let a 2am commit with red CI take the
# Commander's assistant down while he sleeps, and the first symptom would be a
# 07:00 agenda that never arrives.
#
# Everything interesting is in TypeScript, behind injected seams, and tested
# without a network or a launchd job:
#
#   backend/src/ops/deploy-gate.ts   whether this commit may be deployed
#   backend/src/ops/deploy.ts        deploy, health-gate, roll back
#   backend/src/ops/cli/deploy.ts    the real git/npm/launchctl/gh plumbing
#
# This file exists for the three things a plist cannot do, and they are the same
# three `syl-service.sh` exists for:
#
#   1. Find `node`. launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin` and
#      nothing else — no Homebrew, no nvm, no `~/.local/bin`.
#   2. Strip the credential variables. Non-negotiable constraint 3. This process
#      runs `npm run verify`, which spawns the test suite, which spawns `claude`
#      — so a stray ANTHROPIC_API_KEY here would reroute billing just as surely
#      as one in the service.
#   3. Refuse clearly when there is nothing built to run.
#
# Exit codes:
#   0   deployed, or correctly decided not to
#   1   did not deploy, and said why
#   70  a deploy failed and was rolled back — or the rollback failed
#   78  misconfigured; a human has to fix something

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 78

log() {
  printf '%s [syl-update] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# --- 1. node ---------------------------------------------------------------
#
# Same candidate list and the same "ask the binary its version" check as
# scripts/syl-service.sh. A machine with nvm has half a dozen nodes installed
# and only some of them are new enough.

node_major() {
  local bin="$1" version
  version="$("$bin" --version 2>/dev/null)" || return 1
  version="${version#v}"
  printf '%s' "${version%%.*}"
}

resolve_node() {
  local candidates=() candidate major
  [ -n "${SYL_NODE_BIN:-}" ] && candidates+=("$SYL_NODE_BIN")
  candidates+=(/opt/homebrew/bin/node /usr/local/bin/node)
  if [ -d "${HOME:-/nonexistent}/.nvm/versions/node" ]; then
    while IFS= read -r dir; do
      candidates+=("$HOME/.nvm/versions/node/$dir/bin/node")
    done < <(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -rV 2>/dev/null || ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -r)
  fi
  candidates+=("$(command -v node 2>/dev/null || true)")

  for candidate in "${candidates[@]}"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    major="$(node_major "$candidate")" || continue
    [ -n "$major" ] || continue
    if [ "$major" -ge 22 ] 2>/dev/null; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(resolve_node)" || {
  log "FATAL: no node >= 22 found. Set SYL_NODE_BIN in"
  log "       ~/Library/LaunchAgents/com.jmm.syl.update.plist."
  exit 78
}

# `npm` and `git` are found by the deploy itself — npm beside this node, git
# from PATH — but `gh` is the one that has to be here, because it carries the
# Commander's GitHub credentials and nothing else can answer for it. A missing
# `gh` is not fatal: the gate reports "could not ask GitHub" and declines to
# deploy, which is the correct posture. Saying so here just makes it obvious.
if ! command -v gh >/dev/null 2>&1; then
  log "WARNING: no gh on PATH. Every run will decline to deploy, because the"
  log "         CI gate cannot be answered. Install the GitHub CLI."
fi

# --- 2. credentials --------------------------------------------------------

unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN

# --- 3. the built deploy command -------------------------------------------
#
# Run from `dist/`, like the service. Every module it needs is imported
# statically at startup, which matters more here than usual: this process
# REPLACES the directory it was loaded from part-way through. Already-loaded
# modules stay in memory; a lazy `import()` after the swap would load whichever
# build happened to be on disk at that instant.

ENTRY="$REPO_ROOT/backend/dist/ops/cli/deploy.js"
if [ ! -f "$ENTRY" ]; then
  log "FATAL: $ENTRY does not exist. The update job runs built output, not tsx."
  log "       Build it:  cd $REPO_ROOT && npm run build"
  exit 78
fi

exec "$NODE_BIN" "$ENTRY" --unattended
