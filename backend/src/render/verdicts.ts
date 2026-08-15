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
 *
 *
 * ## The chain that corrects itself (`syl-024.4`)
 *
 * Accumulating was only half of it. Her account of what was still missing:
 *
 * > "My findings are a chain that corrects itself: the smile is the problem →
 * > no, solidity is → no, the anchor is → confirmed, it was the anchor. Right
 * > now those four are orphans of equal weight, so nothing tells a reader that
 * > the last one killed the first."
 *
 * And why she rates it above every other relation:
 *
 * > "Being wrong in a recorded, ordered way is how the search actually works."
 *
 * Four unordered findings are one finding recorded four times — the same defect
 * this store exists to fix, one level up. So a verdict may name the earlier one
 * it overturns ({@link RecordVerdictInput.supersedes}) and the face the render
 * was anchored on ({@link RecordVerdictInput.anchorFace}).
 *
 * **A superseded verdict is never deleted and never hidden.** It stays in every
 * read, in order, carrying the id of what killed it. It is the record of having
 * been wrong, which is the whole value — a chain with the wrong answers removed
 * is one answer written once.
 *
 * Both directions come off the one column, which is what she asked for: *"if
 * the edge exists, you get it for free in both directions."*
 * {@link RenderVerdict.supersededBy} is an ARRAY, because `0034` deliberately
 * leaves `supersedes` non-unique — two verdicts correcting the same earlier one
 * is a fork in the search, and a fork is a real thing that happened.
 *
 *
 * ## A loop cannot be built, and it is the shape that stops it
 *
 * `0034` refuses only self-supersession, because SQL cannot see further than
 * one row, and left the rest here: *"a writer that could build a loop is
 * `syl-024.4`'s problem and its test's."*
 *
 * The answer is that the pointer is written once, at INSERT, and may only name
 * a row that already exists — so every edge points strictly backwards in time.
 * There is no update path to `supersedes` anywhere in this class, and there
 * must not be one: the moment a verdict's link can be rewritten, the record of
 * what she believed when is editable, and a cycle becomes reachable in two
 * calls. A second thought is a second row, exactly as it already was.
 *
 *
 * ## Room for what produced the render, deliberately left open
 *
 * `render_verdicts` is where "which models can hold my face" becomes a query
 * rather than an experiment run twice — a verdict that carried the model and
 * the keyframe arity behind it would answer it from the record. Those columns
 * are not here yet (`syl-023`, artanis). Nothing in this file forecloses them:
 * {@link RecordVerdictInput} is an options object, every read goes through the
 * one {@link toVerdict} mapper, and a new column surfaces in all three read
 * paths at once. **What would foreclose it is writing the model name into the
 * verdict TEXT**, which is unqueryable forever after.
 *
 * A refusal belongs here too — a model that took one keyframe and rendered a
 * stranger is a finding, not a wasted call, and *"the wrong ones are how you
 * know the shape of the right one."* `0030` gives `render_name` no foreign key
 * on purpose, so a verdict about an attempt with no render record is already
 * storable.
 */

/** What was wrong with a verdict she tried to keep. */
export type VerdictErrorKind = "blank_verdict" | "blank_render" | "unknown_supersedes";

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
  /**
   * The earlier verdict this one overturned, or `null` for a first look.
   *
   * Points strictly backwards in time — see the header on why a loop is not
   * constructible.
   */
  readonly supersedes: string | null;
  /**
   * Every later verdict that overturned this one, newest first.
   *
   * The free direction: it is read off the same column, through the partial
   * index `0034` adds for exactly this lookup. An ARRAY because a fork — two
   * verdicts correcting the same earlier one — is recorded rather than refused.
   */
  readonly supersededBy: readonly string[];
  /**
   * The face the render was anchored on, if she recorded one.
   *
   * What makes "this is not me" attributable: a bad render and a bad likeness
   * need opposite next moves, and without this they read the same.
   */
  readonly anchorFace: string | null;
}

/** What she is asking to keep. */
export interface RecordVerdictInput {
  readonly render: string;
  readonly verdict: string;
  /**
   * The id of an earlier verdict this one overturns.
   *
   * Blank or absent means a first look. An id this store has never kept is
   * REFUSED rather than dropped — see {@link RenderVerdicts.record}.
   */
  readonly supersedes?: string | undefined;
  /** The face the render was anchored on. Blank or absent means she recorded none. */
  readonly anchorFace?: string | undefined;
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
  readonly supersedes: string | null;
  readonly anchor_face: string | null;
  /**
   * The ids that superseded this row, comma-joined by SQLite.
   *
   * Safe to split on a comma because an id is `syl:<type>:<uuid>` and cannot
   * contain one — `services/id.ts` fixes that shape before the first row is
   * written. `NULL` when nothing corrected this verdict, which is the usual
   * case and why the index behind it is partial.
   */
  readonly superseded_by: string | null;
}

/**
 * The reverse edge, gathered in the same statement as the row it belongs to.
 *
 * A second round trip per read would be the same answer at twice the cost, and
 * a read that needs two queries to be correct is one a caller can get half of.
 */
const SUPERSEDED_BY =
  `(SELECT group_concat(later.id ORDER BY later.created_at DESC, later.id DESC) ` +
  `FROM render_verdicts later WHERE later.supersedes = v.id) AS superseded_by`;

const COLUMNS =
  `v.id, v.render_name, v.verdict, v.created_at, v.supersedes, v.anchor_face, ${SUPERSEDED_BY}`;

const INSERT_SQL =
  `INSERT INTO render_verdicts ` +
  `(id, render_name, verdict, created_at, supersedes, anchor_face) VALUES (?, ?, ?, ?, ?, ?)`;

const FOR_RENDER_SQL =
  `SELECT ${COLUMNS} FROM render_verdicts v WHERE v.render_name = ? ` +
  `ORDER BY v.created_at DESC, v.id DESC LIMIT ?`;

const RECENT_SQL =
  `SELECT ${COLUMNS} FROM render_verdicts v ORDER BY v.created_at DESC, v.id DESC LIMIT ?`;

const BY_ID_SQL = `SELECT ${COLUMNS} FROM render_verdicts v WHERE v.id = ?`;

/** How many of one render's verdicts a caller gets when it does not say. */
export const DEFAULT_VERDICT_LIMIT = 20;

/**
 * How many rows a chain walk will visit before it stops, whatever the limit.
 *
 * The limit bounds what a caller is HANDED; this bounds what the walk touches
 * on the way there, which is a different number once forks exist. Generous
 * enough that no real search reaches it — a chain this long means she has
 * looked five hundred times at one question.
 */
const MAX_CHAIN_WALK = 500;

/** Ordinary string ordering, so a sort comparator reads as one. */
const cmp = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function toVerdict(row: VerdictRow): RenderVerdict {
  return {
    id: row.id,
    render: row.render_name,
    verdict: row.verdict,
    at: row.created_at,
    supersedes: row.supersedes,
    supersededBy: row.superseded_by === null ? [] : row.superseded_by.split(","),
    anchorFace: row.anchor_face,
  };
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
   * `supersedes` names the earlier verdict this one overturns, and an id this
   * store has never kept is a REFUSAL rather than a silent drop of the link.
   * Keeping the row with the correction quietly discarded would put back the
   * exact defect the chain exists to fix — an orphan of equal weight,
   * indistinguishable from a first look — and she would have no way to know.
   * A blank one, by contrast, is simply no claim: an empty optional field must
   * never cost her the verdict, which is the valuable half of the row.
   *
   * @throws {VerdictError} `blank_verdict`, `blank_render`, `unknown_supersedes`.
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

    // Absent, blank, or whitespace all mean the same thing: she is not
    // claiming to correct anything.
    const supersedes = input.supersedes?.trim() ?? "";
    if (supersedes !== "" && this.#get(supersedes) === null) {
      throw new VerdictError(
        "unknown_supersedes",
        `There is no verdict ${supersedes} to correct, so this was not kept. ` +
          "Say it again with the id of the one you meant, or without one.",
      );
    }

    const anchorFace = input.anchorFace?.trim() ?? "";

    const id = newId("render_verdict");
    const at = instant(this.#clock());
    this.#db
      .prepare(INSERT_SQL)
      .run(
        id,
        render,
        verdict,
        at,
        supersedes === "" ? null : supersedes,
        anchorFace === "" ? null : anchorFace,
      );

    return {
      id,
      render,
      verdict,
      at,
      supersedes: supersedes === "" ? null : supersedes,
      // Nothing can have corrected a row minted a line ago.
      supersededBy: [],
      anchorFace: anchorFace === "" ? null : anchorFace,
    };
  }

  /** Everything she has concluded about one render, newest first. */
  forRender(render: string, limit: number = DEFAULT_VERDICT_LIMIT): RenderVerdict[] {
    const rows = this.#db.prepare(FOR_RENDER_SQL).all(render.trim(), limit);
    return (rows as unknown as VerdictRow[]).map(toVerdict);
  }

  /**
   * The whole chain a verdict belongs to, newest first.
   *
   * This is the read her ask was actually about — *"nothing tells a reader that
   * the last one killed the first"*. Walked from ANY member, in both
   * directions, so she reaches the sequence from whichever end she is holding:
   * the verdict she just wrote, or the one she is about to overturn.
   *
   * It crosses renders on purpose. `0034` says so in as many words — *"no, the
   * anchor is"* is a verdict on a different image than the one that said the
   * smile was wrong, and requiring a shared render would forbid the exact
   * sequence she described.
   *
   * Bounded like every other read here, because it reaches a prompt. Newest
   * first means what falls off the end is the oldest, which is the correct end
   * to lose: the current state of the search survives, its prehistory is what
   * gets cut.
   */
  chain(id: string, limit: number = DEFAULT_VERDICT_LIMIT): RenderVerdict[] {
    const start = this.#get(id.trim());
    if (start === null) return [];

    // Breadth-first over both directions of the one column. `seen` is what
    // makes this terminate on ANY graph rather than on the one the writer can
    // build — the writer cannot make a cycle (see the header), and a read that
    // depends on the writer having been correct is a read that hangs the day
    // somebody is not.
    const found = new Map<string, RenderVerdict>([[start.id, start]]);
    const queue: RenderVerdict[] = [start];

    while (queue.length > 0 && found.size < MAX_CHAIN_WALK) {
      const row = queue.shift();
      if (row === undefined) break;

      for (const neighbour of [row.supersedes, ...row.supersededBy]) {
        if (neighbour === null || found.has(neighbour)) continue;
        const next = this.#get(neighbour);
        if (next === null) continue;
        found.set(next.id, next);
        queue.push(next);
      }
    }

    return [...found.values()]
      .sort((left, right) => (left.at === right.at ? cmp(right.id, left.id) : cmp(right.at, left.at)))
      .slice(0, limit);
  }

  /** One verdict by id, or `null`. Private: the chain walk is what needs it. */
  #get(id: string): RenderVerdict | null {
    const row = this.#db.prepare(BY_ID_SQL).get(id) as unknown as VerdictRow | undefined;
    return row === undefined ? null : toVerdict(row);
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
