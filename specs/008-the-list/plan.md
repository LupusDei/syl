# Implementation Plan — The List

**Feature**: 008-the-list
**Epic**: `syl-011`
**Spec**: [spec.md](./spec.md)

## What the survey changed

Four findings moved this plan a long way from where it started. Read them before
estimating anything.

**1. The server is finished. This is a client epic.**
`backend/src/routes/{goals,todos,reminders,deliveries,sync}.ts`, their services,
migrations `0005`–`0010`, and unit tests all exist and pass. `shared/openapi.yaml`
publishes every operation this needs. `GET /sync` resolves all three types. Planning
this as full-stack work would spend a week rebuilding something already under test.

**2. The write transport is finished too, and this is the surprising one.**
`Outbox.Kind` already declares `completeTodo`, `createTodo`, `createReminder`,
`snoozeReminder`, `completeReminder`, and `SyncEngine`'s flush already sends every one
of them through `SylAPI` with the record's idempotency key. **Do not touch that code.**
It is not a stub; it is a working path with nothing calling it.

**3. What is actually missing at the write layer is the optimistic half.**
`LocalStore` has exactly one write helper — `enqueueSend`, for chat. There is no
equivalent for "mark this to-do done on disk and queue the intent in one transaction".
That single missing seam is why completion does not work in the app, and it is the
foundational task of this epic.

**4. Goals are genuinely absent, end to end on the device.**
No `goal` table in `SylDatabase`, no `LocalStore` methods, and `SyncEngine` line 222
explicitly drops them with a comment asserting the phone has no use for them. That
comment was true when it was written and is now the thing standing between the Commander
and his goals. It must be changed deliberately, not quietly.

## Architecture decisions

### D1 — One optimistic write helper per intent, in `LocalStore`, in one transaction

`enqueueSend` is the pattern and its doc comment states the rule:

> One transaction because the two halves are the same fact. A pending bubble with no
> outbox row is a message that will never be sent; an outbox row with no bubble is a
> message he cannot see he sent.

The same is true of a completion. A to-do that renders done with no outbox row is a lie;
an outbox row with no local change is a tap that did nothing. `completeTodo(id:)`,
`completeReminder(id:)`, `snoozeReminder(id:)` and `createTodo(text:)` each write the
local row and the outbox row together, or neither.

### D2 — A deferral renders as *asked*, not as *moved*

Constraint 4 of the project and proposal E agree: **the server owns the new instant.**
The device may not compute it, because a phone that is wiped would take his deferrals
with it.

So a deferred reminder does not optimistically show a new time — it has none yet. It
shows that a deferral was **asked for**, and the row settles when the server answers.
This is the one place in the epic where the optimistic render is deliberately weaker
than it could be, and getting it wrong invents a time that does not exist.

### D3 — Goals get a table, and `SyncEngine` stops ignoring them

`0007_goals.sql`-equivalent inside `SylDatabase`'s migration list, `Goal` records, and
`case .goal` moves out of the ignore list. The comment there must be rewritten rather
than deleted, because it currently asserts a design decision that is being reversed.

### D4 — Ordering is computed, in a pure function, with tests

Proposal B refuses a stored priority, so ordering is a function of deadline, `pinned`
and staleness. That function is pure, lives beside `MessageGrouping`/`TranscriptRhythm`
as a peer, and is unit-tested — not buried in a view where its rules cannot be asserted.

### D5 — Evidence is a projection, not a query per row

A goal's evidence is "what actually happened and was linked to it". Computed once, off
the main actor, in the same snapshot-loader pattern `syl-008` established — never per
row in a `body`. `syl-008` shipped a quadratic comparison into a transcript by handing
every row the whole map; that lesson is one epic old and applies exactly here.

### D6 — No new tabs. The orbs are the doors.

Decided in the spec. `HomeView`'s orbs already carry `onOpen(.goals)`; that call site
exists and goes nowhere. The full list opens from the **foot of the day**, which is
where he looks when today is done.

### D7 — Appearance is one stored preference applied at the root

`preferredColorScheme` at the app root, from a persisted `System | Day | Night`. `HomeView`
stops forcing `.dark` unconditionally and instead forces it only when the choice is
System *and* a scene is present — so an explicit Day is honoured and the scene falls
back to the still rather than putting a starfield in a bright frame.

## Phases

Each phase leaves the app shippable.

| Phase | Sub-epic | What becomes true | Ships alone |
|---|---|---|---|
| 1 | `syl-011.1` | Optimistic writes exist; goals are stored and synced | no UI change |
| 2 | `syl-011.2` | US1 — he can finish or defer a thing in the app | **yes** |
| 3 | `syl-011.3` | US2 — he can write one down in a sentence | **yes** |
| 4 | `syl-011.4` | US3 — he can see everything he owes | **yes** |
| 5 | `syl-011.5` | US4 — a goal tells him the truth | **yes** |
| 6 | `syl-011.6` | US5 — he can choose the light | **yes** |
| 7 | `syl-011.7` | Polish: scale, accessibility, and the screenshots | yes |

### Parallel opportunities

- **Phase 6 is independent of everything.** It touches `SylApp`, `HomeView` and Settings
  and nothing else in this epic. Start it on day one.
- Within Phase 1, the goal storage and the optimistic write helpers are separate files
  and can run concurrently.
- Phases 4 and 5 are different screens over the same foundation and can run concurrently
  once Phase 1 lands.
- **Phase 2 blocks nothing else**, but it is the highest value per line in the epic and
  should go first among the UI phases.

## Key files

**New**
```
ios/Syl/Features/Lists/TodoListView.swift            every open to-do
ios/Syl/Features/Lists/TodoRow.swift                 one to-do, and its affordances
ios/Syl/Features/Lists/TodoOrdering.swift            pure ordering. Tested.
ios/Syl/Features/Lists/CaptureField.swift            one sentence, nothing else
ios/Syl/Features/Goals/GoalListView.swift            goals, from the orb
ios/Syl/Features/Goals/GoalDetailView.swift          evidence and risk
ios/Syl/Features/Goals/GoalEvidence.swift            pure projection. Tested.
ios/Syl/Features/Goals/GoalRisk.swift                silence / arithmetic. Tested.
ios/Syl/Features/Settings/AppearanceSetting.swift    System | Day | Night
```

**Changed**
```
ios/Syl/Core/Store/SylDatabase.swift        the goal table
ios/Syl/Core/Store/Records.swift            GoalRecord
ios/Syl/Core/Store/LocalStore.swift         optimistic write helpers + goal reads
ios/Syl/Core/Store/SyncEngine.swift         stop ignoring .goal (rewrite the comment)
ios/Syl/Features/Home/HomeView.swift        wire the Goals orb; the foot of the day
ios/Syl/Features/Home/DaySpine.swift        onSelect stops being a stub
ios/Syl/SylApp.swift                        preferredColorScheme from the setting
```

**Deliberately unchanged**
```
backend/**                                  done, tested, and not this epic
shared/openapi.yaml                         every operation already exists
ios/Syl/Core/Store/SyncEngine.swift flush   already sends every intent correctly
```

## Risks

**R1 — Rebuilding the flush.** The single most likely way to waste this epic is an agent
seeing "completion does not work" and writing a new send path beside the working one.
The flush is correct. Only the optimistic half is missing.

**R2 — A percentage.** A progress bar on a goal is the most natural thing in the world to
add and it is explicitly refused. Progress is evidenced. Reviewers should treat any
percentage in a diff as a defect.

**R3 — The deferral instant.** Computing "+10 minutes" on the device would be easy,
would look right, and would be wrong. See D2.

**R4 — Quadratic rendering, again.** `syl-008` shipped exactly this and it cost the
Commander two crashes. Any per-row view that stores a collection covering the whole list
will do it again. Slice per row in the loader.

**R5 — A form.** Capture is a sentence. The moment it gains a date picker and a goal
selector it becomes the thing proposal B exists to prevent.

## Bead Map

- `syl-011` — The List
  - `syl-011.1` — Foundation: optimistic writes, and goals on the device
  - `syl-011.2` — US1: he can finish a thing
  - `syl-011.3` — US2: he can write one down in a sentence
  - `syl-011.4` — US3: he can see everything he owes
  - `syl-011.5` — US4: a goal tells him the truth
  - `syl-011.6` — US5: he can choose the light
  - `syl-011.7` — Polish: scale, accessibility, and the screenshots

**Start here.** `syl-011.6` (appearance) is unblocked and independent — it answers a
question the Commander asked directly. `syl-011.1` is the gate on everything else.
