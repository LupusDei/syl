import {
  HEALTH_TYPES,
  UNITS,
  silenceIsEvidence,
  type AuthorisationState,
  type HealthType,
} from "./contract.js";

/**
 * Derivations: what his own history says about the last few days of it.
 *
 * `syl-t9tj.4.1` (T014). The middle of the three layers — observations,
 * derivations, conclusions — and the only one that is **thrown away**.
 *
 *
 * ## Pure, and pure on purpose
 *
 * No database, no clock, no file system, no `Date.now()`. `now` is an argument.
 * The same seam discipline as `harness/protocol.ts`: the subtle bugs in this
 * layer are *arithmetic* bugs — a mean over the wrong window, a standard
 * deviation over one sample, a day bucketed into yesterday because the zone was
 * ignored — and provoking one of those should not need a schema, a migration
 * and an HTTP request. Every test in `tests/unit/health-derive.test.ts` is an
 * array of numbers in and an object out.
 *
 * It does not even import the store. {@link Measurement} is the three fields
 * this file needs, and `HealthSample` satisfies it structurally, so the seam
 * costs nothing and buys a module that cannot accidentally grow a query.
 *
 *
 * ## Nothing here is persisted, and that is the design rather than an omission
 *
 * `0019_working_memory.sql` makes the argument for the projection and it is the
 * same argument: a derivation that accumulates becomes the **cheapest authority
 * to read**, therefore the one everything reads, and it is the only part of the
 * system with no path back to what it was derived from. It drifts and nothing
 * errors. So a derivation lives for the length of one review turn and is
 * recomputed from `health_samples` the next night.
 *
 * The daily aggregate in `downsample.ts` is not an exception to this. A
 * downsample is an *observation at coarser resolution* — the same measurement,
 * fewer of them — and it lives in the observation store because that is what it
 * is. A baseline is an interpretation, and interpretations are not stored.
 *
 *
 * ## THERE IS NO RESTING HEART RATE, and that shaped this file
 *
 * Measured on his machine, 2026-08-13: 61,030 samples over two months.
 *
 *     steps 29,962 · heartRate 28,726 · sleep 2,336 · workout 6
 *     restingHeartRate 0 · heartRateVariability 0 · bodyMass 0
 *
 * `restingHeartRate` is the series nearly every interesting conclusion leans on
 * — "his resting heart rate has been up for nine days" is the spec's own
 * example — and **he has none of it**. A derivation layer that requires one
 * produces nothing, forever, and looks exactly like a bug: every test green,
 * every night successful, and Syl never has anything to say about his heart.
 *
 * So when `restingHeartRate` is absent and `heartRate` is not, this file
 * derives a resting figure from the raw series: the day's
 * {@link RESTING_PERCENTILE} percentile, which is the quiet floor of the day
 * and is what a wrist tracker is approximating anyway. It is marked
 * {@link SeriesDerivation.derivedFrom} and its evidence is `estimated`, and the
 * review prompt says so in words — she may say *"your heart's quiet floor, as I
 * estimate it from raw readings"* and may never say *"your resting heart rate,
 * measured"*. A number she computed and a number a device reported are
 * different claims and the difference travels with the number.
 *
 *
 * ## NO BAR AT THE DOOR
 *
 * The Commander's ruling, overruling an earlier threshold rule:
 *
 * > *"I can decide whether or not to act on it and tell her if I want her to
 * > stop drawing such conclusions, but I don't want [her coded] in such a way
 * > that is impossible for her to draw connections."*
 *
 * **Nothing in this file gates anything.** There is no minimum sample count, no
 * significance test, no floor a deviation must clear to be reported. Every
 * figure computed is handed to the review turn and she decides what is worth
 * keeping; confidence decay and his feedback prune afterwards, which is how
 * every other inference in Syl is judged.
 *
 * {@link Deviation.z} and {@link SeriesDerivation.run} are *descriptions*, not
 * gates. A z-score says how far from his own ordinary a week is, in units of
 * his own variability, and a run says how many days in a row it has been on one
 * side. Neither is ever compared against a constant here, and there is
 * deliberately no constant to compare them against.
 */

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * One measurement, reduced to what arithmetic needs.
 *
 * `HealthSample` is assignable to this, so callers pass the store's rows
 * straight through. Structural rather than an import, so this module has no
 * edge to a file that opens a database.
 */
export interface Measurement {
  /** RFC 3339 UTC. Which local day a sample belongs to is decided by this. */
  readonly startedAt: string;
  readonly endedAt: string;
  readonly value: number;
}

/** Everything held, per type. A type with nothing is absent or empty; both read the same. */
export type Series = Readonly<Partial<Record<HealthType, readonly Measurement[]>>>;

/** What the phone last said about each type, if it has said anything. */
export type Authorisation = Readonly<Partial<Record<HealthType, AuthorisationState>>>;

export interface DeriveInput {
  readonly series: Series;
  readonly authorisation?: Authorisation;
  /** The instant the review is being run at. An argument; this module has no clock. */
  readonly now: number;
  /** IANA, never a fixed offset. Constraint 5. Days are HIS days. */
  readonly tz: string;
  /** Days treated as "lately". */
  readonly recentDays?: number;
  /** Days before that, which "lately" is compared against. */
  readonly baselineDays?: number;
}

/** The last week, against the four before it. */
export const DEFAULT_RECENT_DAYS = 7;
export const DEFAULT_BASELINE_DAYS = 28;

/**
 * Where the quiet floor of a day is taken from, when a resting series has to be
 * estimated from raw heart rate.
 *
 * The fifth percentile rather than the minimum: a single spurious low reading —
 * a watch losing contact, a sensor settling — is a minimum, and a minimum is
 * therefore a statistic about artefacts. Over a day of ~1,400 readings the
 * fifth percentile is the seventieth-lowest, which no single artefact moves.
 */
export const RESTING_PERCENTILE = 0.05;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * How a day's figure is read for this type.
 *
 * `total` for things that accumulate — you walked 8,431 steps, you slept 372
 * minutes — and `mean` for things that are sampled — your heart was at 61.
 * Getting this backwards produces a number that is confidently wrong by three
 * orders of magnitude, so it is written down once, here, and `downsample.ts`
 * imports the same map rather than restating it.
 */
export type DailySummary = "total" | "mean";

export const DAILY_SUMMARY: Readonly<Record<HealthType, DailySummary>> = {
  heartRate: "mean",
  restingHeartRate: "mean",
  heartRateVariability: "mean",
  sleep: "total",
  steps: "total",
  workout: "total",
  bodyMass: "mean",
};

/** Why a series says nothing, when it says nothing. */
export type Evidence =
  /** Samples exist. */
  | "measured"
  /** No samples, and the phone proved it was allowed to look. Silence IS evidence. */
  | "silent"
  /**
   * No samples, and nobody proved we were ever allowed to look.
   *
   * `silenceIsEvidence` is true for `authorised` alone, so `denied`,
   * `notDetermined`, `undisclosed`, `unavailable` and *no report at all* land
   * here. A conclusion drawn from this quiet would be about his phone rather
   * than about him.
   */
  | "unproven"
  /** Computed from another type, because this one has nothing. */
  | "estimated";

/** One local day, reduced. */
export interface DailyStat {
  /** `YYYY-MM-DD` in his zone. */
  readonly day: string;
  readonly count: number;
  /** The figure for this day, read per {@link DAILY_SUMMARY}. */
  readonly figure: number;
  readonly total: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  /** The {@link RESTING_PERCENTILE} percentile of the day. The quiet floor. */
  readonly low: number;
}

/** A stretch of days, and what the daily figures over it came to. */
export interface Span {
  /** `YYYY-MM-DD`, inclusive. The nominal edge of the window, data or not. */
  readonly from: string;
  /** `YYYY-MM-DD`, inclusive. */
  readonly to: string;
  /** Days in the span that actually carry a figure. */
  readonly days: number;
  /** Mean of the daily figures. `null` when no day in the span has one. */
  readonly mean: number | null;
  /** Sample standard deviation of the daily figures. `null` under two days. */
  readonly sd: number | null;
}

/** Lately against his own ordinary. Nothing here is compared to a constant. */
export interface Deviation {
  readonly recent: number;
  readonly baseline: number;
  /** `recent - baseline`, in the type's own unit. */
  readonly delta: number;
  /** As a percentage of the baseline. `null` when the baseline is zero. */
  readonly percent: number | null;
  /**
   * How far from ordinary, in units of his own day-to-day variability.
   *
   * `null` when the baseline has under two days or no spread at all, which is
   * an honest answer rather than a zero. A z of 0 means "exactly typical" and
   * an absent one means "there is no such thing as typical yet"; collapsing
   * them would make a brand-new series look reassuringly normal.
   */
  readonly z: number | null;
}

/** A stretch of consecutive recent days on one side of his baseline. */
export interface Run {
  readonly direction: "above" | "below";
  /** Consecutive days, counting back from the most recent day with data. */
  readonly days: number;
  /** `YYYY-MM-DD`, the first day of the run. */
  readonly since: string;
}

/** Everything derived about one type. */
export interface SeriesDerivation {
  readonly type: HealthType;
  readonly unit: string;
  readonly summary: DailySummary;
  readonly evidence: Evidence;
  /**
   * The type this was computed from, when it is not its own.
   *
   * Non-null means **she worked this out**, and the review prompt says so.
   * A number a device reported and a number she computed are different claims.
   */
  readonly derivedFrom: HealthType | null;
  /** Every local day with data, oldest first, across the whole lookback. */
  readonly days: readonly DailyStat[];
  readonly recent: Span;
  readonly baseline: Span;
  readonly deviation: Deviation | null;
  readonly run: Run | null;
  /** The most recent day with a figure, or `null`. */
  readonly latest: DailyStat | null;
}

/** The window everything was drawn from, in the form a reason can name. */
export interface DerivationWindow {
  /** `YYYY-MM-DD` in his zone — the oldest day looked at. */
  readonly from: string;
  /** `YYYY-MM-DD` — the newest day looked at. */
  readonly to: string;
  /** How many calendar days that is. */
  readonly span: number;
  /** How many of them carry at least one measurement of any type. */
  readonly observed: number;
  /** `YYYY-MM-DD`, the oldest day that carries one, or `null`. */
  readonly firstObserved: string | null;
  /** `YYYY-MM-DD`, the newest day that carries one, or `null`. */
  readonly lastObserved: string | null;
  readonly tz: string;
}

/** What one review turn is given. */
export interface Derivations {
  readonly window: DerivationWindow;
  readonly recentDays: number;
  readonly baselineDays: number;
  /** One entry per type in {@link HEALTH_TYPES}, in that order, always. */
  readonly series: readonly SeriesDerivation[];
  /** True when at least one type has a measurement. */
  readonly anyMeasurement: boolean;
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60_000;

/**
 * The local calendar day an instant falls on.
 *
 * `en-CA` gives `YYYY-MM-DD` directly, which sorts and compares exactly as the
 * dates do, so nothing downstream ever parses one back. Same trick, and the
 * same reason, as `nightOf` in `memory/dream/log.ts`.
 */
export function dayOf(epochMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochMs));
}

/** `YYYY-MM-DD` plus a whole number of days, by calendar rather than by clock. */
export function shiftDay(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + days));
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(shifted.getUTCFullYear())}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Whole days between two `YYYY-MM-DD`s, inclusive of both ends. */
function daysBetween(from: string, to: string): number {
  const at = (day: string): number => {
    const [year, month, date] = day.split("-").map(Number);
    return Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1);
  };
  return Math.round((at(to) - at(from)) / DAY_MS) + 1;
}

/**
 * A window in words, for the reasoning a conclusion carries.
 *
 * `"14 days of measurement, 31 July – 13 August 2026"`. Every conclusion Syl
 * writes gets this appended to her own sentence by the service, so *"reasoning
 * names its window"* is a fact about the code path rather than a hope about the
 * model. Written out here because the string is part of the contract that
 * `a-conclusion-is-hers-never-his` asserts.
 */
export function describeWindow(window: DerivationWindow): string {
  if (window.firstObserved === null || window.lastObserved === null) {
    return `no days of measurement in ${window.from} to ${window.to}`;
  }
  const day = (value: string): string => {
    const [year, month, date] = value.split("-").map(Number);
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1)));
  };
  const count = `${String(window.observed)} day${window.observed === 1 ? "" : "s"} of measurement`;
  if (window.firstObserved === window.lastObserved) return `${count}, ${day(window.firstObserved)}`;
  return `${count}, ${day(window.firstObserved)} – ${day(window.lastObserved)}`;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * Sample standard deviation — `n - 1`, not `n`.
 *
 * These daily figures are a sample of his life rather than the whole of it, and
 * the population form understates the spread most at exactly the sample sizes
 * this file works at. Understating the spread inflates every z-score, which
 * would make a perfectly ordinary week look remarkable.
 *
 * `null` under two days, because with one there is no such thing as spread.
 */
function standardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const centre = mean(values);
  let sum = 0;
  for (const value of values) sum += (value - centre) ** 2;
  return Math.sqrt(sum / (values.length - 1));
}

/** The nearest-rank percentile of a sorted-in-place copy. */
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] ?? sorted[0] ?? 0;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** Bucket one type's measurements into local days, oldest first. */
function dailyStats(
  measurements: readonly Measurement[],
  summary: DailySummary,
  tz: string,
  from: string,
  to: string,
): DailyStat[] {
  const buckets = new Map<string, number[]>();
  for (const measurement of measurements) {
    const at = Date.parse(measurement.startedAt);
    if (Number.isNaN(at) || !Number.isFinite(measurement.value)) continue;
    const day = dayOf(at, tz);
    // The caller's window is the authority. A store that handed back a day
    // either side — a UTC range does not line up with a local one — must not
    // put a partial day at the edge of a baseline.
    if (day < from || day > to) continue;
    const bucket = buckets.get(day);
    if (bucket === undefined) buckets.set(day, [measurement.value]);
    else bucket.push(measurement.value);
  }

  const days: DailyStat[] = [];
  for (const day of [...buckets.keys()].sort()) {
    const values = buckets.get(day) ?? [];
    let total = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of values) {
      total += value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const average = total / values.length;
    days.push({
      day,
      count: values.length,
      figure: summary === "total" ? total : average,
      total,
      mean: average,
      min,
      max,
      low: percentile(values, RESTING_PERCENTILE),
    });
  }
  return days;
}

/** The span a set of daily figures covers, and what they came to. */
function spanOf(days: readonly DailyStat[], from: string, to: string): Span {
  const figures = days.filter((day) => day.day >= from && day.day <= to).map((day) => day.figure);
  return {
    from,
    to,
    days: figures.length,
    mean: figures.length === 0 ? null : mean(figures),
    sd: standardDeviation(figures),
  };
}

function deviationOf(recent: Span, baseline: Span): Deviation | null {
  if (recent.mean === null || baseline.mean === null) return null;
  const delta = recent.mean - baseline.mean;
  return {
    recent: recent.mean,
    baseline: baseline.mean,
    delta,
    percent: baseline.mean === 0 ? null : (delta / baseline.mean) * 100,
    z: baseline.sd === null || baseline.sd === 0 ? null : delta / baseline.sd,
  };
}

/**
 * How many consecutive recent days sit on one side of his baseline.
 *
 * This is the shape of the spec's own example — *"his resting heart rate has
 * been up for nine days"* — and it is a **description**, not a test. There is
 * no magnitude a day has to clear to count; it counts if it is on that side at
 * all, and how far is `deviation` and `z`'s job to say.
 *
 * A calendar gap ends the run. "Nine days" has to mean nine days, and a run
 * that jumped a day with no data would be a claim about the watch's battery.
 */
function runOf(days: readonly DailyStat[], baselineMean: number | null): Run | null {
  if (baselineMean === null || days.length === 0) return null;
  const last = days[days.length - 1];
  if (last === undefined || last.figure === baselineMean) return null;

  const direction: Run["direction"] = last.figure > baselineMean ? "above" : "below";
  let count = 0;
  let since = last.day;
  let expected = last.day;

  for (let index = days.length - 1; index >= 0; index -= 1) {
    const day = days[index];
    if (day === undefined || day.day !== expected) break;
    const side = day.figure > baselineMean ? "above" : day.figure < baselineMean ? "below" : null;
    if (side !== direction) break;
    count += 1;
    since = day.day;
    expected = shiftDay(expected, -1);
  }

  return count === 0 ? null : { direction, days: count, since };
}

function evidenceOf(
  measured: number,
  state: AuthorisationState | undefined,
  derivedFrom: HealthType | null,
): Evidence {
  if (derivedFrom !== null) return "estimated";
  if (measured > 0) return "measured";
  // Absent is not `denied` and it is not `authorised` either. Only a proven
  // `authorised` makes silence mean anything, and `silenceIsEvidence` is the
  // one place that rule is written down.
  return state !== undefined && silenceIsEvidence(state) ? "silent" : "unproven";
}

const EMPTY_SPAN = (from: string, to: string): Span => ({
  from,
  to,
  days: 0,
  mean: null,
  sd: null,
});

/**
 * Everything one review turn gets to reason over.
 *
 * Deterministic in every argument, including `now`. Call it twice with the same
 * input and it produces the same object, which is what makes the review turn's
 * prompt reproducible from a fixture and what makes an arithmetic bug provable
 * without a database.
 */
export function derive(input: DeriveInput): Derivations {
  const recentDays = input.recentDays ?? DEFAULT_RECENT_DAYS;
  const baselineDays = input.baselineDays ?? DEFAULT_BASELINE_DAYS;

  const today = dayOf(input.now, input.tz);
  const recentFrom = shiftDay(today, -(recentDays - 1));
  const baselineTo = shiftDay(recentFrom, -1);
  const baselineFrom = shiftDay(baselineTo, -(baselineDays - 1));

  const measuredDays = new Map<HealthType, DailyStat[]>();
  for (const type of HEALTH_TYPES) {
    measuredDays.set(
      type,
      dailyStats(
        input.series[type] ?? [],
        DAILY_SUMMARY[type],
        input.tz,
        baselineFrom,
        today,
      ),
    );
  }

  // The estimate, and the reason this file exists in the shape it does: he has
  // 28,726 raw heart-rate samples and not one resting-heart-rate reading, so
  // the series every interesting conclusion leans on has to be computed or
  // there are no conclusions. The day's quiet floor stands in for it, and it
  // is labelled all the way to the prompt.
  const rawHeartRate = measuredDays.get("heartRate") ?? [];
  const measuredResting = measuredDays.get("restingHeartRate") ?? [];
  const estimateResting = measuredResting.length === 0 && rawHeartRate.length > 0;
  if (estimateResting) {
    measuredDays.set(
      "restingHeartRate",
      rawHeartRate.map((day) => ({
        ...day,
        figure: day.low,
        total: day.low,
        mean: day.low,
      })),
    );
  }

  const series: SeriesDerivation[] = HEALTH_TYPES.map((type) => {
    const days = measuredDays.get(type) ?? [];
    const derivedFrom = type === "restingHeartRate" && estimateResting ? "heartRate" : null;
    const recent = days.length === 0 ? EMPTY_SPAN(recentFrom, today) : spanOf(days, recentFrom, today);
    const baseline =
      days.length === 0
        ? EMPTY_SPAN(baselineFrom, baselineTo)
        : spanOf(days, baselineFrom, baselineTo);
    const recentOnly = days.filter((day) => day.day >= recentFrom);

    return {
      type,
      unit: UNITS[type],
      summary: DAILY_SUMMARY[type],
      evidence: evidenceOf(days.length, input.authorisation?.[type], derivedFrom),
      derivedFrom,
      days,
      recent,
      baseline,
      deviation: deviationOf(recent, baseline),
      run: runOf(recentOnly, baseline.mean),
      latest: days[days.length - 1] ?? null,
    };
  });

  const observedDays = new Set<string>();
  for (const derivation of series) {
    // The estimate is not independent evidence that a day was observed — the
    // raw heart rate it came from already counted.
    if (derivation.derivedFrom !== null) continue;
    for (const day of derivation.days) observedDays.add(day.day);
  }
  const observed = [...observedDays].sort();

  return {
    window: {
      from: baselineFrom,
      to: today,
      span: daysBetween(baselineFrom, today),
      observed: observed.length,
      firstObserved: observed[0] ?? null,
      lastObserved: observed[observed.length - 1] ?? null,
      tz: input.tz,
    },
    recentDays,
    baselineDays,
    series,
    anyMeasurement: observed.length > 0,
  };
}
