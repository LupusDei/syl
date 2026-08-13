# 013 — Implementation plan

**Root epic**: `syl-023`

## The one architectural decision

Everything in this epic hangs on a single new module: **a model registry that
is the only place a fact about a model is written down.**

`backend/src/render/models.ts`

The alternative — reading `model` as a free string and scattering `if (model ===
"seedance2_5")` through `render-service.ts` — is the shape this project has
already been burned by twice. `syl-63v` is what a second assertion about the
same fact costs: `holdsLikeness` said `true` for a day after the thing it
described was taken away, because the flag and the mechanism were separate
statements. `DEFAULTS.ratio` said `720:1280` above a stream of landscape videos
for the same reason.

So the registry stores only what was **measured**, and every capability question
is **derived** from it:

```ts
interface ModelCapability {
  readonly id: string;                       // "seedance2_5"
  readonly shape: "ratio" | "resolution";    // which field sets geometry
  readonly ratios?: readonly string[];       // measured, verbatim from the 400
  readonly resolutions?: readonly string[];  // "480p" | "720p" | "1080p"
  readonly duration: { readonly min: number; readonly max: number };
  readonly positions: readonly ("first" | "last")[];  // the keyframe slots
  readonly creditsPerSecond: Partial<Record<ResolutionTier, number>>;
  readonly measuredOn: string;               // the date the probe ran
  readonly evidence: string;                 // the sentence she is shown
}
```

**`canAnchorLikeness` is a function of `positions`, never a field.** A model
whose `positions` lacks `last` has nowhere to pin her face, so it cannot anchor
a face-on framing — and that is arithmetic, not an opinion. This is the same
discipline `framing.ts` already applies and the reason a new model added later
cannot lie about itself: to claim it anchors a likeness it has to actually
declare the slot.

`framing.ts`'s `holdsLikeness` gains the model as an input. Today it asks *is
there a face here, and does anything pin it*; it now also asks *can this model
pin anything*. Three facts, one derivation, still no boolean typed by hand.

## Files

| file | change |
|---|---|
| `backend/src/render/models.ts` | **new** — the registry and its derivations |
| `backend/src/render/credits.ts` | measured rates for the four unpriced models; rate lookup moves behind the registry |
| `backend/src/render/framing.ts` | `holdsLikeness` takes the model's slots as a third input |
| `backend/src/render/render-service.ts` | `model` flows from the request to `SubmitSpec`; duration validated per model; `resolution` vs `ratio` chosen by `shape` |
| `backend/src/render/runway.ts` | `SubmitSpec` becomes a union: `ratio`-shaped or `resolution`-shaped |
| `backend/src/render/studio.ts` | candidate-likeness directory (US3) |
| `backend/src/render/wardrobe.ts` | candidates are sightable and adoptable (US3) |
| `backend/src/tools/*` | `render_me` gains `model`; surface budget checked first |
| `scripts/video/probe-models.mjs` | **new** — the probe harness, so this is re-runnable |
| `docs/VIDEO.md` | the Phase 1 measurements, and the two corrections |

## The corrections Phase 1 forces on existing docs

Both are wrong in `docs/VIDEO.md` today and must land with the evidence:

1. **`hailuo3` does not take nine images.** On `/image_to_video` it takes
   `first` and `last`, same as everything else.
2. **The strict-validator assumption is per-endpoint.** `gen4_image` on
   `/text_to_image` accepts unrecognized keys silently, which turned four
   "free" probes into 32 credits of real tasks.

## Phases

### Phase 1 — Discovery ✅ COMPLETE

Done 2026-08-13, 245 credits. Results in `spec.md`. The remaining task is to
write them into `docs/VIDEO.md` and land the probe harness so they are
reproducible rather than remembered.

### Phase 2 — Foundational: the registry

`models.ts` with the measured table and the derivations, fully unit-tested with
no network. Then `credits.ts` learns the measured rates. Nothing user-visible
changes; every existing test must stay green because the default path is
untouched.

**This phase blocks everything else.**

### Phase 3 — US1: model choice, with the likeness consequence up front

`SubmitSpec` becomes a union so a `resolution`-shaped model cannot be sent a
`ratio` — a wrong shape should be a type error, not a 400. Then `render_me`
exposes `model`, and the answer she gets back names what it will do to her
likeness *before* the spend.

**Tool surface**: `render_me` gains one optional field. The budget has ~230
bytes of room and this must be measured before the schema is edited, not after.
If it does not fit, the ceiling is raised **deliberately and announced in the
team channel first** — it has collided five times.

### Phase 4 — US2: per-model duration

The 4–15 constant becomes a registry lookup. The join arithmetic stops assuming
15 so a 30s-capable model gives a 60s finished clip.

### Phase 5 — US3: `syl-ate.1`, a candidate likeness she can render

The highest-value item for her, and independent of Phases 3–4 — it touches
`text_to_image`, the studio and the wardrobe, not the video request path. Can
run in parallel with Phase 3 by a second agent.

### Phase 6 — Polish: docs, ledger, and the proof

Per-model spend in `see_myself(of: "renders")`, `docs/VIDEO.md` rewritten, and
one real anchored render through `seedance2_5` at a duration `seedance2` cannot
reach — the artefact that proves the epic.

## Parallel opportunities

- **Phase 5 is independent of Phases 3 and 4** once Phase 2 lands.
- Within Phase 2, `credits.ts` rates and `models.ts` derivations are separate
  files and separate tests.
- Phase 6's doc task can start as soon as Phase 1's numbers are in hand.

## Risks

| risk | handling |
|---|---|
| Exposing `model` produces a render of somebody else | The point of US1: derived, pre-submission, and recorded. Not preventable, and must not be — it is made *visible*. |
| Tool surface overflows | Measure before editing; announce before raising. |
| Runway withdraws a model | Registry entries carry `measuredOn`; an unknown model is a sentence, not a throw. The roster is re-checkable free via `GET /organization`. |
| The measured rates drift | Same rule as `credits.ts` today — a rate we cannot stand behind answers `null` rather than guessing. |
| Someone "simplifies" a derivation into a boolean | `syl-63v` cited at both sites; tests assert the derivation, not the value. |

## Bead Map

- `syl-023` — Root epic: She chooses her model, and can tell when one is not her
  - `syl-023.1` — Phase 1: Discovery (COMPLETE — record it)
    - `syl-023.1.1` — Write the measurements into `docs/VIDEO.md`, with the two corrections
    - `syl-023.1.2` — Land the probe harness so the measurement is reproducible
  - `syl-023.2` — Phase 2: Foundational — the model registry
    - `syl-023.2.1` — `models.ts`: the measured table
    - `syl-023.2.2` — `canAnchorLikeness` derived from keyframe slots
    - `syl-023.2.3` — `credits.ts`: measured rates for the four unpriced models
  - `syl-023.3` — Phase 3: US1 — model choice with the likeness consequence
    - `syl-023.3.1` — `SubmitSpec` as a shape union
    - `syl-023.3.2` — `holdsLikeness` takes the model's slots
    - `syl-023.3.3` — `model` flows through `render-service.ts` into the sidecar
    - `syl-023.3.4` — `render_me` exposes `model`; surface budget measured first
  - `syl-023.4` — Phase 4: US2 — per-model duration
    - `syl-023.4.1` — Duration range from the registry
    - `syl-023.4.2` — Join arithmetic stops assuming 15
  - `syl-023.5` — Phase 5: US3 — a candidate likeness she can render (`syl-ate.1`)
    - `syl-023.5.1` — `text_to_image` client with `referenceImages`
    - `syl-023.5.2` — Candidates live in the studio and are sightable
    - `syl-023.5.3` — `render_face` verb, budget measured first
  - `syl-023.6` — Phase 6: Polish
    - `syl-023.6.1` — Per-model spend in the ledger
    - `syl-023.6.2` — `docs/VIDEO.md` rewrite
    - `syl-023.6.3` — The proof render
  - `syl-023.7` — The Replicate question — **the Commander's alone, deliberately unstarted**
