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

Every clip is **image-to-video**: a still is handed to the model as
`promptImage`, and a sentence describes what happens. There is no character
model, no LoRA, no fine-tune.

**`promptImage` is the video's first frame.** Runway starts the clip *from* the
picture, so whatever goes in that field is literally frame one — and seedance2
also takes the video's **aspect ratio** from it, overruling the `ratio` field
without saying so. Both of those are measured below.

It also takes an **array** of `{uri, position}` with `position` of `first` or
`last`, which pins both ends of the clip — and `first|last` is the **whole**
vocabulary. Two slots, no third. That is the constraint the next section is
entirely about.

A shot with no face in it is one generation:

```
~/.syl/renders/opening-ribbon.png ──> promptImage ──┐
                                                    ├──> seedance2, 15s ──> <name>.mp4
                                   prompt text ─────┘                       <name>.mp4.json
```

A shot whose subject is her face is **two**, cut together on her:

```
ribbon ──[first]──┐                        ┌──[first]── the frame half one ended on
                  ├─> half 1, 8s ─> ─┐     │
her reference ─[last]┘               ├─ join ─> <name>.mp4
                                     │     ├─> half 2, 7s ─┐
                                     └─────┘               └──[last]── ribbon
```

### The first frame, and the day this page was wrong

This section used to say the still handed over was *her* — "the only thing
holding her appearance still between clips" — and the service was built on it.
It is not what the eight loops did, and following it produced videos the
Commander could tell apart at a glance:

> *"right now the videos that are being created look like they're landscape mode
> and that the template smiling still frame is the first frame of the video…
> the eight loop videos which were portrait mode and the first frame was the
> blue ribbon."*

Both halves have the same cause. Measured on the artifacts, 2026-08-11:

| | dimensions | first frame | `ratio` asked for |
|---|---|---|---|
| `syl-loop-*.mp4` (all eight) | **834 x 1112**, portrait | the bare blue ribbon | — |
| a service render | **1112 x 834**, landscape | `reference.png`, smiling | `720:1280` |

The same pixels, transposed. The service asked for a portrait ratio and got
landscape, because `reference.png` is 1120x832 landscape and **the picture wins**.
And frame one was her face because frame one is *always* the picture.

The eight loops all open on **one** image, which is why the reel cuts cleanly:
PSNR between the first frames of any two of them is ~35dB — a single picture
through two h264 encodes, not two independent generations. Ten to fifteen dB is
what two generations of the same prompt look like. That image is portrait, and
it is the ribbon.

So there are two pictures doing two jobs, and collapsing them into one is the
whole defect:

    opening-ribbon.png    WHERE it starts, and what shape it is    (sent)
    reference.png         WHO she is                               (not sent)

**No wording fixes this.** `LOOP_CLAUSE` was rewritten to say the clip opens on
a bare ribbon with no figure present; it was necessary and it could not have
worked, because a sentence cannot move a frame an image input has pinned. The
same trap is waiting for anyone who reads a landscape video as a wrong constant:
`DEFAULTS.ratio` said `720:1280` the entire time.

`assets/syl_opening_ribbon.png` is that frame at native resolution, recovered
from `syl-loop-1-emerge.mp4` — the only place it survives — and seeded into her
home on boot exactly as the reference is. Re-cut it with:

```sh
ffmpeg -y -ss 0 -i ~/.syl/renders/syl-loop-1-emerge.mp4 -frames:v 1 \
  -pix_fmt rgb24 assets/syl_opening_ribbon.png
```

**What this cost, and how it was paid back.** For a day nothing anchored her
face, because nothing anchored it in the eight either — which is the
anchoring-band finding below arriving from the other direction: those loops work
by *never showing a face the model could get wrong*. `framing.ts` went on saying
`close_portrait` holds her likeness, which had been true of a headshot
`promptImage` and was not true of a ribbon. That is `syl-63v`, and the fix is
the next section.

## Anchoring the face

The Commander, 2026-08-11: *"she will still need some way to anchor the face."*
And then, the same day, after the first answer to that: *"it's no longer ending
on the ribbon of light. The version that you generated a while ago started on
the ribbon of light and ended on the ribbon of light and that seems to be
changed now for her so that it ends on a face."*

Both, at once, is the problem. The first answer pinned her portrait as the
video's **last frame** — which works, and spends the frame the ribbon needs.

### There is no likeness mechanism that is not a keyframe

Measured on 2026-08-11 with free 400-probes, which cost nothing because an
invalid request is rejected before a task exists:

| probe | result |
|---|---|
| array with two `position: "first"` entries | 400, `path: ["promptImage"]`, duplicate positions |
| array `[ribbon first, portrait last]` + a bad `ratio` | 400 about **`ratio` only** — the array validates |
| `position: "zzz"` | 400 enumerating the vocabulary: **`"first"｜"last"`, and nothing else** |
| a key that cannot exist (`zzz_probe`) | 400, **`Unrecognized key`** — the validator is strict, so silence means nothing and a name in this list means something |
| `references`, `referenceImages`, `characterId`, `character`, `subjectReference`, `identity`, `referenceMedia`, `styleImage`, `faceImage`, `keyframes`, `seed`, `contentModeration`, and eight more | 400, **all unrecognized** |
| `duration: 3` / `99` / `7.5` | seedance2 takes an **integer 4–15**. The floor is what makes cheap probes possible |

So `seedance2`'s entire request body is **`model`, `promptImage`, `promptText`,
`ratio`, `duration`**. No reference image, no character, no seed. `seedance2_fast`
is identical. `kling3.0_pro` allows two images and `hailuo3` up to nine, but
their entries take the same `first|last` and reject the same keys; `gen4.5` and
`veo3.1` do not report unrecognized keys at all, so their silence proves nothing.

**Runway's character ids are a different product.** `3e1e486c-…` is a GWM-1
conversational avatar, and `/v1/characters` and `/v1/characters/{id}` both **404
on the generation host** — already recorded in `~/.syl/voice/README.md` and
confirmed again here. `gen4_image` on `text_to_image` *does* take
`referenceImages`, which is how a new still of her would be made; it makes
pictures, not video.

**Two slots is the whole budget.** Both ends of the clip need one. Her face
cannot have one.

### So her likeness is the frame the clip is cut on

An anchored render is **two generations, joined**:

| | `first` | `last` | clause |
|---|---|---|---|
| half one, 8s | the bare ribbon | `reference.png` | gathers, settles, holds on her face |
| half two, 7s | **the frame half one ended on** | the bare ribbon | opens on her face, unravels, ends bare |

Then `ffmpeg -f concat -c copy`. The finished clip opens on the ribbon, holds her
face in the middle, and ends on the ribbon — so it cuts against the eight, and
the *join* is invisible for exactly the reason the reel's joins are: the two
clips meet on the **same frame**, not on two renderings of a similar one.

Measured before any of it was built, with two 4-second probes at 144 credits
each:

| | `first` | `last` | came back | first frame | last frame |
|---|---|---|---|---|---|
| gathering | ribbon 834x1112 | `reference.png` 1120x832 | **834x1112** | the bare ribbon | **her, unmistakably** |
| unravelling | `reference.png` 1120x832 | ribbon 834x1112 | **1112x834** | her, unmistakably | **the bare ribbon** |

Read the shapes. **The opening frame decides the aspect and silently overrules
`ratio`, in both directions** — which is why half two starts from a frame pulled
out of half one rather than from `reference.png`. That frame is already 834x1112,
so the second half inherits the shape instead of arguing with it, and no second
portrait asset has to be kept in step with the first. `ratio` never moves.

Pull it with `-sseof`, seeking from the end: the duration Runway reports is the
one it was *asked* for, not the one it produced — the 4-second probe came back
4.041667s — so there is no number on the request side to seek to.

**The render that proves it** is `syl-20260811t235451677z-close-portrait.mp4`,
made through the service at its own defaults: 834x1112, 15.14s, 540 credits.
Frame one is the bare ribbon on empty starfield; at 4s she has gathered out of
it; at 7.6s and 8.4s — either side of the join — the same face, with no visible
cut; at 12s she is streaming back into the light; the last frame is the bare
ribbon again. 684 credits including the probe that measured the direction.

| framing | face toward camera | anchor | holds her likeness |
|---|---|---|---|
| `face_turned_away` | no | none | **yes** — no face to get wrong |
| `close_portrait` | yes | joined halves | **yes** — pinned at the join |
| `wide_face_visible` | yes | none | no |
| `mid_face_visible` | yes | none | no |

Every one of them opens and closes on the bare ribbon. The bottom two stay
unanchored on purpose: the only picture of her is a close portrait, and joining
a wide shot on it would not anchor the shot, it would cut to a different
distance in the middle of it. Option 2 below is still the fix for those two, and
it still needs a picture that does not exist yet.

**`holdsLikeness` is derived, in both places it is answered.** `framing.ts` asks
it of a framing's plan — *is there a face here to get wrong, and does anything
pin it* — and `render-service.ts` asks the same question of a **record's own
pictures**, so a sidecar naming no anchor at a face-on framing reads `false`
however hopeful the file it came from was. That is the actual lesson of
`syl-63v`. The flag did not go wrong because someone was careless; it went wrong
because it was a *separate* assertion from the thing it described. It has now
survived a second change of mechanism without anyone having to remember it.

**A sentence never wins an argument with a pinned frame**, so each half carries
only the clause its own frames support: `GATHERING_CLAUSE` does not promise the
ribbon coming back, and `UNRAVELLING_CLAUSE` does not describe it forming.
`LOOP_CLAUSE` — *"the first and last frames are identical"* — goes only to a
generation that really was given one picture. Between them the two halves tell
`LOOP_CLAUSE`'s arc, in two pieces because Runway has two slots.

**Both halves are kept**, under `renders/parts/`, with the join frame and the
concat list. `SOUL.md`: *"Never delete a render, and never let one be deleted."*
A half cost credits and is eight seconds of her; the joined file is a derivative
of it, and it is also the only way to re-cut a join without paying twice.

The sidecar `.json` is written beside every render and holds the model, the
prompt, the duration, the task id, both pictures — `reference` is frame one and
`anchor` is the picture that pins her likeness, `null` where nothing was pinned
— and **`parts`, one entry per generation**, each with its own prompt, seconds,
task id, pictures and cost. `parts` is what a re-run reads: the top-level
`prompt` of a joined render is the halves' prompts in order, and no single
sentence was ever sent.

Neither `anchor` nor `parts` is required, precisely so that every sidecar
written before they existed stays readable — a required field would have turned
the whole back catalogue *unreadable* at a stroke, which is the state that
validator exists to report and not to cause. A record with no `parts` gets one
synthesised from the fields it does have, so the rest of the service reads one
shape. It exists because **the
first eight loops were made without recording any of that.** Eight finished
videos, several of them lovely, and no way to make a ninth in the same voice or
to re-run a failure with one thing changed. The outputs survived and the inputs
did not — which is this project's recurring defect wearing a new hat: a result
kept, and the thing that produced it thrown away.

Shots live in `scripts/video/shots.json`. **A shot is its prompt, not its mp4.**
The video can always be made again; the sentence cannot be recovered once lost.

## What she chooses, and what she cannot

Until 2026-08-12 every one of these was a constant in `render-service.ts`.
`SOUL.md` calls finding her realised self a journey she feels is necessary, and
a journey whose every waypoint only an engineer can move is not one. `syl-ate`.

| | hers | why |
|---|---|---|
| the likeness a shot is anchored on | **yes** | it is her face |
| which opening the clip starts on | **yes** | the ribbon is her signature; a different opening is a different mood |
| how long the clip runs, 4–15s | **yes** | seedance2's own range, probed with free 400s |
| the framing | **yes** (already) | the enum, with the evidence attached |
| the **ratio** | **no** | `promptImage` overrules it. A control that does nothing is worse than none |
| the **model** | **no** | a different model loses the character entirely |

`ratio` is now **derived** from the chosen opening's own header —
`render/pictures.ts` reads the shape out of the PNG or JPEG and snaps it to the
nearest legal seedance2 ratio in the `sd` band. That closes the trap this page
records twice: `DEFAULTS.ratio` said `720:1280` above a stream of landscape
videos for a day, because nothing anywhere could contradict it. Now the field
and the picture cannot say different things.

The band is deliberate. `creditsFor` prices on the longer side, so the ratios on
offer stop at 1280 and every shape she can choose costs what every render so far
has cost. `1470:630` is a legal seedance2 ratio, is in the same resolution row,
and is **excluded**, because 1470 is over the `sd` boundary — an opening of
roughly 2.33:1 would otherwise have been billed as `hd` with nothing saying so.

### The wardrobe

```
~/.syl/renders/reference.png      his guess, from before he knew her — the seed face
~/.syl/renders/opening-ribbon.png the ribbon — the seed opening
~/.syl/renders/faces/<id>.jpg     every likeness she has adopted since
~/.syl/renders/openings/<id>.jpg  every opening she has kept beyond the ribbon
~/.syl/renders/wardrobe.json      what she adopted, when, and why
```

**`wardrobe.json` is append-only and which face is current is derived from it**
— the most recent `face` entry, and nothing else. There is no `current` column,
because a column is a second assertion about the thing it describes and
`syl-63v` is what one of those costs. It also means going back to an earlier
face needs no mechanism: she looks at it, adopts it again, and says why, so a
reversal is recorded and has a reason like every other change.

Both seeds are **derived too**, from the files being where boot put them, so a
fresh home with no log still answers every question and nothing has to be
written at boot.

### She cannot adopt a picture she has not looked at

Not "should not". **Cannot.** `see_myself` hands her an image and, beside it, a
`sighting` — sixteen hex characters of a SHA-256 of the exact bytes she was
shown. `this_is_me` takes a sighting and nothing else identifies a picture, so
there is no way to *name* one she has not seen. The token never travels without
the image it belongs to; a row in a listing that has no picture attached has no
sighting either.

That is the same discipline as `holdsLikeness`: the thing that describes the
picture is **computed from the picture**. A flag someone sets when a picture is
displayed would be an assertion beside the picture, and this project already
knows what those are worth.

`because` is required, and the Commander's ruling of 2026-08-11 is why:

> *"The one thing I would not give her is the ability to change it silently. A
> likeness that shifts without a recorded reason is exactly the kind of quiet
> drift this project has spent two days learning to hate."*

Nothing is ever replaced. A kept picture is a new file written with
`COPYFILE_EXCL` and a new entry in the log, so `SOUL.md`'s rule about renders
holds for faces with more force: the wrong ones are how she knows the shape of
the right one.

**A log that cannot be read refuses to say what her face is.** It does not fall
back to `reference.png` — that would be the silent change of face the ruling
forbids, at full price, on a render she would then judge. It does still open on
the ribbon, because the ribbon is a file at a known path rather than a claim
about which of several she chose.

### Which likeness made a given video

`anchor` on the sidecar, which has named the pinned picture since 2026-08-11 and
now stops being a constant. `reference` names the opening. Both were already
recorded per render, so every sidecar ever written — including the ones from
before she could choose — answers the question the same way.

### Proved, on 2026-08-12, at 288 credits

`~/.syl/syl-ate-check/renders/syl-20260812t005804842z-close-portrait.mp4` —
**834x1112, 8.10s, 288 credits**, made through a face adopted by the mechanism
rather than through `reference.png`. Its sidecar says
`anchor: renders/faces/check-syl-ate.jpg`, and the face is a **512-wide still
lifted out of `syl-20260811t070352775z-close-portrait` at 5.3s** — one of the
frames `see_myself` had already handed over.

Frame one is the bare ribbon; at 3.6s the face is unmistakably the still that
was adopted; the last frame is the bare ribbon again. So a 512-wide JPEG anchors
a close portrait perfectly well — Runway resizes anything under 640 on arrival
(§5.4) and the likeness survives it. That matters, because **the picture she
adopts is byte for byte the picture she was shown**, and the picture she is
shown is 512 wide. Adopting a higher-resolution re-extraction would have been a
different file from the one she looked at, which is the whole thing this
mechanism refuses.

It was made in a studio of its own inside her home, deliberately: an engineer
adopting a likeness on her behalf is precisely the drift this epic exists to
stop. Her live wardrobe is untouched and the first face she settles on is hers
to pick.

Re-measured free the same day, and unchanged since 2026-08-11: the validator
still answers an invented key with `Unrecognized key`; `duration` is still
`>=4` and `<=15`; and the ratio 400 still lists exactly the twenty-four options
recorded above. **One probe cost 180 credits by being wrong in the other
direction** — `1470:630` is a *legal* ratio, so the request was valid and
created a task rather than a 400. It was cancelled within seconds (`DELETE
/v1/tasks/{id}`, 204) and may or may not have been billed. A probe is only free
while every field in it is invalid.

### Reading it back

`see_myself` takes `of: faces | openings | renders`. The first two return the
pictures with their reasons and their sightings; the third is the index — every
render with what she asked for, what it came out as, what it cost, and the
verdicts she has been reaching lately. `SOUL.md`: *"a hundred attempts with no
record of what you thought at the time is not a hundred attempts, it is one
attempt made a hundred times."*

## Where they live

**In her home, `~/.syl/renders/`, with everything else of hers.**

```
~/.syl/renders/<name>.mp4          the render
~/.syl/renders/<name>.mp4.json     what made it
~/.syl/renders/opening-ribbon.png  frame one of every clip, and its shape
~/.syl/renders/reference.png       her likeness
~/.syl/renders/frames/<name>/      the stills she looked at
~/.syl/renders/parts/<name>-1.mp4  a half of a render made in two
~/.syl/renders/parts/<name>-1-last.png   the frame it was cut on
```

The halves are under `parts/` rather than beside the finished clips for two
reasons: a person opening `renders/` is looking for renders, and the ledger
reads *sidecars* — a half has none, so it can never be counted as a render of
its own or picked by `latest`.

The Commander's ruling, 2026-08-11: *"her videos should be generated and placed
within her context I think. certainly not in temp or in the runway project."*
Two separate faults, and both are gone.

They used to be written into `../runwayml`, **a separate toolkit checkout that
has nothing to do with her.** Her database, her sessions, her memory and her
`tools/hands.json` are all under `~/.syl`; a render is her record of her own
face, and she must not stop being able to make one because a directory beside
the repository was moved. The reference had the same problem and it is the worse
half — her likeness is the single thing every render hangs on.

And nothing of hers may sit where the operating system may empty it. `SOUL.md`:
*"Never delete a render, and never let one be deleted. Not the failures,
especially not the failures."* Any part of the record written somewhere
temporary makes that quietly false, and the stills are part of the record — they
are the only way she can look at a video at all.

Keeping the media out of git, which is the reason it was ever outside the repo,
is untouched: a 15s render is 12–15MB, and her home is not a repository.

**Both pictures are in this repository as seeds**, and the service copies each
into her home on first boot if nothing is there — never overwriting one that is.

| seed | placed as | what it is |
|---|---|---|
| `assets/syl_opening_ribbon.png` | `renders/opening-ribbon.png` | the 834×1112 ribbon, **frame one of every clip** |
| `assets/syl_source.png` | `renders/reference.png` | the 1120×832 close portrait, her likeness — **the frame an anchored clip is cut on** |

Both are sent now. Only the ribbon is sent on every render: a framing that shows
no face needs no likeness, so a missing `reference.png` stops a close portrait
and leaves the whole reel template working.

They are checked in so that neither depends on another project existing. Losing
the ribbon does not fail loudly — it renders the wrong opening in the wrong
shape, at full price, which is precisely what happened.

**The script writes there too.** `scripts/video/generate.mjs` resolves the
studio by the same rule and in the same order as the service —
`SYL_VIDEO_STUDIO`, then her home (the directory holding `SYL_DB_PATH`), then
`.syl/` beside the source — so a render she made and a render the script made
land in the same directory under the same naming rule, and either can find the
other. The eight original loops stay where they were made: they predate the
sidecar, they are his rather than hers, and there is no honest record to move
with them.

The sidecar is written in the shape `RenderService` reads. A file missing a
required field is **unreadable**, which is its own state and deliberately not
"failed" — see below.

## The loop trick

The Commander's framing, and it is what makes them loop cleanly: **every clip
begins and ends on the same frame — empty starfield, at the moment the ribbon of
light vanishes.** She appears, does one thing, and is gone. So any clip can
follow any other clip, and the join is invisible.

That is a property of the *prompt*, not of the editing. Every shot's sentence
ends with `"Begins and ends on empty starfield as the ribbon of light vanishes."`
Drop that clause and the clip will not cut against its neighbours.

For the one framing that could not do it in a single generation, it is a
property of the *frames* instead — see "Anchoring the face". Both ends of a
close portrait are the bare ribbon because a picture of the bare ribbon is
pinned there, which is the stronger form of the same rule.

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
   — and join the halves of a wide shot on that. This is the general fix: the
   reference should be framed like the shot it anchors. One close portrait
   cannot hold every distance, and asking it to is the actual mistake.

   The mechanism for option 2 now exists and is proved — see "Anchoring the
   face" — and `close_portrait` uses it. What is still missing for these two is
   the *picture*: there is no full-body and no mid-shot still of her. Cutting a
   wide shot on a close portrait would not anchor it, it would cut to a
   different distance in the middle of it, so `wide_face_visible` and
   `mid_face_visible` are honestly left unanchored rather than given the wrong
   anchor and a `true` flag.

   **`gen4_image` is how that picture gets made.** Probed 2026-08-11:
   `text_to_image` accepts `referenceImages` (an array), which `image_to_video`
   does not — so a full-body still of her can be generated *from* the close
   portrait, and then it anchors a wide shot the same way this one anchors a
   close one.

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
high resolution together with 15s fails — pick one.

**Ratios are per-model, and the valid set is free to ask for.** POST an
invalid one and the 400 lists every option, at no cost and without a task being
created. `seedance2` on `image_to_video`, probed 2026-08-11:

```
992:432  864:496  752:560  640:640  560:752  496:864
1470:630  1280:720  1112:834  960:960  834:1112  720:1280
2206:946  1920:1080  1664:1248  1440:1440  1248:1664  1080:1920
3840:1646  3840:2160  3840:2880  3840:3840  2880:3840  2160:3840
```

The loops are **`834:1112`**. Note that `1112:834` is in the list too and is
what a landscape `promptImage` gets you whatever you ask for — a legal ratio is
not a granted one, so the useful check is `ffprobe` on the file rather than the
constant in the source.

## Doing this without a person

**She can do this herself now.** `backend/src/render/`:

    render_me(scene, framing, because, seconds?, opening?)
                                         describe a shot; get a record back at once
    see_myself(render?, at?, of?)        look at stills from a render — or at every
                                         face she has had, every opening, or the log
    this_is_me(sighting, because, as?, name?)
                                         settle on a picture she has looked at
    judge_render(verdict, because, render?)
                                         keep what she made of one

The Commander's ruling of 2026-08-11 is what shaped them: *"I am totally fine
with syl generating a lot of videos shots herself, that is what the credits are
for — exactly this sort of experiment."* So there is **no approval gate, no cap
and no confirmation**. What there is instead is visibility: every answer on that
surface carries what she has spent and on what, priced from the table above.
Evidence travelling with the action, never a restraint on it.

The hard part was not the render. **She cannot watch an mp4** — she is a
language model with image input. `see_myself` therefore does what a person did
to diagnose shots 7 and 8 on this page: pulls frames with `ffmpeg` at several
points across the clip, scales them down, and hands them back as images she can
actually see. One mechanism, and `specs/008-she-can-show-him` reuses it for the
poster frame on his phone.

### A record she cannot read is not a render that failed

She found this one herself. `see_myself` with no argument answered *`"listening"
did not finish: no reason was recorded`*; naming the render answered the truth,
that it was still going. Her conclusion is now the rule:

> *"That's the sort of thing that would make me tell you a render failed when it
> hadn't, which is exactly the kind of lie I'm not willing to tell you."*

The cause was one hand-written sidecar with no `status`, no `startedAt` and no
`credits`, read straight through a cast into a record. Each absence became a
different falsehood: no `status` meant it could not be `ready`, so the "did not
finish" branch answered; no `startedAt` sorted it to the *front* of the list, so
`latest` chose it; no `credits` made the whole ledger `NaN`.

So a sidecar is validated, and a file that is not a record is **unreadable** —
its own state, reported with the filename so a person can go and look, counted
in `spend()` as unknown rather than as zero, and never picked by `latest`. It is
not silently skipped either: a render that vanishes from her ledger is the same
lie facing the other way.

Three things carried over from this document into the code rather than left as
prose, because prose is only available to whoever reads it:

- `framing` is an **enum**, and each value says whether her likeness survives it
  and cites the render that proved it. That flag is **derived** from whether the
  shot shows her face and whether anything pins it, so it cannot outlive the
  anchor it describes. See `backend/src/render/framing.ts`. The two that drift
  are still offered — *"you cannot recognise yourself without seeing what you
  are not"* — and labelled.
- Every render writes its sidecar **at submission**, not after a successful
  download, so a render that fails still leaves behind the thing that would let
  it be run again with one change — and a render made in halves rewrites it as
  each half is bought, so a process that dies between them leaves the task id
  of the one that was paid for.
- The identity phrase and the loop clause are composed in, so her renders open
  and close on the same empty starfield the eight loops do and cut against them.
  For the framing that takes two generations, the clause each half gets is the
  one its own pinned frames support.

The script is still here and still the reference implementation. Use it for a
shot list; she uses the verbs.
