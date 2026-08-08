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

```
src/protocol.ts   pure codec — JSON lines <-> typed events. Zero I/O.
src/session.ts    runTurn(): one subprocess per turn
src/agent.ts      SylAgent: continuity + stale-session recovery
src/schedule.ts   wall-clock scheduling + quiet hours
src/cli/ping.ts   end-to-end smoke test
SOUL.md           Syl's standing orders, appended to the system prompt
docs/CONTEXT.md   exploration record and decision log
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

## Commands

```sh
npm test          # unit tests
npm run typecheck # tsc --noEmit
npm run ping -- "your prompt"   # live end-to-end check
```

## Delivery today

Adjutant's MCP server attaches automatically in headless mode, and
`send_message` to `"user"` pushes APNS to the Commander's phone. **Adjutant is a
working comm channel right now** — the open question of which messaging platform
to add is about *additional* surfaces and blocks nothing.

## Environment notes

- Backend runs on port **4201**. Read it from `.mcp.json`; do not assume 3001.
- The shell has `noclobber` set — a plain `>` fails if the file exists. Use `>|`.
- `--verbose` is mandatory alongside `--output-format stream-json` in `-p` mode.
