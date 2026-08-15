# Beads Import: Fifty At A Time

**Root epic**: `syl-025` (P0, type=epic)
**Total beads**: 25 — 1 root + 6 sub-epics + 18 tasks
**Created**: 2026-08-14 · all beads exist in the Dolt DB; this file is the map.

Hierarchy is **inferred from the ID** in this beads install — `bd children
syl-025` returns all 25. Epic→task `bd dep add` is rejected (*"epics can only
block other epics, not tasks"*), so parent/child needs no explicit wiring and the
`bd dep` edges below are **ordering** edges only.

## Sub-epics

| Bead | Phase | Title | Priority |
|---|---|---|---|
| `syl-025.1` | 1 | Foundational: the runaway load, and the batch of fifty | P0 |
| `syl-025.2` | 2 | US1: opening the chat is instant, and stays instant | P0 |
| `syl-025.3` | 3 | US2: scrolling up loads fifty more, and keeps his place | P1 |
| `syl-025.4` | 4 | US3: history older than this device is reachable | P1 |
| `syl-025.5` | 5 | US4: the contract stops lying about `direction` | P2 |
| `syl-025.6` | 6 | Polish: the window has a ceiling, and the screen has manners | P2 |

## Tasks

| T-ID | Bead | Title | P | Primary file | Blocked by |
|---|---|---|---|---|---|
| T001 | `syl-025.1.1` | The failing test: a long transcript must not grow unattended | 0 | `ios/SylTests/ChatTests.swift` | — |
| T002 | `syl-025.1.2` | One page size, named once, equal to 50 | 0 | `ios/Syl/Features/Chat/ChatViewModel.swift` | T001 |
| T003 | `syl-025.1.3` | Kill the self-retriggering load | 0 | `ios/Syl/Features/Chat/ChatView.swift` | T002 |
| T004 | `syl-025.2.1` | The failing test: first paint must not measure the whole transcript | 0 | `ios/SylTests/ChatFreezeTests.swift` | T003 |
| T005 | `syl-025.2.2` | Replace `.defaultScrollAnchor(.bottom)` without losing first-paint placement | 0 | `ios/Syl/Features/Chat/ChatView.swift:219` | T004 |
| T006 | `syl-025.2.3` | Isolate the composer draft from the transcript | 0 | `ios/Syl/Features/Chat/ChatComposer.swift` | T005 |
| T007 | `syl-025.3.1` | The failing test: prepend must not move the read position | 1 | `ios/SylTests/ChatTests.swift` | T006 |
| T008 | `syl-025.3.2` | Proximity-triggered load, one in flight | 1 | `ios/Syl/Features/Chat/ChatView.swift` | T007 |
| T009 | `syl-025.3.3` | Scroll-position preservation across a prepend | 1 | `ios/Syl/Features/Chat/ChatView.swift` | T008 |
| T010 | `syl-025.4.1` | The failing test: scrolling past the local floor reaches the server | 1 | `ios/SylTests/ChatTests.swift` | T009 |
| T011 | `syl-025.4.2` | Persist the history floor per conversation | 1 | `ios/Syl/Core/Store/SylDatabase.swift` | T010 |
| T012 | `syl-025.4.3` | Wire `SylAPI.messages` into `loadEarlier` | 1 | `ios/Syl/Features/Chat/ChatViewModel.swift` | T011 |
| T013 | `syl-025.4.4` | Offline and terminal states for the earlier control | 1 | `ios/Syl/Features/Chat/ChatChrome.swift:126` | T012 |
| T014 | `syl-025.5.1` | The failing test: `direction=forward` walks forward | 2 | `backend/tests/unit/message-store.test.ts` | — **(ready now)** |
| T015 | `syl-025.5.2` | Honour `direction` in the store and the route | 2 | `backend/src/services/message-store.ts:379` | T014 |
| T016 | `syl-025.6.1` | Collapse the window on returning to the foot | 2 | `ios/Syl/Features/Chat/ChatViewModel.swift` | T013 |
| T017 | `syl-025.6.2` | Accessibility: focus and announcement across a prepend | 2 | `ios/Syl/Features/Chat/ChatView.swift` | T013 |
| T018 | `syl-025.6.3` | Record the mechanism in `docs/CONTEXT.md` | 2 | `docs/CONTEXT.md` | T013 |

## Two independent tracks

**Track A (iOS, serial)** — T001 → T002 → T003 → T004 → T005 → T006 → T007 →
T008 → T009 → T010 → T011 → T012 → T013 → {T016, T017, T018}

The serialisation is not timidity. T002/T003 both edit `ChatViewModel.swift`;
T005/T006 both edit `ChatView.swift` and `ChatViewModel.swift`; T008/T009 both
edit the scroll container. Two agents in those files at once produce a merge, not
progress — and this repository has already paid twice for concurrent writes to a
shared tree.

**Track B (backend, serial, starts immediately)** — T014 → T015

Zero file overlap with Track A. Different workspace, different language, no
shared build.

## Ready set at creation

```
syl-025.1.1   T001   (Track A head)
syl-025.5.1   T014   (Track B head)
```

Everything else is correctly blocked. `bd ready` truncates at 100 rows against a
260-issue backlog — T014 is unblocked despite not appearing in the first page.

## What is deliberately NOT here

- **No backend migration.** `messages_conversation_seq_idx ON messages
  (conversation_id, seq DESC)` already serves both paging directions. No number
  is claimed. *(For reference only: origin is at `0035`.)*
- **No new endpoint.** `GET /conversations/{id}/messages` already does the job.
- **No new SylKit endpoint.** `SylAPI.messages(...)` already exists; T012 gives
  it its first production caller.
- **No pre-planned improvements.** Level-4 beads (`syl-025.N.M.P`) get created
  during implementation when a bug or refactor actually shows up.
