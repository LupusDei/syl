#!/usr/bin/env bash
set -euo pipefail

# Ensure we run from repo root regardless of where the script is invoked
cd "$(git rev-parse --show-toplevel)" || exit 1

# Skip verification for WIP branches
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" == wip/* ]]; then
  echo "WIP branch detected — skipping verification"
  exit 0
fi

# The same three gates CI runs, in the same order. There is no lint step and no
# build step: no linter is configured, and every tsconfig is noEmit, so the
# typecheck *is* the build.
echo "=== Step 1/3: Workspace test coverage ==="
node scripts/check-workspaces-tested.mjs || { echo "FAILED: a workspace has source but no tests"; exit 1; }

echo "=== Step 2/3: Typecheck ==="
npm run typecheck || { echo "FAILED: type errors found"; exit 1; }

echo "=== Step 3/3: Test ==="
npm test || { echo "FAILED: tests failed"; exit 1; }

echo "=== All checks passed ==="
