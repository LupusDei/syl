/**
 * Cursor pagination, in one place.
 *
 * Every page in the contract is `{ items, nextCursor, hasMore }` and every
 * cursor is opaque. Opaque matters more than it looks: a cursor a client can
 * read is a cursor a client will construct, and the moment one does, the
 * server's freedom to change how it walks a table is gone.
 *
 * The conversation store predates this module and keeps its own sequence-based
 * cursor, because ordering history by `seq` is genuinely a different walk.
 * Everything added since — devices, deliveries, reminders, jobs, runs — orders
 * by a timestamp and pages by offset, and shares this.
 */

/** How many rows a page holds when the caller does not say. */
export const DEFAULT_PAGE_LIMIT = 50;

/** A page larger than this is a client mistake, not a request. */
export const MAX_PAGE_LIMIT = 200;

/** Thrown when a page cannot be walked as asked. */
export class PagingError extends Error {
  readonly kind: "bad_cursor" | "bad_limit";

  constructor(kind: PagingError["kind"], message: string) {
    super(message);
    this.name = "PagingError";
    this.kind = kind;
  }
}

/** What a caller may ask for. */
export interface PageOptions {
  readonly cursor?: string | null;
  readonly limit?: number;
}

/**
 * The contract's page shape.
 *
 * `items` is a mutable array rather than a `readonly` one purely so it is
 * assignable to the generated contract types, which spell array fields
 * `T[]`. The array is freshly sliced on every call, so nothing is shared and
 * nobody can mutate a page into disagreeing with the query that produced it.
 */
export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Encode a row offset as an opaque cursor. */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

/**
 * Decode a cursor this service issued.
 *
 * @throws {PagingError} if it is not one. Refusing is the only safe answer: a
 * cursor treated as "start from the beginning" makes a paginating client walk
 * the first page forever without ever reporting an error.
 */
export function decodeOffsetCursor(cursor: string): number {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new PagingError("bad_cursor", "That cursor is not one this service issued.");
  }

  if (typeof decoded !== "object" || decoded === null) {
    throw new PagingError("bad_cursor", "That cursor is not one this service issued.");
  }
  // Safe assertion: guarded above, and the field is type-tested.
  const offset = (decoded as Record<string, unknown>)["offset"];
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw new PagingError("bad_cursor", "That cursor is not one this service issued.");
  }
  return offset;
}

/**
 * Validate a requested page size.
 *
 * @throws {PagingError} on anything outside 1..{@link MAX_PAGE_LIMIT}.
 */
export function resolvePageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new PagingError(
      "bad_limit",
      `limit must be a whole number between 1 and ${MAX_PAGE_LIMIT}.`,
    );
  }
  return limit;
}

/**
 * Turn `limit + 1` rows into a page.
 *
 * The caller always reads one row more than it needs; that extra row is how
 * `hasMore` is answered without a second `COUNT` query, and it is why every
 * query in this codebase binds `limit + 1`.
 */
export function pageOf<T>(rows: readonly T[], limit: number, offset: number): Page<T> {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: hasMore ? encodeOffsetCursor(offset + items.length) : null,
    hasMore,
  };
}

/** Read `cursor` and `limit` off page options, validated together. */
export function resolvePage(options: PageOptions): { readonly limit: number; readonly offset: number } {
  return {
    limit: resolvePageLimit(options.limit),
    offset: options.cursor === undefined || options.cursor === null
      ? 0
      : decodeOffsetCursor(options.cursor),
  };
}
