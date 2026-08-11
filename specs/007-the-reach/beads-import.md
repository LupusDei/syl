# Bead map — The Reach (`syl-013`)

**Feature**: `007-the-reach`
**Generated**: 2026-08-10 · **Revised**: 2026-08-11
**Source**: `specs/007-the-reach/tasks.md`

41 beads: 1 root, 7 sub-epics, 33 tasks. Hierarchy is `bd update <id> --parent`;
ordering is `bd dep add <blocked> <blocker>`, wired at **task** level only.

## The 2026-08-11 revision

`reach_do` and the delegate. **Phase numbering is unchanged and nothing was
renumbered** — a bead id is an address other documents and other agents already
hold, and renumbering to keep a list tidy costs more than the tidiness is worth.

- **Rewritten in place**: `syl-013.1.6` (the one door — two callers, and it now
  exposes readable page text) and `syl-013.1.7` (the verbs — `reach_do` and
  `reach_read` added, and the commander/delegate surface split).
- **Appended to Phase 1**: `syl-013.1.9`, `.1.10`, `.1.11`.
- **Clauses added**: `syl-013.7.1` (one `reach_do` call, not fifteen) and
  `syl-013.7.2` (pin that her main conversation ingests no page text).

Task numbers **T031–T033** are allocation order and not execution order. They
belong to Phase 1; `tasks.md` § *Dependencies* carries the ordering.

## Two `bd` mechanics that cost a rework here — do not rediscover them

**`bd create` refuses `--id` and `--parent` together.** Create with `--id`, then
reparent with `bd update <id> --parent=<parent>` in a second pass.

**A blocker on a parent propagates DOWN to every descendant.** This is the
opposite of the note left on `syl-009`, which said `bd` does not cascade an
epic-level dependency to its children. That note was about *blockers not reaching
children when you wanted them to*; what actually happens on this version is that
a blocker on an epic removes **every task beneath it** from `bd ready`. Both
directions of the misunderstanding cost real time, so:

- **Epic-level ordering dependencies were created and then removed.** They looked
  tidy in `bd blocked` and they hid four independent starting tracks — including
  `syl-013.4.1`, the migration, which depends on nothing. Task-level edges carry
  the real ordering and are the only ones kept.
- **`syl-009` is linked with `bd dep relate`, not `bd dep add`.** The work is
  complete; the epic is merely still open pending auto-close. As a hard blocker
  it removed all 30 tasks from `bd ready` — a bookkeeping state stalling a whole
  epic. The relationship is recorded as `relates_to` and in the root's
  description instead.

The check that catches both: after wiring, run `bd ready` and confirm the beads
you called independent are actually in it. `bd dep cycles` says nothing about
this.

**The root is `syl-013`, not `syl-010`.** `syl-010` was taken on 2026-08-10 by
"Who she is: personality, memory, and the container she inhabits"
(`specs/006-who-she-is/`); `syl-011` (the list) and `syl-012` (she notices) are
taken too. The spec directory stays `007-the-reach`. See `spec.md` § *Recorded
assumptions*.

## Root epic

- **ID**: `syl-013`
- **Title**: Syl 13: the reach — a browser she drives, at hosts he allowed
- **Type**: epic
- **Priority**: 0
- **Depends on**: `syl-009` (complete)

## Sub-epics

| Bead | Phase | Priority | Tasks |
|---|---|---|---|
| `syl-013.1` | Phase 1: the reach — the browser, her profile, the allowlist below her | 0 | 11 |
| `syl-013.2` | Phase 2: credentials — per-host, keychain, individually revocable | 0 | 4 |
| `syl-013.3` | Phase 3: consequence visibility — facts, not vetoes | 0 | 5 |
| `syl-013.4` | Phase 4: the ledger — what, where, why, what it cost | 0 | 5 |
| `syl-013.5` | Phase 5: the spending frame — set once, not asked each time | 1 | 3 |
| `syl-013.6` | Phase 6: her soul — proposed, not assumed | 1 | 2 |
| `syl-013.7` | Phase 7: proof — she books something real | 0 | 3 |

## Tasks

### Phase 1 — the reach

| T-ID | Bead | Title | Primary path |
|---|---|---|---|
| T001 | `syl-013.1.1` | The allowlist predicate, pure and testable without a browser | `backend/src/reach/allowlist.ts` |
| T002 | `syl-013.1.2` | The allowlist is his: stored, and admin-scoped | `backend/src/services/reach-allowlist-service.ts` |
| T003 | `syl-013.1.3` | Playwright, pinned exact, binaries outside the repo | `backend/package.json` |
| T004 | `syl-013.1.4` | Her own browser profile, never the Commander's | `backend/src/reach/browser.ts` |
| T005 | `syl-013.1.5` | Enforced below her: one chokepoint, four bypass tests | `backend/tests/unit/reach-allowlist-enforcement.test.ts` |
| T006 | `syl-013.1.6` | The one door: act, describe, record | `backend/src/reach/session.ts` |
| T007 | `syl-013.1.7` | The front door `reach_do`, the granular six beneath it, and the two surfaces | `backend/src/tools/schemas.ts` |
| T008 | `syl-013.1.8` | She may act and may not widen her own allowlist; headless by default | `backend/src/middleware/auth.ts` |
| T031 | `syl-013.1.9` | The delegate: given the goal, it reads and clicks and comes back | `backend/src/reach/delegate.ts` |
| T032 | `syl-013.1.10` | Ask the page, do not snapshot it — answered by a sealed reader turn | `backend/src/reach/read.ts` |
| T033 | `syl-013.1.11` | The delegate holds none of her verbs, proven | `backend/tests/unit/reach-delegate-confinement.test.ts` |

### Phase 2 — credentials

| T-ID | Bead | Title | Primary path |
|---|---|---|---|
| T009 | `syl-013.2.1` | The OS keychain, per host, never a shell | `backend/src/reach/keychain.ts` |
| T010 | `syl-013.2.2` | Registered at the console, mintable from no route | `backend/src/ops/cli/reach.ts` |
| T011 | `syl-013.2.3` | The secret reaches a page and never a response or a turn | `backend/tests/integration/reach-credential.test.ts` |
| T012 | `syl-013.2.4` | Revoking one host stops it and leaves the others working | `backend/src/ops/cli/reach.ts` |

### Phase 3 — consequence visibility

| T-ID | Bead | Title | Primary path |
|---|---|---|---|
| T013 | `syl-013.3.1` | Consequence as facts: reversible, whose, what it consumes | `backend/src/reach/consequence.ts` |
| T014 | `syl-013.3.2` | Irreversibility, and naming the undo when there is one | `backend/src/reach/consequence.ts` |
| T015 | `syl-013.3.3` | Ownership carries the evidence, not the conclusion | `backend/src/reach/consequence.ts` |
| T016 | `syl-013.3.4` | The Sydney tell: a missing authorisation check is evidence, not permission | `backend/src/reach/authorization-probe.ts` |
| T017 | `syl-013.3.5` | Facts, not vetoes — proven structurally | `backend/tests/unit/reach-consequence-has-no-veto.test.ts` |

### Phase 4 — the ledger

| T-ID | Bead | Title | Primary path |
|---|---|---|---|
| T018 | `syl-013.4.1` | The ledger table, with `because` guarded by shape | `backend/src/migrations/` |
| T019 | `syl-013.4.2` | The write lives inside the acting function | `backend/src/services/reach-ledger-service.ts` |
| T020 | `syl-013.4.3` | `GET /reach/ledger`, admin-scoped like `/logs` | `backend/src/routes/reach.ts` |
| T021 | `syl-013.4.4` | The ledger in the admin | `frontend/src/features/reach/LedgerView.tsx` |
| T022 | `syl-013.4.5` | Exactly one function acts, and it is the one that records | `backend/tests/unit/reach-one-door.test.ts` |

### Phase 5 — the spending frame

| T-ID | Bead | Title | Primary path |
|---|---|---|---|
| T023 | `syl-013.5.1` | Money and the softer currencies, set once | `backend/src/services/reach-frame-service.ts` |
| T024 | `syl-013.5.2` | He sets the frame in the admin | `frontend/src/features/reach/FrameView.tsx` |
| T025 | `syl-013.5.3` | At the edge she asks; she never silently stops | `backend/src/reach/frame-gate.ts` |

### Phase 6 — her soul

| T-ID | Bead | Title | Primary path |
|---|---|---|---|
| T026 | `syl-013.6.1` | Draft the language for a cost to an identified third party | `specs/007-the-reach/soul-draft.md` |
| T027 | `syl-013.6.2` | His ruling, recorded verbatim before anything is edited | `docs/CONTEXT.md` |

### Phase 7 — proof

| T-ID | Bead | Title | Primary path |
|---|---|---|---|
| T028 | `syl-013.7.1` | Acceptance: she can reach — red first, declared | `backend/tests/acceptance/us7-she-can-reach.test.ts` |
| T029 | `syl-013.7.2` | The residual pinned: a reach session is not a reader turn | `backend/tests/unit/reach-is-not-the-reader.test.ts` |
| T030 | `syl-013.7.3` | The live proof, watched, by hand | `docs/CONTEXT.md` |

## Summary

| Phase | Tasks | Priority | Bead |
|---|---|---|---|
| 1: the reach | 11 | 0 | `syl-013.1` |
| 2: credentials | 4 | 0 | `syl-013.2` |
| 3: consequence | 5 | 0 | `syl-013.3` |
| 4: the ledger | 5 | 0 | `syl-013.4` |
| 5: the frame | 3 | 1 | `syl-013.5` |
| 6: her soul | 2 | 1 | `syl-013.6` |
| 7: proof | 3 | 0 | `syl-013.7` |
| **Total** | **33 tasks + 7 sub-epics + 1 root = 41** | | |

## Dependency graph

```
syl-013.1.3 ──> .1.4 ──> .1.5 ──> .1.6 ──> .1.7 ──> .1.11 ──> .1.9
syl-013.1.1 ──────────────^          └──> .1.10 ──────────────^
syl-013.1.2 ──> .1.8
syl-013.1.4 ──> .2.1 ──> .2.2 ──> .2.3
                          └──────> .2.4
syl-013.3.1 ──> .3.2 ─┐
              ──> .3.3 ├──> .3.5
              ──> .3.4 ┘
syl-013.4.1 ──> .4.2 ──> .4.3 ──> .4.4
syl-013.1.6 ──────^      └──────> .4.5
syl-013.5.1 ──> .5.2
              ──> .5.3
syl-013.6.1 ──> .6.2
   .1.6 + .1.9 + .3.5 + .4.2 + .5.3 ────> .7.1 ──> .7.3
                        .1.9 ───────────> .7.2 ──┘
```

**`.1.11` blocks `.1.9`, and that is deliberate.** The delegate-confinement sweep
goes in before the delegate exists, for the reason `.1.5` goes in before `.1.6`
and `.3.5` lands with `.3.1`: a guard written against code that already exists is
shaped by the code it finds. It is the same argument the plan makes three times,
and this is the third.

## Ready at the start — verified against `bd ready`, not asserted

```
syl-013.1.1  the allowlist predicate — pure, no browser, no dependency
syl-013.1.2  the allowlist store and its admin scope
syl-013.1.3  Playwright, pinned
syl-013.3.1  consequence as facts — pure, testable against captured observations
syl-013.4.1  the ledger migration
syl-013.5.1  the spending frame's store
syl-013.6.1  the soul draft — prose, blocks nothing
```

`syl-013.1.5` and `syl-013.3.5` deserve to go first among the rest. They are the
tests that say what this system must never do — the allowlist has no bypass, and
the consequence layer has no veto — and they should be green before anything
gains the ability to act.

## Improvements

Improvements (`syl-013.N.M.P`) are not pre-planned here. They are created during
implementation when a bug, a refactor or an extra test is discovered, as children
of the affected task.
