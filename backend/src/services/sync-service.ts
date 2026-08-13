import type { SyncChange, SyncResourceType, SyncResponse } from "@syl/shared";

import { instant, systemClock, type Clock } from "./clock.js";
import { PagingError, resolvePageLimit } from "./paging.js";
import type { Database } from "./sqlite.js";

/**
 * `GET /sync` — cursor catch-up for a device that has been away.
 *
 * ## What it is for, and therefore what it is not
 *
 * The phone's loop is **push outbox → pull since cursor → reconcile → ack**.
 * This is the pull. The push half is the ordinary write endpoints, each
 * carrying an `Idempotency-Key`.
 *
 * That split is what makes the semantics statable in one line: **this endpoint
 * accepts no client state, so it cannot have a conflict.** There is nothing to
 * merge. The server is the sole authority; the device's own writes went
 * through the write endpoints before the pull ran; the pull returns the
 * server's row, which replaces whatever the device was holding optimistically.
 * The device never wins, and the question "what happens when both sides
 * changed the same row" has the answer "the server's version, always" rather
 * than an answer that depends on timing.
 *
 * ## The four properties a client may rely on
 *
 * 1. **Monotonic position.** The cursor is an append-only sequence, not a
 *    timestamp. A timestamp cursor loses a row permanently if the wall clock
 *    ever steps backwards, and loses it *silently* — a row missing from a sync
 *    feed is indistinguishable from a row that was never written.
 * 2. **State, not history.** A log row records *that* something changed; the
 *    resource is read from its own table when the response is built. So a
 *    device that pages slowly sees fewer, fresher changes rather than a replay
 *    it would only overwrite, and the wire shape is produced by the same store
 *    code that serves the resource's own endpoint.
 * 3. **At-least-once.** Replaying a cursor re-delivers. Every change is an
 *    id-keyed `upsert` or `delete`, so a duplicate is a no-op on the device.
 *    Nothing here is exactly-once and no client should assume it.
 * 4. **`hasMore` means keep going.** A device back from a week away pages. A
 *    client that stops at the first page silently believes it is current.
 *
 * ## This is not the WebSocket `sync` frame
 *
 * That one recovers a gap on one socket by sequence number and does not
 * survive a reinstall. This one is durable and covers every resource type. The
 * parameter names differ (`since` against `sinceSeq`) so the two cannot be
 * conflated by accident.
 */

/**
 * Every type the feed can carry, in the contract's own order.
 *
 * Spelled as a `Record` over `SyncResourceType` and then flattened, rather than
 * written as an array, so **a type added to the contract and forgotten here is
 * a compile error**. As a plain `readonly SyncResourceType[]` it was not: the
 * array stayed assignable, `changes()` defaulted to a list missing the new
 * type, and `GET /sync` answered `200` with an empty page — a resource that
 * silently never reaches a device, which is the exact class of failure this
 * endpoint's whole design is built to rule out.
 *
 * Same trick `SyncResolvers` uses one screen down, and for the same reason.
 */
const EVERY_TYPE: Readonly<Record<SyncResourceType, true>> = {
  conversation: true,
  message: true,
  reminder: true,
  todo: true,
  goal: true,
  device: true,
  delivery: true,
  sending: true,
};

export const SYNC_RESOURCE_TYPES: readonly SyncResourceType[] = Object.keys(
  EVERY_TYPE,
) as readonly SyncResourceType[];

/**
 * How a resource is fetched, by type.
 *
 * Supplied by the caller rather than reached for here, because every one of
 * these is an existing store method that already produces the contract's wire
 * shape. A second mapping in this file would be a second place for the shape
 * to drift, which is the failure this whole endpoint exists downstream of.
 *
 * Returning `null` means the row is gone, and gone is what `op: "delete"`
 * spells.
 */
export type SyncResolvers = Readonly<
  Record<SyncResourceType, (id: string) => Record<string, unknown> | null>
>;

/** A row of the change log, before its resource has been fetched. */
interface SyncLogRow {
  readonly seq: number;
  readonly type: SyncResourceType;
  readonly id: string;
  readonly at: string;
}

/** What `GET /sync` may be asked for. */
export interface SyncQuery {
  /** An opaque cursor from a previous response. Absent means bootstrap. */
  readonly since?: string | null;
  readonly limit?: number;
  /** Restrict to these resource types. Absent means all of them. */
  readonly types?: readonly SyncResourceType[];
}

/**
 * Wrap a sequence as an opaque cursor.
 *
 * Base64 for one reason only: a cursor a client can read is a cursor a client
 * will construct, and the moment one does, the server's freedom to change how
 * it walks the log is gone. The field is spelled `seq` rather than `offset`
 * because it is not an offset — it never restarts and it survives deletions.
 */
export function encodeSyncCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ seq }), "utf8").toString("base64url");
}

/**
 * Read a cursor this service issued.
 *
 * @throws {PagingError} on anything else. Refusing matters more here than
 * anywhere else in the service: a bad cursor silently treated as "start from
 * the beginning" makes a device re-download its whole history on every
 * foreground, and a bad cursor treated as "start from now" makes it skip
 * everything it missed. Both are quiet, and one of them loses data.
 */
export function decodeSyncCursor(cursor: string): number {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new PagingError("bad_cursor", "That sync cursor is not one this service issued.");
  }
  if (typeof decoded !== "object" || decoded === null) {
    throw new PagingError("bad_cursor", "That sync cursor is not one this service issued.");
  }
  // Safe assertion: guarded above, and the field is type-tested.
  const seq = (decoded as Record<string, unknown>)["seq"];
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    throw new PagingError("bad_cursor", "That sync cursor is not one this service issued.");
  }
  return seq;
}

export interface SyncServiceOptions {
  readonly db: Database;
  readonly resolvers: SyncResolvers;
  readonly clock?: Clock;
}

export class SyncService {
  readonly #db: Database;
  readonly #resolvers: SyncResolvers;
  readonly #clock: Clock;

  constructor(options: SyncServiceOptions) {
    this.#db = options.db;
    this.#resolvers = options.resolvers;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Everything that changed after `since`, oldest first.
   *
   * @throws {PagingError} on an unreadable cursor or an out-of-range limit.
   */
  changes(query: SyncQuery = {}): SyncResponse {
    const limit = resolvePageLimit(query.limit);
    const since =
      query.since === undefined || query.since === null || query.since === ""
        ? 0
        : decodeSyncCursor(query.since);

    const types = query.types ?? SYNC_RESOURCE_TYPES;
    // An explicit empty `types` is a caller asking for nothing. Answering with
    // everything would be the opposite of what was asked, and answering with a
    // cursor that advanced past unseen rows would lose them.
    if (types.length === 0) {
      return {
        cursor: encodeSyncCursor(since),
        hasMore: false,
        changes: [],
        serverTime: instant(this.#clock()),
      };
    }

    const placeholders = types.map(() => "?").join(", ");
    // `limit + 1` is how `hasMore` is answered without a second COUNT — the
    // same trick every page in this service uses.
    const rows = this.#db
      .prepare(
        `SELECT seq, type, id, at FROM sync_log
          WHERE seq > ? AND type IN (${placeholders})
          ORDER BY seq
          LIMIT ?`,
      )
      .all(since, ...types, limit + 1);

    const log = rows.map((row) => row as unknown as SyncLogRow);
    const hasMore = log.length > limit;
    const page = log.slice(0, limit);

    const changes: SyncChange[] = page.map((row) => {
      const resource = this.#resolvers[row.type](row.id);
      return {
        type: row.type,
        op: resource === null ? "delete" : "upsert",
        id: row.id,
        at: row.at,
        resource,
      };
    });

    return {
      // The cursor advances only over rows this response actually carried. On
      // an empty page it stays exactly where it was, so a client polling a
      // quiet server neither loses its place nor skips forward past a row that
      // lands a millisecond later.
      cursor: encodeSyncCursor(page.at(-1)?.seq ?? since),
      hasMore,
      changes,
      serverTime: instant(this.#clock()),
    };
  }

  /** The newest sequence in the log, or 0 when it is empty. */
  head(): number {
    const row = this.#db.prepare("SELECT max(seq) AS head FROM sync_log").get();
    // Safe assertion: `max` over an INTEGER column is INTEGER or NULL.
    return (row as unknown as { head: number | null } | undefined)?.head ?? 0;
  }
}
