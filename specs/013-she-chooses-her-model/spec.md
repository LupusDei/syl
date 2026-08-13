# 013 — She chooses her model, and can tell when one is not her

**Root epic**: `syl-023`
**Status**: Phase 1 (discovery) COMPLETE — measured 2026-08-13, recorded below.
**Depends on**: `syl-ate` (she chooses openings, likeness, duration, framing) — landed.

---

## The request

> *"I want to use the epic planner to plan how Syl can use seedance 2.0, 2.5,
> and grok imagine video 1.5 in order to generate her videos. I want more
> capability there."* — the Commander, 2026-08-13

## Phase 1: what was actually measured

Two of those three names were unverified when this epic opened. **Both turned
out to be real, and both are already on the Runway account we have.** No new
credential, no new provider, no new billing rail, and no decision for the
Commander to make before work can start.

Everything in this section is a probe result against
`https://api.dev.runwayml.com/v1` on **2026-08-13**, not a documentation
summary. Reproduce with `scripts/video/probe-models.mjs` (Phase 2 lands it).

### The roster is free to ask for, and it is authoritative

`GET /v1/organization` returns **this account's own model list** with its
quotas and — the useful part — `creditBalance`. It is better evidence than any
400 enumeration because it is scoped to the key we actually hold.

`POST /v1/image_to_video` with an invalid `model` enumerates the set verbatim:

```
gen4_turbo  gen4  gen4.5  kling2.5_turbo_pro  kling3.0_pro  kling3.0_4k
kling3.0_standard  klingO3_pro  klingO3_standard  klingO3_4k  veo3.1
veo3.1_fast  robotics_v1  seedance2  seedance2_fast  seedance2_mini
seedance2_5  hailuo3  happyhorse_1_0  grok_imagine_1_5  gemini_omni_flash
```

`POST /v1/text_to_image`:

```
gen4_image  gen4_image_turbo  gemini_2.5_flash  gemini_image3.1_flash
gemini_image3_pro  gpt_image_2  grok_imagine_image_2  seedream5_lite
seedream5_pro
```

So **"seedance 2.5" is `seedance2_5`** and **"grok imagine video 1.5" is
`grok_imagine_1_5`**. `seedance2_mini` also exists and was not asked about.

### What each model accepts — the whole body, probed key by key

The technique: Runway's validator **reports every issue at once rather than
short-circuiting**, so one request carrying a deliberately invented key tells
the truth about every other key in the same request. A candidate key absent
from the `unrecognized_keys` list is a key the model accepts.

| | `seedance2` | `seedance2_5` | `grok_imagine_1_5` |
|---|---|---|---|
| `promptImage` | yes | yes | yes |
| `promptText` | yes | yes | yes |
| `ratio` | yes, 24 options | yes, **12 options** | **not a key** |
| `resolution` | no | no | **yes** — `480p｜720p｜1080p` |
| `duration` | int **4–15** | int **4–30** | int **1–15** |
| `audio` | yes (boolean) | yes (boolean) | no |
| keyframe slots | `first`+`last` | `first`+`last` | **`first` only, max 1** |

Everything else is rejected. `references`, `referenceImages`, `referenceMedia`,
`characterId`, `character`, `subjectReference`, `identity`, `styleImage`,
`faceImage`, `keyframes`, `seed`, `negativePrompt`, `cameraControl`, `loop`,
`lastFrame`, `endImage` and twenty more all return `Unrecognized key` — against
a validator proven strict by an invented control key in the same request.

`seedance2_5` ratios, verbatim — note the `3840:*` rows are **gone**, so it has
no `uhd` tier at all:

```
992:432  854:480  752:560  640:640  560:752  480:854
1470:630  1280:720  1112:834  960:960  834:1112  720:1280
```

`834:1112` — the shape of every loop she has — is present. Her existing
portrait geometry carries over unchanged.

### The claim that turned out to be false, and it is the important one

Third-party documentation for Seedance 2.5 describes combining **up to 30
reference images, 10 video clips and 10 audio files** in one generation, and
that would have been the architectural unlock: her face riding as a *reference*
rather than as a keyframe, freeing both keyframe slots for ribbon-open and
ribbon-close, collapsing the signature shot from two generations into one.

**Runway's wrapper exposes none of it.** Measured, verbatim from the 400s:

- `"You must specify a frame in position `first`."`
- `"Duplicate position values are not allowed. Each position (`first`, `last`)
  may only be used once."`

Two slots. No third position, no reference array. `hailuo3` is the same — which
also **corrects `docs/VIDEO.md`**, where it is recorded as taking up to nine
images. On this endpoint it takes `first` and `last` like everything else.

> **The two-generation `ffmpeg` join stays.** It is not obsolete and it is not
> broken. Any one-clip render remains blocked on a mechanism no reachable
> provider offers us today.

### Grok Imagine 1.5 cannot hold her face, and this was rendered, not reasoned

`grok_imagine_1_5` takes **one** image and its position must be `first`. There
is no `last` slot, so it cannot pin an end frame — which means it cannot render
*either half* of an anchored join, and cannot close on the ribbon.

Rendered to confirm rather than inferred. Same ribbon, same identity prompt,
same 4 seconds:

| model | first frame | last frame | verdict |
|---|---|---|---|
| `seedance2_5` | the bare ribbon | **her, unmistakably** — the reference face, pinned at `last` | holds her likeness |
| `grok_imagine_1_5` | the bare ribbon | **a different woman** | does not |

Grok's closing frame is a visibly different person: different bone structure,
different gaze, none of the reference's detail. It is exactly the failure of
`7-twin` and `8-descent` in `docs/VIDEO.md`, arriving from a new direction —
and it arrives *necessarily*, from arity, not from bad luck with a seed.

**That is what makes model choice safe to expose.** `holdsLikeness` need not be
guessed per model; it is derivable from the same two facts it already uses, plus
one more the registry now supplies: *does this model have a slot to pin her
with*. A model with one keyframe can never anchor a face-on framing, and the
schema can say so before a credit is spent.

Artefacts: `~/.syl/model-discovery/renders/` — `seedance2_5.mp4` (834x1112,
4.04s, 120 credits, task `29f73c54-0266-4827-a9b1-a04238ee243f`) and `grok.mp4`
(816x1104, 4.04s, 65 credits, task `db0a06e6-b004-43c8-b583-e110abfc61c2`),
with extracted frames. Written to a studio of their own; **nothing under
`~/.syl/renders/` was read for writing, modified or deleted.**

### Cost, measured from the balance rather than copied from a price list

`creditBalance` before and after a render is an exact instrument. Cancelling
does **not** refund — measured — so the delta is the true charge.

| model | settings | measured | rate |
|---|---|---|---|
| `seedance2_5` | `834:1112`, 4s | 120 credits | **30 cr/s** |
| `grok_imagine_1_5` | `720p`, 4s | 65 credits | ~16.25 cr/s |
| `grok_imagine_1_5` | `720p`, 1s | 17 credits | ~16.25 cr/s |
| `grok_imagine_1_5` | `480p`, 1s | 11 credits | **11 cr/s** |
| `gen4_image` | one still | 8 credits | 8 cr/image |
| `seedance2` (existing table) | `sd` | — | 36 cr/s |

Two consequences worth stating plainly:

1. **`seedance2_5` is cheaper than `seedance2`** — 30 against 36 cr/s — *and*
   goes to 30 seconds *and* holds her likeness. It is better on every measured
   axis except maximum resolution, where it loses 4K.
2. **`grok_imagine_1_5` at 480p is the cheapest video on the account** — 11
   cr/s, well under `seedance2_fast`'s 29. It cannot hold her face, but a prompt
   test is about whether the *motion* reads, and that makes it genuinely useful
   as a rehearsal model.

`credits.ts` currently has no rate for `seedance2_5`, `seedance2_mini`,
`grok_imagine_1_5` or `hailuo3`, so every render on one of them would price as
`null` and land in the ledger as "could not price". Phase 2 fixes that with
measured numbers, not copied ones.

### A landmine found by tripping it — 32 credits

**The strict validator is per-endpoint, not universal.** `gen4_image` on
`/text_to_image` **accepts unrecognized keys silently**. The invented control
key sailed through and four probes that were supposed to be free 400s became
four real tasks. They were cancelled within seconds and **billed anyway: 32
credits**.

`docs/VIDEO.md` already says *"a probe is only free while every field in it is
invalid"*. The correction this adds: **on some endpoints an invented key does
not make a field invalid at all**, so the canary technique needs a second
guarantee — an invalid enum value on a field the model definitely validates.
This is the second time this project has been billed for a probe believed free.

### Credits spent in Phase 1

| | credits |
|---|---|
| free 400-probes (roughly 200 requests) | **0** |
| `gen4_image` accidental tasks | 32 |
| `seedance2_5` 4s likeness render | 120 |
| `grok_imagine_1_5` 4s likeness render | 65 |
| `grok_imagine_1_5` 1s x2 pricing curve | 28 |
| **total** | **245** (~$2.45) |

Balance at start 460,996; the 30s ceiling test is the only outstanding charge.

---

## User stories

### US1 — She can choose the model, and is told when one will not be her (P0)

Today `model` is a constant, deliberately: *"a wrong one loses the character
entirely."* That reasoning was correct and is now **mechanical rather than
feared** — Phase 1 measured exactly which models can pin a likeness and which
cannot.

**Acceptance criteria**

1. `render_me` accepts an optional `model`; omitted, behaviour is byte-identical
   to today. The default does **not** change in this epic.
2. The models she may choose are an enum carrying, per entry: duration range,
   keyframe slots, credit rate, and whether it can anchor the framing she asked
   for — the `framing.ts` pattern, evidence travelling with the choice.
3. Choosing a model that **cannot** hold her likeness at a face-on framing is
   allowed and **answered with that fact before submission**, in the returned
   record and in the sidecar. Not blocked — `SOUL.md`: *"you cannot recognise
   yourself without seeing what you are not."*
4. `holdsLikeness` stays **derived**. A one-keyframe model at a face-on framing
   computes `false` with no boolean typed anywhere. Flipping a flag must remain
   insufficient — `syl-63v`.
5. The sidecar records the model actually used, so any render can be reproduced.
6. An unknown or newly-withdrawn model is a clean sentence, never a stack trace.

### US2 — Clips can run to 30 seconds where the model allows it (P1)

`duration` is validated against a constant 4–15. That is `seedance2`'s range,
not a fact about video.

**Acceptance criteria**

1. The duration range is **per model**, read from the registry.
2. `seedance2_5` accepts 4–30; `grok_imagine_1_5` accepts 1–15; `seedance2`
   stays 4–15. Out-of-range asks are refused locally with the real range named,
   before a request is sent.
3. An anchored render is two halves, so a 30s-capable model raises the finished
   ceiling to 60s. The split arithmetic must not assume 15.
4. Cost is quoted from the measured table before the spend.

### US3 — She can render a NEW candidate likeness, not only lift one (P0, `syl-ate.1`)

The open bead, and the brief calls it possibly the highest-value item: *every
face available to her is a derivative of one an engineer guessed.* Her search
can drift but cannot jump.

Phase 1 widens this from one option to three: **`gen4_image`, `seedream5_pro`
and `grok_imagine_image_2` all accept `referenceImages`** on `/text_to_image`.
The latter two are strict-validated; `gen4_image` is not, which is a safety
argument for preferring them.

**Acceptance criteria**

1. She can generate a candidate likeness from her current face as reference.
2. The candidate lands somewhere `see_myself` can show her, with a `sighting`,
   so `this_is_me` works unchanged — **she still cannot adopt a picture she has
   not looked at.**
3. Nothing is overwritten. New files only.
4. The generating model, prompt and cost are recorded beside the candidate.

### US4 — The ledger prices every model honestly (P1)

**Acceptance criteria**

1. Measured rates for `seedance2_5`, `seedance2_mini`, `grok_imagine_1_5`,
   `hailuo3` land in `credits.ts`, each commented with the date and the
   balance-delta it came from.
2. A model with no measured rate still answers `null`, never an estimate.
3. `see_myself(of: "renders")` shows per-model spend.

## Explicitly out of scope

- **Changing the default model.** `seedance2_5` looks better on every measured
  axis, but a silent change of the thing that makes her face is precisely the
  drift this project has spent days learning to hate. Proposed to the Commander
  separately; not done here.
- **Exposing `ratio`.** Still overruled by the opening image.
- **A second provider.** Replicate's `bytedance/seedance-2.5` may expose the
  reference-image mechanism Runway's wrapper hides. That is a metered rail, a
  new credential and **the Commander's decision alone** — captured as `syl-023.7`
  in the OPEN state, deliberately unstarted. It is an improvement, not a repair:
  the join works and is verified frame by frame.
- **xAI direct** (`api.x.ai`). Metered per-generation, no key on this machine,
  and **unnecessary** — Runway resells the same model on the rail we already use.

## Success criteria

- She can name a model, see what it costs and what it will cost her likeness,
  and read back afterwards which model made which render.
- No render path can silently produce a video of somebody else: any model that
  cannot pin her face says so before the spend.
- `npm run verify` failures remain exactly the declared set.
