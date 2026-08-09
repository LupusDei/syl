#!/usr/bin/env bash
#
# Runs both halves of the iOS test suite.
#
#   1. SylKit on the host, via `swift test` — no simulator, tens of milliseconds.
#      This is where networking and wire-format tests belong.
#   2. The app target on a simulator, via `xcodebuild test` — slow, so keep it thin.
#
# They cannot be one command: a scheme's TestAction silently skips a local package's
# test target (verified — it reports success having run nothing).
#
# Override the simulator with SYL_DESTINATION, e.g.
#   SYL_DESTINATION='platform=iOS Simulator,name=iPhone 16,OS=18.6' ios/scripts/test.sh
set -euo pipefail

ios_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# No OS pinned: xcodebuild picks the newest installed runtime for the device, so a
# routine Xcode update does not break the script.
destination="${SYL_DESTINATION:-platform=iOS Simulator,name=iPhone 17}"

echo "==> SylKit (host)"
swift test --package-path "$ios_dir/SylKit"

echo "==> Syl app (simulator: $destination)"
xcodebuild test \
  -project "$ios_dir/Syl.xcodeproj" \
  -scheme Syl \
  -sdk iphonesimulator \
  -destination "$destination" \
  -quiet
