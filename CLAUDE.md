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
6. **The SYSTEM never deletes an inferred edge. It demotes it.** Confidence
   decays toward zero asymptotically and never arrives — a dormant edge stays
   addressable, so if it ever becomes relevant it can be promoted straight back
   to high confidence. Commander's call, 2026-08-09, overruling the prune
   recommendation in proposal `62329e61` §4 exactly where that proposal invited
   him to. Same instinct as constraint 4: **the system does not get to silently
   discard things.** Nodes are superseded, edges are demoted, decay destroys
   nothing.
   **The Commander's explicit order is the one exception** (his ruling,
   2026-08-10). When he says delete this memory, the memory and its edges are
   *removed*, not demoted and not suppressed. Read the rule for what it defends:
   it protects him from a system that quietly forgets, never from his own
   authority over his own data. A "forget this" that leaves the thing on disk is
   not honouring the constraint, it is disobeying him — and the residue is
   real, because an inference's reasoning text can quote what it reasoned over.
   Automatic paths (decay, sweeps, cleanup, the dream) get no such exception and
   must remain incapable of deletion.
7. **Every dream session is logged permanently, and the log is not memory.**
   Observability is a first principle of the memory build, not a later phase —
   a memory system that cannot be inspected cannot be tuned. The dream log is
   telemetry *about* the graph and must live in its own store; writing it into
   the graph would make Syl dream about her own dreams. Err toward logging too
   much; revisit only if it becomes burdensome at scale.

## Architecture in one line

Drive `claude -p --input-format stream-json --output-format stream-json --verbose`
as one subprocess per turn, with continuity via `--resume`.

One process per turn **is no longer forced** (re-measured 2026-08-09 on CLI
2.1.226). A `result` now arrives with stdin still open, so one process can serve
many turns. Follow-up turns cost **~1.4s** against **~5.5-9.7s** for a fresh
spawn — 4-7x, on every turn Syl takes. `runTurn` has not been changed yet:
`syl-per1`. Reproduce with `node scripts/experiments/persistent-session.mjs`;
details in `docs/CONTEXT.md` §3.

The old note said the opposite, was correctly measured, and had silently decided
the whole architecture. **Load-bearing measurements against someone else's binary
need a version stamp and a re-run.**

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
  src/routes/admin.ts             serves the built web admin at /admin
  src/ops/admin-bundle.ts         where that bundle is, and what a missing one does
  src/harness/schedule.ts         wall-clock scheduling + quiet hours
  src/ops/build-info.ts           what this process was BUILT FROM. Never asks git.
  src/ops/deploy.ts               deploy, health-gate, roll back. All seams injected.
  src/ops/deploy-gate.ts          may this commit be deployed? The CI gate.
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
- **An acceptance test describes CORRECT behaviour, never current behaviour.**
  If the behaviour is not built yet, the test stays **red** saying what should
  happen, and goes in `tests/expected-failures.json` with a bead. Never soften
  it into asserting what the code does today. We did exactly that and it caused
  the worst defect in this project: `should leave the Commander talking to
  himself: no assistant message ever arrives` sat green while Syl could not
  reply to anyone. That is worse than no test — it locks in the defect, has to
  be rewritten rather than deleted, and makes a green suite claim the story
  works.
  The gate is therefore **"failures == declared"**, not "zero failures"
  (`npm run verify`). It is strict both ways: an undeclared failure is red, and
  **a declared test that starts PASSING is also red**, so you must promote it
  out of the file. A list that only grows is a list nobody trusts. Do not reach
  for `it.fails` — it shows a green tick under the correct-behaviour name, and
  it passes when the test fails for *any* reason, including a typo.
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
- **Run the gate in your own worktree, never in the main checkout — and if you
  must work there, `git add` explicit paths.** The stash is repo-global; so is
  the working tree, and it bites the same way. `npm run verify` reads the tree as
  it finds it, so another agent's half-finished edit becomes *your* red run,
  naming *their* subsystem. That happened on 2026-08-10: nine failures appeared
  in the sealed reader path — including the injection-containment tests — from
  one uncommitted line changing what `runTurn` returns. Nothing was broken and it
  was nearly reported as a security regression.
  The commit half is worse because it is silent. A `git add -A` in a shared
  checkout sweeps up whatever anyone else has in flight and publishes it under
  your name, in a commit whose message describes something else entirely. Stage
  the paths you touched, by name, every time. `-A` and `.` are how you steal work
  without noticing.

## Commands

All of these run from the repo root and cover every workspace.

```sh
npm test          # every workspace's unit tests, one pass
npm run typecheck # root tooling + tsc --noEmit per workspace
npm run verify    # typecheck + test — run this before pushing
npm test -w backend             # one workspace, focused
npm run ping -- "your prompt"   # live end-to-end check
npm run deploy -- --dry-run     # what a deploy would do, touching nothing
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
- **Migration numbers: the LOWEST free number goes to whoever is CERTAIN to need
  one.** `readMigrations` enforces a contiguous sequence and hard-fails on a gap,
  so a file numbered above a missing one takes down every test that opens a
  database — for a reason its author did not cause. A missing *highest* number is
  not a gap. Assign the low number to a maybe and you have staked the suite on
  work that may never happen. Got this backwards three times in one day
  (`syl-acr`); each time an agent caught it, and each time the guard reported a
  duplicate version loudly with both filenames rather than silently skipping a
  migration. That guard is why these stay ten-minute problems.
- **Checking ORIGIN is necessary and NOT sufficient — ask two questions, not
  one.** The rule below answers *which number is free*. It says nothing about
  *which numbers your branch can hold*. A branch that is behind cannot satisfy
  contiguity at the number origin says is free: take it, and you leave a gap
  under it, and `readMigrations` hard-fails on a gap — reddening every
  database-backed test for a reason its author did not cause. Origin was at
  `0024` while a branch sat at `0023`, so both obvious moves were wrong.

      git ls-tree --name-only origin/main backend/src/migrations/   # what is free
      ls backend/src/migrations/                                    # what you can hold

  The second is the one-liner nobody was running. If your branch is missing a
  number origin has, import that one file byte-identical (`git checkout
  origin/main -- <path>`) to restore contiguity rather than fast-forwarding a
  shared tree under other agents.
- **Before claiming an id or a number in a shared namespace — a bead root, a
  spec directory, a migration — fetch and look at ORIGIN, not at your branch.**
  Five collisions in one day all had this single cause: creating from a stale
  local view into a namespace someone else was actively extending. A colliding
  create can also wire itself into another epic's dependency graph, which is
  invisible unless you look for the edges rather than the rows.
- **Any command carrying PROSE takes a quoted heredoc, never a `-m`/`--flag=`
  string.** `git commit -m`, `bd create --description`, `bd update --notes`,
  `bd close --reason` — all of them. A double-quoted argument is expanded by the
  shell: `$` interpolates and **backticks execute**, so the word simply vanishes
  and the command succeeds. The sentence is left short, grammatical, and wrong.
  Four instances so far — `$5,000` out of a commit message, a field name out of
  another, and `bd create` twice, once removing `` `tools: ""` `` from the middle
  of a P0 description and leaving *"auto-memory is written BY THE MODEL through
  the Write tool.  removed Write, so auto-memory stopped"* — a sentence with its
  subject surgically extracted and still perfectly readable.

  **This repository is unusually exposed and it is the house style that does
  it.** Our comments and bead descriptions name real identifiers in backticks on
  purpose, because a comment citing the thing it is about is the convention. So
  the one codebase where backticks are everywhere is the one where the shell
  eats them, and it selects for whoever writes the most careful prose. Use
  `<<'EOF'` — quoted, so it expands nothing — and read the output for
  `command not found`, which is the only warning you get.
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
  pre-authorisation, **auto-memory off**, a session that is never resumed or
  persisted, and output that is schema-validated or discarded. It throws if the
  tool surface comes back non-empty, so a CLI change cannot silently reopen the
  hole.
  **Auto-memory is ON BY DEFAULT in headless `-p`**, so until `syl-005.1.2` the
  reader was loading Syl's `MEMORY.md` into the same context as untrusted text —
  everything known about the Commander, handed to whatever an article told the
  model to do. The captured `reader-direct` and `reader-injection` fixtures still
  show `memory_paths` in their init frames; that is the evidence, not a theory.
  `runReaderTurn` now passes `autoMemoryOff()` unconditionally and it is
  deliberately **not** exposed on `ReaderTurnOptions`, so no call site can turn
  it back on. A quarantine you have to remember to switch on is not a quarantine.
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
- **The web admin is served by Syl herself at `/admin`**, from `frontend/dist`
  (`SYL_ADMIN_DIR` to move it). Same origin as `/api/v1`, so there is no CORS,
  no second certificate and no ATS exception in the iOS app. `npm run build`
  produces the bundle and **fails loudly if it is not emitted** — a missing
  bundle must never degrade into a 404, which reads as a routing bug. The
  frontend's Vite `base` and `ADMIN_BASE_PATH` must be the same string;
  `backend/tests/integration/admin-bundle.test.ts` builds for real and checks it.
- **`GET /logs` is the one route a paired phone may not call, and the scope that
  stops it is minted only at the console.** Every other read in the contract is
  the Commander's own data; the log is the record of what a *pre-authorised
  program did on his machine* — every turn, every tool call. So `api_keys` has a
  `scope` (`0014_api_key_scope.sql`): `POST /auth/pair` always mints `device`,
  and `admin` comes from **`npm run pair -- --admin`** and from no HTTP route at
  all. That asymmetry is the whole security argument — pairing is reachable over
  the tailnet behind eight digits, minting an admin key needs write access to
  `syl.db`, which is already full compromise. A device token gets `403
  FORBIDDEN`; an anonymous caller gets the ordinary indistinguishable 401, so
  the scope is never disclosed to someone who has not authenticated.
  **Existing keys backfilled to `device`**, which is why the admin's logs view
  asks for a new token the first time. `authed-fetch.ts` deliberately no longer
  signs out on 403 — the key works everywhere else, and dropping it would send
  the operator back to the gate to paste the same one in again.
- **`res.sendFile` with an ABSOLUTE path 404s if any directory in it starts with
  a dot.** `send` cannot tell caller-supplied path from request-supplied path,
  so it refuses the lot — a bundle under `~/.syl/` or an agent worktree in
  `.claude/` silently disappears. Always `sendFile(name, { root })`.
- **`/health` reports the commit and build time the running process was BUILT
  FROM**, stamped into `backend/dist/build-info.json` by
  `backend/scripts/write-build-info.mjs` during `npm run build`. **Never shell
  out to git at request time.** The two answers differ exactly when it matters:
  a service that asked git would have reported the *new* commit throughout the
  three hours it was running the old one. A stale build is invisible by
  construction — every check passes, because the old build is perfectly
  healthy — and `bash scripts/syl-verify.sh stale` is the one check that can
  fail because of it. Because the stamp lives inside `dist/`, it travels with a
  rolled-back build automatically.
- **Deploys go through one gate and there is no bypass.** `npm run deploy` and
  the unattended `com.jmm.syl.update` job both call `decideDeploy`
  (`ops/deploy-gate.ts`), which deploys only a commit whose GitHub check runs
  have passed. Every ambiguous answer — pending, no checks at all, an unknown
  conclusion string, GitHub unreachable — means do not deploy. `--unattended`
  only makes a run *stricter*. `deploy-gate.test.ts` asserts that no
  combination of options lets an ungreen commit through, so a bypass added
  later fails the suite. **Do not add a way for the service to deploy itself.**
- The health gate after a restart asks "does she answer **as the new commit**",
  not "does she answer". Those differ in the case that matters: if the new build
  fails to load, `KeepAlive` can leave the previous process answering perfectly.
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
