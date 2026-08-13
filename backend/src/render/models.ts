import type { ResolutionTier } from "./credits.js";

/**
 * Which models can make a video of her, and what each one can actually do.
 *
 * ## Why this file exists at all
 *
 * `syl-ate` gave her every dial but two. `ratio` stayed shut because the
 * opening image overrules it, and `model` stayed shut because *"a different
 * model loses the character entirely"*. That reason was correct. It was also
 * **untested**, and an untested reason is how a constraint outlives the fact
 * underneath it — which is the failure `syl-63v` is named after.
 *
 * So it was tested, on 2026-08-13, against the live API. It survived, and the
 * shape of the answer is what made the dial safe to open:
 *
 * > A model with no `last` keyframe slot has nowhere to pin her face, so it
 * > **cannot** anchor a shot that shows one. That is arithmetic, not an
 * > opinion, and it can be computed rather than remembered.
 *
 * `grok_imagine_1_5` takes exactly one image and its position must be `first`.
 * It was probed, and then it was *rendered*: same ribbon, same prompt, same
 * four seconds, and the closing frame came back a visibly different woman. That
 * is `7-twin` and `8-descent` from `docs/VIDEO.md` arriving **necessarily**
 * rather than by bad luck with a seed.
 *
 * ## Why every capability here is derived and none is written down
 *
 * The same discipline as `framing.ts`'s `holdsLikeness` and `wardrobe.json`'s
 * missing `current` column, and for the same reason. A stored boolean is a
 * *second* assertion about a fact, and the two drift apart in silence: the flag
 * said `true` for a day after the picture it described had been taken away, and
 * nothing anywhere could contradict it.
 *
 * So this file stores **only what a probe measured** — the slots, the ranges,
 * the lists, the rates — and {@link canAnchorLikeness} is a function of the
 * slots. To claim it can hold her face, a model added later has to actually
 * declare the slot. There is no flag to flip.
 *
 * ## Why the numbers are pedantic
 *
 * Each one cost credits. `seedance2_5`'s ratio list is twelve entries and stops
 * at 1470 — the `3840:*` rows that `seedance2` has are simply gone, which is
 * why it has no `uhd` rate. `834:1112`, the shape of all eight loops, is still
 * there, which is the only reason her back catalogue is reproducible on it.
 *
 * Re-run the measurement with `scripts/video/probe-models.mjs`. A rejected
 * request costs nothing **as long as every field in it is invalid** — and note
 * the correction in `docs/VIDEO.md`: on some endpoints an invented key does not
 * make a field invalid at all, which is how 32 credits went on probes believed
 * free.
 */

/** Which field decides the video's geometry. They are mutually exclusive. */
export type GeometryShape = "ratio" | "resolution";

/**
 * Where a picture may be pinned in the clip.
 *
 * The whole vocabulary, enumerated by a 400 for a bogus position and unchanged
 * across every model on the roster. There is no `middle`.
 */
export type KeyframePosition = "first" | "last";

/** One model, and everything measured about it. */
export interface ModelNote {
  readonly id: string;
  /** `ratio` or `resolution` — sending the wrong one is an `Unrecognized key`. */
  readonly shape: GeometryShape;
  /** Every legal ratio, verbatim from the 400. Empty when shaped by resolution. */
  readonly ratios: readonly string[];
  /** Every legal resolution. Empty when shaped by ratio. */
  readonly resolutions: readonly string[];
  /** Inclusive, and integers only — a fractional duration is rejected. */
  readonly duration: { readonly min: number; readonly max: number };
  /** The keyframe slots. **This is what decides whether her face can be pinned.** */
  readonly positions: readonly KeyframePosition[];
  /** Measured from the balance or from `estimatedCost`, never copied. */
  readonly creditsPerSecond: Partial<Readonly<Record<ResolutionTier, number>>>;
  /** The day a probe last confirmed all of the above. */
  readonly measuredOn: string;
  /** What she is told about it, carrying the evidence rather than asserting. */
  readonly evidence: string;
}

const MEASURED = "2026-08-13";

/**
 * `seedance2`'s ratios. Twenty-four, and the only list here with 4K in it.
 *
 * `1470:630` is legal and is deliberately still offered even though
 * `pictures.ts` will not snap to it — a legal ratio is not a granted one, and
 * this list describes the API rather than our policy about it.
 */
const SEEDANCE2_RATIOS = [
  "992:432", "864:496", "752:560", "640:640", "560:752", "496:864",
  "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280",
  "2206:946", "1920:1080", "1664:1248", "1440:1440", "1248:1664", "1080:1920",
  "3840:1646", "3840:2160", "3840:2880", "3840:3840", "2880:3840", "2160:3840",
] as const;

/** `seedance2_5`'s twelve. Note `854:480` where seedance2 has `864:496`. */
const SEEDANCE2_5_RATIOS = [
  "992:432", "854:480", "752:560", "640:640", "560:752", "480:854",
  "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280",
] as const;

/** `seedance2_mini`'s twelve, which use seedance2's spelling of the small pair. */
const SEEDANCE2_MINI_RATIOS = [
  "992:432", "864:496", "752:560", "640:640", "560:752", "496:864",
  "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280",
] as const;

/** A registry entry as it is written down — everything measured, nothing derived. */
type ModelSpec = ModelNote;

const SPECS: readonly ModelSpec[] = [
  {
    id: "seedance2",
    shape: "ratio",
    ratios: SEEDANCE2_RATIOS,
    resolutions: [],
    duration: { min: 4, max: 15 },
    positions: ["first", "last"],
    creditsPerSecond: { sd: 36, hd: 40, uhd: 150 },
    measuredOn: MEASURED,
    evidence:
      "The flagship, and what all eight loops and every render of yours so far were made with. Two keyframe slots, so your face can be pinned at the join. The only model here that reaches 4K.",
  },
  {
    id: "seedance2_5",
    shape: "ratio",
    ratios: SEEDANCE2_5_RATIOS,
    resolutions: [],
    duration: { min: 4, max: 30 },
    // Probed: "You must specify a frame in position `first`", and "Each
    // position (`first`, `last`) may only be used once."
    positions: ["first", "last"],
    // 120 credits for a 4s render at 834:1112, and `estimatedCost` reported
    // exactly 900 for 30s. Both give 30/second. No `uhd` because there is no
    // ratio above 1470 to reach it with.
    creditsPerSecond: { sd: 30, hd: 30 },
    measuredOn: MEASURED,
    evidence:
      "Longer and cheaper than seedance2 — up to 30 seconds against 15, at 30 credits a second against 36 — and it holds your likeness the same way, pinned at the join. It cannot do 4K. A 4-second render was made and confirmed on 2026-08-13; a 30-second one was accepted, ran to 98% and then failed, so the long end of this range is ALLOWED but not yet PROVEN.",
  },
  {
    id: "seedance2_mini",
    shape: "ratio",
    ratios: SEEDANCE2_MINI_RATIOS,
    resolutions: [],
    duration: { min: 4, max: 30 },
    positions: ["first", "last"],
    // Not yet measured against the balance. `null` is the honest answer and
    // `creditsFor` already reports it as unpriced rather than as free.
    creditsPerSecond: {},
    measuredOn: MEASURED,
    evidence:
      "The small seedance. Same two keyframe slots and the same 30-second ceiling, but nothing has been rendered on it yet and its rate is not known — a render on this will land in your ledger as unpriced.",
  },
  {
    id: "seedance2_fast",
    shape: "ratio",
    ratios: SEEDANCE2_MINI_RATIOS,
    resolutions: [],
    duration: { min: 4, max: 15 },
    positions: ["first", "last"],
    creditsPerSecond: { sd: 29 },
    measuredOn: MEASURED,
    evidence:
      "Cheaper seedance2 at 480p/720p. The saving is thinner than it looks — 29 against 36 — and grok_imagine_1_5 at 480p is cheaper still if all you need is to see whether the motion reads.",
  },
  {
    id: "grok_imagine_1_5",
    // No `ratio` key at all: it is an `Unrecognized key` here, and geometry
    // comes from `resolution` plus the opening picture's own shape.
    shape: "resolution",
    ratios: [],
    resolutions: ["480p", "720p", "1080p"],
    duration: { min: 1, max: 15 },
    // ONE slot, and it must be `first`. "Too big: expected array to have <=1
    // items", and "Invalid input: expected \"first\"". This is the whole
    // reason it cannot hold her face.
    positions: ["first"],
    // 11 credits for 1s at 480p; 17 for 1s and 65 for 4s at 720p.
    creditsPerSecond: { sd: 11 },
    measuredOn: MEASURED,
    evidence:
      "The cheapest video on the account at 11 credits a second, and it takes only ONE picture — the opening. It has nowhere to pin your face, so a shot that shows one comes back as somebody else; it was rendered on 2026-08-13 and the closing frame was a stranger. Use it to rehearse whether a movement reads, then render for real on a seedance.",
  },
] as const;

export const MODELS: readonly ModelNote[] = SPECS;

/** Every model she may name, in the order the schema lists them. */
export const MODEL_IDS: readonly string[] = MODELS.map((model) => model.id);

/** The note for a model, or `null` for anything not on the roster. */
export function modelNote(raw: unknown): ModelNote | null {
  if (typeof raw !== "string") return null;
  return MODELS.find((model) => model.id === raw) ?? null;
}

/**
 * The model her renders are made with unless she names another.
 *
 * > *"Yes default to 2.5. But keep the options available"*
 * > — the Commander, 2026-08-13
 *
 * `specs/013` put changing the default **out of scope** and said why: *"a silent
 * change of the thing that makes her face is precisely the drift this project
 * has spent days learning to hate."* That reasoning was right, and it is why the
 * change waited for him rather than being taken by whoever measured the numbers.
 * He has ruled, so it is no longer silent.
 *
 * What the ruling buys, all measured on 2026-08-13 and none of it inferred:
 * `seedance2_5` is **cheaper** (30 credits a second against 36), reaches
 * **longer** (30 seconds against 15), and **holds her likeness the same way** —
 * two keyframe slots, and a 4-second render was made and looked at. It loses
 * only 4K, which nothing in her reel has ever used, and it keeps `834:1112`, so
 * every loop she has is still reproducible on it.
 *
 * **This is a `ModelNote` and not a string**, which is the whole point. A name
 * held beside the roster is a second assertion about which models exist, and it
 * goes stale in exactly the way `syl-63v` went stale. Resolving it here means a
 * house model removed from the roster is an error at import rather than a 400
 * discovered by a render at three in the morning.
 */
const HOUSE_MODEL_ID = "seedance2_5";

export const HOUSE_MODEL: ModelNote = ((): ModelNote => {
  const note = MODELS.find((model) => model.id === HOUSE_MODEL_ID);
  if (note === undefined) {
    throw new Error(
      `The house model ${HOUSE_MODEL_ID} is not on the roster, so nothing knows what to render with.`,
    );
  }
  return note;
})();

/**
 * Whether this model can pin her likeness at all.
 *
 * **The one derivation this file exists for.** An anchored render is two
 * generations cut together on her portrait frame: the first runs ribbon to
 * portrait, the second runs that same frame back to ribbon. Both halves need to
 * pin a picture at `last`. A model without that slot cannot render either half,
 * so it cannot hold her face and cannot close on the ribbon either.
 *
 * `null` — an unknown model — answers `false`. A model nobody has measured has
 * not proved it can hold her face, and the safe direction is the one that warns
 * her rather than the one that reassures her.
 */
export function canAnchorLikeness(model: ModelNote | null): boolean {
  return model?.positions.includes("last") ?? false;
}

/** Whether a duration is one this model will actually accept. */
export function durationAllowed(model: ModelNote | null, seconds: number): boolean {
  if (model === null) return false;
  if (!Number.isInteger(seconds)) return false;
  return seconds >= model.duration.min && seconds <= model.duration.max;
}

/**
 * The band a `resolution`-shaped model is asked for, when nobody says.
 *
 * **The lowest one, and the reason is honesty about the bill rather than
 * thrift.** `creditsPerSecond` on such a model was measured at one band — 11
 * credits a second for `grok_imagine_1_5` at `480p` — and 720p measured
 * *higher*, around 16.25. Asking for a band the rate was not measured at would
 * put a confident wrong number in her ledger, which is the one thing
 * `credits.ts` exists to refuse.
 *
 * It also matches what the model is for. A model with one keyframe cannot hold
 * her face, so what it is good for is rehearsing whether a movement reads — and
 * that question is answered at 480p.
 *
 * `null` for a model shaped by `ratio`, which has no such field to send.
 */
export function defaultResolution(model: ModelNote | null): string | null {
  if (model === null || model.shape !== "resolution") return null;
  return model.resolutions[0] ?? null;
}

/**
 * The longest finished clip this model can make, across the generations it takes.
 *
 * An anchored shot is **two** generations cut together on her face, so its
 * ceiling is twice the model's own — that is arithmetic about the join, not a
 * second opinion about the model. The unanchored template is one generation and
 * stops where the model stops.
 *
 * Written as a function of the generation count for the same reason everything
 * else here is derived: `MAX_SECONDS = 15` was `seedance2`'s range wearing the
 * name of a fact about video, and it silently refused a length the house model
 * accepts.
 */
export function maxSecondsFor(model: ModelNote, generations: number): number {
  return model.duration.max * Math.max(1, generations);
}

/** The shortest finished clip, on the same reasoning. */
export function minSecondsFor(model: ModelNote, generations: number): number {
  return model.duration.min * Math.max(1, generations);
}

/**
 * The enum's description, as the schema carries it.
 *
 * Built from {@link MODELS} rather than written out beside it, so the list and
 * its explanation cannot disagree — the same reason `framingGuidance` is a
 * function. A model added without a sentence would be a model she is offered
 * and told nothing about.
 */
export function modelGuidance(): string {
  const line = (model: ModelNote): string => {
    const range = `${String(model.duration.min)}-${String(model.duration.max)}s`;
    // The cheapest published band, because that is the one a render lands in
    // unless something asks otherwise, and because an unpriced model must read
    // as unpriced rather than as free — the same rule as `creditsFor`.
    const rates = Object.values(model.creditsPerSecond);
    const cost = rates.length === 0 ? "rate unmeasured" : `${String(Math.min(...rates))} cr/s`;
    const holds = canAnchorLikeness(model)
      ? "holds you"
      : "will NOT hold you — one keyframe, nothing to pin your face with";
    return `${model.id}: ${range}, ${cost}, ${holds}`;
  };

  return (
    "Which model renders the shot. They differ in what they can hold still: a clip is anchored on " +
    "your face by pinning a picture to its last frame, so a model with only one keyframe slot " +
    "cannot do it and will give you a stranger however good the prompt is — that was rendered, " +
    `not guessed. ${MODELS.map(line).join("; ")}. ` +
    `${HOUSE_MODEL.id} unless you say. One that cannot hold you is refused for a shot of your ` +
    "face before anything is paid for, and is yours to use freely for a shot without one — " +
    "see_myself with of: models is the whole table."
  );
}
