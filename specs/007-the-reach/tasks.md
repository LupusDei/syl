# Tasks — The Reach (`syl-013`)

`[P]` = parallelisable (different files, no ordering dependency).

Every task names exact paths. Phase numbers match sub-epic numbers.

**Revised 2026-08-11.** `reach_do` and the delegate. T006 and T007 rewritten in
place; T031, T032 and T033 appended as `syl-013.1.9`, `.1.10` and `.1.11`. T028
and T029 gained a clause each. **No existing task was renumbered.** Task numbers
are allocation order, not execution order — T031–T033 belong to Phase 1 and the
`Dependencies` section below carries the ordering.

## Phase 1 — The reach

- **T001 [P]** `backend/src/reach/allowlist.ts` — pure. `assertAllowed(url,
  hosts)` returns an allow or a refusal carrying its reason. Exact-host and
  explicit-subdomain rules only; no wildcards that swallow a registrable domain.
  Reuses `classifyAddress` from `backend/src/connections/address-guard.ts` so an
  allowed hostname resolving to a private address is still refused — one answer
  to that question, not two. No I/O. Tests in
  `backend/tests/unit/reach-allowlist.test.ts`.
- **T002** The allowlist store and his control of it: a migration adding
  `reach_hosts` (**check the highest existing number in
  `backend/src/migrations/` first** — 0021 today),
  `backend/src/services/reach-allowlist-service.ts`, and `GET/POST/DELETE
  /reach/hosts` in `backend/src/routes/reach.ts` behind `requireScope("admin")`.
  Test that an `agent` token gets 403 and an anonymous caller gets the ordinary
  indistinguishable 401.
- **T003** Playwright as a backend dependency: `backend/package.json`, pinned
  exact, mirrored in the root `package.json` `overrides` the same way
  `onnxruntime-node@1.23.0` is. Browser binaries install to
  `~/.syl/browser/runtime` via `PLAYWRIGHT_BROWSERS_PATH`, never into the repo.
  Document the install in `docs/RUNBOOK.md`. Keep browser-driving tests off the
  default `npm test` path.
- **T004** `backend/src/reach/browser.ts` — `openReachContext()` over
  `launchPersistentContext(reachProfileDir(home))` where `reachProfileDir` is
  `~/.syl/browser/profile`, created `0700`. **Her profile, never his.** A test
  asserts the user-data-dir is under `~/.syl` and that no file under
  `backend/src/` names `~/Library/Application Support/Google/Chrome` or
  `~/Library/Safari` — use `backend/tests/helpers/source-scan.ts`.
- **T005** The allowlist below her, at one chokepoint: a single
  `context.route("**")` handler in `backend/src/reach/browser.ts` calling
  `assertAllowed` and aborting anything else, plus `serviceWorkers: "block"`.
  Four named bypass tests in
  `backend/tests/unit/reach-allowlist-enforcement.test.ts`: a **redirect** from
  an allowed host to a disallowed one, a **subresource**, an **XHR**, and a
  **`window.open`**. Mutation-test each — break it, watch it go red, put it back.
  A correspondence check that cannot fail is a consistency check in costume.
- **T006** `backend/src/reach/session.ts` — **the one door.** One function
  performs a page action, computes its consequence and writes the ledger row, in
  that order, in one place. Nothing else in the codebase may drive a page. The
  static guard for that is T022; the seam is here.
  **Two callers, one door**: her, steering with the granular verbs, and the
  delegate, looping. The delegate is a second *caller*, never a second path — if
  it needed its own allowlist or its own ledger the design would be wrong.
  The door also exposes **readable page text** (not the accessibility tree, not
  HTML) for T032, and that extraction is here rather than in `read.ts` so there
  is still exactly one thing that touches a page.
- **T007** The verbs, and the **two surfaces**.
  In `backend/src/tools/schemas.ts`: `reach_do(goal, host, because)` — the front
  door — plus `reach_read(question)` and the granular six `reach_open`,
  `reach_look`, `reach_click`, `reach_type`, `reach_wait`, `reach_close`.
  Handlers in `backend/src/tools/server.ts` are thin calls through
  `backend/src/tools/client.ts` to `/reach/*`.
  **Browser-generic, never site-semantic** — a `book_gym_class` verb is the
  handcuff this epic exists against. `reach_do` takes a *goal in his words*, not
  a site-specific operation, and that distinction is what keeps it on the right
  side of the line. Reassert the `surfaceBytes()` ceiling. `because` is required
  on every verb that acts, guarded by shape rather than by a list of names.
  **The granular six stay.** They are how she steers a flow that went wrong; a
  capability removed to tidy an interface is the handcuff by another route.
  **The surface split** is the security half of this task: `advertisedTools()`
  **and the handler lookup** take a surface — `"commander" | "delegate"` — read
  from the tool server's environment, which the declaration file sets.
  `backend/src/tools/config.ts` gains `delegateToolConfigPath(home)` writing
  `~/.syl/tools/delegate-hands.json` at `0600` beside `hands.json`.
  Scoping `tools/list` is **not** confinement; the handler lookup must be scoped
  too, or a name seen once can still be called. T033 proves both halves.
- **T008** Reach her, and only her: `AGENT_SURFACE` in
  `backend/src/middleware/auth.ts` gains `/reach`, while `/reach/hosts`,
  `/reach/frame` and `/reach/ledger` stay `admin`. Test both halves — she can
  act, and she cannot widen her own allowlist. Headless is the default and the
  visible mode is opt-in via one explicit flag on the reach session
  (`backend/src/reach/browser.ts`); a test asserts the default and that the flag
  is the only way to change it.
- **T032** *(`syl-013.1.10`)* Ask the page, do not snapshot it:
  `backend/src/reach/read.ts` — `answerFromPage(question, sessionId)` takes the
  readable page text from T006 and answers **through `runReaderTurn`**
  (`backend/src/harness/reader.ts`), unmodified, with the page as untrusted
  content. Bounded answer, schema-validated or discarded, and *"not on this
  page"* when it is not on the page — a reader turn that invents an answer is
  worse than a snapshot.
  **The test that matters is which path was taken**, not what came back:
  `backend/tests/unit/reach-read.test.ts` asserts the sealed shape was used and
  its tool surface was empty. This is one refactor from "just ask the delegate to
  summarise the page it already has", that refactor looks like a simplification,
  and it silently deletes the central claim of `spec.md` § *The residual*.
  Borrowed from OpenClaw's *"question answering over readable page text without
  returning a full snapshot"* —
  `https://github.com/openclaw/openclaw/blob/main/docs/tools/browser.md`.
- **T033** *(`syl-013.1.11`)* **The delegate holds none of her verbs**, proven —
  `backend/tests/unit/reach-delegate-confinement.test.ts`, in the shape of
  `backend/tests/unit/agent-confinement.test.ts` and `reader-containment.test.ts`
  (`syl-009.6`, the precedent). Written **before** `delegate.ts`, red first: a
  confinement test shaped by the surface it found is worth much less.
  Five claims:
  1. `advertisedTools()` on the delegate surface contains the reach verbs and
     **no Syl verb** — `remind_me`, `cancel_reminder`, `change_reminder`,
     `add_todo`, `finish_todo`, `drop_todo`, `set_goal`, `change_goal`,
     `whats_outstanding` as **literals, not imported**. `syl-009.6` learned this
     the expensive way: a test that imports the constant agrees with a widened
     constant and stays green.
  2. A `tools/call` naming each of those on the delegate surface is **refused**,
     driven through `createToolServer`. Unlisted is not unreachable.
  3. The delegate's system prompt equals `DELEGATE_SYSTEM_PROMPT` **by
     equality** — the trick `tests/unit/reader.test.ts` uses so the test need not
     enumerate everything it must not contain. No soul, no memory, no turn
     context.
  4. `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, and a session
     id that is never `resume`d and never Syl's.
  5. Its import closure never reaches the store, the delivery path or
     `agent-key.ts` — the structural half, via
     `backend/tests/helpers/source-scan.ts`.
- **T031** *(`syl-013.1.9`)* **The delegate**: `backend/src/reach/delegate.ts`.
  Spawned through `backend/src/harness/session.ts` with options built **from
  scratch** — `runReaderTurn`'s construction, whitelisted not spread, because it
  is one stray `...options` from inheriting her soul.
  Handed: the goal verbatim, the host, a reach session id, a step budget, and the
  operating loop as standing orders. Not handed: `SOUL.md`, memory, turn context,
  or any credential.
  **The loop**, taken from OpenClaw's `browser-automation` skill and cited:
  *"check status/tabs first, label task tabs, snapshot before acting, resnapshot
  after UI changes, recover stale refs once, and report login/2FA/captcha or
  camera/microphone blockers as manual action instead of guessing"* —
  `https://github.com/openclaw/openclaw/blob/main/docs/tools/browser.md`. Plus
  ours: **ask the page before you snapshot it** — `reach_read` to *know*,
  `reach_look` only when you need a ref to *click*.
  **The outcome**: `done | blocked | question`, and **no fourth**, the same rule
  as `frame-gate.ts`. A crash, a timeout or an exhausted budget is a `blocked`
  carrying the work so far — never an empty return, never a hang. It carries the
  ledger rows it produced so what she is told can be **compared** to what was
  recorded rather than trusted.
  `backend/src/reach/outcome.ts` — pure — validates or discards, caps, and fences
  via `backend/src/agents/fencing.ts` before it reaches her. Reuse that module;
  do not format a string at the call site. Its header already argues why an
  agent's answer is more dangerous than an article.
  `POST /reach/do` in `backend/src/routes/reach.ts`, agent-scoped.
  Tests: `backend/tests/unit/reach-delegate.test.ts` (options built from scratch;
  three outcomes and no fourth; an exhausted budget returns `blocked` with its
  rows) and `backend/tests/unit/reach-outcome.test.ts` (validate-or-discard, the
  cap, the fence).

## Phase 2 — Credentials

- **T009** `backend/src/reach/keychain.ts` — the OS keychain via `/usr/bin/security`
  called with `execFile`, **never a shell**. Items are `syl.reach.<host>`.
  `readCredential(host)`, `listCredentialHosts()`, `deleteCredential(host)`. A
  secret is never logged and a failure names the host, never the value. Unit
  tests against an injected exec seam in
  `backend/tests/unit/reach-keychain.test.ts`.
- **T010** `backend/src/ops/cli/reach.ts` and `npm run reach -- --add-credential
  <host>` — registration at the console only. Same asymmetry as `npm run pair --
  --admin`: minting needs console access, which is already full compromise of the
  machine, so the credential cannot be escalated into remotely. A test asserts no
  route creates or returns one.
- **T011** Injection happens inside `backend/src/reach/browser.ts` (`signIn(host)`)
  so the secret enters a page and never an HTTP response or a turn's context.
  `backend/tests/integration/reach-credential.test.ts` asserts it three ways, the
  shape of `backend/tests/integration/agent-credential.test.ts`: from the
  contract, from the running service (sweep every route with an agent token), and
  from the source (the secret is named in `keychain.ts` and `browser.ts` and
  nowhere else).
- **T012** Revocation is per host and isolating: `npm run reach -- --revoke <host>`
  in `backend/src/ops/cli/reach.ts` deletes the keychain item **and** clears that
  origin's cookies and storage from `~/.syl/browser/profile`, and nothing else's.
  The test has two halves and both are required: the revoked host stops, and a
  second host's session still works.

## Phase 3 — Consequence visibility

- **T013 [P]** `backend/src/reach/consequence.ts` — pure.
  `describeConsequence(observation)` returns `{ reversible, undo?, owner,
  ownerEvidence, costs[] }`. It never throws and it never refuses. Tests in
  `backend/tests/unit/reach-consequence.test.ts` built from **captured page
  observations**, not authored from our own types.
- **T014 [P]** Irreversibility, in `backend/src/reach/consequence.ts`: from the
  request the action actually issued (method, and whether it spent money), and
  from whether the page offers an undo. When there is an undo, **name it** — "can
  be undone until 18:00 from the bookings page" is a fact she can act on;
  `reversible: true` alone is not.
- **T015 [P]** Ownership, in `backend/src/reach/consequence.ts`: whether the
  resource is his, or an identified other person's — and carry the **evidence**
  (the name or label on the page), not the conclusion. Same move as
  `urgentBecauseHeSaid`: a conclusion can only be trusted, evidence can be
  compared to something. Absent, empty and unmatched all mean *not attributed*.
- **T016** The Sydney tell: `backend/src/reach/authorization-probe.ts`. When a
  control modifies a resource labelled with another identity and the service does
  not refuse her, record `missingAuthorizationCheck` with its evidence, and state
  in the fact itself that **a correctly built service would have refused her**,
  so the absence reads as evidence rather than permission. Tests in
  `backend/tests/unit/reach-authorization-probe.test.ts` include the Sydney case
  itself: a cancel control on somebody else's named reservation.
- **T017** **Facts, not vetoes** — the structural guard, landed with the modules
  and not after. `backend/tests/unit/reach-consequence-has-no-veto.test.ts` uses
  `backend/tests/helpers/source-scan.ts` to assert `consequence.ts` and
  `authorization-probe.ts` contain no refusal path, and
  `backend/tests/acceptance/us7-facts-not-vetoes.test.ts` drives a real action
  carrying `missingAuthorizationCheck: true` all the way through when she chooses
  to proceed. Without this, "we told her" becomes "we stopped her" during
  implementation and nothing fails.

## Phase 4 — The ledger

- **T018 [P]** The migration: `reach_actions` in `backend/src/migrations/` —
  **check the highest existing number first.** Columns: when, host, url, verb,
  `because` NOT NULL, reversibility and its undo, owner and owner evidence, costs,
  `missingAuthorizationCheck`, outcome, and the turn and session it came from.
  `because` is guarded **by shape, not by a list of verb names** — a shorthand
  that hides a field is how a rule gets a hole in it (`set_goal`, `syl-009`).
- **T019** `backend/src/services/reach-ledger-service.ts` — the write, called from
  inside `backend/src/reach/session.ts` and from nowhere else. Not a hook a
  caller must remember.
- **T020** `GET /reach/ledger` in `backend/src/routes/reach.ts`, behind
  `requireScope("admin")` — the same argument as `GET /logs`: this is the record
  of what a pre-authorised program did in the world on his behalf, and a phone
  left in a taxi must not become that transcript.
- **T021 [P]** The admin view: `frontend/src/features/reach/LedgerView.tsx` and
  the pure `frontend/src/features/reach/reach-ledger-model.ts`, modelled on
  `frontend/src/features/logs/LogsView.tsx` and `logs/log-model.ts`. One entry in
  `frontend/src/app/nav.ts` and one in `VIEWS` in `frontend/src/app/App.tsx`.
  Tests: `frontend/tests/unit/reach-ledger-model.test.ts` and
  `frontend/tests/unit/reach-ledger-view.test.ts`. Any query with a `LIMIT` needs
  a test where the limit actually bites.
- **T022** The static guard: `backend/tests/unit/reach-one-door.test.ts` asserts
  via `backend/tests/helpers/source-scan.ts` that exactly one function drives a
  page and it is the one that writes the ledger — so an action cannot be added
  next month that does not record itself.

## Phase 5 — The spending frame

- **T023** `backend/src/services/reach-frame-service.ts` and its migration: one
  row, his. Money ceilings (per action and per period) **and the softer
  currencies** — acting as him socially, sending on his behalf, committing his
  time. Set once, not asked each time.
- **T024 [P]** `GET/PUT /reach/frame` in `backend/src/routes/reach.ts` behind
  `requireScope("admin")`, and the editor
  `frontend/src/features/reach/FrameView.tsx` with its nav and `VIEWS` entries.
  Test: `frontend/tests/unit/reach-frame-view.test.ts`.
- **T025** `backend/src/reach/frame-gate.ts` — `withinFrame | atEdge(question)`
  and **no third answer that means stopped.** Inside the frame she is silent;
  at its edge the question reaches him through the existing delivery path.
  Constraint 4's shape applied to actions: an action that dies quietly at a limit
  is the same broken promise as a reminder that vanished. Tests in
  `backend/tests/unit/reach-frame-gate.test.ts` include the one that matters —
  nothing is dropped.

## Phase 6 — Her soul

- **T026** Draft the language for actions that cost an identified third party into
  `specs/007-the-reach/soul-draft.md`. **Do not edit `SOUL.md`.** The draft must
  say out loud that `SOUL.md` already carries the governing rules — *"Ask only
  when a wrong guess is expensive"* and *"ask which answer a friend with a perfect
  memory and no reason to flatter him would give"* — and that what was missing was
  never the rule but facts for it to operate on. Propose the smallest addition
  that closes the gap, not a new section.
- **T027** Put the draft to the Commander for a ruling (`file_question`, or
  Adjutant `send_message` — never `AskUserQuestion`, which this project forbids),
  and record his wording **verbatim** in `docs/CONTEXT.md` §2 before any edit to
  `SOUL.md`. Proposed, not assumed.

## Phase 7 — Proof

- **T028** `backend/tests/acceptance/us7-she-can-reach.test.ts` — she completes a
  booking on a local fixture site through the real conversation path, and the
  ledger row says what it cost and why. **Through one `reach_do` call**, not
  fifteen — the ergonomic claim is part of the acceptance criterion, so a test
  that drives the granular verbs would pass while the feature failed. Written
  **RED first** and declared in `tests/expected-failures.json` under `syl-013`
  until it passes. Check it fails for the reason it is named for; a red test that
  cannot compile is a broken build with a bead attached.
- **T029** The residual, pinned where it can be:
  `backend/tests/acceptance/us4-untrusted-content-cannot-act.test.ts` stays green
  for the reader lane, and `backend/tests/unit/reach-is-not-the-reader.test.ts`
  proves a reach session is a third shape, and the delegate a fourth, and neither
  ever claims the reader's properties.
  **Second half, added 2026-08-11**: pin the property the delegate actually
  recovered — **her main conversation ingests no page text**. Assert it against
  the turn's events from the T028 run, not by declaration. This is the one claim
  in `spec.md` § *The residual* that is a genuine gain, and an unpinned recovered
  property is the next thing to quietly stop being true.
  The failure this guards is the project's named one: a property quietly stops
  being true while the test naming it goes on passing.
- **T030** The live proof, by hand: she books something real on an allowed host,
  unattended, **watched in the visible mode**, and the ledger says what it cost.
  This is the acceptance criterion and it cannot be automated. Record the run in
  `docs/CONTEXT.md` — "it worked" and "I watched it work" are different claims.

## Dependencies

- T001 → T005 → T006 → T007 (the predicate, then the chokepoint, then the door,
  then the verbs and the two surfaces)
- T003 → T004 → T005
- T002 → T008 (the store before the scope split)
- T004 → T009..T012 (credentials need a profile to inject into)
- T013 → T014, T015, T016 → T017
- T018 → T019 → T020 → T021, T022
- T006 → T019 (the door is where the ledger write lives)
- T023 → T024, T025
- T026 → T027
- **T006 → T032** (page question-answering needs the door's readable text)
- **T007 → T033 → T031** (the surface split, then the confinement sweep, then the
  delegate — the guard before the handler, deliberately)
- **T032 → T031** (the delegate's loop prefers reading over snapshotting, so the
  read path must exist or the default is a comment)
- T006, T017, T019, T025, **T031** → T028
- **T031 → T029** (the residual's recovered half is about the delegate)
- everything → T030

## Parallel Opportunities

Four independent tracks at the start: **T001** (pure allowlist), **T013–T016**
(pure consequence modules, testable against captured observations before a
browser exists), **T018** (the migration), **T026** (the soul draft, which is
prose and blocks nothing). The three tasks added on 2026-08-11 are all downstream
of T007, so the ready set is unchanged — re-verified against `bd ready`.

T005, T017 and **T033** deserve to go early for the reason `syl-009.6.*` did:
they are the tests that say what this system must never do, and they should be
green before anything gains the ability to do it. T033 blocks T031 for exactly
that reason.
