# Bead Map — The List

**Epic**: `syl-011` · 1 root + 7 sub-epics + 36 tasks = **44 beads**

Created 2026-08-10. `specs/` and the bead root were both claimed against **origin**, not
a local branch — five collisions in one day were traced to the other habit
(`CLAUDE.md`).

## Hierarchy

| Bead | Phase / Story | Type | P |
|---|---|---|---|
| `syl-011` | The List | epic | 1 |
| `syl-011.1` | Foundation: optimistic writes, and goals on the device | epic | 0 |
| `syl-011.2` | US1: he can finish a thing | epic | 0 |
| `syl-011.3` | US2: he can write one down in a sentence | epic | 1 |
| `syl-011.4` | US3: he can see everything he owes | epic | 1 |
| `syl-011.5` | US4: a goal tells him the truth | epic | 1 |
| `syl-011.6` | US5: he can choose the light | epic | 2 |
| `syl-011.7` | Polish: scale, accessibility, and the screenshots | epic | 3 |

## Tasks

| T-ID | Bead | Title |
|---|---|---|
| T001 | `syl-011.1.1` | The goal table on the device |
| T002 | `syl-011.1.2` | Stop ignoring goals in SyncEngine |
| T003 | `syl-011.1.3` | Goal reads in LocalStore |
| T004 | `syl-011.1.4` | Optimistic write helpers — the foundational seam |
| T005 | `syl-011.1.5` | A deferral is ASKED, not moved |
| T006 | `syl-011.1.6` | Replaying an intent applies once |
| T007 | `syl-011.1.7` | Refuse a completion of something already finished |
| T008 | `syl-011.2.1` | DaySpine.onSelect stops being a stub |
| T009 | `syl-011.2.2` | Completion settles rather than vanishes |
| T010 | `syl-011.2.3` | The defer affordance, with the server's authority visible |
| T011 | `syl-011.2.4` | Completion and deferral are labelled actions |
| T012 | `syl-011.2.5` | A refused intent surfaces on the row |
| T013 | `syl-011.3.1` | CaptureField: one sentence, nothing else |
| T014 | `syl-011.3.2` | No confirmation step and no inbox |
| T015 | `syl-011.3.3` | Empty commits write nothing |
| T016 | `syl-011.3.4` | Capture lives where he already is |
| T017 | `syl-011.4.1` | TodoOrdering — pure, tested, computed |
| T018 | `syl-011.4.2` | The list itself, from disk, with no loading state |
| T019 | `syl-011.4.3` | Reached from the foot of the day |
| T020 | `syl-011.4.4` | A to-do's goal is visible without the row becoming a form |
| T021 | `syl-011.4.5` | The empty state is a clear day |
| T022 | `syl-011.4.6` | 500 to-dos scroll without dropped frames |
| T023 | `syl-011.5.1` | GoalEvidence — what actually happened |
| T024 | `syl-011.5.2` | GoalRisk — silence and arithmetic |
| T025 | `syl-011.5.3` | The Goals orb becomes a door |
| T026 | `syl-011.5.4` | GoalDetailView: evidence, and no percentage |
| T027 | `syl-011.5.5` | Abandoned is a non-shameful outcome |
| T028 | `syl-011.5.6` | Nesting, and a derived horizon |
| T029 | `syl-011.6.1` | AppearanceSetting — System, Day, Night |
| T030 | `syl-011.6.2` | Applied app-wide |
| T031 | `syl-011.6.3` | Home stops forcing night unconditionally |
| T032 | `syl-011.6.4` | Each choice resolves, persists, and follows |
| T033 | `syl-011.7.1` | Render every new surface, and look at it |
| T034 | `syl-011.7.2` | Screenshot the list and a goal beside Today and Chat |
| T035 | `syl-011.7.3` | Dynamic Type and Reduce Motion across the new surfaces |
| T036 | `syl-011.7.4` | Grep gate: no stock system colour |

## Dependencies

- `.2`, `.3`, `.4`, `.5` each depend on `.1` — nothing renders before the store can
  write.
- **`.6` depends on nothing.** Appearance touches `SylApp`, `HomeView` and Settings and
  no part of the list. It is the one phase that can start on day one, and it answers a
  question the Commander asked directly.
- `.7` depends on `.2`, `.4`, `.5`, `.6` — it photographs them.
- Within `.1`: `T002`/`T003` need `T001`'s record; `T005`/`T006`/`T007` need `T004`'s
  helpers.
- `T018` needs `T017`; `T026` needs `T023` and `T024`.

## Two decisions with the Commander

Neither blocks. Both are filed as questions and proceeding on proposal B's own
recommended defaults:

1. **Family goals vs single user** (B §13 #3, which says decide it *now*). Assumed:
   single user, with a shareable digest if he ever wants to share.
2. **Does Syl propose structure she infers from conversation?** (B §13 #4, "his instinct
   should win"). Assumed: on, bounded, expiring — but the `proposed`-state UI is
   deliberately **out of this epic** so the answer can be "no" without unpicking
   anything.
