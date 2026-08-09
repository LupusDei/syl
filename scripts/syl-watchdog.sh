#!/bin/bash
#
# The wedge detector.
#
# `KeepAlive` restarts a process that has DIED. Nothing in launchd notices one
# that is WEDGED — still running, still holding the port, still accepting TCP
# connections because the kernel's listen backlog does that without the
# process's help, and answering nothing. `launchctl list` shows it as perfectly
# healthy. That is the 3am failure, and it is the entire reason this file
# exists.
#
# So the question asked here is not "is there a process" — launchd already knows
# that, and knowing it is exactly what is not enough. The question is "does it
# answer", asked over the loopback the way a client asks, with a deadline.
#
# Consecutive failures, not one. A single slow response during a heavy tick is
# not a wedge, and a watchdog that restarts the service every time a research
# brief takes twelve seconds is worse than no watchdog. Three misses at a
# sixty-second interval means a genuinely wedged service is back inside four
# minutes and a busy one is never touched.
#
# Exit codes are informational (launchd does not restart a StartInterval job on
# failure) but they are what the tests assert on:
#   0  healthy
#   1  unhealthy, below the threshold, counting
#   2  wedged, a restart was issued
#   78 misconfigured

set -uo pipefail

PORT="${SYL_PORT:-8888}"
LABEL="${SYL_CORE_LABEL:-com.jmm.syl.core}"
LOG_DIR="${SYL_LOG_DIR:-$HOME/Library/Logs/Syl}"
STATE_FILE="${SYL_WATCHDOG_STATE:-$LOG_DIR/watchdog.state}"
THRESHOLD="${SYL_WATCHDOG_THRESHOLD:-3}"
TIMEOUT="${SYL_WATCHDOG_TIMEOUT:-10}"
LAUNCHCTL="${SYL_LAUNCHCTL:-/bin/launchctl}"
HEALTH_URL="${SYL_HEALTH_URL:-http://127.0.0.1:$PORT/api/v1/health}"
# 32 MiB. These are the files launchd holds open, so they can only be bounded
# by truncation in place — renaming one leaves launchd writing to the renamed
# inode and the "current" file empty forever.
MAX_CAPTURE_BYTES="${SYL_WATCHDOG_MAX_CAPTURE_BYTES:-33554432}"

mkdir -p "$LOG_DIR" 2>/dev/null || {
  printf 'FATAL: cannot create %s\n' "$LOG_DIR" >&2
  exit 78
}

# One JSON line per event into the watchdog's own log, and a human line on
# stdout for whoever is tailing. The JSON is what `npm run syl:logs` reads.
log() {
  local level="$1" event="$2" detail="${3:-}"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  printf '{"ts":"%s","level":"%s","event":"%s","pid":%d,"detail":"%s"}\n' \
    "$ts" "$level" "$event" "$$" "$detail" >>"$LOG_DIR/watchdog.log"
  printf '%s [syl-watchdog] %s %s %s\n' "$ts" "$level" "$event" "$detail"
}

read_failures() {
  local value
  value="$(cat "$STATE_FILE" 2>/dev/null || printf '0')"
  case "$value" in
  '' | *[!0-9]*) printf '0' ;;
  *) printf '%s' "$value" ;;
  esac
}

write_failures() {
  printf '%s' "$1" >"$STATE_FILE"
}

# Bound the files launchd captures. Truncation, never rotation — see above.
truncate_captures() {
  local file size
  for file in "$LOG_DIR"/launchd-*.log; do
    [ -f "$file" ] || continue
    size="$(stat -f%z "$file" 2>/dev/null || printf '0')"
    if [ "$size" -gt "$MAX_CAPTURE_BYTES" ] 2>/dev/null; then
      : >"$file"
      log info watchdog.truncated "$file was ${size} bytes"
    fi
  done
}

probe() {
  # `--max-time` is the whole point: a wedged process completes the TCP
  # handshake and then never writes, so only a deadline distinguishes it from a
  # healthy one. `-f` makes a non-2xx a failure; `/health` answers 200 even when
  # it reports `degraded`, so a non-2xx here means the HTTP layer itself is gone.
  curl -fsS --max-time "$TIMEOUT" -o /dev/null "$HEALTH_URL" 2>/dev/null
}

truncate_captures

if probe; then
  previous="$(read_failures)"
  if [ "$previous" != "0" ]; then
    log info watchdog.recovered "healthy again after $previous consecutive misses"
  fi
  write_failures 0
  exit 0
fi

failures=$(($(read_failures) + 1))
write_failures "$failures"
log warn watchdog.unhealthy "$HEALTH_URL did not answer within ${TIMEOUT}s ($failures/$THRESHOLD)"

if [ "$failures" -lt "$THRESHOLD" ]; then
  exit 1
fi

log error watchdog.wedged "restarting $LABEL after $failures consecutive misses"
# `kickstart -k` kills the current instance and starts a new one, which is the
# only launchctl verb that helps here: the job is loaded and "running" as far as
# launchd is concerned, so `start` alone is a no-op.
if "$LAUNCHCTL" kickstart -k "gui/$(id -u)/$LABEL"; then
  log info watchdog.restarted "$LABEL kickstarted"
else
  log error watchdog.restart_failed "launchctl kickstart -k gui/$(id -u)/$LABEL failed"
fi

# Counter cleared so the next window is judged on its own merits rather than
# kickstarting on every subsequent tick while the service is still coming up.
write_failures 0
exit 2
