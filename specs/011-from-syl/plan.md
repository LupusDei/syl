# Implementation Plan — From Syl

**Feature**: `011-from-syl` · **Epic**: `syl-015` · **Priority**: P0
**Date**: 2026-08-11
**Spec**: `specs/011-from-syl/spec.md` (renamed from `008-she-can-show-him`; `008` was used twice)

## Summary

She finds her own likeness, voice and expressions, and shows him what she made — on
her own initiative, at a rate rather than on a schedule. The root bead `syl-015`
carries ten acceptance criteria and nothing is done until the last is true.

This plan does **not** restate the six phases. Each of `syl-015.1` … `syl-015.6`
already carries its own DONE WHEN, written before this plan existed. Everything
below ladders up to those sentences and adds nothing to them.

## Where this plan starts from, which is not zero

This epic was written as a correction: three features were already being built from
conversation rather than from a tracked plan. So the plan's job is the opposite of
the usual one — it is to write down **what is left**, and to write down nothing that
somebody is already holding.

| phase | state on 2026-08-11 | what this plan adds |
|---|---|---|
| `.1` she renders herself | **CLOSED** — shipped and deployed, verified on the running service | nothing |
| `.2` the hourly turn | **built** on `syl-heartbeat`, being merged as this was written | verification against its DONE WHEN on the *running* service, the two gaps that DONE WHEN exposes, and deploy |
| `.3` sendings backend | **in flight** — table, triggers, store, service, media, routes, contract, mock, sync and ~1500 lines of tests all exist | only the five gaps the in-flight work does not reach |
| `.4` From Syl surface | not started, unblocked now that `.3`'s contract exists | the whole surface, iOS only |
| `.5` her voice | not started | narrow: one id, speak, mux. No design, no iteration, no choosing |
| `.6` proof | not started | one task, his, cannot be automated |

## Bead Map

- `syl-015` — Syl 15: she finds herself, and shows him
  - `syl-015.1` — Phase 1: she renders herself — **CLOSED**, no tasks
  - `syl-015.2` — Phase 2: the hourly turn
    - `syl-015.2.1` — T001 Quiet hours cannot be pierced from the heartbeat lane
    - `syl-015.2.2` — T002 `npm run when` reads the real quiet window instead of a copy
    - `syl-015.2.3` — T003 The rate counts sendings, not only reminders
    - `syl-015.2.4` — T004 The ceiling refuses, rather than recording a failure after the fact
    - `syl-015.2.5` — T005 Verify the hour on the running service, and write down what it said
    - `syl-015.2.6` — T006 Deploy the hourly turn
  - `syl-015.3` — Phase 3: sendings — the backend
    - `syl-015.3.1` — T007a Failing tests for the sending verb
    - `syl-015.3.2` — T007b The sending verb, so she can make one
    - `syl-015.3.3` — T008a Failing tests for a sending stranded pending
    - `syl-015.3.4` — T008b The recovery pass, on boot, `RenderService.resume()`-shaped
    - `syl-015.3.5` — T009 The `0024` collision, which stops a boot rather than a test
    - `syl-015.3.6` — T010 Verify acceptance 3, 4 and 6 on the running service
  - `syl-015.4` — Phase 4: From Syl — the surface
    - `syl-015.4.1` — T011 The contract on the phone: `Sending`, the endpoint, the fixtures
    - `syl-015.4.2` — T012 Sendings on disk, so the surface opens offline
    - `syl-015.4.3` — T013 `SendingSource` — fetch, store, project
    - `syl-015.4.4` — T014a Failing tests for the From Syl list and its snapshot
    - `syl-015.4.5` — T014b `FromSylListView` and `SendingListSnapshot`
    - `syl-015.4.6` — T015 `FromSylScreen` and its view model
    - `syl-015.4.7` — T016 The door: a third destination beside Goals and Memory
    - `syl-015.4.8` — T017 Tapping plays her, with the poster as the still
    - `syl-015.4.9` — T018 Open it on his phone, and write down what it showed
  - `syl-015.5` — Phase 5: her voice — use the one he made
    - `syl-015.5.1` — T019 Crack `voice.type` by asking the validator, not by guessing
    - `syl-015.5.2` — T020 One voice id, in her home, in one place
    - `syl-015.5.3` — T021a Failing tests for the speech client, from captured output
    - `syl-015.5.4` — T021b The speech client
    - `syl-015.5.5` — T022 The mux — her voice onto the render, the render untouched
    - `syl-015.5.6` — T023 A sending carries her voice
  - `syl-015.6` — Phase 6: proof
    - `syl-015.6.1` — T024 The proof, which is his

## Technical Context

**Stack**: TypeScript strict (`noUncheckedIndexedAccess`), Node ≥22.13, Express,
SQLite (STRICT tables, numbered SQL migrations), Vitest. Swift 6 / SwiftUI / XCTest
on iOS, with a dependency-free local SwiftPM package `SylKit` and GRDB in the app
target only.

**Gate**: `npm run verify` (`typecheck` then `test:gate`). Never `npm test` alone.
iOS: `ios/scripts/test.sh`, whose three phases cannot be collapsed into one command.

**Storage**: `backend/src/migrations/NNNN_snake_case.sql`, four digits, sequential.
`0024_sendings.sql` is the highest in flight. **Take the lowest free number
immediately before writing the file** — numbers cannot be reserved and have collided
repeatedly on this project.

**Her home**: `~/.syl`. Renders, stills, reference, sessions, database, and now her
voice. Nothing of hers lives in a checkout, and nothing of hers lives where the OS
may empty it (`backend/src/render/studio.ts`).

**Constraints inherited and non-negotiable**: subscription rails only; the official
`claude` binary owns the credential path; `ANTHROPIC_API_KEY` stripped from children;
never silently drop a reach; IANA timezones, never fixed offsets.

## Architecture decisions this plan makes

**1. The phone learns that a video landed by asking again, not by a socket frame.**
A sending is created `pending` and its video is attached seconds to minutes later.
The obvious answer is a websocket frame. It is the wrong one here: `SyncEngine`
carries an open P0 (`syl-011.9` — it advances its cursor past pages it did not
apply), and the documented precedent for a new read-time surface is
`ConstellationSource` — direct fetch into `LocalStore`, snapshot out. The push
notification already carries her sentence and already wakes the app; refetching
`GET /sendings` on foreground is both simpler and correct while `syl-011.9` is open.
**No websocket work is planned.** If `syl-011.9` closes and live arrival becomes
wanted, that is a new bead, not a hidden one here.

**2. The ceiling must refuse, not regret.** The hourly turn counts what she spent by
reading the `runs` table after the turn, and marks the run a failure if she went over.
Root acceptance 7 says *at most two sendings a day*, and `syl-015.2`'s DONE WHEN says
she *cannot exceed the rate*. A run marked failed after a third sending already
reached him is not "cannot". T004 moves the ceiling to the tool boundary, where a
refusal is a sentence she can read and act on.

**3. The muxed video and the compressed copy are both derived; the render is the
record.** Same rule already stated for the send copy in `syl-015.3` and for renders in
`SOUL.md`. Neither the voice work nor the reaping task may modify or remove anything
under `~/.syl/renders`.

**4. `.4` is one screen and a door, not a gallery.** The spec is explicit that a grid
of every experiment separates the picture from the reason. The list is one row per
sending: her face as the still, her words beneath, the date.

## Files this plan touches

| File | Change |
|------|--------|
| `backend/src/jobs/heartbeat-job.ts` | `REACHES_HIM` learns the sending verb; the allowance is enforced rather than observed |
| `backend/src/harness/cli/when.ts` | stop hardcoding a quiet window that disagrees with `config.ts` |
| `backend/tests/integration/heartbeat-wiring.test.ts` | the structural quiet-hours proof |
| `backend/src/tools/schemas.ts`, `client.ts`, `server.ts` | the sending verb; the ceiling refuses |
| `backend/src/index.ts` | the recovery pass called from `bootstrap` |
| `backend/src/services/sending-service.ts` | recovery; the muxed copy becomes the video |
| `backend/src/migrations/` | the contested `0024`, renumbered at merge, with a test that catches the next one |
| `backend/src/render/studio.ts` | `voiceAt(root)` beside `studioAt(root)` |
| `backend/src/render/voice.ts` (new) | speak, and mux |
| `shared/openapi.yaml`, `shared/fixtures/` | fixtures for the iOS contract tests |
| `ios/SylKit/Sources/SylKit/Model/Sending.swift` (new) | the model |
| `ios/SylKit/Sources/SylKit/Networking/SylAPI.swift` | `sendings(cursor:limit:)` |
| `ios/Syl/Core/Store/SylDatabase.swift`, `Records.swift`, `LocalStore.swift` | sendings on disk |
| `ios/Syl/Features/FromSyl/*.swift` (new) | the surface |
| `ios/Syl/Features/Home/HomeView.swift`, `HomeScreen.swift` | the third destination |
| `ios/Syl/App/AppDelegate.swift`, `ios/Syl/SylApp.swift` | the source, and `attachmentContext` off the Chat tab |
| `docs/RUNBOOK.md`, `docs/VIDEO.md` | what the running service said; what the validator said |

## Phase 2 — the hourly turn

Built. What is left is the part that a branch cannot prove: that on the machine that
actually runs her, she wakes every hour, usually says nothing, cannot reach him
between 22:00 and 08:00, and cannot exceed two a day.

Two gaps that the DONE WHEN exposes and the branch does not close: the rate counts
`remind_me` and nothing else, so the sending verb would be uncounted the day it lands
(the file's own comment says so); and the ceiling is read after the turn rather than
enforced during it. Both are in this phase because both are the sentence *cannot
exceed the rate*.

`npm run when` is the hand tool used to reason about the window during that
verification, and it hardcodes `23:00` where `config.ts` says `22:00`. An instrument
that is an hour wrong is worse than no instrument.

## Phase 3 — sendings, the backend

**Almost entirely built by another agent, and this plan deliberately writes no task
for any of it**: `0024_sendings.sql` with the never-delete and never-rewrite triggers,
`sending-store.ts`, `sending-service.ts` (words appended and push enqueued strictly
before the render is looked at), `sending-media.ts` (compression, poster at 0.35 of
duration so it is never frame zero), `routes/sendings.ts`, `shared/openapi.yaml` +
`types.ts` + the mock server, `sync-service.ts` learning the `sending` type, and four
test files.

Five gaps were identified against that work and put to the agent holding it before a
single task was written. **It claimed two of them and they were landed while this plan
was being drafted** — the live broadcast of her words (done by taking
`chat: ConversationService` and appending through `chat.append()` + `chat.accept()`,
rather than a second sink, because the socket already subscribes itself via
`chat.setSink`) and the reaping of the derived working directory (`#reap(sendingId)`,
after the bytes reach the attachment store). **Neither is planned here.**

Three remain, and they are the difference between a table that works and a thing she
can do:

1. **There is no verb.** `TOOLS` in `backend/src/tools/schemas.ts` has thirteen
   entries and none of them composes a sending. Until it exists she cannot make one at
   all, acceptance 3 and 4 cannot be true on her own initiative, and `syl-015.2`'s rate
   ceiling counts a thing that does not exist. Ranked first by the agent holding the
   phase, which stayed out of `backend/src/tools/` because `schemas.ts` is shared with
   `render_me`/`see_myself` and another agent is working in it.
2. **A crash between `create()` and `attachVideo()` strands the row `pending`
   forever** — `#follow` is a detached in-process promise and `drain()` only survives
   a clean shutdown. Ranked *high* by the same agent, and it is right to: her words
   already reached him saying something was coming, and nothing ever says it is not.
   That is the render-shaped version of a dropped reminder, which constraint 4 forbids.
   `RenderService.resume()`, called from `bootstrap`, is the precedent to copy.
3. **Nothing has verified acceptance 3, 4 and 6 on the running service** — that the
   notification really carries her sentence, and that SQLite really refuses a DELETE.

Plus one integration hazard that is nobody's feature and will stop a boot:
`0024_sendings.sql` and `agent/fenix`'s `0024_working_memory_budget.sql` are the same
number on two branches, and `readMigrations` hard-fails on a *gap*, so the second to
merge cannot simply become `0025`. T009 makes that a red test instead of a service
that will not start. (The gap half of that check already exists in `readMigrations` —
it is what taught the `.3` agent that `0024` was the only free number — so T009's new
coverage is the *duplicate* half, and its value is failing at `npm test` rather than
at boot.)

**Where the work is.** `.3` is committed to `feat/from-syl-backend` at `cc8e44e`,
branched from `origin/main` and **neither merged nor pushed** — 25 files. Anything that
calls `POST /sendings` must branch from there, not from `main`. Its gate ran 4666
passed / 4 failed / 16 skipped, all four failures declared (`syl-b97` ×3, `syl-dep1.7`).

**One guard that will fire on the unwary.** Routing her words through
`ConversationService` made `sending-service.ts` the third caller of
`chat.accept`/`chat.append`, and `backend/tests/integration/chat-wiring.test.ts`
asserts that caller list exactly. The distinction it encodes is real — the other two
carry a message from *him*, a sending is Syl originating — so a fourth caller is a
question to answer, not a test to update. T003 and T007b both name it.

## Phase 4 — From Syl, the surface

iOS only. Unblocked: `.3` has published `Sending`, `SendingPage`, `SendingState` and
`GET /sendings` with cursor paging, newest first.

The app is a three-tab `TabView`; Today roots the only `NavigationStack`
(`ios/Syl/Features/Home/HomeScreen.swift:63`) and its single
`navigationDestination(for: HomeView.Destination.self)` at line 86 switches over
`goals`, `memory`, `today`. From Syl is a fourth case and a third real destination.

Follow the **Goals** shape, not Memory's: `XScreen` owns the lifecycle, `XListView` is
a pure function of an optional snapshot (`nil` means "not asked yet" — bare veil,
never a spinner and never a false empty state), `XViewModel` is `@MainActor` and reads
`LocalStore` only, and the snapshot plus its loader live in their own file so they are
testable without SwiftUI. Every list view takes `scrolls: Bool = true` because
`ImageRenderer` lays out nothing inside a `ScrollView`.

Two traps, both already paid for once:

- **`\.attachmentContext` is set only on the Chat tab** (`ios/Syl/SylApp.swift:107`).
  A From Syl row that loads bytes without it gets nothing, silently.
- **Adding a case to `HomeView.Destination` breaks every exhaustive switch over it**,
  which is the stated reason `onCapture` was a closure. The file says so at lines
  47–51.

New files need no `.pbxproj` edit — both targets use
`PBXFileSystemSynchronizedRootGroup`.

## Phase 5 — her voice

Narrow by his ruling: *"Don't worry too much about the voice, just build in the one I
provided."* Use `Syl High Pitch`, `93b52581-17ab-4905-bb5a-4fa730a7757a`. Build
nothing that creates, lists, compares or replaces a voice.

The one unknown is the `voice.type` discriminator on `POST /v1/text_to_speech`.
Fifteen values have already been refused: `prompt`, `text`, `id`, `library`, `custom`,
`preset`, `voice`, `description`, `sample`, `clone`, `audio`, `generated`, `designed`,
`text_prompt`, `audio_sample`. **Do not guess a sixteenth.** Post an empty body and
read `issues[]`, then narrow one field at a time — the technique that cracked every
other Runway schema on this project, documented at
`/Users/Reason/code/ai/runwayml/RUNWAY_API_INDEX.md:134`. Note that
`~/.syl/voice/README.md` records the same technique cracking `POST /v1/voices`, whose
answer was `from: { type: "text", model, prompt }` — a *sibling* schema, and a useful
prior, not the answer.

Then mux with ffmpeg, which is already an injected dependency for frame extraction
(`ffmpegRunner` in `backend/src/render/frames.ts:100`). The muxed copy is derived. The
render is not touched.

## Phase 6 — proof

One task. He goes a full day without asking, and finds something from her in From Syl
that he is glad to have. It cannot be automated and no test may claim to stand in for
it — the same shape as `syl-009.7.2`, which was the only honest test of whether
reminders worked.

## Parallel execution

- `.2` and `.3` are independent of each other except at two seams: T003 and T004 need
  the verb from T007b.
- `.4` cannot start before `.3` publishes the contract — which it now has, so `.4` is
  unblocked in practice; the bead-level dependency stays because `.4`'s DONE WHEN
  needs a *live* sending to look at.
- `.5` is independent of `.4` and can run beside it. Only T024 crosses into `.3`.
- `.6` needs `.4` and `.5` and cannot be started early.

Inside phases, `[P]` marks the tasks that touch different files with no ordering
between them. It is deliberately sparse: most of `.4` is one dependency chain because
each layer is the input to the next.

## Verification steps

- [ ] `npm run verify` is green — zero TypeScript errors, the gate passes.
- [ ] `ios/scripts/test.sh` is green in all three phases.
- [ ] `GET /jobs?kind=heartbeat` on the running service shows one row, `interval`, one
      hour, an IANA zone.
- [ ] `GET /jobs/{id}/runs` shows consecutive hourly runs, mostly `spoke: false`, each
      with her one-sentence summary.
- [ ] A sending composed on the running service puts her words in chat, sends a push
      whose body is her sentence, and appears in `GET /sendings`.
- [ ] `DELETE FROM sendings WHERE id = ?` is refused by SQLite, with the trigger's own
      message.
- [ ] From Syl opens on his phone, shows her face rather than a play glyph and rather
      than the empty starfield, and plays when tapped.
- [ ] A sending's video is her, in her voice, and the original render under
      `~/.syl/renders` is byte-identical afterwards.
- [ ] The proof.
