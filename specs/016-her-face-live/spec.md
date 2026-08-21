# Feature Specification: Her Face, Live

**Feature Branch**: `016-her-face-live`
**Epic**: `syl-chzl`
**Created**: 2026-08-21
**Status**: Draft

A live, speaking face for Syl. She appears, she listens, and she answers in her
own voice with a face that moves — without her brain leaving the `claude` binary
and without leaving subscription rails.

---

## The measurements this spec rests on

From `scripts/experiments/first-token-latency.mjs`, committed at **`28746b5`**.
Every number below is reproducible by running that file. Everything downstream
of this section is a consequence of these four facts, not a preference.

### 1. Warm is 1635ms. Cold is 7450ms.

Time to her **first assistant text** on a persistent session:

```
turn 1 (pays CLI startup)   7450ms
follow-ups                  1983ms, 1455ms, 1466ms   ->  avg 1635ms
```

A conversation cannot pay 7.45 seconds per utterance. The live lane must run
warm, which is why Phase 2 exists and why this epic depends on `syl-per1`.

### 2. THERE IS NO TOKEN STREAMING.

The gap between her first assistant text and `result` is **2-15ms**. Confirmed
against a longer prompt: **131 characters arrived as ONE assistant event, with
the result 31ms behind it.**

`--output-format stream-json` streams **EVENTS, NOT TOKENS**. The complete
answer lands in one piece when the turn is done.

### 3. The consequence that decides the whole design.

**An avatar cannot start speaking on the first words and stream the rest.**
There are no first words until there are all the words. So:

```
time to first SOUND  =  the whole turn  +  TTS synthesis
                     =  ~1635ms warm    +  [MEASURED BY T001]
```

**NO TASK IN THIS EPIC MAY ASSUME TOKEN STREAMING.** Any code that waits for
incremental deltas waits forever; any test that mocks a multi-chunk stream is
testing a fiction.

### 4. `apiKeySource` was `"none"` on every turn.

The measurement was taken on subscription rails and stays there. Any task that
touches the child process preserves that and asserts it. A set
`ANTHROPIC_API_KEY` silently outranks the claude.ai login and reroutes billing
to the metered API — the strongest constraint in the project (`adj-t64m9`).

**A load-bearing measurement against someone else's binary has a shelf life.**
`docs/CONTEXT.md` §3 records what it cost when one silently decided the
architecture. Every number recorded by this epic carries a version stamp and a
re-run command.

---

## The architecture

### Attach at the LiveKit layer, not Runway's SDK layer

LiveKit does not render avatars. It is **transport plus orchestration**, with
sixteen avatar providers behind it, Runway among them. Runway's own avatar SDK
is LiveKit underneath — `@runwayml/avatars-node-rpc` depends transitively on
`@livekit/rtc-node`.

### Why lower is the whole point

At the LiveKit layer, **the avatar worker CONSUMES AUDIO**. That single property
buys three things this project will not give up:

1. **Her brain stays the `claude` binary on subscription rails.** The face is a
   consumer of her output, not a replacement for it.
2. **HER voice drives the face.** The voice in `backend/src/voice/` — `HER_VOICE`
   in `her-voice.ts`, spoken through `speech.ts` — produces the audio the avatar
   lip-syncs to.
3. **The face stays swappable.** Sixteen providers behind one transport means
   changing the face is a configuration change, not a rewrite.

Attaching higher — at Runway's avatar SDK — would put **Runway's model in the
talking seat**, bypassing `SOUL.md`, her memory graph and the reader fence.
That is refused. Phase 4 makes the refusal a tested property rather than a
claim about wiring, because wiring rots and claims do not fail loudly.

### Shape C, the hybrid

**The avatar owns the immediate social layer** — a glance, a breath, an honest
thinking behaviour — **while her turn completes behind it.**

This is **required, not decorative**. It is what covers the ~1635ms plus
synthesis. A face that goes blank and still for 1.6 seconds is worse than no
face: the halo she has today never pretended to be about to speak, and a frozen
face does.

---

## User Scenarios & Testing

### User Story 1 — She is possible at all (Priority: P1)

Before a line of production code, three unproven assumptions get cheap,
throwaway tests, each with a stated result that **kills the epic**.

**Why this priority**: the three risks are the epic. If a LiveKit
`AgentSession` cannot take a non-streaming model node, everything after Phase 1
is void. Finding that out in a spike costs a day; finding it out in Phase 4
costs the epic's whole budget and the credibility of the plan.

**Independent Test**: `specs/016-her-face-live/findings.md` exists, carries three
numbers with version stamps, and states go / re-plan / stop in one sentence.

**Acceptance Scenarios**:

1. **Given** her existing voice and a realistic utterance, **When** T001 runs,
   **Then** a synthesis latency is recorded and added to 1635ms to give a real
   time-to-first-sound.
2. **Given** one persistent `claude` subprocess, **When** T002 feeds a whole
   answer to a LiveKit `AgentSession` as its model node, **Then** the session
   accepts it, drives TTS, and a second turn keeps the same session id — or the
   spike reports exactly where it refuses.
3. **Given** an audio track produced by her voice, **When** T003 attaches an
   avatar worker as consumer, **Then** the returned video is lip-synced to that
   audio and not to audio the provider generated.
4. **Given** any spike turn, **When** the init frame is read, **Then**
   `apiKeySource` is `"none"`.

---

### User Story 2 — She answers fast enough to be a conversation (Priority: P1)

The live lane runs on a persistent session, so an utterance costs ~1.6s to her
first text rather than ~7.5s.

**Why this priority**: the difference between a conversation and a status page.

**Independent Test**: the warm-lane predicate refuses to open a face on a cold
path, with a reason that names the cold path.

**Acceptance Scenarios**:

1. **Given** a warm, healthy persistent session, **When** a face is requested,
   **Then** it opens.
2. **Given** no persistent session, **When** a face is requested, **Then** it is
   refused with an honest reason rather than opened onto a 7.45s first
   utterance.
3. **Given** a session whose `apiKeySource` is anything but `"none"`, **When** a
   face is requested, **Then** it is refused regardless of warmth.

---

### User Story 3 — A session cannot leak money (Priority: P1)

The broker gates, meters, records and reaps. The secret never leaves the server.

**Why this priority**: this guards real money at about **$0.20/minute**, and an
idle session is a silent leak — this project's most-repeated defect shape.

**Independent Test**: an idle session is disconnected and accounted without
anyone touching it, and the browser never receives anything derived from
`RUNWAYML_API_SECRET`.

**Acceptance Scenarios**:

1. **Given** a session created successfully, **When** it never reaches READY,
   **Then** the upfront credits are still recorded — the provider charged them.
2. **Given** a session quiet past its idle timeout, **When** the reaper runs,
   **Then** it is disconnected, accounted with end-state `reaped`, and logged
   with its id, idle duration and spend.
3. **Given** the daily ceiling is reached, **When** a face is requested,
   **Then** it is refused with a structured reason naming the ceiling — not a
   500, and not a silent open.
4. **Given** any successful open, **When** the returned credentials are
   inspected, **Then** no substring of the configured secret appears in them.

---

### User Story 4 — She speaks as herself (Priority: P1)

A face turn goes through the same seam as every other turn, so `SOUL.md`, her
memory graph and the reader fence all still apply.

**Why this priority**: it is the reason for the attach point. Without it, the
epic has built a nicer way to talk to somebody else's model.

**Independent Test**: a face turn appears in the same conversation transcript as
a text turn, and its system prompt contains `SOUL.md`.

**Acceptance Scenarios**:

1. **Given** a spoken question, **When** she answers with her face, **Then**
   both the question and her reply are appended to the conversation.
2. **Given** a face turn, **When** its system prompt is inspected, **Then**
   `SOUL.md` is in it.
3. **Given** two face turns on one conversation, **When** they overlap,
   **Then** the second waits — one turn at a time per conversation.
4. **Given** a turn that fails or times out, **When** the face is watched,
   **Then** she says something honest and distinct to that failure, in her
   voice, through the real audio path. **Never silence.**

---

### User Story 5 — The pause looks like thinking, and never like speech (Priority: P2)

**Independent Test**: with a turn artificially slowed, the face shows a thinking
behaviour throughout and no behaviour from the speech-implying set.

**Acceptance Scenarios**:

1. **Given** a turn in flight, **When** the face is watched, **Then** a glance
   and a breath — the things a person does while considering a question.
2. **Given** a turn that ends in an error, **When** the behaviour is checked,
   **Then** it drops, exactly as it does on success.
3. **Given** a think that outlasts its budget, **When** it continues, **Then**
   it stays a think and does not escalate into a mouth shape, an in-breath
   before speaking, or filler audio.

---

### User Story 6 — The likeness is his to choose (Priority: P2)

**Independent Test**: a brief exists, a comparison surface renders the
candidates with their lineage, the question is filed through Adjutant, and no
likeness has been written anywhere.

**Acceptance Scenarios**:

1. **Given** the candidate set, **When** it is read, **Then** every candidate
   carries its provenance and its lineage root, and candidates sharing a root
   are reported as one root rather than several choices.
2. **Given** the comparison surface, **When** a control is used, **Then**
   nothing writes a chosen likeness to the backend.
3. **Given** the brief, **When** it is filed, **Then** it goes through Adjutant
   `file_question` — never `AskUserQuestion`, never stdout.
4. **Given** no answer yet, **When** later phases run, **Then** they run against
   a **visibly** placeholder face. Silence is not consent.

---

### User Story 7 — She is where he looks (Priority: P2)

iOS first, the web admin second.

**Independent Test**: he opens the app, sees her, speaks, and she answers — and
backgrounding the app closes the session.

**Acceptance Scenarios**:

1. **Given** the app in the foreground, **When** a face is opened, **Then**
   exactly one session exists.
2. **Given** the app is backgrounded, **When** it leaves the foreground,
   **Then** the session is closed immediately rather than left for the reaper.
3. **Given** a session nearing its cap, **When** it approaches expiry, **Then**
   it renews before it drops him.
4. **Given** the web admin, **When** a session is running, **Then** its live
   meter and the day's spend against the ceiling are readable at a glance.

---

### Edge Cases

- **The session cap lands mid-answer.** A realtime session cannot be extended; a
  renew is a fresh create and a re-charge. The client pre-empts.
- **The persistent process dies mid-turn.** `syl-per1` owns transparent respawn
  and `--resume`; the face shows the failure line rather than freezing.
- **The daily ceiling trips while she is speaking.** She finishes the utterance
  and says plainly that she is out, rather than cutting off mid-word.
- **The reaper cannot disconnect an idle session.** It retries and then escalates
  loudly. An unreachable session still billing is exactly what the reaper exists
  to prevent; a swallowed error there is the leak wearing the guard's uniform.
- **The app is killed rather than backgrounded.** The reaper is the backstop; the
  client close is the fast path. Both exist because either alone leaks.
- **Synthesis latency scales with answer length.** If T001 finds it does, a long
  answer is a different product from a short one and Phase 5's budget must be a
  function, not a constant.
- **No candidates in the studio.** The candidate set returns empty with an honest
  reason rather than a fabricated face.

---

## Requirements

### Functional Requirements

- **FR-001**: The system MUST attach at the LiveKit layer, with the avatar worker
  consuming audio produced by `HER_VOICE`.
- **FR-002**: The system MUST NOT place any provider's model in the answering
  seat. Every face turn goes through the same conversation seam as a text turn.
- **FR-003**: The system MUST NOT assume token streaming anywhere.
- **FR-004**: The system MUST NOT buffer-and-chunk a finished answer to imitate
  streaming. That adds latency to hide a property of the system; Phase 5 covers
  the gap honestly instead.
- **FR-005**: The live lane MUST run on a persistent session and MUST refuse to
  open on a cold path.
- **FR-006**: `runReaderTurn` MUST NOT become persistent, and the per-turn path
  MUST remain for scheduled jobs, nightly consolidation and untrusted reads.
- **FR-007**: `ANTHROPIC_API_KEY` MUST be stripped from the child process and
  `apiKeySource === "none"` asserted on every live turn.
- **FR-008**: `RUNWAYML_API_SECRET` MUST never leave the server. Only a
  short-lived `sessionKey` crosses to a client.
- **FR-009**: The cost guard MUST bill partial 6-second blocks UP and MUST NOT
  under-count.
- **FR-010**: An idle session MUST be auto-disconnected, accounted and logged.
  This is not optional and not foldable into another component.
- **FR-011**: A failed turn MUST produce something she says, distinct to the
  failure mode. Never silence.
- **FR-012**: The covering behaviour MUST be raised only while a turn is in
  flight, MUST drop on result and on error alike, and MUST emit nothing that
  implies imminent speech.
- **FR-013**: No task MAY pick a likeness. Candidates carry provenance and
  lineage; the decision is filed to the Commander via Adjutant `file_question`.
- **FR-014**: Every measurement recorded by this epic MUST carry a version stamp
  and a re-run command.

### Key Entities

- **Face session**: one live avatar session. Id, opened-at, closed-at, credits,
  dollars, and how it ended — closed by the user, reaped as idle, expired, or
  failed. Persisted, because a daily ceiling that resets on restart is not a
  ceiling.
- **Presence state**: `IDLE -> LISTENING -> THINKING -> SPEAKING -> IDLE`, driven
  only by real events. There is deliberately **no "about to speak" state**,
  because nothing in the system can know that.
- **Face candidate**: a likeness with its provenance and its lineage root. No
  ranking, no default, no field a caller could mistake for a recommendation.

---

## Success Criteria

- **SC-001**: `findings.md` records three measured results with version stamps
  and a one-sentence verdict, before any production code exists.
- **SC-002**: Time to first sound on a warm lane is measured end to end and
  matches ~1635ms plus T001's synthesis number, within the spike's own variance.
- **SC-003**: A face turn appears in the same conversation transcript as a text
  turn, with `SOUL.md` in its system prompt — asserted by test.
- **SC-004**: An idle session left alone is disconnected, accounted and logged
  without human action — asserted by test with an injected clock.
- **SC-005**: No returned credential contains any substring of the configured
  API secret — asserted by test on the value, not the field names.
- **SC-006**: No behaviour emitted while `THINKING` is a member of the
  speech-implying set — asserted by test.
- **SC-007**: The likeness question is filed to the Commander and no likeness is
  written anywhere in the repository before he answers.
- **SC-008**: He opens the app, speaks, and she answers with a face that moved
  the whole time.

---

## Out of scope

- **Building the persistent session.** That is `syl-per1`, which already exists
  and is open. This epic depends on it and does not duplicate it.
- **Generating a new candidate likeness** from `gen4_image` on `text_to_image`.
  That is `syl-ate.1`. Phase 6 names it as the alternative in the brief and
  stops there.
- **Voice selection.** Settled: she uses `HER_VOICE`.
- **Audio input as a general capability.** She still cannot hear a voice and
  judge it; that is why Phase 6 needs him.
