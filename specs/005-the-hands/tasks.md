# Tasks — The Hands (`syl-009`)

`[P]` = parallelisable (different files, no ordering dependency).

## Phase 1 — The `agent` scope

- **T001** Add `agent` to `KeyScope` in `backend/src/services/api-key-service.ts`,
  and a migration adding it to the CHECK constraint. **Check the highest existing
  migration number first.** Existing rows keep their scope; nothing backfills to
  `agent`.
- **T002** Mint the agent key at boot in `backend/src/index.ts` if absent, into
  Syl's own store. It is never returned by any route and `POST /auth/pair` still
  cannot produce one. Test that.
- **T003** Scope checks in `backend/src/middleware/auth.ts`: `agent` may write
  reminders, to-dos and goals; it may NOT pair a device, read `/logs`, or touch
  `/devices`. A denial is a 403 behind the ordinary 401, as `admin` already is.

## Phase 2 — The client and the clock

- **T004 [P]** `backend/src/tools/client.ts` — a thin HTTP client for Syl's own
  API over loopback, carrying the agent key and generating an idempotency key per
  call. It must surface a structured failure, never throw a bare string.
- **T005 [P]** `backend/src/tools/time.ts` — resolve human time to
  `{ wallTime, tz }` or an explicit `Ambiguous` result. Pure, clock-injected.
  IANA zones only, never an offset. Cover: relative ("in five minutes"), absolute
  ("at 7am" → the next future 7am), conventional ("tomorrow morning" — state the
  convention in a comment), recurring ("every Tuesday" → rrule), and the refusals.

## Phase 3 — US1: reminders

- **T006** `backend/src/tools/tools.ts` — `create_reminder`, `list_reminders`,
  `cancel_reminder`, with JSON schemas the model can actually satisfy.
- **T007** `backend/src/tools/server.ts` — the MCP server over stdio, exposing
  only those tools.
- **T008** Wire it: `backend/src/index.ts` writes the MCP config; the commander
  lane's `TurnOptions` carries `mcpConfig` + `strictMcpConfig: true`.
- **T009** Confirm creation FROM THE STORE, not from her intention, and return
  the stored reminder to her so she can tell him what she actually made.
- **T010** A tool failure reaches the CONVERSATION, not only the log. She says
  what went wrong.

## Phase 4 — US2: to-dos and goals

- **T011 [P]** `create_todo`, `list_todos`, `complete_todo`.
- **T012 [P]** `create_goal`, `list_goals`.

## Phase 5 — US3: visibility and control

- **T013** `turn.tool` logs the tool ARGUMENTS, not just the name. That line is
  the record of what she did on his machine.
- **T014** Revoking the agent key stops her acting and leaves the phone working.
  Test both halves.

## Phase 6 — US4: containment

- **T015** The tools reach the commander lane ONLY. A test asserts the reader
  turn's tool surface is still empty and that it carries no MCP config —
  `runReaderTurn`'s security property must hold by construction.
- **T016** A static test that the MCP config is referenced from exactly one place,
  so it cannot be handed to another lane by accident.

## Phase 7 — Proof

- **T017** Acceptance: `us6-she-can-act.test.ts` — "remind me in five minutes"
  through the real conversation path produces a stored reminder with the right
  wall time. Written RED first and declared in `tests/expected-failures.json`
  under `syl-009` until it passes.
- **T018** The live proof, by hand: ask her from the phone, lock it, and receive
  the notification. This is the acceptance criterion and it cannot be automated.
