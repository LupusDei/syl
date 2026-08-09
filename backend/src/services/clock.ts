/**
 * Time, as one injectable value.
 *
 * Every service that schedules, expires, or stamps something takes a `Clock`
 * rather than calling `Date.now()` itself. That is not testing ceremony: the
 * behaviour Syl has to get right is almost entirely about *when*, and a test
 * that has to sleep to observe an expiry is a test nobody writes.
 *
 * Milliseconds since the epoch, not a `Date`. Arithmetic on a number cannot
 * accidentally mutate a shared object, and every comparison the schedulers do
 * is subtraction.
 *
 * The wire format is the contract's `Instant`: RFC 3339, UTC, millisecond
 * precision, literal `Z`. Never a fixed offset — an offset is a property of an
 * instant, not of a place, and one that reaches storage survives exactly one
 * DST boundary.
 */

/** Milliseconds since the Unix epoch. */
export type Clock = () => number;

/** The real clock. */
export const systemClock: Clock = () => Date.now();

/**
 * A clock frozen at one instant. For tests, and for a request handler that
 * wants every stamp it writes to agree.
 */
export function fixedClock(epochMs: number): Clock {
  return () => epochMs;
}

/**
 * Render an epoch-millisecond value as the contract's `Instant`.
 *
 * `toISOString` already produces exactly this shape, so there is no formatter
 * to get wrong — which is the point of using it rather than assembling one.
 *
 * @throws {RangeError} on a value outside the representable date range, rather
 * than silently producing `"Invalid Date"`.
 */
export function instant(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Parse an `Instant` back to epoch milliseconds, or `null` if it is not one.
 *
 * Deliberately strict. `Date.parse` accepts a startling range of things —
 * `"2026-08-09"`, `"Aug 9 2026"`, and, worst for us, values carrying a fixed
 * UTC offset. Accepting an offset here is how one reaches storage, so the
 * shape is checked before the value is.
 */
export function parseInstant(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Whether `expiresAt` (an `Instant`, or `null` for never) has passed. */
export function hasExpired(expiresAt: string | null, now: number): boolean {
  if (expiresAt === null) return false;
  const at = parseInstant(expiresAt);
  // An unparseable expiry is treated as already expired. The alternative is
  // treating corrupt data as "valid forever", which is the wrong way to fail
  // for anything that grants access.
  if (at === null) return true;
  return at <= now;
}
