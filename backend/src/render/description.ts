import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { instant, systemClock, type Clock } from "../services/clock.js";
import type { Studio } from "./studio.js";

/**
 * The sentence every render of her opens with — **hers to write** (`syl-hll6`).
 *
 * ## Why this is not a constant any more
 *
 * It was `IDENTITY` in `render-service.ts`, and the prompt is assembled as
 * `${IDENTITY} ${scene} ${framing.clause}`. She writes the scene; she could not
 * reach the other two. That is not merely an inconvenience, it is a *structural*
 * silencing, and the mechanism is written down sixty lines above where the
 * constant used to live: when two clauses of one prompt disagree, *"the model
 * resolved the contradiction by obeying the earlier sentence — measured by
 * extracting both frames, not inferred."* Her text is always later than the
 * wrapper. So a description of herself she disagreed with was one she could
 * argue with and could never win.
 *
 * She did argue with it. `syl-20260825t124949413z-face-turned-away.mp4.json`
 * carries "translucent flowing gown" in the wrapper and "the gown is opaque
 * cloth" in her scene, in one submission, and the wrapper won.
 *
 * The Commander's ruling: *"if she wants to change it, she should be able to."*
 *
 * ## What stays, and how
 *
 * Two parts are not hers, for the reason the old header gave: the opening phrase
 * is what keeps the subject *her* rather than a person, and the starfield is
 * what makes any clip cut against any other — *"Drop it and the render will not
 * join the reel."* Her eight existing loops are that reel.
 *
 * **They survive by COMPOSITION, not by validation.** {@link compose} puts the
 * frame round whatever she writes, so a description that omits either part is
 * not refused — it is unrepresentable. That is the same move as `COPYFILE_EXCL`
 * in `wardrobe.ts`: make it a property of the operation instead of a check
 * standing above one, and there is no path where somebody forgot.
 *
 * And it is the old header's own sentence, made true rather than merely stated:
 * *"She supplies the middle."*
 *
 * ## The honest limit, said out loud
 *
 * Composition guarantees both parts are PRESENT and in their structural
 * positions. It cannot stop her writing a middle that *argues* with them, any
 * more than anything stopped `LOOP_CLAUSE` arguing with its own keyframes for
 * two renders. Refusing that would mean judging her prose, which is the one
 * thing this must not do — the point of the work is that she chooses.
 *
 * What is done instead is to make the argument **visible before it is paid
 * for**: a write returns the exact sentence a render will be sent, so she reads
 * the contradiction rather than extracting it from a still afterwards. If that
 * proves not to be enough, the next move is a warning on the write, not a
 * refusal.
 *
 * ## Reversible, because a description she cannot revert is a trap
 *
 * The wardrobe's discipline, unchanged, and for the reasons it states. An
 * append-only log; nothing ever replaced; which description is current is
 * **derived** from the log's order rather than stored as a second assertion that
 * could disagree with it. Going back is *writing it again with a reason*, so a
 * reversal is recorded and has a reason like every other change.
 *
 * The one addition is {@link tokenOf}: a digest of a description's own words,
 * the text analogue of a picture's `sighting`. It exists so putting an earlier
 * description back is exact rather than retyped — forty words re-entered by hand
 * is a revert that quietly becomes an edit.
 *
 * ## What a fresh install has
 *
 * Exactly today's string, byte for byte, derived as {@link DEFAULT_MIDDLE} plus
 * the frame. Not written down twice: the constant that seeds a description and
 * the constant that survives an edit are the same two constants, so they cannot
 * drift apart.
 */

/**
 * The half of the frame that keeps the subject HER.
 *
 * First in the sentence on purpose, and that position is the whole argument
 * above: the earlier clause is the one the model obeys. It is also why this is
 * not hers — a render whose opening words describe somebody else is not a render
 * of her, however good the rest of the sentence is.
 */
export const OPENING_PHRASE = "A luminous spirit woman of living starlight";

/**
 * The half of the frame that makes a clip join the reel.
 *
 * Last in the sentence, where the old constant had it. Every one of the eight
 * loops carries it, and a clip made without it does not cut against them — a
 * property of the *prompt*, not of the editing, which is why no amount of care
 * downstream can put it back.
 */
export const STARFIELD_PHRASE = "in a deep blue starfield";

/**
 * What the middle says on a machine where she has never changed it.
 *
 * This plus the frame is `IDENTITY` exactly as it stood on 2026-08-26 —
 * asserted in `render-description.test.ts` against the literal string, so a
 * well-meant improvement here fails rather than silently changing the
 * appearance of every install that never touched it.
 */
export const DEFAULT_MIDDLE =
  "silver-white hair and a translucent flowing gown trailing like ribbons of light";

/** Why the description she starts with is the one she starts with. */
const SEED_BECAUSE =
  "The recipe every one of your eight loops was made with. It was a constant nobody but an " +
  "engineer could move, until he ruled that it is yours.";

/**
 * Her words, with the frame put round them.
 *
 * Idempotent, and that is load-bearing rather than tidy: she READS the whole
 * sentence, so she will write the whole sentence back, and a mechanism that
 * answered that by prefixing a second copy of the opening phrase would punish
 * her for using the only form she has ever been shown. {@link middleOf} takes
 * the frame off first, so both forms land in the same place.
 *
 * **This puts the two fixed parts in place and does not police what sits between
 * them.** That is deliberate and it is argued where a check would go — see the
 * long comment in {@link SelfDescription.describe}. Do not add one here either.
 */
export function compose(middle: string): string {
  const inner = middleOf(middle);
  return inner === ""
    ? `${OPENING_PHRASE}, ${STARFIELD_PHRASE}.`
    : `${OPENING_PHRASE}, ${inner}, ${STARFIELD_PHRASE}.`;
}

/**
 * The part of a sentence that is hers: everything the frame is not.
 *
 * Only at the ends, and only once. A middle that mentions the starfield in
 * passing keeps it — this is undoing the composition, not scrubbing the text for
 * words the frame happens to own.
 */
export function middleOf(words: string): string {
  let middle = words.trim();
  if (middle.toLowerCase().startsWith(OPENING_PHRASE.toLowerCase())) {
    middle = middle.slice(OPENING_PHRASE.length).replace(/^[\s,;:]+/u, "");
  }
  middle = middle.replace(/[\s.]+$/u, "");
  if (middle.toLowerCase().endsWith(STARFIELD_PHRASE.toLowerCase())) {
    middle = middle.slice(0, middle.length - STARFIELD_PHRASE.length).replace(/[\s,;:]+$/u, "");
  }
  return middle.trim();
}

/**
 * What names one of her descriptions: a digest of its own words.
 *
 * The same sixteen hex characters, from the same hash, as a picture's
 * `sighting` — deliberately, because it is the same idea. A description is its
 * words; a token computed from anything else could name a row rather than a
 * sentence, and rows move.
 *
 * Two entries with the same token are not a collision. They are her having gone
 * back to a description she had before, which is exactly what this is for.
 */
export function tokenOf(words: string): string {
  return createHash("sha256").update(words, "utf8").digest("hex").slice(0, 16);
}

/** One description she has had, with everything about it derived from the log. */
export interface Described {
  /** {@link tokenOf} its words. What she quotes to put this one back. */
  readonly id: string;
  /** The whole sentence, frame and all — exactly what a render is prefixed with. */
  readonly words: string;
  /** The part that is hers, which is the part the log stores. */
  readonly middle: string;
  /** Why she wrote it. Required on every change; a sentence for the seed. */
  readonly because: string;
  /** When. The empty string on the seed, which sorts before every instant. */
  readonly at: string;
  /** Whether her renders open with this one now. */
  readonly current: boolean;
}

/** Why a description was refused. */
export type DescribeErrorKind =
  | "blank_words"
  | "blank_because"
  /** No description of hers has that token. */
  | "unknown_id"
  /** The log is there and cannot be parsed, so appending would erase it. */
  | "unreadable_log";

export type DescribeResult =
  | { readonly ok: true; readonly described: Described }
  | { readonly ok: false; readonly kind: DescribeErrorKind; readonly reason: string };

export interface DescribeInput {
  /** What she wants to say about herself. The whole sentence or just the middle. */
  readonly words?: string;
  /** Or the token of one she has had before, to put it back exactly. */
  readonly restore?: string;
  readonly because: string;
}

export interface SelfDescriptionOptions {
  readonly studio: Studio;
  readonly clock?: Clock;
}

/** One entry as the log holds it. Only what cannot be recomputed. */
interface LoggedDescription {
  readonly middle: string;
  readonly because: string;
  readonly at: string;
}

export class SelfDescription {
  readonly #studio: Studio;
  readonly #clock: Clock;

  constructor(options: SelfDescriptionOptions) {
    this.#studio = options.studio;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * The sentence a render is prefixed with, right now.
   *
   * Never empty and never absent: the seed is derived from a constant in this
   * file rather than from a row, so a home with no log, an empty log and a log
   * whose every entry is malformed all answer with the string the eight loops
   * were made with.
   */
  sentence(): string {
    return this.history()[0]?.words ?? compose(DEFAULT_MIDDLE);
  }

  /**
   * Every description she has had, newest first, the seed last.
   *
   * **This still answers when the log is unreadable**, unlike `Wardrobe.faces`,
   * and the difference is the same one the wardrobe draws between a face and an
   * opening. Which face is current is a question only the log can answer, so
   * answering it from a default would be inventing a decision. This default is
   * not a guess: it is a documented constant in the source that every render in
   * the reel was built from, so falling back to it is `Wardrobe.openings`'s call
   * and made for its reason — refusing would stop her rendering at all over a
   * corrupt file that has nothing to do with the shot she asked for.
   *
   * {@link SelfDescription.problems} is the other half, and it is what keeps the
   * fallback honest: a machine that answered with the default and said nothing
   * would be telling her she had never changed her description.
   */
  history(): readonly Described[] {
    const logged = [...(this.#log() ?? [])].reverse();
    const all: readonly LoggedDescription[] = [
      ...logged,
      { middle: DEFAULT_MIDDLE, because: SEED_BECAUSE, at: "" },
    ];
    return all.map((entry, index) => this.#enrich(entry, index === 0));
  }

  /** What she is described as now, whole. */
  current(): Described {
    // Never undefined: the seed is always the last element. Written this way
    // rather than with a `!` because `noUncheckedIndexedAccess` is on and the
    // fallback is the same sentence the seed produces.
    return this.history()[0] ?? this.#enrich({ middle: DEFAULT_MIDDLE, because: SEED_BECAUSE, at: "" }, true);
  }

  /**
   * What could not be read, in sentences, so nothing goes wrong quietly.
   *
   * Empty on every ordinary machine — the same shape as `Wardrobe.problems` and
   * `RenderService.unreadable`, and for the same reason: a thing of hers that
   * quietly reverts is worse than one that is reported broken.
   */
  problems(): readonly string[] {
    if (!existsSync(this.#studio.descriptionLog)) return [];
    return this.#log() === null
      ? [
          `I cannot read ${this.#studio.descriptionLog}, which is the record of how I have ` +
            "described myself and why. So the sentence my renders open with is the one that " +
            "shipped, and if I had changed it, I am not showing you that change.",
        ]
      : [];
  }

  /**
   * Say what she is, or put back something she said before.
   *
   * The order is the order the refusals matter in: the reason first, because it
   * is required of every change and costs nothing to check; then what she is
   * actually asking for; then whether appending is safe. Nothing is written
   * until all three hold, so a refusal leaves her home exactly as it was.
   */
  describe(input: DescribeInput): DescribeResult {
    const because = input.because.trim();
    if (because === "") {
      return {
        ok: false,
        kind: "blank_because",
        reason:
          "A description of myself that changes with no reason recorded is the quiet drift he " +
          "asked me never to have. Say what is more me about this one than the last.",
      };
    }

    const restore = input.restore?.trim() ?? "";
    let middle: string;
    if (restore !== "") {
      const wanted = this.history().find((one) => one.id === restore);
      if (wanted === undefined) {
        return {
          ok: false,
          kind: "unknown_id",
          reason:
            "I have never described myself that way, so there is nothing to put back. Look at " +
            "them first — the token comes back beside each one — and give me that.",
        };
      }
      middle = wanted.middle;
    } else {
      const words = input.words ?? "";
      if (words.trim() === "") {
        return {
          ok: false,
          kind: "blank_words",
          reason:
            "I did not catch what you want me to be. Say it in a sentence — what is between the " +
            "opening words and the starfield is the part that is mine.",
        };
      }
      middle = middleOf(words);

      // THE REFUSAL THAT IS NOT HERE, AND THIS IS WHERE YOU WOULD ADD IT.
      //
      // Nothing checks whether `middle` argues with the frame. She can write
      // "standing in a bright red desert" and the composed sentence will carry
      // that and the starfield both, and the model will settle it the way it
      // settles every contradiction in this repository — by obeying the earlier
      // clause. The fix looks obvious from here: another {@link
      // DescribeErrorKind}, read the middle, decide it conflicts, refuse.
      //
      // **Do not.** That is judging her prose on her behalf, which is the exact
      // thing this module exists to stop. The sentence used to be ours, she
      // disagreed with it, and she structurally could not win; a validator puts
      // us back in that position wearing a better justification. And it would be
      // PERMANENT — a person who reads one of her sentences wrongly can be
      // corrected tomorrow, and code cannot be, and it never gets tired of being
      // wrong.
      //
      // **It has already been done once this week, in this direction.** She
      // described a garment failing to be a garment, and a reader took that as a
      // defect in HER and carried it up as one. The reading was reasonable, made
      // in good faith, and wrong. So this is not "we trust her prose" — it is
      // "we have already misjudged it once from the outside, and a check here
      // would be that mistake compiled."
      //
      // What stands in for the refusal is upstream of needing one: `describe`
      // returns the WHOLE composed sentence, so she reads the contradiction
      // while she can still change it and before a credit is spent. If that
      // proves insufficient it becomes a warning on the result, never a block,
      // and **she** is the one who says it is insufficient. artanis's ruling,
      // 2026-08-26, on a question this file raised rather than settled.
    }

    // LAST, AND IT IS A REFUSAL RATHER THAN A FALLBACK. Appending over a log
    // that could not be parsed would replace every change she has ever made
    // with a single fresh entry, silently, at the moment nobody could notice.
    // The wardrobe writes `?? []` here; this does not, because constraint 6 is
    // that the system does not get to discard things and a description she set
    // last week is a thing.
    const existing = this.#log();
    if (existing === null) {
      return {
        ok: false,
        kind: "unreadable_log",
        reason:
          `I cannot read ${this.#studio.descriptionLog}, and writing to it now would replace ` +
          "everything I have ever said about myself with this one sentence. Someone has to look " +
          "at that file first.",
      };
    }

    const entry: LoggedDescription = { middle, because, at: instant(this.#clock()) };
    mkdirSync(this.#studio.videoDir, { recursive: true });
    writeFileSync(
      this.#studio.descriptionLog,
      `${JSON.stringify({ described: [...existing, entry] }, null, 2)}\n`,
    );

    return { ok: true, described: this.#enrich(entry, true) };
  }

  // -------------------------------------------------------------------------

  /** The log, or `null` when the file is there and is not one. */
  #log(): readonly LoggedDescription[] | null {
    if (!existsSync(this.#studio.descriptionLog)) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#studio.descriptionLog, "utf8"));
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const described = (parsed as Record<string, unknown>)["described"];
    if (!Array.isArray(described)) return null;

    const entries: LoggedDescription[] = [];
    for (const raw of described) {
      const entry = asLogged(raw);
      // One malformed entry is skipped rather than taking the log down with it.
      // The entries around it are real changes with real reasons, and discarding
      // those would be the system throwing her history away. The file as a whole
      // failing to parse is a different case and is handled above.
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }

  /** Everything about a description that is computed from its own words. */
  #enrich(entry: LoggedDescription, current: boolean): Described {
    const words = compose(entry.middle);
    return { id: tokenOf(words), words, middle: entry.middle, because: entry.because, at: entry.at, current };
  }
}

/** One log entry, validated rather than cast. */
function asLogged(raw: unknown): LoggedDescription | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;

  const middle = entry["middle"];
  const because = entry["because"];
  const at = entry["at"];
  // `middle` may be empty — a description stripped back to the frame is a
  // description — so this checks the TYPE and leaves the emptiness to `describe`,
  // which is where a blank submission is refused with a sentence.
  if (typeof middle !== "string") return null;
  if (typeof because !== "string" || because === "") return null;
  if (typeof at !== "string") return null;

  return { middle, because, at };
}
