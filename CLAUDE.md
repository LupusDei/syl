# Syl

A personal assistant for the Commander. Named for Sylphrena, the honorspren.

It owns his to-dos, goals, and objectives; a daily rhythm (morning agenda,
evening review); proactive reminders that arrive at the right wall-clock time;
and research on request, returned as a brief.

> **Read `docs/CONTEXT.md` before starting work.** It records why the
> architecture is what it is, which alternatives were rejected and why, the
> landmines that already cost real time, and where earlier reasoning was wrong.
> It exists so none of that is rediscovered.

## Non-negotiable constraints

These were decided by the Commander or forced by measurement. Do not change them
without asking.

1. **Subscription payment rails only.** Never the metered API. This is the
   strongest constraint and it has decided every major architectural call. When a
   design question is unclear, work out what it implies for billing first.
2. **The official `claude` binary is what talks to Anthropic.** Our code never
   touches credentials. No direct API calls, no third-party harness in the
   credential path.
3. **`ANTHROPIC_API_KEY` must be stripped from any child process**, and
   `apiKeySource === "none"` asserted. A set key silently outranks the claude.ai
   login and reroutes billing. See `adj-t64m9`.
4. **Never silently drop a reminder.** Deferral must always return a strictly
   later instant. A late reminder is a nuisance; a vanished one destroys trust.
5. **Store IANA timezones (`America/Chicago`), never fixed UTC offsets.** An
   offset is a property of an instant, not of a place, and a fixed one drifts an
   hour at every DST boundary.

## Architecture in one line

Drive `claude -p --input-format stream-json --output-format stream-json --verbose`
as one subprocess per turn, with continuity via `--resume`.

One process per turn is forced, not chosen: a turn does not complete until stdin
reaches EOF. Details and the measurement in `docs/CONTEXT.md` §3.

## Layout

An npm monorepo. `ios/` is Swift and deliberately **not** an npm workspace.

```
backend/                          the Node 22 service (npm workspace)
  src/harness/protocol.ts         pure codec — JSON lines <-> typed events. Zero I/O.
  src/harness/session.ts          runTurn(): one subprocess per turn
  src/harness/agent.ts            SylAgent: per-lane continuity + stale-session recovery
  src/harness/reader.ts           runReaderTurn(): untrusted text, no tools
  src/services/conversation-service.ts  the seam that makes her answer: both write
                                  paths append + accept here; one turn at a time
                                  per conversation; a failed turn is a message,
                                  never silence
  tests/helpers/fake-claude.ts    a real fake `claude` executable, for driving runTurn
  tests/fixtures/*.jsonl          captured CLI transcripts — never hand-written
  src/harness/schedule.ts         wall-clock scheduling + quiet hours
  src/harness/cli/ping.ts         end-to-end smoke test
  tests/unit/**                   vitest
frontend/                         web admin — Vite + React (npm workspace)
shared/                           THE CONTRACT — OpenAPI, generated types, fixtures (npm workspace)
ios/                              SylKit (SPM) + the app target — Swift, not a workspace
tsconfig.base.json                strict + noUncheckedIndexedAccess; every workspace extends it
vitest.shared.ts                  base vitest config; every workspace merges it
SOUL.md                           Syl's standing orders, appended to the system prompt
docs/CONTEXT.md                   exploration record and decision log
```

Keep the codec pure. The subtle bugs in this layer are wire-format bugs, and
keeping them testable without spawning a process is worth the seam.

## Working rules

- **Test first.** The project constitution (`constitution.md`) requires it, and
  the base layer is exactly where it pays.
- **Build fixtures from real captured CLI output, never from our own type
  definitions.** The point is to catch drift between our types and the actual
  wire format.
- **Zero TypeScript errors.** Strict mode with `noUncheckedIndexedAccess`.
- **Track work in beads** (`bd`), not TodoWrite or markdown lists. Syl has no
  beads database of its own yet — everything is tracked under `adj-itvob` in the
  Adjutant project.
- **Communicate through Adjutant MCP.** Terminal output alone is invisible to the
  Commander; `send_message` reaches his dashboard and phone.
- **Never `git stash` while other worktrees are live.** Worktrees share one
  object store, and the stash is a REPO-GLOBAL stack: `pop` takes the top entry,
  not *your* entry. Two agents stashing concurrently means one pops the other's
  work into the wrong tree, silently, with the damage landing in someone else's
  files. It has already happened once — recovered in full only because the agent
  noticed and reported it. Use a **scratch commit on your own branch** instead:
  it is per-worktree, it is named, and nobody else can take it. If you do pop
  something that is not yours, re-push it with `-u` and the same paths rather
  than deleting it.

## Commands

All of these run from the repo root and cover every workspace.

```sh
npm test          # every workspace's unit tests, one pass
npm run typecheck # root tooling + tsc --noEmit per workspace
npm run verify    # typecheck + test — run this before pushing
npm test -w backend             # one workspace, focused
npm run ping -- "your prompt"   # live end-to-end check
```

**Adding a workspace**: create `<name>/package.json` and a `<name>/tsconfig.json`
extending `tsconfig.base.json`, then add `<name>` to `workspaces` in the root
`package.json`. CI fails if a workspace has source under `src/` and no tests
under `tests/` (`scripts/check-workspaces-tested.mjs`).

## Delivery today

Adjutant's MCP server attaches automatically in headless mode, and
`send_message` to `"user"` pushes APNS to the Commander's phone. **Adjutant is a
working comm channel right now** — the open question of which messaging platform
to add is about *additional* surfaces and blocks nothing.

## Environment notes

- **Two different backends, two different ports, and confusing them has already
  cost a real failure.** `.mcp.json` points at **4201** — that is *Adjutant's*
  backend, the MCP server Syl's agents use for messaging. **Syl's own service
  runs on 8888.** The line here used to say only "backend runs on 4201", which
  predated Syl having a backend at all; an agent read it as Syl's port, and Syl
  would have failed to bind on every boot forever with Adjutant already holding
  4201 — and worse, a by-hand run bound `*:4201` *alongside* Adjutant's
  `127.0.0.1:4201`, which do not collide but coexist, so MCP calls landed on a
  server with no `/mcp` route and took Adjutant's connection down. A collision
  that fails loudly costs a boot; one that half-succeeds takes out the
  neighbour.
  **Never start the Syl service by hand without an explicit port.** The
  integration tests are safe — they bind a random high port — which is also why
  no test could ever have caught this.
  Ports around here: Adjutant 4200/4201, contract mock 4210, Syl admin dev 4211,
  and **Syl's service on 8888**, deliberately outside the 42xx block rather than
  merely free within it.
- The shell has `noclobber` set — a plain `>` fails if the file exists. Use `>|`.
- `--verbose` is mandatory alongside `--output-format stream-json` in `-p` mode.
- Headless sessions are pre-authorised (`--permission-mode bypassPermissions`)
  and MCP-scoped (`--strict-mcp-config`). Without both, the CLI default asks for
  approval nobody can give and the model thrashes across every ambient MCP
  server — measured at 44 turns and $0.39 for one question that should cost 3
  turns and $0.05. Constraining the tool surface is the outstanding follow-up;
  it also bounds what `bypassPermissions` can reach.
- **`--tools` and `--allowedTools` are different mechanisms, and the difference
  is a security boundary.** `--allowedTools` pre-approves names from whatever is
  already available; `--tools` sets *what is available at all* (`--tools ""`
  disables every built-in tool). To make a turn incapable of acting — which is
  what reading untrusted content requires — you need `--tools`, not
  `--allowedTools`. Verified against `claude --help` on 2.1.226.
- **`runTurn` has no default permission mode** (as of `syl-001.3.4`). It used to
  default to `bypassPermissions`, which is correct for a headless turn nobody
  can approve and actively dangerous the moment untrusted text enters a prompt.
  Each call site now opts in: `SylAgent` asks for `bypassPermissions` because it
  is the Commander's own trusted conversation, and `runReaderTurn` does not.
- **Reading anything fetched goes through `runReaderTurn`** (`harness/reader.ts`),
  never `runTurn`: `--tools ""`, `--strict-mcp-config` with no MCP config, no
  pre-authorisation, a session that is never resumed or persisted, and output
  that is schema-validated or discarded. It throws if the tool surface comes
  back non-empty, so a CLI change cannot silently reopen the hole.
- Every turn gets its session id **before** the spawn, via `--session-id <uuid>`
  (honoured exactly on 2.1.226; both init and result echo it). `TurnOptions.
  onSessionId` fires pre-spawn so the id can be persisted first — a crash
  between spawn and init used to strand a conversation that existed on disk.
- `runTurn` kills a turn that produces no result within `timeoutMs`
  (`DEFAULT_TURN_TIMEOUT_MS`, 10 minutes) and throws `TurnTimeoutError`.
- Session continuity is **per lane** — `commander`, `heartbeat`, `agenda`,
  `consolidation` — each in its own file under `.syl/sessions/`. One shared id
  would interleave Syl's inner monologue with talking to the Commander.
- Node **22** is required (`.nvmrc` pins 22.23.1). Node 20 is end-of-life and
  lacks `node:sqlite`. Verified on 22.23.1: `node:sqlite` imports without a flag
  (SQLite 3.51.3) and **FTS5 is compiled in**, so keyword search needs no native
  dependency. It still prints an `ExperimentalWarning`.
- The `claude` binary is resolved by `backend/src/harness/claude-bin.ts`, not by trusting `PATH`.
  Claude Code installs to `~/.local/bin`, which shell profiles add for
  interactive use — so the same machine resolves under zsh and throws `ENOENT`
  under bash. Override with `CLAUDE_BIN=/full/path/to/claude` if resolution ever
  fails; the error message lists everything it searched.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
