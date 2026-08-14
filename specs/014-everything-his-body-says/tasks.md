# Tasks — Everything his body says

Markers: `[P]` parallelisable · `[US_n]` serves user story _n_

## Phase 1 — The seven types

- **T001** `[US1]` Add to `HEALTH_TYPES` and `UNITS` in `backend/src/health/contract.ts`:
  `activeEnergy` (kcal), `basalEnergy` (kcal), `bodyFatPercentage` (%),
  `vo2Max` (ml/kg/min), `height` (cm), `leanBodyMass` (lb), `respiratoryRate`
  (count/min). Fourteen total.
- **T002** `[US1]` `ios/Syl/Core/Health/HealthReader.swift` — the matching
  `HKQuantityTypeIdentifier`s and unit conversions. Units convert AT THIS SEAM so
  no sample carries its own.
- **T003** `[P]` `[US1]` Widen the Swift wire enum and its round-trip test.
- **T004** `[US1]` Check `tool-surface-budget` — the `types` enum in
  `how_has_he_been` doubles. Raise the ceiling only if an intended contributor
  outgrew it, and by a margin rather than to exactly clear it.
- **T005** `[P]` `[US1]` **RED**: no new type can become a memory node. The
  existing sweep, now with fourteen chances to fail.

## Phase 2 — Speed, and it gates everything after it

- **T006** `[US2]` `derive.ts` reads **daily aggregates** rather than raw samples.
  The 60-day downsample already produces the shape it wants. Two 20,000-row scans
  become two ~60-row reads.
- **T007** `[US2]` `summarise.ts` uses the aggregate path; raw rows only when a
  caller needs within-day resolution, which the summary never does.
- **T008** `[US2]` **RED**: `how_has_he_been` answers in **under a second** with
  all fourteen types, measured against a corpus his size. Closes `syl-6ig6`.

## Phase 3 — What his body cannot say

- **T009** `[US3]` The `unavailable` judgement in `summarise.ts`: `authorised` +
  zero samples + a long authorised window ⇒ `unavailable`, carrying the window
  that justifies it. It is an inference, so it says what it is drawn from.
- **T010** `[P]` `[US3]` **RED**: a type his source does not publish reads as
  `unavailable`, not `denied`. HRV and resting heart rate are the live cases.
- **T011** `[P]` `[US3]` The admin distinguishes it, and never advises a
  permission change for a type no source publishes.

## Phase 4 — Facts, not measurements

- **T012** `[US4]` `backend/src/health/characteristics.ts` — date of birth, sex,
  height read through the characteristic API and written to the **memory graph**,
  never `health_samples`.
- **T013** `[US4]` Precedence: where Health and his own words disagree, **his
  words win**, and she can say which she used. `SOUL.md`'s ladder, new input.
- **T014** `[P]` `[US4]` **RED**: a characteristic never lands in
  `health_samples` and never acquires a baseline.

## Phase 5 — Blood pressure *(gated on his decision)*

- **T015** Systolic and diastolic as a pair the store cannot separate. Two rows
  that must be read together is a join nobody enforces; prefer a shape that
  cannot come apart.

## Phase 6 — Workout routes *(gated on his explicit yes)*

- **T016** GPS. Where he has been, not how his body is. Do not start without it.

## Notes

- RED tests are declared in `tests/expected-failures.json` with their bead and
  promoted out in the commit that turns them green.
- Widening her reach costs three deliberate edits in three files. Do not shortcut.
- `npm run verify` exits 0 at the end of every task.
