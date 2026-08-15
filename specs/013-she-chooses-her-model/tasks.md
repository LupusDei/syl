# 013 — Tasks

`[P]` = parallelisable (different files, no dependency). `[US]` = user story.

## Phase 1 — Discovery (measurement COMPLETE, recording outstanding)

- [ ] T001 [docs] Write the Phase 1 measurements into `docs/VIDEO.md`: the
      `/v1/organization` roster technique, the verbatim `image_to_video` and
      `text_to_image` model lists, the per-model body tables, the measured
      credit rates, and the two **corrections** — `hailuo3` takes `first|last`
      and not nine images, and the strict-validator assumption is per-endpoint
      because `gen4_image` on `text_to_image` silently accepts unrecognized keys
      and cost 32 credits. Cite task ids and the artefacts in
      `~/.syl/model-discovery/renders/`.
- [ ] T002a [P] [setup] Create `scripts/video/probe-models.mjs` from the harness
      used in Phase 1: roster read, per-model key enumeration, ratio/duration
      enumeration, keyframe arity. Every request must carry a guaranteed-invalid
      field AND an invalid enum value on a field the model validates — the
      canary alone is not sufficient, measured.
- [ ] T002b Add `backend/tests/unit/probe-guard.test.ts`. Phases: write failing
      tests first asserting that every request body the harness builds contains
      at least one field invalid by the model's own declared schema → confirm
      RED → implement the guard the harness calls → confirm GREEN. This is the
      test that would have saved 32 credits.

## Phase 2 — Foundational: the model registry

- [ ] T010a [P] Write failing tests for the model registry in
      `backend/tests/unit/models.test.ts`. Cover: a known model returns its
      measured duration range and keyframe slots; an unknown model returns a
      clean `null`/sentence rather than throwing; the registry's ratio list for
      `seedance2_5` is exactly the twelve measured values and contains no
      `3840:*` row. Confirm RED.
- [ ] T010b Implement `backend/src/render/models.ts` — the measured table only,
      each entry carrying `measuredOn` and the evidence sentence she is shown.
      Run tests until GREEN. No capability may be stored as a hand-typed
      boolean.
- [ ] T011a [P] Write failing tests for `canAnchorLikeness` in
      `backend/tests/unit/models.test.ts`. Cover: `seedance2`/`seedance2_5`
      (has `last`) can anchor; `grok_imagine_1_5` (one slot, `first` only)
      **cannot**, at any face-on framing; the derivation reads `positions` and
      there is no boolean to flip. Confirm RED.
- [ ] T011b Implement `canAnchorLikeness` in `backend/src/render/models.ts` as a
      pure function of the registry entry's `positions`. Run tests until GREEN.
- [ ] T012 [P] Add measured credit rates to `backend/src/render/credits.ts` for
      `seedance2_5` (30 cr/s sd), `grok_imagine_1_5` (11 cr/s at 480p, ~16.25 at
      720p), `seedance2_mini` and `hailuo3` where measured. Phases: write
      failing tests first in `backend/tests/unit/credits.test.ts` asserting each
      measured rate and that an unmeasured combination still answers `null`
      rather than an estimate → confirm RED → implement → confirm GREEN. Each
      rate carries a comment naming the date and the balance delta it came from.

## Phase 3 — US1: model choice, with the likeness consequence up front

- [ ] T020a [P] [US1] Write failing tests for the `SubmitSpec` shape union in
      `backend/tests/unit/runway.test.ts`: a `resolution`-shaped model rejects a
      `ratio` field and vice versa; both serialise to the exact bodies measured
      in Phase 1. Confirm RED.
- [ ] T020b [US1] Change `SubmitSpec` in `backend/src/render/runway.ts` to a
      discriminated union on geometry shape. Run tests until GREEN.
- [ ] T021a [P] [US1] Write failing tests in
      `backend/tests/unit/framing.test.ts` for `holdsLikeness` taking the
      model's keyframe slots as a third input: `close_portrait` +
      `grok_imagine_1_5` is `false`; `close_portrait` + `seedance2_5` is `true`;
      `face_turned_away` is `true` for both because there is no face to get
      wrong. Confirm RED.
- [ ] T021b [US1] Extend `holdsLikeness` in `backend/src/render/framing.ts`.
      Run tests until GREEN. Keep it derived — `syl-63v` is cited at the site.
- [ ] T022a [P] [US1] Write failing tests in
      `backend/tests/unit/render-service.test.ts`: `render_me` with no `model`
      produces a request byte-identical to today's; with a `model` it reaches
      `SubmitSpec` and the sidecar; an unknown model answers a sentence and
      spends nothing. Confirm RED.
- [ ] T022b [US1] Thread `model` through
      `backend/src/render/render-service.ts` into the submission and the
      sidecar. Run tests until GREEN.
- [ ] T023a [P] [US1] Write a failing test asserting that a render request whose
      model cannot anchor the chosen framing returns that fact **in the record,
      before submission**, and is still allowed to proceed. Confirm RED.
- [ ] T023b [US1] Implement the pre-submission likeness warning. Run tests until
      GREEN. It must never block — `SOUL.md`.
- [ ] T024 [US1] Expose `model` on `render_me`. Phases: **measure the tool
      surface budget first** with `backend/tests/unit/tool-surface-budget.test.ts`
      and record the byte delta in the bead → if it does not fit, STOP and
      announce in the team channel before editing → write the failing schema
      test → confirm RED → implement → confirm GREEN.

## Phase 4 — US2: per-model duration

- [ ] T030 [P] [US2] Move the 4–15 duration validation to a registry lookup.
      Phases: write failing tests first in
      `backend/tests/unit/render-service.test.ts` — `seedance2_5` accepts 30 and
      refuses 31; `grok_imagine_1_5` accepts 1; `seedance2` still refuses 16;
      each refusal names the model's real range → confirm RED → implement →
      confirm GREEN.
- [ ] T031 [US2] Stop the join arithmetic assuming 15 so a 30s-capable model
      yields up to 60s finished. Phases: write failing tests first in
      `backend/tests/unit/join.test.ts` covering the half-split at 30s and the
      unchanged split at 15s → confirm RED → implement → confirm GREEN.

## Phase 5 — US3: a candidate likeness she can render (`syl-ate.1`)

- [ ] T040a [P] [US3] Write failing tests for a `text_to_image` client in
      `backend/tests/unit/text-to-image.test.ts`, against fixtures captured from
      the real endpoint. Cover: `referenceImages` is sent; a failure is a
      sentence not a throw; the response's image is written to a new path and
      never over an existing one. Confirm RED.
- [ ] T040b [US3] Implement the `text_to_image` call in
      `backend/src/render/runway.ts`. Run tests until GREEN. Prefer
      `seedream5_pro` or `grok_imagine_image_2` over `gen4_image` — the first
      two validate strictly, `gen4_image` does not.
- [ ] T041a [P] [US3] Write failing tests in
      `backend/tests/unit/wardrobe.test.ts`: a generated candidate is sightable
      via `see_myself`, carries a `sighting` computed from its own bytes, and
      `this_is_me` adopts it unchanged. Confirm RED.
- [ ] T041b [US3] Implement candidate storage in
      `backend/src/render/studio.ts` and `wardrobe.ts`. Run tests until GREEN.
      `COPYFILE_EXCL`, new files only, nothing overwritten.
- [ ] T042 [US3] Expose the candidate-render verb. Phases: **measure the tool
      surface budget first** and record the delta → announce if the ceiling must
      rise → write the failing schema test → confirm RED → implement → confirm
      GREEN. Prefer widening an existing verb over adding one.

## Phase 6 — Polish

- [ ] T050 [P] Per-model spend in `see_myself(of: "renders")`. Phases: write
      failing tests first in `backend/tests/unit/render-service.test.ts`
      asserting the ledger groups by model and reports unpriced renders as
      unknown rather than zero → confirm RED → implement → confirm GREEN.
- [ ] T051 [docs] Rewrite `docs/VIDEO.md`'s "Models" section around the
      registry, and record which model made the proof render.
- [ ] T052 The proof: one real anchored render through `seedance2_5` at a
      duration `seedance2` cannot reach, in a studio of its own, with frames
      pulled and the likeness confirmed by eye. Record credits spent and the
      task id. **Never touch her live wardrobe or renders.**

## Deliberately unstarted

- [ ] T060 The Replicate question. `bytedance/seedance-2.5` may expose the
      reference-image mechanism Runway's wrapper hides, which would collapse the
      anchored join into one clip. It is a **metered rail, a new credential and
      the Commander's decision alone**. This task stays OPEN and unclaimed until
      he rules. It is an improvement, not a repair.
