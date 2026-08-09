/**
 * Formatting for the rest of the wire: ids, money, enum names.
 *
 * Ids are `syl:<type>:<uuidv7>`. They are long, they are the thing you copy
 * into a query, and they are the thing a column cannot afford to widen for —
 * so they render short and carry the whole value in a `title`.
 */

/** `syl:job:0198f2c4-0001-…e001` → `job:0198f2c4`. Never for copying. */
export function shortId(id: string): string {
  const parts = id.split(":");
  if (parts.length < 3) return id;
  const kind = parts[1] ?? "";
  const value = parts.slice(2).join(":");
  const head = value.split("-")[0] ?? value;
  return `${kind}:${head}`;
}

/** `morning_agenda` → `morning agenda`. The wire's enums are snake_case. */
export function humanise(value: string): string {
  return value.replace(/_/g, " ");
}

/**
 * Cost in USD at the precision the harness reports it. A run that used no
 * turns costs exactly nothing, and saying `$0.0000` about it hides the one
 * fact worth noticing — `maxTurns: 0` is the strongest statement in the job
 * catalogue.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  // A turn costs cents, so two places would round most of the catalogue to
  // the same number and make comparing runs impossible.
  if (Math.abs(usd) < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** A count with its noun, pluralised. `1 attempt`, `3 attempts`. */
export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** First line only, for a summary that has to sit in a table cell. */
export function firstLine(text: string | null, limit = 120): string {
  if (text === null) return "";
  const line = text.split("\n")[0] ?? "";
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}
