# Plan — Her Body of Evidence

**Feature**: 012-her-body-of-evidence · **Spec**: `spec.md` · **Proposal**: `ff3f839e`

## Architecture

Three stores, three lifetimes, one direction of dependency. Nothing below reaches up.

```
  iPhone (HealthKit)
        │  POST /health/samples          idempotent, watermarked, curated types
        ▼
  health_samples          OBSERVATIONS   60d full resolution → daily aggregates
        │                                never a node, never in a prompt
        ▼  (computed, never stored long)
  health-derive.ts        DERIVATIONS    baselines, means, deviations
        │                                a projection: thrown away and rebuilt
        ▼  (nightly consolidation turn)
  remember()              CONCLUSIONS    kind:"memory", inferred edges,
                                         reasoning naming the window
        │
        ▼
  she tells him           SURFACING      carries `because`, engagement recorded
```

### The boundary that must be structural

`health_samples` has **no `memory_node` id column and no path into the graph**.
`memory/schema.ts` is not extended with a health kind. The absence is the
enforcement — there is nothing to misuse. A test asserts that after a full upload
and a full review, `SELECT count(*) FROM memory_nodes WHERE kind NOT IN (...)` has
not grown by the sample count.

### Why derivations are not a table

Same argument as `0019_working_memory.sql` makes for the projection: a derivation
that accumulates becomes the cheapest authority to read, therefore the one
everything reads, and it is the only part of the system with no path back to what
it was derived from. It drifts and nothing errors. So derivations are computed on
demand from `health_samples` and held only for the length of a review.

The exception is the **daily aggregate**, which is a downsample of observations
rather than an interpretation of them — it lives in the observation store because
it *is* an observation, at coarser resolution.

## Key files

| Path | What |
|---|---|
| `ios/Syl.entitlements` | + `com.apple.developer.healthkit` |
| `ios/Syl/Core/Health/HealthReader.swift` | authorisation, read, **authorisation report** |
| `ios/Syl/Core/Health/HealthUploader.swift` | watermark, batching, retry |
| `backend/src/migrations/00NN_health.sql` | `health_samples`, `health_watermarks`, `health_authorisation` |
| `backend/src/health/samples.ts` | the store: append, watermark, downsample |
| `backend/src/health/derive.ts` | baselines and deviations, pure, no I/O |
| `backend/src/health/review.ts` | the review turn's input and schema-validated output |
| `backend/src/routes/health-data.ts` | `POST /health/samples`, `GET /health/watermarks`, `GET /health/series` |

**Not `routes/health.ts`** — that name was in the first draft of this plan and it
is already taken by the service's LIVENESS endpoint, `GET /health`, which is the
one unauthenticated route in the contract. Authentication is mounted on
`/health/samples`, `/health/watermarks` and `/health/series` **by name and never on
the `/health` prefix**, so a bearer check cannot land in front of liveness whatever
the mount order turns out to be. Caught by the backend agent while building.
| `backend/src/jobs/nightly-*.ts` | the review step, on the lane that already exists |
| `frontend/src/…/Health*` | the admin view (US2) |

**Migration number**: claim it from **ORIGIN** at the moment of writing, not from
the branch. Two migrations collided head-on during `syl-zdf` because a branch was
stale; the contiguity guard caught it, but only after taking down every test that
opens a database.

## Phases

**Phase 1 — Authorisation, and the distinction that outlives it.** The entitlement,
the App ID capability, the usage string, and the authorisation report. Nothing else
is testable without it, and the report is what stops *empty* and *denied* being the
same answer forever.

**Phase 2 — Observations.** Schema, store, watermark, idempotent upload, the six
types, the downsample job.

**Phase 3 — The admin view.** His ruling: he wants to see the raw data.

**Phase 4 — Derivations and review.** Baselines, deviations, and the nightly turn
that reads them and writes conclusions through `remember()`.

**Phase 5 — Surfacing.** She raises what she found, carrying `because`, with
engagement recorded.

### Parallel opportunities

- Phase 3 (admin) is independent of Phase 4 once Phase 2 lands — different files,
  no shared seam.
- The iOS half of Phase 1 and the schema half of Phase 2 can run together; they
  meet at the route contract, which should be written first and pinned by a fixture.

## Testing strategy

Every acceptance test describes **correct** behaviour. Anything not yet built stays
**RED** and is declared in `tests/expected-failures.json` against its bead — never
softened into asserting what the code does today.

Four tests carry this feature and should be written before the code they describe:

1. **A health sample cannot become a memory node.** Measured on the shape after a
   real upload and a real review, not on a fixture.
2. **Empty is not denied.** A type he never authorised and a type with genuinely no
   samples produce different, distinguishable answers at every layer.
3. **A re-upload changes nothing.** Same batch twice, and the second is a no-op.
4. **A conclusion is hers, never his.** `kind: "memory"`, reasoning present, naming
   its window; and no `fact` node is ever created by the review path.

Mock HealthKit at the Swift seam; use captured sample shapes, never shapes invented
from our own types.

## Bead Map

Root `syl-t9tj` — 27 beads. Full table and T-ID mapping in `beads-import.md`.

- `syl-t9tj` — **Her Body of Evidence**
  - `syl-t9tj.1` — Phase 1: Authorisation *(4 tasks — the only phase ready today)*
  - `syl-t9tj.2` — Phase 2: Observations *(7 tasks)*
  - `syl-t9tj.3` — Phase 3: The admin view *(2 tasks)*
  - `syl-t9tj.4` — Phase 4: Derivations and review *(5 tasks)*
  - `syl-t9tj.5` — Phase 5: Surfacing *(3 tasks)*

Dependencies are wired **sibling-to-sibling** (`.1 → .2 → {.3, .4} → .5`) rather
than task-to-parent, because a blocking dependency on a parent propagates down and
removes every descendant from `bd ready`. Verified by running `bd ready` after
wiring rather than assuming it: all four Phase 1 tasks appear and nothing
downstream does.

### Types, decided

His four — heart rate, HRV, sleep, steps — plus **resting heart rate** (kept
distinct: it is the baseline nearly every conclusion leans on, and raw HR is the
highest-volume type HealthKit offers) and **weight** (because `Get back to 185
pounds` is already a goal in his graph, which makes the conclusion layer useful on
day one instead of after a month of baseline-building). Workouts deferred.

### Still open, not blocking

Whether a health message may ever be `time-sensitive` and break through Focus.
*"She can interrupt often"* answers frequency; loudness is a different decision and
the default until he rules is an ordinary notification.
