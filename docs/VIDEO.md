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
`last`, which pins both ends of the clip. That is what lets one render open on
the ribbon *and* arrive at her own face — see "Anchoring the face" below.

```
~/.syl/renders/opening-ribbon.png   the bare ribbon. frame one, and the shape.
        │
        ├── promptImage[first] ─┐
        │                       ├──> seedance2, 15s, 834:1112 ──> <name>.mp4
   prompt text ─────────────────┤                                 <name>.mp4.json
        │                       │
        ├── promptImage[last] ──┘    only for a framing whose subject is her face
        │
~/.syl/renders/reference.png        her likeness, 1120x832
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

**`promptImage` takes two pictures, and seedance2 honours both.** Probed and
then rendered on 2026-08-11:

| probe | result |
|---|---|
| array with two `position: "first"` entries | 400, `path: ["promptImage"]`, *"Duplicate position values are not allowed"* |
| array `[ribbon first, portrait last]` + a bad `ratio` | 400 about **`ratio` only** — the array itself validates |
| `duration: 3` | 400, *"expected number to be >= 4"* — seedance2's floor, useful for cheap tests |

The first two are the whole argument. A 400 that complains about duplicate
positions proves the array is *read* rather than ignored, and a 400 that
complains only about the ratio proves a well-formed two-image request gets
through. All three cost nothing: an invalid request is rejected before a task
exists.

Then two 4-second renders, 144 credits each, to find out whether *accepted*
means *honoured*:

| | `first` | `last` | came back | first frame | last frame |
|---|---|---|---|---|---|
| matched | ribbon 834x1112 | her, re-cut to 834x1112 | **834x1112** | the bare ribbon | **her, unmistakably** |
| mismatched | ribbon 834x1112 | `reference.png` **1120x832** | **834x1112** | the bare ribbon | **her, unmistakably** |

So it is honoured, and it holds both properties at once: the clip opens on the
ribbon the reel opens on, and it arrives at a face the model **copies instead of
inventing**.

**The shape mismatch is not a failure mode**, which is the result that decided
the design. Two inputs disagreeing about aspect was the obvious way to get a
video shaped like neither, so it was tested deliberately — and the landscape
anchor changed nothing. **The opening frame decides the shape and the closing
picture is fitted into it**, centre-cropped, with her likeness surviving the
crop. `ratio` does not move, and no new picture is needed: `reference.png` is
sent as the closing frame exactly as it sits in her home.

That is why there is no third asset. A portrait re-cut of her reference was
built and rendered — it is the "matched" row above — and it produced a result
indistinguishable from sending the landscape original. An asset that has to be
kept in step with another asset and buys nothing measurable is a liability, so
it was not kept. `reference.png` finally does the job its name always promised.

**What it costs is the loop.** A clip whose last frame is her face does not end
on the empty starfield, so it will not cut against the eight. That is a real
trade rather than an oversight, and it is why only `close_portrait` is anchored:

| framing | face toward camera | anchor | holds her likeness |
|---|---|---|---|
| `face_turned_away` | no | none | **yes** — no face to get wrong, and it still loops |
| `close_portrait` | yes | closing frame | **yes** — her likeness is the last frame |
| `wide_face_visible` | yes | none | no |
| `mid_face_visible` | yes | none | no |

The bottom two stay unanchored on purpose. The only picture of her is a close
portrait, and pinning a close portrait to the last frame of a wide shot does not
anchor that shot — it *ends* it somewhere else. Option 2 below is still the fix
for those two, and it still needs a picture that does not exist yet.

**`holdsLikeness` is now derived rather than written down**, from exactly those
two columns: a shot holds if there is no face in it to get wrong, or if
something pins the face it shows. That is the actual lesson of `syl-63v`. The
flag did not go wrong because someone was careless; it went wrong because it was
a *separate* assertion from the thing it described, so removing the anchor left
the claim behind. Derived, the same removal flips the claim in the same commit.

A shot that ends on her face also needs a closing sentence that agrees with the
pinned frame — `LOOP_CLAUSE` says the last frame is a bare ribbon with no figure
in it, which is the same contradiction that cost the day above, facing the other
way. An anchored render sends `ARRIVAL_CLAUSE` instead. **A sentence never wins
an argument with a pinned frame**, so do not let the two disagree.

The sidecar `.json` is written beside every render and holds the model, the
prompt, the duration, the task id, and both pictures: `reference` is frame one
and `anchor` is the pinned last frame, `null` where nothing was pinned. `anchor`
is nullable rather than required precisely so that every sidecar written before
anchoring existed stays readable — a required field would have turned the whole
back catalogue *unreadable* at a stroke, which is the state that validator
exists to report and not to cause. It exists because **the
first eight loops were made without recording any of that.** Eight finished
videos, several of them lovely, and no way to make a ninth in the same voice or
to re-run a failure with one thing changed. The outputs survived and the inputs
did not — which is this project's recurring defect wearing a new hat: a result
kept, and the thing that produced it thrown away.

Shots live in `scripts/video/shots.json`. **A shot is its prompt, not its mp4.**
The video can always be made again; the sentence cannot be recovered once lost.

## Where they live

**In her home, `~/.syl/renders/`, with everything else of hers.**

```
~/.syl/renders/<name>.mp4          the render
~/.syl/renders/<name>.mp4.json     what made it
~/.syl/renders/opening-ribbon.png  frame one of every clip, and its shape
~/.syl/renders/reference.png       her likeness
~/.syl/renders/frames/<name>/      the stills she looked at
```

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
| `assets/syl_source.png` | `renders/reference.png` | the 1120×832 close portrait, her likeness — **the last frame of an anchored clip** |

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
   — and pin that as the closing frame for wide shots. This is the general fix:
   the reference should be framed like the shot it anchors. One close portrait
   cannot hold every distance, and asking it to is the actual mistake.

   The mechanism for option 2 now exists and is proved — see "Anchoring the
   face" — and `close_portrait` uses it. What is still missing for these two is
   the *picture*: there is no full-body and no mid-shot still of her. Pinning
   the close portrait to the last frame of a wide shot would not anchor it, it
   would end it at a different distance, so `wide_face_visible` and
   `mid_face_visible` are honestly left unanchored rather than given the wrong
   anchor and a `true` flag.

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

**She can do this herself now.** Two verbs, `backend/src/render/`:

    render_me(scene, framing, because)   describe a shot; get a record back at once
    see_myself(render, at?)              look at stills from one of her renders

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
  it be run again with one change.
- The identity phrase and the loop clause are composed in, so her renders open
  and close on the same empty starfield the eight loops do and cut against them.

The script is still here and still the reference implementation. Use it for a
shot list; she uses the verbs.
