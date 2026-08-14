# Implementation Plan: Fifty At A Time

**Branch**: `015-fifty-at-a-time` | **Date**: 2026-08-14
**Epic**: `syl-025` | **Priority**: P0

## Summary

The transcript loads the entire conversation because an `onAppear`-driven
`loadEarlier()` re-triggers itself every time the snapshot is reassigned, in
steps of 200, while `.defaultScrollAnchor(.bottom)` forces the `LazyVStack` to
size every row it has pulled in. Fix the loop, fix the anchor, set the page to
50, preserve scroll position on prepend, and then wire the already-written,
never-called `SylAPI.messages(cursor:limit:direction:)` so history older than
the device is reachable. The backend needs no pagination work — it already has
it — only an honesty fix on the `direction` parameter it declares and ignores.

## Bead Map

- `syl-025` — Root: Fifty At A Time — the transcript stops loading everything
  - `syl-025.1` — Foundational: the runaway load, and the batch of fifty
    - `syl-025.1.1` — T001 The failing test: a long transcript must not grow unattended
    - `syl-025.1.2` — T002 One page size, named once, equal to 50
    - `syl-025.1.3` — T003 Kill the self-retriggering load
  - `syl-025.2` — US1: Opening the chat is instant, and stays instant
    - `syl-025.2.1` — T004 The failing test: first paint must not measure the whole transcript
    - `syl-025.2.2` — T005 Replace `.defaultScrollAnchor(.bottom)` without losing first-paint placement
    - `syl-025.2.3` — T006 Isolate the composer draft from the transcript
  - `syl-025.3` — US2: Scrolling up loads fifty more, and keeps his place
    - `syl-025.3.1` — T007 The failing test: prepend must not move the read position
    - `syl-025.3.2` — T008 Proximity-triggered load, one in flight
    - `syl-025.3.3` — T009 Scroll-position preservation across a prepend
  - `syl-025.4` — US3: History older than this device is reachable
    - `syl-025.4.1` — T010 The failing test: scroll past the local floor reaches the server
    - `syl-025.4.2` — T011 Persist the history floor per conversation
    - `syl-025.4.3` — T012 Wire `SylAPI.messages` into `loadEarlier`
    - `syl-025.4.4` — T013 Offline and terminal states for the earlier control
  - `syl-025.5` — US4: The contract stops lying about `direction`
    - `syl-025.5.1` — T014 The failing test: `direction=forward` walks forward
    - `syl-025.5.2` — T015 Honour `direction` in the store and the route
  - `syl-025.6` — Polish: the window has a ceiling, and the screen has manners
    - `syl-025.6.1` — T016 Collapse the window on returning to the foot
    - `syl-025.6.2` — T017 Accessibility: focus and announcement across a prepend
    - `syl-025.6.3` — T018 Record the mechanism in `docs/CONTEXT.md`

## Technical Context

**Stack**: Swift 6 / SwiftUI (app target), SylKit (SPM, host-testable), Node 22 +
TypeScript (backend), hand-authored OpenAPI in `shared/`.
**Storage**: GRDB/SQLite on device (`Application Support/Syl/syl.sqlite`);
`node:sqlite` server-side.
**Testing**: XCTest via `ios/scripts/test.sh` (three phases); Vitest via
`npm run verify` (two passes).
**Constraints**:
- No backend migration is required. `messages_conversation_seq_idx ON messages
  (conversation_id, seq DESC)` already serves the read path exactly.
  *(If one is ever added: origin is at `0035`, so the next number is `0036` —
  re-check `git ls-tree --name-only origin/main backend/src/migrations/`
  immediately before committing, not only before writing.)*
- The on-device GRDB schema may need a migration for the history-floor marker;
  that migrator lives in `ios/Syl/Core/Store/SylDatabase.swift` and is versioned
  independently of the backend's.
- `-scheme Syl` does not run SylKit. Use `ios/scripts/test.sh`.

## Architecture Decision

### Why not "just make the batch 50"

Because the batch size is not what makes the window large. The loop is. With a
50-step and the loop intact, the window still reaches the whole conversation —
it just takes four times as many iterations to get there, each one triggering a
full snapshot rebuild and a full-height re-measure. It would arguably be
*worse*: four times the rebuild churn for the same terminal state.

### Why the anchor has to go, and what replaces it

`.defaultScrollAnchor(.bottom)` was added for a real reason, recorded in the
code: an `onChange`-only scroll-to-bottom "intermittently fails on long
transcripts" (`ChatView.swift:216-218`). We cannot simply delete it and hope.

The replacement must satisfy FR-006 (reliable first-paint placement) **and**
FR-005 (no total-height requirement). The candidates, in preference order:

1. **`.scrollPosition($position)` initialised to the foot anchor id.** Positions
   by identity rather than by geometry, so it does not need the total height.
   This is the intended modern API and the first thing to measure.
2. **Explicit `proxy.scrollTo(footAnchor, anchor: .bottom)` from `.task`, after
   the first snapshot assignment, with a second settle pass.** This is the
   pattern that was previously found flaky — but it was flaky *without* a
   deterministic first snapshot, and with one page instead of a growing window
   the failure mode may not survive. Must be proven, not assumed.
3. **Inverted transcript** (`.scaleEffect(y: -1)` on the scroll view and each
   row). Makes prepending free — content grows away from the anchor, so US2's
   position preservation becomes structural rather than compensated. The cost is
   that every row, gesture, and accessibility traversal is upside down, which is
   a large blast radius across `ChatTurn`, `AttachmentView` and VoiceOver order.

**T005 is explicitly a measurement task, not an implementation guess.** It picks
between these against the render-count probe from T004 and records why. This
project's own history is emphatic on the point: the previous two fixes to this
exact symptom both guessed wrong, and the file went on claiming it never parsed.

### Why the load trigger changes shape

`onAppear` on a row inside a `LazyVStack` answers "was this view instantiated",
which under full-height measurement is true for rows nowhere near the screen —
and it fires again on every subtree rebuild. Neither property is what "he
scrolled to the top" means.

The trigger becomes **proximity of the loaded range's top edge to the viewport**,
with a latch so that one crossing produces one load. The `isLoadingEarlier`
guard stays, but it stops being the only thing between us and the whole
conversation.

### Why US3 is a separate story and not part of US2

US2 makes the *local* window behave. US3 makes the window reach *past the
device*. They fail differently, they are testable separately, and US2 delivers
real value alone — the reported defect is fixed at the end of US1+US2. US3 is
what makes the word "infinite" honest, and it is the first time the chat screen
will ever make an HTTP call of its own.

### Why the client keeps a history floor

Without a persisted "the server confirmed there is nothing older" marker, every
relaunch re-walks the full history the first time he scrolls up, and every
exhausted local window looks identical to a genuine beginning. The marker
distinguishes *we have not looked* from *there is nothing there*, which is the
same distinction the terminal UI state depends on (FR-010).

## Files Changed

| File | Change |
|------|--------|
| `ios/Syl/Features/Chat/ChatViewModel.swift` | `pageSize` 200 → 50; `loadEarlier()` gains a latch, a remote leg, and a floor; draft isolation |
| `ios/Syl/Features/Chat/ChatView.swift` | Anchor replacement; proximity trigger replaces `onAppear`; position preservation across prepend |
| `ios/Syl/Features/Chat/ChatSnapshot.swift` | `ChatSnapshotLoader.limit` default 200 → 50; expose oldest-loaded `seq`; `reachedBeginning` |
| `ios/Syl/Features/Chat/ChatChrome.swift` | `EarlierMessages` gains idle / loading / beginning / offline states |
| `ios/Syl/Core/Store/LocalStore.swift` | Read a page older than a given `seq`; read/write the history floor |
| `ios/Syl/Core/Store/SylDatabase.swift` | GRDB migration for the per-conversation history floor |
| `ios/Syl/App/AppDelegate.swift` | Inject an API client into `ChatViewModel` so the chat can fetch history |
| `ios/SylTests/ChatTests.swift` | Runaway-growth, page-size, prepend-position, remote-paging tests |
| `ios/SylTests/ChatFreezeTests.swift` | Extend the render-cost probe to count laid-out rows at first paint |
| `backend/src/services/message-store.ts` | Honour `direction` in `list()` |
| `backend/src/routes/conversations.ts` | Parse and validate `direction`; reject unknown values |
| `backend/tests/unit/message-store.test.ts` | Forward/backward paging, limit that actually bites |
| `backend/tests/unit/conversations.test.ts` | `direction` validation |
| `shared/openapi.yaml` | Only if the decision goes the other way (remove `direction`) — then `npm run contract:generate` |
| `docs/CONTEXT.md` | The mechanism, and why the batch size was the least of it |

## Phase 1: Foundational — the runaway load, and the batch of fifty

Stops the bleeding. Independently shippable and independently valuable: even
with the anchor untouched, a window that stays at 50 instead of climbing to the
whole conversation is a dramatic improvement. Blocks every other phase, because
every other phase's tests assume a bounded window.

## Phase 2: US1 — first paint is cheap

The anchor, and the keystroke-invalidation multiplier. This is where the
measured win lives.

## Phase 3: US2 — fifty at a time, without losing his place

The feature as he described it. Depends on Phase 1 for the bounded window and on
Phase 2 for a layout that can be positioned by identity.

## Phase 4: US3 — reaching past the device

The first HTTP call the chat screen makes. Depends on Phase 3 for the trigger it
hangs off.

## Phase 5: US4 — the `direction` honesty fix

**Fully parallel with everything above.** Backend + contract only, no iOS files.
This is the one phase a second agent can take from the start.

## Phase 6: Polish

Window ceiling, accessibility, and the write-up.

## Parallel Opportunities

- **Phase 5 (backend) is independent of Phases 1-4 (iOS)** and can run
  concurrently from minute one. Different workspaces, zero shared files.
- Within Phase 1, T002 (constant) and T003 (latch) touch the same file and are
  **not** parallel.
- T006 (draft isolation) touches `ChatViewModel`/`ChatView` alongside T005 —
  sequence them, do not parallelise.
- T018 (CONTEXT.md) is writable at any point once T005 has produced its
  measurement.

## Risks

- **The anchor replacement may not reproduce first-paint reliability.** T005 is
  scoped as a measurement with three named candidates precisely because of this.
  If all three fail, the fallback is to keep `.defaultScrollAnchor(.bottom)` and
  rely on the bounded window alone — which still fixes the reported defect,
  because 50 rows measured is not 2,000. Say so rather than shipping a
  half-working anchor.
- **Scroll-position preservation in SwiftUI is genuinely hard** and version-
  sensitive. The inverted-transcript option exists as the structural escape
  hatch if compensation proves unstable.
- **Adding a network call to the chat screen adds a failure surface** that did
  not exist. FR-004 and the offline state (T013) are not polish; they are what
  stops US3 turning a working local transcript into a spinner.
- **Regression risk on two rules that were expensive to get right**: his own
  message always scrolls (`ChatView.swift:245`), and an arriving reply never
  yanks the view (`NewTurnPill`). FR-013 makes them explicit; the existing tests
  in `ChatTests.swift` must stay green untouched.
