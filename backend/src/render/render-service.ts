import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { instant, systemClock, type Clock } from "../services/clock.js";
import { creditsFor, usdOf } from "./credits.js";
import {
  framingNote,
  FRAMING_IDS,
  TEMPLATE_FRAMING,
  type Framing,
  type FramingNote,
} from "./framing.js";
import { extractFrames, ffmpegRunner, type ExtractResult, type FrameRunner } from "./frames.js";
import { joinVideos, lastFrame } from "./join.js";
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
  readonly scene: string;
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
   * A shot whose subject is her face is two generations, so the shortest one
   * that exists is eight. {@link halvesOf} rounds up rather than collapsing, and
   * `duration` on the record is the halves added up, so the number she reads
   * back is the number that was made.
   */
  readonly seconds?: number;
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
 * The recipe every one of the eight loops was made with.
 *
 * `shots.json` opens all eight prompts with this phrase, and the loop clause
 * closes all eight. Neither is decoration: the opening is what keeps the
 * subject *her* rather than a person, and the closing clause is what makes any
 * clip cut against any other — a property of the prompt, not of the editing.
 * Drop it and the render will not join the reel.
 *
 * She supplies the middle. That is the part worth experimenting with, and the
 * part `docs/VIDEO.md` says is worth keeping.
 */
const IDENTITY =
  "A luminous spirit woman of living starlight, silver-white hair and a translucent flowing gown " +
  "trailing like ribbons of light, in a deep blue starfield.";

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
 * A render's seconds, split across the two generations it is made of.
 *
 * The longer half goes FIRST, because that is the half that has to do the
 * gathering and then hold on her face long enough for the join to land on a
 * face rather than on a smear. `15` becomes `8, 7`.
 *
 * A total too short to divide is rounded **up** rather than collapsed into one
 * generation: losing a second is a nuisance, and losing an end of the clip is
 * the defect this whole shape exists to fix. `duration` on the record is the
 * halves added up, so the number she is told stays the number that was made.
 *
 * **The floor and the ceiling come from the model**, not from constants that
 * were `seedance2`'s range wearing the name of a fact about video. `4` would
 * refuse `grok_imagine_1_5` a length it accepts, and `15` would refuse the
 * house model half of its range.
 */
function halvesOf(seconds: number, model: ModelNote): readonly [number, number] {
  const first = Math.min(model.duration.max, Math.max(model.duration.min, Math.ceil(seconds / 2)));
  return [first, Math.min(model.duration.max, Math.max(model.duration.min, seconds - first))];
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
  readonly #backend: RenderBackend | null;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pollMs: number;
  readonly #giveUpAfterPolls: number;
  readonly #ffmpeg: FrameRunner;
  readonly #watch: ((record: RenderRecord) => void) | undefined;
  readonly #onError: (error: unknown, name: string) => void;
  /** Renders being followed right now, so `drain` can wait for them. */
  readonly #inFlight = new Set<Promise<void>>();

  constructor(options: RenderServiceOptions) {
    this.#studio = options.studio;
    this.#clock = options.clock ?? systemClock;
    this.#wardrobe =
      options.wardrobe ?? new Wardrobe({ studio: options.studio, clock: this.#clock });
    this.#backend = options.backend;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollMs = options.pollMs ?? POLL_MS;
    this.#giveUpAfterPolls = options.giveUpAfterPolls ?? GIVE_UP_AFTER_POLLS;
    this.#ffmpeg = options.ffmpeg ?? ffmpegRunner;
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
    const scene = input.scene.trim();
    if (scene === "") {
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

    // How many generations this shot takes, which decides the length ceiling: a
    // clip cut together out of two halves reaches twice as far as one. Known
    // here because it follows from the framing, before any picture is looked up.
    const generations = framing.anchor === "none" ? 1 : 2;
    const ceiling = maxSecondsFor(model, generations);
    // THE FLOOR IS ONE GENERATION'S, NOT TWO, and that asymmetry is deliberate.
    // A joined shot cannot really be shorter than two of the model's shortest —
    // but asking for five and being refused teaches her nothing, while asking
    // for five and being told the clip is eight is a dial she can read back
    // even when it did not do what she asked. `halvesOf` rounds up and
    // `duration` on the record is the halves added up, so the number she is
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
          (generations === 2
            ? `A shot of my face is two generations cut together, each ${String(model.duration.min)}` +
              `-${String(model.duration.max)}s, which is where those numbers come from.`
            : `That is ${model.id}'s own range, measured against the API.`),
        retryable: true,
      };
    }

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
      scene,
      opening: opening.path,
      anchor,
      seconds,
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
      seconds += record.parts.filter(wasBought).reduce((total, part) => total + part.duration, 0);
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
   * framings that drift. **Two when her face is the subject**, because both
   * keyframe slots then go to the ribbon — one at each end of the finished clip
   * — and her likeness has to live at the join instead. `join.ts` records the
   * probes that leave no third option.
   */
  #plan(input: {
    readonly name: string;
    readonly framing: FramingNote;
    /** The chosen model, because the split has to land inside ITS range. */
    readonly model: ModelNote;
    readonly scene: string;
    readonly opening: string;
    readonly anchor: string | null;
    /** What she asked for, already checked against the chosen model's range. */
    readonly seconds: number;
  }): readonly PlannedPart[] {
    const stem = `${IDENTITY} ${input.scene} ${input.framing.clause}`;

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
          prompt: `${stem} ${LOOP_CLAUSE}`,
          duration: input.seconds,
          first: input.opening,
          last: input.opening,
        },
      ];
    }

    const [gathering, unravelling] = halvesOf(input.seconds, input.model);
    return [
      { prompt: `${stem} ${GATHERING_CLAUSE}`, duration: gathering, first: input.opening, last: input.anchor },
      {
        prompt: `${stem} ${UNRAVELLING_CLAUSE}`,
        duration: unravelling,
        // The frame the first half ends on, which does not exist yet. Named
        // here rather than left blank because the path is decided by the render
        // name: a record that says what WILL be sent is reproducible, and one
        // that says nothing is a hole somebody fills in with a guess.
        first: this.#studio.partFrame(input.name, 1),
        last: input.opening,
      },
    ];
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
   */
  #nameFor(now: number, framing: Framing): string {
    const stamp = instant(now).replace(/[:.]/gu, "").replace(/-/gu, "").toLowerCase().replace("000z", "z");
    const base = `${RENDER_PREFIX}${stamp}-${framing.replace(/_/gu, "-")}`;
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
    },
  };
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
