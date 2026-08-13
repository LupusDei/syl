#!/bin/zsh
# Run a command with Node 22 on PATH, from the worktree root.
# Scratch helper for this agent's worktree; not for commit.
export PATH="/Users/Reason/.nvm/versions/node/v22.23.1/bin:$PATH"
cd "$(dirname "$0")" || exit 1
exec "$@"
