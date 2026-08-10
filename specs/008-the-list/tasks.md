# Tasks — The List

**Feature**: 008-the-list · **Epic**: `syl-011`

`[P]` = parallelisable (different files, no dependency). `[USn]` = serves that user story.
Every task names exact paths. Tests come first.

**Before anything: do not rebuild the write transport.** `Outbox.Kind` already declares
every intent this epic needs and `SyncEngine`'s flush already sends them with idempotency
keys. What is missing is the optimistic half in `LocalStore`. Read `plan.md` R1.

---

## Phase 1 — Foundation (`syl-011.1`)

No UI change. Everything after this depends on it.

- **T001** Add the `goal` table to `ios/Syl/Core/Store/SylDatabase.swift` as the next
  migration, and `GoalRecord` to `Records.swift`. Self-nesting via `parentId`; **no
  percent-complete column**, no priority column — mirror the server's
  `0009_todos_goals.sql`, whose header states both refusals.

- **T002** Stop ignoring goals in `ios/Syl/Core/Store/SyncEngine.swift`. Move `.goal` out
  of the ignore list and upsert it. **Rewrite the comment rather than deleting it** — it
  currently asserts "the phone has no use for these", which was true and is now the thing
  standing between the Commander and his goals. Say what changed.

- **T003** [P] `LocalStore` goal reads: all goals, one goal, and the to-dos linked to a
  goal. Oldest-first is wrong here; order by target date then title.

- **T004** **The foundational seam.** Optimistic write helpers in
  `ios/Syl/Core/Store/LocalStore.swift`, each writing the local row and the outbox row in
  **one transaction**, following `enqueueSend`'s pattern and its doc comment:
  `completeTodo(id:)`, `completeReminder(id:)`, `snoozeReminder(id:)`, `createTodo(text:)`.
  Tests: the local row changes, the outbox row exists, and neither survives alone when the
  transaction fails.

- **T005** Deferral is **asked**, not moved (D2). `snoozeReminder` must not compute a new
  instant. The row records that a deferral was requested and settles when the server
  answers. A test asserts no device-computed time is ever written.

- **T006** Idempotency: replaying any of these intents applies once. Drive it through the
  real outbox rather than asserting the key is non-nil.

- **T007** Refuse a completion of something already finished, and name the thing in the
  error. The project has a scar here (`CONTEXT.md` §7: `finish_todo` "must refuse an
  already-finished to-do rather than reporting an answer happily; and name the to-do, in
  his words, on every path").

---

## Phase 2 — US1: he can finish a thing (`syl-011.2`)

- **T008** `ios/Syl/Features/Home/DaySpine.swift` — `onSelect` stops being a stub. Its
  comment says "Completion lands later"; this is later. Tap completes a to-do, and a
  reminder offers complete or defer.

- **T009** The completed state is a *settling*, not a disappearance. A row that vanishes
  the instant it is tapped gives no confirmation and no undo; it marks done, then leaves.
  Use `SylTheme.Motion.settle`.

- **T010** [P] Defer affordance with the server-authoritative rule visible: while the
  server has not answered, the row says the deferral was asked for and does **not** show
  a new time.

- **T011** Accessibility: completion and deferral are distinct, labelled actions on the
  row — not a bare tap whose meaning a VoiceOver user must infer. 44pt minimum.

- **T012** Failure: an intent the server refuses must surface on the row rather than in a
  banner. Reuse the `warmth` treatment from `syl-008` — the palette's one warm note.

---

## Phase 3 — US2: capture (`syl-011.3`)

- **T013** `ios/Syl/Features/Lists/CaptureField.swift` — one field, one sentence,
  `SylTheme` throughout, 44pt. It creates a to-do with text and a timestamp and **nothing
  else**. No date picker, no goal selector, no priority. See R5.

- **T014** No confirmation step and no inbox: an explicit ask is never provisional
  (proposal B §3). The row exists the moment he commits.

- **T015** Empty or whitespace-only commits write nothing.

- **T016** Where capture lives: the foot of the day and the head of the list, so the thing
  he most often wants to do is never more than one tap from where he already is.

---

## Phase 4 — US3: everything he owes (`syl-011.4`)

- **T017** `ios/Syl/Features/Lists/TodoOrdering.swift` — pure, tested, a peer of
  `TranscriptRhythm`. Deadline, then `pinned`, then staleness. **No stored priority is
  read, because none exists.** Test that an undated to-do still lands somewhere sane.

- **T018** `ios/Syl/Features/Lists/TodoListView.swift` and `TodoRow.swift`, rendering from
  disk with **no loading state**. Slice per row in the loader (R4).

- **T019** [P] Reached from the foot of the day — "Everything else, N open" — so undated
  to-dos stop being invisible.

- **T020** A to-do's goal is visible on the row without the row becoming a form.

- **T021** The empty state is a clear day, in the voice `EmptyConversation` already
  established. Not an empty table.

- **T022** 500 open to-dos scroll without dropped frames.

---

## Phase 5 — US4: a goal tells him the truth (`syl-011.5`)

- **T023** `ios/Syl/Features/Goals/GoalEvidence.swift` — pure projection of what actually
  happened and when. Computed off the main actor in the loader (D5). Tested.

- **T024** `GoalRisk.swift` — **silence** (`now − last activity > cadence_days`) and
  **arithmetic** (required rate vs observed rate). The arithmetic is reported as **both
  numbers**, never as a verdict. Tested, including a goal with no cadence and a target
  date in the past.

- **T025** `GoalListView.swift`, opened from the Goals orb — wire `onOpen(.goals)` in
  `HomeView.swift`, which already exists and goes nowhere.

- **T026** `GoalDetailView.swift`: title, `why`, target date, evidence, risk. **No
  percentage, no progress bar, no chart of a made-up number.** A goal with nothing linked
  says nothing has happened.

- **T027** `abandoned` reads as a non-shameful outcome with its history intact — the
  reason proposal B made it first-class was that accumulated guilt is what kills goal
  systems.

- **T028** Nesting: the parent link is visible, and the horizon is **derived** from the
  target date rather than stored.

---

## Phase 6 — US5: he can choose the light (`syl-011.6`)

**Independent of every other phase. Start it immediately.**

- **T029** `ios/Syl/Features/Settings/AppearanceSetting.swift` — `System | Day | Night`,
  persisted, and a row in the Settings list styled against `SylTheme`.

- **T030** Applied app-wide via `preferredColorScheme` in `ios/Syl/SylApp.swift`.

- **T031** `HomeView.swift` stops forcing `.dark` unconditionally. It forces it only when
  the choice is System and a scene is present, so an explicit Day is honoured — and in Day
  the scene falls back to the still rather than putting a starfield in a bright frame.

- **T032** Tests: each choice resolves correctly, survives a relaunch, and System follows
  the environment without one.

---

## Phase 7 — Polish (`syl-011.7`)

- **T033** Render every new surface through `ios/SylTests/` snapshot harnesses, in day and
  night, and **look at them**. That harness found three real defects in `syl-008` that no
  assertion would have.

- **T034** Screenshot the list and a goal beside Today and Chat. They must read as one
  product; that is the epic's stated criterion, and it is not settleable by reading a
  diff.

- **T035** Dynamic Type at the largest accessibility size across every new surface, and
  Reduce Motion honoured as elsewhere.

- **T036** Grep gate: no stock system colour anywhere in the new features. `syl-008`'s
  acceptance was verified exactly this way.

---

## Deferred, and why

- **The `proposed` state UI** — structure Syl infers from conversation. Real work in
  proposal B, gated on a taste decision currently with the Commander. Kept out so it can
  be dropped without unpicking anything.
- **Editing goal fields in the app** — capture is a sentence; curation is a conversation.
- **A reminders screen** — a reminder is a scheduled utterance attached to a thing.
- **Memory** — `syl-010`.
- **Widget / Live Activity** — proposal E defers it.
