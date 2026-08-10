# Tasks — The Constellation

**Feature**: 009-the-constellation · **Epic**: `syl-cst`

`[P]` = parallelisable. Exact paths in every task. Tests first.

---

## Phase 1 — The phone can see it at all (`.1`)

- **T001** A **device-scoped** read for the constellation. `/memory` is mounted behind
  `requireAdmin`; the phone holds a `device` key and gets `403` today. Follow the `/logs`
  reasoning rather than copying it: logs are admin because they are the record of what a
  program did on his machine — **the memory graph is facts about him, his people and his
  goals, which is his own data.** Reading it is `device`. `metrics` and
  `edges/{id}/feedback` stay `admin`: they tune the engine and are not his data.
- **T002** Shape the payload for a sky, not for an instrument: nodes with `kind`, `tier`,
  `confidence`, label and provenance; edges with `species` and `confidence`. Bounded, and
  the bound stated in the response so the client never implies it has everything.
- **T003** Contract, then generated types, then captured fixtures, then SylKit — the order
  `syl-008` learned the hard way, and remember that a contract change and its Swift client
  are **not separable** (`docs/CONTEXT.md`).
- **T004** Store it on the device and read it from disk. Local-first is not suspended for
  a pretty screen: the sky opens instantly, offline, or it is not part of this app.
- **T005** Whether a **delete** exists for a memory node. His explicit order deletes — the
  one exception to constraint 6. If no route exists, this is contract work and belongs
  here. Report what you find before building it.

## Phase 2 — The sky (`.2`) — *the phase that matters*

- **T006** `ios/Syl/Features/Memory/Constellation.swift` — **one `Canvas`**, not a view per
  star. Read `MoteField.swift` first: it draws forty soft points on coprime periods in a
  single canvas, and this is that technique pointed at real data.
- **T007** `ConstellationLayout.swift` — **pure and tested.** `position(node) -> CGPoint`,
  seeded from the node id through `Scatter.hash`, identical every launch. Anchors are
  people and goals; facts orbit their anchor at a radius set by confidence; depth comes
  from age. Test that the same input gives the same point across runs, and that two nodes
  never land on top of each other.
- **T008** Brightness **is** confidence and depth **is** tier — mapped directly, no
  buckets, no thresholds, no legend. A faint star is faint because the memory is.
- **T009** Filaments: edges drawn between anchors with `observed` solid and `inferred`
  gossamer, on `plusLighter`. `SylRibbon.swift` is the reference for a glowing line — mine
  its feather pass rather than inventing one.
- **T010** Prepared off the main actor into a finished value, `ChatSnapshotLoader`-style
  (D4, R4).
- **T011** The Memory orb becomes a door: `isReady: true`, and `onOpen(.memory)` leads
  somewhere. It is deliberately dimmed today.

## Phase 3 — It lives (`.3`)

- **T012** `offset(node, t)` — small, slow, **bounded**, on coprime periods so nothing
  resynchronises into a visible loop. The app's existing vocabulary: drift, roll, breath.
- **T013** **A star drifts around its anchor and never travels to a new one.** Assert the
  bound: no value of `t` moves a star more than a stated radius from `position(node)`.
  This is the Commander's requirement expressed as a test rather than as a hope (R3).
- **T014** Depth parallax: nearer stars drift a little more than far ones. It is the
  cheapest thing that turns a flat field into a space.
- **T015** Reduce Motion pins every star at its anchor — and the still must read as *the
  same sky*, not a broken one (D5).

## Phase 4 — Touch a star (`.4`)

- **T016** Hit-testing against **anchor** positions, not drifting ones, so a tap lands
  where he aimed.
- **T017** The star brightens, its filaments light, and neighbours dim — the graph
  answering rather than a selection highlight.
- **T018** One card: the memory in her words, when she learned it, and **from what**.
  Provenance is the answer to the only question that matters about a memory.
- **T019** VoiceOver: a `Canvas` is invisible to it. Every star is an accessibility element
  with a label and a position, or this screen does not exist for anyone using it.

## Phase 5 — Forget (`.5`)

- **T020** Two taps, confirmed once, and it is the only destructive act in the app.
- **T021** Optimistic + outbox, like every other write. The star goes out immediately.
- **T022** It must genuinely delete rather than suppress — his ruling, and the exception
  to constraint 6. A test asserts the row is gone, not demoted.

## Phase 6 — Polish (`.6`)

- **T023** Render it, in day and night, and **look at it**. This is the primary check on
  this feature, not a supplement to it (R2).
- **T024** Five hundred nodes without dropped frames.
- **T025** Dynamic Type on the card; Reduce Motion; no stock system colour.
- **T026** Screenshot beside home and chat — one product.

---

## Not this feature

- **The admin instrument.** Same data, opposite priorities. His call: the app gets beauty,
  the admin gets the useful things.
- **Filters, search, a node count.** If it needs a legend it has failed, and a count is a
  dashboard statistic on a screen whose doors are documented as *not statistics*.
- **Making it useful.** Decided explicitly. "But is it useful" is not a defect report
  against this feature (R5).
