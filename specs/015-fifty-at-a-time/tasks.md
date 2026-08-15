# Tasks: Fifty At A Time

**Epic**: `syl-025` | **Branch**: `015-fifty-at-a-time`

Markers: `[P]` = parallelisable with the tasks beside it (different files, no
dependency). `[US]` = the user story it serves.

**Every phase starts with a red test.** The project constitution requires it,
and `docs/CONTEXT.md` is explicit that an acceptance test describes correct
behaviour, never current behaviour. A test that goes in green has proven
nothing here — every existing fixture is shorter than the window, which is
exactly the condition under which the runaway loop does not exist.

---

## Phase 1: Foundational — the runaway load, and the batch of fifty

### T001 — The failing test: a long transcript must not grow unattended `[US1]`

**File**: `ios/SylTests/ChatTests.swift`

Add to `ChatViewModelTests`:

- `testShouldLoadOnlyOnePageWhenTheConversationIsLong` — seed 2,000 messages,
  build the model, `await refresh()`, assert `snapshot.groups` covers exactly
  one page.
- `testShouldNotWidenTheWindowWithoutBeingAsked` — seed 2,000, refresh, then
  drive whatever the view drives on a snapshot rebuild (a second `refresh()`,
  an arriving `.message` event) and assert the window is **still** one page.
- `testShouldNotWidenTheWindowTwiceForOneTrigger` — call `loadEarlier()`, and
  while it is in flight call it again; assert the window grew by exactly one
  page.

The seed must be **larger than the window** — a fixture smaller than the limit
is the shape under which this defect is invisible, and it is why nothing caught
it. Follow the rule already written down: *any query with a `LIMIT` needs a test
where the limit actually bites.*

These go red. Record them in the expected-failures ledger if the harness
requires it, with this bead id.

---

### T002 — One page size, named once, equal to 50 `[US1]`

**Files**: `ios/Syl/Features/Chat/ChatViewModel.swift`,
`ios/Syl/Features/Chat/ChatSnapshot.swift`

`ChatViewModel.init(limit: Int = 200)` → `50`, and
`ChatSnapshotLoader.limit = 200` → `50`. Define **one** constant and have both
sites read it — two independently-written 200s is how they drifted from the
server's own default of 50 in the first place, and this repository has a
standing rule against a second copy of a load-bearing number (see the quiet
window and its scanning test).

Do not change `LocalStore.messages(conversationId:limit: Int = 200)`'s default
in the same edit — that default serves other callers. Pass the constant
explicitly.

---

### T003 — Kill the self-retriggering load `[US1]`

**Files**: `ios/Syl/Features/Chat/ChatViewModel.swift`,
`ios/Syl/Features/Chat/ChatView.swift`

Remove `.onAppear { Task { await model.loadEarlier() } }` from the
`EarlierMessages` row. `onAppear` inside a `LazyVStack` means "this view was
instantiated", which is true for off-screen rows under full-height measurement
and true again on every subtree rebuild — neither is "he scrolled to the top".

Replace with an explicit trigger the model owns: `loadEarlier()` keeps its
`isLoadingEarlier` guard **and** gains a latch so that one arrival at the top
produces one load. The tap affordance on `EarlierMessages` stays — it is the
fallback that makes a misfiring automatic trigger recoverable, which is the
reason it was built.

T001 goes green here. Leave the automatic proximity trigger to T008; this task's
job is to make the window stop growing on its own, and a control he taps is a
correct, shippable intermediate state.

---

## Phase 2: US1 — opening the chat is instant, and stays instant

### T004 — The failing test: first paint must not measure the whole transcript `[US1]`

**File**: `ios/SylTests/ChatFreezeTests.swift`

Extend the existing render-cost probe (`ChatInlineRenderCostTests`) to count
**laid-out rows**, not just markdown parses: seed 2,000 messages, present the
view, assert the count of rows that were sized is bounded by a small multiple of
the page size.

Then the multiplier test: assert that changing `model.draft` causes **zero**
transcript row re-layouts. `ChatView.body` re-running on every keystroke is one
of the three multipliers named in `docs/CONTEXT.md`; without this assertion the
fix is unverifiable.

Beware the trap this file already documents: a faithfulness check that compares
a memo against a fresh parse **shares an implementation**, so corrupting both
produces two wrong answers that agree. Break the probe on purpose and confirm it
goes red before trusting it.

---

### T005 — Replace `.defaultScrollAnchor(.bottom)` without losing first-paint placement `[US1]`

**File**: `ios/Syl/Features/Chat/ChatView.swift` (line 219)

**This is a measurement task, not an implementation guess.** Evaluate the three
candidates in `plan.md` against T004's probe:

1. `.scrollPosition($position)` initialised to `Self.footAnchor` — positions by
   identity, needs no total height. Try first.
2. Explicit `proxy.scrollTo(footAnchor, anchor: .bottom)` from `.task` after the
   first snapshot, plus a settle pass.
3. Inverted transcript (`.scaleEffect(y: -1)` on the scroll view and each row).

Two properties must hold **together**: rows near the viewport only (FR-005), and
reliable first-paint placement at the newest message on a long transcript
(FR-006). The second is why the anchor exists — the comment at
`ChatView.swift:216-218` records the `onChange`-only pattern as intermittently
failing, and that finding is not superseded just because it is inconvenient.

Record the measurement and the choice in the bead notes. If **all three** fail
FR-006, stop and say so: keeping the anchor with a 50-row bounded window still
fixes the reported defect, and a half-working anchor that strands him mid-
transcript on launch is worse than the bug we started with.

---

### T006 — Isolate the composer draft from the transcript `[US1]`

**Files**: `ios/Syl/Features/Chat/ChatViewModel.swift`,
`ios/Syl/Features/Chat/ChatComposer.swift`, `ios/Syl/Features/Chat/ChatView.swift`

`draft` is `@Published` on the same object the transcript observes, so every
keystroke invalidates `ChatView.body` and everything under it. Move the draft
into state the composer owns, or into a separate observable, so typing does not
touch the transcript subtree.

Sequenced after T005 — same files, no parallelism.

T004 goes green here.

---

## Phase 3: US2 — scrolling up loads fifty more, and keeps his place

### T007 — The failing test: prepend must not move the read position `[US2]`

**File**: `ios/SylTests/ChatTests.swift`

- Load a window, note the identity of the turn at the top of the viewport,
  prepend a page, assert that turn's screen offset is unchanged.
- Assert a trigger that fires while a load is in flight is ignored, not queued
  (FR-004).
- Assert resting short of the top loads nothing (FR-004's sibling: proximity,
  not existence, is the trigger).

---

### T008 — Proximity-triggered load, one in flight `[US2]`

**File**: `ios/Syl/Features/Chat/ChatView.swift`

Drive `loadEarlier()` from the loaded range's top edge approaching the viewport,
with the T003 latch resetting only after the user moves away from the top. One
crossing, one load, fifty messages.

Keep the tap affordance. An automatic trigger that misfires must never leave him
with no way back — that is why the manual control exists and it is not
redundant.

---

### T009 — Scroll-position preservation across a prepend `[US2]`

**File**: `ios/Syl/Features/Chat/ChatView.swift`

Capture the top-most visible group id before the prepend; restore it after
layout settles. **The restore must be unanimated** — a correction that slides is
read as a glitch, and Reduce Motion must be honoured regardless
(`reduceMotion` is already threaded through `scrollToFoot`).

If candidate 3 (inverted transcript) won T005, this task collapses to almost
nothing: content grows away from the anchor and position preservation is
structural. Note that outcome on the bead rather than writing compensation code
that has nothing to compensate for.

T007 goes green here.

---

## Phase 4: US3 — history older than this device is reachable

### T010 — The failing test: scrolling past the local floor reaches the server `[US3]`

**Files**: `ios/SylTests/ChatTests.swift`, `ios/SylKit/Tests/SylKitTests/`

Seed the local store with 100 messages while a stub API holds 500. Assert that
exhausting the local window issues `GET /conversations/{id}/messages` with the
seq cursor, that the returned page is written to the store, and that a second
pass does **not** re-fetch it.

Also assert the offline path: with the API failing, the local transcript stays
usable and he is told the older history is unreachable — not left on a spinner.

---

### T011 — Persist the history floor per conversation `[US3]`

**Files**: `ios/Syl/Core/Store/SylDatabase.swift`,
`ios/Syl/Core/Store/LocalStore.swift`

A per-conversation marker distinguishing *we have not looked* from *the server
confirmed there is nothing older*. Without it every relaunch re-walks the whole
history on the first upward scroll, and a genuine beginning is indistinguishable
from an exhausted local window.

This is the **on-device GRDB** migrator, versioned independently of the
backend's — no backend migration number is involved and none should be claimed.

Add `LocalStore` reads for "one page older than seq X".

---

### T012 — Wire `SylAPI.messages` into `loadEarlier` `[US3]`

**Files**: `ios/Syl/Features/Chat/ChatViewModel.swift`,
`ios/Syl/App/AppDelegate.swift`

`SylAPI.messages(conversationId:cursor:limit:direction:)` is fully implemented
and unit-tested with **zero production callers**. This task gives it its first
one. `AppDelegate` must inject the client into `ChatViewModel`, which has never
held one — the chat screen has never made an HTTP call.

Order: local page first, remote page only when local is exhausted, upsert,
re-read. The store is the single source of truth for what is displayed
(`refresh()` already rebuilds from disk); the network leg writes to disk and
lets the existing path do the rest, rather than appending to an array beside it.

---

### T013 — Offline and terminal states for the earlier control `[US3]`

**File**: `ios/Syl/Features/Chat/ChatChrome.swift` (`EarlierMessages`, line 126)

Four states, each visually distinct: **idle** (tappable), **loading**,
**beginning of the conversation** (terminal, not tappable, and it should feel
like an ending rather than a failure), and **unreachable** (offline — tappable
to retry).

A control that spins forever at the true beginning of a conversation is the
single most likely way this feature reads as broken while working perfectly.

T010 goes green here.

---

## Phase 5: US4 — the contract stops lying about `direction`

**Fully parallel with Phases 1-4. Different workspaces, zero shared files.**

### T014 — The failing test: `direction=forward` walks forward `[US4]` `[P]`

**Files**: `backend/tests/unit/message-store.test.ts`,
`backend/tests/unit/conversations.test.ts`

- `forward` + cursor returns messages with `seq` **greater** than the cursor,
  ascending.
- `backward` and absent are byte-identical to today.
- An unrecognised value is `VALIDATION_FAILED` naming the field — the route's
  existing convention (`single()` refuses repeated params rather than coercing;
  an unknown enum deserves the same refusal).
- A limit that **actually bites**: a fixture larger than the page. This is the
  standing rule and it is the exact shape that caught the window-from-the-wrong-
  end defect.

---

### T015 — Honour `direction` in the store and the route `[US4]` `[P]`

**Files**: `backend/src/services/message-store.ts` (`list()`, line 379),
`backend/src/routes/conversations.ts` (`pageOptions`, line 67)

Today the parameter is declared in `shared/openapi.yaml`, accepted by the route
without complaint, and discarded. Only `shared/src/mock/server.ts:251`
implements it, so the contract tests pass against a mock that behaves
differently from the service — consistency without correspondence, which is the
named failure mode of this repository.

Forward paging is `WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC`, and
the existing `messages_conversation_seq_idx` serves it. Keep the `limit + 1`
convention and the `hasMore` derivation.

`nextCursor` semantics for `forward` must be stated in the response and the
spec — it is the *newest* seq of the page, not the oldest, and getting that
backwards produces a loop that silently returns the same page forever.

**If the decision goes the other way** — remove `direction` from
`shared/openapi.yaml` instead — then run `npm run contract:generate` and expect
`shared/tests/drift.test.ts` to gate it. Do not edit the generated
`shared/src/types.ts` by hand. What is not acceptable is leaving it declared and
ignored.

---

## Phase 6: Polish

### T016 — Collapse the window on returning to the foot `[P]`

**File**: `ios/Syl/Features/Chat/ChatViewModel.swift`

The window only ever grows (`loader.limit += pageSize`, never shrinks). After a
long browse he is holding the whole conversation in memory for the rest of the
session. When he returns to the foot and the conversation is idle, collapse back
to one page.

Must not fight the `isAtBottom` sentinel or the `NewTurnPill` logic, and must
never discard a pending optimistic row.

---

### T017 — Accessibility: focus and announcement across a prepend `[P]`

**Files**: `ios/Syl/Features/Chat/ChatView.swift`,
`ios/Syl/Features/Chat/ChatChrome.swift`

VoiceOver focus must not move when fifty rows are inserted above the cursor, and
the transcript must not re-announce from the top. The load states need labels;
the terminal state needs one that reads as an ending. Verify traversal order
survives whatever T005 chose — if the transcript was inverted, traversal order
was inverted with it, and that is a correctness bug, not a cosmetic one.

---

### T018 — Record the mechanism in `docs/CONTEXT.md` `[P]`

**File**: `docs/CONTEXT.md`

Three things worth the words:

1. **The feature existed and was defeated.** Server paging, the client endpoint,
   and the "load earlier" affordance were all present. The bug was an `onAppear`
   that re-fired on every snapshot rebuild, in 200-message steps, until the
   whole conversation was resident.
2. **`onAppear` in a `LazyVStack` is not "became visible"** — it is "was
   instantiated", which under a bottom scroll anchor is true for every row in
   the window. Anything using it as a scroll trigger is wrong by construction.
3. **The measurement from T005**, whichever way it went, with a version stamp.
   The load-bearing-measurement rule at the top of `CLAUDE.md` was written for
   exactly this: the last person to decide this file's scroll behaviour left a
   comment that outlived the reason.

Write it where a reader stands — this file and the module headers — not in a
commit message.

---

## Dependency Summary

```
T001 ─┬─→ T002 ──→ T003 ──→ T004 ──→ T005 ──→ T006
      │                              │
      │                              └──→ T007 ──→ T008 ──→ T009 ──→ T010 ─┬─→ T011 ──→ T012 ──→ T013
      │                                                                     │
      └──────────────────────────────────────────────────────────────────  T016, T017, T018 (after T013)

T014 ──→ T015                       (independent track, start immediately)
```

## Verification

```sh
npm run verify                 # both passes; failures == declared
bash ios/scripts/test.sh       # all three phases — NOT `-scheme Syl` alone
```

`-scheme Syl` does not run SylKit and has previously reported green while
counting 795 of 1094 tests. The gate for this epic is `ios/scripts/test.sh`.
