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
 *
 *
 * ## TWO WAYS IN, AND THEY MUST AGREE TO THE LAST BIT
 *
 * `syl-8ys9.2.1`. {@link DeriveInput} accepts either raw {@link Measurement}s,
 * which this file buckets into days itself, or {@link DailyStat}s already
 * bucketed by whoever read them — which is what `samples.ts`'s `daily()` does
 * in SQL, and what makes the summary verb cost a number of DAYS rather than a
 * number of SAMPLES. Measured on a corpus his size: 3,255ms against 62ms.
 *
 * **Nothing this file computes is finer than a day**, which is what makes the
 * second door sound: every figure is a daily mean or total, a baseline over
 * days, or a run of days. The one exception is {@link DailyStat.low}, the day's
 * quiet floor, which IS a within-day percentile — so it is carried on the
 * aggregate rather than recomputed, and `daily()` computes it with the same
 * nearest rank ({@link percentileRank}) this file uses.
 *
 * The two doors are held together by three things and it is worth naming all
 * three, because each of them is a way they could quietly stop agreeing:
 *
 * 1. **{@link dailyStatOf} is the only place a day's `figure` is decided.**
 *    Both paths build their `DailyStat` through it, so `total` versus `mean`
 *    cannot be answered differently on either side of the seam.
 * 2. **Summation is compensated, because SQLite's is.** `sum()` in SQLite is
 *    Kahan-Babuska-Neumaier and a naive `+=` in JavaScript is not; over a day
 *    of 464 heart-rate readings the two disagree in the last bits, so a
 *    baseline would shift depending on which door the data came through. See
 *    {@link sum}.
 * 3. **{@link percentileRank} is exported** rather than restated in SQL.
 *
 * A baseline that moved because the read path changed would make her
 * conclusions change for reasons nothing recorded, which is worse than a slow
 * verb.
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

/**
 * Days already bucketed by whoever read them. The fast door.
 *
 * `syl-8ys9.2.1`. A type present here is NOT re-derived from {@link Series},
 * and an empty array is a real answer — "this type has no days" — rather than a
 * request to look in `series` instead. See {@link DeriveInput}.
 */
export type DailySeries = Readonly<Partial<Record<HealthType, readonly DailyStat[]>>>;

/**
 * Either raw measurements or days already reduced. Per type, and both are
 * allowed in one call.
 *
 * A type appearing in `days` takes the aggregate path and its entry in `series`
 * is ignored. That is not a fallback chain to be clever about: it is what lets
 * the summary hand over fourteen SQL aggregates while the nightly review keeps
 * handing over raw rows, through one function, with the arithmetic written once.
 */
export interface DeriveInput {
  /** Raw measurements, bucketed into his days here. */
  readonly series?: Series;
  /** Days already bucketed — by SQL, by a fixture, by anything. Wins over `series`. */
  readonly days?: DailySeries;
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
  // The seven from `syl-8ys9.1`. Only the two energies accumulate — a day's
  // active energy is the sum of the day's burns, exactly as steps are. The rest
  // are readings OF something, and summing a body fat percentage over a day
  // produces a number three orders of magnitude wrong with nothing to say so,
  // which is what the block above exists to prevent.
  activeEnergy: "total",
  basalEnergy: "total",
  bodyFatPercentage: "mean",
  vo2Max: "mean",
  height: "mean",
  leanBodyMass: "mean",
  respiratoryRate: "mean",
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
 * Formatters, kept, because CONSTRUCTING ONE COST 2.4 SECONDS PER SUMMARY.
 *
 * `syl-8ys9.2.3`. `dayOf` is called once per sample, and building an
 * `Intl.DateTimeFormat` is expensive in a way nothing about the call site
 * suggests: it resolves a locale and loads the zone's transition table every
 * time. Measured against his corpus — 36,485 samples inside the window —
 * `dayOf` alone accounted for **2,442ms of the 3,034ms** `derive()` took, and
 * the store read it was blamed on was 77ms.
 *
 * The instance is immutable and depends only on the zone, so one per zone is
 * the whole fix. A `Map` rather than a single slot because the review, the
 * summary and the fold can all be in flight for different zones in principle,
 * and a one-entry cache that thrashes is a cache that reads as working.
 *
 * The aggregate path in `samples.ts` means this is no longer on the summary's
 * hot path at all — but it is still on the nightly review's, which reads raw
 * rows on purpose, and this was a real defect independent of either.
 */
const DAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(tz: string): Intl.DateTimeFormat {
  const held = DAY_FORMATTERS.get(tz);
  if (held !== undefined) return held;
  const made = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  DAY_FORMATTERS.set(tz, made);
  return made;
}

/**
 * The local calendar day an instant falls on.
 *
 * `en-CA` gives `YYYY-MM-DD` directly, which sorts and compares exactly as the
 * dates do, so nothing downstream ever parses one back. Same trick, and the
 * same reason, as `nightOf` in `memory/dream/log.ts`.
 */
export function dayOf(epochMs: number, tz: string): string {
  return dayFormatter(tz).format(new Date(epochMs));
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

/**
 * Compensated summation — Kahan-Babuska-Neumaier — BECAUSE SQLITE'S `sum()` IS.
 *
 * `syl-8ys9.2.1`, and the one arithmetic difference that stops a day's figures
 * being the same figures whichever door the data came through. A day's total
 * can be computed here, over raw measurements, or by SQLite over the same rows
 * (`samples.ts`'s `daily()`). SQLite's `sum()` carries a running compensation
 * term; a plain `+=` in JavaScript does not. Over 5,000 values of mixed
 * magnitude the two answers differ:
 *
 *     sqlite sum()  21716791915707.2929688
 *     js  `+=`      21716791915707.2968750
 *     js  KBN       21716791915707.2929688   <- identical to sqlite
 *
 * That is small, and it is exactly the size of difference that would make a
 * baseline shift the day the read path changed — a conclusion of hers changing
 * for a reason nothing recorded. Naming a tolerance instead would be choosing
 * how much silent drift is acceptable, which is not a thing to choose.
 *
 * It is also strictly the more accurate answer, so this is not a compromise
 * made to match a database. Matching it is the reason it was noticed.
 */
function sum(values: readonly number[]): number {
  let total = 0;
  let compensation = 0;
  for (const value of values) {
    const next = total + value;
    compensation +=
      Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
    total = next;
  }
  return total + compensation;
}

function mean(values: readonly number[]): number {
  return sum(values) / values.length;
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
  return Math.sqrt(sum(values.map((value) => (value - centre) ** 2)) / (values.length - 1));
}

/**
 * WHICH reading of a day is its quiet floor — the 1-based nearest rank.
 *
 * Exported because `samples.ts` has to pick the same one out of SQL, and the
 * only way two implementations of `ceil` on a float agree in every case is for
 * there to be one implementation. The store reads the day's `count`, calls
 * this, and asks SQLite for that row by `row_number()`.
 *
 * `Math.max(1, …)` rather than a floor of zero: a day with a single reading has
 * that reading as its floor, and rank 0 does not exist.
 */
export function percentileRank(count: number, fraction: number = RESTING_PERCENTILE): number {
  return Math.max(1, Math.ceil(fraction * count));
}

/** The nearest-rank percentile of a sorted-in-place copy. */
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[percentileRank(sorted.length, fraction) - 1] ?? sorted[0] ?? 0;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * What a day's readings came to, before it is known how to READ them.
 *
 * The five facts a day's rows carry, in the form both doors can produce: this
 * file counts and sums an array, `samples.ts` asks SQLite for `count`, `sum`,
 * `min`, `max` and the {@link percentileRank} row. Split out so
 * {@link dailyStatOf} can be the one place `total` versus `mean` is decided.
 */
export interface DailyTally {
  /** `YYYY-MM-DD` in his zone. */
  readonly day: string;
  readonly count: number;
  readonly total: number;
  readonly min: number;
  readonly max: number;
  /** The {@link RESTING_PERCENTILE} percentile of the day. The quiet floor. */
  readonly low: number;
}

/**
 * THE ONE PLACE A DAY'S FIGURE IS DECIDED.
 *
 * `figure` is what every span, deviation and run is computed from, and reading
 * a `total` type as a `mean` produces a number confidently wrong by three
 * orders of magnitude. There are now two paths that build a `DailyStat` — this
 * file from raw measurements, `samples.ts` from a SQL aggregate — and if each
 * decided that for itself the summary and the nightly review could disagree
 * about his step count without anything failing.
 *
 * `mean` is derived from `total` and `count` rather than taken from SQLite's
 * `avg()`, for the same reason: one division, written once.
 */
export function dailyStatOf(tally: DailyTally, summary: DailySummary): DailyStat {
  const average = tally.total / tally.count;
  return {
    day: tally.day,
    count: tally.count,
    figure: summary === "total" ? tally.total : average,
    total: tally.total,
    mean: average,
    min: tally.min,
    max: tally.max,
    low: tally.low,
  };
}

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
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    days.push(
      dailyStatOf(
        {
          day,
          count: values.length,
          total: sum(values),
          min,
          max,
          low: percentile(values, RESTING_PERCENTILE),
        },
        summary,
      ),
    );
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

/** The four calendar edges a derivation is cut at. All `YYYY-MM-DD`, his zone. */
export interface DerivationSpan {
  /** The newest day looked at — his today. */
  readonly today: string;
  /** First day of "lately". */
  readonly recentFrom: string;
  /** Last day of the baseline, which is the day before {@link recentFrom}. */
  readonly baselineTo: string;
  /** Oldest day looked at. */
  readonly baselineFrom: string;
  readonly recentDays: number;
  readonly baselineDays: number;
}

/**
 * Which days a derivation will actually look at, WITHOUT deriving anything.
 *
 * Exported so a caller reading aggregates can ask the store for exactly the
 * days `derive` is about to keep, rather than computing a lookback of its own
 * and hoping the two line up. They did not: `summarise.ts` and `review.ts` each
 * carried `recent + baseline + 2` with a comment explaining the two, and a
 * window computed twice is a window that eventually disagrees — silently, in
 * the direction that truncates a baseline.
 */
export function derivationSpan(
  input: Pick<DeriveInput, "now" | "tz" | "recentDays" | "baselineDays">,
): DerivationSpan {
  const recentDays = input.recentDays ?? DEFAULT_RECENT_DAYS;
  const baselineDays = input.baselineDays ?? DEFAULT_BASELINE_DAYS;
  const today = dayOf(input.now, input.tz);
  const recentFrom = shiftDay(today, -(recentDays - 1));
  const baselineTo = shiftDay(recentFrom, -1);
  return {
    today,
    recentFrom,
    baselineTo,
    baselineFrom: shiftDay(baselineTo, -(baselineDays - 1)),
    recentDays,
    baselineDays,
  };
}

/**
 * Keep only the days inside the window, oldest first.
 *
 * The caller's window is the authority for pre-bucketed days exactly as it is
 * for raw ones: a store that answered with a day either side must not put a
 * partial day at the edge of a baseline. Sorted rather than trusted, because
 * `runOf` walks backwards expecting consecutive calendar days and would report
 * a one-day run over a fortnight of data if the order were wrong.
 */
function bounded(days: readonly DailyStat[], from: string, to: string): DailyStat[] {
  return days
    .filter((day) => day.day >= from && day.day <= to)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * Everything one review turn gets to reason over.
 *
 * Deterministic in every argument, including `now`. Call it twice with the same
 * input and it produces the same object, which is what makes the review turn's
 * prompt reproducible from a fixture and what makes an arithmetic bug provable
 * without a database.
 */
export function derive(input: DeriveInput): Derivations {
  const { today, recentFrom, baselineTo, baselineFrom, recentDays, baselineDays } =
    derivationSpan(input);

  const measuredDays = new Map<HealthType, DailyStat[]>();
  for (const type of HEALTH_TYPES) {
    const aggregated = input.days?.[type];
    measuredDays.set(
      type,
      aggregated === undefined
        ? dailyStats(input.series?.[type] ?? [], DAILY_SUMMARY[type], input.tz, baselineFrom, today)
        : bounded(aggregated, baselineFrom, today),
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
