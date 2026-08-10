import { instant, parseInstant, systemClock, type Clock } from "../services/clock.js";
import { isId } from "../services/id.js";
import type { Database } from "../services/sqlite.js";
import type { MemoryGraph } from "./graph.js";
import { newMemoryAssertionId } from "./schema.js";

/**
 * The supersession ledger: facts are never deleted, they are RETIRED with a
 * validity interval. `syl-005.3.3`.
 *
 * `0015_supersession_ledger.sql` carries the full argument. This module is the
 * API that argument implies, and three of its properties are load-bearing.
 *
 *
 * ## 1. Deterministic. No threshold, no model call at read time
 *
 * The obvious design is to embed a new statement, compare it with what is
 * stored, and treat a close match as an update. It does not work:
 *
 *   **Embedding similarity cannot tell STALE from CURRENT.** A contradiction of
 *   a stored fact is on average *more* cosine-similar to it than a genuine
 *   duplicate is — "he works at Acme" and "he no longer works at Acme" share
 *   almost every token — so discriminating them by distance performs barely
 *   better than chance.
 *
 * Measured: a deterministic ledger reaches 0.95–1.00 accuracy on evolving
 * benchmarks where ordinary similarity retrieval gets 0.20–0.47, and serves a
 * superseded value essentially never against 15–40% for retrieval. An assistant
 * that answers with last year's job 15–40% of the time is not slightly worse;
 * it is not trustworthy.
 *
 * So supersession here is decided by a KEY — `(subject, relation)` — and by a
 * UNIQUE PARTIAL index, with nothing to tune. {@link SupersessionLedger.current}
 * is a point lookup.
 *
 * Identical re-assertion is idempotent, and that is **byte equality, not a
 * threshold**. Idempotence is not merging: aggressive near-duplicate merging is
 * measured to collapse accuracy from 0.82 to 0.62, so two values that merely
 * look alike are always two rows. In the other direction naive
 * retain-everything raises fabrication roughly sixfold — which the ledger
 * avoids not by discarding but by reading only what is open. **Bounded growth
 * is a consequence of supersession, never a goal pursued by compression.**
 *
 *
 * ## 2. Bi-temporal, because "when" is two questions
 *
 * | | columns | the question |
 * |---|---|---|
 * | valid time | `valid_from` / `valid_to` | when was it true *in the world*? |
 * | transaction time | `recorded_at` / `superseded_at` | when did Syl *believe* it? |
 *
 * They come apart constantly. If the Commander changed jobs in March and
 * mentioned it in June, the new assertion is valid from March and recorded in
 * June, and for three months Syl believed something already false.
 *
 * The bead's question — **"what did I believe in March?"** — is transaction
 * time, and {@link SupersessionLedger.believedAt} answers it.
 * {@link SupersessionLedger.trueAt} answers the other one: what does she NOW
 * think was the case in March. Both are one indexed lookup and neither
 * consults a model.
 *
 *
 * ## 3. Nothing is destroyed, and history is not rewritten
 *
 * The same instinct as constraint 4 and constraint 6: the system does not get
 * to discard things quietly. There is no `delete` in this module and no way to
 * reach one — the migration refuses every DELETE, and refuses any UPDATE that
 * rewrites what a row claimed or re-opens a closed row. The only legal write to
 * an existing row is closing it.
 *
 *
 * ## What is deliberately NOT here
 *
 * No confidence, no trust, no feedback score. A ledger entry is **current or
 * closed** — a property of an interval, not a number — and that is the real
 * difference from the edge weights in `syl-005.3.2`. An edge is *more or less
 * worth surfacing*, which is a ranking question and therefore a scalar that
 * decays. A fact is *the one in force or a former one*, which is a question
 * with an exact answer. Giving an assertion a confidence would reintroduce the
 * threshold this whole design exists to remove: "current enough" is precisely
 * the judgement that cannot be made reliably.
 */

/** A claim, with the two intervals that say when it held. */
export interface Assertion {
  readonly id: string;
  /** What the claim is about. A type-prefixed id. */
  readonly subject: string;
  /** The predicate. With `subject`, the key supersession is decided on. */
  readonly relation: string;
  /** The claim itself. Compared by byte equality, never by similarity. */
  readonly value: string;
  /** The graph node this value corresponds to, if there is one. */
  readonly valueNode: string | null;
  /** Valid time: when this became true in the world. */
  readonly validFrom: string;
  /** Valid time: when it stopped. `null` means "still true as far as Syl knows". */
  readonly validTo: string | null;
  /** Transaction time: when Syl learned it. */
  readonly recordedAt: string;
  /** Transaction time: when she learned otherwise. `null` means "believed now". */
  readonly supersededAt: string | null;
  /** What replaced it. `null` with a set `supersededAt` is a retirement. */
  readonly supersededBy: string | null;
  /** Provenance: the node this came from. */
  readonly assertedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What {@link SupersessionLedger.assert} needs. */
export interface AssertInput {
  readonly subject: string;
  readonly relation: string;
  readonly value: string;
  /** The graph node carrying this value. Demoted to `cold` when superseded. */
  readonly valueNode?: string;
  /** When it became true in the world. Defaults to now. */
  readonly validFrom?: string;
  /** The node — usually of kind `source` — this came from. */
  readonly assertedBy?: string;
}

/** What an assertion did to the ledger. */
export interface SupersessionResult {
  /** The row now in force for the key. */
  readonly current: Assertion;
  /** The row this one closed, or `null` if the key was empty or unchanged. */
  readonly superseded: Assertion | null;
  /**
   * Whether the value was already in force, so nothing was written.
   *
   * Byte equality. Two values that merely look alike are never `unchanged`.
   */
  readonly unchanged: boolean;
}

/** What went wrong, as a closed set a caller can branch on. */
export type LedgerErrorKind =
  | "bad_instant"
  | "bad_subject"
  | "blank_relation"
  | "blank_value"
  | "corrupt_row"
  | "no_such_assertion"
  | "unknown_node";

/** Thrown when the ledger cannot be read or written as asked. */
export class LedgerError extends Error {
  readonly kind: LedgerErrorKind;

  constructor(kind: LedgerErrorKind, message: string) {
    super(message);
    this.name = "LedgerError";
    this.kind = kind;
  }
}

const COLUMNS =
  "id, subject, relation, value, value_node, valid_from, valid_to, recorded_at, " +
  "superseded_at, superseded_by, asserted_by, created_at, updated_at";

interface AssertionRow {
  readonly id: string;
  readonly subject: string;
  readonly relation: string;
  readonly value: string;
  readonly value_node: string | null;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly recorded_at: string;
  readonly superseded_at: string | null;
  readonly superseded_by: string | null;
  readonly asserted_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * The current-value read, pinned as text.
 *
 * `superseded_at IS NULL` is not a filter that happens to work — it is the
 * predicate of `memory_assertions_current_idx`, which is UNIQUE. That is what
 * makes this a point lookup whose cost is the number of LIVE facts rather than
 * the number of rows, and what makes "two current values for one fact"
 * impossible rather than merely unlikely.
 */
export const CURRENT_ASSERTION_SQL =
  `SELECT ${COLUMNS} FROM memory_assertions ` +
  `WHERE subject = ? AND relation = ? AND superseded_at IS NULL`;

/**
 * "What did I believe at t?", pinned as text.
 *
 * Transaction time: recorded by then, and not yet superseded by then. Exactly
 * one row can satisfy it per key, because the unique partial index above means
 * the belief intervals cannot overlap.
 */
export const BELIEVED_AT_SQL =
  `SELECT ${COLUMNS} FROM memory_assertions ` +
  `WHERE subject = ? AND relation = ? AND recorded_at <= ? ` +
  `AND (superseded_at IS NULL OR superseded_at > ?) ` +
  `ORDER BY recorded_at DESC, id DESC LIMIT 1`;

function toAssertion(row: AssertionRow): Assertion {
  return {
    id: row.id,
    subject: row.subject,
    relation: row.relation,
    value: row.value,
    valueNode: row.value_node,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    recordedAt: row.recorded_at,
    supersededAt: row.superseded_at,
    supersededBy: row.superseded_by,
    assertedBy: row.asserted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireSubject(value: string): string {
  if (!isId(value)) {
    throw new LedgerError(
      "bad_subject",
      `A subject must be a type-prefixed id like syl:memory_node:<uuid>, got ` +
        `${JSON.stringify(value)}. Supersession is keyed on (subject, relation), so a subject ` +
        `that is merely a label would silently key two different things together.`,
    );
  }
  return value;
}

function requireText(value: string, kind: LedgerErrorKind, what: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new LedgerError(kind, `${what} cannot be blank.`);
  }
  return trimmed;
}

function requireInstant(value: string, what: string): string {
  if (parseInstant(value) === null) {
    throw new LedgerError(
      "bad_instant",
      `${what} must be an RFC 3339 UTC instant with millisecond precision, got ` +
        `${JSON.stringify(value)}. A fixed offset is a property of an instant, not of a ` +
        `place, and one that reaches storage survives exactly one DST boundary.`,
    );
  }
  return value;
}

export interface SupersessionLedgerOptions {
  readonly db: Database;
  /**
   * The graph, so superseding an assertion can demote the node carrying the
   * stale value. `0012_memory_core.sql` says supersession is what moves a node
   * to `cold`; this is where that happens.
   */
  readonly graph: MemoryGraph;
  readonly clock?: Clock;
}

export class SupersessionLedger {
  readonly #db: Database;
  readonly #graph: MemoryGraph;
  readonly #clock: Clock;

  constructor(options: SupersessionLedgerOptions) {
    this.#db = options.db;
    this.#graph = options.graph;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Record what is true now for a `(subject, relation)` key.
   *
   * Deterministic, in one sentence: **if the key already has an open row with a
   * different value, close it and open a new one.** No threshold, no model
   * call, no similarity anywhere.
   *
   * An identical value is idempotent and writes nothing — byte equality, not a
   * near-duplicate check. The two are not the same thing and the difference has
   * been measured: merging near-duplicates collapses accuracy from 0.82 to
   * 0.62.
   *
   * Closing the old row and opening the new one happen in ONE transaction. A
   * half-applied supersession leaves the key with no current value at all,
   * which is a fact silently forgotten — the failure constraints 4 and 6 both
   * exist to prevent.
   *
   * @throws {LedgerError} `bad_subject`, `blank_relation`, `blank_value`,
   * `bad_instant`, `unknown_node`.
   */
  assert(input: AssertInput): SupersessionResult {
    const subject = requireSubject(input.subject);
    const relation = requireText(input.relation, "blank_relation", "A relation");
    const value = requireText(input.value, "blank_value", "A value");
    const now = instant(this.#clock());
    const validFrom =
      input.validFrom === undefined
        ? now
        : requireInstant(input.validFrom, "A validity start");
    const valueNode = this.#requireNode(input.valueNode, "A value node");
    const assertedBy = this.#requireNode(input.assertedBy, "An asserting node");

    const open = this.current(subject, relation);

    // Byte equality. Deliberately not "close enough".
    if (open !== null && open.value === value && open.valueNode === valueNode) {
      return { current: open, superseded: null, unchanged: true };
    }

    const id = newMemoryAssertionId();
    let closed: Assertion | null = null;

    this.#transaction(() => {
      if (open !== null) {
        // A backdated correction can name a `validFrom` earlier than the row it
        // replaces. Clamping keeps the interval well-formed — the old row then
        // says "we now believe this was never true for any duration", which is
        // a coherent claim — rather than refusing to record the correction or
        // writing a backwards interval the CHECK would reject.
        const validTo = validFrom < open.validFrom ? open.validFrom : validFrom;
        this.#db
          .prepare(
            `UPDATE memory_assertions SET valid_to = ?, superseded_at = ?, superseded_by = ?, ` +
              `updated_at = ? WHERE id = ? AND superseded_at IS NULL`,
          )
          .run(validTo, now, id, now, open.id);
      }

      this.#db
        .prepare(
          `INSERT INTO memory_assertions (${COLUMNS}) ` +
            `VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(id, subject, relation, value, valueNode, validFrom, now, assertedBy, now, now);

      if (open !== null) {
        closed = this.#assertionOrThrow(open.id);
        this.#retireValueNode(closed);
      }
    });

    return { current: this.#assertionOrThrow(id), superseded: closed, unchanged: false };
  }

  /**
   * Close a key with no successor.
   *
   * "He stopped working there and nothing took its place" is a real thing to
   * learn. Forcing it to invent a replacement value would be a fabrication, so
   * `superseded_by` stays `null` while `superseded_at` is set — which the
   * migration's CHECKs allow in exactly that direction and no other.
   *
   * @throws {LedgerError} `bad_subject`, `blank_relation`, `no_such_assertion`.
   */
  retire(subject: string, relation: string, validTo?: string): Assertion {
    const open = this.current(subject, relation);
    if (open === null) {
      throw new LedgerError(
        "no_such_assertion",
        `Nothing is currently asserted for ${subject} —${relation}→, so there is nothing to ` +
          `retire. A key with no open row is not an error elsewhere; retiring one is.`,
      );
    }

    const now = instant(this.#clock());
    const ends = validTo === undefined ? now : requireInstant(validTo, "A validity end");
    const clamped = ends < open.validFrom ? open.validFrom : ends;

    this.#transaction(() => {
      this.#db
        .prepare(
          `UPDATE memory_assertions SET valid_to = ?, superseded_at = ?, updated_at = ? ` +
            `WHERE id = ? AND superseded_at IS NULL`,
        )
        .run(clamped, now, now, open.id);
      this.#retireValueNode(this.#assertionOrThrow(open.id));
    });

    return this.#assertionOrThrow(open.id);
  }

  /**
   * The value in force for a key, or `null`.
   *
   * A point lookup on the UNIQUE PARTIAL index, so its cost is the number of
   * live facts and not the number of rows. Ten years of history is free.
   *
   * @throws {LedgerError} `bad_subject`, `blank_relation`.
   */
  current(subject: string, relation: string): Assertion | null {
    const row = this.#db
      .prepare(CURRENT_ASSERTION_SQL)
      .get(requireSubject(subject), requireText(relation, "blank_relation", "A relation"));
    return row === undefined ? null : toAssertion(row as unknown as AssertionRow);
  }

  /** One assertion by id, or `null`. Spans closed rows: that is the history. */
  getAssertion(id: string): Assertion | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM memory_assertions WHERE id = ?`).get(id);
    return row === undefined ? null : toAssertion(row as unknown as AssertionRow);
  }

  /**
   * **"What did I believe in March?"** — transaction time.
   *
   * The row recorded by then and not yet superseded by then. Exactly one can
   * satisfy that per key, because the unique partial index means the belief
   * intervals never overlap. This is what makes the history retained rather
   * than merely stored: a closed row is still an answer to a question.
   *
   * @throws {LedgerError} `bad_subject`, `blank_relation`, `bad_instant`.
   */
  believedAt(subject: string, relation: string, at: string): Assertion | null {
    const when = requireInstant(at, "A belief instant");
    const row = this.#db
      .prepare(BELIEVED_AT_SQL)
      .get(
        requireSubject(subject),
        requireText(relation, "blank_relation", "A relation"),
        when,
        when,
      );
    return row === undefined ? null : toAssertion(row as unknown as AssertionRow);
  }

  /**
   * "What was actually the case then?" — valid time, by today's knowledge.
   *
   * The other clock, and a genuinely different question from
   * {@link SupersessionLedger.believedAt}: if he changed jobs in March and said
   * so in June, `believedAt(April)` is the old employer and `trueAt(April)` is
   * the new one. Answering only one of the two is how a bi-temporal store
   * quietly becomes a single-temporal one.
   *
   * @throws {LedgerError} `bad_subject`, `blank_relation`, `bad_instant`.
   */
  trueAt(subject: string, relation: string, at: string): Assertion | null {
    const when = requireInstant(at, "A validity instant");
    const row = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM memory_assertions ` +
          `WHERE subject = ? AND relation = ? AND valid_from <= ? ` +
          `AND (valid_to IS NULL OR valid_to > ?) ` +
          `ORDER BY valid_from DESC, recorded_at DESC, id DESC LIMIT 1`,
      )
      .get(
        requireSubject(subject),
        requireText(relation, "blank_relation", "A relation"),
        when,
        when,
      );
    return row === undefined ? null : toAssertion(row as unknown as AssertionRow);
  }

  /**
   * Every row for a key, oldest first — the whole chain, open and closed.
   *
   * @throws {LedgerError} `bad_subject`, `blank_relation`.
   */
  history(subject: string, relation: string): Assertion[] {
    return this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM memory_assertions WHERE subject = ? AND relation = ? ` +
          `ORDER BY recorded_at, id`,
      )
      .all(requireSubject(subject), requireText(relation, "blank_relation", "A relation"))
      .map((row) => toAssertion(row as unknown as AssertionRow));
  }

  /**
   * Everything Syl believed about a subject at an instant — the whole March
   * picture rather than one relation of it.
   *
   * @throws {LedgerError} `bad_subject`, `bad_instant`.
   */
  beliefsAt(subject: string, at: string): Assertion[] {
    const when = requireInstant(at, "A belief instant");
    return this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM memory_assertions WHERE subject = ? AND recorded_at <= ? ` +
          `AND (superseded_at IS NULL OR superseded_at > ?) ORDER BY relation, id`,
      )
      .all(requireSubject(subject), when, when)
      .map((row) => toAssertion(row as unknown as AssertionRow));
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Move the node carrying a now-stale value out of the scan.
   *
   * A tier MOVE, never a delete or a rewrite: it leaves every ranked path and
   * stays reachable by id, which is exactly what keeps the history above
   * answerable. If a superseded node stayed in the scan, retrieval would serve
   * what he believed in March as though it were current — the failure the
   * ledger exists to prevent, arriving by a different door.
   *
   * Silent when there is no node, or when it has already left the hot tier:
   * both are ordinary, and neither is a reason to fail a supersession that has
   * otherwise succeeded.
   */
  #retireValueNode(closed: Assertion): void {
    if (closed.valueNode === null) return;
    const node = this.#graph.getNode(closed.valueNode);
    if (node === null || node.tier !== "hot") return;
    this.#graph.supersedeNode(node);
  }

  #requireNode(id: string | undefined, what: string): string | null {
    if (id === undefined) return null;
    if (this.#graph.getNode(id) === null) {
      throw new LedgerError(
        "unknown_node",
        `${what} must be a node in the memory graph; ${id} is not.`,
      );
    }
    return id;
  }

  #assertionOrThrow(id: string): Assertion {
    const assertion = this.getAssertion(id);
    if (assertion === null) {
      throw new LedgerError("corrupt_row", `Assertion ${id} vanished during write.`);
    }
    return assertion;
  }

  /**
   * Run several statements as one.
   *
   * `BEGIN IMMEDIATE` rather than a deferred begin: the writes are known up
   * front, so taking the write lock at the start turns a lock upgrade failure
   * into a wait, which the busy timeout already handles.
   */
  #transaction(work: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.#db.exec("COMMIT");
    } catch (cause) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // The transaction was already gone. The original failure is the one
        // worth reporting, and swallowing this keeps it visible.
      }
      throw cause;
    }
  }
}
