# Feature Specification: Fifty At A Time

**Feature Branch**: `015-fifty-at-a-time`
**Created**: 2026-08-14
**Status**: Draft

## The correction this spec opens with

The Commander asked for pagination and an infinite-scroll mechanism, on the
reasonable theory that the chat loads every message because nobody ever built
paging. **Both halves already exist.** Building them again would produce a large,
green, useless epic.

- **The server has been cursor-paginated the whole time.**
  `GET /api/v1/conversations/{id}/messages` returns newest-first, opaque
  seq-cursor pages, default limit **50**, max 200, envelope
  `{items, nextCursor, hasMore}` (`backend/src/services/message-store.ts:379`).
- **SylKit already speaks it.** `SylAPI.messages(conversationId:cursor:limit:direction:)`
  is implemented and unit-tested (`SylKit/Sources/SylKit/Networking/SylAPI.swift:76`).
  It has **zero production callers**.
- **The client already has a "load earlier" affordance**, `mayHaveEarlier`,
  `isLoadingEarlier`, and an `EarlierMessages` control (`ChatViewModel.swift:160`,
  `ChatView.swift:124`).

So the transcript does not load everything because paging is missing. It loads
everything because **three defects conspire to defeat the paging that is there**,
and the Commander's sentence — *"it looks like it loads and contains all of the
previous messages"* — is a literally accurate description of the outcome.

### Defect A — the window auto-expands to the entire conversation, unattended

`ChatView.swift:128-131`:

```swift
if model.snapshot.mayHaveEarlier {
    EarlierMessages(isLoading: model.isLoadingEarlier) { Task { await model.loadEarlier() } }
    .onAppear { Task { await model.loadEarlier() } }
}
```

`loadEarlier()` widens the window and calls `refresh()`, which **reassigns the
whole snapshot**. That rebuilds the `LazyVStack` subtree, which re-creates
`EarlierMessages` at the top, which fires `onAppear` again. The only guard is
`isLoadingEarlier`, and `defer` clears it before the next appearance.

The loop terminates on `mayHaveEarlier == false` — that is, **when the entire
conversation is in memory**. No finger touched the screen. The 200-message cap
is not a cap; it is a step size.

### Defect B — the step size is 200, not 50

`ChatViewModel.init(limit: Int = 200)` sets `pageSize = 200`, and
`loadEarlier()` does `loader.limit += pageSize`. Every iteration of the loop in
Defect A pulls **200 more turns**. The Commander asked for 50; the code has
never used 50 anywhere on the client.

### Defect C — `.defaultScrollAnchor(.bottom)` cancels the laziness

`ChatView.swift:219`. To place the viewport at the bottom, SwiftUI must know the
transcript's **total** content height, so the `LazyVStack` sizes **every row in
the window** rather than the visible ones. This is already written down in
`docs/CONTEXT.md` (the chat freeze of 2026-08-11) and in the doc comment at
`Markdown/MarkdownInline.swift:38`. `ChatView.body` re-runs on **every keystroke
and every presence frame**, and each re-run re-measures the lot.

Defect C is also what makes Defect A fire on a row that is nowhere near the
screen: under full-height measurement the top row is materialised immediately.

**A and C multiply.** A grows the window without bound; C makes every row in it
cost a full layout on every keystroke. That product is the flicker and the
jitter, and it gets monotonically worse the longer he uses her — which is
exactly the progression he reported.

### What this means for the plan

Shipping "batch of 50" alone would divide the symptom by four and leave the
runaway loop and the anchor in place. The window would climb back to the whole
conversation within seconds of the first paint, in 50-row steps instead of
200-row steps, and the jitter would return. **The loop and the anchor are the
feature; 50 is a constant.**

---

## User Scenarios & Testing

### User Story 1 - Opening the chat is instant, and stays instant (Priority: P0)

The Commander opens the Chat tab on a conversation with thousands of messages.
The most recent turns are on screen immediately, and the app renders only what
is near the viewport. Typing into the composer does not stutter. Leaving the
screen open through a reply does not degrade it.

**Why this priority**: This is the reported defect. It is also a watchdog-kill
risk — `docs/CONTEXT.md` records this same mechanism killing the app on
2026-08-11. Every other story here is comfort; this one is the app working.

**Independent Test**: Seed a local store with 2,000 messages, present `ChatView`,
and assert that the number of rows laid out after first paint is bounded by a
small multiple of the page size — and that it does not change when nothing
happens.

**Acceptance Scenarios**:

1. **Given** 2,000 messages on disk, **When** the chat first paints, **Then**
   the loaded window is exactly one page (50), not 2,000.
2. **Given** the chat has painted and the Commander touches nothing, **When**
   five seconds pass, **Then** the window is still one page — no unattended
   growth.
3. **Given** 2,000 messages on disk, **When** he types a character into the
   composer, **Then** the transcript rows are not re-laid-out as a result.
4. **Given** he is at the foot, **When** a reply arrives, **Then** it appears
   and the view follows it, with no window growth beyond the new message.

---

### User Story 2 - Scrolling up loads fifty more, and keeps his place (Priority: P1)

He drags upward through the transcript. On reaching the top of what is loaded,
the next fifty older turns load and appear *above* his current position. The
message he was reading does not move under his finger.

**Why this priority**: This is the mechanism he asked for. It is worthless
without US1 — infinite scroll onto an unbounded window is the bug — but with
US1 it is the whole feature.

**Independent Test**: Load a conversation, scroll to the top of the window,
observe exactly one additional page of 50 arrive, and assert the previously
top-most turn is still at the same screen offset.

**Acceptance Scenarios**:

1. **Given** a window of 50 with older messages available, **When** he scrolls
   to the top, **Then** exactly 50 more load — not 200, and not all of them.
2. **Given** older messages have just been prepended, **When** the layout
   settles, **Then** the turn he was reading is at the same screen position it
   occupied before the load, with no visible jump.
3. **Given** a load is in flight, **When** he keeps dragging upward, **Then** a
   second overlapping load is not started.
4. **Given** he scrolls up but stops short of the top, **When** he rests,
   **Then** nothing loads — proximity to the top, not mere existence of the
   control, is the trigger.

---

### User Story 3 - History older than this device is reachable (Priority: P1)

He scrolls back past everything the phone has ever synced. Rather than hitting
an invisible floor, the app fetches older pages from the server and keeps going,
until it reaches the true beginning of the conversation and says so.

**Why this priority**: Today `loadEarlier()` only widens a **local SQLite**
window. If a message is not on the device, no action in the chat UI can fetch
it — only the forward-only global `/sync` cursor, which never walks backwards.
So the transcript has a hard floor that looks identical to the beginning of the
conversation. This is the story that makes "infinite" true.

**Independent Test**: Point the app at a backend holding 500 messages with only
the newest 100 on the device; scroll past 100 and assert the older ones arrive
over HTTP and persist.

**Acceptance Scenarios**:

1. **Given** the device holds fewer messages than the server, **When** he
   scrolls past the oldest local message, **Then** the client requests the next
   page from `GET /conversations/{id}/messages` using the seq cursor.
2. **Given** a fetched page arrives, **When** it is applied, **Then** the
   messages are written to the local store and survive a relaunch — the same
   scroll does not re-fetch them.
3. **Given** he reaches the true first message, **When** the last page returns
   `hasMore: false`, **Then** the control resolves to a terminal
   "beginning of the conversation" state rather than spinning forever.
4. **Given** the network is unavailable, **When** he scrolls past the local
   floor, **Then** he is told the older history is not reachable right now, and
   the local transcript remains usable.

---

### User Story 4 - The contract stops lying about `direction` (Priority: P2)

`shared/openapi.yaml` declares a `direction` query parameter on `listMessages`
with values `backward` (default) and `forward`. **The backend ignores it
entirely** — no reference exists in `routes/` or `message-store.ts`. Only the
mock server implements it, so the contract tests pass and the real service
silently returns backward pages to a caller that asked for forward.

**Why this priority**: Nothing today is broken by it, because nothing sends
`forward`. But US3 puts a paging client in the field, and `forward` is exactly
what you reach for to close a gap between a loaded window and the live tail. A
parameter that is documented, accepted without complaint, and silently discarded
is a trap laid specifically for the next person who trusts the contract.

**Independent Test**: Request `direction=forward` against the real backend and
assert the page walks forward in `seq`; assert the mock and the service agree.

**Acceptance Scenarios**:

1. **Given** a conversation, **When** `direction=forward` with a cursor is
   requested, **Then** the response contains messages with `seq` **greater**
   than the cursor, in ascending order.
2. **Given** `direction=backward` or no direction, **When** requested, **Then**
   behaviour is byte-identical to today.
3. **Given** an unrecognised `direction`, **When** requested, **Then** the
   response is `VALIDATION_FAILED` naming the field — not a silently coerced
   default.

---

### Edge Cases

- **A conversation shorter than one page.** `mayHaveEarlier` must be false and
  the "earlier" control must never appear. This is the case every existing
  fixture exercises, which is why the runaway loop was never caught.
- **A load that returns zero rows** (deleted history, race with a sync). Must
  resolve to the terminal state, not an infinite retry.
- **Scrolling up and then straight back down.** The window must not be left
  permanently enormous; returning to the foot should let it collapse.
- **An arriving reply while he is reading history.** Already handled by
  `NewTurnPill` + `isAtBottom`; must not regress, and must not yank the view.
- **An optimistic row with `seq == 0`.** Ordering and cursor arithmetic must not
  treat a pending local bubble as the oldest message in the conversation.
- **Reduce Motion.** The scroll-position restore after a prepend must be
  instantaneous; an animated correction reads as a glitch, not as motion.
- **VoiceOver.** Loading fifty rows above the cursor must not silently move
  focus or re-announce the transcript from the top.

## Requirements

### Functional Requirements

- **FR-001**: The transcript MUST load exactly one page on first paint,
  regardless of how many messages exist locally.
- **FR-002**: The page size MUST be **50**, defined as one named constant, used
  by both the first read and every subsequent page.
- **FR-003**: The window MUST NOT grow except as the direct result of the
  Commander scrolling to the top of the loaded range.
- **FR-004**: Exactly one load MUST be in flight at a time; a second trigger
  while one is running MUST be ignored, not queued.
- **FR-005**: The transcript MUST lay out only rows at or near the viewport.
  Total content height MUST NOT be required for correct initial placement.
- **FR-006**: First paint MUST place the viewport at the newest message,
  reliably, on a long transcript — the property `.defaultScrollAnchor(.bottom)`
  was added to guarantee and must not be lost when it is removed.
- **FR-007**: When older messages are prepended, the message occupying the
  viewport MUST remain at the same screen offset.
- **FR-008**: When the local store is exhausted, the client MUST fetch older
  pages from the server via the existing seq cursor and persist them.
- **FR-009**: The client MUST record, per conversation, that the true beginning
  has been reached, so a relaunch does not re-walk the whole history.
- **FR-010**: The "earlier" affordance MUST have three distinct visible states:
  idle, loading, and beginning-of-conversation.
- **FR-011**: Typing in the composer MUST NOT invalidate the transcript rows.
- **FR-012**: The backend MUST either honour `direction=forward` or the contract
  MUST stop declaring it. It MUST NOT continue to accept and discard it.
- **FR-013**: Nothing in this work may change the rule that his own sent message
  always scrolls into view, or that an arriving reply never yanks the view away
  from someone reading history.

### Key Entities

- **Window**: the contiguous, newest-anchored range of messages currently
  materialised for display. Has a size, a page size, and an oldest-loaded `seq`.
- **Page**: 50 messages. The unit of every read, local or remote.
- **Seq cursor**: the server's opaque `base64({seq})`. Already the pagination
  key on both sides; this work makes the client actually carry one.
- **History floor**: per-conversation marker meaning "the server has confirmed
  there is nothing older". Distinct from "we have not looked yet".

## Success Criteria

- **SC-001**: With 2,000 messages on disk, the row count laid out after first
  paint is ≤ 2× the page size, and unchanged after five idle seconds.
  *(Today: 2,000 and climbing.)*
- **SC-002**: With 2,000 messages on disk, typing ten characters into the
  composer causes zero transcript row re-layouts.
- **SC-003**: Reaching the top loads exactly 50 messages, once, per trigger.
- **SC-004**: After a prepend, the previously-visible turn's screen offset
  changes by 0 points.
- **SC-005**: A device holding 100 of 500 server-side messages can scroll to
  message 1 without leaving the chat screen.
- **SC-006**: `direction=forward` and `direction=backward` produce provably
  different, correct pages against the real service — not just the mock.
- **SC-007**: The full gate is green: `npm run verify` and
  `ios/scripts/test.sh` (all three phases — `swift test` for SylKit, the
  live-backend phase, and `xcodebuild test`; `-scheme Syl` alone does **not**
  run SylKit and has previously reported green while counting 795 of 1094
  tests).
