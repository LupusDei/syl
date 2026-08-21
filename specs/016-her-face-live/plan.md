# Implementation Plan: Her Face, Live

**Branch**: `016-her-face-live` | **Date**: 2026-08-21
**Epic**: `syl-chzl` | **Priority**: P1

## Summary

Give Syl a live, speaking face by attaching at the **LiveKit** layer — transport
plus orchestration, sixteen avatar providers behind it — so the avatar worker
**consumes audio** her existing voice produced, her brain stays the `claude`
binary on subscription rails, and the face is swappable. Because there is no
token streaming (measured: first assistant text to `result` is 2-15ms), the
avatar cannot speak on the first words; **Shape C** covers the ~1635ms with an
honest thinking behaviour while the turn completes behind it. Seven phases,
ordered so the three unproven risks are tested first and cheaply.

## Bead Map

- `syl-chzl` — Root: Her face, live — a real-time character on her own voice, at the LiveKit layer
  - `syl-chzl.1` — Phase 1: Prove it is possible at all
    - `syl-chzl.1.1` — T001 Spike: TTS synthesis latency for `HER_VOICE`
    - `syl-chzl.1.2` — T002 Spike: the `claude` binary as a LiveKit model node
    - `syl-chzl.1.3` — T003 Spike: avatar worker on her audio
    - `syl-chzl.1.4` — T004 The Phase 1 verdict
  - `syl-chzl.2` — Phase 2: The warm turn — this epic rides on `syl-per1`
    - `syl-chzl.2.1` — T005 Write down the lane split
    - `syl-chzl.2.2` — T006 The warm-lane precondition
  - `syl-chzl.3` — Phase 3: Session broker and cost guard
    - `syl-chzl.3.1` — T007 The cost guard
    - `syl-chzl.3.2` — T008 The session broker
    - `syl-chzl.3.3` — T009 The session ledger
    - `syl-chzl.3.4` — T010 The idle reaper
    - `syl-chzl.3.5` — T011 The route and the contract
  - `syl-chzl.4` — Phase 4: Her turn in the model-node seat
    - `syl-chzl.4.1` — T012 The turn node
    - `syl-chzl.4.2` — T013 SOUL, memory and the fence hold
    - `syl-chzl.4.3` — T014 A failed turn is something she says
  - `syl-chzl.5` — Phase 5: The covering behaviour
    - `syl-chzl.5.1` — T015 Presence state
    - `syl-chzl.5.2` — T016 The covering behaviour
    - `syl-chzl.5.3` — T017 Write the honesty rule down
  - `syl-chzl.6` — Phase 6: The face, as a choice prepared for the Commander
    - `syl-chzl.6.1` — T018 Assemble the candidates
    - `syl-chzl.6.2` — T019 The comparison surface
    - `syl-chzl.6.3` — T020 File the likeness decision
  - `syl-chzl.7` — Phase 7: The surface
    - `syl-chzl.7.1` — T021 SylKit asks for a face
    - `syl-chzl.7.2` — T022 Her face on his phone
    - `syl-chzl.7.3` — T023 The operator's view
    - `syl-chzl.7.4` — T024 The runbook entry

**External dependency**: `syl-per1` (open) blocks `syl-chzl.2.2`.

## Technical Context

**Stack**: Node 22 (`.nvmrc` 22.23.1), TypeScript strict with
`noUncheckedIndexedAccess`, Vitest; React + Vite for the web admin; Swift /
SwiftUI + SylKit (SPM) for iOS. LiveKit for transport and avatar orchestration.
**Storage**: `syl.db` via `node:sqlite`, one new migration for the session ledger.
**Testing**: Vitest for backend and frontend; XCTest for iOS and SylKit.
**Ports**: Syl's service is **8888**. Adjutant holds 4200/4201. Never start the
service by hand without an explicit port.
**Credentials**: `RUNWAYML_API_SECRET` is already forwarded. **No new credential
is introduced by this epic.**
**Constraints**: subscription rails only; `apiKeySource === "none"` asserted on
every live turn; no token streaming anywhere; ~$0.20/minute of avatar time.

## Architecture Decision

### Why the LiveKit layer and not Runway's avatar SDK

Runway's avatar SDK is LiveKit underneath — `@runwayml/avatars-node-rpc` depends
transitively on `@livekit/rtc-node`. So the choice is not "LiveKit or Runway";
it is **which layer of the same stack we sit on**.

One layer up, the provider's model does the talking. That bypasses `SOUL.md`,
her memory graph and the reader fence, and it puts her identity in a vendor's
weights. **Refused.**

One layer down, the avatar worker is a **consumer of audio**. `HER_VOICE` makes
the sound, the worker lip-syncs to it, and the provider is a rendering detail
behind a transport with fifteen alternatives.

That property — *the worker consumes audio* — is the entire argument, and T003
exists because nobody has watched it happen yet.

### Why Shape C rather than "just wait"

There is no token streaming. Time to first sound is the whole turn plus
synthesis. On a warm lane that is ~1635ms plus T001's number. A face that sits
motionless for that long is worse than the halo she has now, because the halo
never implied it was about to speak.

So the avatar owns the immediate social layer while the turn runs. **Required,
not decorative.** And bounded by honesty: the behaviour represents real thinking
and never implies speech, because nothing in the system can know speech is
imminent until synthesis has produced audio.

### Rejected: fake the stream

Buffer the finished answer and emit it in chunks so the session sees a stream.
Rejected — it adds latency to hide a property of the system, and the hiding is
the problem. Phase 5 covers the gap by being honest about it.

## Files Changed

| File | Change |
|------|--------|
| `scripts/experiments/tts-synthesis-latency.mjs` | New — throwaway spike (T001) |
| `scripts/experiments/livekit-model-node.mjs` | New — throwaway spike (T002) |
| `scripts/experiments/livekit-avatar-audio.mjs` | New — throwaway spike (T003) |
| `specs/016-her-face-live/findings.md` | New — the Phase 1 verdict (T004) |
| `docs/CONTEXT.md` | The lane split (T005); the honesty rule (T017) |
| `backend/src/face/warm-lane.ts` | New — refuse a face on a cold path (T006) |
| `backend/src/face/face-cost-guard.ts` | New — pure ceiling, meter, idle predicate (T007) |
| `backend/src/face/face-session-store.ts` | New — durable session ledger (T009) |
| `backend/src/migrations/00NN_face_sessions.sql` | New — lowest free number, checked against ORIGIN (T009) |
| `backend/src/face/face-session-broker.ts` | New — lifecycle; the secret stays here (T008) |
| `backend/src/face/idle-reaper.ts` | New — the auto-disconnect (T010) |
| `backend/src/routes/face.ts` | New — open / read / close (T011) |
| `shared/openapi.yaml` | The face session routes (T011) |
| `backend/src/face/turn-node.ts` | New — one whole answer into the session (T012) |
| `backend/src/face/face-conversation.ts` | New — SOUL, memory, fence, serialisation (T013) |
| `backend/src/face/turn-failure.ts` | New — she says what went wrong (T014) |
| `backend/src/face/presence-state.ts` | New — the honest state machine (T015) |
| `backend/src/face/covering-behaviour.ts` | New — glance and breath (T016) |
| `SOUL.md` | The honesty rule (T017) |
| `backend/src/face/face-candidates.ts` | New — candidates with lineage (T018) |
| `frontend/src/features/face/FaceCandidates.tsx` | New — the comparison surface (T019) |
| `specs/016-her-face-live/likeness-brief.md` | New — the filed decision (T020) |
| `ios/SylKit/Sources/SylKit/Networking/SylAPI.swift` | Face session methods (T021) |
| `ios/Syl/Features/Face/LiveFaceModel.swift` | New — the tested behaviour (T022) |
| `ios/Syl/Features/Face/LiveFaceView.swift` | New — the thin view (T022) |
| `frontend/src/features/face/LiveFace.tsx` | New — the operator's meter (T023) |
| `docs/RUNBOOK.md` | Opening, closing, and spotting a leak (T024) |

**Naming note**: the module directory is `backend/src/face/`, not
`backend/src/live/`. In this repository "live" already means *a running Syl
service* — `backend/tests/integration/live-service.test.ts`,
`backend/tests/helpers/live-service.ts`. Reusing it would produce two meanings
for one word in one tree.

## Phase 1: Prove it is possible at all

**Three cheap throwaway spikes, first, so the epic dies early if it is going to
die.** Each states what result kills it, so a negative outcome is actionable
rather than discouraging. All three are `[scaffold]` — explicitly not production
and explicitly not TDD, in the shape `first-token-latency.mjs` already
established.

They touch three different files with no dependency between them, so all three
are `[P]`. T004 gates on all three and writes the verdict.

**Nothing after this phase may assume anything this phase did not prove.** If
T002 finds a different seam than the one assumed here, Phase 4 follows T002.

## Phase 2: The warm turn — this epic rides on `syl-per1`

`syl-per1` **already exists and is open**. It is not duplicated here; this epic
declares the dependency and builds the two pieces specific to a face.

Its own description warns that persistence reintroduces a process to supervise,
a crash that costs more than one turn, and backpressure — and that these
**"must be DESIGNED, not stumbled into"**. Those design questions belong to
`syl-per1`: transparent respawn and `--resume` on a mid-turn death, idle reaping,
telling a wedged process from a busy one, and whether interleaved conversations
corrupt continuity.

**What stays on the per-turn path, unchanged**: scheduled jobs, the nightly
consolidation, the heartbeat, and anything reading untrusted content.
**`runReaderTurn` must never become persistent** — its security property *is* the
fresh, never-resumed, tool-less, auto-memory-off process.

## Phase 3: Session broker and cost guard

Reuse the patterns Adjutant's Bridge already proved:
`~/code/ai/adjutant/backend/src/services/bridge-session-broker.ts` and
`~/code/ai/adjutant/backend/src/services/bridge-cost-guard.ts`. Read both before
writing.

**Cost model**: 2 credits up front per session, 2 credits per 6-second streaming
block — about 20 credits/minute, about **$0.20/minute** at roughly $0.01/credit.
Partial blocks bill **UP**. A guard that under-counts is worse than no guard,
because it reports safety it has not verified.

**The secret stays server-side.** Only a short-lived `sessionKey` reaches the
browser, and the test asserts on the *value*, not the field names — a field
rename is exactly how this leaks.

**The idle auto-disconnect is not optional** and gets its own task (T010) so it
cannot be folded into the broker and quietly dropped. An idle session is a
silent leak, which is this project's most-repeated defect shape.

## Phase 4: Her turn in the model-node seat

The adapter between her subprocess and the LiveKit session, **built on exactly
what T002 proved and on nothing it did not**.

Three tasks, deliberately separate files: the adapter itself (T012), the proof
that `SOUL.md` / memory / the fence still hold (T013), and the failure path
(T014). T013 is where the attach-point argument stops being a claim about wiring
and becomes an assertion that fails when someone re-wires it.

## Phase 5: The covering behaviour

An honest state machine (T015) and a driver that reads it (T016). Separate,
because if the driver derives its own states from timers it will eventually show
a state the system is not in — and the state that must never be faked is the one
that says she is about to speak.

The budget comes from T001's number, not from a guess.

## Phase 6: The face, as a choice prepared for the Commander

**NO TASK IN THIS PHASE MAY PICK A LIKENESS.**

`syl-ate.1` records the trap: every face she can currently adopt is a frame of a
render that was itself anchored on an earlier face, so *"the search can only
drift from where it started; it cannot jump."* Choosing again from inside that
lineage repeats an engineer's original guess with more steps.

So this phase assembles candidates **with their lineage**, builds the surface to
compare them, files the question through Adjutant `file_question`, and stops. No
default is installed "for now" and **silence is not consent** — later phases run
against a placeholder that is visibly a placeholder.

## Phase 7: The surface

**iOS first**, because that is where he looks at her. The web admin second — it
is the operator surface where a leak becomes visible, and it is not where the
relationship happens.

Model and view are separate files on iOS because the model is what the tests
drive; `docs/CONTEXT.md` records that `ImageRenderer` renders neither a
`ScrollView` nor a `NavigationStack`.

## Parallel Execution

**Now**: T001, T002, T003 — three files, no dependency between them.

**After the Phase 1 verdict (T004)**, three tracks open at once:

- **Track A — the pipeline**: T005 → T006 → (T012 → T013 → T014) and
  (T007 → T009 → T008 → T010 → T011)
- **Track B — the likeness**: T018 → T019 → T020. Zero file overlap with A, and
  it should start early because it ends in a question that has to wait for him.
- **Track C — the behaviour**: T015 → T016 → T017, once T012 lands.

**In Phase 7**, T021 (SylKit, Swift) and T023 (web admin, React) are `[P]` —
different languages, different workspaces, both gated on T011 and on nothing
else.

**Serialised on purpose**: everything inside Phase 3 after T007. T008, T009 and
T010 form one accounting story and two agents in it at once produce a merge, not
progress. This repository has already paid twice for concurrent writes to a
shared tree.

## Verification Steps

- [ ] `findings.md` carries three numbers, three version stamps, and a verdict.
- [ ] `npm run verify` at the repo root — typecheck plus tests, failures ==
      declared.
- [ ] `bd ready` shows the three spikes and nothing else from this epic.
- [ ] Open a face from the phone and speak; she answers, and the face moved the
      whole time.
- [ ] Leave a session open and walk away; the reaper closes it and the log says
      so with the id, the idle duration and the spend.
- [ ] Grep the browser payload for any substring of `RUNWAYML_API_SECRET` — zero
      hits.
- [ ] Trip the daily ceiling deliberately; the phone shows her honest message,
      not a spinner.
- [ ] The likeness question appears on his dashboard, and nothing in the tree has
      chosen a face.
