# Syl — The List

**Feature**: 008-the-list
**Epic**: `syl-011`
**Status**: Draft
**Priority**: P1
**Depends on**: nothing. The server half is already built and tested.

## Summary

Syl owns his to-dos, goals and objectives. He cannot see any of them.

The app has three tabs — Today, Chat, Settings. The day screen renders a spine of
moments, which is genuinely what's due. Everything else the assistant is *for* is
invisible: there is no list of open to-dos, no goal anywhere, no way to finish a thing
without waiting for its notification to arrive.

## What is actually missing, and what is not

**The server is done.** Routes, services, migrations, contract, sync resolvers and tests
exist for goals, to-dos and reminders. `GET /sync` already resolves all three.
`shared/openapi.yaml` publishes `/goals`, `/todos`, `/reminders`, `/todos/{id}/complete`,
`/reminders/{id}/complete`, `/reminders/{id}/snooze`. **This is a client epic.** Anyone
planning it as full-stack work will spend a week rebuilding something that already
passes its own tests.

Three concrete holes, in the order they block each other:

1. **The device has no `goal` table at all**, and `SyncEngine` drops goals on the floor —
   `case .goal, .device, .delivery, .job, .run:` ignores them. A goal screen written
   before this is a screen that must hit the network to show anything, which breaks
   local-first on its first frame.
2. **Completion only works from the notification.** `DaySpine.onSelect` is a wired-up
   stub whose own comment says so: *"Completion lands later; the affordance is here so
   the layout is built around a real touch target."* So a to-do he finishes at his desk
   stays open until its reminder fires.
3. **There is no capture.** Every to-do that exists was created by talking to Syl. That
   is a lovely primary path and a terrible only path — it means nothing can be written
   down while she is unreachable.

## The acceptance criterion

> **He can see everything he owes, finish any of it in one tap, write a new one down in
> one sentence, and look at a goal and know whether it is actually moving — all of it
> instantly, from disk, with the server unreachable.**

If any surface here opens on a spinner, this epic is not done regardless of how many
beads are closed.

## Navigation — decided, and it costs no new tabs

The home screen already carries three glass orbs, and their own documentation says what
they are for:

> **The three orbs are doors, not statistics.** The concept labels them Goals / Memory /
> Today. Only `today` is wired; the other two are the next screens.

So the doors exist and one of them is this epic's front door.

- **Today** stays primary — the day spine, what's due, unchanged in purpose.
- **Goals** opens from the Goals orb.
- **Everything open** — to-dos with no date, which by definition never appear in a day —
  lives at the **foot of the day**, one tap below today's moments. That is where he
  looks when today is done, and it keeps the morning agenda as the place things surface
  rather than making him hunt in a fourth tab.
- **Memory** stays dark; it belongs to `syl-010`.
- **Reminders are not a screen.** A reminder is a scheduled utterance attached to a
  thing; it is managed on the row that shows it. A separate reminders tab would be a
  list of alarm clocks divorced from what they are about.

**No new tabs.** Four tabs is where a tab bar starts to feel like a filing cabinet, and
this app is a person.

## What proposal B refuses, and this therefore must not build

These are not omissions. They are the design.

- **No priority ladder.** *"Priority is a property of a moment, not of a task. A stored
  priority is stale within a day."* Ordering is computed. The one durable bit is
  `pinned`.
- **No percent-complete on goals.** *"Self-reported percentages are fiction and they
  decay. Progress is evidenced."*
- **No tags, contexts, energy levels or areas.** *"A taxonomy he must apply at capture."*
- **No confirmation step on an explicit ask.** *"An explicit ask is never provisional."*

And the rule the whole capture design hangs on:

> **They die at capture, not at review.** Every field a human must fill in is a tax
> collected at the moment of lowest motivation.

## User Scenarios & Testing

### User Story 1 — He can finish a thing (Priority: P0)

**As** the Commander, **I want** to complete or defer something from inside the app,
**so that** finishing a task does not require waiting for its notification.

**Why this priority**: It is the largest gap between what the app shows and what it lets
him do, it needs no new screen, and the touch target is already there and inert.

**Independent Test**: Tap a row on the day spine; it completes, the row settles, and it
is still complete after force-quitting with the server unreachable.

**Acceptance Scenarios**:

1. **Given** an open to-do on the spine, **When** he completes it, **Then** it renders as
   done immediately and the intent is in the outbox before any network call.
2. **Given** the server is unreachable, **When** he completes something, **Then** it
   still completes on screen and syncs later — with no error and no spinner.
3. **Given** a reminder, **When** he defers it, **Then** the new instant comes from the
   **server**, never the device — a phone that is wiped must not take his deferrals with
   it.
4. **Given** a completed to-do, **When** the same completion is retried by the outbox,
   **Then** it is not applied twice.
5. **Given** an already-finished to-do, **When** completion is attempted again, **Then**
   it is refused rather than cheerfully reporting success.

---

### User Story 2 — He can write it down in one sentence (Priority: P1)

**As** the Commander, **I want** to capture a to-do without filling in a form, **so
that** writing it down costs less than remembering it.

**Why this priority**: Without capture, everything must go through conversation, and
nothing can be recorded while she is unreachable.

**Independent Test**: Type one sentence, commit it, and it appears — with no date, no
priority, no goal, no category — and survives a relaunch offline.

**Acceptance Scenarios**:

1. **Given** the capture field, **When** he types a sentence and commits, **Then** a
   to-do exists with only text and a timestamp, and every other column is null.
2. **Given** a captured to-do, **When** it is written, **Then** there is **no
   confirmation step and no inbox** — an explicit ask is never provisional.
3. **Given** the server is unreachable, **When** he captures, **Then** it is durable on
   the device and queued with an idempotency key.
4. **Given** an empty or whitespace-only capture, **When** he commits, **Then** nothing
   is written.

---

### User Story 3 — He can see everything he owes (Priority: P1)

**As** the Commander, **I want** a list of every open to-do, **so that** things without a
date are not invisible.

**Why this priority**: A to-do may have no time at all, and the day spine can only ever
show things with one. Today, those to-dos exist on the server and appear nowhere.

**Independent Test**: With several dated and undated to-dos on disk, the list shows all
of them, ordered sensibly, offline.

**Acceptance Scenarios**:

1. **Given** to-dos with and without due dates, **When** the list opens, **Then** all
   appear, and ordering is **computed** — deadline, then pinned, then staleness — not
   read from a stored priority.
2. **Given** a pinned to-do, **When** the list orders itself, **Then** pinned survives as
   the one durable signal of "this one matters".
3. **Given** no open to-dos, **When** the list opens, **Then** it says so as a clear day
   rather than showing an empty table.
4. **Given** a to-do linked to a goal, **When** it renders, **Then** the goal is visible
   on it without the row becoming a form.

---

### User Story 4 — A goal tells him the truth (Priority: P1)

**As** the Commander, **I want** to open a goal and know whether it is actually moving,
**so that** review is based on what happened rather than on how I felt when I last
touched it.

**Why this priority**: This is the whole reason goals are in Syl rather than in a notes
app, and it is the surface with the most design risk — it is where a percent-complete
bar would be easiest to add and most wrong.

**Independent Test**: A goal with linked closed to-dos shows them as evidence; a goal
with nothing shows nothing, and says nothing has happened.

**Acceptance Scenarios**:

1. **Given** a goal, **When** it opens, **Then** it shows title, `why`, target date and
   **evidence** — what actually happened and when — and **no percentage anywhere**.
2. **Given** a goal with no linked activity, **When** it opens, **Then** it says nothing
   has happened, which is true, rather than showing 0% or an empty chart.
3. **Given** a goal whose last activity is older than its cadence, **When** it renders,
   **Then** **silence** is shown as a risk signal.
4. **Given** a goal with a target and a rate, **When** risk is shown, **Then** the
   arithmetic is reported as **both numbers** — required rate and observed rate — not as
   a judgement.
5. **Given** an abandoned goal, **When** it renders, **Then** it reads as a
   **non-shameful** outcome and its history is intact.
6. **Given** nested goals, **When** they render, **Then** the parent link is visible and
   the horizon is **derived** from the target date rather than stored.

---

### User Story 5 — He can choose the light (Priority: P2)

**As** the Commander, **I want** to choose the app's appearance, **so that** the app is
one product rather than a dark home screen next to a light conversation.

**Why this priority**: A real inconsistency he found himself. Small, contained, and it
finishes the "one product" argument `syl-008` started.

**Independent Test**: Set Day; every screen including Home is light. Set Night;
everything is night. Set System; the app follows iOS.

**Acceptance Scenarios**:

1. **Given** the setting, **When** he chooses System / Day / Night, **Then** the choice
   applies to the whole app and survives a relaunch.
2. **Given** Day, **When** Home renders, **Then** the scene falls back to the still
   rather than putting a starfield in a bright frame.
3. **Given** System, **When** iOS changes appearance, **Then** the app follows without a
   relaunch.

---

### Edge Cases

- A to-do completed on the phone and on the Mac in the same minute.
- A deferral requested while offline — the server owns the new instant, so what does the
  row say in the meantime?
- A goal with a target date in the past.
- A goal whose parent was abandoned.
- Five hundred open to-dos.
- A to-do whose text is a paragraph.
- Completion of a to-do that the server has already deleted.

## Requirements

### Functional

- **FR1** Every surface renders from the local database, with no loading state.
- **FR2** Every write goes to the outbox with an idempotency key, and renders
  optimistically.
- **FR3** Complete and defer work from inside the app, for both to-dos and reminders.
- **FR4** A deferral's new instant comes from the server, never the device.
- **FR5** Capture creates a to-do from text alone; every other column is null.
- **FR6** Goals are stored on the device and reconciled by `SyncEngine`.
- **FR7** A goal shows evidence and risk. No percentage exists anywhere in the UI.
- **FR8** Ordering is computed at read time. No stored priority.
- **FR9** Appearance is System / Day / Night, applied app-wide and persisted.

### Non-functional

- **NFR1** No screen in this epic may show a spinner on open.
- **NFR2** A list of 500 to-dos scrolls without dropped frames.
- **NFR3** Dynamic Type to the largest accessibility size; every turn and row is a
  coherent VoiceOver element; 44pt minimum targets.
- **NFR4** Reduce Motion removes ambient motion exactly as elsewhere.
- **NFR5** No stock system colours in any new view. `SylTheme` throughout.
- **NFR6** No new third-party dependency.

## Success Criteria

- He stops asking Syl what he has to do in order to find out what he has to do.
- A thing finished at his desk is finished everywhere, without waiting for an alarm.
- A goal he has not touched in a month says so, out loud, without being asked.
- Chat, Today, the list and a goal screenshot as one product.

## Out of Scope, and why

- **A reminders screen.** A reminder is a scheduled utterance attached to a thing, not a
  thing itself. It is managed on the row that shows it.
- **The `proposed` state UI** — structure Syl infers from conversation. It is real work
  in proposal B, and it is gated on a taste decision that is currently with the
  Commander. Its own phase, droppable without unpicking anything.
- **Memory browsing.** `syl-010`.
- **A widget or Live Activity.** Proposal E defers it and so does this.
- **Editing a goal's fields in the app.** Capture is a sentence; curation is a
  conversation. Revisit only if he asks.
- **Multi-user / family goals.** Filed with the Commander; single-user until answered.
