/**
 * Formatting for everything on the wire that is a moment or a span.
 *
 * Two rules, both taken from the contract rather than invented:
 *
 * 1. **Instants render as UTC, with the `Z`.** The wire is UTC always, and
 *    this surface exists to be compared against logs and against the wire. A
 *    local rendering is a second representation to reconcile at exactly the
 *    moment you are trying to work out whether something fired late.
 * 2. **Lateness is shown, never hidden.** "Every run records the gap between
 *    scheduled and actual. That gap is the whole point — a reminder that fired
 *    late is a nuisance, and one that pretended to be on time is a lie."
 *
 * Everything here is pure and takes `now` explicitly, so a relative time is
 * testable without freezing the clock.
 */

/** `2026-08-09T21:00:00.480Z` → `2026-08-09 21:00:00Z`. */
export function formatInstant(iso: string | null): string {
  if (iso === null) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/** The clock part only, for a column where the date is already established. */
export function formatTimeOfDay(iso: string | null): string {
  if (iso === null) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.toISOString().slice(11, 19)}Z`;
}

/**
 * A span, at the precision that is actually useful at that magnitude.
 * Sub-second work is measured in milliseconds; an overnight run is not.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const sign = ms < 0 ? "-" : "";
  const total = Math.abs(ms);

  if (total < 1_000) return `${sign}${Math.round(total)}ms`;
  if (total < 60_000) return `${sign}${(total / 1_000).toFixed(1)}s`;

  const seconds = Math.floor(total / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${sign}${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${sign}${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How far apart two instants are, or `null` when either is missing. */
export function elapsedMs(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

/** `-2000` → `2.0s ago`; `2000` → `in 2.0s`. */
export function formatRelative(iso: string | null, now: Date): string {
  if (iso === null) return "—";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;

  const delta = at - now.getTime();
  if (Math.abs(delta) < 1_000) return "now";
  return delta < 0 ? `${formatDuration(-delta)} ago` : `in ${formatDuration(delta)}`;
}

/**
 * The scheduled-to-actual gap. Zero and negative both read as on time — a run
 * cannot be early in any way worth a column — and anything else is signed so
 * it can never be mistaken for a duration.
 */
export function formatLateness(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "on time";
  return `+${formatDuration(ms)}`;
}

/** Whether a gap is worth drawing attention to. One minute is the threshold. */
export const LATE_THRESHOLD_MS = 60_000;

export function isNotablyLate(ms: number): boolean {
  return Number.isFinite(ms) && ms >= LATE_THRESHOLD_MS;
}
