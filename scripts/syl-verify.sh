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
# And one question none of those can ask: WHICH BUILD IS ANSWERING.
#
#   stale   — compare the commit /health reports against HEAD.
#
# That check exists because a stale build is invisible by construction. Every
# other line this script prints passes against an old build, because an old
# build is perfectly healthy. It cost three hours once: the service came up at
# 19:58, a fix landed at 20:18, and Syl went on answering through a tool surface
# that had been removed until the Commander noticed something read oddly and
# asked. `status` now includes it; `stale` is the same check on its own, so it
# can be scripted — exit 0 means the running build is HEAD.
#
# `status` and `stale` are read-only and safe to run any time. Everything else
# deliberately breaks the running service, which is the point.
#
# Usage:
#   scripts/syl-verify.sh status
#   scripts/syl-verify.sh stale
#   scripts/syl-verify.sh kill
#   scripts/syl-verify.sh wedge
#   scripts/syl-verify.sh after-reboot

set -uo pipefail

PORT="${SYL_PORT:-8888}"
LABEL="${SYL_CORE_LABEL:-com.jmm.syl.core}"
WATCHDOG_LABEL="${SYL_WATCHDOG_LABEL:-com.jmm.syl.watchdog}"
HEALTH_URL="${SYL_HEALTH_URL:-http://127.0.0.1:$PORT/api/v1/health}"
LAUNCHCTL="${SYL_LAUNCHCTL:-/bin/launchctl}"
STATUS_FILE="${SYL_CERT_STATUS:-$HOME/.syl/cert-status.json}"
LOG_DIR="${SYL_LOG_DIR:-$HOME/Library/Logs/Syl}"
# The checkout HEAD is read from. Overridable so the build comparison can be
# driven against a scratch repository in a test rather than against this one.
REPO_DIR="${SYL_VERIFY_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
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

# The health body, or the empty string if she does not answer.
health_body() {
  curl -fsS --max-time "${SYL_VERIFY_TIMEOUT:-5}" "$HEALTH_URL" 2>/dev/null
}

# Pull one field out of the health body.
#
# Deliberately anchored on the KEY rather than on a position, so a field added
# to the endpoint later cannot shift the answer. `build.commit` is the only
# `"commit"` key the body has; `"build":null` matches nothing, which is exactly
# the right answer for a service running from source.
health_field() {
  /usr/bin/sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" | head -1
}

# WHICH BUILD IS ANSWERING.
#
# Every other check in this file passes against a stale build, because a stale
# build is perfectly healthy. This is the only one that can fail because of one.
# The two sides of the comparison come from deliberately different places: the
# running service reports what it was BUILT FROM (a stamp inside `dist/`, never
# a `git` call at request time), and HEAD is what the checkout says now. It is
# the disagreement between those two that is the whole signal.
cmd_stale() {
  heading "Which build is answering"

  local body
  body="$(health_body)"
  if [ -z "$body" ]; then
    fail "$HEALTH_URL does not answer, so nothing can be said about which build is running"
    return
  fi

  local running built head
  running="$(printf '%s' "$body" | health_field commit)"
  built="$(printf '%s' "$body" | health_field builtAt)"
  head="$(/usr/bin/git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)"

  if [ -z "$running" ]; then
    fail "the service reports no build commit — it is running from source, or from a build made before provenance existed"
    note "if she is supposed to be a launchd service, this is itself the finding: rebuild and redeploy"
    return
  fi

  case "$body" in
  *'"dirty":true'*)
    fail "the running build was made from a DIRTY working tree — it cannot be reproduced from ${running:0:7}"
    ;;
  esac

  note "running ${running:0:7}, built $built"

  if [ -z "$head" ]; then
    fail "cannot read HEAD from $REPO_DIR, so there is nothing to compare against"
    return
  fi

  if [ "$running" = "$head" ]; then
    pass "that is the commit at HEAD"
  else
    fail "STALE: she is running ${running:0:7} and HEAD is ${head:0:7}"
    note "she is healthy and she is not the code you are reading. Deploy: npm run deploy"
    note "what changed:  git -C $REPO_DIR log --oneline ${running:0:7}..${head:0:7}"
  fi
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

  cmd_stale

  # The check that would have saved an evening.
  #
  # Every check above passed while the Commander's phone said "could not reach
  # that Mac". The service answers on LOOPBACK and speaks plain HTTP; the phone
  # asks for https://<tailnet-name>. A green health check on 127.0.0.1 says
  # nothing about whether anything outside this machine can reach her, and a
  # certificate NOTHING PRESENTS is a certificate that does not exist.
  #
  # `tailscale serve` is what bridges the two: it terminates TLS with that
  # certificate and proxies to loopback, so the service never binds a network
  # interface. This checks the bridge is actually there — including after a
  # reboot, which is the case nobody would notice until a reminder failed to
  # arrive.
  heading "Reachable from the tailnet"
  if ! command -v tailscale >/dev/null 2>&1; then
    fail "no tailscale binary — install the STANDALONE client"
  elif tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
    pass "tailscale serve is proxying https -> 127.0.0.1:$PORT"
    # Taken from `serve status` rather than parsed out of `status --json`.
    # It is the URL serve itself reports, so it cannot disagree with what is
    # actually configured — and a hand-rolled sed over JSON was already wrong
    # once, silently producing an empty host and a failure that read as
    # unreachable rather than as a broken check.
    tailnet_host="$(tailscale serve status 2>/dev/null |
      /usr/bin/sed -n 's|^https://\([^ ]*\).*|\1|p' | head -1)"
    if [ -n "$tailnet_host" ] &&
       curl -fsS --max-time 8 "https://$tailnet_host/api/v1/health" >/dev/null 2>&1; then
      pass "https://$tailnet_host/api/v1/health answers over the tailnet"
    else
      fail "serve is configured but https://$tailnet_host/api/v1/health does not answer"
    fi
  else
    fail "tailscale serve is NOT configured — the phone cannot reach her. Run: sudo tailscale serve --bg --https=443 http://127.0.0.1:$PORT"
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
stale) cmd_stale ;;
kill) cmd_kill ;;
wedge) cmd_wedge ;;
after-reboot) cmd_after_reboot ;;
*)
  printf 'usage: %s [status|stale|kill|wedge|after-reboot]\n' "$0" >&2
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
