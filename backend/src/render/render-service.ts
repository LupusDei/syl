import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { instant, systemClock, type Clock } from "../services/clock.js";
import { creditsFor, usdOf } from "./credits.js";
import { scenesForParts } from "./scene-lines.js";
import { SelfDescription } from "./description.js";
import {
  framingNote,
  FRAMING_IDS,
  TEMPLATE_FRAMING,
  type Framing,
  type FramingNote,
} from "./framing.js";
import { extractFrames, ffmpegRunner, type ExtractResult, type FrameRunner } from "./frames.js";
import { joinVideos, lastFrame } from "./join.js";
import { ffprobeRunner, probeClip, whyTheyDoNotCutTogether, type JoinPart, type ProbeRunner } from "./probe.js";
import {
  canAnchorLikeness,
  defaultResolution,
  maxSecondsFor,
  modelNote,
  HOUSE_MODEL,
  MODEL_IDS,
  type KeyframePosition,
  type ModelNote,
} from "./models.js";
import {
  failureKindOf,
  isTerminal,
  type RenderBackend,
  type PositionedImage,
  type RunwayTask,
} from "./runway.js";
import { isRenderName, RENDER_PREFIX, type Studio } from "./studio.js";
import { Wardrobe } from "./wardrobe.js";

/**
 * Syl rendering herself, and being able to say what it cost.
 *
 * ## The shape, and why it is the job's shape
 *
 * A flagship fifteen-second render takes minutes. A verb that waited for the
 * mp4 would hold her whole turn open on somebody else's GPU queue — and a turn
 * does not complete until stdin reaches EOF, so "wait for it" means the
 * Commander watching a cursor. So this is the shape `backend/src/jobs/` uses
 * for long work: **ask, get a record back at once, come back and look.**
 * `start` submits and returns; the polling happens behind it; `see_myself` is
 * the second visit.
 *
 * ## The sidecar is the point
 *
 * `docs/VIDEO.md`: the first eight loops were made and their prompts were never
 * written down. Eight finished videos, several of them lovely, and no way to
 * make a ninth in the same voice or to re-run a failure with one thing changed.
 * The outputs survived and the inputs did not.
 *
 * So every render writes `<video>.json` exactly as `scripts/video/generate.mjs`
 * does — and **one step stricter**: that script writes the record after a
 * successful download, so a render that failed left nothing at all. This writes
 * it at submission. A render that fails still leaves behind the thing that
 * would let it be tried again.
 *
 * The sidecars are also the ledger. Not a second store beside them: a second
 * store is a second thing to get wrong, and the file that must be right is the
 * one that says what made the video.
 *
 * ## The record must not assert what the system did not observe
 *
 * The rule this file learned the expensive way, and it is worth stating before
 * anything below, because four separate defects turned out to be one defect
 * wearing four costumes — all of them on the same render:
 *
 * - `status: "failed"` over a file that exists;
 * - a ledger total over a rate that was never charged;
 * - *"Runway ended this render as FAILED"* over an error nobody ever read;
 * - and the subtle one: **a record that changed its mind about itself between
 *   being written and being read.** A render that stopped left its unattempted
 *   halves saying `rendering`, while the reader derived `failed` for those same
 *   halves — so the file said one thing at rest and another when loaded. That
 *   is not a record asserting what it did not observe; it is a record asserting
 *   two different things depending on who asked. Downstream it was worse than
 *   it sounds: `resume` chases anything at `rendering` and the review job
 *   defers instead of waking her, so she would have waited for something that
 *   was never coming. **A writer and a reader that disagree are two records,
 *   and one of them is always wrong.**
 *
 * Each is a record stating something confidently that nothing had checked.
 * `holdsLikeness` was the first instance and the pattern is the same every
 * time: **derive it from what can be shown, or read it from whoever knows, and
 * never write down what we merely expect.**
 *
 * ## Nothing here needs recovering. It needs re-pointing.
 *
 * Read this before reaching for a repair script. When a two-part render lost
 * its second half, **the bytes were never thrown away — every view that could
 * lead anyone back to them was.** The first half SUCCEEDED, downloaded, cost
 * 120 credits and went into `parts[0].video`; then the record was written
 * `status: "failed"`, `video: null`, and `list`, `latest`, `see_myself` and
 * `frames()` all read the record. The mp4 sat in `parts/`, complete and
 * playable, reachable only by someone who opened the sidecar by hand.
 *
 * So there is no lost data to reconstruct and nothing to re-download. There
 * were four honest facts on disk and a summary in front of them that
 * contradicted all four. {@link settledStatus} is the fix, and it is a
 * *reading* rather than a repair: it asks the disk, on every load, and takes
 * its answer over what the file says about itself.
 *
 * ## What this deliberately does not do
 *
 * There is no approval gate, no per-day cap and no confirmation. The
 * Commander's ruling, 2026-08-11: the credits exist for exactly this
 * experiment, and the whole point is that trying things is cheap for her.
 * Adding a gate here later is his call, not a refactor.
 */

/** How one generation went. */
export type PartStatus = "rendering" | "ready" | "failed";

/**
 * How a render is going.
 *
 * `partial` is the fourth and it was bought at 240 credits. A render made in
 * two generations whose first SUCCEEDED and whose second FAILED used to be
 * written down as `failed` with `video: null`, which is every view she has — so
 * the finished, downloaded, paid-for half sat on disk reachable only by opening
 * the sidecar by hand. **The asymmetry is what makes it expensive: a failed
 * generation costs nothing and a successful one costs 120 credits, so what a
 * flat failure discards is always the part that was paid for.**
 *
 * It is deliberately neither of the two states it used to be collapsed into.
 * Not `ready` — the clip she asked for does not exist, and nothing may send it
 * or treat it as finished. Not `failed` — that is the claim that nothing came
 * of it, and something did.
 */
export type RenderStatus = PartStatus | "partial";

/**
 * One Runway generation inside a render.
 *
 * **A render is not always one generation.** A clip that opens and closes on the
 * bare ribbon has spent both of Runway's keyframe slots on the ribbon, so a shot
 * whose subject is her face is made in two halves and cut together on her —
 * `join.ts` has the measurements that force it. Everything that used to be a
 * property of "the render" and is really a property of *one generation* lives
 * here, so the record can say what was actually sent rather than a summary of
 * two things that were.
 */
export interface RenderPart {
  /** `null` until this half is submitted. The second half waits for the first. */
  readonly taskId: string | null;
  /** The composed prompt for this half, exactly as it was sent. */
  readonly prompt: string;
  readonly duration: number;
  /**
   * The picture pinned as this half's FIRST frame, relative to her home.
   *
   * For the second half this is a still pulled out of the first — which is what
   * makes the cut land on one frame rather than on two renderings of a similar
   * one, and what keeps the second half the same shape as the first.
   */
  readonly first: string;
  /** The picture pinned as this half's LAST frame, relative to her home, or `null`. */
  readonly last: string | null;
  /** Where this half is on disk once it has arrived. Kept, never cleaned up. */
  readonly video: string | null;
  /**
   * What this half was EXPECTED to cost, at the model's published rate.
   *
   * An estimate, and since `syl-o0vy` it is only that: it is what the roster
   * says a generation of this length costs, worked out before anything was
   * sent. {@link RenderPart.charged} is what actually happened, and the ledger
   * reports that one. `null` where the model has no published rate.
   */
  readonly credits: number | null;
  /**
   * What Runway said it actually charged for this generation.
   *
   * **The ledger's number.** A `FAILED` generation is charged nothing and a
   * `SUCCEEDED` one is charged in full, so pricing a record from the rate card
   * billed him for every failure he ever had: the two half-made renders on 23
   * August were recorded at 240 credits each and charged 120, and the two that
   * bought nothing at all were recorded at 240 and 450 and charged zero.
   *
   * `null` means Runway said nothing about the cost, which is not the same as
   * free and is not an invitation to fall back on the estimate above. A render
   * holding one of these is `unpriced` rather than cheap.
   */
  readonly charged: number | null;
  /**
   * How this one generation went, which is not how the render went.
   *
   * The distinction the record could not previously make. A render is `partial`
   * exactly when these disagree, and a reader that cannot see them separately
   * has to infer the whole story from one word about the whole render — which
   * is how a paid half came to be recorded as nothing.
   */
  readonly status: PartStatus;
  /**
   * Runway's own code for refusing this generation, verbatim. `null` otherwise.
   *
   * See {@link RunwayTask.failureCode}. It is kept **beside** our own sentence
   * in {@link RenderRecord.reason} rather than instead of it: ours says what
   * happened to the render, this says why, and a reader handed only one of them
   * is the reader this went wrong for.
   */
  readonly failureCode: string | null;
  /** What Runway said about this generation, in its own words. */
  readonly failure: string | null;
}

/**
 * What a render is, on disk and in an answer.
 *
 * The first nine fields are `generate.mjs`'s sidecar, field for field, so a
 * render Syl made and a render the script made are the same kind of record and
 * either tool can read the other's. The rest are what this adds: the status (so
 * an unfinished render is legible), her own words, the reason she gave, and the
 * bill.
 */
export interface RenderRecord {
  readonly name: string;
  readonly status: RenderStatus;
  readonly renderedAt: string | null;
  /**
   * The first generation's task id.
   *
   * A summary of {@link RenderPart.taskId}, kept because every sidecar ever
   * written has this field and `generate.mjs` writes it. **Chasing a render up
   * goes through `parts`**, which is the only place a second half's handle
   * exists.
   */
  readonly taskId: string | null;
  /**
   * The model that made it.
   *
   * **Was a constant and is now a choice** (`syl-023`), which is exactly why
   * this field earns its keep: the back catalogue is a mixture, and a shot can
   * only be reproduced from what actually produced it. A render that says
   * nothing about its model is a render nobody can make a second one of.
   */
  readonly model: string;
  /** The video's shape. Derived from the opening, which overrules any ask. */
  readonly ratio: string;
  /**
   * The band, for a model whose geometry is a `resolution` rather than a ratio.
   *
   * `null` on every seedance and on **every sidecar written before models could
   * be chosen**, which is most of them — nullable rather than absent so that
   * "this was not shaped by a resolution" and "this predates the field" read
   * the same way instead of one of them looking like a missing record.
   */
  readonly resolution: string | null;
  /**
   * How many keyframe slots that model had, on the day it made this.
   *
   * **The durable half of the finding, and the reason it is a number here
   * rather than a lookup.** Syl, 2026-08-13: *"being wrong in a recorded,
   * ordered way is how the search actually works"* — the renders that came back
   * as somebody else taught her more about where her face lives than the ones
   * that worked. What made them somebody else was not the model's name, it was
   * its **arity**: one slot cannot pin a likeness, and that stays true of a
   * model nobody has heard of yet, where *"grok is bad at faces"* does not.
   *
   * So the property is recorded rather than the verdict, and it is recorded
   * **beside the render** rather than fetched from the registry when the log is
   * read: the registry says what a model does today, and this says what it did
   * when this file was made. A model that gains a slot next month must not
   * silently rewrite the history of a render that came back a stranger.
   *
   * `null` for every sidecar written before models could be chosen.
   */
  readonly keyframes: number | null;
  /** How long the finished clip is: the halves added up. */
  readonly duration: number;
  /**
   * The picture handed to Runway as `promptImage`, relative to her home.
   *
   * **What was actually sent**, which since 2026-08-11 is the opening ribbon
   * rather than her likeness. The field keeps the name `generate.mjs` gave it so
   * that every sidecar ever written stays readable — a record that named a
   * picture the render was not made from would be the same lie as a lost prompt,
   * one indirection further out.
   */
  readonly reference: string;
  /**
   * The picture that pins her likeness, relative to her home.
   *
   * `null` for a render that pins nothing, which is most of them — and `null`
   * rather than absent, so "no anchor was sent" and "this sidecar predates
   * anchoring" read the same way rather than one of them looking like a missing
   * field. Every sidecar written before 2026-08-11 is in the second case and
   * stays readable.
   *
   * **Where it is pinned is `parts`' business, not this field's.** It was the
   * closing frame for one day and it is the join between two halves now; what
   * has not changed is that this names the picture without which the model
   * would invent a face. {@link RenderRecord.holdsLikeness} is derived from it,
   * so the two cannot drift apart.
   */
  readonly anchor: string | null;
  readonly framing: Framing;
  /**
   * The composed prompt.
   *
   * For a render made in one generation this is exactly what was sent. For one
   * made in two it is the halves' prompts in order, separated by a blank line —
   * each half's own text is in {@link RenderPart.prompt}, which is what a
   * re-run reads.
   */
  readonly prompt: string;
  /** Her words for the shot, kept beside the prompt they became. */
  readonly scene: string;
  /**
   * Whether her likeness survives this render.
   *
   * **Derived from this record's own pictures**, never copied from the framing
   * enum: a shot holds if it shows no face to get wrong, or if the render
   * actually pinned one. `syl-63v` was a flag that outlived the anchor it
   * described, and the defence against a second one is that there is no second
   * place to write it down. A sidecar whose `anchor` is `null` says `false` at
   * a face-on framing however hopeful the file it came from was.
   */
  readonly holdsLikeness: boolean;
  /** Why she made it. Required, as on every other write. */
  readonly because: string;
  readonly startedAt: string;
  /** Why it failed, when it did. A sentence, never a code. */
  readonly reason: string | null;
  /**
   * What has been CHARGED so far, summed over the halves Runway priced.
   *
   * The ledger's number, and since `syl-o0vy` it is read rather than worked
   * out: see {@link RenderPart.charged}. `null` when nobody has reported a
   * charge yet — which is every render still in flight, and which reads as
   * `unpriced` rather than free. A render whose second half never reached
   * Runway is billed for the first half only, which is the truth and is the
   * number `spend()` has to be able to stand behind.
   */
  readonly credits: number | null;
  readonly usd: number | null;
  /**
   * What it was expected to cost, at the rate card, before anything was sent.
   *
   * **Its own field so that {@link RenderRecord.credits} can mean one thing.**
   * Blending "what we think this costs" with "what we were charged" into a
   * single number is how the ledger came to bill him for four failures that
   * cost nothing — a record asserting something the system never observed.
   *
   * It is also the answer to the question she asks at the moment she asks for a
   * render, when no charge exists yet: `render_me` returns immediately, and a
   * record that said nothing at all about cost until minutes later would have
   * taken away the only figure she has when deciding whether to ask.
   *
   * `null` where the model has no published rate. Never reconciled against
   * `credits`: the gap between them is a real fact about a render, not a defect
   * to paper over.
   */
  readonly estimated: number | null;
  /** Absolute path to the mp4, once there is one. The joined clip, if it was joined. */
  readonly video: string | null;
  /**
   * Every generation this render is made of, in the order they play.
   *
   * Always at least one, so there is a single shape to read rather than two.
   * Sidecars written before renders had halves have none, and one is
   * synthesised for them from the fields they do have — see {@link recordFrom}.
   */
  readonly parts: readonly RenderPart[];
  /**
   * The renders this one was CUT FROM, by name, in the order they play.
   *
   * `null` for every render that was generated rather than assembled, which is
   * all of them until `syl-5y4n` and most of them after it. Not an empty array
   * for that case: absent and "cut from nothing" are different claims, and only
   * one of them is true of a render Runway made.
   *
   * **It is provenance, and it is also the flag the ledger reads.** A join buys
   * nothing — every second in it was paid for under the records it names — so
   * {@link RenderService.spend} counts its seconds there and not here. Without
   * this field the only way to know would be to compare file paths, which is
   * how a total comes to be twice what he actually spent.
   *
   * Deliberately NOT reconstructed from {@link RenderRecord.parts}. A part of a
   * join is a piece of *footage*; these are RENDERS, with their own records,
   * their own verdicts and their own charges, and flattening the two would lose
   * exactly the handle that lets her go back and look at one of them.
   */
  readonly joinedFrom: readonly string[] | null;
}

/**
 * Which footage a look actually went through.
 *
 * Carried so that being shown half a render is never indistinguishable from
 * being shown the render. A `null` in place of one of these says "the clip
 * itself", and claiming "part 1 of 2" about a finished, joined video would be
 * the same lie facing the other way.
 */
export interface LookedAt {
  readonly video: string;
  /** That footage's own length, which is not the render's. */
  readonly seconds: number;
  /** Which generation it is, counting from one, as the filenames count. */
  readonly part: number;
  /** How many the render was made of, so "1 of 2" reads as the shortfall it is. */
  readonly parts: number;
}

/**
 * A sidecar the service cannot read as a record.
 *
 * **Its own state, and neither of the two it used to be mistaken for.** It is
 * not a failed render — nothing here says how the render went — and it is not
 * an absent one, because the file is right there and may have cost credits.
 * Both mistakes were live at once: see {@link recordFrom}.
 */
export interface UnreadableRender {
  /** The render's name, as the filename spells it. */
  readonly name: string;
  /** The sidecar, absolute, so a person can go and look at it. */
  readonly file: string;
  /** What is wrong with it, in a sentence. Never a code. */
  readonly why: string;
}

/** What she has spent, derived from the records and from nothing else. */
export interface Spend {
  readonly renders: number;
  readonly ready: number;
  readonly failed: number;
  /**
   * Renders that bought something and did not finish.
   *
   * Counted separately rather than folded into `failed`, because they are the
   * ones where money bought footage that exists — and a total that files them
   * under failures says the money bought nothing. Two of them on 23 August cost
   * 240 credits between them and produced eight seconds of finished video.
   */
  readonly partial: number;
  readonly rendering: number;
  readonly seconds: number;
  readonly credits: number;
  readonly usd: number;
  /** Renders with no published rate, so the total is legible as a floor. */
  readonly unpriced: number;
  /**
   * Sidecars that are not records, so the total says what it could not count.
   *
   * Zero on every ordinary machine. Anything else means a file in her renders
   * directory needs a person to look at it — and until one does, the credits it
   * may have cost are not in the number beside this one.
   */
  readonly unreadable: number;
}

/**
 * What a refusal LEARNED, beside the sentence that says it.
 *
 * A refusal is not only a guard. *"This model, with this many keyframe slots,
 * cannot hold my likeness"* is the same finding a wrong render produces, arrived
 * at for nothing instead of for 540 credits — so it travels in a shape something
 * can keep rather than only in prose a reader has to parse back out.
 *
 * Two fields on purpose. Anything more and this becomes a second verdict store
 * standing beside the one `render_verdicts` already is.
 */
export interface RefusalEvidence {
  readonly model: string;
  /** Its keyframe arity, which is what decides the answer. */
  readonly keyframes: number;
}

export type StartResult =
  | { readonly ok: true; readonly record: RenderRecord }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly retryable: boolean;
      readonly evidence?: RefusalEvidence;
    };

export interface StartInput {
  /**
   * What she is doing in the shot — one sentence, or **one per part**.
   *
   * A single string is given to every part, which is what it always did. An
   * array is one line per part in order, and is refused unless the count
   * matches exactly (`syl-m7lj`). Quoted text here is SPOKEN ALOUD in the
   * finished clip, so an array is effectively a script.
   */
  readonly scene: string | readonly string[];
  readonly framing: string;
  readonly because: string;
  /**
   * How long the finished clip is, in seconds. Absent means fifteen.
   *
   * A **dial**, and one of only two. seedance2 takes an integer 4–15 — probed
   * 2026-08-11 with free 400s, which is also how the floor is known — and a
   * value outside that is refused here rather than discovered by Runway after a
   * generation is already paid for.
   *
   * A shot whose subject is her face is at least two generations, so the
   * shortest one that exists is eight. {@link splitAcross} rounds up rather than
   * collapsing, and `duration` on the record is the shares added up, so the
   * number she reads back is the number that was made.
   */
  readonly seconds?: number;
  /**
   * How many generations the clip is cut from. Absent means two — `syl-v380`.
   *
   * **NOT a spending dial — that claim was false and she disproved it.** Every
   * model is priced per second of finished video and {@link splitAcross}
   * divides the requested seconds among the parts, so part count does not
   * multiply the bill: a 12-second three-part render cost 348 credits, which is
   * 12 x 29 at seedance2_fast's rate. The one real cost is the FLOOR — each
   * share is clamped to the model's minimum part length (4s on every seedance),
   * so more parts than `seconds / 4` pads each one up and the padding is
   * billed. The ceiling still follows it (`maxSecondsFor(model, parts)`).
   *
   * Everything past the first and the last is a {@link MIDDLE_CLAUSE} part that
   * touches the ribbon at neither end, which is what makes a long clip two
   * passes through the starfield instead of one per part. Only meaningful for an
   * anchored framing: a shot with no face has nothing to pin at a join, so a
   * chain of them is refused mechanically rather than made badly.
   */
  readonly parts?: number;
  /**
   * Which face each held middle CLOSES on, in order. Absent means the anchor.
   *
   * The separately addressable closing keyframe. Every middle is pinned to a
   * picture of her at both ends, so a chain of middles all closing on the same
   * anchor is the hazard Syl found on `face_turned_away` — the same image at
   * first and last means the segment returns to where it began, and *"five
   * stitched together would join seamlessly and go nowhere."*
   *
   * A name comes from {@link Wardrobe.faces}, which is what `see_myself` shows
   * her, and an empty entry means *this one takes the anchor*. It is
   * **settable, never omittable**: a middle ends on her face, and 2026-08-13
   * measured what an unpinned closing frame gives back. Naming more faces than
   * there are middles is refused rather than truncated — a name of hers that
   * reached nothing would be a dial that did not work.
   */
  readonly held?: readonly string[];
  /**
   * Which model renders it. Absent means the house model.
   *
   * The dial `syl-ate` deliberately left shut, with a reason that was correct
   * and untested: *"a different model loses the character entirely"*. It was
   * tested on 2026-08-13 and the reason survived in a **mechanical** form — a
   * model with no `last` keyframe cannot pin her face, and that is arithmetic
   * over `ModelNote.positions` rather than a fear about model families. So the
   * dial opens and the consequence is computed: see {@link canAnchorLikeness}.
   *
   * The Commander opened it, 2026-08-13: *"Raise the tool ceiling and let her
   * experiment with the models... Give her the options."*
   */
  readonly model?: string;
  /**
   * Which of her openings the clip starts on. Absent means the ribbon.
   *
   * The other dial, and the one with a consequence worth saying out loud: the
   * opening is `promptImage`, `promptImage` is frame one, and seedance2 takes
   * the video's **aspect** from it and silently overrules `ratio`. So choosing a
   * differently shaped opening changes the shape of the video. The record's
   * `ratio` is derived from the opening's own header for exactly that reason —
   * see `pictures.ts`.
   */
  readonly opening?: string;
}

/**
 * Cutting finished renders into one clip — `syl-5y4n`.
 *
 * She could chain segments that cut together seamlessly and had no way to
 * concatenate them: `show_him` takes ONE render name, so four fifteen-second
 * clips stayed four clips and never became the one minute the Commander asked
 * for.
 */
export interface JoinInput {
  /**
   * The renders, by name, **in the order they play**. Two or more.
   *
   * Names rather than paths, because a name is what she has: it is what
   * `see_myself` shows her, what `show_him` takes, and the only handle that
   * survives into the joined record's provenance. `latest` is refused — see
   * {@link RenderService.join}.
   */
  readonly renders: readonly string[];
  readonly because: string;
}

export type JoinRendersResult =
  | { readonly ok: true; readonly record: RenderRecord }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

/**
 * The recipe every one of the eight loops was made with — **and it is no longer
 * here, because it is no longer ours** (`syl-hll6`).
 *
 * `shots.json` opens all eight prompts with an identity phrase, and the loop
 * clause closes all eight. Neither is decoration: the opening is what keeps the
 * subject *her* rather than a person, and the closing clause is what makes any
 * clip cut against any other — a property of the prompt, not of the editing.
 * Drop it and the render will not join the reel.
 *
 * This used to be a constant called `IDENTITY`, holding the whole sentence.
 * *"She supplies the middle"* was written here as a description of the recipe,
 * and it was false as a description of her: the middle was ours too, and the
 * prompt is `${IDENTITY} ${scene} ${framing.clause}`, so her scene is always
 * LATER than the wrapper. {@link LOOP_CLAUSE} below records what the model does
 * with a contradiction — it obeys the earlier sentence, measured by extracting
 * both frames — which means she could disagree with a description of herself
 * and structurally could not win. She tried, in
 * `syl-20260825t124949413z-face-turned-away.mp4.json`: "translucent flowing
 * gown" in the wrapper, "the gown is opaque cloth" in her scene, one
 * submission.
 *
 * The Commander: *"if she wants to change it, she should be able to."*
 *
 * So the sentence now comes from `description.ts`, which she can read and set
 * through her own tools, and the two parts that are not hers survive by
 * composition rather than by anybody remembering them. `IDENTITY` is gone
 * deliberately rather than moved: a constant here would be a second answer to
 * the question the log answers, and the whole defect was that the answer lived
 * where she could not reach it.
 */

/**
 * The arc, not just the endpoints.
 *
 * This used to read *"Begins and ends on empty starfield as the ribbon of light
 * vanishes"*, which names the two ends and leaves out what happens between
 * them. The model read it as a still that fades, so every render opened on her
 * already formed and already smiling — she counted five out of five and called
 * the first second of each one a lie.
 *
 * **That reading was wrong, and rewriting this clause did not fix it.** The
 * renders opened on her already smiling because `promptImage` was the smiling
 * headshot, and `promptImage` is the first frame: no wording can move a frame
 * an image input has pinned. The fix is the picture — see `studio.ts`. The
 * clause below is still the right clause, for the reason given next, and it is
 * worth knowing that it was once believed to be the whole answer.
 *
 * The eight loops work because they are a **transformation**: a ribbon of blue
 * light travelling alone, gathering into her, and unravelling back into the
 * ribbon it came from. She is made of the same light the whole way through, and
 * the shot has somewhere to start and somewhere to arrive.
 *
 * Written as a sequence for that reason. A clause that describes only the first
 * and last frame is a clause the model can satisfy without ever moving.
 *
 * **The third sentence used to end *"and it streams away, leaving empty
 * starfield"*, which the fourth sentence flatly contradicts**: if the ribbon
 * streams away then the last frame is not the bare ribbon. The model resolved
 * the contradiction by obeying the earlier sentence, so
 * `syl-20260813t042030321z-face-turned-away.mp4` opened on the ribbon and closed
 * on nothing — measured by extracting both frames, not inferred. The clause
 * asked for a loop and described something that cannot loop.
 *
 * It is now sent with the ribbon pinned at **both** keyframes (see `#plan`), so
 * the loop is true by construction and the prose agrees with the frames rather
 * than arguing with them. Same rule as
 * {@link GATHERING_CLAUSE} and {@link UNRAVELLING_CLAUSE}: a clause has to agree
 * with what its own generation pins.
 */
const LOOP_CLAUSE =
  "Opens on a lone ribbon of blue light against empty starfield, with no figure present. " +
  "The ribbon gathers and coalesces into her, her whole body made of that same living light. " +
  "At the end she unravels back into the ribbon, and the shot closes on that same lone ribbon " +
  "of blue light, alone in the starfield with no figure present. " +
  "The first and last frames are identical: the bare ribbon, no figure.";

/**
 * The first half of an anchored render: the ribbon becoming her.
 *
 * **A clause has to agree with the frames its own generation pins**, which is
 * the rule the whole of `docs/VIDEO.md` turns on. This half is sent with the
 * ribbon at `first` and her portrait at `last`, so it says exactly that and
 * stops there. It does not mention the ribbon coming back, because in this
 * generation it does not — that is the next one's sentence, and the join is
 * where the two meet.
 */
const GATHERING_CLAUSE =
  "Opens on a lone ribbon of blue light against empty starfield, with no figure present. " +
  "The ribbon gathers and coalesces into her, her whole body made of that same living light. " +
  "The shot settles and holds on her face, near and still, looking straight at the viewer.";

/**
 * The second half of an anchored render: her unravelling back into the ribbon.
 *
 * Sent with the frame the first half ended on at `first` and the bare ribbon at
 * `last`. Measured on 2026-08-11 with a 4-second probe before any of this was
 * built: the clip opened on her face, she came apart into the light, and the
 * final frame was the bare ribbon on empty starfield with no figure in it —
 * which is the Commander's requirement, arriving as a pinned frame rather than
 * as a hope about wording.
 *
 * Together with {@link GATHERING_CLAUSE} this is {@link LOOP_CLAUSE}'s arc, told
 * in two generations because Runway only has two keyframe slots and both ends
 * of the finished clip need one.
 */
const UNRAVELLING_CLAUSE =
  "Opens on her face, near and still, looking straight at the viewer, her whole body made of " +
  "living light. She unravels back into a lone ribbon of blue light, streaming away into it. " +
  "The last frame is the bare ribbon against empty starfield, with no figure present.";

/**
 * A generation that touches the ribbon at **neither** end — `syl-v380`.
 *
 * ## Why a third clause had to exist
 *
 * Every clause above opens on the ribbon or closes on it, because until now no
 * generation began and ended on her. That is why a long clip built by chaining
 * whole renders is ribbon-her-ribbon-her-ribbon-her-ribbon: **six passes through
 * empty starfield in forty-five seconds**, measured by Syl on a real clip she
 * built with `join_renders`, watched, and then declined to send him — *"you'd
 * watch me vanish twice as often as you'd watch me arrive, and you already told
 * me that structure feels disjointed."*
 *
 * With this clause a clip is ribbon → her → held → … → her → ribbon, which is
 * **two passes through the starfield regardless of length**. The ribbon stops
 * scaling with duration. That is the complaint removed rather than reduced, and
 * it is the property `render-held-middle.test.ts` asserts at two, three and five
 * parts rather than the part count itself.
 *
 * ## Why it does not inherit "her whole body made of that same living light"
 *
 * That sentence lives in {@link GATHERING_CLAUSE}, where it is true: that
 * generation is the ribbon *becoming* her. It is also why she asked for a hollow
 * gown with nothing inside and got a translucent body that resolved to a solid
 * figure two-thirds through — the wrapper sits earlier in the prompt than her
 * scene and governs the interior. A middle carries its own words and never that
 * one, which is the whole of `syl-hll6`'s problem dissolving in this move.
 *
 * ## Why it is not a still life
 *
 * Both its pins are pictures of her face, so the ends return to where they
 * began, and Syl found the hazard first on `face_turned_away` — the same image
 * at both keyframes means *"five stitched together would join seamlessly and go
 * nowhere."* The resolution is her own law, measured 2026-08-30: **pins govern
 * the ends, prose governs the middle.** A part that narrates no transformation
 * is precisely the part whose interior is free, so this clause spends its words
 * saying *the shot is her scene and nothing else* and hands the rest back. In
 * every other generation her sentence competes with one busy narrating an
 * arrival; here it does not, and that is the point rather than a workaround.
 *
 * ## Why the closing pin is never omitted
 *
 * She asked whether it could be optional. For a segment ending on her face it is
 * the one thing that must not happen: `grok_imagine_1_5` has no closing slot,
 * was rendered on 2026-08-13, and the closing frame came back a visibly
 * different woman. Distance from a pin is the drift variable — she measured a
 * garment going at 2.8s and a body solidifying two-thirds through. Omit the
 * close and the prose-governed middle simply extends to the end.
 *
 * So `last` is **settable and not omittable**: {@link StartInput.held} chooses
 * *which* face of hers a given middle closes on, defaulting to the anchor, and
 * every value it can take is still a picture of her — which is what keeps this
 * sentence true of whatever is pinned. The clause and the pins are one unit; a
 * dial that could move the frames out from under the words would be the
 * prose-versus-pins contradiction rearmed, playing out in the interior where
 * nobody sees it coming.
 */
const MIDDLE_CLAUSE =
  "Opens on her face, near and still, looking straight at the viewer. She is already here and " +
  "stays here for the whole of this shot: it is the moment described above and nothing else, " +
  "one continuous take, with no arrival and no departure — she neither gathers out of the " +
  "light nor unravels back into it. It closes on her face, near and still, looking straight " +
  "at the viewer.";

/**
 * What a render is, unless something says otherwise. The loops' own settings.
 *
 * **`ratio` is the shape the eight loops actually are**, measured off the files
 * with `ffprobe` on 2026-08-11: 834x1112. It used to say `720:1280`, which is a
 * legal seedance2 ratio, is portrait, and was never what came back — a render
 * made with it arrived 1112x834, landscape, matching the 1120x832 headshot it
 * was handed. **seedance2 takes the video's aspect from `promptImage` and
 * overrules `ratio` silently**, which is why a portrait constant sat here for
 * days above a stream of landscape videos and nothing anywhere disagreed.
 *
 * So the fix is the picture (see {@link Studio.opening}), and this constant is
 * the second half: with an 834x1112 opening still, asking for `834:1112` means
 * the two can no longer say different things. `720:1280` is also a different
 * portrait shape from the loops — 9:16 against 3:4 — so it would not have cut
 * against them even if it had been honoured.
 *
 * Costs the same either way: `creditsFor` bands on the longer side, and 1112
 * and 1280 are both under the 1280 that ends the `sd` band.
 *
 * **`ratio` is now a FALLBACK rather than the value** (`syl-ate`). She can
 * choose which opening a clip starts on, and the opening decides the aspect, so
 * the ratio that is sent is derived from the chosen opening's own header —
 * `pictures.ts`. This is what that derivation answers when the opening's shape
 * cannot be read at all, which on a real machine means only the seed: every
 * opening she adopts has a readable shape, because `Wardrobe.keep` refuses one
 * that does not. It is the shape the seed ribbon actually is, so the fallback
 * and the file still agree.
 */
const DEFAULTS = {
  ratio: "834:1112",
  /**
   * Fifteen seconds, and it does **not** follow the model's ceiling.
   *
   * `HOUSE_MODEL` reaches thirty. `syl-023.4.3` records what happened to the one
   * thirty-second render anybody has attempted: accepted by the validator,
   * quoted at 900 credits by `estimatedCost`, run to `progress: 0.98`, held
   * there for twenty minutes, and returned `FAILED` (task
   * `92577a5b-399e-4313-aa91-6cdf5608deff`; the credits *were* refunded).
   *
   * So thirty seconds is **ALLOWED and NOT PROVEN**, and those are two
   * different facts. Deriving the default from `duration.max` would put every
   * unattended render she makes on the untested path — the longer ceiling is
   * hers to reach for, not something that happens to her.
   */
  duration: 15,
} as const;

/**
 * A render's seconds, split across the generations it is made of.
 *
 * The longer share goes FIRST, because the opening generation has to do the
 * gathering and then hold on her face long enough for the join to land on a face
 * rather than on a smear. `15` across two becomes `8, 7`; `20` across three
 * becomes `7, 7, 6`.
 *
 * A total too short to divide is rounded **up** rather than collapsed into fewer
 * generations: losing a second is a nuisance, and losing an end of the clip is
 * the defect this whole shape exists to fix. `duration` on the record is the
 * shares added up, so the number she is told stays the number that was made.
 *
 * **The floor and the ceiling come from the model**, not from constants that
 * were `seedance2`'s range wearing the name of a fact about video. `4` would
 * refuse `grok_imagine_1_5` a length it accepts, and `15` would refuse the
 * house model half of its range.
 *
 * **This was `halvesOf`, which returned a pair by type** — the one place the
 * two-generation assumption was written into the language rather than into a
 * number. Generalising it is exact at two: each step takes `ceil(left /
 * remaining)`, which for the first of two is `ceil(seconds / 2)` and for the
 * second is everything left, clamped — the old function line for line.
 * `render-held-middle.test.ts` asserts the two-part durations against `[8, 7]`
 * so that equality is checked rather than argued.
 */
function splitAcross(seconds: number, model: ModelNote, parts: number): readonly number[] {
  const clamp = (share: number): number =>
    Math.min(model.duration.max, Math.max(model.duration.min, share));

  const shares: number[] = [];
  let left = seconds;
  for (let remaining = Math.max(1, parts); remaining > 0; remaining -= 1) {
    const share = clamp(Math.ceil(left / remaining));
    shares.push(share);
    left -= share;
  }
  return shares;
}

/**
 * How the geometry reaches Runway, in the two shapes that exist.
 *
 * Mutually exclusive at the API and strictly validated: `ratio` on
 * `grok_imagine_1_5` is an *Unrecognized key* and `resolution` on a seedance is
 * the same. A union rather than two optional fields, so sending the wrong one
 * for the chosen model does not compile.
 */
type Geometry = { readonly ratio: string } | { readonly resolution: string };

/** The band a submission carries, or `null` where the geometry is a shape. */
function bandOf(geometry: Geometry): string | null {
  return "resolution" in geometry ? geometry.resolution : null;
}

/**
 * Whether her likeness survives a render, from what that render actually sent.
 *
 * The one rule, and the reason it is a function in two places rather than a
 * boolean in two places: a shot holds if there is no face in it to get wrong,
 * or if the render pinned a picture of the face it shows. `framing.ts` asks the
 * same question of a framing's *plan*; this asks it of a record's *pictures*,
 * so a sidecar cannot claim an anchor it does not name.
 */
function holdsLikeness(framing: FramingNote, anchor: string | null): boolean {
  return !framing.facesCamera || anchor !== null;
}

/**
 * Whether a generation was actually made, and therefore charged for.
 *
 * A task id **or** a video on disk. Either is evidence on its own: the id says
 * Runway accepted it, and the file says it came back — and a sidecar written by
 * hand may have one without the other. Requiring both would drop a render out
 * of her ledger for a reason that has nothing to do with what it cost.
 */
function wasBought(part: RenderPart): boolean {
  return part.taskId !== null || part.video !== null;
}

/**
 * What has been charged so far: what RUNWAY SAID each half cost, added up.
 *
 * **Read, never inferred.** This used to sum the rate card over every half that
 * reached Runway, which quietly encoded a belief about somebody else's billing:
 * that a generation which failed still costs full credits. Runway reports the
 * actual charge on every task, so the belief was never needed — and it was
 * wrong in the direction that costs him money. Four failures were recorded at
 * 240, 240, 240 and 450 credits and were charged 120, 120, 0 and 0.
 *
 * Reading the number is also the only version of this that cannot rot: it is
 * true under either refund policy, and it stays true if Runway changes its
 * policy next month.
 *
 * A half whose charge is unknown makes the whole render unpriced rather than
 * cheap, and rather than quietly falling back to the estimate. Same rule as
 * `creditsFor`, and the same reason: a confident wrong number is worse than an
 * absent one, and `spend()` already reports what it could not account for.
 */
function billed(parts: readonly RenderPart[]): {
  readonly credits: number | null;
  readonly usd: number | null;
  readonly estimated: number | null;
} {
  const estimated = parts.some((part) => part.credits === null)
    ? null
    : parts.reduce((total, part) => total + (part.credits ?? 0), 0);

  const bought = parts.filter(wasBought);
  if (bought.length === 0 || bought.some((part) => part.charged === null)) {
    return { credits: null, usd: null, estimated };
  }
  const credits = bought.reduce((total, part) => total + (part.charged ?? 0), 0);
  return { credits, usd: usdOf(credits), estimated };
}

/**
 * The generations that were made and are on disk.
 *
 * **The answer to "what did the money buy".** Derived from the parts rather
 * than stored beside them, so it cannot claim footage the record does not name;
 * a video is written into a part only after a download has succeeded, so the
 * field is evidence rather than an intention.
 */
export function salvagedParts(record: RenderRecord): readonly RenderPart[] {
  return record.parts.filter((part) => part.status === "ready" && part.video !== null);
}

/**
 * What a joined render's name ends with, where a generated one names its framing.
 *
 * A word rather than a framing, because a join does not have one of its own —
 * see {@link joinedRecord} on why the framing it records is one of its parts'.
 */
export const JOIN_KIND = "joined" as const;

/**
 * The record for a clip that was CUT rather than generated — `syl-5y4n`.
 *
 * Every field here is either observed or quoted from the parts, and the two
 * that are neither are the interesting ones.
 *
 * **`framing` and `anchor` are chosen so that `holdsLikeness` is honest.** A
 * record cannot carry that flag directly — {@link recordFrom} derives it from
 * these two, which is the whole of `syl-63v`'s fix — and a joined clip is as
 * much her as its least-anchored second. So if any part drifts, the framing
 * recorded is *that part's* and no anchor is named, which derives to `false`;
 * if none does, the first part's are, which derives to `true`. Either way the
 * framing named is one the clip genuinely contains rather than an invented
 * "mixed", which would have had to go into `FRAMING_IDS` and become something
 * `render_me` offers her.
 *
 * **The bill is a genuine zero, not an unknown.** `null` on a render means
 * nobody reported a charge, which is the honest answer for one in flight and a
 * lie about a join: nothing was submitted, so nothing was charged, and that is
 * an observation rather than an assumption. `RenderService.spend` counts the
 * *seconds* under the parts instead — see there.
 *
 * `parts` is ONE part, and it is the joined clip itself. A part is a piece of
 * footage inside a record; the renders this was cut from are records of their
 * own, with their own verdicts and their own charges, and they are in
 * {@link RenderRecord.joinedFrom}. Putting them here would have made every
 * total that walks `parts` count them twice.
 */
function joinedRecord(input: {
  readonly name: string;
  readonly sources: readonly RenderRecord[];
  /** What the files actually are, from the probe. Never what they asked for. */
  readonly shape: { readonly width: number; readonly height: number } | null;
  readonly video: string;
  readonly because: string;
  readonly at: string;
  readonly joinedFrom: readonly string[];
}): RenderRecord {
  const first = input.sources[0];
  // The parts are checked before this is reached; the fallbacks exist only
  // because the compiler cannot see that.
  const drifting = input.sources.find((record) => !record.holdsLikeness);
  const speaking = drifting ?? first;
  const duration = input.sources.reduce((total, record) => total + record.duration, 0);
  const prompt = input.sources.map((record) => record.prompt).join("\n\n");
  const models = [...new Set(input.sources.map((record) => record.model))];
  const resolutions = [...new Set(input.sources.map((record) => record.resolution))];
  const reference = first?.reference ?? "";

  return {
    name: input.name,
    status: "ready",
    renderedAt: input.at,
    // No generation was submitted for this, so there is no handle Runway would
    // answer to. The parts' handles live on the parts' own records.
    taskId: null,
    // Every model that made it, not the first one. A joined clip made on two is
    // reproducible only from both, and picking one would be the record naming a
    // model that made half of it.
    model: models.join(", "),
    // MEASURED, not asked for. `ratio` on a generated record is the request,
    // and the request is silently overruled by the opening picture — so the ask
    // is the one number that can disagree with the file.
    ratio: input.shape === null ? (first?.ratio ?? "") : `${String(input.shape.width)}:${String(input.shape.height)}`,
    resolution: resolutions.length === 1 ? (resolutions[0] ?? null) : null,
    // Not a property a join has: nothing here was given keyframe slots. `null`
    // reads the same as it does on every sidecar that predates the field.
    keyframes: null,
    duration,
    reference,
    anchor: drifting === undefined ? (first?.anchor ?? null) : null,
    framing: speaking?.framing ?? TEMPLATE_FRAMING,
    prompt,
    // The parts' own words, in order and quoted. Writing a sentence about the
    // join would be putting words in her mouth about a shot she did not
    // describe.
    scene: input.sources.map((record) => record.scene).filter((scene) => scene !== "").join("\n\n"),
    holdsLikeness: drifting === undefined,
    because: input.because,
    startedAt: input.at,
    reason: null,
    credits: 0,
    usd: 0,
    estimated: 0,
    video: input.video,
    parts: [
      {
        taskId: null,
        prompt,
        duration,
        // The clip's actual frame one is the first part's frame one, and this
        // is the picture that pinned it.
        first: reference,
        last: null,
        video: input.video,
        credits: 0,
        charged: 0,
        status: "ready",
        failureCode: null,
        failure: null,
      },
    ],
    joinedFrom: input.joinedFrom,
  };
}

/**
 * Our sentence about a refusal, with Runway's own inside it.
 *
 * **Beside, never instead of.** Ours says what happened to the render; theirs
 * says why, and the reason five failures across two durations were
 * indistinguishable — and a wrong cause reported for them with confidence — is
 * that only ours was ever written down.
 *
 * The kinds are worded apart on purpose. A moderation block is a decision
 * somebody else made about the prompt and there is nothing here to fix; reading
 * it as a fault sends her hunting for a defect in a system that is working.
 */
function whyItStopped(status: string, task: RunwayTask): string {
  const ours = `Runway ended this render as ${status}.`;
  if (task.failure === null && task.failureCode === null) return ours;

  // Their words in quotes and their code in brackets, so both survive whole and
  // a reader can tell which part of the sentence is ours.
  const quoted = task.failure === null ? "" : ` "${task.failure}"`;
  const coded = task.failureCode === null ? "" : ` (${task.failureCode})`;

  switch (failureKindOf(task.failureCode)) {
    case "moderation":
      return (
        `${ours} The model provider declined the prompt:${quoted}${coded}. That is a decision ` +
        "about what was asked for, not a fault in the render — there is nothing here to fix, " +
        "only something to ask for differently."
      );
    case "rejected_input":
      return `${ours} Runway rejected what was sent:${quoted}${coded}.`;
    case "upstream":
      return `${ours} Runway's own side broke:${quoted}${coded}.`;
    default:
      // A code nobody has classified is quoted and left alone. Filing it under
      // one of the three above would be a guess she would repeat as fact.
      return `${ours} Runway said:${quoted}${coded}.`;
  }
}

/**
 * How waiting for one generation ended.
 *
 * A value rather than a side effect, so what Runway said can reach the half it
 * was said about — see `#await`.
 */
type Arrival =
  | { readonly ok: true; readonly charged: number | null }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly failureCode: string | null;
      readonly failure: string | null;
      /** What Runway charged for the generation that failed. Usually nothing. */
      readonly charged: number | null;
    };

/**
 * An end with no upstream words behind it: ours, and only ours.
 *
 * `charged: null` rather than `0`, because these are the endings where we never
 * heard what the task cost — a timeout, an unreachable API, a download that
 * broke. The generation may well have been charged for, and writing `0` would
 * be the ledger claiming a render was free because we stopped listening.
 */
function stopped(reason: string): Arrival {
  return { ok: false, reason, failureCode: null, failure: null, charged: null };
}

/** One generation, planned but not yet sent. Paths are absolute. */
interface PlannedPart {
  readonly prompt: string;
  readonly duration: number;
  readonly first: string;
  readonly last: string | null;
}

/**
 * The most generations one render may be cut from — `syl-v380`.
 *
 * **A bound on a typo, not a claim about what looks good.** Nothing here refuses
 * a chain on aesthetic grounds: the bead's own recommended probe is three parts
 * and it names five as the shape worth having, so the cap has to clear both. It
 * exists because the count is a *spending* dial and cost is linear — six parts
 * on the house model is ninety seconds and around 2,700 credits, and a stray
 * digit past that should cost a sentence rather than a fortune.
 *
 * The drift worry the bead raised — *"part five opens on a copy of a copy of a
 * copy"* — is not what this bounds, and it is worth saying so here because the
 * two are easy to confuse. Every middle re-pins her likeness at `last`, so each
 * generation re-anchors instead of accumulating error; that was listed as the
 * mitigation to test and it is how the plan is built. Raise this number when a
 * render proves the chain holds further, and lower it if one proves it does not
 * — either way with the render named, the same as every other number in here.
 */
export const MAX_PARTS = 6;

/** How often a render in flight is asked about. */
const POLL_MS = 5_000;

/**
 * How many times a generation is asked about before it is written off.
 *
 * 240 polls at five seconds is twenty minutes, against a job Runway finishes in
 * two or three. **Per generation**, so a render made in halves waits up to
 * twenty minutes for each of them: they are separate jobs on Runway's queue and
 * a shared deadline would write off a second half for the first one's slowness.
 * It exists so a task that will never answer becomes a `failed` record with a
 * reason rather than a record that says `rendering` forever —
 * which is the render-shaped version of constraint 4: a late render is a
 * nuisance, one that silently never arrives destroys the point of asking.
 *
 * Counted in **attempts rather than against the clock**, and that is not a
 * detail. This loop's only pause is {@link RenderServiceOptions.sleep}, which a
 * test replaces with nothing — so a wall-clock deadline on a frozen test clock
 * is a deadline that never arrives, and the loop spins forever. Attempts are
 * the quantity this code actually controls.
 */
const GIVE_UP_AFTER_POLLS = 240;

export interface RenderServiceOptions {
  readonly studio: Studio;
  /**
   * What she looks like and what her clips open on, as things she chooses.
   *
   * Optional, and built from the studio when it is absent, because a wardrobe
   * is entirely a function of her home — there is nothing a caller could supply
   * that this could not work out. The seam exists so a test can hold the clock
   * still, not so two of them can disagree about which face is hers.
   */
  readonly wardrobe?: Wardrobe;
  /**
   * The sentence her renders open with, as a thing she sets (`syl-hll6`).
   *
   * Optional and built from the studio when absent, for exactly the reason the
   * wardrobe is: it is entirely a function of her home, so there is nothing a
   * caller could supply that this could not work out. The seam exists so a test
   * can hold the clock still — not so two of them can disagree about how she is
   * described, which is the defect this whole change is about.
   */
  readonly description?: SelfDescription;
  /** `null` on a machine with no `RUNWAYML_API_SECRET`, which is most of them. */
  readonly backend: RenderBackend | null;
  readonly clock?: Clock;
  /** Injected so a test's state machine runs in microseconds. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly giveUpAfterPolls?: number;
  /**
   * How this service runs ffmpeg. Injected so the suite needs neither ffmpeg
   * nor a real mp4.
   *
   * One seam for all three uses — pulling stills she can look at, taking the
   * closing frame off a half, and joining the halves — because they are the
   * same program with different argv, and two seams would be two things to
   * remember to double.
   */
  readonly ffmpeg?: FrameRunner;
  /**
   * How this service runs ffprobe. Injected for the same reasons ffmpeg is.
   *
   * A **second** seam rather than a widening of the one above, because a probe's
   * answer is its stdout and `FrameRunner` throws stdout away. See `probe.ts`.
   */
  readonly ffprobe?: ProbeRunner;
  /**
   * Arrange to come back and look at this render.
   *
   * Called once per render, immediately after the record is written and before
   * anything is polled — so the promise to look at it exists from the same
   * moment the render does, and a process that dies in the next second still
   * leaves something that will bring her back to it.
   *
   * The Commander's ruling, 2026-08-11: *"when Syl triggers a video to be
   * rendered she needs some kind of wake up mechanism five minutes later"*.
   * This is the seam where that is arranged. A function rather than a store,
   * so this module keeps knowing nothing about the database — and so the suite
   * can watch it being called without one.
   */
  readonly watch?: (record: RenderRecord) => void;
  readonly onError?: (error: unknown, name: string) => void;
}

export class RenderService {
  readonly #studio: Studio;
  readonly #wardrobe: Wardrobe;
  readonly #description: SelfDescription;
  readonly #backend: RenderBackend | null;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pollMs: number;
  readonly #giveUpAfterPolls: number;
  readonly #ffmpeg: FrameRunner;
  readonly #ffprobe: ProbeRunner;
  readonly #watch: ((record: RenderRecord) => void) | undefined;
  readonly #onError: (error: unknown, name: string) => void;
  /** Renders being followed right now, so `drain` can wait for them. */
  readonly #inFlight = new Set<Promise<void>>();

  constructor(options: RenderServiceOptions) {
    this.#studio = options.studio;
    this.#clock = options.clock ?? systemClock;
    this.#wardrobe =
      options.wardrobe ?? new Wardrobe({ studio: options.studio, clock: this.#clock });
    this.#description =
      options.description ?? new SelfDescription({ studio: options.studio, clock: this.#clock });
    this.#backend = options.backend;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollMs = options.pollMs ?? POLL_MS;
    this.#giveUpAfterPolls = options.giveUpAfterPolls ?? GIVE_UP_AFTER_POLLS;
    this.#ffmpeg = options.ffmpeg ?? ffmpegRunner;
    this.#ffprobe = options.ffprobe ?? ffprobeRunner;
    this.#watch = options.watch;
    this.#onError =
      options.onError ??
      ((error, name): void => {
        console.warn(`[syl] following the render ${name} threw: ${String(error)}`);
      });
  }

  /** Whether this machine can render at all. */
  get available(): boolean {
    return this.#backend !== null;
  }

  /**
   * Ask for a render, and come straight back.
   *
   * The order is load-bearing. Everything that can refuse refuses **before** a
   * credit is spent: the scene, the framing, the reason, the reference on disk.
   * Then the submission. Then the record — written before the first poll, so a
   * process that dies in the next second still leaves the prompt behind.
   */
  async start(input: StartInput): Promise<StartResult> {
    // The scene may be ONE sentence or one PER PART, and how many parts there
    // are is not known until the model and framing are settled below. So this
    // only catches the obviously-absent case; `scenesForParts` does the real
    // resolution once `generations` exists, and still before anything is spent.
    if (typeof input.scene === "string" && input.scene.trim() === "") {
      return {
        ok: false,
        reason: "I did not catch the scene — describe what you are doing in it, in a sentence.",
        retryable: true,
      };
    }

    const framing = framingNote(input.framing);
    if (framing === null) {
      return {
        ok: false,
        reason:
          `"${String(input.framing)}" is not one of the framings. They are: ${FRAMING_IDS.join(", ")} — ` +
          "and the first two are the ones the reference can hold you at.",
        retryable: true,
      };
    }

    const because = input.because.trim();
    if (because === "") {
      return {
        ok: false,
        reason: "Every render says why it exists, the same as everything else you make.",
        retryable: true,
      };
    }

    // WHICH MODEL, AND WHAT IT CANNOT DO — before a credit is spent, and both
    // answers derived from the registry rather than from a list of names kept
    // here. `syl-023`.
    const named = (input.model ?? "").trim();
    const model = named === "" ? HOUSE_MODEL : modelNote(named);
    if (model === null) {
      return {
        ok: false,
        reason:
          `"${named}" is not a model I can render on. The ones I have are: ${MODEL_IDS.join(", ")} — ` +
          `and ${HOUSE_MODEL.id} is what makes my renders when I do not say.`,
        retryable: true,
      };
    }

    // THE REFUSAL THAT MATTERS, and it is arithmetic. A framing whose subject
    // is her face is anchored at the join, and both halves of a join pin a
    // picture at `last` — so a model with no `last` slot cannot render either
    // one. `grok_imagine_1_5` was not reasoned about, it was RENDERED on
    // 2026-08-13, and the closing frame came back a visibly different woman.
    //
    // It derives from `canAnchorLikeness`, which derives from `positions`, so a
    // model added to the roster tomorrow is covered without anybody editing
    // this branch — and it says what the model CANNOT DO rather than that it is
    // not allowed, because she may experiment freely and may not be quietly
    // handed somebody else.
    if (framing.anchor !== "none" && !canAnchorLikeness(model)) {
      return {
        ok: false,
        reason:
          `${model.id} takes ${String(model.positions.length)} keyframe ` +
          `(${model.positions.join(", ")}), so there is nowhere in the clip to pin my face. At ` +
          `${framing.id} the model would invent one and hand you a stranger — that is what it did ` +
          "on 2026-08-13, at full price. Nothing has been spent. Render this framing on a model " +
          `with a last keyframe (${HOUSE_MODEL.id} is mine), or ask for ${TEMPLATE_FRAMING}, ` +
          `which shows no face and which ${model.id} can make.`,
        retryable: true,
        // The finding, in a shape something can keep. The arity is the durable
        // part; the model's name is only where it was observed.
        evidence: { model: model.id, keyframes: model.positions.length },
      };
    }

    // HOW MANY GENERATIONS, which decides the length ceiling: a clip cut
    // together out of N parts reaches N times as far as one. Known here because
    // it follows from the framing and one dial, before any picture is looked up.
    //
    // An unanchored shot is one generation and cannot be chained. That is
    // MECHANICAL rather than a matter of taste, which is why it is refused
    // instead of rounded down: a middle part ends on her face and must pin one,
    // and a framing that shows no face has nothing to pin — 2026-08-13 measured
    // what an unpinned closing frame gives back. It is also the Commander's
    // complaint by construction, because chaining a loop framing is
    // ribbon-her-ribbon-her-ribbon, the very structure `MIDDLE_CLAUSE` exists to
    // remove.
    const generations = framing.anchor === "none" ? 1 : (input.parts ?? 2);
    if (framing.anchor === "none" && input.parts !== undefined && input.parts !== 1) {
      return {
        ok: false,
        reason:
          `${framing.id} shows no face, so there is nothing to pin at a join and no way to make ` +
          "it out of more than one generation. Chaining it would put the ribbon between every " +
          "part — arrive, vanish, arrive, vanish — which is the structure he told me feels " +
          `disjointed. Ask for ${framing.id} in one piece, or for a shot of my face in parts.`,
        retryable: true,
      };
    }
    if (
      framing.anchor !== "none" &&
      (!Number.isInteger(generations) || generations < 2 || generations > MAX_PARTS)
    ) {
      return {
        ok: false,
        reason:
          `A shot of my face is cut from between 2 and ${String(MAX_PARTS)} generations — ` +
          `${String(input.parts)} is not one of those. Two is the ribbon gathering into me and ` +
          "me unravelling back into it; every part past that is held on my face and touches the " +
          "ribbon at neither end, so a longer clip still passes through the starfield exactly " +
          "twice. It does not multiply the bill — the seconds are split across the parts, not " +
          `repeated by them — but each part has a ${String(MAX_PARTS)}-part ceiling and a ` +
          "minimum length, so more parts than the clip has room for pads each one up.",
        retryable: true,
      };
    }
    const ceiling = maxSecondsFor(model, generations);
    // THE FLOOR IS ONE GENERATION'S, NOT TWO, and that asymmetry is deliberate.
    // A joined shot cannot really be shorter than two of the model's shortest —
    // but asking for five and being refused teaches her nothing, while asking
    // for five and being told the clip is eight is a dial she can read back
    // even when it did not do what she asked. `splitAcross` rounds up and
    // `duration` on the record is the shares added up, so the number she is
    // told stays the number that was made.
    const floor = model.duration.min;

    // The one length dial, checked against what THIS MODEL actually makes.
    // Refused before anything is spent rather than after the first half of a
    // joined render is already bought.
    const seconds = input.seconds ?? Math.min(DEFAULTS.duration, ceiling);
    if (!Number.isInteger(seconds) || seconds < floor || seconds > ceiling) {
      return {
        ok: false,
        reason:
          `A clip on ${model.id} is a whole number of seconds between ${String(floor)} and ` +
          `${String(ceiling)} — ${String(seconds)} is not one. ` +
          (generations > 1
            ? `A shot of my face is ${String(generations)} generations cut together, each ` +
              `${String(model.duration.min)}-${String(model.duration.max)}s, which is where those ` +
              "numbers come from."
            : `That is ${model.id}'s own range, measured against the API.`),
        retryable: true,
      };
    }

    // ONE SCENE SENTENCE PER PART, resolved now that the part count is known and
    // still before a credit is spent. A single string goes to every part; an
    // array must match exactly and is never padded — see `scene-lines.ts`.
    const lines = scenesForParts(input.scene, generations);
    if (!lines.ok) {
      return { ok: false, reason: lines.reason, retryable: true };
    }
    const scenes = lines.scenes;
    // What she ASKED FOR, for the record — derived from the SHAPE SHE SENT, not
    // from the resolved per-part array. Those differ exactly where it matters:
    // one sentence across three parts resolves to three identical entries, and
    // joining those would store her words three times. That is the very
    // duplication this change exists to remove, one layer down, and
    // `should keep her own words for the scene beside the prompt they became`
    // caught it. Each part's own composed prompt is kept verbatim on the part,
    // so per-part wording stays answerable either way.
    const scene = typeof input.scene === "string" ? input.scene.trim() : scenes.join("\n\n");

    if (this.#backend === null) {
      return {
        ok: false,
        reason:
          "There is no RUNWAYML_API_SECRET on this machine, so I have no way to render anything. " +
          "Nothing has been spent and nothing has been made.",
        retryable: false,
      };
    }

    // The picture that is actually sent, and therefore the video's first frame
    // AND the video's shape. Hers to choose since `syl-ate`: the ribbon unless
    // she names another, because that is her signature and what every clip in
    // the reel opens on.
    const opening = this.#wardrobe.opening(input.opening);
    // Checked rather than assumed: without a picture there is nothing to start
    // the clip from, and the failure mode of getting this wrong is not an error
    // — it is fifteen seconds that open on the wrong thing, at full price.
    //
    // TWO REFUSALS WEARING ONE SHAPE, and one of them is hers to fix. A name
    // she got wrong is answered with the list; the ribbon missing off the disk
    // is answered with the path, because there is nothing she can retry.
    if (opening === null || !existsSync(opening.path)) {
      const named = (input.opening ?? "").trim();
      if (named === "" || opening !== null) {
        return {
          ok: false,
          reason:
            `The opening my clips would start on is not where it should be ` +
            `(${opening?.path ?? this.#studio.opening()}). It is the first frame of every render ` +
            "— without it the video would begin somewhere else, and it would not cut against the " +
            "others.",
          retryable: false,
        };
      }
      return {
        ok: false,
        reason:
          `I do not have an opening called "${named}". The ones I have are: ` +
          `${this.#wardrobe.openings().map((one) => one.id).join(", ")}. Leave it out for the ` +
          "ribbon, which is what the reel opens on.",
        retryable: true,
      };
    }

    // The picture that pins her face, for the framings that need one. A shot
    // whose subject is her face and which has nothing holding that face is the
    // `8-descent` failure by construction — a visibly different woman, at full
    // price — so it is refused here rather than discovered on the other side.
    // Only for the framings that need it: `face_turned_away` holds without a
    // face at all, and must not stop working because a likeness is missing.
    let anchor: string | null = null;
    if (framing.anchor !== "none") {
      const chosen = this.#wardrobe.face();
      if (chosen === null) {
        // TWO DIFFERENT REFUSALS, AND THEY MUST NOT WEAR ONE SENTENCE. Either
        // there is no likeness on this machine at all, or the log of what she
        // has adopted cannot be read — and in the second case falling back to
        // the picture he guessed would be the silent change of face the
        // Commander forbade, at full price, on a render she would then judge.
        const problems = this.#wardrobe.problems();
        return {
          ok: false,
          reason:
            problems.length > 0
              ? `${problems.join(" ")} So I will not render a shot of my face until that file is readable.`
              : `This shot is my face, and there is no picture of me on this machine to hold it ` +
                `(nothing at ${this.#studio.reference()}). Without one the model has nothing to ` +
                "copy and would give you somebody else. Nothing has been spent.",
          retryable: false,
        };
      }
      if (!existsSync(chosen.path)) {
        return {
          ok: false,
          reason:
            `This shot is my face, and the picture I chose to hold it is not where it should be ` +
            `(${chosen.path}). Without it the model has nothing to copy and would give you ` +
            "somebody else. Nothing has been spent.",
          retryable: false,
        };
      }
      anchor = chosen.path;
    }

    // WHICH FACE EACH HELD MIDDLE CLOSES ON — the separately addressable closing
    // keyframe, resolved before a credit is spent for the same reason the anchor
    // is. Absent and empty both mean the anchor, so the dial is opt-in and a
    // render she said nothing about is unchanged.
    //
    // Every value it can take is a picture of HER, which is what keeps
    // `MIDDLE_CLAUSE` true of whatever ends up pinned: the sentence says the
    // shot closes on her face, and a dial that could move the frame out from
    // under those words would be the prose-versus-pins contradiction rearmed.
    const middles = Math.max(0, generations - 2);
    const wanted = input.held ?? [];
    if (wanted.length > middles) {
      return {
        ok: false,
        reason:
          `I was given ${String(wanted.length)} faces to hold on and a shot in ` +
          `${String(generations)} parts only has ${String(middles)} held ` +
          `${middles === 1 ? "part" : "parts"} in it — the first and the last belong to the ` +
          "ribbon. Nothing has been spent; say which parts you meant, or ask for more of them.",
        retryable: true,
      };
    }
    const held: string[] = [];
    for (let index = 0; index < middles; index += 1) {
      const name = (wanted[index] ?? "").trim();
      if (name === "" && anchor !== null) {
        held.push(anchor);
        continue;
      }
      const chosen = this.#wardrobe.faces().find((face) => face.id === name);
      if (chosen === undefined || !existsSync(chosen.path)) {
        return {
          ok: false,
          reason:
            `I do not have a face called "${name}" to hold part ${String(index + 2)} on. The ones ` +
            `I have are: ${this.#wardrobe.faces().map((face) => face.id).join(", ")}. Leave it ` +
            "out for the one this shot is already anchored on. Nothing has been spent.",
          retryable: true,
        };
      }
      held.push(chosen.path);
    }

    // DERIVED FROM THE OPENING, never written down beside it. `promptImage`
    // decides the aspect and overrules this field without saying so, so the
    // only thing `ratio` can do is agree with the picture or lie about it —
    // and it lied for a day, saying `720:1280` above a stream of landscape
    // videos. The fallback is the shape the seed ribbon is; every opening she
    // adopts has a readable shape, because `Wardrobe.keep` refuses one that
    // does not.
    const ratio = opening.ratio ?? DEFAULTS.ratio;

    // WHICH KEY THE GEOMETRY TRAVELS UNDER. `ratio` for every seedance; a
    // resolution band for a model that has no `ratio` key at all. The record
    // keeps `ratio` either way, because `ratio` is the shape the video actually
    // has — the opening decides that on every model — and `resolution` records
    // what was additionally sent.
    const geometry = this.#geometryFor(model, ratio);
    if (geometry === null) {
      return {
        ok: false,
        reason:
          `${model.id} is shaped by a resolution and the roster lists none for it, so I do not ` +
          "know what size to ask for. Nothing has been spent.",
        retryable: false,
      };
    }

    const now = this.#clock();
    const name = this.#nameFor(now, framing.id);
    const planned = this.#plan({
      name,
      framing,
      model,
      scenes,
      opening: opening.path,
      anchor,
      seconds,
      parts: generations,
      held,
    });

    // Only the FIRST half goes over now. The second one starts from the frame
    // the first one ends on, so it cannot be submitted until that frame exists
    // — which is also what keeps the failure story simple: nothing has been
    // spent when this refuses, exactly as before.
    const head = planned[0];
    if (head === undefined) {
      // `#plan` always returns at least one generation. Checked rather than
      // cast, because a cast is a promise to the compiler and this file
      // already carries the scar of one that was not kept.
      return { ok: false, reason: "I could not work out how to make that shot.", retryable: false };
    }
    const submitted = await this.#backend.submit({
      model: model.id,
      promptImage: this.#promptImage(head, model),
      promptText: head.prompt,
      duration: head.duration,
      ...geometry,
    });

    if (!submitted.ok) {
      // Nothing is written. A record left saying `rendering` for a task that was
      // never created would be chased by `resume` forever, and would read to her
      // as a render still in flight that will never arrive.
      return { ok: false, reason: submitted.failure.message, retryable: submitted.failure.retryable };
    }

    const parts: RenderPart[] = planned.map((part, index) => ({
      taskId: index === 0 ? submitted.data.id : null,
      prompt: part.prompt,
      duration: part.duration,
      first: this.#relativeTo(part.first),
      last: part.last === null ? null : this.#relativeTo(part.last),
      video: null,
      // AT THE CHOSEN MODEL'S RATE, never at a constant. 30 credits a second
      // against 36 is 90 credits on one ordinary fifteen-second render, and a
      // price that silently belonged to the old model is this project's
      // signature defect.
      credits: creditsFor({ model: model.id, seconds: part.duration, ...geometry }),
      status: "rendering",
      failureCode: null,
      failure: null,
      // Nothing has been charged that anyone has told us about yet. The number
      // arrives with the task, so until then this render is `unpriced` rather
      // than priced at what we think it will cost.
      charged: null,
    }));

    const record: RenderRecord = {
      name,
      status: "rendering",
      renderedAt: null,
      taskId: submitted.data.id,
      model: model.id,
      ratio,
      resolution: bandOf(geometry),
      keyframes: model.positions.length,
      duration: planned.reduce((total, part) => total + part.duration, 0),
      reference: this.#relativeTo(opening.path),
      anchor: anchor === null ? null : this.#relativeTo(anchor),
      framing: framing.id,
      prompt: planned.map((part) => part.prompt).join("\n\n"),
      scene,
      holdsLikeness: holdsLikeness(framing, anchor === null ? null : this.#relativeTo(anchor)),
      because,
      startedAt: instant(now),
      reason: null,
      ...billed(parts),
      video: null,
      parts,
      // Generated, not assembled. `null` rather than `[]`: see the field.
      joinedFrom: null,
    };

    this.#write(record);
    // The promise to come back and look, arranged before the first poll. It is
    // wrapped because a render has already cost a credit by this point: a watch
    // that could not be written must never turn a submitted render into a
    // refusal, and the failure is loud rather than swallowed.
    try {
      this.#watch?.(record);
    } catch (error) {
      this.#onError(error, record.name);
    }
    this.#follow(record);
    return { ok: true, record };
  }

  /**
   * Cut finished renders into one clip — `syl-5y4n`.
   *
   * ## Why this mints a RENDER rather than a new kind of thing
   *
   * Because `video` on a record is already documented as *"the joined clip, if
   * it was joined"*, so a join that writes a record is something every reader
   * downstream already understands: `see_myself` pulls stills out of it,
   * `show_him` takes it by name, `GET /renders/{name}` answers for it, and none
   * of them changes by a line. A join that produced anything else would have
   * needed all four taught about a second sort of clip.
   *
   * ## The engineering is the REFUSAL, not the concatenation
   *
   * `joinVideos` has always taken an array. What is new is that the parts are
   * separately made renders, and `-c copy` is only safe while they agree — see
   * `probe.ts`, which has the measurement and the trap behind it. A mismatched
   * concat exits zero and writes a broken file, so nothing downstream would
   * catch it and she would send him a corrupt minute. **Refusing, with a
   * sentence naming which renders disagree and how, is the deliverable.**
   *
   * ## Nothing is written until the mp4 exists
   *
   * The opposite of {@link RenderService.start}, deliberately, and the reason
   * is the same rule reaching a different answer. A render's sidecar is written
   * at submission because credits are already spent and a process that dies in
   * the next second must leave behind the prompt that bought them. A join
   * spends nothing, so there is nothing to preserve early — and a record
   * pointing at a video that was never written is exactly the "record asserting
   * what the system did not observe" defect this file's header is about.
   *
   * @param input The renders by name in playing order, and why she made it.
   */
  async join(input: JoinInput): Promise<JoinRendersResult> {
    const because = input.because.trim();
    if (because === "") {
      return {
        ok: false,
        reason: "Every render says why it exists, the same as everything else you make.",
        retryable: true,
      };
    }

    const names = input.renders.map((name) => name.trim()).filter((name) => name !== "");
    if (names.length < 2) {
      return {
        ok: false,
        reason:
          `A join is two or more finished renders cut into one, and I was given ${String(names.length)}. ` +
          "Name them by their own names, in the order they play.",
        retryable: true,
      };
    }

    const sources: RenderRecord[] = [];
    for (const name of names) {
      // `latest` IS RESOLVED EVERYWHERE ELSE AND REFUSED HERE, for the reason
      // `show_him` refuses it: the joined record keeps the names it was made
      // with forever, and "whatever was made most recently" stops being the
      // render she meant the moment anything else writes a record — including,
      // one second later, this very join.
      if (name === "latest") {
        return {
          ok: false,
          reason:
            "I cannot cut in `latest` — a join keeps the names it was made from forever, and " +
            "`latest` means whatever record was written most recently, which will be this join " +
            "itself. Name each render by its own name.",
          retryable: true,
        };
      }

      const record = this.get(name);
      if (record === null) {
        return {
          ok: false,
          reason: `There is no render called "${name}" that I can read, so there is nothing of it to cut in.`,
          retryable: true,
        };
      }
      if (record.status !== "ready" || record.video === null) {
        return {
          ok: false,
          reason:
            `"${name}" ${
              record.status === "rendering"
                ? "is still rendering"
                : `did not finish: ${record.reason ?? "no reason was recorded"}`
            }, so there is nothing of it to cut in.`,
          retryable: true,
        };
      }
      // Asked of the DISK rather than of the record, for the reason
      // `settledStatus` exists: what a render can be shown to be beats what is
      // written beside it, and `joinVideos` would find this out later with the
      // name already minted.
      if (!existsSync(record.video)) {
        return {
          ok: false,
          reason:
            `"${name}" is recorded as finished and its file is not on this disk ` +
            `(${record.video}), so I cannot cut it in.`,
          retryable: false,
        };
      }
      sources.push(record);
    }

    const first = sources[0];
    if (first === undefined || first.video === null) {
      return { ok: false, reason: "There is nothing to join.", retryable: true };
    }

    // WHAT THE FILES ACTUALLY ARE. Never what the records asked for: `ratio` is
    // the ask, and the ask is silently overruled by the opening picture, so a
    // check against the record would pass on precisely the renders it exists to
    // catch. See `probe.ts`.
    const probed: JoinPart[] = [];
    for (const record of sources) {
      const shape = await probeClip({ video: record.video ?? "", run: this.#ffprobe });
      if (!shape.ok) {
        return {
          ok: false,
          // An unreadable part is refused rather than assumed to match. The
          // safe direction: absence of a disagreement is not agreement.
          reason: `${shape.reason} So I have not cut anything, and nothing has been spent.`,
          retryable: false,
        };
      }
      probed.push({ name: record.name, shape: shape.shape });
    }

    const disagreement = whyTheyDoNotCutTogether(probed);
    if (disagreement !== null) return { ok: false, reason: disagreement, retryable: true };

    const now = this.#clock();
    const name = this.#nameFor(now, JOIN_KIND);
    const to = this.#studio.video(name);
    const joined = await joinVideos({
      parts: sources.map((record) => record.video ?? ""),
      to,
      listFile: this.#studio.partList(name),
      run: this.#ffmpeg,
    });
    if (!joined.ok) {
      // No record is written. There is no footage to lose — every part is still
      // on disk under its own record — so a sidecar here would be a render that
      // claims to exist, reachable from `latest`, with nothing behind it.
      return { ok: false, reason: joined.reason, retryable: false };
    }

    const record = joinedRecord({
      name,
      sources,
      shape: probed[0]?.shape ?? null,
      video: to,
      because,
      at: instant(now),
      joinedFrom: names,
    });
    this.#write(record);
    return { ok: true, record };
  }

  /** One render, or `null` for a name that is not one, or a record she cannot read. */
  get(name: string): RenderRecord | null {
    if (!isRenderName(name)) return null;
    return this.#read(name);
  }

  /** Every render she has made, newest first. Readable ones only. */
  list(): readonly RenderRecord[] {
    return this.#scan().records;
  }

  /**
   * The sidecars that are not records, so nothing of hers goes missing quietly.
   *
   * The other half of refusing to guess. A file the service cannot parse must
   * not be reported as a failed render — but it must not vanish from her ledger
   * either, because `SOUL.md` says every attempt is kept and a render she is
   * never told about is one she cannot go and look for.
   */
  unreadable(): readonly UnreadableRender[] {
    return this.#scan().unreadable;
  }

  /**
   * The most recent render, so `latest` means something.
   *
   * **Never a record she cannot read.** This is the failure `see_myself` told
   * her about: a hand-written sidecar with no `startedAt` sorted to the front of
   * the list and no `status`, so asking to look at her latest render answered
   * *"did not finish: no reason was recorded"* about a render that was still in
   * flight. Her own words: *"that's the sort of thing that would make me tell
   * you a render failed when it hadn't, which is exactly the kind of lie I'm
   * not willing to tell you."* `list()` now holds records only, so the question
   * "which is most recent" is asked of things that have an answer.
   */
  latest(): RenderRecord | null {
    return this.list()[0] ?? null;
  }

  /**
   * What she has spent, totalled over the records.
   *
   * **Every number here is one Runway reported, never one we worked out.** This
   * used to price a render from our own rate card, defended by a line in
   * `RUNWAY_API_INDEX.md` saying a moderated generation still costs full
   * credits with no refund — so a failed render counted in full, on the
   * argument that understating the bill is the one direction an honest ledger
   * must not err in.
   *
   * The argument was sound and the premise was not: the tasks behind the 23-24
   * August failures were charged **zero**. Every failure she has ever had was
   * therefore billed to him at the rate card, and she reported a number that
   * was ours rather than hers.
   *
   * The fix is not the opposite belief — "a failure costs nothing" is just as
   * much a guess about somebody else's billing. Runway states the charge on
   * every task, so we carry no belief at all: see {@link RenderPart.charged}.
   * That answer is true under either policy and survives Runway changing it.
   *
   * A render whose charge nobody reported is `unpriced` rather than free, so
   * the total is legible as a floor with its gaps named beside it.
   */
  spend(): Spend {
    const { records, unreadable } = this.#scan();
    let credits = 0;
    let seconds = 0;
    let unpriced = 0;

    for (const record of records) {
      // The seconds that were BOUGHT, not the seconds the render was going to
      // be. They are the same number for every render that finished; they
      // differ for one whose second half never reached Runway, and the ledger
      // is the place where that difference has to be the truth.
      //
      // **A JOIN BUYS NOTHING** (`syl-5y4n`), so its seconds are counted under
      // the renders it was cut from and not again here. Its footage is real and
      // it is not new footage: cutting a minute out of four fifteen-second
      // clips she already has would otherwise report two minutes bought. The
      // credits look after themselves — a joined record's total is a genuine
      // zero — but the seconds would double, and this is the ledger.
      if (record.joinedFrom === null) {
        seconds += record.parts.filter(wasBought).reduce((total, part) => total + part.duration, 0);
      }
      if (record.credits === null) unpriced += 1;
      else credits += record.credits;
    }

    return {
      renders: records.length,
      ready: records.filter((record) => record.status === "ready").length,
      failed: records.filter((record) => record.status === "failed").length,
      // Counted apart from the failures, because these bought footage that
      // exists. Filing them under `failed` is the ledger saying the money
      // bought nothing.
      partial: records.filter((record) => record.status === "partial").length,
      rendering: records.filter((record) => record.status === "rendering").length,
      seconds,
      credits,
      usd: usdOf(credits),
      unpriced,
      // Counted rather than dropped, and for the same reason as `unpriced`: a
      // total is only honest if what it could not account for is visible beside
      // it. A sidecar that cannot be read may well have cost credits.
      unreadable: unreadable.length,
    };
  }

  /**
   * Look at a render.
   *
   * Refuses an unfinished one rather than answering with no frames: "there is
   * nothing to see yet" and "I looked and there is nothing there" are different
   * facts about her own face, and only one of them means wait.
   *
   * **A `partial` render is looked at, not refused.** This verb is what "the
   * footage is still reachable" has to mean: she cannot watch an mp4 — she
   * looks at stills pulled out of one — so a half she cannot pull a still from
   * is a half she cannot see, whatever the sidecar says is on disk. What comes
   * back then is the surviving generation, with {@link LookedAt} saying which
   * one it was, so she is never shown half a render believing it is the clip.
   */
  async frames(name: string, at?: number): Promise<
    | {
        readonly ok: true;
        readonly record: RenderRecord;
        readonly frames: ExtractResult;
        /** Which footage the stills came out of. `null` means the whole clip. */
        readonly looked: LookedAt | null;
      }
    | { readonly ok: false; readonly reason: string; readonly status: "missing" | "unfinished" | "unreadable" }
  > {
    const loaded = name === "latest" ? this.#loadLatest() : this.#load(name);
    if (loaded === null) {
      return { ok: false, reason: "There is no render by that name.", status: "missing" };
    }
    if (!loaded.ok) {
      // **Not "did not finish".** A record the service cannot read says nothing
      // at all about how the render went, and inventing a reason to fill the
      // sentence is how she came to report a render in flight as a failure. The
      // file is named because that is the thing a person can go and look at.
      return {
        ok: false,
        status: "unreadable",
        reason:
          `I cannot read the record for "${loaded.unreadable.name}" — ${loaded.unreadable.why}. ` +
          `The file is ${loaded.unreadable.file}. So I do not know how that render went, and I ` +
          "am not going to guess: it may still be in flight.",
      };
    }

    const record = loaded.record;
    // The half that was made and paid for, when the clip itself was not.
    const salvaged = record.status === "partial" ? (salvagedParts(record)[0] ?? null) : null;
    const looked: LookedAt | null =
      salvaged === null || salvaged.video === null
        ? null
        : {
            video: salvaged.video,
            seconds: salvaged.duration,
            part: record.parts.indexOf(salvaged) + 1,
            parts: record.parts.length,
          };

    if (looked === null && (record.status !== "ready" || record.video === null)) {
      return {
        ok: false,
        status: "unfinished",
        reason:
          record.status === "rendering"
            ? `"${record.name}" is still rendering, so there is nothing to look at yet.`
            : `"${record.name}" did not finish: ${record.reason ?? "no reason was recorded."}`,
      };
    }

    return {
      ok: true,
      record,
      looked,
      frames: await extractFrames({
        // The clip when there is one, and the surviving half when there is not.
        // The half's OWN length, never the render's: spreading four stills
        // across eight seconds of a four-second file asks ffmpeg for frames
        // past the end of it.
        video: looked?.video ?? record.video ?? "",
        seconds: looked?.seconds ?? record.duration,
        ...(at === undefined ? {} : { at }),
        outDir: this.#studio.frames(record.name),
        run: this.#ffmpeg,
      }),
    };
  }

  /**
   * Pick up renders a restart interrupted.
   *
   * The sidecar holds the task id, which `generate.mjs` keeps for exactly this
   * reason: it is the only handle Runway will accept for chasing a render up
   * later. Without this a service restart during a render leaves a record
   * saying `rendering` forever, and she would tell him something was coming
   * that never was.
   */
  resume(): void {
    for (const record of this.list()) {
      // Any half with a handle is worth picking up — including a render whose
      // FIRST half is already on disk and whose second was never submitted,
      // which is the state a restart between two generations leaves behind.
      if (record.status === "rendering" && record.parts.some((part) => part.taskId !== null)) {
        this.#follow(record);
      }
    }
  }

  /** Wait for every render in flight. For tests and for a clean shutdown. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
  }

  // -------------------------------------------------------------------------

  /**
   * The generations a render is made of, before any of them is sent.
   *
   * One when nothing needs pinning, which is the reel template and both of the
   * framings that drift. **Two or more when her face is the subject**, because
   * both keyframe slots then go to the ribbon — one at each end of the finished
   * clip — and her likeness has to live at the joins instead. `join.ts` records
   * the probes that leave no third option.
   *
   * ## The shape, and the property that decides it
   *
   *     ribbon -> her -> [held] -> ... -> her -> ribbon
   *
   * The first part gathers, the last unravels, and everything between is a
   * {@link MIDDLE_CLAUSE} part pinned to a picture of her at **both** ends. So
   * the ribbon is pinned exactly twice however many parts there are —
   * **two passes through the starfield regardless of clip length**, which is the
   * Commander's disjointedness complaint removed rather than reduced, and the
   * thing `render-held-middle.test.ts` asserts at two, three and five parts.
   *
   * ## Why the clause and the pins are built together
   *
   * Each part is one object binding a sentence to the frames that sentence is
   * true about, and there is deliberately no way to set one without the other.
   * A clause reading *"closes on her face"* is only coherent if `last` pins her
   * face — and since the pin wins at the ends (measured 2026-08-30), a mismatch
   * does not fail loudly. It plays out in the interior, where nobody sees it
   * coming. `LOOP_CLAUSE` argued with its own keyframes for two renders exactly
   * that way.
   */
  #plan(input: {
    readonly name: string;
    readonly framing: FramingNote;
    /** The chosen model, because the split has to land inside ITS range. */
    readonly model: ModelNote;
    /** One scene sentence per part, in order — already validated to match. */
    readonly scenes: readonly string[];
    readonly opening: string;
    readonly anchor: string | null;
    /** What she asked for, already checked against the chosen model's range. */
    readonly seconds: number;
    /** How many generations, already checked against {@link MAX_PARTS}. */
    readonly parts: number;
    /** What each held middle closes on, one per middle, already resolved to a file. */
    readonly held: readonly string[];
  }): readonly PlannedPart[] {
    // HER SENTENCE, read at plan time rather than captured at construction, so
    // a description she changes is in effect on the very next render instead of
    // on the next restart. The whole prompt still lands in the sidecar, so which
    // description a given render was made with stays answerable afterwards.
    // ONE STEM PER PART, because the scene may differ between them. It used to
    // be built once and copied, which is how "once and only once" was obeyed
    // twice — each part received the instruction and each honoured it. See
    // `scene-lines.ts` for why no wording could have fixed that.
    const stemFor = (index: number): string =>
      `${this.#description.sentence()} ${input.scenes[index] ?? input.scenes[0] ?? ""} ${input.framing.clause}`;

    if (input.anchor === null) {
      // BOTH SLOTS GO TO THE OPENING. There is no face in this shot to pin, so
      // nothing else wants the `last` keyframe — and a keyframe left empty is a
      // frame the model decides. It decided wrong:
      // `syl-20260813t042030321z-face-turned-away.mp4` ended on empty starfield
      // with no ribbon in it, because {@link LOOP_CLAUSE} was *asking* for the
      // closing ribbon in prose while the anchored path was *pinning* its own.
      // The same picture at both ends makes the loop true by construction,
      // which is the rule `docs/VIDEO.md` was written to record.
      return [
        {
          prompt: `${stemFor(0)} ${LOOP_CLAUSE}`,
          duration: input.seconds,
          first: input.opening,
          last: input.opening,
        },
      ];
    }

    const anchor = input.anchor;
    const shares = splitAcross(input.seconds, input.model, input.parts);
    return shares.map((duration, index) => {
      // Frame one: the ribbon for the opening generation, and otherwise the
      // frame the previous one ends on. That frame does not exist yet, and is
      // named here rather than left blank because the path is decided by the
      // render name: a record that says what WILL be sent is reproducible, and
      // one that says nothing is a hole somebody fills in with a guess.
      const first = index === 0 ? input.opening : this.#studio.partFrame(input.name, index);

      if (index === 0) {
        return { prompt: `${stemFor(index)} ${GATHERING_CLAUSE}`, duration, first, last: anchor };
      }
      if (index === shares.length - 1) {
        return { prompt: `${stemFor(index)} ${UNRAVELLING_CLAUSE}`, duration, first, last: input.opening };
      }
      // A HELD MIDDLE, and its closing pin is never omitted. `held` is one entry
      // per middle and was resolved before anything was spent; the fallback is
      // the anchor rather than `null`, because a middle ends on her face and an
      // unpinned closing frame came back a visibly different woman on
      // 2026-08-13. Distance from a pin is the drift variable.
      return {
        prompt: `${stemFor(index)} ${MIDDLE_CLAUSE}`,
        duration,
        first,
        last: input.held[index - 1] ?? anchor,
      };
    });
  }

  /**
   * The pictures a generation is given, in the shape Runway takes them.
   *
   * A bare string where only frame one is pinned — exactly what the eight loops
   * were sent — and the positioned array where both ends are.
   *
   * **Filtered to the slots the model declares.** `grok_imagine_1_5` answers
   * *"Too big: expected array to have <=1 items"* and *"Invalid input: expected
   * \"first\""* to the two-slot form, so a closing picture is dropped for a
   * model that has nowhere to put one. That is the same consequence
   * {@link canAnchorLikeness} refuses an anchored framing over, arriving at the
   * other end: a clip on such a model does not close on the ribbon either, and
   * it is derived from `positions` in both places rather than restated.
   *
   * `#plan` produces a closing picture for every generation, the unanchored one
   * with the same opening twice. The string branch survives for a sidecar
   * written before that, which names none, and which `resume` has to be able to
   * carry to the end in the shape it was actually submitted in.
   */
  #promptImage(
    part: { readonly first: string; readonly last: string | null },
    model: ModelNote,
  ): string | readonly PositionedImage[] {
    const pinned: PositionedImage[] = [];
    const takes = (position: KeyframePosition): boolean => model.positions.includes(position);

    if (takes("first")) pinned.push({ uri: this.#dataUri(part.first), position: "first" });
    if (part.last !== null && takes("last")) {
      pinned.push({ uri: this.#dataUri(part.last), position: "last" });
    }

    // One picture and nothing else is the bare-string form the eight loops were
    // sent in, and it is what a one-slot model wants.
    if (pinned.length === 1 && pinned[0]?.position === "first") return this.#dataUri(part.first);
    return pinned;
  }

  /**
   * Which key this model's geometry travels under, and what goes in it.
   *
   * `null` only for a `resolution`-shaped model the roster lists no bands for,
   * which cannot happen with the registry as it stands and is refused rather
   * than guessed if it ever does. Guessing `720p` here would put a size on the
   * wire that no probe measured and a price in her ledger that no balance
   * confirmed.
   */
  #geometryFor(model: ModelNote, ratio: string): Geometry | null {
    if (model.shape !== "resolution") return { ratio };
    const band = defaultResolution(model);
    return band === null ? null : { resolution: band };
  }

  /** Follow a submitted task to its end, without anybody awaiting it. */
  #follow(record: RenderRecord): void {
    const running = this.#poll(record)
      .catch((error: unknown) => {
        this.#onError(error, record.name);
        try {
          this.#stop(record, null, `Following this render threw: ${String(error)}`);
        } catch {
          // The record could not be updated either — the studio directory is
          // gone, or the disk is full. There is nowhere left to write the
          // truth, and throwing out of a `catch` in a detached promise would
          // take the process down with it.
        }
      })
      .finally(() => {
        this.#inFlight.delete(running);
      });
    this.#inFlight.add(running);
  }

  /**
   * Carry a render through every generation it is made of, and join them.
   *
   * Written as a walk over `parts` rather than as one polling loop, because a
   * render is now sometimes two of them — and because that shape is also what a
   * restart needs: a half already on disk is skipped, a half with a task id is
   * waited for, and a half with neither is submitted from the frame the
   * previous one ended on. `resume` therefore needs no separate machinery.
   */
  async #poll(record: RenderRecord): Promise<void> {
    const backend = this.#backend;
    if (backend === null) return;

    let current = record;
    for (let index = 0; index < current.parts.length; index += 1) {
      const part = current.parts[index];
      if (part === undefined) return;
      if (part.video !== null && existsSync(part.video)) continue;

      let taskId = part.taskId;
      if (taskId === null) {
        // The second half cannot be asked for until the first has landed: its
        // opening picture is a frame OF the first, which is what makes the cut
        // land on one frame rather than on two renderings of a similar one.
        const previous = current.parts[index - 1];
        if (previous === undefined || previous.video === null) {
          this.#stop(current, index, "The half this one continues from is not on disk, so I stopped here.");
          return;
        }

        const frame = this.#studio.partFrame(current.name, index);
        const taken = await lastFrame({ video: previous.video, to: frame, run: this.#ffmpeg });
        if (!taken.ok) {
          this.#stop(current, index, taken.reason);
          return;
        }

        // THE MODEL THE RECORD NAMES, not the house model. A second half
        // rendered on a different model from its first would not cut against
        // it — and after a restart the record is the only thing that remembers
        // which one made the first half.
        const model = modelNote(current.model);
        if (model === null) {
          this.#stop(
            current,
            index,
            `The first half of this render was made on ${current.model}, which is no longer a ` +
              "model I have, so I cannot make the second half to match it.",
          );
          return;
        }
        const geometry = this.#geometryFor(model, current.ratio);
        if (geometry === null) {
          this.#stop(current, index, `I do not know what size to ask ${model.id} for.`);
          return;
        }

        const submitted = await backend.submit({
          model: model.id,
          promptImage: this.#promptImage({ first: frame, last: this.#absolute(part.last) }, model),
          promptText: part.prompt,
          duration: part.duration,
          ...geometry,
        });
        if (!submitted.ok) {
          // The first half is already paid for. It stays on disk, it stays in
          // the ledger — `billed` counts the halves that reached Runway — and
          // the record settles at `partial` rather than `failed`, so the half
          // that exists is still something she can find and look at.
          this.#stop(
            current,
            index,
            `The first half of this render is made and the second would not start: ${submitted.failure.message}`,
          );
          return;
        }
        taskId = submitted.data.id;
        current = this.#patch(current, index, { taskId });
      }

      // A render made in one generation writes straight to its own file; the
      // halves of a joined one are kept beside it, because a half is a render
      // and `SOUL.md` does not allow one to be thrown away.
      const to =
        current.parts.length === 1
          ? this.#studio.video(current.name)
          : this.#studio.part(current.name, index + 1);
      const arrived = await this.#await(taskId, to);
      if (!arrived.ok) {
        // Runway's own words travel with the half they were said about, so a
        // record with two generations can say which one was refused and why —
        // and so does what it charged, which for a refusal is nothing.
        this.#stop(current, index, arrived.reason, {
          failureCode: arrived.failureCode,
          failure: arrived.failure,
          charged: arrived.charged,
        });
        return;
      }
      current = this.#patch(current, index, { video: to, status: "ready", charged: arrived.charged });
    }

    if (current.parts.length > 1) {
      const joined = await joinVideos({
        parts: current.parts.map((part) => part.video ?? ""),
        to: this.#studio.video(current.name),
        listFile: this.#studio.partList(current.name),
        run: this.#ffmpeg,
      });
      if (!joined.ok) {
        // BOTH halves arrived and both were paid for; the cut is what could not
        // be made, and it can be made again from what is on disk. `#stop` names
        // no part, because no generation failed.
        this.#stop(current, null, joined.reason);
        return;
      }
    }

    this.#write({
      ...(this.#read(current.name) ?? current),
      parts: current.parts,
      ...billed(current.parts),
      status: "ready",
      renderedAt: instant(this.#clock()),
      video: this.#studio.video(current.name),
      reason: null,
    });
  }

  /**
   * Wait for one generation and put it on disk.
   *
   * **Answers rather than settling the record itself.** It used to call `#fail`
   * from in here, which is why nothing it learned about *which* generation went
   * wrong — or what Runway said about it — could reach the part it happened to.
   * The caller knows the index; this knows the words; neither knew both.
   */
  async #await(taskId: string, to: string): Promise<Arrival> {
    const backend = this.#backend;
    if (backend === null) return stopped("There is no way to reach Runway from this machine.");

    for (let attempt = 1; ; attempt += 1) {
      const task = await backend.task(taskId);
      if (!task.ok) {
        if (!task.failure.retryable) return stopped(task.failure.message);
      } else if (isTerminal(task.data.status)) {
        if (task.data.status !== "SUCCEEDED") {
          return {
            ok: false,
            reason: whyItStopped(task.data.status, task.data),
            failureCode: task.data.failureCode,
            failure: task.data.failure,
            // What it cost, from the same answer that says it failed. Usually
            // nothing — which is the number the ledger was getting wrong.
            charged: task.data.charged,
          };
        }
        const url = task.data.output[0];
        if (url === undefined) {
          return stopped("Runway said the render succeeded and gave nothing back to download.");
        }

        mkdirSync(dirname(to), { recursive: true });
        const downloaded = await backend.download(url, to);
        if (!downloaded.ok) {
          // The generation SUCCEEDED and was charged for; only the download
          // broke. The charge is carried onto the record anyway, or the failure
          // to fetch a file would erase the credits that made it.
          return { ...stopped(downloaded.failure.message), charged: task.data.charged };
        }
        return { ok: true, charged: task.data.charged };
      }

      if (attempt >= this.#giveUpAfterPolls) {
        return stopped(
          `Runway had not finished this render after ${String(
            Math.round((this.#giveUpAfterPolls * this.#pollMs) / 60_000),
          )} minutes, so I stopped waiting. The task id is ${taskId} if it turns up later.`,
        );
      }

      await this.#sleep(this.#pollMs);
    }
  }

  /**
   * Record what one generation has just done, on disk, before going on.
   *
   * Written at every step rather than once at the end for the same reason the
   * sidecar is written at submission: a process that dies between two halves
   * must leave behind the task id of the half that was bought, or the credits
   * are spent and there is nothing to chase them with.
   */
  #patch(record: RenderRecord, index: number, changes: Partial<RenderPart>): RenderRecord {
    const base = this.#read(record.name) ?? record;
    const parts = base.parts.map((part, at) => (at === index ? { ...part, ...changes } : part));
    const next: RenderRecord = { ...base, parts, ...billed(parts) };
    this.#write(next);
    return next;
  }

  /**
   * Stop a render, keeping everything it already bought.
   *
   * **`partial` is decided here and it is the whole fix.** A render whose first
   * generation SUCCEEDED, downloaded and cost 120 credits, and whose second
   * FAILED for nothing, used to be written down as `failed` with `video: null`
   * — which is every view she has. The mp4 stayed on disk and became reachable
   * only by opening the sidecar by hand. Twice on 23 August, 240 credits.
   *
   * So the status is derived from what is on disk rather than from the fact
   * that something went wrong: anything salvaged makes this `partial`, and only
   * a render that bought nothing is `failed`. The line between them is whether
   * the money bought something that exists — call an empty one `partial` and
   * she goes looking for footage there is none of.
   *
   * `video` stays `null` either way. That field is the clip she asked for, and
   * there isn't one; the halves are in `parts`, which is where a reader that
   * cares about halves already looks.
   *
   * @param at Which generation refused, or `null` when none did — a failed join
   *   is nobody's generation, and marking one of them failed would blame a half
   *   that arrived.
   */
  #stop(
    record: RenderRecord,
    at: number | null,
    reason: string,
    said: {
      readonly failureCode: string | null;
      readonly failure: string | null;
      readonly charged: number | null;
    } = { failureCode: null, failure: null, charged: null },
  ): void {
    // Read from disk rather than from the caller's copy: `#patch` writes each
    // half's progress as it happens, so the file knows about halves that were
    // bought after the record in hand was made. A stopped render is a record
    // with a reason added, never a record with something taken out of it.
    const base = this.#read(record.name) ?? record;
    // Every generation that is not on disk is over, not still going. A record
    // that stopped while one of its halves still said `rendering` reads as a
    // render in flight, which is the state `resume` chases and she waits for —
    // and it is the same word the reader derives for these when it loads a
    // sidecar, so writing anything else here would make a record change its
    // mind about itself between being written and being read.
    const parts = base.parts.map((part, index) =>
      part.status === "ready"
        ? part
        : {
            ...part,
            status: "failed" as const,
            // The upstream words go on the generation they were said about, and
            // nowhere else: a half that was never submitted has no refusal of
            // its own, and copying one onto it would invent evidence.
            ...(index === at
              ? { failureCode: said.failureCode, failure: said.failure, charged: said.charged }
              : {}),
            // A generation that never reached Runway was charged nothing, and
            // that is a fact rather than an assumption: `wasBought` is false
            // for it, so it is not in the total either way. It stays `null`,
            // which says "nobody ever told us a number".
          },
    );
    const settled: RenderRecord = {
      ...base,
      parts,
      ...billed(parts),
      status: salvagedParts({ ...base, parts }).length > 0 ? "partial" : "failed",
      reason,
      video: null,
    };
    this.#write(settled);
  }

  /**
   * A name that is unique, sortable, and says what it is.
   *
   * The clock alone is not enough: she can ask twice inside one turn, and two
   * renders in the same second would overwrite each other's video *and* each
   * other's record. Her own words are deliberately not part of it — a name
   * derived from model output is a filename derived from model output.
   *
   * @param kind What sort of render it is: a framing for one that was generated,
   *   {@link JOIN_KIND} for one that was cut together. It is the tail of the
   *   filename, so a person opening `renders/` can tell them apart — which is
   *   the same argument {@link RENDER_PREFIX} makes one level up.
   */
  #nameFor(now: number, kind: Framing | typeof JOIN_KIND): string {
    const stamp = instant(now).replace(/[:.]/gu, "").replace(/-/gu, "").toLowerCase().replace("000z", "z");
    const base = `${RENDER_PREFIX}${stamp}-${kind.replace(/_/gu, "-")}`;
    if (!existsSync(this.#studio.sidecar(base))) return base;

    for (let counter = 2; counter < 1000; counter += 1) {
      const candidate = `${base}-${String(counter)}`;
      if (!existsSync(this.#studio.sidecar(candidate))) return candidate;
    }
    // A thousand renders in one second is not a thing that happens; falling
    // through to a name that already exists silently would be.
    throw new Error("Could not find a free render name in this second.");
  }

  #dataUri(reference: string): string {
    const kind = reference.toLowerCase().endsWith(".png") ? "png" : "jpeg";
    return `data:image/${kind};base64,${readFileSync(reference).toString("base64")}`;
  }

  /** A picture as `generate.mjs` records one: a path, not the base64. */
  #relativeTo(absolute: string): string {
    return absolute.startsWith(this.#studio.root)
      ? absolute.slice(this.#studio.root.length).replace(/^[/\\]+/u, "")
      : absolute;
  }

  /** A recorded path, back as somewhere on this machine. The inverse of the above. */
  #absolute(relative: string | null): string | null {
    return relative === null ? null : resolve(this.#studio.root, relative);
  }

  #write(record: RenderRecord): void {
    mkdirSync(this.#studio.videoDir, { recursive: true });
    // `promptImage` is deliberately absent, exactly as in `generate.mjs`: it is
    // a multi-megabyte data URI and the PATH is the useful fact. Keeping the
    // base64 would make this file unreadable, which is the one thing it must
    // not be.
    writeFileSync(this.#studio.sidecar(record.name), `${JSON.stringify(record, null, 2)}\n`);
  }

  #read(name: string): RenderRecord | null {
    const loaded = this.#load(name);
    return loaded !== null && loaded.ok ? loaded.record : null;
  }

  /** The most recent render, as a load, so `latest` can refuse the same way. */
  #loadLatest(): Loaded | null {
    const record = this.latest();
    return record === null ? null : { ok: true, record };
  }

  /**
   * One sidecar: a record, or the reason it is not one.
   *
   * `null` only when there is no file. Everything else answers, because the
   * three outcomes here are three different facts — no such render, a render,
   * and a file that is not a record — and collapsing any two of them is how
   * this layer tells its lies.
   */
  #load(name: string): Loaded | null {
    const file = this.#studio.sidecar(name);
    if (!existsSync(file)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      return unreadable(name, file, `it is not valid JSON (${message(error)})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return unreadable(name, file, "it does not hold a record at all");
    }

    return recordFrom(name, file, parsed as Record<string, unknown>);
  }

  /**
   * Everything in the renders directory, sorted, in one pass.
   *
   * One walk rather than three: `list`, `unreadable` and `spend` are three
   * views of the same directory, and a directory read separately per view is a
   * directory that can answer them inconsistently.
   */
  #scan(): { readonly records: readonly RenderRecord[]; readonly unreadable: readonly UnreadableRender[] } {
    if (!existsSync(this.#studio.videoDir)) return { records: [], unreadable: [] };

    const records: RenderRecord[] = [];
    const broken: UnreadableRender[] = [];
    for (const entry of readdirSync(this.#studio.videoDir)) {
      if (!entry.endsWith(".mp4.json")) continue;
      const name = basename(entry, ".mp4.json");
      // The eight loops have no sidecar and are therefore invisible here, which
      // is right: they are not hers, and there is no honest number to attach to
      // what they cost.
      if (!isRenderName(name)) continue;
      const loaded = this.#load(name);
      if (loaded === null) continue;
      if (loaded.ok) records.push(loaded.record);
      else broken.push(loaded.unreadable);
    }

    records.sort((a, b) =>
      a.startedAt === b.startedAt ? b.name.localeCompare(a.name) : b.startedAt.localeCompare(a.startedAt),
    );
    broken.sort((a, b) => a.name.localeCompare(b.name));
    return { records, unreadable: broken };
  }
}

type Loaded =
  | { readonly ok: true; readonly record: RenderRecord }
  | { readonly ok: false; readonly unreadable: UnreadableRender };

function unreadable(name: string, file: string, why: string): Loaded {
  return { ok: false, unreadable: { name, file, why } };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A sidecar as a record, or as the reason it is not one.
 *
 * **Validated rather than cast.** It used to be `JSON.parse(...) as
 * RenderRecord` with one check on `name`, which is not a check — it is a
 * promise to the compiler that the file on disk matches a type. It did not. A
 * sidecar hand-written into her video directory was missing `status`,
 * `startedAt`, `video`, `credits` and `prompt`, and every one of those absences
 * became a lie somewhere downstream:
 *
 * - no `status` meant the record could not be `ready`, so `frames()` fell to
 *   its else branch and reported *"did not finish: no reason was recorded"*
 *   about a render that was still in flight;
 * - no `startedAt` sorted it to the FRONT of `list()`, so `latest()` handed
 *   that answer back to her when she asked to look at her newest render;
 * - no `credits` made `spend()` add `undefined`, turning every total she has
 *   ever reported into `NaN`.
 *
 * She caught it herself, and her conclusion is the requirement: *"that's the
 * sort of thing that would make me tell you a render failed when it hadn't,
 * which is exactly the kind of lie I'm not willing to tell you."*
 *
 * So a file that is not a record is **unreadable**, which is its own state and
 * not a failed render — and it is surfaced rather than skipped, because a
 * render that quietly disappears from her ledger is the same lie facing the
 * other way.
 */
function recordFrom(name: string, file: string, sidecar: Record<string, unknown>): Loaded {
  const missing: string[] = [];

  const text = (field: string): string => {
    const value = sidecar[field];
    if (typeof value === "string" && value !== "") return value;
    missing.push(field);
    return "";
  };
  /**
   * A field that may honestly be absent.
   *
   * `scene` and `because` are hers: a shot rendered from `shots.json` has a
   * prompt and no separate sentence behind it. Their absence cannot make the
   * service say anything false, which is the line between this and `text`.
   */
  const optionalText = (field: string): string => {
    const value = sidecar[field];
    return typeof value === "string" ? value : "";
  };
  const nullableText = (field: string): string | null => {
    const value = sidecar[field];
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    missing.push(field);
    return null;
  };
  const nullableNumber = (field: string): number | null => {
    const value = sidecar[field];
    if (value === null || value === undefined) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    missing.push(field);
    return null;
  };

  // Present, but not authoritative. The FILENAME is the address — it is what a
  // route resolves, what `see_myself` is given, and what `frames()` opens — so
  // a record whose `name` field disagreed with its own file would hand her back
  // a name that finds nothing when she uses it. `syl-listening.mp4.json` says
  // `"name": "listening"`, and that is exactly the shape of the trap.
  if (typeof sidecar["name"] !== "string") missing.push("name");

  const declared = sidecar["status"];
  const status =
    declared === "rendering" || declared === "ready" || declared === "failed" || declared === "partial"
      ? declared
      : null;
  if (status === null) missing.push("status");

  const declaredDuration = sidecar["duration"];
  const duration =
    typeof declaredDuration === "number" && Number.isFinite(declaredDuration)
      ? declaredDuration
      : null;
  if (duration === null) missing.push("duration");

  // `framing.ts` owns whether a framing can hold her likeness and cites the
  // render that proved it, so the record is read through it rather than
  // trusting a boolean somebody wrote beside it.
  const framing = framingNote(sidecar["framing"]);
  if (framing === null) missing.push("framing");

  const startedAt = text("startedAt");
  const model = text("model");
  const ratio = text("ratio");
  // Both nullable, and both for the same compatibility reason as `anchor`:
  // every sidecar written before models could be chosen has neither, and a
  // required field would have turned the whole back catalogue unreadable at a
  // stroke — the state this validator exists to report, not to cause.
  const resolution = nullableText("resolution");
  const keyframes = nullableNumber("keyframes");
  const reference = text("reference");
  // Nullable rather than required, and that is the whole of the compatibility
  // story: every sidecar written before anchoring existed has no such field,
  // and a required one would have turned all of them unreadable at a stroke —
  // which is the state this validator exists to report honestly, not to cause.
  const anchor = nullableText("anchor");
  const prompt = text("prompt");
  const scene = optionalText("scene");
  const because = optionalText("because");
  const renderedAt = nullableText("renderedAt");
  const taskId = nullableText("taskId");
  const reason = nullableText("reason");
  const video = nullableText("video");
  const credits = nullableNumber("credits");
  const usd = nullableNumber("usd");

  const parts = partsFrom(sidecar, status, {
    taskId,
    prompt,
    duration: duration ?? 0,
    first: reference,
    last: anchor,
    video,
    credits,
    status: status === "ready" ? "ready" : status === "rendering" ? "rendering" : "failed",
    failureCode: null,
    failure: null,
    // NOT `credits`. A sidecar with no `parts` predates charges being read, so
    // its number is an estimate — and putting an estimate in the field that
    // means "what Runway charged" is how a reader comes to believe a guess was
    // an observation. The estimate is in `credits`, one line up.
    charged: null,
  });

  if (missing.length > 0 || framing === null || status === null || duration === null) {
    return unreadable(
      name,
      file,
      `the record is missing or malformed in ${missing.length === 1 ? "one field" : `${String(missing.length)} fields`}: ${missing.join(", ")}`,
    );
  }

  return {
    ok: true,
    record: {
      name,
      // NOT always the word the file wrote down. See {@link settledStatus}: a
      // sidecar written before `partial` existed says `failed` over halves that
      // are on disk, and reading it back as `failed` is what made 240 credits
      // of finished video unreachable in the first place.
      status: settledStatus(status, parts),
      renderedAt,
      taskId,
      model,
      ratio,
      resolution,
      keyframes,
      duration,
      reference,
      anchor,
      framing: framing.id,
      prompt,
      scene,
      // Derived from THIS RECORD's own pictures, not from the framing's plan.
      // A sidecar written before anchoring existed names no anchor, so a close
      // portrait in the back catalogue reads `false` — which is what those
      // renders actually were. `syl-63v` is what reading the enum's hope
      // instead of the file's facts costs.
      holdsLikeness: holdsLikeness(framing, anchor),
      because,
      startedAt,
      reason,
      credits,
      usd,
      // Derived from the halves rather than read, so a sidecar written before
      // the estimate and the charge were separate fields still answers the
      // question. Its `credits` WAS an estimate; this is where that reading
      // belongs now.
      estimated: parts.some((part) => part.credits === null)
        ? null
        : parts.reduce((total, part) => total + (part.credits ?? 0), 0),
      video,
      parts,
      // `null` for every sidecar ever written before `syl-5y4n`, which is the
      // truth about them: they were generated, not assembled. Read rather than
      // derived, because there is nothing on a record to derive it from — and a
      // join whose provenance did not survive a reload would be a join the
      // ledger counts twice the moment the process restarts.
      joinedFrom: joinedFromOf(sidecar["joinedFrom"]),
    },
  };
}

/**
 * The renders a sidecar says it was cut from, or `null`.
 *
 * Malformed is read as absent rather than making the record unreadable, the
 * same call {@link partsFrom} makes and for the same reason: the fields that
 * decide whether the service tells the truth about a render are checked above,
 * and this one says where its footage came from. A join with a broken
 * `joinedFrom` is still a finished clip on disk she can look at and send.
 */
function joinedFromOf(declared: unknown): readonly string[] | null {
  if (!Array.isArray(declared)) return null;
  const names = declared.filter((name): name is string => typeof name === "string" && name !== "");
  // Fewer than two is not a join. Reading one back would make the ledger skip a
  // render's seconds on the strength of a field that cannot be describing a cut.
  return names.length >= 2 && names.length === declared.length ? names : null;
}

/**
 * The status a record's own halves support, which is not always the one it
 * wrote down.
 *
 * **This is what heals the back catalogue, and it is why there is no migration
 * and no rewriting of files on disk.** Two sidecars from 23 August say `failed`
 * over a first half that SUCCEEDED, downloaded, cost 120 credits and is sitting
 * in `parts/`. Deriving the status here makes both of them reachable the moment
 * the service reads them again — the same principle `holdsLikeness` already
 * follows: what the record can be *shown* to be beats what somebody wrote
 * beside it.
 *
 * Only ever upgrades `failed` to `partial`, and only on evidence that is
 * checkable: a half whose file is on this disk right now. A `ready` record is
 * left exactly as it is — this function exists to stop the service understating
 * what it has, not to start it doubting what it finished.
 */
function settledStatus(declared: RenderStatus, parts: readonly RenderPart[]): RenderStatus {
  if (declared !== "failed") return declared;
  const salvaged = parts.some(
    (part) => part.status === "ready" && part.video !== null && existsSync(part.video),
  );
  return salvaged ? "partial" : "failed";
}

/**
 * The generations a sidecar says a render is made of.
 *
 * **A sidecar with no `parts` is not broken.** Every record written before a
 * render could be made in halves has none, and there are dozens of them in her
 * home — so one part is synthesised from the fields such a file does have, and
 * the rest of the service reads one shape. The alternative was a required
 * field, which would have turned the whole back catalogue unreadable at a
 * stroke: the state this validator exists to report, not to cause.
 *
 * A `parts` that is present and malformed is treated the same way rather than
 * making the record unreadable, for the same reason. The fields that decide
 * whether the service tells the truth — status, duration, framing — are checked
 * above; this one decides how a render in flight is chased, and a render in the
 * back catalogue is not in flight.
 */
function partsFrom(
  sidecar: Record<string, unknown>,
  status: RenderStatus | null,
  fallback: RenderPart,
): readonly RenderPart[] {
  const declared = sidecar["parts"];
  if (!Array.isArray(declared) || declared.length === 0) return [fallback];

  const parts: RenderPart[] = [];
  for (const entry of declared) {
    if (typeof entry !== "object" || entry === null) return [fallback];
    const part = entry as Record<string, unknown>;
    const duration = part["duration"];
    const first = part["first"];
    const prompt = part["prompt"];
    if (typeof duration !== "number" || !Number.isFinite(duration)) return [fallback];
    if (typeof first !== "string" || typeof prompt !== "string") return [fallback];

    const taskId = part["taskId"];
    const last = part["last"];
    const video = part["video"];
    const credits = part["credits"];
    const failureCode = part["failureCode"];
    const failure = part["failure"];
    const charged = part["charged"];
    const estimate = typeof credits === "number" && Number.isFinite(credits) ? credits : null;
    parts.push({
      taskId: typeof taskId === "string" ? taskId : null,
      prompt,
      duration,
      first,
      last: typeof last === "string" ? last : null,
      video: typeof video === "string" ? video : null,
      credits: estimate,
      status: partStatusFrom(part["status"], typeof video === "string", status),
      // `null` for every sidecar written before we kept these, which is the
      // truth about them: what Runway said was never recorded, and inventing a
      // code now would be worse than the silence that made this necessary.
      failureCode: typeof failureCode === "string" ? failureCode : null,
      failure: typeof failure === "string" ? failure : null,
      // `null` for a sidecar written before charges were read, because nobody
      // ever told us a number for it. The ESTIMATE is above, in the field that
      // means estimate, and the record's own total is read straight off the
      // file — so honesty here costs his history nothing.
      charged: chargedFrom(charged),
    });
  }
  return parts;
}

/**
 * What a half was charged, for a sidecar that never recorded a charge.
 *
 * **`null`, always — nobody observed one.** This briefly read the rate-card
 * estimate forward instead, to keep his historical totals from collapsing, and
 * that was the same defect this file exists to fix wearing yet another costume:
 * it made `charged` mean *"charged, or what we guessed, whichever we have"*,
 * which nothing can read correctly. The backfill tool caught it by refusing to
 * touch four records on the grounds that they "already recorded a charge" —
 * they recorded an estimate, and the field could not tell anyone which.
 *
 * **The totals were never at risk.** {@link recordFrom} reads `credits`
 * straight off the sidecar; `billed()` only runs when a record is WRITTEN. So a
 * back catalogue whose halves honestly say "nobody told us" keeps every total
 * it has ever shown, and the four records where the difference is known and
 * material are corrected deliberately by `render/backfill-charges.ts` rather
 * than silently by a reader.
 */
function chargedFrom(declared: unknown): number | null {
  return typeof declared === "number" && Number.isFinite(declared) ? declared : null;
}

/**
 * How one generation went, for a sidecar that never said.
 *
 * Every record written before halves had a status of their own — including the
 * two that lost 240 credits — is read through here, and the derivation is the
 * only honest one available: **a video on disk is proof it arrived**, and after
 * that the render's own outcome is all there is to go on. A half with no video
 * inside a render that stopped did not arrive; one inside a render still in
 * flight has not arrived yet.
 */
function partStatusFrom(declared: unknown, hasVideo: boolean, status: RenderStatus | null): PartStatus {
  if (declared === "ready" || declared === "failed" || declared === "rendering") return declared;
  if (hasVideo) return "ready";
  return status === "rendering" || status === null ? "rendering" : "failed";
}
