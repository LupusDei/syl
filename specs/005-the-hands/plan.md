# Plan — The Hands (`syl-009`)

## The architectural decision, and why

**Her tools call Syl's own HTTP API over loopback. They do not reach into the
services in-process.**

The tempting shortcut is to hand the MCP server the `ReminderService` object
directly — it is in the same process, it is right there, and it would be faster.
It is wrong. Validation, idempotency, quiet-hours deferral and the store's CHECK
constraints are enforced at the API boundary. A second path into the same data
would have to re-implement every one of them, and the day it drifts is the day a
reminder she created behaves differently from one the phone created.

One door. She queues at it like everyone else.

Cost: a loopback HTTP round trip per tool call, on a service already on the
machine. Irrelevant against a multi-second turn.

## A third scope: `agent`

`0014_api_key_scope.sql` gave `api_keys` a scope of `device | admin`. This adds
`agent`, and the reasoning is the same as it was there — **what matters is not
the column but where a value can be created, and what it can reach.**

| scope | who | may |
|---|---|---|
| `device` | his phone | read and write his data |
| `admin` | the operator, from the CLI only | read the logs |
| `agent` | Syl herself | write reminders, to-dos, goals — and nothing else |

Why not simply give her a device key: because then her actions are
indistinguishable from his in the log, revoking her means unpairing his phone,
and she inherits capabilities she must never have — pairing another device, or
reading the log of everything she has done.

`agent` is minted only by the service for itself, at boot, into its own store.
It is never returned over the network by any route, and `POST /auth/pair` still
cannot produce one.

## Where things go

```
backend/src/tools/server.ts          the MCP server: stdio, one process per turn
backend/src/tools/tools.ts           the tool definitions and their schemas
backend/src/tools/client.ts          a thin HTTP client for Syl's own API
backend/src/tools/time.ts            human time -> { wallTime, tz } or a refusal
backend/src/services/api-key-service.ts   + the `agent` scope
backend/src/middleware/auth.ts       + scope checks on the write routes
backend/src/index.ts                 mint the agent key at boot; write the MCP config
backend/src/harness/agent.ts         hand the config to the commander lane only
backend/src/migrations/00NN_agent_scope.sql
```

Check the highest existing migration number before writing one. Two agents
collided on `0009` in a single day.

## The part that is actually hard

**Turning human time into stored time.** `CreateReminderInput` wants
`{ text, wallTime, tz, date?, rrule?, urgent? }`. The model produces the
interpretation; `tools/time.ts` decides whether that interpretation is usable.

- "in five minutes" — unambiguous, relative to now
- "at 7am" — ambiguous. Today or tomorrow? Resolve against his configured zone
  and the current instant: the next 7am that is still in the future
- "tomorrow morning" — a convention, and it must be stated rather than guessed
- "every Tuesday" — an `rrule`, not a date
- **anything it cannot resolve confidently must come back as a QUESTION.** A wrong
  guess is worse than a question, because he will not discover it until the moment
  the reminder did not arrive

This module is pure and deterministic given a clock. It is where the tests live.

## Phases

1. **The scope** — `agent` scope, minted at boot, denied everything but writes
2. **The client and the clock** — HTTP client + human-time resolution, both pure
3. **US1: reminders** — the tool, end to end, against a real service
4. **US2: to-dos and goals** — the same shape, once the first is proven
5. **US3: visibility** — arguments in `turn.tool`, revocation, attribution
6. **US4: containment** — commander lane only, reader provably untouched
7. **Proof** — the acceptance test, and the live one

Phases 3 and 4 are parallel once 2 lands. 6 can be written first — it is a test
that must keep passing.

## Risks

- **She sets a reminder for the wrong time and he trusts it.** Mitigated by
  refusing ambiguity rather than guessing, and by the reminder being visible in
  the app the moment it is made.
- **A tool call that fails silently.** She must be told the outcome and say so;
  the failure must reach the conversation, not just the log.
- **Scope creep into "she can do anything".** The tool list is the boundary.
  Adding to it is a decision, not a convenience.


## Bead Map

- `syl-009` — Syl 9: the hands
  - `syl-009.1` Phase 1: the agent scope — `.1.1` `.1.2` `.1.3`
  - `syl-009.2` Phase 2: the client and the clock — `.2.1` `.2.2`
  - `syl-009.3` US1: reminders — `.3.1` `.3.2` `.3.3` `.3.4` `.3.5`
  - `syl-009.4` US2: to-dos and goals — `.4.1` `.4.2`
  - `syl-009.5` US3: visible and reversible — `.5.1` `.5.2`
  - `syl-009.6` US4: containment — `.6.1` `.6.2`
  - `syl-009.7` Proof — `.7.1` `.7.2`
