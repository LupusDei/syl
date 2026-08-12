import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { instant, systemClock, type Clock } from "../services/clock.js";
import { creditsFor, usdOf } from "./credits.js";
import { framingNote, FRAMING_IDS, type Framing, type FramingNote } from "./framing.js";
import { extractFrames, ffmpegRunner, type ExtractResult, type FrameRunner } from "./frames.js";
import { joinVideos, lastFrame } from "./join.js";
import { isTerminal, type RenderBackend, type PositionedImage } from "./runway.js";
import { isRenderName, RENDER_PREFIX, type Studio } from "./studio.js";

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
 * ## What this deliberately does not do
 *
 * There is no approval gate, no per-day cap and no confirmation. The
 * Commander's ruling, 2026-08-11: the credits exist for exactly this
 * experiment, and the whole point is that trying things is cheap for her.
 * Adding a gate here later is his call, not a refactor.
 */

/** How a render is going. */
export type RenderStatus = "rendering" | "ready" | "failed";

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
  /** What this half cost, or `null` where there is no published rate. */
  readonly credits: number | null;
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
  readonly model: string;
  readonly ratio: string;
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
   * What has been bought so far, summed over the halves that were submitted.
   *
   * `null` when there is no published rate — never a guess. A render whose
   * second half never reached Runway is billed for the first half only, which
   * is the truth and is the number `spend()` has to be able to stand behind.
   */
  readonly credits: number | null;
  readonly usd: number | null;
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

export type StartResult =
  | { readonly ok: true; readonly record: RenderRecord }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

export interface StartInput {
  readonly scene: string;
  readonly framing: string;
  readonly because: string;
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
 */
const LOOP_CLAUSE =
  "Opens on a lone ribbon of blue light against empty starfield, with no figure present. " +
  "The ribbon gathers and coalesces into her, her whole body made of that same living light. " +
  "At the end she unravels back into the ribbon and it streams away, leaving empty starfield. " +
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
 */
const DEFAULTS = {
  model: "seedance2",
  ratio: "834:1112",
  /** `seedance2` tops out here, measured 2026-08-10. */
  duration: 15,
} as const;

/**
 * The shortest generation seedance2 will make, probed 2026-08-11.
 *
 * A 400 rather than a guess: `duration: 3` answers *"Too small: expected number
 * to be >=4"*, and 99 answers *"<=15"*, and the field is an integer. It is here
 * because a render made in halves has to split its seconds, and a split that
 * lands under this floor is a refusal Runway hands back after the first half is
 * already paid for.
 */
const MIN_SECONDS = 4;

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
 */
function halvesOf(seconds: number): readonly [number, number] {
  const first = Math.max(MIN_SECONDS, Math.ceil(seconds / 2));
  return [first, Math.max(MIN_SECONDS, seconds - first)];
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

/** What has been bought so far: the halves that reached Runway, added up. */
function billed(parts: readonly RenderPart[]): {
  readonly credits: number | null;
  readonly usd: number | null;
} {
  const bought = parts.filter(wasBought);
  // An unpriced half makes the whole render unpriced rather than cheap. Same
  // rule as `creditsFor`: a confident wrong number is worse than an absent one.
  if (bought.length === 0 || bought.some((part) => part.credits === null)) {
    return { credits: null, usd: null };
  }
  const credits = bought.reduce((total, part) => total + (part.credits ?? 0), 0);
  return { credits, usd: usdOf(credits) };
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
    this.#backend = options.backend;
    this.#clock = options.clock ?? systemClock;
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

    if (this.#backend === null) {
      return {
        ok: false,
        reason:
          "There is no RUNWAYML_API_SECRET on this machine, so I have no way to render anything. " +
          "Nothing has been spent and nothing has been made.",
        retryable: false,
      };
    }

    // The picture that is actually sent, and therefore the video's first frame.
    // Checked rather than assumed: without it there is nothing to start the
    // clip from, and the failure mode of getting this wrong is not an error —
    // it is fifteen seconds that open on the wrong thing, at full price.
    const opening = this.#studio.opening();
    if (!existsSync(opening)) {
      return {
        ok: false,
        reason:
          `The ribbon my clips open on is not where it should be (${opening}). It is the first ` +
          "frame of every render — without it the video would begin somewhere else, and it would " +
          "not cut against the others.",
        retryable: false,
      };
    }

    // The picture that pins her face, for the framings that need one. A shot
    // whose subject is her face and which has nothing holding that face is the
    // `8-descent` failure by construction — a visibly different woman, at full
    // price — so it is refused here rather than discovered on the other side.
    // Only for the framings that need it: `face_turned_away` holds without a
    // face at all, and must not stop working because a likeness is missing.
    const anchor = framing.anchor === "none" ? null : this.#studio.reference();
    if (anchor !== null && !existsSync(anchor)) {
      return {
        ok: false,
        reason:
          `This shot is my face, and the picture that holds my likeness is not where it should ` +
          `be (${anchor}). Without it the model has nothing to copy and would give you somebody ` +
          "else. Nothing has been spent.",
        retryable: false,
      };
    }

    const now = this.#clock();
    const name = this.#nameFor(now, framing.id);
    const planned = this.#plan({ name, framing, scene, opening, anchor });

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
      model: DEFAULTS.model,
      promptImage: this.#promptImage(head),
      promptText: head.prompt,
      ratio: DEFAULTS.ratio,
      duration: head.duration,
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
      credits: creditsFor({ model: DEFAULTS.model, ratio: DEFAULTS.ratio, seconds: part.duration }),
    }));

    const record: RenderRecord = {
      name,
      status: "rendering",
      renderedAt: null,
      taskId: submitted.data.id,
      model: DEFAULTS.model,
      ratio: DEFAULTS.ratio,
      duration: planned.reduce((total, part) => total + part.duration, 0),
      reference: this.#relativeTo(opening),
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
   * A failed render counts. `RUNWAY_API_INDEX.md` is explicit that a moderated
   * generation still costs full credits with no refund, and a ledger that only
   * counted the successes would understate the bill — which is the one
   * direction an honest one must not err in.
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
   */
  async frames(name: string, at?: number): Promise<
    { readonly ok: true; readonly record: RenderRecord; readonly frames: ExtractResult } | { readonly ok: false; readonly reason: string; readonly status: "missing" | "unfinished" | "unreadable" }
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
    if (record.status !== "ready" || record.video === null) {
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
      frames: await extractFrames({
        video: record.video,
        seconds: record.duration,
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
    readonly scene: string;
    readonly opening: string;
    readonly anchor: string | null;
  }): readonly PlannedPart[] {
    const stem = `${IDENTITY} ${input.scene} ${input.framing.clause}`;

    if (input.anchor === null) {
      return [
        { prompt: `${stem} ${LOOP_CLAUSE}`, duration: DEFAULTS.duration, first: input.opening, last: null },
      ];
    }

    const [gathering, unravelling] = halvesOf(DEFAULTS.duration);
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
   * were sent — and the positioned array where both ends are. Not two code
   * paths for the sake of it: the string form is what `generate.mjs` sends and
   * what every one of the eight was made with, and there is no reason to
   * re-shape a request that is already right.
   */
  #promptImage(part: { readonly first: string; readonly last: string | null }): string | readonly PositionedImage[] {
    if (part.last === null) return this.#dataUri(part.first);
    return [
      { uri: this.#dataUri(part.first), position: "first" },
      { uri: this.#dataUri(part.last), position: "last" },
    ];
  }

  /** Follow a submitted task to its end, without anybody awaiting it. */
  #follow(record: RenderRecord): void {
    const running = this.#poll(record)
      .catch((error: unknown) => {
        this.#onError(error, record.name);
        try {
          this.#fail(record, `Following this render threw: ${String(error)}`);
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
          this.#fail(current, "The half this one continues from is not on disk, so I stopped here.");
          return;
        }

        const frame = this.#studio.partFrame(current.name, index);
        const taken = await lastFrame({ video: previous.video, to: frame, run: this.#ffmpeg });
        if (!taken.ok) {
          this.#fail(current, taken.reason);
          return;
        }

        const submitted = await backend.submit({
          model: current.model,
          promptImage: this.#promptImage({ first: frame, last: this.#absolute(part.last) }),
          promptText: part.prompt,
          ratio: current.ratio,
          duration: part.duration,
        });
        if (!submitted.ok) {
          // The first half is already paid for. It stays on disk and it stays
          // in the ledger — `billed` counts the halves that reached Runway, so
          // this record reports what was actually spent rather than what the
          // whole render would have cost.
          this.#fail(
            current,
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
      if (!(await this.#await(current, taskId, to))) return;
      current = this.#patch(current, index, { video: to });
    }

    if (current.parts.length > 1) {
      const joined = await joinVideos({
        parts: current.parts.map((part) => part.video ?? ""),
        to: this.#studio.video(current.name),
        listFile: this.#studio.partList(current.name),
        run: this.#ffmpeg,
      });
      if (!joined.ok) {
        this.#fail(current, joined.reason);
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

  /** Wait for one generation and put it on disk. `false` means it is over. */
  async #await(record: RenderRecord, taskId: string, to: string): Promise<boolean> {
    const backend = this.#backend;
    if (backend === null) return false;

    for (let attempt = 1; ; attempt += 1) {
      const task = await backend.task(taskId);
      if (!task.ok) {
        if (!task.failure.retryable) {
          this.#fail(record, task.failure.message);
          return false;
        }
      } else if (isTerminal(task.data.status)) {
        if (task.data.status !== "SUCCEEDED") {
          this.#fail(record, `Runway ended this render as ${task.data.status}.`);
          return false;
        }
        const url = task.data.output[0];
        if (url === undefined) {
          this.#fail(record, "Runway said the render succeeded and gave nothing back to download.");
          return false;
        }

        mkdirSync(dirname(to), { recursive: true });
        const downloaded = await backend.download(url, to);
        if (!downloaded.ok) {
          this.#fail(record, downloaded.failure.message);
          return false;
        }
        return true;
      }

      if (attempt >= this.#giveUpAfterPolls) {
        this.#fail(
          record,
          `Runway had not finished this render after ${String(
            Math.round((this.#giveUpAfterPolls * this.#pollMs) / 60_000),
          )} minutes, so I stopped waiting. The task id is ${taskId} if it turns up later.`,
        );
        return false;
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

  #fail(record: RenderRecord, reason: string): void {
    // Read from disk rather than from the caller's copy: `#patch` writes each
    // half's progress as it happens, so the file knows about halves that were
    // bought after the record in hand was made. A failed render is a record
    // with a reason added, never a record with something taken out of it.
    const base = this.#read(record.name) ?? record;
    this.#write({ ...base, status: "failed", reason, video: null });
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
    declared === "rendering" || declared === "ready" || declared === "failed" ? declared : null;
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
      status,
      renderedAt,
      taskId,
      model,
      ratio,
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
      video,
      parts: partsFrom(sidecar, {
        taskId,
        prompt,
        duration,
        first: reference,
        last: anchor,
        video,
        credits,
      }),
    },
  };
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
function partsFrom(sidecar: Record<string, unknown>, fallback: RenderPart): readonly RenderPart[] {
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
    parts.push({
      taskId: typeof taskId === "string" ? taskId : null,
      prompt,
      duration,
      first,
      last: typeof last === "string" ? last : null,
      video: typeof video === "string" ? video : null,
      credits: typeof credits === "number" && Number.isFinite(credits) ? credits : null,
    });
  }
  return parts;
}
