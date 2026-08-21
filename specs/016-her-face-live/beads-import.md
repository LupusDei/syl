# Her Face, Live — Beads

**Feature**: `016-her-face-live`
**Root epic**: `syl-chzl` (P1, type=epic)
**Total beads**: **32** — 1 root + 7 sub-epics + 24 tasks
**Generated**: 2026-08-21 · all beads exist in the Dolt DB; this file is the map.
**Source**: `specs/016-her-face-live/tasks.md`

The root id was **auto-assigned by `bd`**, not claimed. Five id collisions in one
day in this project all had one cause: creating from a stale local view into a
namespace someone else was actively extending. Auto-assignment removes the class.

Hierarchy is **inferred from the id** in this beads install — `bd children
syl-chzl` returns all 32 — so parent/child needs no explicit wiring. The
`bd dep` edges below are **ordering** edges only.

## Root Epic

- **ID**: `syl-chzl`
- **Title**: Her face, live — a real-time character on her own voice, at the LiveKit layer
- **Type**: epic · **Priority**: P1

## Sub-epics

| Bead | Phase | Title | Priority | Tasks |
|---|---|---|---|---|
| `syl-chzl.1` | 1 | Prove it is possible at all — three cheap spikes against the three unproven risks | P1 | 4 |
| `syl-chzl.2` | 2 | The warm turn — this epic rides on `syl-per1` | P1 | 2 |
| `syl-chzl.3` | 3 | Session broker and cost guard — an idle session is a silent leak | P1 | 5 |
| `syl-chzl.4` | 4 | Her turn in the model-node seat | P1 | 3 |
| `syl-chzl.5` | 5 | The covering behaviour — what she does during the ~1.6s | P2 | 3 |
| `syl-chzl.6` | 6 | The face, as a choice prepared for the Commander | P2 | 3 |
| `syl-chzl.7` | 7 | The surface — iOS first, the web admin second | P2 | 4 |

## Tasks

### Phase 1 — Prove it is possible at all

| T-ID | Bead | Title | P | Primary file | Blocked by |
|---|---|---|---|---|---|
| T001 | `syl-chzl.1.1` | Spike: TTS synthesis latency for `HER_VOICE` | 1 | `scripts/experiments/tts-synthesis-latency.mjs` | — **(ready)** |
| T002 | `syl-chzl.1.2` | Spike: the `claude` binary as a LiveKit model node | 1 | `scripts/experiments/livekit-model-node.mjs` | — **(ready)** |
| T003 | `syl-chzl.1.3` | Spike: avatar worker on her audio | 1 | `scripts/experiments/livekit-avatar-audio.mjs` | — **(ready)** |
| T004 | `syl-chzl.1.4` | The Phase 1 verdict | 1 | `specs/016-her-face-live/findings.md` | T001, T002, T003 |

### Phase 2 — The warm turn

| T-ID | Bead | Title | P | Primary file | Blocked by |
|---|---|---|---|---|---|
| T005 | `syl-chzl.2.1` | Write down the lane split | 1 | `docs/CONTEXT.md` | T004 |
| T006 | `syl-chzl.2.2` | The warm-lane precondition | 1 | `backend/src/face/warm-lane.ts` | T005, **`syl-per1`** |

### Phase 3 — Session broker and cost guard

| T-ID | Bead | Title | P | Primary file | Blocked by |
|---|---|---|---|---|---|
| T007 | `syl-chzl.3.1` | The cost guard | 1 | `backend/src/face/face-cost-guard.ts` | T004 |
| T008 | `syl-chzl.3.2` | The session broker | 1 | `backend/src/face/face-session-broker.ts` | T009 |
| T009 | `syl-chzl.3.3` | The session ledger | 1 | `backend/src/face/face-session-store.ts` | T007 |
| T010 | `syl-chzl.3.4` | The idle reaper | 1 | `backend/src/face/idle-reaper.ts` | T008 |
| T011 | `syl-chzl.3.5` | The route and the contract | 1 | `backend/src/routes/face.ts` | T008, T006 |

Note the bead order is not the T-order: `T009` (the ledger) precedes `T008` (the
broker) in dependency terms because the broker records spend through the store.

### Phase 4 — Her turn in the model-node seat

| T-ID | Bead | Title | P | Primary file | Blocked by |
|---|---|---|---|---|---|
| T012 | `syl-chzl.4.1` | The turn node | 1 | `backend/src/face/turn-node.ts` | T006, T002 |
| T013 | `syl-chzl.4.2` | SOUL, memory and the fence hold | 1 | `backend/src/face/face-conversation.ts` | T012 |
| T014 | `syl-chzl.4.3` | A failed turn is something she says | 1 | `backend/src/face/turn-failure.ts` | T013 |

### Phase 5 — The covering behaviour

| T-ID | Bead | Title | P | Primary file | Blocked by |
|---|---|---|---|---|---|
| T015 | `syl-chzl.5.1` | Presence state | 2 | `backend/src/face/presence-state.ts` | T012 |
| T016 | `syl-chzl.5.2` | The covering behaviour | 2 | `backend/src/face/covering-behaviour.ts` | T015, T001 |
| T017 | `syl-chzl.5.3` | Write the honesty rule down | 2 | `SOUL.md`, `docs/CONTEXT.md` | T016 |

### Phase 6 — The face, as a choice prepared for the Commander

| T-ID | Bead | Title | P | Primary file | Blocked by |
|---|---|---|---|---|---|
| T018 | `syl-chzl.6.1` | Assemble the candidates | 2 | `backend/src/face/face-candidates.ts` | T004 |
| T019 | `syl-chzl.6.2` | The comparison surface | 2 | `frontend/src/features/face/FaceCandidates.tsx` | T018 |
| T020 | `syl-chzl.6.3` | File the likeness decision | 2 | `specs/016-her-face-live/likeness-brief.md` | T019 |

### Phase 7 — The surface

| T-ID | Bead | Title | P | Primary file | Blocked by |
|---|---|---|---|---|---|
| T021 | `syl-chzl.7.1` | SylKit asks for a face | 2 | `ios/SylKit/Sources/SylKit/Networking/SylAPI.swift` | T011 |
| T022 | `syl-chzl.7.2` | Her face on his phone | 2 | `ios/Syl/Features/Face/LiveFaceModel.swift` | T021, T016, T014 |
| T023 | `syl-chzl.7.3` | The operator's view | 2 | `frontend/src/features/face/LiveFace.tsx` | T011 |
| T024 | `syl-chzl.7.4` | The runbook entry | 2 | `docs/RUNBOOK.md` | T022, T023 |

## Summary

| Phase | Tasks | Priority | Bead |
|-------|-------|----------|------|
| 1: Prove it is possible at all | 4 | 1 | `syl-chzl.1` |
| 2: The warm turn | 2 | 1 | `syl-chzl.2` |
| 3: Session broker and cost guard | 5 | 1 | `syl-chzl.3` |
| 4: Her turn in the model-node seat | 3 | 1 | `syl-chzl.4` |
| 5: The covering behaviour | 3 | 2 | `syl-chzl.5` |
| 6: The face, prepared as a choice | 3 | 2 | `syl-chzl.6` |
| 7: The surface | 4 | 2 | `syl-chzl.7` |
| **Total tasks** | **24** | | |
| **Total beads** | **32** | | 1 root + 7 sub-epics + 24 tasks |

## Dependency Graph

```
              T001   T002   T003        <- the ready set, three files, no deps
                \      |      /
                     T004                <- the verdict: go / re-plan / stop
          ____________|____________________
         /            |                    \
       T005         T007                  T018      <- three tracks open here
         |            |                     |
  syl-per1 -> T006   T009                 T019
         |     \      |                     |
         |      \    T008                 T020  -> filed to the Commander
         |       \   /  \
         |        \ /    T010
         |        T011
         |         | \______________
       T012        |                \
      /    \     T021 [P]         T023 [P]
   T013   T015     \                /
     |      |       \              /
   T014   T016 ----- T022 --------/
            |          \         /
          T017          \       /
                          T024
```

## External dependency

`syl-per1` — *Persistent session: one process, many turns* — **already exists and
is open.** It is not duplicated by this epic. `syl-chzl.2.2` is wired to depend
on it, and `specs/016-her-face-live/plan.md` §Phase 2 records why: cold spawn
7450ms against warm 1635ms means that without it every utterance costs seven and
a half seconds.

## Ready set at creation

```
syl-chzl.1.1   T001   Spike: TTS synthesis latency
syl-chzl.1.2   T002   Spike: the claude binary as a LiveKit model node
syl-chzl.1.3   T003   Spike: avatar worker on her audio
```

Everything else is correctly blocked. Verified with `bd ready` after wiring — the
three spikes appear and no other task from this epic does, which is the intent:
the three unproven risks come first and cheaply, so the epic dies early if it is
going to die.

## Improvements

Level-4 beads (`syl-chzl.N.M.P`) are **not** pre-planned here. They are created
during implementation when a bug, a refactor or an extra test is discovered, as
children of the affected task.
