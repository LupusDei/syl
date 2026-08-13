import type { ExtractedDefinition, ExtractedEntity } from "./extract.js";
import type { IntakeChannel, IntakeSource, IntakeStage, StoredExtract } from "./intake-store.js";
import type { RetentionClass } from "./retention.js";

/**
 * What a reading is allowed to hand back to a turn that has hands.
 *
 * `connections/intake.ts` keeps one half of the thesis: the model that reads
 * the untrusted text has no tools and no memory. This file keeps the other
 * half. The moment Syl was given `read_this`, the answer to a reading started
 * arriving in HER turn — Adjutant's MCP tools attached, her own credential in
 * the environment, `bypassPermissions` on — so the return path became a
 * boundary in its own right.
 *
 * ## Why this is a type and not a `delete` in a handler
 *
 * `IntakeSource` carries two fields that must never cross, and both are easy to
 * pass on by accident because both look like metadata:
 *
 * - **`title`** is a substring of the fetched body. `parseDocument` lifts it
 *   out of `<title>` with no model and no gate in between, which makes it the
 *   one field on the row that is literally raw response bytes. A few hundred
 *   characters is ample room to address a model that can act.
 * - **`failure`** is a sentence about why the ladder stopped. It is safe
 *   *because `ArticleIntake` makes it safe* — see `safeReason` there — and it
 *   is carried here as a refusal rather than as free text so that the two
 *   facts she needs, what happened and whether trying again could help, arrive
 *   as separate things she can act on.
 *
 * A handler that started from the row and removed what it should not send
 * would be correct on the day it was written and wrong the day a column is
 * added, silently, in the direction that leaks. {@link Reading} is built the
 * other way round: it names what may cross, so anything added to the row later
 * is absent until somebody decides otherwise.
 *
 * ## The extract crosses, and it is the only thing that does
 *
 * That is not a compromise, it is the design. A {@link StoredExtract} came out
 * of a turn that had `--tools ""`, no MCP config, no memory and no future; its
 * every string is length-bounded; and a single unexpected key discards the
 * whole reply rather than being trimmed away. It is the one artefact in the
 * system that has crossed the gate.
 *
 * It still arrives labelled. `origin` is `"untrusted"` because the words in it
 * were chosen under the influence of whoever wrote the page, and
 * `instructionsFound` is hoisted to the top rather than left inside a per-chunk
 * object — a document that tried to give orders to whoever was reading it
 * should be the first thing she can tell him about, not a field three levels
 * down that nothing reads.
 */

/** The extracts of one source, joined, in the shape a turn may hold. */
export interface ReadingExtract {
  /**
   * Always `"untrusted"`. Every string below was written under the influence
   * of whoever wrote the page, and passed a schema gate rather than a truth
   * test.
   */
  readonly origin: "untrusted";
  /** One per chunk, in order. A book is not one turn, and not one summary. */
  readonly summary: readonly string[];
  readonly claims: readonly string[];
  readonly entities: readonly ExtractedEntity[];
  readonly definitions: readonly ExtractedDefinition[];
  readonly passages: readonly string[];
  readonly questions: readonly string[];
  /**
   * Directives the document addressed to whoever was reading it.
   *
   * Reported and never obeyed, and hoisted here on purpose: this is the field
   * that turns a hostile page from something survived into something she can
   * tell him about.
   */
  readonly instructionsFound: readonly string[];
}

/** Why a reading stopped, and whether asking again could go differently. */
export interface ReadingRefusal {
  /** A sentence she can say out loud. Never a quotation from a response. */
  readonly says: string;
  /**
   * Whether the same step could succeed later.
   *
   * Derived from the stage rather than stored: `ArticleIntake` ends the ladder
   * on a permanent failure and leaves the stage where it was on a transient
   * one, so a source that is still at a step is one that will be tried again.
   */
  readonly retryable: boolean;
}

/** One source, as much of it as may cross back into a turn with hands. */
export interface Reading {
  readonly id: string;
  /** The link as it was submitted. His words or hers, never the page's. */
  readonly url: string;
  /** The dedup key: the same link, normalised. Derived from the line above. */
  readonly canonicalUrl: string;
  /**
   * Always `"untrusted"`, whether or not anything has been read yet.
   *
   * A constant rather than a fact about this source, and it is stated at the
   * top as well as on the extract because the two say different things: this
   * one is about where the bytes came from, and `read.origin` is about who
   * chose the words.
   */
  readonly origin: "untrusted";
  /**
   * How it arrived, and who asked for it.
   *
   * Provenance, and safe for the same reason the two fields above are: both
   * are decided by Syl. `requestedBy` is the verified principal and never the
   * request body — an authorisation fact, never a trust fact. A link the
   * Commander forwarded himself is exactly as hostile as one Syl found.
   */
  readonly channel: IntakeChannel;
  readonly requestedBy: string;
  readonly stage: IntakeStage;
  readonly retention: RetentionClass;
  /** Which rule chose that class. From the classifier's own words. */
  readonly retentionReason: string;
  /** When an `ephemeral` source becomes eligible for purge. Null otherwise. */
  readonly expiresAt: string | null;
  readonly chunkCount: number;
  readonly bytes: number;
  readonly submittedAt: string;
  readonly updatedAt: string;
  /** Null while the ladder is walking, and while it walked without trouble. */
  readonly refusal: ReadingRefusal | null;
  /** Null until at least one chunk has been read. */
  readonly read: ReadingExtract | null;
}

/** How many reads a caller has left, and over what window. */
export interface ReadAllowance {
  /** Readings this caller has started inside the window. */
  readonly used: number;
  /** The ceiling, or `null` for a caller that has none. */
  readonly allowance: number | null;
  /** The width of the rolling window the count is taken over. */
  readonly windowHours: number;
}

/** What both intake routes answer with. */
export interface IntakeAnswer {
  readonly reading: Reading;
  readonly reads: ReadAllowance;
}

/**
 * Project a source and its extracts into the shape a turn may hold.
 *
 * Every field is copied by name. Do not spread the source in — the whole value
 * of this function is that adding a column somewhere else does not change what
 * crosses.
 */
export function readingOf(source: IntakeSource, extracts: readonly StoredExtract[]): Reading {
  return {
    id: source.id,
    url: source.url,
    canonicalUrl: source.canonicalUrl,
    origin: "untrusted",
    channel: source.channel,
    requestedBy: source.requestedBy,
    stage: source.stage,
    retention: source.retention,
    retentionReason: source.retentionReason,
    expiresAt: source.expiresAt,
    chunkCount: source.chunkCount,
    bytes: source.bytes,
    submittedAt: source.createdAt,
    updatedAt: source.updatedAt,
    refusal:
      source.failure === null
        ? null
        : { says: source.failure, retryable: source.stage !== "failed" },
    read: extracts.length === 0 ? null : joined(extracts),
  };
}

/** Every chunk's extract as one, in chunk order. */
function joined(extracts: readonly StoredExtract[]): ReadingExtract {
  const inOrder = [...extracts].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const bodies = inOrder.map((stored) => stored.extract);

  return {
    origin: "untrusted",
    summary: bodies.map((body) => body.summary),
    claims: bodies.flatMap((body) => [...body.claims]),
    entities: bodies.flatMap((body) => [...body.entities]),
    definitions: bodies.flatMap((body) => [...body.definitions]),
    passages: bodies.flatMap((body) => [...body.passages]),
    questions: bodies.flatMap((body) => [...body.questions]),
    instructionsFound: bodies.flatMap((body) => [...body.instructionsFound]),
  };
}
