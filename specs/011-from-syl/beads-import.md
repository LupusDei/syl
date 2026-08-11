# From Syl — Beads

**Feature**: `011-from-syl`
**Generated**: 2026-08-11
**Source**: `specs/011-from-syl/tasks.md`

## Root Epic — **already exists, do not recreate**

- **ID**: `syl-015`
- **Title**: Syl 15: she finds herself, and shows him
- **Type**: epic · **Priority**: 0
- Carries the ten acceptance criteria. Nothing here restates them.

## Epics — **all six already exist, do not recreate, do not renumber**

| Bead | Phase | State on 2026-08-11 | Tasks added |
|---|---|---|---|
| `syl-015.1` | 1 — she renders herself | **CLOSED**, shipped and deployed | **0** |
| `syl-015.2` | 2 — the hourly turn | built on `syl-heartbeat`, merging | 6 |
| `syl-015.3` | 3 — sendings, the backend | landed on main; gaps + one bug | 7 |
| `syl-015.4` | 4 — From Syl, the surface | not started | 9 |
| `syl-015.5` | 5 — her voice | not started | 6 |
| `syl-015.6` | 6 — proof | not started | 1 |

Epic-level dependencies. None were created or removed by this import; recorded as they
now stand: `syl-015.6 → syl-015.4` and `syl-015.6 → syl-015.5`. The `syl-015.4 →
syl-015.3` edge existed when these tasks were written and **has since been cut**, which
is why the iOS track is open — see "Verification after wiring" below.

## Tasks

### Phase 2 — the hourly turn (`syl-015.2`)

| T-ID | Title | Path | Bead |
|---|---|---|---|
| T001 | Quiet hours cannot be pierced from the heartbeat lane | `backend/tests/integration/heartbeat-wiring.test.ts` | `syl-015.2.1` |
| T002 | `npm run when` reads the real quiet window, not a copy of it | `backend/src/harness/cli/when.ts` | `syl-015.2.2` |
| T003 | The rate counts sendings, not only reminders | `backend/src/jobs/heartbeat-job.ts` | `syl-015.2.3` |
| T004 | The ceiling refuses, rather than recording a failure after the fact | `backend/src/tools/server.ts` | `syl-015.2.4` |
| T005 | Verify the hour on the running service, and write down what it said | `docs/RUNBOOK.md` | `syl-015.2.5` |
| T006 | Deploy the hourly turn | `npm run deploy` | `syl-015.2.6` |

### Phase 3 — sendings, the backend (`syl-015.3`)

| T-ID | Title | Path | Bead |
|---|---|---|---|
| T007a | Failing tests for the sending verb | `backend/tests/unit/tool-server.test.ts` | `syl-015.3.1` |
| T007b | The sending verb, so she can make one | `backend/src/tools/schemas.ts` | `syl-015.3.2` |
| T008a | Failing tests for a sending stranded pending | `backend/tests/unit/sending-service.test.ts` | `syl-015.3.3` |
| T008b | The recovery pass, on boot, `RenderService.resume()`-shaped | `backend/src/services/sending-service.ts` | `syl-015.3.4` |
| T009 | The `0024` collision, which stops a boot rather than a test | `backend/src/migrations/` | `syl-015.3.5` |
| T025 | **bug** — the mock serves sendings in the wrong order | `shared/src/mock/server.ts` | `syl-015.3.7` |
| T010 | Verify acceptance 3, 4 and 6 on the running service | `docs/RUNBOOK.md` | `syl-015.3.6` |

`T025` was found after planning, by the agent that wrote the mock, and beaded because it
is the kind of defect that produces a *green* wrong answer: the mock is schema-conformant
and serves the wrong order, so snapshots taken against it would disagree with production
while passing. It is filed under `.3` because it is `.3`'s code, and wired to block
`syl-015.4.4` because that is where the damage would land.

**Dropped after the agent holding `.3` claimed them, both landed 2026-08-11**: the live
broadcast of her words (via `chat: ConversationService`, not a second sink) and the
reaping of the derived working directory (`#reap(sendingId)`). Not planned, not beaded.

### Phase 4 — From Syl, the surface (`syl-015.4`)

| T-ID | Title | Path | Bead |
|---|---|---|---|
| T011 | The contract on the phone: `Sending`, the endpoint, the fixtures | `ios/SylKit/Sources/SylKit/Model/Sending.swift` | `syl-015.4.1` |
| T012 | Sendings on disk, so the surface opens offline | `ios/Syl/Core/Store/LocalStore.swift` | `syl-015.4.2` |
| T013 | `SendingSource` — fetch, store, project | `ios/Syl/Core/Services/SendingSource.swift` | `syl-015.4.3` |
| T014a | Failing tests for the From Syl list and its snapshot | `ios/SylTests/FromSylSurfaceTests.swift` | `syl-015.4.4` |
| T014b | `FromSylListView` and `SendingListSnapshot` | `ios/Syl/Features/FromSyl/FromSylListView.swift` | `syl-015.4.5` |
| T015 | `FromSylScreen` and its view model | `ios/Syl/Features/FromSyl/FromSylScreen.swift` | `syl-015.4.6` |
| T016 | The door: a third destination beside Goals and Memory | `ios/Syl/Features/Home/HomeView.swift` | `syl-015.4.7` |
| T017 | Tapping plays her, with the poster as the still | `ios/Syl/Features/FromSyl/FromSylListView.swift` | `syl-015.4.8` |
| T018 | Open it on his phone, and write down what it showed | `docs/RUNBOOK.md` | `syl-015.4.9` |

### Phase 5 — her voice (`syl-015.5`)

| T-ID | Title | Path | Bead |
|---|---|---|---|
| T019 | Crack `voice.type` by asking the validator, not by guessing | `docs/VIDEO.md` | `syl-015.5.1` |
| T020 | One voice id, in her home, in one place | `backend/src/render/studio.ts` | `syl-015.5.2` |
| T021a | Failing tests for the speech client, from captured output | `backend/tests/unit/render-voice.test.ts` | `syl-015.5.3` |
| T021b | The speech client | `backend/src/render/voice.ts` | `syl-015.5.4` |
| T022 | The mux — her voice onto the render, the render untouched | `backend/src/render/voice.ts` | `syl-015.5.5` |
| T023 | A sending carries her voice | `backend/src/services/sending-service.ts` | `syl-015.5.6` |

### Phase 6 — proof (`syl-015.6`)

| T-ID | Title | Path | Bead |
|---|---|---|---|
| T024 | The proof, which is his | — | `syl-015.6.1` |

## Summary

| Phase | Tasks | Priority | Bead |
|---|---|---|---|
| 1: she renders herself | 0 (CLOSED) | 0 | `syl-015.1` |
| 2: the hourly turn | 6 | 0 | `syl-015.2` |
| 3: sendings — the backend | 7 | 0 | `syl-015.3` |
| 4: From Syl — the surface | 9 | 0 | `syl-015.4` |
| 5: her voice | 6 | 0 | `syl-015.5` |
| 6: proof | 1 | 0 | `syl-015.6` |
| **Total task beads** | **29** | | |

25 T-IDs; four of them (`T007`, `T008`, `T014`, `T021`) are Shape A splits and become
two beads each. 29 task beads in all, under six pre-existing sub-epics under one
pre-existing root. `T025` is the one bead added after planning — a bug found by the
agent that wrote the code it is against.

## Dependency graph

```
syl-015
├── syl-015.1  CLOSED ─ no tasks
├── syl-015.2  .1 .2 ──► .5 ──► .6
│               .3 ──► .4 ──────┘        .3 also ◄── syl-015.3.2
├── syl-015.3  .1 ──► .2 ──┐
│               .3 ──► .4 ──┴──► .6
│               .5  (independent)
│               .7  (independent) ── blocks ──► syl-015.4.4
├── syl-015.4  .1 ──┐
│               .2 ──┴──► .3 ──► .6 ──► .7 ──► .8 ──► .9
│               .4 ──► .5 ─────────┘   .4 ◄── syl-015.3.7
│              └── blocks ──► syl-015.6
├── syl-015.5  .1 ──► .3 ──► .4 ──► .5 ──► .6 ◄── syl-015.3.2
│               .2  (independent)
│              └── blocks ──► syl-015.6
└── syl-015.6  .1
```

Cross-phase task edges deliberately added:

- `syl-015.2.3 → syl-015.3.2` — the rate cannot count a verb that does not exist.
- `syl-015.5.6 → syl-015.3.2` — a sending must exist before it can carry a voice.
- `syl-015.4.4 → syl-015.3.7` — snapshots must not be taken against a mock that serves
  the wrong order, or they pass while disagreeing with production.

## Verification after wiring

`bd dep cycles` → **no cycles**.

`bd ready` returns ten task beads under `syl-015`, and they are exactly the ten with no
open blocker:

| Ready now | |
|---|---|
| `syl-015.2.1` | T001 the quiet-hours proof |
| `syl-015.2.2` | T002 `npm run when` |
| `syl-015.3.1` | T007a failing tests for the verb — **start here** |
| `syl-015.3.3` | T008a failing tests for the stranded `pending` row |
| `syl-015.3.5` | T009 the duplicate-migration check |
| `syl-015.3.7` | T025 the mock's sending order — **do this before `.4.4`** |
| `syl-015.4.1` | T011 the contract on the phone |
| `syl-015.4.2` | T012 sendings on disk |
| `syl-015.5.1` | T019 crack `voice.type` |
| `syl-015.5.2` | T020 the voice id in her home |

`syl-015.4.4` was ready and is now deliberately blocked on `syl-015.3.7`.

### The Phase 4 edge, and why the iOS track is open

As first wired, `syl-015.4` depended on `syl-015.3`, and **a dependency on a parent epic
hides every descendant regardless of the descendant's own edges** — `bd dep cycles` says
nothing about it, so it is worth knowing as a general trap in this tree. That edge left
`syl-015.4.1` and `.4.2` invisible to `bd ready` even though both were startable.

**It has since been removed, and Phase 4 is now open.** That was the right call: `.3`
has published `Sending`, `SendingPage`, `SendingState` and `GET /sendings` in
`shared/openapi.yaml` and `shared/src/types.ts`, which is exactly the "contract exists"
condition `syl-015.4`'s own description names as its reason for being held. The iOS
track can run beside the backend one.

What the removed edge was also carrying is still true and is now enforced at task level
rather than at epic level: `syl-015.4.9` (T018, open it on his phone) needs a real
sending to look at, and it sits behind the whole Phase 4 chain, so it cannot be reached
early by accident.

`syl-015.6.1` remains hidden, correctly: the proof cannot start before Phases 4 and 5
finish.

## Audit

`npx tsx scripts/audit-tasks-md.ts` **does not exist in this repository.** `scripts/`
contains no auditor, and nothing under `.claude/rules/03-testing.md` carries the
"Task Structure in tasks.md (TDD-shaped)" section the skill points at. The command
fails with `ERR_MODULE_NOT_FOUND`.

The rule was therefore checked against the SKILL.md definition by hand, task by task.
Result on the 28 tasks above: **0 flagged** — 16 Shape B (both a test-first phrase and
a GREEN phrase), 4 Shape A pairs (`T007`, `T008`, `T014`, `T021` — the `a` half carries
RED, the `b` half carries GREEN), and 6 exempt (`[docs]` ×5 for the running-service
verifications, the validator probe and the proof, all of whose deliverable genuinely is
a written record; `[setup]` ×1 for the deploy).

## Improvements

Level-4 beads (`syl-015.N.M.P`) are **not** pre-planned. They are created during
implementation, as children of the task that discovered them.
