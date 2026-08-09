#!/bin/bash
#
# Keep the tailnet certificate alive.
#
# `tailscale cert` issues a real, publicly-trusted Let's Encrypt certificate for
# the Mac's tailnet hostname. That is why the iOS app needs no App Transport
# Security exception, and it is strictly better than the plain-HTTP-plus-ATS-
# exception path — it is free and it is real TLS.
#
# It is also a NINETY DAY certificate and `tailscale cert` does not renew it on
# its own. An expired certificate is a silent outage on a timer: the service is
# up, the tailnet is up, the phone simply cannot complete a TLS handshake and
# says "cannot connect to server". Nothing anywhere says why.
#
# So this runs daily and does three things:
#
#   1. Renews when the certificate has less than SYL_CERT_MIN_DAYS left.
#   2. Writes a status file the service's health endpoint reads, so an
#      expiring or failed certificate shows up as `degraded` on /health BEFORE
#      it becomes an outage.
#   3. Fails LOUDLY — non-zero exit, an error record in the log, and a desktop
#      notification — because a renewal job that fails quietly is worse than no
#      renewal job at all: it converts a known 90-day deadline into a surprise.
#
# Exit codes:
#   0  the certificate is valid and has comfortable time left
#   1  renewal was attempted and did not produce a usable certificate
#   78 misconfigured (no hostname, no tailscale binary)

set -uo pipefail

CERT_DIR="${SYL_CERT_DIR:-$HOME/.syl/certs}"
STATUS_FILE="${SYL_CERT_STATUS:-$HOME/.syl/cert-status.json}"
LOG_DIR="${SYL_LOG_DIR:-$HOME/Library/Logs/Syl}"
MIN_DAYS="${SYL_CERT_MIN_DAYS:-30}"
# Below this, renewal ran and did not help. Let's Encrypt allows renewal from
# 30 days out, so still being under two weeks after a successful-looking run
# means something is wrong that waiting will not fix.
ALARM_DAYS="${SYL_CERT_ALARM_DAYS:-14}"
NOTIFY="${SYL_CERT_NOTIFY:-/usr/bin/osascript}"

mkdir -p "$LOG_DIR" "$CERT_DIR" "$(dirname "$STATUS_FILE")" 2>/dev/null || {
  printf 'FATAL: cannot create the certificate directories\n' >&2
  exit 78
}

log() {
  local level="$1" event="$2" detail="${3:-}"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  printf '{"ts":"%s","level":"%s","event":"%s","pid":%d,"detail":"%s"}\n' \
    "$ts" "$level" "$event" "$$" "$detail" >>"$LOG_DIR/cert-renew.log"
  printf '%s [syl-cert] %s %s %s\n' "$ts" "$level" "$event" "$detail"
}

# ok | renewed | daysRemaining | error
write_status() {
  local ok="$1" renewed="$2" days="$3" error="$4"
  cat >"$STATUS_FILE" <<JSON
{
  "checkedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "hostname": "${HOSTNAME_FQDN:-}",
  "certPath": "$CERT_FILE",
  "ok": $ok,
  "renewed": $renewed,
  "daysRemaining": $days,
  "error": $error
}
JSON
}

fail_loudly() {
  local message="$1"
  log error cert.failed "$message"
  # Best effort. A machine with no logged-in session has no notification
  # centre, and that must not turn a warning into a crash.
  if [ -x "$NOTIFY" ]; then
    "$NOTIFY" -e "display notification \"$message\" with title \"Syl: tailnet certificate\"" \
      >/dev/null 2>&1 || true
  fi
}

# --- the tailscale binary --------------------------------------------------
#
# Same lesson as everywhere else in this repository: launchd's PATH has none of
# the places this is actually installed. The standalone client puts it in
# /usr/local/bin; the App Store build hides it inside the bundle — and if this
# resolves to the App Store one, that is itself a finding, because the sandboxed
# variant cannot run as a boot daemon at all.

resolve_tailscale() {
  local candidate

  # An explicit override is an INSTRUCTION, not a hint.
  #
  # `SYL_TAILSCALE_BIN` used to be merely the first entry in the candidate list
  # below, so setting it to a path that does not exist silently fell through to
  # whatever happened to be on the machine. An operator who fat-fingers the
  # override then gets a DIFFERENT binary than the one they named, with no
  # complaint — the same "override that does not override" shape as every other
  # silent-substitution defect in this project.
  #
  # It was invisible until tailscale was actually installed here: the test that
  # covers it points at /nonexistent/tailscale and had been passing only
  # because the fallbacks were empty too. Installing the real client turned a
  # green test red and exposed the bug, which is the test doing its job late
  # rather than not at all.
  if [ -n "${SYL_TAILSCALE_BIN:-}" ]; then
    [ -x "${SYL_TAILSCALE_BIN}" ] && printf '%s' "${SYL_TAILSCALE_BIN}" && return 0
    return 1
  fi

  for candidate in \
    /usr/local/bin/tailscale \
    /opt/homebrew/bin/tailscale \
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && printf '%s' "$candidate" && return 0
  done
  candidate="$(command -v tailscale 2>/dev/null || true)"
  [ -n "$candidate" ] && printf '%s' "$candidate" && return 0
  return 1
}

TAILSCALE="$(resolve_tailscale)" || {
  CERT_FILE=""
  log error cert.no_tailscale "no tailscale binary found; install the STANDALONE client"
  write_status false false null '"tailscale binary not found"'
  exit 78
}

# --- the hostname ----------------------------------------------------------

HOSTNAME_FQDN="${SYL_TAILNET_HOSTNAME:-}"
if [ -z "$HOSTNAME_FQDN" ]; then
  HOSTNAME_FQDN="$("$TAILSCALE" status --json 2>/dev/null |
    /usr/bin/sed -n 's/.*"DNSName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  HOSTNAME_FQDN="${HOSTNAME_FQDN%.}"
fi

CERT_FILE="$CERT_DIR/$HOSTNAME_FQDN.crt"
KEY_FILE="$CERT_DIR/$HOSTNAME_FQDN.key"

if [ -z "$HOSTNAME_FQDN" ]; then
  log error cert.no_hostname "set SYL_TAILNET_HOSTNAME, or bring the tailnet up"
  write_status false false null '"tailnet hostname unknown"'
  exit 78
fi

# --- how much time is left -------------------------------------------------
#
# `openssl x509 -checkend` is the decision, because it needs no date parsing and
# therefore cannot be wrong about a locale or a BSD-vs-GNU `date`. The day count
# is best-effort and only ever reported, never acted on.

seconds_for_days() { printf '%s' "$(($1 * 86400))"; }

valid_for_days() {
  local days="$1"
  [ -f "$CERT_FILE" ] || return 1
  /usr/bin/openssl x509 -in "$CERT_FILE" -noout -checkend "$(seconds_for_days "$days")" >/dev/null 2>&1
}

days_remaining() {
  local end epoch now
  [ -f "$CERT_FILE" ] || { printf 'null'; return; }
  end="$(/usr/bin/openssl x509 -in "$CERT_FILE" -noout -enddate 2>/dev/null)" || { printf 'null'; return; }
  end="${end#notAfter=}"
  epoch="$(/bin/date -j -f '%b %e %H:%M:%S %Y %Z' "$end" +%s 2>/dev/null)" || { printf 'null'; return; }
  now="$(/bin/date +%s)"
  printf '%s' "$(((epoch - now) / 86400))"
}

if valid_for_days "$MIN_DAYS"; then
  log info cert.ok "$HOSTNAME_FQDN valid for $(days_remaining) more days; nothing to do"
  write_status true false "$(days_remaining)" null
  exit 0
fi

# --- renew -----------------------------------------------------------------

log info cert.renewing "$HOSTNAME_FQDN has under $MIN_DAYS days left"
renew_output="$("$TAILSCALE" cert --cert-file "$CERT_FILE" --key-file "$KEY_FILE" "$HOSTNAME_FQDN" 2>&1)"
renew_status=$?

if [ "$renew_status" -ne 0 ]; then
  fail_loudly "tailscale cert failed for $HOSTNAME_FQDN: $(printf '%s' "$renew_output" | tr '\n' ' ' | cut -c1-200)"
  write_status false false "$(days_remaining)" "\"tailscale cert exited $renew_status\""
  exit 1
fi

# A renewal that "succeeded" and left a certificate still inside the alarm
# window is the dangerous case: everything looks fine and the outage is still
# scheduled. Check what actually landed on disk rather than trusting the exit
# code.
if ! valid_for_days "$ALARM_DAYS"; then
  fail_loudly "tailscale cert succeeded but $CERT_FILE still expires within $ALARM_DAYS days"
  write_status false true "$(days_remaining)" '"renewal did not extend the certificate"'
  exit 1
fi

log info cert.renewed "$HOSTNAME_FQDN now valid for $(days_remaining) more days"
write_status true true "$(days_remaining)" null
exit 0
