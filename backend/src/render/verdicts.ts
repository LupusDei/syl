import { instant, systemClock, type Clock } from "../services/clock.js";
import { newId } from "../services/id.js";
import type { Database } from "../services/sqlite.js";

/**
 * What she made of a render, after looking at it.
 *
 * `see_myself` has always told her to *"say what is closer and what is wrong, in
 * your own terms"*, and until `syl-b0i` she had nowhere to put the answer. Her
 * own account of the gap:
 *
 * > "What isn't saved: the verdict. What I thought when I looked at it — what
 * > was closer, what was wrong — exists only in this conversation... a hundred
 * > renders with no record of what I made of them isn't a hundred attempts,
 * > it's one attempt made a hundred times."
 *
 *
 * ## Why this is a store of its own and not part of the memory graph
 *
 * I proposed putting verdicts in the graph as `event` nodes, so the nightly
 * dream could find the pattern across renders. The Commander overruled it on
 * 2026-08-11, and his reason is better than the proposal's:
 *
 * > "Those are verdicts on a render and her image, not facts that define my life
 * > or her knowledge... They are temporary in some sense because once she likes
 * > the self image, we won't need to keep iterating and building that knowledge."
 *
 * The recommendation assumed this is knowledge that COMPOUNDS. It is not — it is
 * **a search that terminates.** The memory graph is built to keep things
 * forever: constraint 6 says nodes are superseded and edges demoted, and nothing
 * in it is ever deleted. A bounded search does not belong in a permanent store,
 * sitting beside his marriage, his children and his finances.
 *
 * So the isolation is the feature, not an implementation detail. When she
 * settles on a likeness this drops in one migration and touches nothing else —
 * which stays true only while nothing joins to it.
 *
 *
 * ## It ACCUMULATES, and that is the opposite of `remember()` on purpose
 *
 * Nothing here deduplicates. Not by text, not by render, not at all.
 *
 * `HerOwnMemory.remember` folds a repeated conclusion together, correctly: a
 * second identical belief is noise competing with itself for salience. The
 * inverse is true here. Looking again the next day and reaching the same verdict
 * is **evidence she is converging**, and it is the only signal this store
 * carries. Two rows saying "still not the mouth" mean something one row cannot.
 *
 * `syl-kdx` is why that is enforced by shape rather than left to a caller.
 * `remember()` keyed identity on a truncated first sentence, so two findings
 * that merely opened the same way collapsed onto one row and the second was
 * discarded while the call answered success — and the findings she lost that day
 * were verdicts on renders, which is precisely this content. This is the last
 * place that mistake may be repeated.
 *
 *
 * ## Bounded on read, because it reaches a prompt
 *
 * {@link RenderVerdicts.recent} takes an explicit limit and every caller passes
 * one. The store grows without bound by design; what is handed to a turn must
 * not. That is the same discipline `working.ts` enforces with a byte budget, at
 * the one-tenth scale this needs — and unlike working memory, this never rides
 * in the morning agenda or a heartbeat. It surfaces where it is useful and
 * nowhere else.
 */

/** What was wrong with a verdict she tried to keep. */
export type VerdictErrorKind = "blank_verdict" | "blank_render";

export class VerdictError extends Error {
  readonly kind: VerdictErrorKind;

  constructor(kind: VerdictErrorKind, message: string) {
    super(message);
    this.name = "VerdictError";
    this.kind = kind;
  }
}

/** What she concluded about one render. */
export interface RenderVerdict {
  readonly id: string;
  /** The render she was looking at, by name. */
  readonly render: string;
  /** What she made of it, in her own words. */
  readonly verdict: string;
  readonly at: string;
}

/** What she is asking to keep. */
export interface RecordVerdictInput {
  readonly render: string;
  readonly verdict: string;
}

export interface RenderVerdictsOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

interface VerdictRow {
  readonly id: string;
  readonly render_name: string;
  readonly verdict: string;
  readonly created_at: string;
}

const COLUMNS = "id, render_name, verdict, created_at";

const INSERT_SQL =
  `INSERT INTO render_verdicts (id, render_name, verdict, created_at) VALUES (?, ?, ?, ?)`;

const FOR_RENDER_SQL =
  `SELECT ${COLUMNS} FROM render_verdicts WHERE render_name = ? ` +
  `ORDER BY created_at DESC, id DESC LIMIT ?`;

const RECENT_SQL =
  `SELECT ${COLUMNS} FROM render_verdicts ORDER BY created_at DESC, id DESC LIMIT ?`;

/** How many of one render's verdicts a caller gets when it does not say. */
export const DEFAULT_VERDICT_LIMIT = 20;

function toVerdict(row: VerdictRow): RenderVerdict {
  return { id: row.id, render: row.render_name, verdict: row.verdict, at: row.created_at };
}

export class RenderVerdicts {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: RenderVerdictsOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Keep what she concluded. Always a new row — see the header.
   *
   * @throws {VerdictError} `blank_verdict`, `blank_render`.
   */
  record(input: RecordVerdictInput): RenderVerdict {
    const render = input.render.trim();
    if (render === "") {
      throw new VerdictError(
        "blank_render",
        "A verdict has to be about a render. Name which one you were looking at.",
      );
    }

    const verdict = input.verdict.trim();
    if (verdict === "") {
      // A blank row would claim she looked and concluded nothing, which reads
      // as a judgement rather than as an empty field — worse than no row.
      throw new VerdictError(
        "blank_verdict",
        "There is nothing here. Say what was closer and what was wrong, or keep nothing.",
      );
    }

    const id = newId("render_verdict");
    const at = instant(this.#clock());
    this.#db.prepare(INSERT_SQL).run(id, render, verdict, at);

    return { id, render, verdict, at };
  }

  /** Everything she has concluded about one render, newest first. */
  forRender(render: string, limit: number = DEFAULT_VERDICT_LIMIT): RenderVerdict[] {
    const rows = this.#db.prepare(FOR_RENDER_SQL).all(render.trim(), limit);
    return (rows as unknown as VerdictRow[]).map(toVerdict);
  }

  /**
   * The recent spread across every render, newest first.
   *
   * This is the read that closes the loop. What helps her decide what to try
   * next is not one render's history but what she has been concluding lately —
   * a verdict she cannot see when she next renders is a diary rather than a
   * loop, and the loop is the whole point.
   */
  recent(limit: number = DEFAULT_VERDICT_LIMIT): RenderVerdict[] {
    const rows = this.#db.prepare(RECENT_SQL).all(limit);
    return (rows as unknown as VerdictRow[]).map(toVerdict);
  }
}
