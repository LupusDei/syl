import { isIanaTimeZone } from "../config.js";
import { nextDailyOccurrence } from "../harness/schedule.js";
import { instant, type Clock } from "../services/clock.js";
import {
  RruleUnsupportedError,
  localPartsOf,
  nextOccurrence,
  occurrenceOnDate,
  parseRrule,
  type ParsedRrule,
} from "../services/recurrence.js";

/**
 * Human time in, stored time out — or a question.
 *
 * `CreateReminderInput` wants `{ wallTime, tz, date | rrule }`. Everything
 * between a sentence the Commander said and those four fields happens here, and
 * this module is the only place allowed to decide that the translation
 * succeeded.
 *
 * **It does not parse English, and that is the central decision.**
 *
 * The model that calls the reminder tool has already read the sentence, in
 * context, with the conversation around it. It is far better at "the Tuesday
 * after next" than any grammar we could write, and a second-guessing parser
 * would only be a worse reader of the same words. So the tool schema asks it
 * for *structure* — `{ kind: "relative", minutes: 5 }` — and this module's job
 * is to VALIDATE and NORMALISE that structure, then resolve it against a clock
 * and an IANA zone. What the model is bad at is exactly what is left here:
 * knowing the current instant, doing zone arithmetic that survives a
 * daylight-saving boundary, and declining to answer.
 *
 * There is one exception, and it is a veto rather than a parser. A model asked
 * for structure will *always* produce structure — ask it to interpret "remind
 * me later" and it will hand back a confident thirty minutes. So `said`, the
 * Commander's own words, is screened against a small closed list of phrases
 * that carry no time at all. The screen can only ever turn an answer into a
 * question, never the reverse, so a false positive costs one sentence and a
 * false negative costs nothing the structural checks were not already doing.
 * That asymmetry is the whole reason a word list is acceptable here and would
 * be unacceptable as a parser.
 *
 * **There is exactly one way out of this module that is not a question.** A
 * wrong guess is worse than asking, because the Commander does not discover it
 * when he answers — he discovers it at the moment the reminder does not
 * arrive. That is constraint 4 (never silently drop a reminder) arriving
 * through a different door.
 *
 * Pure and clock-injected: nothing here reads `Date.now()`, and the only
 * `throw` is for a caller bug (see `assertZone`).
 */

/** What the model is asked to produce, before validation. */
export type PartOfDay = "morning" | "afternoon" | "evening" | "night";

/**
 * The conventions, stated once rather than scattered as magic hours.
 *
 * `morning` is 08:00 because that is `DEFAULT_QUIET_HOURS.end` — the first
 * moment the Commander has already declared himself reachable. Deriving it
 * from the quiet window rather than picking a pleasant-looking hour means a
 * "tomorrow morning" reminder is never created only to be deferred on arrival,
 * and it moves with the setting instead of drifting away from it.
 *
 * The other three are ordinary conventions and nothing more: just past midday,
 * the end of the working day, and an hour before quiet hours begin so an
 * evening reminder is not immediately pushed to the next morning.
 *
 * A convention is not a guess **provided it is said out loud**, which is why
 * every resolution that applies one carries an `assumption` the caller is
 * expected to repeat back.
 */
export const PART_OF_DAY: Readonly<Record<PartOfDay, string>> = {
  morning: "08:00",
  afternoon: "13:00",
  evening: "18:00",
  night: "21:00",
};

/**
 * The furthest ahead a relative count will be honoured, in minutes.
 *
 * A year. Past that, "in N minutes" is almost always a unit slip — hours or
 * days multiplied once too often — and a reminder a decade out is indis-
 * tinguishable from a bug until the decade passes.
 */
export const MAX_RELATIVE_MINUTES = 366 * 24 * 60;

/**
 * The furthest ahead a one-shot will be scheduled, in days. Five years.
 *
 * Deliberately generous, because a genuine "renew the passport in 2031" is a
 * real thing to want, and deliberately finite, because a mistyped year is not.
 */
export const MAX_HORIZON_DAYS = 1826;

/** The model's interpretation, once validated. */
export type TimeSpec =
  | { readonly kind: "relative"; readonly minutes: number }
  | { readonly kind: "time_of_day"; readonly wallTime: string }
  | { readonly kind: "date_time"; readonly date: string; readonly wallTime: string }
  | { readonly kind: "part_of_day"; readonly day: "today" | "tomorrow"; readonly part: PartOfDay }
  | { readonly kind: "recurring"; readonly rrule: string; readonly wallTime: string };

/** What `resolveTime` is given. */
export interface TimeRequest {
  /**
   * The Commander's own words for *when* — "in five minutes", "tomorrow
   * morning". The time phrase, not the whole request. The vagueness veto runs
   * on this and on nothing else.
   */
  readonly said: string;
  /**
   * The model's structured interpretation. Typed `unknown` on purpose: this is
   * model output, and validating it is the job. Nothing here trusts its shape.
   */
  readonly spec: unknown;
  /** Injected. This module never reads the wall clock itself. */
  readonly clock: Clock;
  /** The Commander's configured zone. IANA, always (constraint 5). */
  readonly tz: string;
}

/** Why the module is asking instead of answering. */
export type AmbiguityReason =
  /** The words carry no resolvable time at all — "later", "soon". */
  | "vague"
  /** No interpretation was offered, or nothing was said about time. */
  | "missing"
  /** The interpretation is not a well-formed `TimeSpec`. */
  | "malformed"
  /** A date or a recurrence arrived without an hour. */
  | "missing_time_of_day"
  /** It resolves to an instant that has already gone. */
  | "past"
  /** Further ahead than this module is willing to schedule. */
  | "out_of_range"
  /** An RRULE outside the supported subset, or one that can never occur. */
  | "unsupported_recurrence"
  /** A one-shot inside a daylight-saving gap: that local time does not exist. */
  | "nonexistent_local_time"
  /** Inside a daylight-saving overlap: that local time happens twice. */
  | "ambiguous_local_time";

/** Human time, resolved. The only outcome that is not a question. */
export interface ResolvedTime {
  readonly outcome: "resolved";
  /** 24-hour `HH:MM`, in `tz`. */
  readonly wallTime: string;
  /** The IANA zone it is anchored to. Never an offset. */
  readonly tz: string;
  /** `YYYY-MM-DD` local date for a one-shot; `null` for a recurrence. */
  readonly date: string | null;
  /** The rule for a recurrence; `null` for a one-shot. */
  readonly rrule: string | null;
  /**
   * The instant it will first fire, as an `Instant`.
   *
   * Computed through the same primitives the store uses, so a resolution that
   * comes back `resolved` is one that provably schedules. It is here to be
   * echoed and asserted on, not to be stored — the store keeps wall time and a
   * zone, because an instant is the thing that drifts.
   */
  readonly fireAt: string;
  /** What Syl should say she is doing: "Sunday, August 9 at 7:00 AM". */
  readonly spoken: string;
  /**
   * Non-null when a CONVENTION supplied something the Commander did not say —
   * the hour behind "tomorrow morning", or the day behind an hour that has
   * already gone. **The caller must say this out loud.** A convention he cannot
   * hear is a guess wearing better clothes.
   */
  readonly assumption: string | null;
}

/** Human time that could not be resolved, and the question to ask instead. */
export interface AmbiguousTime {
  readonly outcome: "ambiguous";
  readonly reason: AmbiguityReason;
  /** Written to be said to the Commander verbatim. Always ends in a question. */
  readonly question: string;
}

export type TimeResolution = ResolvedTime | AmbiguousTime;

/**
 * Phrases that name no time.
 *
 * Matched anywhere in the phrase, on word boundaries, because "later today"
 * narrows the day and still leaves the hour unknown — and asking "when later
 * today?" is the right answer. `\b` is what keeps "afternoon" out of "soon".
 *
 * Kept deliberately short. Every entry has to be a phrase that CANNOT be
 * resolved to an hour, not merely one that is often used loosely: "in a
 * minute" is left out because its literal reading is defensible, and a veto
 * list that starts absorbing judgement calls becomes the parser this module
 * exists to avoid.
 */
const VAGUE = new RegExp(
  [
    "\\blater\\b",
    "\\bsoon\\b",
    "\\bsometimes?\\b",
    "\\bsome\\s+time\\b",
    "\\bwhenever\\b",
    "\\beventually\\b",
    "\\bshortly\\b",
    "\\bin\\s+a\\s+(bit|while|moment|sec|secs|second|seconds)\\b",
    "\\bat\\s+some\\s+point\\b",
    "\\bone\\s+of\\s+these\\s+days\\b",
    "\\bdown\\s+the\\s+road\\b",
    "\\bin\\s+the\\s+future\\b",
    "\\bbefore\\s+long\\b",
    "\\basap\\b",
  ].join("|"),
  "i",
);

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * Whether a phrase names no time at all.
 *
 * Exported so the tool layer can describe the boundary to the model — "if he
 * said one of these, ask; do not interpret" — and so the list is testable
 * without going through a whole resolution.
 */
export function isVagueTimePhrase(said: string): boolean {
  return VAGUE.test(said);
}

/**
 * Resolve human time to stored time, or to a question.
 *
 * @throws {RangeError} if `tz` is not an IANA zone. That is the only throw in
 * this module, and it is deliberate: a bad zone comes from our own
 * configuration, not from the Commander, so turning it into a question would
 * ask him to explain our misconfiguration and hide it behind a conversation.
 * Constraint 5 fails loudly or it is not a constraint.
 */
export function resolveTime(request: TimeRequest): TimeResolution {
  assertZone(request.tz);

  const tz = request.tz;
  const now = request.clock();
  const said = request.said.trim();

  if (said === "") return ask("missing", "When would you like me to remind you?");
  if (isVagueTimePhrase(said)) {
    return ask(
      "vague",
      `"${said}" could be five minutes from now or five days — when exactly should I remind you?`,
    );
  }

  const spec = request.spec;
  if (spec === null || spec === undefined) {
    return ask("missing", "When would you like me to remind you?");
  }
  if (typeof spec !== "object" || Array.isArray(spec)) {
    return ask("malformed", "I did not follow the timing — when would you like me to remind you?");
  }

  const fields = spec as Record<string, unknown>;
  switch (fields["kind"]) {
    case "relative":
      return resolveRelative(fields, now, tz);
    case "time_of_day":
      return resolveTimeOfDay(fields, now, tz);
    case "date_time":
      return resolveDateTime(fields, now, tz);
    case "part_of_day":
      return resolvePartOfDay(fields, now, tz);
    case "recurring":
      return resolveRecurring(fields, now, tz);
    default:
      return ask(
        "malformed",
        "I did not follow the timing — when would you like me to remind you?",
      );
  }
}

/**
 * The four fields `CreateReminderInput` actually wants.
 *
 * A one-shot carries a date and no rule; a recurrence carries a rule and no
 * date. The store refuses both together, and this is the seam that makes that
 * impossible to get wrong from a resolution.
 */
export function reminderInputFrom(resolved: ResolvedTime): {
  readonly wallTime: string;
  readonly tz: string;
  readonly date: string | null;
  readonly rrule: string | null;
} {
  return {
    wallTime: resolved.wallTime,
    tz: resolved.tz,
    date: resolved.date,
    rrule: resolved.rrule,
  };
}

// ---------------------------------------------------------------------------
// The five kinds
// ---------------------------------------------------------------------------

function resolveRelative(
  fields: Record<string, unknown>,
  now: number,
  tz: string,
): TimeResolution {
  const minutes = readCount(fields["minutes"]);
  if (minutes === null) {
    return ask("malformed", "How long from now would you like me to remind you?");
  }
  if (minutes < 1) {
    return ask("past", "That is not a moment in the future — when should I remind you?");
  }
  if (minutes > MAX_RELATIVE_MINUTES) {
    return ask(
      "out_of_range",
      "That is more than a year out, and I would rather not count it in minutes — what date should I use?",
    );
  }

  // Truncated to the minute, because a wall time has no seconds. Truncation
  // only ever moves the instant EARLIER by under a minute, and the count is at
  // least one minute, so the result is still strictly in the future.
  const target = Math.floor((now + minutes * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
  const at = new Date(target);
  const date = zoned(at, tz).date;
  const wallTime = zoned(at, tz).wallTime;

  let fireAt: Date;
  try {
    fireAt = occurrenceOnDate(date, wallTime, tz);
  } catch {
    /* c8 ignore next -- a real instant always has a resolvable local reading */
    return ask("malformed", "I could not place that on the clock — when should I remind you?");
  }

  if (fireAt.getTime() !== target) {
    // The only way here is a daylight-saving overlap: the local clock reads
    // this time twice tonight and a stored wall time cannot say which one is
    // meant. Resolving it anyway means the earlier instant, which is up to an
    // hour in the past, and a reminder that fires the moment it is created.
    // The alternative — silently pushing past the overlap — is an hour late
    // and just as unasked-for. One sentence is cheaper than either.
    return ask(
      "ambiguous_local_time",
      `The clocks go back tonight, so ${wallTime} happens twice — do you mean the first or the second?`,
    );
  }

  return resolved({
    wallTime,
    tz,
    date,
    rrule: null,
    fireAt,
    assumption: null,
  });
}

function resolveTimeOfDay(
  fields: Record<string, unknown>,
  now: number,
  tz: string,
): TimeResolution {
  const wallTime = readWallTime(fields["wallTime"]);
  if (wallTime === null) return badWallTime(fields["wallTime"]);

  // Strictly after `now`, always — the same rule the scheduler uses, so a
  // reminder can never be created onto an instant that has already gone.
  const fireAt = nextDailyOccurrence(wallTime, new Date(now), tz);
  const local = zoned(fireAt, tz);

  if (local.wallTime !== wallTime) return nonexistent(wallTime, local.date, tz);

  const rolled = local.date !== zoned(new Date(now), tz).date;
  const spoken = spokenOneShot(fireAt, tz, wallTime);

  return resolved({
    wallTime,
    tz,
    date: local.date,
    rrule: null,
    fireAt,
    assumption: rolled
      ? `${clockLabel(wallTime)} has already gone today, so I have taken that as tomorrow — ${spoken}.`
      : null,
  });
}

function resolveDateTime(
  fields: Record<string, unknown>,
  now: number,
  tz: string,
): TimeResolution {
  const date = readDate(fields["date"]);
  if (date === null) {
    return ask("malformed", "Which date did you mean?");
  }
  if (fields["wallTime"] === undefined || fields["wallTime"] === null) {
    return ask("missing_time_of_day", "What time of day on that date?");
  }
  const wallTime = readWallTime(fields["wallTime"]);
  if (wallTime === null) return badWallTime(fields["wallTime"]);

  return finishOneShot(date, wallTime, tz, now, null);
}

function resolvePartOfDay(
  fields: Record<string, unknown>,
  now: number,
  tz: string,
): TimeResolution {
  const day = fields["day"];
  if (day !== "today" && day !== "tomorrow") {
    return ask("malformed", "Which day did you mean?");
  }

  const part = fields["part"];
  if (typeof part !== "string" || !(part in PART_OF_DAY)) {
    return ask("malformed", "What time of day did you mean?");
  }
  const wallTime = PART_OF_DAY[part as PartOfDay];

  const today = zoned(new Date(now), tz).date;
  const date = day === "today" ? today : addLocalDays(today, 1);

  return finishOneShot(
    date,
    wallTime,
    tz,
    now,
    `I have taken "${part}" to mean ${clockLabel(wallTime)}.`,
  );
}

function resolveRecurring(
  fields: Record<string, unknown>,
  now: number,
  tz: string,
): TimeResolution {
  const raw = fields["rrule"];
  if (typeof raw !== "string" || raw.trim() === "") {
    return ask("malformed", "How often should that repeat?");
  }
  if (fields["wallTime"] === undefined || fields["wallTime"] === null) {
    // "every Tuesday" names a day and no hour. Picking one would be a guess he
    // only discovers on the Tuesday nothing arrives.
    return ask("missing_time_of_day", "What time of day should that repeat at?");
  }
  const wallTime = readWallTime(fields["wallTime"]);
  if (wallTime === null) return badWallTime(fields["wallTime"]);

  let rule: ParsedRrule;
  let fireAt: Date;
  try {
    rule = parseRrule(raw);
    // The first occurrence is computed here so a rule that parses but can
    // never fire is refused now rather than stored as a reminder that waits
    // forever.
    fireAt = nextOccurrence(rule, wallTime, new Date(now), tz);
  } catch (error) {
    if (error instanceof RruleUnsupportedError) {
      return ask(
        "unsupported_recurrence",
        `I cannot schedule that repeat — ${lowerFirst(error.message)} Could you put it another way, like "every Tuesday" or "the 1st of each month"?`,
      );
    }
    /* c8 ignore next 2 -- parseRrule and nextOccurrence throw nothing else */
    throw error;
  }

  // No existence check for a recurrence: a rule spans many days, and the one
  // day a year its wall time falls in a daylight-saving gap is the scheduler's
  // problem, which already has a documented policy (fire late, never skip).
  return resolved({
    wallTime,
    tz,
    date: null,
    rrule: raw,
    fireAt,
    spoken: `${describeRrule(rule)} at ${clockLabel(wallTime)}`,
    assumption: null,
  });
}

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

/**
 * The checks every one-shot has to survive: the local time must exist, it must
 * be in the future, and it must be inside the horizon.
 */
function finishOneShot(
  date: string,
  wallTime: string,
  tz: string,
  now: number,
  assumption: string | null,
): TimeResolution {
  let fireAt: Date;
  try {
    fireAt = occurrenceOnDate(date, wallTime, tz);
  } catch {
    return nonexistent(wallTime, date, tz);
  }

  if (zoned(fireAt, tz).wallTime !== wallTime) return nonexistent(wallTime, date, tz);

  if (fireAt.getTime() <= now) {
    return ask(
      "past",
      `${clockLabel(wallTime)} on ${date} has already gone — when would you like me to remind you instead?`,
    );
  }
  if (fireAt.getTime() - now > MAX_HORIZON_DAYS * DAY_MS) {
    return ask(
      "out_of_range",
      "That is further out than I will hold a reminder for — did you mean a nearer date?",
    );
  }

  return resolved({ wallTime, tz, date, rrule: null, fireAt, assumption });
}

function nonexistent(wallTime: string, date: string, tz: string): AmbiguousTime {
  return ask(
    "nonexistent_local_time",
    `The clocks go forward that night, so ${wallTime} never happens on ${date} in ${tz} — shall I use a different time?`,
  );
}

function badWallTime(raw: unknown): AmbiguousTime {
  const shown = typeof raw === "string" ? `"${raw}"` : "that";
  return ask("malformed", `I could not read ${shown} as a time of day — what time did you mean?`);
}

// ---------------------------------------------------------------------------
// Validation and normalisation of model output
// ---------------------------------------------------------------------------

/**
 * A count of minutes.
 *
 * A numeric string is accepted because models emit them, and `"5"` has exactly
 * one reading. Rounding to the nearest minute is normalisation, not
 * interpretation: a wall time has no finer resolution to store.
 */
function readCount(raw: unknown): number | null {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
}

/** `YYYY-MM-DD`, and a date that actually exists. */
function readDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const round = new Date(Date.UTC(year, month - 1, day));
  if (
    round.getUTCFullYear() !== year ||
    round.getUTCMonth() !== month - 1 ||
    round.getUTCDate() !== day
  ) {
    return null;
  }
  return raw;
}

/**
 * A time of day, normalised to the 24-hour `HH:MM` the store keeps.
 *
 * The accepted forms are the ones with exactly one reading: `HH:MM`, an hour
 * with a meridiem, and the two named hours. A bare `"7"` is rejected on
 * purpose — it is 07:00 or 19:00 and there is no way to tell, which is the
 * module's whole subject.
 */
function readWallTime(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();

  if (text === "noon" || text === "midday") return "12:00";
  if (text === "midnight") return "00:00";

  const meridiem = /^(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)$/.exec(text);
  if (meridiem !== null) {
    const hour12 = Number(meridiem[1]);
    if (hour12 < 1 || hour12 > 12) return null;
    // 12am is midnight and 12pm is noon: the one pair that catches everybody.
    const hour = (hour12 % 12) + ((meridiem[3] ?? "").startsWith("p") ? 12 : 0);
    return `${pad(hour)}:${meridiem[2] ?? "00"}`;
  }

  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(text);
  if (clock === null) return null;
  const hour = Number(clock[1]);
  if (hour > 23) return null;
  return `${pad(hour)}:${clock[2] ?? "00"}`;
}

/**
 * @throws {RangeError} unless `tz` names a place.
 *
 * The same two-part rule `loadConfig` and `ReminderService` apply, borrowed
 * rather than re-implemented: a zone the three of them disagreed about would be
 * valid in one half of the service and invalid in the other, which is the
 * defect `syl-085` recorded.
 */
function assertZone(tz: string): void {
  if (!isIanaTimeZone(tz)) {
    throw new RangeError(
      `"${tz}" is not an IANA timezone. Resolve against a place (America/Chicago), never an offset — an offset is a property of an instant and drifts an hour at the next daylight-saving boundary.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Zone arithmetic and wording
// ---------------------------------------------------------------------------

interface ZonedReading {
  /** `YYYY-MM-DD` local date. */
  readonly date: string;
  /** 24-hour `HH:MM` local time. */
  readonly wallTime: string;
}

/**
 * An instant's local date and wall time in a zone.
 *
 * `hourCycle: "h23"` rather than `hour12: false`, because the latter renders
 * midnight as "24" in some locales and every comparison in this file is a
 * string comparison against `HH:MM`.
 */
function zoned(at: Date, tz: string): ZonedReading {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);

  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";

  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    wallTime: `${read("hour")}:${read("minute")}`,
  };
}

/** Calendar arithmetic on a local date string. No zone involved, so no DST. */
function addLocalDays(date: string, days: number): string {
  const shifted = new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `"07:00"` -> `"7:00 AM"`. The form he reads it back in. */
function clockLabel(wallTime: string): string {
  const [rawHour = "0", minute = "00"] = wallTime.split(":");
  const hour = Number(rawHour);
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 === 0 ? 12 : hour % 12}:${minute} ${suffix}`;
}

/** `"Sunday, August 9 at 7:00 AM"`. */
function spokenOneShot(fireAt: Date, tz: string, wallTime: string): string {
  const local = localPartsOf(fireAt, tz);
  const weekday = WEEKDAY_NAMES[local.weekday] ?? "";
  const month = MONTH_NAMES[local.month - 1] ?? "";
  return `${weekday}, ${month} ${local.day} at ${clockLabel(wallTime)}`;
}

function ordinal(day: number): string {
  const suffix =
    day % 100 >= 11 && day % 100 <= 13
      ? "th"
      : day % 10 === 1
        ? "st"
        : day % 10 === 2
          ? "nd"
          : day % 10 === 3
            ? "rd"
            : "th";
  return `${day}${suffix}`;
}

/** A rule in the words he would have used to ask for it. */
function describeRrule(rule: ParsedRrule): string {
  switch (rule.freq) {
    case "DAILY":
      return "every day";
    case "WEEKLY": {
      const days = rule.byDay.map((index) => WEEKDAY_NAMES[index] ?? "");
      return `every ${listOf(days)}`;
    }
    case "MONTHLY":
      return `on the ${ordinal(rule.byMonthDay ?? 1)} of every month`;
    case "YEARLY":
      return rule.byMonth !== null && rule.byMonthDay !== null
        ? `every year on ${MONTH_NAMES[rule.byMonth - 1] ?? ""} ${rule.byMonthDay}`
        : "every year";
  }
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

/** Fold an upstream sentence into the middle of one of ours. */
function lowerFirst(text: string): string {
  const first = text[0];
  return first === undefined ? text : first.toLowerCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

function ask(reason: AmbiguityReason, question: string): AmbiguousTime {
  return { outcome: "ambiguous", reason, question };
}

function resolved(parts: {
  readonly wallTime: string;
  readonly tz: string;
  readonly date: string | null;
  readonly rrule: string | null;
  readonly fireAt: Date;
  readonly spoken?: string;
  readonly assumption: string | null;
}): ResolvedTime {
  return {
    outcome: "resolved",
    wallTime: parts.wallTime,
    tz: parts.tz,
    date: parts.date,
    rrule: parts.rrule,
    fireAt: instant(parts.fireAt.getTime()),
    spoken: parts.spoken ?? spokenOneShot(parts.fireAt, parts.tz, parts.wallTime),
    assumption: parts.assumption,
  };
}
