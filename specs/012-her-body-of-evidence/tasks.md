# Tasks — Her Body of Evidence

**Feature**: 012-her-body-of-evidence · Markers: `[P]` parallelisable · `[US_n]` serves user story _n_

## Phase 1 — Authorisation, and the distinction that outlives it

- **T001** `[US1]` Add `com.apple.developer.healthkit` to `ios/Syl.entitlements` and
  `NSHealthShareUsageDescription` to the app's Info settings. Document, in the file
  and beside the existing Time Sensitive comment, that the key alone is not enough:
  the App ID capability and a regenerated provisioning profile are required, and a
  build missing either is indistinguishable from one he never authorised.
- **T002** `[US1]` `ios/Syl/Core/Health/HealthReader.swift` — request authorisation
  for the six types and read them. **Return what was authorised alongside what was
  read**, per type.
- **T003** `[P]` `[US1]` Define the wire contract for `POST /health/samples` and
  pin it with a captured fixture before either side is built. Carries: samples,
  the per-type authorisation report, and the device's watermark position.
- **T004** `[US1]` **RED acceptance test**: *empty is not denied*. A type he never
  authorised and a type with no samples must be distinguishable at every layer.
  Declare in `tests/expected-failures.json`.

## Phase 2 — Observations

- **T005** `[US1]` Migration: `health_samples`, `health_watermarks`,
  `health_authorisation`. **Claim the number from ORIGIN.** No column referencing
  `memory_nodes`, and a comment saying why the absence is the enforcement.
- **T006** `[US1]` `backend/src/health/samples.ts` — append, idempotent on
  `(type, start, end, source)`; watermark read and advance.
- **T007** `[US1]` `backend/src/routes/health-data.ts` — `POST /health/samples` with an
  idempotency key, `GET /health/watermarks`. Device scope: his own data.
- **T008** `[P]` `[US1]` **RED acceptance test**: *a re-upload changes nothing.*
  Same batch twice; the second is a no-op.
- **T009** `[P]` `[US1]` **RED acceptance test**: *a health sample cannot become a
  memory node.* Asserted on the live shape after a real upload, not on a fixture.
- **T010** `[US1]` `ios/Syl/Core/Health/HealthUploader.swift` — batch, upload on
  foreground, advance the watermark only on a confirmed write.
- **T011** `[P]` `[US1]` The 60-day downsample job: full resolution inside the
  window, daily aggregates outside it. State in the file that constraint 6 does not
  bind measurements, and why.

## Phase 3 — The admin view

- **T012** `[P]` `[US2]` `GET /health/series` — one type over a window, with source.
- **T013** `[US2]` The admin screen: every stored type, a window picker, and the
  raw rows. **Shows *not authorised* and *no data* differently.**

## Phase 4 — Derivations and review

- **T014** `[P]` `[US3]` `backend/src/health/derive.ts` — baselines, means,
  deviations. Pure: no I/O, no clock, so the arithmetic is testable without a
  database. Never persisted.
- **T015** `[US3]` `backend/src/health/review.ts` — the review turn. Derivations in,
  schema-validated conclusions out. The model judges; the service writes.
- **T016** `[US3]` Write conclusions through `remember()`: `kind: "memory"`, never
  `kind: "fact"`, with reasoning naming the window. **No bar at the door** — she
  decides what is worth keeping.
- **T017** `[P]` `[US3]` **RED acceptance test**: *a conclusion is hers, never his.*
  `kind: "memory"`, reasoning present and naming its window, and no `fact` node
  created by this path.
- **T018** `[US3]` Hang the review off the existing nightly consolidation lane. Not
  a new loop, and it must not extend the night's turn budget without saying so.

## Phase 5 — Surfacing

- **T019** `[US4]` She raises what she judged worth raising, carrying its `because`.
  **No health-specific gate**; she may interrupt often, per his ruling.
- **T020** `[P]` `[US4]` Record engagement on every health message, so a class he
  ignores is a class she can stop generating.
- **T021** `[P]` `[US4]` **RED acceptance test**: *a conclusion reaches him without
  being asked for*, and carries its reason.

## Notes

- Every RED test is declared in `tests/expected-failures.json` with its bead and
  comes out of that file one at a time as the work lands. The gate is strict both
  ways: a declared test that starts passing is also red.
- `npm run verify` must exit 0 at the end of every task.
- Any command carrying prose uses a quoted heredoc — backticks are executed
  otherwise, and this repository puts identifiers in backticks by house style.
