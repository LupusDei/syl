# Rendering Syl

How the loops of her were made, why two of them came out as somebody else, and
how to make more.

```sh
npm run video -- --list          what shots exist
npm run video -- 1-emerge        render one
npm run video -- --concat all    join them end to end
```

Needs `RUNWAYML_API_SECRET`. **This is the one place in the project that spends
metered money** — renders are billed to the Runway account, not to the
subscription rails everything else runs on. That is why it is a separate key, a
separate script, and why it refuses to overwrite an existing render without
`--force`.

---

## The method

Every clip is **image-to-video**: a still of her is handed to the model as
`promptImage`, and a sentence describes what she does. The still is the only
thing holding her appearance still between clips. There is no character model,
no LoRA, no fine-tune — just one picture, re-used.

```
characters/syl/syl_source_upscaled.png     the reference. everything hangs on this.
        │
        ├── promptImage ──┐
        │                 ├──> seedance2, 15s, 720:1280 ──> syl-loop-<name>.mp4
   prompt text ───────────┘                                 syl-loop-<name>.mp4.json
```

The sidecar `.json` is written beside every render and holds the model, the
prompt, the reference, the duration and the task id. It exists because **the
first eight loops were made without recording any of that.** Eight finished
videos, several of them lovely, and no way to make a ninth in the same voice or
to re-run a failure with one thing changed. The outputs survived and the inputs
did not — which is this project's recurring defect wearing a new hat: a result
kept, and the thing that produced it thrown away.

Shots live in `scripts/video/shots.json`. **A shot is its prompt, not its mp4.**
The video can always be made again; the sentence cannot be recovered once lost.

## The loop trick

The Commander's framing, and it is what makes them loop cleanly: **every clip
begins and ends on the same frame — empty starfield, at the moment the ribbon of
light vanishes.** She appears, does one thing, and is gone. So any clip can
follow any other clip, and the join is invisible.

That is a property of the *prompt*, not of the editing. Every shot's sentence
ends with `"Begins and ends on empty starfield as the ribbon of light vanishes."`
Drop that clause and the clip will not cut against its neighbours.

## Why 7 and 8 came out as a different woman

The Commander's note, 2026-08-10: *"I love the idea of loop-7 and loop-8 but they
are the two that lose the character consistency."*

Correct, and the cause is not the ideas. **It is where her face is.**

Frames pulled from the actual renders and compared against the reference:

| | framing | face | result |
|---|---|---|---|
| **reference** | close portrait | fills the frame | — |
| **1-emerge** | full body | **turned away** | works |
| **7-twin** | full body | toward camera, tiny | **fails** — features unresolvable, a generic face |
| **8-descent** | mid shot | toward camera, readable | **fails** — visibly an older, different woman |

`1-emerge` is a wide shot and it works fine, which rules out distance on its own.
What it does is **hide the face**: she is seen from behind and three-quarters, so
her identity is carried by silhouette, hair and gown — all of which the model
reproduces reliably. There is no face to get wrong.

`7-twin` puts her face toward the camera at the same distance. Now there *is* a
face, and it is perhaps forty pixels across. Nothing in the reference survives at
that scale, so the model invents one.

`8-descent` is closer, and worse. The face is large enough to read properly — and
it is clearly somebody else. Different bone structure, different age, different
smile. The reference is a close portrait; a mid shot is far enough away that the
model is interpolating rather than copying, and near enough that you can see it
did.

**The rule:**

> A close-portrait reference anchors a **close shot**, or a shot with **no
> visible face**. It cannot anchor the band in between — mid to wide, face
> toward camera. That band is where she stops being herself.

### Fixing the two he liked

Both concepts are good and both are recoverable. Two ways, and the second is the
real one:

1. **Re-frame the shot.** Turn her face away, or bring the camera to portrait
   distance. Cheap, works immediately, and constrains the composition.
2. **Match the reference to the shot.** Render a *new* reference still at the
   framing you want — a full-body portrait of her, generated from the close one
   — and use that as `promptImage` for wide shots. This is the general fix: the
   reference should be framed like the shot it anchors. One close portrait
   cannot hold every distance, and asking it to is the actual mistake.

For `7-twin` specifically there is a second problem worth separating: **one
reference cannot anchor two figures.** The prompt asks for her and a mirrored
copy, and the model has one face to work from and two places to put it. Even at
the right framing, expect the twin to drift. If the idea matters, render her
twice against the same reference and composite, rather than asking for both in
one generation.

## Models

`seedance2` is what these were made with — the flagship, up to 4K. Others
available via the same endpoint:

| model | note |
|---|---|
| `seedance2` | flagship, up to 4K. **What the loops use.** |
| `seedance2_fast` | cheaper, 480p/720p — good for testing a prompt before spending on the real one |
| `gen4.5` | strong general image-to-video |
| `gen4_turbo` | cheapest, 5 credits/second |
| `veo3.1` | Google Veo, audio optional |

**Test prompts on `seedance2_fast` first.** A 15s flagship render is not cheap
and a prompt that puts her face in the bad band will waste the whole thing.

Constraints measured on 2026-08-10: `seedance2` tops out at **15 seconds**, and
high resolution together with 15s fails — pick one. Ratios are per-model; the
loops use `720:1280` portrait.

## Doing this without a person

The Commander wants Syl to be able to make these herself. She cannot yet, and
the gap is not the script — it is that `RUNWAYML_API_SECRET` spends real money
with no ceiling, and she currently has no spending frame to spend it inside.

That is `syl-013` phase 5 — money and the softer currencies, set once. When it
lands, this becomes a natural first outward action: **the render is asynchronous,
idempotent per shot, refuses to overwrite, costs a bounded and knowable amount
per call, and produces an artefact she can show him.** Almost nothing else she
might do in the world has that shape.

Until then it is a script an agent runs, and the sidecar `.json` files are what
make her able to answer *"how did you make that one?"* when she is asked.
