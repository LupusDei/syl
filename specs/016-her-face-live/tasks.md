# Tasks: Her Face, Live

**Input**: design documents in `specs/016-her-face-live/`
**Epic**: `syl-chzl` | **Branch**: `016-her-face-live`

## Format: `[ID] [P?] [Story] Description`

- **T-IDs** (`T001`…): authoring identifiers for this document.
- **Bead IDs** (`syl-chzl.N.M`): the runtime tracking identifiers. See
  `beads-import.md` for the mapping.
- **`[P]`**: may run in parallel — different files, no dependency between them.
- **`[US]`**: the user story it serves.
- **TDD-shaped**: every non-exempt task is Shape B — one task carrying explicit
  RED → GREEN phases. Exemptions in this epic: `[scaffold]` for Phase 1's
  throwaway spikes, `[docs]` for documentation-only work.

**Nothing after Phase 1 may assume anything Phase 1 did not prove.** If a spike
finds a different mechanism than the one a later task assumes, the later task
follows the spike.

---

## Phase 1: Prove it is possible at all (Priority: P1)

**Goal**: three unproven assumptions get cheap, throwaway tests before a line of
production code exists, each with a stated result that kills the epic.
**Independent Test**: `specs/016-her-face-live/findings.md` carries three
version-stamped numbers and a one-sentence verdict.

- [ ] T001 [P] [scaffold] [US1] Throwaway spike in `scripts/experiments/tts-synthesis-latency.mjs` measuring TTS synthesis latency for `HER_VOICE`. Not production, not TDD, no test file.

Drive her existing voice through the path production uses — `HER_VOICE` in
`backend/src/voice/her-voice.ts`, fetched as `reference-audio` and sent to
`POST /v1/text_to_speech` per `backend/src/voice/speech.ts`. Time from request to
first playable audio, over several realistic utterance lengths (one sentence,
two sentences, a short paragraph). Report per-utterance figures, a mean, and
**whether latency scales with character count** — that decides whether a long
answer is a different product from a short one. `RUNWAYML_API_SECRET` is already
forwarded; no new credential.

**Deliverable**: a number, written down, added to the measured 1635ms.

**What kills the epic**: if synthesis pushes total time-to-first-sound past
roughly 4 seconds on a one-sentence answer, a conversational face is refused at
this attach point. Between ~2s and ~4s the epic survives only because Phase 5
exists — the covering behaviour then has to carry the whole gap, and its budget
is set from this number.

- [ ] T002 [P] [scaffold] [US1] Throwaway spike in `scripts/experiments/livekit-model-node.mjs` putting the `claude` binary behind a LiveKit `AgentSession` as its model node. Not production, not TDD, no test file.

**THE BIGGEST RISK IN THE EPIC.** LiveKit's `AgentSession` expects a **streaming**
LLM node. Ours does not stream: measured at `28746b5`, first assistant text to
`result` is 2-15ms, and a 131-character answer arrived as ONE assistant event
with the result 31ms behind.

Stand up a minimal `AgentSession` with a custom LLM node backed by one persistent
`claude -p --input-format stream-json --output-format stream-json --verbose`
subprocess, in the shape of `scripts/experiments/persistent-session.mjs`. Send
one prompt, deliver the whole answer as a single chunk, confirm the session
accepts it and drives downstream TTS, then confirm a second turn on the same
process keeps its session id.

**Must also confirm**: `ANTHROPIC_API_KEY` is stripped from the child and the
init frame reports `apiKeySource === "none"`.

**What kills the epic**: if `AgentSession` has no way to accept a
non-incremental answer — no single-chunk path, no adapter seam, no way to wrap a
whole string as a completed stream — the LiveKit layer is the wrong attach point
and this epic is **re-planned from Phase 1 rather than patched**.

- [ ] T003 [P] [scaffold] [US1] Throwaway spike in `scripts/experiments/livekit-avatar-audio.mjs` checking that a LiveKit avatar worker lip-syncs to HER voice audio. Not production, not TDD, no test file.

The whole argument for attaching at the LiveKit layer is that the avatar worker
**consumes audio**. That is the claim; nobody has watched it happen. Publish an
audio track produced by `backend/src/voice/her-voice.ts` and
`backend/src/voice/speech.ts` into a LiveKit room, attach an avatar worker as the
consumer, and confirm the returned video track follows **that** audio rather than
audio the provider generated. Note which providers accept an externally supplied
track and which insist on owning TTS.

**What kills the epic as designed**: if avatar workers only lip-sync to
provider-owned TTS, her voice cannot drive the face. Shape C is then refused in
its current form and the choice becomes *give up her voice* or *give up the
face*. That choice is the Commander's and gets filed to him, not decided here.

- [ ] T004 [docs] [US1] Write the Phase 1 verdict in `specs/016-her-face-live/findings.md` — three numbers, three version stamps, one sentence of go / re-plan / stop.

Record from T001/T002/T003: the measured synthesis latency per utterance length
and the resulting total time-to-first-sound against 1635ms warm / 7450ms cold;
whether an `AgentSession` accepted a non-streaming model node and by what
mechanism, with the transcript; whether an avatar worker lip-synced to
externally supplied audio and which providers do; and the `apiKeySource` reading
from every spike turn.

**Stamp the CLI version, the LiveKit package versions and the date on every
number.** A load-bearing measurement against someone else's binary without a
version stamp is the mistake `docs/CONTEXT.md` §3 already records.

If any kill criterion fired, say which, and file the consequence to the
Commander via Adjutant `file_question` rather than choosing for him.

**Checkpoint**: the epic is proven possible, re-planned, or stopped. Everything
below depends on this file.

---

## Phase 2: The warm turn — this epic rides on `syl-per1` (Priority: P1)

**Goal**: the live lane runs warm, so an utterance costs ~1.6s rather than ~7.5s.
**Independent Test**: a face request on a cold path is refused with a reason that
names the cold path.

> `syl-per1` **already exists and is open.** It is not duplicated here. It owns
> the persistent session and its design questions: transparent respawn and
> `--resume` on a mid-turn death, idle reaping, telling a wedged process from a
> busy one, and whether interleaved conversations corrupt continuity. Its
> description is explicit that these *"must be DESIGNED, not stumbled into"*.

- [ ] T005 [docs] [US2] Write down the lane split in `docs/CONTEXT.md` (new subsection under §3) and in `specs/016-her-face-live/plan.md` — which turns run warm and which must not.

**Warm (persistent)**: the commander lane, and the live-face lane this epic adds.
Latency is felt by a person waiting, and cold spawn is 7450ms against warm
1635ms.

**Per-turn (spawn and die), unchanged**: scheduled jobs, the nightly
consolidation, the heartbeat, and anything reading untrusted content. Nobody is
waiting on these and the isolation is worth more than the seconds.

**Never warm**: `runReaderTurn` (`backend/src/harness/reader.ts`). Its security
property *is* the fresh, never-resumed, tool-less, auto-memory-off process. A
persistent reader session is a quarantine with a door in it.

- [ ] T006 [US2] Build the warm-lane precondition in `backend/src/face/warm-lane.ts`. Phases: write failing tests first in `backend/tests/unit/face-warm-lane.test.ts` → confirm RED → implement → confirm GREEN → refactor.

One predicate the broker consults before spending a credit: is the turn source a
warm persistent session, and is its child process healthy? If not, opening a face
is **refused with an honest reason** rather than opened onto a 7.45s first
utterance — a slow face reads as a rendering bug and sends the operator to the
wrong layer.

**Must also assert `apiKeySource === "none"`** for the session backing the lane
and refuse if it is anything else.

Tests cover: warm and healthy → permitted; no persistent session → refused
naming the cold path; session present but child dead → refused;
`apiKeySource` anything but `"none"` → refused regardless of warmth.

**Blocked on `syl-per1`** for the persistent-session API this predicate reads.

**Checkpoint**: the face can only open on a lane fast enough to be a
conversation.

---

## Phase 3: Session broker and cost guard (Priority: P1)

**Goal**: a session cannot leak money and the secret cannot leave the server.
**Independent Test**: an idle session is disconnected and accounted without
anyone touching it.

> Pattern source, read before writing:
> `~/code/ai/adjutant/backend/src/services/bridge-session-broker.ts` and
> `~/code/ai/adjutant/backend/src/services/bridge-cost-guard.ts`.

- [ ] T007 [US3] Build the cost guard in `backend/src/face/face-cost-guard.ts`. Phases: write failing tests first in `backend/tests/unit/face-cost-guard.test.ts` → confirm RED → implement → confirm GREEN → refactor.

Pure, in-memory, injectable clock. **No I/O in this file.** Three concerns:
a daily credit ceiling (`canStartSession()` / `recordSpend()`, resetting on the
next calendar day); an idle predicate (`isSessionIdle()` /
`shouldDisconnectIdle()`); and a live meter (`computeSessionMeter()` returning
elapsed seconds, blocks, credits and dollars).

**Cost model**: 2 credits up front, 2 credits per 6-second block, roughly
$0.01/credit — about 20 credits/minute, about **$0.20/minute**. **Partial blocks
bill UP**: a started block costs a full 2 credits. A guard that under-counts is
worse than no guard, because it reports safety it has not verified.

Tests cover: under the ceiling permits; at the ceiling refuses; the ceiling
resets on the next calendar day; a partial block rounds UP; negative elapsed time
from clock skew clamps to zero; idle past the timeout reports idle and inside it
does not.

- [ ] T009 [US3] Build the session ledger in `backend/src/face/face-session-store.ts` with its migration. Phases: write failing tests first in `backend/tests/unit/face-session-store.test.ts` → confirm RED → implement → confirm GREEN → refactor.

Files: `backend/src/face/face-session-store.ts`,
`backend/src/migrations/00NN_face_sessions.sql`,
`backend/tests/unit/face-session-store.test.ts`.

**Migration number: take the LOWEST FREE number immediately before writing the
file, and check ORIGIN, not your branch.** `readMigrations` enforces a contiguous
sequence and hard-fails on a gap, so a file numbered above a missing one takes
down every test that opens a database — for a reason its author did not cause. A
missing *highest* number is not a gap. `git fetch origin` and read
`backend/src/migrations/` there.

Stores one row per face session: id, opened-at, closed-at, credits, dollars, and
how it ended (closed / reaped / expired / failed). A daily ceiling that resets on
restart is not a ceiling, and "how much did that cost" is asked after the fact.

Tests cover: a session round-trips; the day's total sums across sessions; an
unclosed session from a previous process is visible and countable; reaped and
expired are distinguishable end-states.

- [ ] T008 [US3] Build the session broker in `backend/src/face/face-session-broker.ts`. Phases: write failing tests first in `backend/tests/unit/face-session-broker.test.ts` → confirm RED → implement → confirm GREEN → refactor.

`startSession()` gates on the cost guard, creates the realtime session, **records
the upfront spend immediately**, polls to READY, and returns one-shot browser
credentials. `renewSession()` is a fresh create plus re-seed — realtime sessions
cannot be extended — re-gated and re-charged. `msUntilExpiry()` / `isExpiring()`
give the caller time to pre-empt the cap. `recordSessionEnd()` settles,
excluding the already-charged upfront so it is never double-counted.

**Security, non-negotiable**: `RUNWAYML_API_SECRET` lives inside the HTTP client
and is never part of anything returned. Only a short-lived `sessionKey` crosses
the boundary. The test asserts the returned credential object contains **no
substring of the configured secret** — an assertion about the value, not the
field names, because a field rename is exactly how this leaks.

Poll interval and clock are injected; no real timers and no network in the tests.

Tests cover: happy path to READY; the guard refuses before any HTTP call is made;
create succeeds then READY never arrives (upfront still recorded, session
reported failed); the secret never appears in returned credentials; renew charges
again; `recordSessionEnd` excludes the upfront.

- [ ] T010 [US3] Build the idle reaper in `backend/src/face/idle-reaper.ts`. Phases: write failing tests first in `backend/tests/unit/face-idle-reaper.test.ts` → confirm RED → implement → confirm GREEN → refactor.

**This has its own task because it is not optional.** An open session bills by
the second whether or not anyone is there. A forgotten one is a silent leak, and
a silent leak is this project's most-repeated defect shape. Folding the reaper
into the broker is how it gets quietly dropped under schedule pressure.

On an injected timer it asks the guard which sessions have passed their idle
timeout, disconnects them, and writes end-of-session accounting with end-state
`reaped`. It **logs every reap** with the session id, the idle duration and the
credits spent — a session that disappears without a line in the log is
indistinguishable from one that crashed.

**Never silently**: a reap that fails to disconnect retries, then escalates
loudly. An unreachable session still billing is exactly the condition the reaper
exists to prevent, and a swallowed error there is the leak wearing the guard's
uniform.

Tests cover: an idle session is reaped and accounted; an active session is not; a
session that receives input before the timeout is not reaped; disconnect failure
retries then escalates rather than dropping the session from tracking; the clock
is injected so no test waits on a real timer.

- [ ] T011 [US3] Build the face session routes in `backend/src/routes/face.ts` and the contract entry in `shared/openapi.yaml`. Phases: write failing tests first in `backend/tests/integration/face-sessions.test.ts` → confirm RED → implement → confirm GREEN → refactor.

`POST /api/v1/face/sessions` opens and returns `{ sessionId, sessionKey,
expiresAt }` **and nothing more**. `DELETE /api/v1/face/sessions/{id}` closes and
settles. `GET /api/v1/face/sessions/{id}` reports state and the live meter.

A paired device may open a face — it is his own conversation — and may read the
meter and the day's spend, which are his money and his data. Follow the scope
model in `backend/src/routes/logs.ts` for how a refusal is expressed: 403 for an
authenticated caller lacking the scope, an ordinary indistinguishable 401 for an
anonymous one, so scope is never disclosed to someone who has not authenticated.

`shared/openapi.yaml` is updated **in this task**, and
`backend/tests/integration/contract-conformance.test.ts` must stay green — a
route the contract does not describe is a route the Swift client cannot be
generated against.

Tests cover: open returns a `sessionKey` and no secret; open with a tripped
ceiling returns a structured refusal naming the ceiling, not a 500; open on a
cold lane is refused by T006's predicate; close settles once and is idempotent on
a second call; an anonymous caller gets 401.

**Checkpoint**: a client can ask for a face, and nothing it receives can spend
money on its own.

---

## Phase 4: Her turn in the model-node seat (Priority: P1)

**Goal**: she answers with her face as herself — same brain, same soul, same
fence.
**Independent Test**: a face turn appears in the same transcript as a text turn,
with `SOUL.md` in its system prompt.

- [ ] T012 [US4] Build the turn node in `backend/src/face/turn-node.ts`. Phases: write failing tests first in `backend/tests/unit/face-turn-node.test.ts` → confirm RED → implement → confirm GREEN → refactor.

The adapter that puts her turn in the model-node seat of a LiveKit
`AgentSession`, **built on exactly the mechanism T002 proved and on nothing it
did not**. If T002 found a different seam, this task follows T002, not this
description.

**There is no token streaming.** The complete answer lands in one piece when the
turn is done, so this adapter emits the whole answer as a single completed unit.
Any code here that waits for incremental deltas waits forever, and **any test
that mocks a multi-chunk stream is testing a fiction** — the fake emits one
chunk, because that is what the real binary does.

**It must not buffer-and-chunk the finished answer to imitate streaming.** That
adds latency to hide a property of the system; Phase 5 covers the gap honestly
instead.

Tests cover: a whole answer is delivered and accepted; a second turn reuses the
same process and keeps its session id; a turn exceeding its timeout surfaces as
an error rather than a hang; the adapter never needs more than one chunk to
complete a turn.

- [ ] T013 [US4] Build the face conversation seam in `backend/src/face/face-conversation.ts`. Phases: write failing tests first in `backend/tests/unit/face-conversation.test.ts` → confirm RED → implement → confirm GREEN → refactor.

**This is where the attach-point argument stops being a claim about wiring.**
Wiring rots and claims do not fail loudly; a test does.

Routes a face turn through the same seam every other turn uses —
`backend/src/services/conversation-service.ts` — so `SOUL.md` is appended to the
system prompt, her memory graph is in context, the turn is appended to the
conversation, and one turn runs at a time per conversation.

Tests that **are** the security argument: a face turn appends both the question
and her reply, so what she said with her face is in the same transcript as what
she said in text; the system prompt for a face turn contains `SOUL.md`;
`ANTHROPIC_API_KEY` is absent from the child environment and the init frame
reports `apiKeySource === "none"`, and a turn where it is anything else is
**refused rather than run**; two face turns on one conversation serialise.

- [ ] T014 [US4] Build the failure path in `backend/src/face/turn-failure.ts`. Phases: write failing tests first in `backend/tests/unit/face-turn-failure.test.ts` → confirm RED → implement → confirm GREEN → refactor.

`conversation-service.ts` already holds the rule: a failed turn is a message,
never silence. On a face the stakes are higher, because **silence has a body** —
a person is looking at her waiting for an answer that is not coming, and there is
no spinner to explain it.

Every failure mode becomes something she says, in her voice, through the same
audio path as an ordinary answer: the turn timed out, the process died, the
session expired mid-answer, the daily ceiling tripped. Each gets a **distinct**
honest line — "something went wrong" four times in a row teaches him the face is
broken rather than which thing broke.

Must not: invent an answer, pretend the question was not heard, or drop the
covering behaviour into an infinite think. A think that never resolves is the
uncovered blank with extra steps.

Tests cover: each failure mode produces a distinct spoken line; the line goes
through the real audio path, not a text-only channel; the covering behaviour is
cleared before the failure line plays; a failure during the failure line does not
recurse; a ceiling trip says so plainly rather than blaming the network.

**Checkpoint**: she answers with her face, as herself, and fails out loud.

---

## Phase 5: The covering behaviour (Priority: P2)

**Goal**: the ~1.6s looks like a person considering a question.
**Independent Test**: with a turn artificially slowed, the face shows a thinking
behaviour throughout and nothing from the speech-implying set.

- [ ] T015 [US5] Build the presence state machine in `backend/src/face/presence-state.ts`. Phases: write failing tests first in `backend/tests/unit/face-presence-state.test.ts` → confirm RED → implement → confirm GREEN → refactor.

`IDLE → LISTENING → THINKING → SPEAKING → IDLE`, with transitions driven **only
by real events**. `THINKING` is raised when a turn actually starts and dropped on
`result` or on error. `SPEAKING` is raised when audio actually begins.

It is its own module because if the behaviour driver derives its own states from
timers, it will eventually be showing a state the system is not in — and the one
state that must never be faked is the one that says she is about to speak.

**There is deliberately no "about to speak" state.** With no token streaming,
nothing in the system knows speech is imminent until the whole answer exists and
synthesis has produced audio.

Tests cover: `THINKING` is not entered without a turn in flight; `THINKING` drops
on result and on error alike; `SPEAKING` is not entered before audio exists; an
error during `THINKING` lands in `IDLE`, not `SPEAKING`; states are observable so
the driver can subscribe.

- [ ] T016 [US5] Build the covering behaviour driver in `backend/src/face/covering-behaviour.ts`. Phases: write failing tests first in `backend/tests/unit/face-covering-behaviour.test.ts` → confirm RED → implement → confirm GREEN → refactor.

Subscribes to T015's state and issues avatar behaviours: on `THINKING`, a glance
and a breath — the things a person does while considering a question. On
`SPEAKING`, hand over to the audio. On `IDLE`, settle. **The budget comes from
T001's measured synthesis number, not from a guess.**

**The honesty rule, tested**: raised only while a turn is genuinely in flight;
drops on result **and** on error; emits **no** mouth shape, **no**
in-breath-before-speaking and **no** filler audio, because each implies speech
that may never come; and a think that outlasts its budget **stays a think** —
Phase 4's failure line is what eventually speaks.

A face that pretends to be about to talk and then does not is a lie he will catch
once and never trust again.

Tests cover: `THINKING` raises the behaviour; result clears it; error clears it;
no emitted behaviour in the `THINKING` set is a member of the speech-implying
set; an over-budget think does not change category.

- [ ] T017 [docs] [US5] Write the honesty rule into `SOUL.md` and `docs/CONTEXT.md`, with the measurement and its provenance.

So the next person to touch the avatar does not add a filler animation because
the pause looked awkward. Record the rule — the covering behaviour represents
real thinking, is raised only while a turn is in flight, and never implies speech
that is not coming — and the reason: there is no token streaming, the whole
answer arrives at once 2-15ms before the turn ends, so nothing can know speech is
imminent until synthesis has produced audio. A gesture that says "about to talk"
is always a guess, and a guess wearing her face is a lie.

Cite `scripts/experiments/first-token-latency.mjs` at `28746b5`, ~1635ms warm /
7450ms cold, **with the CLI version stamp**.

**Checkpoint**: the gap is covered, honestly.

---

## Phase 6: The face, as a choice prepared for the Commander (Priority: P2)

**Goal**: he gets a real choice, not an engineer's guess with more steps.
**Independent Test**: the question is on his dashboard and nothing in the tree
has chosen a face.

> **NO TASK IN THIS PHASE MAY PICK A LIKENESS.** `syl-ate.1`: every face she can
> currently adopt is a frame of a render that was itself anchored on an earlier
> face, so *"the search can only drift from where it started; it cannot jump."*

- [ ] T018 [US6] Build the candidate set in `backend/src/face/face-candidates.ts`. Phases: write failing tests first in `backend/tests/unit/face-candidates.test.ts` → confirm RED → implement → confirm GREEN → refactor.

Gathers the likenesses a live face could use, **with provenance attached to
each**: where it came from, what it descends from, and whether it is a frame
lifted from an existing render or an independently generated still.

Provenance is the point. A candidate list without lineage looks like a choice and
is actually one lineage wearing several hats, so the list reports **how many
distinct roots it actually contains**.

**No ranking, no default, no preferred.** This module returns a set. It exposes
no "best", no ordering that implies preference, and no field a later caller could
mistake for a recommendation.

Tests cover: candidates carry provenance; two candidates from one lineage are
reported as one root, not two; the returned set exposes no ranking or default
field; an empty studio returns an empty set with an honest reason rather than a
fabricated candidate.

- [ ] T019 [US6] Build the comparison surface in `frontend/src/features/face/FaceCandidates.tsx`. Phases: write failing tests first in `frontend/tests/unit/face-candidates.test.ts` → confirm RED → implement → confirm GREEN → refactor.

An admin view laying T018's candidates side by side, each labelled with its
provenance and its lineage root, so a person can see at a glance that four
candidates are three views of one guess.

It is a surface and not a report because **the decision is visual**. A brief
describing faces in prose is how the sixth face happened —
`docs/CONTEXT.md` records it as *"a prescription in a brief"*. He needs to look
at them.

**No selection control that commits.** The view may let him mark a preference to
carry into the filed question; it may not write a chosen likeness anywhere.

Tests cover: candidates render with provenance visible; candidates sharing a
lineage root are grouped as one root; the empty set renders an honest empty
state; **no control in the view writes a likeness to the backend**.

- [ ] T020 [docs] [US6] Write `specs/016-her-face-live/likeness-brief.md` and file it to the Commander via Adjutant `file_question`.

The brief carries the candidate set with provenance and lineage roots, how many
distinct roots there actually are, where the comparison surface can be seen, and
what is **not** being asked — not her voice, which is settled, and not the attach
point.

State the problem plainly: every face she has descends from an engineer's
original guess, and if the candidates all share that root the brief says so and
offers the alternative — generating a candidate that is not a derivative of it,
which is what `syl-ate.1` is about.

**File it via Adjutant `file_question`.** Never `AskUserQuestion` — he is not at
a terminal. Never stdout — he watches the dashboard.

**Then stop.** No task picks a likeness, no task installs a default "for now",
and **no task treats silence as consent**. Later phases run against a face that
is visibly a placeholder.

**Checkpoint**: the choice is his, and it is waiting for him.

---

## Phase 7: The surface (Priority: P2)

**Goal**: she appears where he looks.
**Independent Test**: he opens the app, speaks, and she answers with a face that
moved the whole time.

- [ ] T021 [P] [US7] Add face session methods to `ios/SylKit/Sources/SylKit/Networking/SylAPI.swift`. Phases: write failing tests first in `ios/SylKit/Tests/SylKitTests/FaceSessionTests.swift` → confirm RED → implement → confirm GREEN → refactor.

Client methods for the three routes T011 defines: open, read state and meter,
close. They return the short-lived `sessionKey` and nothing else — the API secret
has no representation in SylKit and no place to be stored on a phone.

`shared/openapi.yaml` is the contract and the Swift client is written against it;
the contract-conformance path must stay green. `docs/CONTEXT.md` records that a
contract change and the Swift client are not separable and that no single command
tells you — so this task runs the contract tests on **both** sides before it is
done.

Tests cover: a successful open decodes `sessionId`, `sessionKey` and `expiresAt`;
a ceiling refusal decodes as a structured error carrying its reason, not a
generic failure; a 401 is handled by the existing auth path; close is idempotent
from the client's point of view.

- [ ] T022 [US7] Build the iOS face surface in `ios/Syl/Features/Face/LiveFaceModel.swift` and `ios/Syl/Features/Face/LiveFaceView.swift`. Phases: write failing tests first in `ios/SylTests/LiveFaceTests.swift` → confirm RED → implement → confirm GREEN → refactor.

**iOS is first because that is where he looks at her.** Opens a session through
T021, joins the room with the short-lived `sessionKey`, renders the avatar video
track, plays her audio, and shows the covering behaviour honestly — a face that
is thinking looks like it is thinking, and a face that has failed says so in her
voice rather than freezing.

Must handle: the session cap arriving mid-conversation (pre-empt with a renew
rather than dropping him); the daily ceiling tripping (an honest message, not a
spinner); **the app backgrounding (close the session)** — a face nobody is
looking at is exactly the idle leak the reaper exists for, and the client should
not make the reaper do work the client can do instantly; a lost network.

Model and view are separate files because the model is what the tests drive.
`docs/CONTEXT.md` records that `ImageRenderer` renders neither a `ScrollView` nor
a `NavigationStack`; behaviour lives in the model and the view stays thin enough
to test through it.

Tests cover: opening publishes exactly one session; backgrounding closes it;
foregrounding does not silently reopen; a session nearing expiry renews before it
drops; a ceiling refusal surfaces as her honest message; a failed turn shows the
spoken failure rather than a stalled face.

- [ ] T023 [P] [US7] Build the operator's view in `frontend/src/features/face/LiveFace.tsx`. Phases: write failing tests first in `frontend/tests/unit/live-face.test.ts` → confirm RED → implement → confirm GREEN → refactor.

Served by Syl herself at `/admin` from `frontend/dist`, same origin as
`/api/v1`. Shows the current face session, its live meter in credits and dollars,
the day's spend against the ceiling, and the idle countdown. It can close a
session.

**The meter is the point here**: this is the surface where a leak becomes
visible. A session running with nobody in front of it should be obvious at a
glance, and the day's spend readable without doing arithmetic. The reaper is the
mechanism; this is the instrument that shows the mechanism working.

Tests cover: an open session renders with a live meter; the meter matches the
cost model (2 credits up front, 2 per 6-second block, partial blocks rounded UP);
no session renders an honest empty state; the day's spend renders against the
ceiling; closing from here settles the session once.

- [ ] T024 [docs] [US7] Add a face section to `docs/RUNBOOK.md` — opening, closing, and spotting a session nobody closed.

Cover: how to open and close a session by hand, and on which port — **Syl's
service is on 8888, and the service is never started by hand without an explicit
port**, because Adjutant holds 4201 and a by-hand bind alongside it
half-succeeds, which takes out the neighbour rather than failing loudly. What the
meter means in money: 2 credits up front, 2 per 6-second block, about 20
credits/minute, about $0.20/minute at roughly $0.01/credit, partial blocks billed
up. The daily ceiling, where it is configured, and what a tripped ceiling looks
like from the phone and from the admin. How to spot a session nobody closed, what
the reaper will do about it and when, and how to reap one by hand if the reaper
is wedged. Which failure modes are hers to speak and which are the operator's to
fix.

**Checkpoint**: she is on his phone, and a leak is visible from the admin.

---

## Dependencies

Ordering edges, as wired in beads:

```
T001, T002, T003        (no dependencies — the ready set)
T004                    <- T001, T002, T003
T005                    <- T004
T006                    <- T005, syl-per1
T007                    <- T004
T009                    <- T007
T008                    <- T009
T010                    <- T008
T011                    <- T008, T006
T012                    <- T006, T002
T013                    <- T012
T014                    <- T013
T015                    <- T012
T016                    <- T015, T001
T017                    <- T016
T018                    <- T004
T019                    <- T018
T020                    <- T019
T021                    <- T011
T023                    <- T011
T022                    <- T021, T016, T014
T024                    <- T022, T023
```

Phase-level edges mirror these: Phase 2, 3 and 6 wait on Phase 1; Phase 4 waits
on Phases 2 and 3; Phase 5 waits on Phase 4; Phase 7 waits on Phases 4, 5 and 6.

## Parallel Opportunities

- **Now**: T001, T002, T003 — three different files, no dependency between them.
- **After T004**, three tracks open at once: the pipeline (T005 → T006 → …), the
  likeness (T018 → T019 → T020), and — once T012 lands — the behaviour
  (T015 → T016 → T017). The likeness track should start early, because it ends in
  a question that has to wait for him.
- **In Phase 7**: T021 (Swift) and T023 (React) — different languages, different
  workspaces, both gated on T011 and on nothing else.

**Serialised on purpose**: everything inside Phase 3 after T007. T008, T009 and
T010 are one accounting story, and two agents in it at once produce a merge, not
progress.
