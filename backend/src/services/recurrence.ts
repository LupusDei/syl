import { nextDailyOccurrence } from "../harness/schedule.js";

/**
 * Recurrence, expressed as a filter over the daily scheduler.
 *
 * Everything here defers the hard part — "when does this wall time next happen
 * in this zone" — to `harness/schedule.ts`, which is already correct across
 * daylight-saving gaps and overlaps and already tested. A rule is a *filter*:
 * walk the daily occurrences and take the first one whose local date matches.
 * That is slower than closed-form arithmetic by a factor nobody will ever
 * measure, and it inherits the DST correctness instead of re-deriving it.
 *
 * The supported subset is deliberately small, and anything outside it is
 * refused at write time. A rule that parses but schedules wrongly is a
 * silently dropped reminder wearing a valid row, which is the exact failure
 * this project is built to prevent.
 */

/** Thrown for a rule outside the supported subset. */
export class RruleUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RruleUnsupportedError";
  }
}

/** The frequencies the contract permits. */
export type RruleFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** A parsed rule, reduced to the fields that matter. */
export interface ParsedRrule {
  readonly freq: RruleFreq;
  /** 0 = Sunday. Empty for anything but `WEEKLY`. */
  readonly byDay: readonly number[];
  /** 1..31, or `null`. */
  readonly byMonthDay: number | null;
  /** 1..12, or `null`. */
  readonly byMonth: number | null;
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/** How many daily occurrences to walk before giving up. */
const SEARCH_LIMIT = 800;

/**
 * Parse an RRULE, refusing anything outside the supported subset.
 *
 * @throws {RruleUnsupportedError} on an unknown frequency, an interval other
 * than 1, an unrecognised part, or a part that contradicts the frequency.
 */
export function parseRrule(text: string): ParsedRrule {
  const parts = new Map<string, string>();
  for (const chunk of text.trim().split(";")) {
    if (chunk === "") continue;
    const separator = chunk.indexOf("=");
    if (separator === -1) {
      throw new RruleUnsupportedError(`"${chunk}" is not a NAME=VALUE part of an RRULE.`);
    }
    parts.set(chunk.slice(0, separator).toUpperCase(), chunk.slice(separator + 1).toUpperCase());
  }

  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    throw new RruleUnsupportedError(
      `FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY. Anything else is rejected rather than half-supported.`,
    );
  }

  const interval = parts.get("INTERVAL");
  if (interval !== undefined && interval !== "1") {
    throw new RruleUnsupportedError(
      "INTERVAL is not supported. Every N weeks needs a drift-free anchor this subset does not carry.",
    );
  }

  const known = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST"]);
  for (const name of parts.keys()) {
    if (!known.has(name)) {
      throw new RruleUnsupportedError(`${name} is not part of the supported RRULE subset.`);
    }
  }

  const byDay: number[] = [];
  const rawByDay = parts.get("BYDAY");
  if (rawByDay !== undefined) {
    if (freq !== "WEEKLY") {
      throw new RruleUnsupportedError("BYDAY is supported only with FREQ=WEEKLY.");
    }
    for (const day of rawByDay.split(",")) {
      const index = WEEKDAYS[day];
      if (index === undefined) {
        throw new RruleUnsupportedError(`"${day}" is not a weekday. Use MO, TU, WE, TH, FR, SA, SU.`);
      }
      byDay.push(index);
    }
    if (byDay.length === 0) throw new RruleUnsupportedError("BYDAY must name at least one day.");
  }
  if (freq === "WEEKLY" && byDay.length === 0) {
    throw new RruleUnsupportedError("FREQ=WEEKLY needs a BYDAY: weekly-by-day is the supported form.");
  }

  const byMonthDay = numberPart(parts, "BYMONTHDAY", 1, 31);
  const byMonth = numberPart(parts, "BYMONTH", 1, 12);

  if (freq === "MONTHLY" && byMonthDay === null) {
    throw new RruleUnsupportedError(
      "FREQ=MONTHLY needs a BYMONTHDAY: monthly-by-date is the supported form.",
    );
  }
  if (freq === "DAILY" && (byMonthDay !== null || byMonth !== null)) {
    throw new RruleUnsupportedError("FREQ=DAILY takes no BY- parts.");
  }

  return { freq, byDay, byMonthDay, byMonth };
}

function numberPart(
  parts: ReadonlyMap<string, string>,
  name: string,
  min: number,
  max: number,
): number | null {
  const raw = parts.get(name);
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RruleUnsupportedError(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

/** The local calendar fields of an instant, in a zone. */
export interface LocalParts {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** 0 = Sunday. */
  readonly weekday: number;
}

/** Read an instant's local calendar fields. */
export function localPartsOf(at: Date, tz: string): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(at);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";

  const year = Number(read("year"));
  const month = Number(read("month"));
  const day = Number(read("day"));
  const date = `${read("year")}-${read("month")}-${read("day")}`;

  return {
    date,
    year,
    month,
    day,
    // The weekday of a calendar date is a property of the date, not of the
    // instant, so it is read off the local date rather than off `at`.
    weekday: new Date(`${date}T00:00:00Z`).getUTCDay(),
  };
}

/** Whether a local date satisfies a rule. */
function matches(rule: ParsedRrule, local: LocalParts): boolean {
  if (rule.byMonth !== null && local.month !== rule.byMonth) return false;
  if (rule.byMonthDay !== null && local.day !== rule.byMonthDay) return false;
  if (rule.byDay.length > 0 && !rule.byDay.includes(local.weekday)) return false;
  return true;
}

/**
 * The next instant at which `wallTime` occurs in `tz` and satisfies `rule`,
 * strictly after `from`.
 *
 * Strictly after, always: an inclusive comparison re-fires the occurrence that
 * just ran, and a recurring reminder that fires twice at the same instant is
 * the same class of trust failure as one that does not fire at all.
 *
 * @throws {RruleUnsupportedError} if no occurrence exists within a two-year
 * search — which for this subset means the rule cannot be satisfied at all
 * (BYMONTHDAY=31 with BYMONTH=2, for instance).
 */
export function nextOccurrence(
  rule: ParsedRrule | null,
  wallTime: string,
  from: Date,
  tz: string,
): Date {
  let candidate = nextDailyOccurrence(wallTime, from, tz);
  if (rule === null || rule.freq === "DAILY") return candidate;

  for (let i = 0; i < SEARCH_LIMIT; i += 1) {
    if (matches(rule, localPartsOf(candidate, tz))) return candidate;
    candidate = nextDailyOccurrence(wallTime, candidate, tz);
  }

  throw new RruleUnsupportedError(
    "That rule has no occurrence in the next two years, so it would schedule a reminder that never fires.",
  );
}

/**
 * The instant at which `wallTime` occurs on a specific local date.
 *
 * Used for a one-shot. The search starts before the earliest possible local
 * start of that date in any zone — UTC+14 — and walks forward, so the answer
 * comes out of the same DST-correct primitive as everything else rather than
 * from arithmetic that would have to rediscover it.
 *
 * @throws {RruleUnsupportedError} if the date is not a real one.
 */
export function occurrenceOnDate(date: string, wallTime: string, tz: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) throw new RruleUnsupportedError(`"${date}" is not a YYYY-MM-DD date.`);

  const [, year, month, day] = match;
  const utcMidnight = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (localPartsOf(new Date(utcMidnight), "UTC").date !== date) {
    throw new RruleUnsupportedError(`${date} is not a real date.`);
  }

  // 14 hours is the largest offset any zone is ahead of UTC, so this instant
  // is before local midnight of `date` everywhere on earth.
  let candidate = nextDailyOccurrence(wallTime, new Date(utcMidnight - 14 * 3_600_000 - 1), tz);
  for (let i = 0; i < 3; i += 1) {
    const local = localPartsOf(candidate, tz);
    if (local.date === date) return candidate;
    if (local.date > date) break;
    candidate = nextDailyOccurrence(wallTime, candidate, tz);
  }

  throw new RruleUnsupportedError(
    `${wallTime} does not occur on ${date} in ${tz}. A time inside a daylight-saving gap is the usual cause.`,
  );
}
