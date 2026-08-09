#!/usr/bin/env bash
#
# Runs both halves of the iOS test suite.
#
#   1. SylKit on the host, via `swift test` — no simulator, tens of milliseconds.
#      This is where networking and wire-format tests belong.
#   2. SylKit against a REAL running backend, via the vitest harness that boots one.
#   3. The app target on a simulator, via `xcodebuild test` — slow, so keep it thin.
#
# 1 and 3 cannot be one command: a scheme's TestAction silently skips a local package's
# test target (verified — it reports success having run nothing).
#
# 2 is here because it was previously nowhere (`syl-e4f`). Every suite in 1 and 3 uses
# MockURLProtocol, a FakeConnector, or no I/O at all, and both halves of `LiveServerTests`
# self-skip without SYL_LIVE_URL — so the default iOS run touched no server whatsoever
# while reporting complete success. Three of the four open iOS P0s were found the first
# time this actually executed.
#
# Override the simulator with SYL_DESTINATION, e.g.
#   SYL_DESTINATION='platform=iOS Simulator,name=iPhone 16,OS=18.6' ios/scripts/test.sh
set -euo pipefail

ios_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$ios_dir/.." && pwd)"

# No OS pinned: xcodebuild picks the newest installed runtime for the device, so a
# routine Xcode update does not break the script.
destination="${SYL_DESTINATION:-platform=iOS Simulator,name=iPhone 17}"

echo "==> SylKit (host)"
swift test --package-path "$ios_dir/SylKit"

echo "==> SylKit against a real Syl (boots a throwaway service)"
# Deliberately fatal rather than skipped. A missing toolchain is a reason to install
# one, not a reason for the run to quietly stop checking the one seam where the app and
# the service meet — a suite that skips reports success having run nothing, which is
# the exact failure this phase was added to end.
if ! command -v npx >/dev/null 2>&1; then
  echo "error: npx is not on PATH." >&2
  echo "       This phase boots a real backend, so it needs the Node workspace." >&2
  echo "       Install Node 22 (see .nvmrc) and run 'npm install' from $repo_dir." >&2
  exit 1
fi
if [ ! -d "$repo_dir/node_modules" ]; then
  echo "error: $repo_dir/node_modules is missing. Run 'npm install' from $repo_dir." >&2
  exit 1
fi
# SYL_IOS_LIVE=1 is what stops the suite skipping itself. Do not remove it to make a
# run faster; removing it makes the run mean nothing, and says so nowhere.
(cd "$repo_dir" && SYL_IOS_LIVE=1 npx vitest run backend/tests/integration/ios-live-server.test.ts)

echo "==> Syl app (simulator: $destination)"
xcodebuild test \
  -project "$ios_dir/Syl.xcodeproj" \
  -scheme Syl \
  -sdk iphonesimulator \
  -destination "$destination" \
  -quiet
