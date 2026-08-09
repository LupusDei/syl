#!/bin/bash
#
# Proof of life, for the parts a test suite cannot reach.
#
# `syl-007.4.2` asks three questions, and only the first two can be answered
# from inside a test process:
#
#   kill    — SIGKILL the service; does launchd bring it back?
#   wedge   — SIGSTOP the service; does the WATCHDOG bring it back? KeepAlive
#             will not: a stopped process is still running as far as launchd is
#             concerned, still holds the port, and answers nothing. That is the
#             3am failure, reproduced exactly, with `kill -CONT` as the undo.
#   reboot  — nobody can automate this. `after-reboot` is the checklist.
#
# `status` is read-only and safe to run any time. Everything else deliberately
# breaks the running service, which is the point.
#
# Usage:
#   scripts/syl-verify.sh status
#   scripts/syl-verify.sh kill
#   scripts/syl-verify.sh wedge
#   scripts/syl-verify.sh after-reboot

set -uo pipefail

PORT="${SYL_PORT:-4220}"
LABEL="${SYL_CORE_LABEL:-com.jmm.syl.core}"
WATCHDOG_LABEL="${SYL_WATCHDOG_LABEL:-com.jmm.syl.watchdog}"
HEALTH_URL="${SYL_HEALTH_URL:-http://127.0.0.1:$PORT/api/v1/health}"
LAUNCHCTL="${SYL_LAUNCHCTL:-/bin/launchctl}"
STATUS_FILE="${SYL_CERT_STATUS:-$HOME/.syl/cert-status.json}"
LOG_DIR="${SYL_LOG_DIR:-$HOME/Library/Logs/Syl}"
# How long launchd's KeepAlive may take. ThrottleInterval is 10.
RESTART_DEADLINE="${SYL_VERIFY_RESTART_DEADLINE:-60}"
# How long the watchdog may take: StartInterval 60 times a threshold of 3, plus
# room for the restart itself.
WEDGE_DEADLINE="${SYL_VERIFY_WEDGE_DEADLINE:-300}"

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
fail() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$*"
  FAILURES=$((FAILURES + 1))
}
note() { printf '        %s\n' "$*"; }
heading() { printf '\n%s\n' "$*"; }

FAILURES=0

service_pid() {
  # `launchctl print` reports `pid = 1234` for a running job and omits the line
  # entirely for one that is loaded but not currently running.
  "$LAUNCHCTL" print "gui/$(id -u)/$LABEL" 2>/dev/null |
    /usr/bin/sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\).*/\1/p' | head -1
}

answers() {
  curl -fsS --max-time "${SYL_VERIFY_TIMEOUT:-5}" -o /dev/null "$HEALTH_URL" 2>/dev/null
}

# Wait until `answers` succeeds, or the deadline passes.
await_health() {
  local deadline=$(($(date +%s) + $1))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if answers; then return 0; fi
    sleep 2
  done
  return 1
}

# Wait until the job reports a pid different from the one given.
await_new_pid() {
  local was="$1" deadline=$(($(date +%s) + $2)) current
  while [ "$(date +%s)" -lt "$deadline" ]; do
    current="$(service_pid)"
    if [ -n "$current" ] && [ "$current" != "$was" ]; then
      printf '%s' "$current"
      return 0
    fi
    sleep 2
  done
  return 1
}

cmd_status() {
  heading "The machine"
  local sleep_setting autorestart
  sleep_setting="$(/usr/bin/pmset -g custom 2>/dev/null | /usr/bin/awk '/^AC Power:/{f=1} f&&/ sleep /{print $2; exit}')"
  autorestart="$(/usr/bin/pmset -g custom 2>/dev/null | /usr/bin/awk '/^AC Power:/{f=1} f&&/autorestart/{print $2; exit}')"
  [ "$sleep_setting" = "0" ] && pass "AC sleep is 0" || fail "AC sleep is ${sleep_setting:-unknown}, not 0 — a sleeping Mac fires no reminders"
  [ "$autorestart" = "1" ] && pass "autorestart is 1" || fail "autorestart is ${autorestart:-unknown}, not 1 — a power cut leaves this Mac off"

  if [ -n "$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)" ]; then
    pass "automatic login is set"
  else
    fail "automatic login is NOT set — after a reboot no LaunchAgent runs until somebody logs in"
  fi

  heading "launchd"
  for label in "$LABEL" "$WATCHDOG_LABEL"; do
    if "$LAUNCHCTL" print "gui/$(id -u)/$label" >/dev/null 2>&1; then
      pass "$label is loaded"
    else
      fail "$label is NOT loaded — run: npm run launchd -- --install"
    fi
  done
  local pid
  pid="$(service_pid)"
  [ -n "$pid" ] && pass "the service is running as pid $pid" || fail "the service is loaded but not running"

  heading "The service"
  if answers; then
    pass "$HEALTH_URL answers"
    curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null |
      /usr/bin/sed -n 's/.*"status":"\([a-z]*\)".*/        overall: \1/p' | head -1
  else
    fail "$HEALTH_URL does not answer"
  fi

  heading "The tailnet certificate"
  if [ -f "$STATUS_FILE" ]; then
    note "$(cat "$STATUS_FILE")"
  else
    fail "no $STATUS_FILE — com.jmm.syl.cert has never run"
  fi

  heading "Logs"
  note "$LOG_DIR"
  note "last failure:  npm run logs -- --failure"
}

cmd_kill() {
  heading "kill — does launchd bring a DEAD service back?"
  local was
  was="$(service_pid)"
  if [ -z "$was" ]; then
    fail "the service is not running; nothing to kill"
    return
  fi
  note "killing pid $was with SIGKILL"
  kill -9 "$was" 2>/dev/null

  local now
  if now="$(await_new_pid "$was" "$RESTART_DEADLINE")"; then
    pass "launchd restarted it as pid $now"
  else
    fail "no new pid within ${RESTART_DEADLINE}s — KeepAlive is not doing its job"
    return
  fi

  if await_health "$RESTART_DEADLINE"; then
    pass "it answers again"
  else
    fail "the new process does not answer"
  fi
}

cmd_wedge() {
  heading "wedge — does the WATCHDOG notice a service that is not dead?"
  local was
  was="$(service_pid)"
  if [ -z "$was" ]; then
    fail "the service is not running; nothing to wedge"
    return
  fi

  # SIGSTOP is the honest reproduction: the process stays alive, keeps its
  # port, and the kernel keeps completing handshakes out of the listen backlog.
  # launchd sees a perfectly healthy job. KeepAlive has nothing to restart.
  note "suspending pid $was with SIGSTOP — launchd will still call this healthy"
  kill -STOP "$was" 2>/dev/null

  if answers; then
    fail "a suspended service still answered; the probe is not measuring anything"
    kill -CONT "$was" 2>/dev/null
    return
  fi
  pass "it is wedged: running, holding the port, answering nothing"

  note "waiting up to ${WEDGE_DEADLINE}s for the watchdog (3 misses at 60s)"
  local now
  if now="$(await_new_pid "$was" "$WEDGE_DEADLINE")"; then
    pass "the watchdog restarted it as pid $now"
  else
    fail "still wedged after ${WEDGE_DEADLINE}s — the watchdog is not running"
    note "releasing the suspended process so the machine is left as it was found"
    kill -CONT "$was" 2>/dev/null
    return
  fi

  # Belt and braces: kickstart -k should have killed the old one, but a
  # suspended process left behind would hold the port forever.
  kill -CONT "$was" 2>/dev/null
  kill -9 "$was" 2>/dev/null

  if await_health "$RESTART_DEADLINE"; then
    pass "it answers again"
  else
    fail "the new process does not answer"
  fi
}

cmd_after_reboot() {
  heading "after a reboot — the clause that fails in practice"
  note "uptime: $(uptime)"
  cmd_status
  heading "Now, from the phone, with Wi-Fi OFF"
  note "Open Syl over cellular. If it loads, the tailnet came up before login,"
  note "the certificate is valid, and the service started without a human."
}

case "${1:-status}" in
status) cmd_status ;;
kill) cmd_kill ;;
wedge) cmd_wedge ;;
after-reboot) cmd_after_reboot ;;
*)
  printf 'usage: %s [status|kill|wedge|after-reboot]\n' "$0" >&2
  exit 64
  ;;
esac

heading ""
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[32mEverything checked passed.\033[0m\n'
  exit 0
fi
printf '\033[31m%d check(s) failed.\033[0m\n' "$FAILURES"
exit 1
