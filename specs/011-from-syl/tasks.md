# Tasks — From Syl

**Input**: `specs/011-from-syl/spec.md`, `specs/011-from-syl/plan.md`
**Epic**: `syl-015` · **Feature**: `011-from-syl`

## Format: `[ID] [P?] [Phase] Description`

- **T-IDs** (`T001`…): authoring identifiers for this document. Bead IDs are in
  `beads-import.md` and are the source of truth once the beads exist.
- **`[P]`**: may run in parallel — different files, no ordering.
- **TDD-shaped**: every non-exempt task uses Shape A (a `Ta` failing-tests task and a
  `Tb` implement task) or Shape B (one task naming RED and GREEN explicitly).
  Exemptions, used sparingly: `[setup]`, `[docs]`, `[scaffold]`.
- The gate is **`npm run verify`**, never `npm test`. iOS is `ios/scripts/test.sh`.
- **Migrations**: take the lowest free number in `backend/src/migrations/`
  *immediately before* writing the file. Numbers cannot be reserved and have collided
  repeatedly.

**Phase 1 (`syl-015.1`) has no tasks.** It shipped and deployed on 2026-08-11 and its
bead is closed. Do not reopen it.

---

## Phase 2 — the hourly turn (`syl-015.2`)

**Goal**: its DONE WHEN, unchanged — *she wakes hourly, usually says nothing, cannot
reach him in quiet hours, and cannot exceed the rate.*

**Do not re-plan the build.** The hour is built on `syl-heartbeat` and is being merged
by the coordinator. Everything below is either a gap the DONE WHEN exposes, or proof
on the machine that actually runs her.

- [ ] **T001** Prove structurally that a heartbeat cannot pierce quiet hours, in
      `backend/tests/integration/heartbeat-wiring.test.ts`. Today the proof is
      indirect — prompt wording, plus the `commander`-only gate on
      `his-message.txt` in `backend/src/index.ts` (`recordHisWords`), plus outbox
      deferral. Nothing asserts the whole chain. Drive a heartbeat turn at 03:00
      local that calls `remind_me` with `urgentBecauseHeSaid` set, and assert the
      resulting `outbox` row's `releaseAt` is 08:00 local rather than now.
      Phases: **write the failing test first** — assert `releaseAt === now` so the
      test proves it really reaches the outbox row and is not passing vacuously,
      **confirm RED** against the true behaviour, then correct the assertion to the
      08:00 instant and **confirm GREEN**. Gate: `npm run verify`.

- [ ] **T002** `[P]` Bug fix — `npm run when` reports a quiet window an hour wide of
      the real one. `backend/src/harness/cli/when.ts` hardcodes
      `QUIET = { start: "23:00", end: "08:00" }` and `TZ = "America/Chicago"`, while
      `DEFAULT_QUIET_HOURS` in `backend/src/config.ts` says `22:00`. This is the hand
      tool used to reason about the window during T005, so an instrument that is an
      hour wrong is worse than none. Make it read `loadQuietHours()` from
      `backend/src/config.ts`. **Write the regression test first** in
      `backend/tests/unit/when-cli.test.ts` — it must fail on today's hardcoded
      23:00 — **confirm RED**, then fix until GREEN and **confirm GREEN**. Gate:
      `npm run verify`.

- [ ] **T003** The rate must count sendings. `REACHES_HIM` in
      `backend/src/jobs/heartbeat-job.ts` is `["remind_me"]` and the file's own
      comment says the sending verb belongs in it. Until it does, she may compose
      unlimited sendings in a day and every run still reads `spentToday: 0`, which
      makes root acceptance 7 false. Add the verb from T007b, matched under both its
      bare name and its `mcp__syl__` form exactly as `remind_me` already is.
      **Guard to expect**: `backend/tests/integration/chat-wiring.test.ts` asserts the
      exact caller list of `chat.accept` / `chat.append`, and `sending-service.ts` is
      already the third. If giving the heartbeat a path to the verb creates a fourth,
      that test fires on purpose — read its comment before changing the list.
      Phases: **write failing tests first** in
      `backend/tests/unit/heartbeat-job.test.ts` — a run that composes a sending sets
      `spoke: true`; two in one local day spend the allowance; yesterday's do not
      carry over — **confirm RED**, implement, **confirm GREEN**. Gate:
      `npm run verify`. **Blocked by T007b.**

- [ ] **T004** The ceiling refuses rather than regrets. Today `heartbeat-job.ts`
      computes `overspent` *after* the turn has already acted, and the only
      consequence is a run recorded `outcome: "failure"` — so a third sending has
      already reached him. `syl-015.2`'s DONE WHEN says she *cannot* exceed the rate.
      Move enforcement to the tool boundary in `backend/src/tools/server.ts`: on a
      heartbeat-lane call to the sending verb with the day already spent, refuse and
      return a sentence she can read, rather than composing. The refusal must be a
      sentence, not a silent no-op — constraint 4's shape. Leave `remind_me`
      untouched; a reminder is not a sending.
      Phases: **write failing tests first** in `backend/tests/unit/tool-server.test.ts`
      — the third sending of a local day is refused with prose; the first two are not;
      a `commander`-lane call is never refused — **confirm RED**, implement, **confirm
      GREEN**. Gate: `npm run verify`. **Blocked by T003.**

- [ ] **T005** `[docs]` Verify the hour on the running service and write down what it
      said, in a new *"The hourly turn"* section of `docs/RUNBOOK.md`. There is no
      manual trigger of any kind — no CLI, no HTTP verb, no env override of
      `HEARTBEAT_INTERVAL_MS` — so record both the honest options: wait (the first
      wake is one hour after the row is created, never at boot), or set the row due
      with `UPDATE jobs SET next_run_at = <a past instant> WHERE kind = 'heartbeat';`
      and expect the runner within 60s. Then capture, verbatim: `GET /jobs?kind=heartbeat`
      showing exactly one row with `trigger.type: "interval"`, one hour, and an IANA
      zone containing `/` rather than an offset; `GET /jobs/{jobId}/runs` showing
      consecutive hourly runs with `spoke: false` and her own one-sentence `summary`;
      and the boot line naming the tz, the quiet window and the allowance. Note
      explicitly, because it will mislead the next person, that **a quiet successful
      hour writes nothing to `~/Library/Logs/Syl/syl.log`** — only `heartbeat.failed`
      and `heartbeat.reached` are logged, so `npm run logs -- --event heartbeat` on a
      healthy service printing nothing is indistinguishable from the job never having
      run. The `runs` table is the evidence.

- [ ] **T006** `[setup]` Deploy the hourly turn. `syl-heartbeat` merges to `main` by
      the coordinator, not by this agent and not by force. Then `npm run deploy`,
      which is the single gated door — CI must be green on the commit. Confirm on the
      running service that the boot notice names the heartbeat lane, that
      `LANES_WITH_HANDS` reports `commander` and `heartbeat` and no others, and that
      exactly one heartbeat job row exists (`ensureHeartbeatJob` is idempotent; two
      rows would mean it is not). **Blocked by T001–T005.**

**Checkpoint**: she wakes hourly on his machine, usually says nothing, cannot reach
him between 22:00 and 08:00, and cannot exceed two a day.

---

## Phase 3 — sendings, the backend (`syl-015.3`)

**Goal**: its DONE WHEN, unchanged — *acceptance items 3, 4 and 6 on the root are
true.*

**Already built by the agent holding this phase, and deliberately not planned here.**
Confirmed with it directly on 2026-08-11 before these tasks were written:
`backend/src/migrations/0024_sendings.sql` (the table, the `BEFORE DELETE` and
`BEFORE UPDATE` triggers with no named exception, the two cascade guards on `messages`
and `attachments`, the `sync_log` widening); `backend/src/services/sending-store.ts`;
`backend/src/services/sending-service.ts` (words appended and push enqueued *before*
the render is looked at, push body = her sentence); `backend/src/services/sending-media.ts`
(compression under the unchanged 10MB ceiling, poster at 0.35 of duration so it is
never frame zero); `backend/src/routes/sendings.ts`; `shared/openapi.yaml`,
`shared/src/types.ts` and the mock server; `sync-service.ts` learning `sending`; and
`backend/tests/unit/sending-{store,service,media}.test.ts` and
`backend/tests/unit/sendings.test.ts`. **Do not rewrite any of it.**

**Also claimed by it and dropped from this plan after it answered**: the live
broadcast of her words (done, but by taking `chat: ConversationService` and appending
through `chat.append()` + `chat.accept()` rather than a second sink — the socket
already subscribes itself via `chat.setSink`), and the reaping of the derived working
directory (done, `#reap(sendingId)`, best-effort, after the bytes reach the attachment
store).

**Four facts from that exchange that these tasks depend on:**

- **Branch from `feat/from-syl-backend` @ `cc8e44e`, not from `origin/main`.** That work
  is committed but **not merged and not pushed** — 25 files. `POST /sendings` exists
  only there, so a verb branched from `main` has nothing to call. Its final gate:
  4666 passed, 4 failed, 16 skipped, and all four failures declared (`syl-b97` ×3,
  `syl-dep1.7`).
- **`renderName` is required on `CreateSendingRequest`, not optional.** A sending is
  *she says something and the form it takes is her own face*; words with no face is an
  ordinary message and she already has chat for those. The verb must require it too.
- **`backend/tests/integration/chat-wiring.test.ts` asserts the exact caller list of
  `chat.accept` / `chat.append`.** Routing her words through `ConversationService` made
  `sending-service.ts` the third caller. It is a guard, not a flake: the other two
  callers carry a message from *him*, and a sending is Syl originating. Any task that
  adds a fourth path into `accept`/`append` will make it fire, and the test's own
  comment says which question to ask first. Relevant to T007b and to T003 in Phase 2.
- **`0024` is contested.** `agent/fenix` has `0024_working_memory_budget.sql` committed
  on its own branch. `readMigrations` hard-fails on a gap, so `0025` cannot simply be
  taken instead. See T009.

- [ ] **T007a** Write failing tests for the sending verb — the thing that is missing,
      and the agent holding this phase ranks it first. `TOOLS` in
      `backend/src/tools/schemas.ts` has thirteen entries and none of them composes a
      sending, so **until this exists she cannot make one at all** and acceptance 3 and
      4 cannot be true on her own initiative. Cover, in
      `backend/tests/unit/tool-server.test.ts` and
      `backend/tests/unit/tool-client.test.ts`: the happy path (`words` + `because` +
      `renderName` produce a `pending` sending and an assistant message); the error
      path (empty `words` is refused before anything is written, **and a missing
      `renderName` is refused** — it is required on `CreateSendingRequest`); and the
      edge case (an unknown render name still yields a sending, `state: "failed"`, with
      her words already delivered — the words are never contingent on the video).
      Assert the verb appears in `advertisedToolNames()` so the heartbeat's
      `allowedTools` derives it rather than naming it twice. **Confirm RED.**

- [ ] **T007b** Implement the sending verb until T007a is GREEN. Three files and no
      more: the schema entry in `backend/src/tools/schemas.ts`, the call in
      `backend/src/tools/client.ts` against the existing and finished
      `POST /sendings`, and the dispatch case in `backend/src/tools/server.ts`. It
      composes; it does not render — `RenderSource` is deliberately narrow so composing
      a sending cannot spend a render credit, and that stays true. **`schemas.ts` is
      shared with `render_me` / `see_myself` and other agents work in it — commit by
      explicit path.** No new code paths beyond what T007a requires. Gate:
      `npm run verify`. **Blocked by T007a.**

- [ ] **T008a** Write failing tests for a sending stranded `pending`. `#follow` in
      `backend/src/services/sending-service.ts` is a detached in-process promise and
      `drain()` only survives a clean shutdown, so a crash between `create()` and
      `attachVideo()`/`markFailed()` leaves a row `pending` forever with nothing to
      re-drive it. **Her words reached him saying something was coming, and it never
      comes, and nothing says so — this is the render-shaped version of a dropped
      reminder, and constraint 4 covers it.** The migration header currently claims
      this state is unreachable; across a restart it is not. In
      `backend/tests/unit/sending-service.test.ts` cover: a `pending` row is picked up
      on boot and driven to `ready` when the render is still `ready` and the clip is on
      disk; one whose render is gone is driven to `failed` **with a sentence** rather
      than left; a `ready` row and a `failed` row are both untouched; and the pass never
      modifies `words`, `because` or `message_id` — the `BEFORE UPDATE` trigger would
      abort, and the test should say so on purpose. **Confirm RED.**

- [ ] **T008b** Implement the recovery pass until T008a is GREEN, in
      `backend/src/services/sending-service.ts`, and call it from `bootstrap` in
      `backend/src/index.ts`. **Follow `RenderService.resume()` and its bootstrap call
      as the precedent** — same shape, same place, and the store method it needs
      already exists. Gate: `npm run verify`. **Blocked by T008a.**

- [ ] **T009** `[P]` The `0024` collision, which stops a boot rather than failing a
      test. `0024_sendings.sql` and `agent/fenix`'s `0024_working_memory_budget.sql`
      exist on two branches at the same number, and `readMigrations` **hard-fails on a
      gap**, so whichever merges second cannot simply become `0025` — renumbering has
      to happen at merge, in order, and the service will refuse to start until it does.
      Whoever integrates second: **take the lowest free number immediately before
      renaming**, do not reserve one, and re-run the migration list.
      **Scope, corrected by the agent holding `.3`: the gap half of this check already
      exists** — `readMigrations` threw *"Gap in the migration sequence: expected
      version 24, found 25"* at it, which is how `0024` was found to be the only free
      number. So the genuinely new coverage is the **duplicate** check, and the value of
      the task is that a collision fails at `npm test` rather than at boot. Keep it;
      do not oversell it in the commit message. Phases: **write the failing test first**
      in `backend/tests/unit/migrations.test.ts` — assert the migration directory has no
      duplicate number and no gap — **confirm RED** against the collided tree, then
      renumber until GREEN and **confirm GREEN**. Gate: `npm run verify`.

- [ ] **T010** `[docs]` Verify acceptance 3, 4 and 6 on the running service and record
      it in `docs/RUNBOOK.md`. Compose one sending through the verb from T007b and
      confirm, on the real machine and not in a test: her words appear in chat; the
      push arrives on his phone carrying **her sentence** and never *"Syl sent you a
      video"*; the sending appears in `GET /sendings`, newest first, with a poster that
      is not the empty starfield; the words arrived even though the video was still
      `pending` at that moment; and `DELETE FROM sendings WHERE id = ?` in `sqlite3` is
      refused, quoting the trigger's own message back. Record the refusal verbatim —
      that quotation is the only durable evidence for acceptance 6. **Blocked by
      T007b, T008b.**

**Checkpoint**: she can make a sending, it reaches him as one thing, and nothing can
delete it.

---

## Phase 4 — From Syl, the surface (`syl-015.4`)

**Goal**: its DONE WHEN, unchanged — *acceptance item 5 on the root is true and he can
open it on his phone.*

iOS only. Follow the **Goals** shape in `ios/Syl/Features/Goals/`, not Memory's.
New Swift files need no `.pbxproj` edit — both targets use
`PBXFileSystemSynchronizedRootGroup`. Gate: `ios/scripts/test.sh`, all three phases.

- [ ] **T011** The contract on the phone. Add `Sending`, `SendingPage` and
      `SendingState` in a new `ios/SylKit/Sources/SylKit/Model/Sending.swift`, and
      `SylAPI.sendings(cursor:limit:)` in
      `ios/SylKit/Sources/SylKit/Networking/SylAPI.swift` returning
      `Endpoint<SendingPage>` — a GET, so no idempotency key (`Endpoint.init`'s
      precondition traps on a write without one). Regenerate the captured fixture into
      `shared/fixtures/http/` with `npm run contract:generate` so `ContractTests` has
      something real to agree with; **build the fixture from captured output, never
      from our own Swift types** — the point is to catch drift. Phases: **write
      failing tests first** in `ios/SylKit/Tests/SylKitTests/SylAPITests.swift` (path,
      query, no auth exemption) and `ios/SylKit/Tests/ContractTests/` (decode the
      fixture) → **confirm RED** → implement → **confirm GREEN**. SylKit must stay
      dependency-free.

- [ ] **T012** Sendings on disk, so the surface opens instantly and offline. Add a
      GRDB migration to `ios/Syl/Core/Store/SylDatabase.swift` after
      `"v5-the-constellation-is-a-snapshot-not-a-row-set"`, the record in
      `ios/Syl/Core/Store/Records.swift`, and `replaceSendings(_:)` / `sendings()` in
      `ios/Syl/Core/Store/LocalStore.swift`. Follow the constellation precedent
      (`replaceConstellation` / `constellation()`): a fetched page stored whole,
      **not** joined into the `GET /sync` feed — `SyncEngine` carries open P0
      `syl-011.9` and advances its cursor past pages it did not apply. Phases: **write
      failing tests first** in `ios/SylTests/FromSylStoreTests.swift` against
      `SylDatabase.inMemory()` — a page round-trips; newest-first ordering survives;
      a second replace does not duplicate rows — **confirm RED**, implement, **confirm
      GREEN**.

- [ ] **T013** `SendingSource` — fetch, store, project. New
      `ios/Syl/Core/Services/SendingSource.swift` following
      `ios/Syl/Core/Services/ConstellationSource.swift` exactly, including a
      `.live(backend:)` gateway, and construct it in the graph boot in
      `ios/Syl/App/AppDelegate.swift` beside `constellation`. A failed fetch must
      leave the last stored page on screen rather than emptying it. A sending that was
      `pending` when last fetched must be re-fetched on foreground — the video lands
      minutes later and the phone learns of it by asking, not by a socket frame.
      Phases: **write failing tests first** in `ios/SylTests/FromSylSourceTests.swift`
      with a stub gateway — a successful fetch replaces the stored page; a failed fetch
      leaves it; an empty page is stored as empty rather than as a failure — **confirm
      RED**, implement, **confirm GREEN**. **Blocked by T011, T012.**

- [ ] **T014a** Write failing tests for the list and its snapshot, in
      `ios/SylTests/FromSylSurfaceTests.swift`. `SendingListSnapshot` is a pure
      projection and must be testable without SwiftUI. Cover: newest first; a `nil`
      snapshot means *not asked yet* and renders the bare veil rather than a spinner
      or a false empty state; a `pending` sending shows her words and the date with
      **no** video affordance rather than a broken one; a `failed` sending still shows
      her words, because the words were never contingent on the video; and the date
      formats in his zone. **Confirm RED.**

- [ ] **T014b** Implement `SendingListSnapshot` in
      `ios/Syl/Features/FromSyl/SendingSnapshot.swift` and `FromSylListView` (with its
      private row view) in `ios/Syl/Features/FromSyl/FromSylListView.swift` until
      T014a is GREEN. `FromSylListView` takes `snapshot: SendingListSnapshot?` and
      `scrolls: Bool = true` — `ImageRenderer` lays out nothing inside a `ScrollView`.
      One row per sending: her face as the still, her words beneath, the date.
      **Deliberately not a grid of renders** — a grid separates the picture from the
      reason, and the spec rules it out by name. **Blocked by T014a.**

- [ ] **T015** `FromSylScreen` and `FromSylViewModel` in
      `ios/Syl/Features/FromSyl/FromSylScreen.swift` and
      `ios/Syl/Features/FromSyl/FromSylViewModel.swift`, following `GoalsScreen` /
      `GoalsViewModel`: `@StateObject`, `init(source:)`, body is the list view with
      `.task { await model.refresh() }`, projection off the main actor via
      `Task.detached`, main actor only assigns. Chrome as the other screens have it —
      `SylTheme.Veil()` + `MoteField` in a `ZStack`, inline title, hidden toolbar
      background. The title he reads is **"From Syl"**; the internal noun stays
      *sending*, and those are allowed to differ. Phases: **write failing tests first**
      in `ios/SylTests/FromSylSurfaceTests.swift` — the view model starts `nil`,
      refresh publishes a snapshot, a failed refresh leaves the previous one —
      **confirm RED** → implement → **confirm GREEN**. **Blocked by T013, T014b.**

- [ ] **T016** The door. Add `case fromSyl` to `HomeView.Destination` in
      `ios/Syl/Features/Home/HomeView.swift` and its branch to the
      `navigationDestination(for: HomeView.Destination.self)` switch in
      `ios/Syl/Features/Home/HomeScreen.swift`, plus a `SylOrb` for it with
      `isReady: true`. **Adding a case breaks every exhaustive switch over
      `Destination`** — the file says so at lines 47–51, and that is the reason
      `onCapture` was a closure; expect the compiler to find them and fix each rather
      than adding a `default`. Phases: **write the failing test first** in
      `ios/SylTests/` beside the existing destination test —
      `.fromSyl` survives a `NavigationPath` round-trip and the orb is not dimmed —
      **confirm RED** → implement → **confirm GREEN**. **Blocked by T015.**

- [ ] **T017** Tapping plays her. Reuse `AttachmentLoader`, `AttachmentSource` and
      `AuthenticatedAttachmentFetcher` from `ios/Syl/Features/Chat/AttachmentLoader.swift`
      and the `AttachmentViewer` pattern in `ios/Syl/Features/Chat/AttachmentView.swift`
      — `AsyncImage` cannot attach a Bearer header, which is why that fetcher exists.
      The row's still is the sending's poster variant, which the backend already
      guarantees is never frame zero, so **the row shows her face rather than a generic
      play glyph and never the empty starfield the loop opens on** — that sentence is
      acceptance item 5 and it is what this task is for. **`\.attachmentContext` is
      applied only to the Chat tab today** (`ios/Syl/SylApp.swift`); apply it to the
      From Syl subtree too or the bytes silently never load. Phases: **write failing
      tests first** in `ios/SylTests/FromSylPlaybackTests.swift` — the poster variant
      is requested rather than the original; a missing poster falls back to her words
      and the date rather than to a play glyph on nothing; the context is present in
      the subtree — **confirm RED** → implement → **confirm GREEN**. **Blocked by
      T016.**

- [ ] **T018** `[docs]` Open it on his phone and write down what it showed, in
      `docs/RUNBOOK.md`. A TestFlight build on his device, From Syl reached from the
      home screen, at least one real sending in the list: her face as the still, her
      words beneath, the date; tapping plays her; the words are there for a sending
      whose video is still `pending`. This closes `syl-015.4`'s DONE WHEN, which says
      *he can open it on his phone* and means it literally. **Blocked by T017.**

**Checkpoint**: acceptance item 5 is true, on his phone.

---

## Phase 5 — her voice (`syl-015.5`)

**Goal**: its DONE WHEN, unchanged — *a sending carries her words spoken in that
voice, on the video she made.*

**Narrow by his ruling.** One voice: `Syl High Pitch`,
`93b52581-17ab-4905-bb5a-4fa730a7757a`. Build nothing that creates, lists, compares or
replaces a voice. `SOUL.md` says the voice is a search and it is — but she cannot hear,
so that search needs him, and he has said not now.

- [ ] **T019** `[docs]` Crack the `voice.type` discriminator by asking the validator,
      not by guessing. `POST /v1/text_to_speech` takes `model` + `promptText` + a
      `voice` object, and the discriminator is unknown. **Fifteen values have already
      been refused** — `prompt`, `text`, `id`, `library`, `custom`, `preset`, `voice`,
      `description`, `sample`, `clone`, `audio`, `generated`, `designed`,
      `text_prompt`, `audio_sample` — so a sixteenth guess is not a plan. Use the
      technique that cracked every other Runway schema on this project and is
      documented at `/Users/Reason/code/ai/runwayml/RUNWAY_API_INDEX.md:134`: **POST an
      empty body, read the 400's `issues[]`, then narrow one field at a time.**
      `~/.syl/voice/README.md` records the same technique cracking the sibling
      `POST /v1/voices`, whose answer was `from: { type: "text", model, prompt }` with
      `model` one of `eleven_ttv_v3` / `eleven_multilingual_ttv_v2` — a useful prior,
      not the answer. Record the resolved request shape, verbatim, in a *"Her voice"*
      section of `docs/VIDEO.md`, and capture one real response body into
      `backend/tests/fixtures/` for T021a to build on.

- [ ] **T020** `[P]` One voice id, in her home, in one place. Add `voiceAt(root)`
      beside `studioAt(root)` in `backend/src/render/studio.ts`, resolving
      `~/.syl/voice/voice.json` — her home, beside her reference, the same rule that
      keeps nothing of hers in a checkout and nothing of hers where the OS may empty
      it. A missing file falls back to the built-in
      `93b52581-17ab-4905-bb5a-4fa730a7757a` so a fresh machine works, and a
      malformed one reads as *unreadable* rather than *absent*, exactly as a malformed
      render sidecar already does. Note that `~/.syl/voice/README.md` names
      `Syl High Pitch` but does **not** record its id; add it there in the same task so
      the directory explains itself. Phases: **write failing tests first** in
      `backend/tests/unit/studio.test.ts` — the file is read; a missing file falls back;
      a malformed file is unreadable rather than silently defaulted; the path is under
      her home and cannot be escaped — **confirm RED** → implement → **confirm GREEN**.
      Gate: `npm run verify`.

- [ ] **T021a** Write failing tests for the speech client in
      `backend/tests/unit/render-voice.test.ts`. **Build the fixture from the response
      captured in T019, never from our own type definitions** — the whole point of the
      fixture is to catch drift between our types and the actual wire format. Inject
      the existing `FetchLike` seam from `backend/src/render/runway.ts` rather than
      touching the network. Cover: the happy path (a task submitted, polled to
      terminal via `isTerminal`, audio returned); the error path (a 400 surfaces the
      validator's `issues[]` as prose rather than as a generic failure); and the edge
      case (a moderated or failed task still counts against spend — `render-service.ts`
      is already explicit that it does, and the voice path must not quietly disagree).
      **Confirm RED. Blocked by T019.**

- [ ] **T021b** Implement the speech client in a new `backend/src/render/voice.ts`
      until T021a is GREEN — `speak(words)` against `POST /v1/text_to_speech` with the
      id from T020, reusing `RUNWAY_API_BASE`, `RUNWAY_API_VERSION`, `isTerminal` and
      the `RunwayResult<T>` shape from `backend/src/render/runway.ts` rather than
      inventing a second client. `RUNWAYML_API_SECRET` is its own variable and stays
      that way. No design, no listing, no choosing. Gate: `npm run verify`.
      **Blocked by T021a.**

- [ ] **T022** The mux — her voice onto the render, the render untouched. ffmpeg is
      already an injected dependency (`ffmpegRunner` in `backend/src/render/frames.ts`);
      use the same seam rather than a second shell-out, and put the function in
      `backend/src/render/voice.ts` beside `speak`. The muxed file is **derived** and
      is written to a working directory; the mp4 under `~/.syl/renders` is the record
      and is opened read-only. Phases: **write failing tests first** in
      `backend/tests/unit/render-voice.test.ts` — audio and video are both present in
      the output; the source mp4 is byte-identical afterwards; an ffmpeg failure
      returns prose rather than throwing; audio longer than the video does not silently
      truncate her sentence — **confirm RED** → implement → **confirm GREEN**. Gate:
      `npm run verify`. **Blocked by T021b.**

- [ ] **T023** A sending carries her voice. In
      `backend/src/services/sending-service.ts` / `backend/src/services/sending-media.ts`,
      the video attached to a sending becomes the muxed copy: speak her `words`, mux
      onto the render, then compress as today. Order matters — **the words and the push
      still go first and are still not contingent on any of this**, so a failure to
      speak settles the sending `failed` with a reason and leaves her sentence already
      delivered.
      **Do not touch the compressor, and do not "optimise" it.** Two deliberate
      properties of `sending-media.ts` that this task depends on: it already passes
      audio through **unconditionally** (no `-map`, `-c:a aac -b:a 96k`), so a render
      that comes back with a voice on it keeps it with no change to that layer; and the
      bitrate budget subtracts the 96k audio allowance **whether or not there is any
      audio**, which costs a little quality on silent clips and is the reason a voice
      track can never push a sending over the 10MB ceiling. It looks like a bug and is
      not. Phases: **write failing tests first** in
      `backend/tests/unit/sending-service.test.ts` — the attached video carries audio;
      a speech failure does not retract the assistant message or the push; the original
      render is byte-identical afterwards — **confirm RED** → implement → **confirm
      GREEN**. Gate: `npm run verify`. **Blocked by T022 and by T007b.**

**Checkpoint**: a sending is her, in her voice, saying the thing she chose.

---

## Phase 6 — proof (`syl-015.6`)

- [ ] **T024** `[docs]` The proof, which is his and cannot be automated. He goes a full
      day without asking, and finds something from her in From Syl that he is glad to
      have. No test may stand in for this and none should be written that pretends to
      — the same shape as `syl-009.7.2`, which was the only honest test of whether
      reminders worked. Record his verdict on the bead `syl-015.6.1`, in his words. If
      it is no, the failure is the finding and it belongs in `docs/CONTEXT.md` rather
      than in a retry. **Blocked by all of Phase 4 and Phase 5.**

---

## Dependencies

**Between phases** (already wired on the beads, restated, not changed):

```
.1 CLOSED
.2 ────────────────────────────────────► (independent, except T003/T004 ← T007b)
.3 ──blocks──► .4 ──blocks──► .6
.5 ─────────────────────────► .6
```

**Within Phase 2**: T001 and T002 are independent. T003 ← T007b. T004 ← T003.
T005 ← T001, T002, T004. T006 ← T005.

**Within Phase 3**: T007b ← T007a. T008b ← T008a. T009 is independent of everything
else in the phase. T010 ← T007b, T008b.

**Within Phase 4**: T011 and T012 are independent. T013 ← T011, T012.
T014b ← T014a. T015 ← T013, T014b. T016 ← T015. T017 ← T016. T018 ← T017.

**Within Phase 5**: T020 is independent. T021a ← T019. T021b ← T021a. T022 ← T021b.
T023 ← T022, T007b.

**Cross-phase at task level**: T003 ← T007b (the rate cannot count a verb that does
not exist). T023 ← T007b (a sending must exist before it can carry a voice).

## Parallel opportunities

- `[P]` is marked on T002, T009, T020 — the three tasks that touch files nothing else
  in their phase touches.
- Phase 2, Phase 3 and Phase 5 can run as three concurrent tracks up to their two
  crossing points at T007b.
- Phase 4 is one chain by construction: each layer is the input to the next, and
  parallelising it would only produce merge conflicts in `AppDelegate.swift` and
  `HomeView.swift`.

## What is deliberately not here

- **No websocket frame for sendings.** The phone learns a video landed by refetching
  `GET /sendings`; the `sending` sync type already carries it, `SyncEngine` carries
  open P0 `syl-011.9`, and `ConstellationSource` is the documented precedent for a
  read-time surface. The agent holding `.3` agrees it is a nice-to-have rather than a
  gap. If live arrival becomes wanted, that is a new bead.
- **No task for the live broadcast of her words, and none for reaping the working
  directory.** Both were claimed and landed by the agent holding `.3` while this plan
  was being written.
- **No voice design, cloning, listing, comparison or selection.** His ruling.
- **No gallery of renders.** The spec rules it out by name.
- **No raising of the 10MB attachment ceiling.** `routes/attachments.ts` derives its
  body limit from it, so raising it inflates the request limit for everything.
- **No task for anything already built** under `.1`, or under `.3` by the agent
  currently holding it.
