import { instant, systemClock, type Clock } from "../services/clock.js";
import type { Database } from "../services/sqlite.js";

/**
 * Which answers from the fleet Syl has already been shown.
 *
 * ## The property, stated once
 *
 * **One reply is delivered exactly once.** Adjutant's read side has no cursor —
 * `GET /api/messages?agentId=syl` returns everything addressed to her, on every
 * poll — so "which of these are new" is entirely ours to answer, and the poller
 * is the wrong place for it: a poller that keeps the answer in memory forgets
 * it on the first restart, and re-delivers everything the fleet has ever said.
 *
 * ## Why this is a ledger and not a cursor
 *
 * `syl-014.3.1` and the plan both say "cursor (last seen message id)", and the
 * obvious implementation — one mutable row per agent holding the newest instant
 * seen — is exactly-once only while messages arrive in time order. They do not
 * have to. Two agents write concurrently, one of them retries, and an answer
 * stamped 00:10 arrives after one stamped 00:30; a watermark swallows it
 * without a word. That is CLAUDE.md constraint 4 in different clothes — a
 * vanished answer is a vanished reminder — and it is worse here, because the
 * answer cost the Commander an agent's time to produce.
 *
 * So the unit of idempotence is the message id, and the per-agent cursor the
 * bead asks for is {@link RepliesSeen.lastFrom}, derived from an index. Reading
 * "the last thing the treasurer said" is then a query rather than the thing
 * that loses an answer.
 *
 * ## Record AFTER delivering, never before
 *
 * A crash between recording and delivering loses an answer for good; a crash
 * between delivering and recording delivers it twice. Constraint 4 decides
 * which of those is acceptable, and it is the second one. Callers therefore
 * enqueue the delivery first and {@link RepliesSeen.record} after.
 */

/** One answer as it arrived from Adjutant, before anything is decided about it. */
export interface InboundReply {
  /** Adjutant's id for the message. The unit of exactly-once. */
  readonly messageId: string;
  /** Which agent said it, as Adjutant knows them. */
  readonly from: string;
  /** When they said it. An `Instant`. */
  readonly at: string;
}

/** A recorded answer, with the one fact the message itself does not carry. */
export interface SeenReply extends InboundReply {
  /** When Syl's poller picked it up. */
  readonly seenAt: string;
}

export interface RepliesSeenOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

interface SeenRow {
  readonly message_id: string;
  readonly agent_id: string;
  readonly message_at: string;
  readonly seen_at: string;
}

const COLUMNS = "message_id, agent_id, message_at, seen_at";

/** A reply the store will not accept, because accepting it would lose it later. */
export class RepliesSeenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepliesSeenError";
  }
}

export class RepliesSeen {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: RepliesSeenOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * The ones out of a poll that have not been handled yet, in the order given.
   *
   * Order is preserved rather than sorted: the caller fences these and she
   * reads them in sequence, and re-ordering here would move a later answer
   * above an earlier one for no reason visible at the call site.
   */
  unseen<T extends InboundReply>(replies: readonly T[]): readonly T[] {
    if (replies.length === 0) return [];

    // One statement rather than one per reply: a poll returning fifty answers
    // must not be fifty round trips, and the `IN` list is bounded by the page
    // size Adjutant returns.
    const placeholders = replies.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(`SELECT message_id FROM agent_replies_seen WHERE message_id IN (${placeholders})`)
      .all(...replies.map((reply) => reply.messageId));

    const known = new Set(rows.map((row) => (row as unknown as SeenRow).message_id));

    return replies.filter((reply) => !known.has(reply.messageId));
  }

  /**
   * Record a batch as handled. Idempotent, and all-or-nothing.
   *
   * Idempotent because the honest ordering — deliver, then record — means a
   * crash re-runs this over answers already in the table, and a store that
   * threw there would wedge the poller permanently on the first duplicate.
   *
   * All-or-nothing because half a recorded batch is the worst of both: some
   * answers re-delivered and, once someone "fixes" it by recording optimisti-
   * cally, some never delivered at all.
   *
   * @returns how many rows were new, which is what a log line wants.
   * @throws {RepliesSeenError} on a reply that identifies neither itself nor
   * its author. Loudly, because such a row cannot be deduplicated later.
   */
  record(replies: readonly InboundReply[]): number {
    if (replies.length === 0) return 0;

    const seenAt = instant(this.#clock());
    const insert = this.#db.prepare(
      `INSERT INTO agent_replies_seen (${COLUMNS}) VALUES (?, ?, ?, ?) ` +
        `ON CONFLICT (message_id) DO NOTHING`,
    );

    let written = 0;
    this.#db.exec("BEGIN");
    try {
      for (const reply of replies) {
        if (reply.messageId.trim() === "" || reply.from.trim() === "" || reply.at.trim() === "") {
          throw new RepliesSeenError(
            `An inbound reply is missing its id, its author or its instant ` +
              `(id=${JSON.stringify(reply.messageId)}, from=${JSON.stringify(reply.from)}, ` +
              `at=${JSON.stringify(reply.at)}). It cannot be recorded as handled, so recording it ` +
              `would mean delivering it again on every poll from now on.`,
          );
        }

        written += insert.run(reply.messageId, reply.from, reply.at, seenAt).changes > 0 ? 1 : 0;
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }

    return written;
  }

  /**
   * The last answer this agent gave that Syl has been shown — the per-agent
   * cursor, derived rather than stored.
   *
   * Ties break on the id, because the instant alone does not order two answers
   * written in the same millisecond and "the most recent one" has to mean
   * something rather than depending on page order.
   */
  lastFrom(agentId: string): SeenReply | null {
    const row = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM agent_replies_seen WHERE agent_id = ? ` +
          `ORDER BY message_at DESC, message_id DESC LIMIT 1`,
      )
      .get(agentId);

    if (row === undefined) return null;

    const typed = row as unknown as SeenRow;
    return {
      messageId: typed.message_id,
      from: typed.agent_id,
      at: typed.message_at,
      seenAt: typed.seen_at,
    };
  }
}
