# Beads — Her Body of Evidence

**Root epic**: `syl-t9tj` · **27 beads**: 1 root + 5 sub-epics + 21 tasks
**Created**: 2026-08-12 from proposal `ff3f839e` (revision 2)

## Hierarchy

| Bead | T-ID | Title | Type | P |
|---|---|---|---|---|
| `syl-t9tj` | — | Her Body of Evidence | epic | 1 |
| `syl-t9tj.1` | — | **Phase 1: Authorisation, and the distinction that outlives it** | epic | 0 |
| `syl-t9tj.1.1` | T001 | The entitlement, the capability, and the comment that stops the next silent build | task | 0 |
| `syl-t9tj.1.2` | T002 | HealthReader: read the six types, and report what it was ALLOWED to read | task | 0 |
| `syl-t9tj.1.3` | T003 | [P] Pin the upload contract with a captured fixture, before either side is built | task | 0 |
| `syl-t9tj.1.4` | T004 | **RED**: empty is not denied | task | 0 |
| `syl-t9tj.2` | — | **Phase 2: Observations — the store that must never touch the graph** | epic | 0 |
| `syl-t9tj.2.1` | T005 | Migration: three tables, and a comment saying why there is no fourth column | task | 0 |
| `syl-t9tj.2.2` | T006 | The sample store: append, idempotent, watermarked | task | 0 |
| `syl-t9tj.2.3` | T007 | POST /health/samples and GET /health/watermarks | task | 0 |
| `syl-t9tj.2.4` | T008 | [P] **RED**: a re-upload changes nothing | task | 0 |
| `syl-t9tj.2.5` | T009 | [P] **RED**: a health sample cannot become a memory node | task | 0 |
| `syl-t9tj.2.6` | T010 | HealthUploader: batch, upload on foreground, advance on confirmation | task | 0 |
| `syl-t9tj.2.7` | T011 | [P] The 60-day downsample | task | 1 |
| `syl-t9tj.3` | — | **Phase 3: The admin view — he sees the raw data** | epic | 1 |
| `syl-t9tj.3.1` | T012 | [P] GET /health/series — one type over a window | task | 1 |
| `syl-t9tj.3.2` | T013 | The admin screen, which must not render two different facts the same way | task | 1 |
| `syl-t9tj.4` | — | **Phase 4: Derivations and review — what she makes of it** | epic | 0 |
| `syl-t9tj.4.1` | T014 | [P] derive.ts — baselines and deviations, pure | task | 0 |
| `syl-t9tj.4.2` | T015 | The review turn: derivations in, schema-validated conclusions out | task | 0 |
| `syl-t9tj.4.3` | T016 | Write conclusions through remember(): hers, never his | task | 0 |
| `syl-t9tj.4.4` | T017 | [P] **RED**: a conclusion is hers, never his | task | 0 |
| `syl-t9tj.4.5` | T018 | Hang the review on the existing nightly lane | task | 0 |
| `syl-t9tj.5` | — | **Phase 5: Surfacing — she tells him, unprompted** | epic | 0 |
| `syl-t9tj.5.1` | T019 | She raises it, unprompted, carrying her reason | task | 0 |
| `syl-t9tj.5.2` | T020 | [P] Record engagement, because that is the only governor | task | 0 |
| `syl-t9tj.5.3` | T021 | [P] **RED**: a conclusion reaches him without being asked for | task | 0 |

## Dependencies

Wired **sibling-to-sibling**, deliberately:

```
.1 ──▶ .2 ──┬──▶ .3
            └──▶ .4 ──▶ .5
```

`.3` and `.4` are parallel once `.2` lands — different files, no shared seam.

**A blocking dependency on a PARENT propagates down and removes every descendant
from `bd ready`.** That is why these edges join sub-epics rather than hanging tasks
off their parent epic, and `bd ready` was checked after wiring rather than assumed:
all four Phase 1 tasks appear, and nothing downstream does. Asserting the graph is
right is not the same as asking it.

## The four RED tests

Each is written before the code it describes, stays red, and is declared in
`tests/expected-failures.json` against its bead. They come out of that file one at
a time as the work lands — the gate is strict both ways, so a declared test that
starts passing is also a failure.

| Bead | Claim |
|---|---|
| `syl-t9tj.1.4` | Empty is not denied, at every layer |
| `syl-t9tj.2.4` | A re-upload changes nothing |
| `syl-t9tj.2.5` | A health sample cannot become a memory node — measured on the live shape |
| `syl-t9tj.4.4` | A conclusion is hers, never his |
| `syl-t9tj.5.3` | A conclusion reaches him without being asked for |

## Assumptions taken, not blocking

- **Six types**: his four (heart rate, HRV, sleep, steps) plus **resting heart
  rate** (the baseline signal nearly every conclusion leans on; raw HR is the
  highest-volume type HealthKit offers) and **weight** (because `Get back to 185
  pounds` is already a goal in his graph, so the conclusion layer is useful on day
  one). Workouts deferred — adding a type is cheap, removing one is not.
- **Loudness is unanswered.** *"She can interrupt often"* settles frequency, not
  whether a health message may ever be `time-sensitive` and break through Focus.
  Default is an ordinary notification until he says otherwise.
