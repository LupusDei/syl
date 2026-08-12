/**
 * Inspect the scheduler without waiting for a reminder to fire.
 *
 *   npm run when -- 07:00        (the boundary: arrives at 07:00, not deferred)
 *   npm run when -- 03:00        (lands in quiet hours, shows the deferral)
 *   npm run when -- 02:30        (does not exist on spring-forward night)
 *
 * The scheduler is pure, so this just asks it questions and prints the answers.
 */
import { loadQuietHours } from "../../config.js";
import { deferPastQuietHours, isWithinQuietHours, nextDailyOccurrence } from "../schedule.js";

function local(instant: Date, timeZone: string): string {
  return instant.toLocaleString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function relative(from: Date, to: Date): string {
  const minutes = Math.round((to.getTime() - from.getTime()) / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `in ${minutes}m`;
  return `in ${hours}h ${rest}m`;
}

function main(): void {
  // The window this environment would actually run on, not a copy of it. This
  // file used to hardcode 23:00-08:00 while the service ran 22:00-08:00, so the
  // tool built to answer "when would this arrive?" answered for a different
  // machine. Reading it the way the service does also means a malformed
  // SYL_QUIET_* is reported here, by name, rather than at the first deferral.
  const { quiet: QUIET, tz: TZ } = loadQuietHours(process.env);

  const spec = process.argv[2] ?? "07:00";
  const now = new Date();

  console.log(`\n  now        ${local(now, TZ)}`);
  console.log(`  quiet      ${QUIET.start}–${QUIET.end} ${TZ}\n`);

  const next = nextDailyOccurrence(spec, now, TZ);
  const quiet = isWithinQuietHours(next, QUIET, TZ);
  const delivered = deferPastQuietHours(next, QUIET, TZ);
  const urgent = deferPastQuietHours(next, QUIET, TZ, { urgent: true });

  console.log(`  "${spec}" daily`);
  console.log(`  next fire  ${local(next, TZ)}   (${next.toISOString()})  ${relative(now, next)}`);
  console.log(`  in quiet?  ${quiet ? "yes" : "no"}`);

  if (delivered.getTime() !== next.getTime()) {
    console.log(`  DEFERRED   ${local(delivered, TZ)}   (${delivered.toISOString()})`);
    console.log(`  urgent     ${local(urgent, TZ)}   — an urgent reminder still breaks through`);
  } else {
    console.log(`  delivered  ${local(delivered, TZ)}   — no deferral needed`);
  }

  // The property that Adjutant's scheduler gets wrong: a fixed interval drifts
  // an hour at each DST boundary, so "07:00 daily" stops meaning 07:00.
  const summer = nextDailyOccurrence(spec, new Date("2026-07-01T12:00:00Z"), TZ);
  const winter = nextDailyOccurrence(spec, new Date("2026-01-05T12:00:00Z"), TZ);
  console.log(`\n  DST check  summer ${summer.toISOString()}`);
  console.log(`             winter ${winter.toISOString()}`);
  console.log(`             same wall clock, different instants — no drift\n`);
}

try {
  main();
} catch (error: unknown) {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
