#!/bin/bash
#
# The core service, as launchd starts it.
#
# Three things this script exists to do, none of which a plist can do itself:
#
#   1. Find `node`. launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin` and
#      nothing else — no Homebrew, no nvm, no `~/.local/bin`. This is the same
#      trap `backend/src/harness/claude-bin.ts` already documents: the same
#      machine resolves under an interactive zsh and throws ENOENT under
#      launchd.
#   2. Strip the credential variables. Non-negotiable constraint 3 — a set
#      ANTHROPIC_API_KEY silently outranks the claude.ai login and reroutes
#      billing to the metered API. The harness strips them before spawning
#      `claude`, but stripping them here means nothing in the process tree ever
#      had one.
#   3. `exec`. Without it, bash stays as the process launchd is tracking and
#      launchd's SIGTERM goes to *bash*, which dies instantly and takes node
#      with it — defeating the graceful shutdown entirely. With it, node IS the
#      job, and gets the signal it handles.
#
# Exit 78 (EX_CONFIG) means "a human has to fix something", and the line above
# it says what.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 78

log() {
  printf '%s [syl-service] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# --- 1. node ---------------------------------------------------------------
#
# Candidates in the order a machine is most likely to have a usable one, each
# checked by asking the binary its version rather than by trusting the path it
# was found at. A machine with nvm has half a dozen nodes installed and only
# some of them are new enough.

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
  # Newest nvm install first. `sort -r` on the directory names is enough: they
  # are all `vNN.NN.NN`, and a wrong ordering only costs us a version probe.
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
  log "FATAL: no node >= 22 found. Looked at SYL_NODE_BIN, /opt/homebrew/bin,"
  log "       /usr/local/bin, ~/.nvm/versions/node/*/bin and PATH."
  log "       Set SYL_NODE_BIN in ~/Library/LaunchAgents/com.jmm.syl.core.plist."
  exit 78
}

# --- 2. credentials --------------------------------------------------------

unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN

# --- 3. the built service --------------------------------------------------

ENTRY="$REPO_ROOT/backend/dist/index.js"
if [ ! -f "$ENTRY" ]; then
  log "FATAL: $ENTRY does not exist. The service runs built output, not tsx."
  log "       Build it:  cd $REPO_ROOT && npm run build"
  exit 78
fi

log "starting $ENTRY with $NODE_BIN ($("$NODE_BIN" --version))"
exec "$NODE_BIN" "$ENTRY"
