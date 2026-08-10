# Syl — The Hands

**Feature**: 005-the-hands
**Epic**: `syl-009`
**Status**: Planned
**Priority**: P0
**Derived from**: `syl-act1` (P0 bug)

## Summary

Syl can hold a conversation and cannot do anything.

The Commander asked her, on his phone, to remind him in five minutes. She replied
the way an assistant would. No reminder was written, no job scheduled, nothing was
ever going to arrive. The turn produced **text and no action**.

Every piece of the machinery exists and is tested: `ReminderService`, the wall-clock
scheduler, the job runner, the outbox, quiet hours, delivery, APNs, `TodoService`,
`GoalService`, and HTTP routes for all of it. **Nothing connects a conversation to
any of it.** `SOUL.md` tells her reminders matter and never tells her how to make one.

This epic gives her hands.

## Why this is the highest-value work left

It is the gap between "she can hold a conversation" and "she is an assistant". The
project is named for proactive reminders that arrive at the right wall-clock moment;
today she cannot create one. Push is proven, delivery is proven, the phone is paired
— the only missing link is her ability to *act*.

## The acceptance criterion

> **The Commander says "remind me in five minutes" from his phone, and five minutes
> later his phone buzzes.**

Nothing else in this epic matters if that sentence is not demonstrably true.

## User stories

### US1 — She can set a reminder (P0)

**As** the Commander, **I want** to ask for a reminder in plain language, **so that**
I stop being the one who remembers.

- "remind me in five minutes", "at 7am", "tomorrow morning", "every Tuesday" all work
- The reminder is visible in the app immediately, not only when it fires
- **A time she could not understand is a QUESTION, never a silent failure or a guess.**
  Guessing at "later" and being wrong is worse than asking.
- Quiet hours still defer rather than drop (constraint 4)
- Timezones are IANA (constraint 5). "In five minutes" is unambiguous; "7am" is not,
  and resolves against his configured zone rather than the server's

### US2 — She can keep his to-dos and goals (P0)

**As** the Commander, **I want** her to capture a to-do or a goal as we talk, **so
that** the thing I mentioned in passing is still there tomorrow.

- Creating, listing and completing a to-do
- Creating and listing a goal
- She can tell him what is outstanding without being asked twice

### US3 — What she did is visible and reversible (P0)

**As** the Commander, **I want** to see every action she took and undo any of them,
**so that** giving her hands does not mean giving up control.

- Every tool call lands in the log as `turn.tool` with its arguments
- Her credential is distinct from the phone's, so her actions are attributable
- Her credential can be revoked without unpairing his phone
- She can be denied capabilities the phone has — she must never pair a device or
  read the logs

### US4 — She cannot act where she must not (P0)

**As** whoever is responsible for this machine, **I want** the tool surface to be
structurally unreachable from untrusted input, **so that** a malicious article
cannot make her act.

- The tools reach the **commander lane only**
- `runReaderTurn` never sees them — its whole security property is a fresh,
  never-resumed, tool-less process, and that must remain true by construction
  rather than by convention
- A test proves the reader's tool surface is still empty

## Explicitly out of scope

Memory (`syl-005`), the daily rhythm's content (`syl-006`), self-update
(`syl-dep1` deliberately has no bypass), calendar and email, and any tool that
writes code or touches the repository. She gets the product's own nouns and
nothing else.

## Constraints

All five non-negotiables. Two bite hardest here:

**Constraint 4 — never silently drop a reminder.** She is now the one creating them,
so a reminder she thought she made and did not is the same broken promise as one that
vanished. Creation must be confirmed from the store, not from her intention.

**Constraint 5 — IANA zones, never offsets.** She is translating human time into
stored time, which is exactly where an offset gets baked in and drifts an hour at the
DST boundary.

## Success criteria

- "Remind me in five minutes" produces a notification five minutes later
- An ambiguous time produces a question, not a guess
- Every action she takes is in the log with its arguments
- Revoking her credential stops her acting and leaves the phone working
- The reader turn's tool surface is provably still empty
