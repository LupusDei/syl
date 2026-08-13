/**
 * Wall-clock scheduling, timezone-correct.
 *
 * This module exists because getting it wrong is the default. Adjutant's
 * scheduler collapses a cron expression to a fixed interval, so "07:00 daily"
 * becomes "every 24 hours from whenever you created it" — it drifts an hour at
 * every daylight-saving boundary and never actually lands on 07:00.
 *
 * Everything here is pure and works in instants (`Date`) plus an IANA zone.
 * A fixed UTC offset is never stored, because an offset is a property of an
 * instant, not of a place.
 */

/** A quiet window in local wall-clock time. May wrap past midnight. */
export interface QuietHours {
  /** Inclusive start, "HH:MM". */
  readonly start: string;
  /** Exclusive end, "HH:MM". */
  readonly end: string;
}

interface WallTime {
  readonly hour: number;
  readonly minute: number;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseWallTime(spec: string, label = "time"): WallTime {
  const match = TIME_PATTERN.exec(spec);
  if (!match) {
    throw new Error(`Invalid ${label} "${spec}": expected 24-hour HH:MM (e.g. "07:00")`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * A wall time moved by whole minutes, wrapping at midnight.
 *
 * For conventions that are defined *relative to* the quiet window — "an hour
 * before it begins" — so they are computed from it rather than written down
 * beside it. A second number with a comment saying it agrees with the first is
 * the arrangement that puts them an hour apart the moment either one moves.
 *
 * Wrapped rather than clamped: clamping collapses two different times onto
 * 00:00, which is the same silent divergence in a different shape.
 *
 * @throws {Error} if `spec` is not 24-hour `HH:MM`.
 */
export function shiftWallTime(spec: string, minutes: number): string {
  const time = parseWallTime(spec);
  const dayMinutes = 24 * 60;
  const shifted = (((time.hour * 60 + time.minute + minutes) % dayMinutes) + dayMinutes) %
    dayMinutes;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(Math.floor(shifted / 60))}:${pad(shifted % 60)}`;
}

/** Wall-clock fields for an instant, as seen in a given zone. */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function partsInZone(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = formatter.formatToParts(instant);
  const read = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? 0 : Number(value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // Some locales render midnight as "24"; normalise so arithmetic is sane.
    hour: read("hour") % 24,
    minute: read("minute"),
  };
}

/** Offset (ms) that the zone is ahead of UTC at this instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  // Second-level truncation is fine: no zone offset has sub-minute precision.
  return asIfUtc - Math.floor(instant.getTime() / 60000) * 60000;
}

/**
 * Convert local wall-clock fields in a zone to a UTC instant.
 *
 * Two passes: the offset depends on the instant we are solving for, so we guess
 * with the offset at the naive timestamp and then correct using the offset at
 * the guess. That converges everywhere except inside a DST gap, which the
 * caller detects by round-tripping.
 */
function wallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  return new Date(naive - zoneOffsetMs(firstGuess, timeZone));
}

/** True when the instant reads back as exactly the requested wall time. */
function roundTripsTo(instant: Date, hour: number, minute: number, timeZone: string): boolean {
  const p = partsInZone(instant, timeZone);
  return p.hour === hour && p.minute === minute;
}

function addLocalDays(parts: ZonedParts, days: number): ZonedParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

/**
 * Resolve a local wall time on a specific local date to a UTC instant,
 * handling both daylight-saving edge cases.
 *
 * DST gap (spring forward): the requested time does not exist. We return the
 * first instant that does exist after it, rather than skipping the day — losing
 * a reminder is worse than firing it an hour late.
 *
 * DST overlap (fall back): the requested time happens twice. We return the
 * earlier instant so the reminder fires once.
 */
function resolveLocalDateTime(
  date: ZonedParts,
  time: WallTime,
  timeZone: string,
): Date {
  const candidate = wallTimeToInstant(
    date.year,
    date.month,
    date.day,
    time.hour,
    time.minute,
    timeZone,
  );

  if (roundTripsTo(candidate, time.hour, time.minute, timeZone)) {
    // Ambiguous times resolve to two instants an hour apart; probe the earlier
    // one and prefer it when it also reads back correctly.
    const earlier = new Date(candidate.getTime() - 3_600_000);
    if (roundTripsTo(earlier, time.hour, time.minute, timeZone)) return earlier;
    return candidate;
  }

  // Inside a gap. Walk forward a minute at a time to the first existing instant.
  // The largest real-world gap is one hour, so this is bounded and cheap.
  let probe = candidate;
  for (let i = 0; i < 180; i += 1) {
    const p = partsInZone(probe, timeZone);
    const requested = time.hour * 60 + time.minute;
    const actual = p.hour * 60 + p.minute;
    if (actual >= requested && p.day === date.day) return probe;
    probe = new Date(probe.getTime() + 60_000);
  }
  return probe;
}

/**
 * The next instant at which the local wall clock in `timeZone` reads `spec`,
 * strictly after `from`.
 *
 * Strictly-after matters: an inclusive comparison re-fires a reminder that just
 * ran.
 */
export function nextDailyOccurrence(spec: string, from: Date, timeZone: string): Date {
  const time = parseWallTime(spec);
  const today = partsInZone(from, timeZone);

  const todaysOccurrence = resolveLocalDateTime(today, time, timeZone);
  if (todaysOccurrence.getTime() > from.getTime()) return todaysOccurrence;

  return resolveLocalDateTime(addLocalDays(today, 1), time, timeZone);
}

/**
 * The calendar date an instant falls on, in a zone, as `YYYY-MM-DD`.
 *
 * For anything counted "per day" — a ceiling on how often she reaches him, a
 * ledger that must not bank what yesterday did not spend. A day counted in UTC
 * turns over at 19:00 or 18:00 local, so his whole evening lands on tomorrow's
 * tally and a twice-a-day rate quietly becomes four.
 *
 * Zero-padded, so the strings compare and sort exactly as the dates do and no
 * caller ever has to parse one back.
 */
export function localDate(instant: Date, timeZone: string): string {
  const p = partsInZone(instant, timeZone);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(p.year).padStart(4, "0")}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * The instant as HE would read it: his weekday, his date, his 24-hour clock.
 *
 * For the prompts of unattended turns, which have to state the hour they are in
 * before they can reason about it. Lives here rather than beside any one job
 * because two of them now need it and a second copy of an `Intl` format is a
 * second place for the hour to be rendered differently.
 *
 * 24-hour and zone-aware on purpose: a turn handed "2:00" cannot tell morning
 * from afternoon, and a turn handed UTC converts it wrongly.
 */
export function wallClockIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
}

function minutesOfDay(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  return p.hour * 60 + p.minute;
}

/**
 * Whether an instant falls inside the quiet window, start-inclusive and
 * end-exclusive. Handles windows that wrap past midnight (the normal case).
 */
export function isWithinQuietHours(
  instant: Date,
  quiet: QuietHours,
  timeZone: string,
): boolean {
  const start = parseWallTime(quiet.start, "quiet-hours start");
  const end = parseWallTime(quiet.end, "quiet-hours end");
  const startMin = start.hour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;
  const now = minutesOfDay(instant, timeZone);

  return startMin <= endMin
    ? now >= startMin && now < endMin
    : now >= startMin || now < endMin; // wraps midnight
}

export interface DeferOptions {
  /** Deliver anyway, ignoring quiet hours. For genuinely urgent items only. */
  readonly urgent?: boolean;
}

/**
 * Move a firing time out of quiet hours, to the moment the window ends.
 *
 * Never returns null and never returns an earlier instant: a reminder that
 * arrives late is a nuisance, but one that vanishes silently is the failure
 * that makes an assistant untrustworthy.
 */
export function deferPastQuietHours(
  fireAt: Date,
  quiet: QuietHours,
  timeZone: string,
  options: DeferOptions = {},
): Date {
  if (options.urgent === true) return fireAt;
  if (!isWithinQuietHours(fireAt, quiet, timeZone)) return fireAt;

  const end = parseWallTime(quiet.end, "quiet-hours end");
  const local = partsInZone(fireAt, timeZone);
  const endMin = end.hour * 60 + end.minute;

  // Before the window's end on this local day (e.g. 03:00 with an 08:00 end):
  // release this morning. Otherwise we are in the late-evening arm of a
  // wrapping window, so release tomorrow morning.
  const releaseDate =
    minutesOfDay(fireAt, timeZone) < endMin ? local : addLocalDays(local, 1);

  return resolveLocalDateTime(releaseDate, end, timeZone);
}
