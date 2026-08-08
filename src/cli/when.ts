/**
 * Inspect the scheduler without waiting for a reminder to fire.
 *
 *   npm run when -- 07:00
 *   npm run when -- 03:00        (lands in quiet hours, shows the deferral)
 *   npm run when -- 02:30        (does not exist on spring-forward night)
 *
 * The scheduler is pure, so this just asks it questions and prints the answers.
 */
import {
  deferPastQuietHours,
  isWithinQuietHours,
  nextDailyOccurrence,
  type QuietHours,
} from "../schedule.js";

const TZ = "America/Chicago";
const QUIET: QuietHours = { start: "23:00", end: "08:00" };

function local(instant: Date): string {
  return instant.toLocaleString("en-US", {
    timeZone: TZ,
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
  const spec = process.argv[2] ?? "07:00";
  const now = new Date();

  console.log(`\n  now        ${local(now)}`);
  console.log(`  quiet      ${QUIET.start}–${QUIET.end} ${TZ}\n`);

  const next = nextDailyOccurrence(spec, now, TZ);
  const quiet = isWithinQuietHours(next, QUIET, TZ);
  const delivered = deferPastQuietHours(next, QUIET, TZ);
  const urgent = deferPastQuietHours(next, QUIET, TZ, { urgent: true });

  console.log(`  "${spec}" daily`);
  console.log(`  next fire  ${local(next)}   (${next.toISOString()})  ${relative(now, next)}`);
  console.log(`  in quiet?  ${quiet ? "yes" : "no"}`);

  if (delivered.getTime() !== next.getTime()) {
    console.log(`  DEFERRED   ${local(delivered)}   (${delivered.toISOString()})`);
    console.log(`  urgent     ${local(urgent)}   — an urgent reminder still breaks through`);
  } else {
    console.log(`  delivered  ${local(delivered)}   — no deferral needed`);
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
