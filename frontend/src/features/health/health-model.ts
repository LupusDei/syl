/**
 * What the health viewer decides, as pure functions.
 *
 * `syl-t9tj.3.2`. The whole file exists to serve one sentence from the spec:
 *
 * > The view distinguishes *no data* from *not authorised*.
 *
 * Both are an empty window. On a chart both are a flat line. The difference is
 * that one of them is a fact about his body and the other is a fact about his
 * phone, and a surface that renders them alike is how the empty/denied
 * ambiguity survives every layer built to catch it — because at that point the
 * request succeeded, the envelope said `success: true`, the array was
 * well-formed, and the only symptom is a line that looks like a quiet day.
 *
 *
 * ## The states are not a severity scale
 *
 * There are five on the wire plus a sixth this view has to render, and they do
 * not sort. Each names a *different fact*, and collapsing any two of them
 * produces advice that is worse than silence:
 *
 * - `authorised` — the only one under which quiet is evidence.
 * - `undisclosed` — asked, and iOS will not confirm a read grant either way
 *   (`syl-m3gi`). **This is the ordinary case, not an edge case.** It is what
 *   his empty types actually carry, and there is nothing to do about it: only
 *   an arriving sample settles it.
 * - `notDetermined` — nobody has ever shown him the prompt.
 * - `unavailable` — **HealthKit is absent from the device entirely.**
 *   `isHealthDataAvailable()` answers device-wide, so this is never about one
 *   type. An earlier draft of this file said it meant "no watch, so no HRV" and
 *   rendered "buy a watch" as the remedy. That was wrong and unfixably so: a
 *   phone with no watch reports HRV as `undisclosed`, and nothing on the device
 *   can tell a missing sensor from a declined type.
 * - `denied` — reserved. **No current client can produce it**, because read
 *   authorisation is exactly what iOS will not disclose. It stays renderable
 *   because a future client or the Commander himself could substantiate one,
 *   but a `denied` in the store today has a provenance worth asking about.
 * - `unreported` — **not on the wire, and the most dangerous one.** The route
 *   answers `state: null` when the phone has never said anything about this
 *   type at all. Rendering that as `denied` would tell him he refused
 *   something he was never asked about.
 *
 * Telling him to grant a permission he already granted is useless advice.
 * Telling him to buy hardware for a fact the device cannot report is worse. A
 * collapsed display produces both.
 *
 *
 * ## Why the wire types are hand-written here
 *
 * The same reason `memory-client.ts` gives: `api/client.ts` describes no
 * payload of its own, because that is what keeps the frontend, the backend and
 * SylKit measured against one spec. `GET /health/series` is not in
 * `shared/openapi.yaml` yet, so its shape is quarantined in this feature until
 * it is. Do not move these into `shared/src/types.ts` by hand — generate them.
 */

import type { Tone } from "../../ui/Badge";

/**
 * The fourteen types. Mirrors `backend/src/health/contract.ts`, **in its order**
 * — the panels render in this sequence, so a type inserted in the middle here
 * silently reorders the page against the wire.
 */
export const HEALTH_TYPES = [
  "heartRate",
  "restingHeartRate",
  "heartRateVariability",
  "sleep",
  "steps",
  "workout",
  "bodyMass",
  "activeEnergy",
  "basalEnergy",
  "bodyFatPercentage",
  "vo2Max",
  "leanBodyMass",
  "respiratoryRate",
] as const;

export type HealthType = (typeof HEALTH_TYPES)[number];

export function isHealthType(value: unknown): value is HealthType {
  return typeof value === "string" && (HEALTH_TYPES as readonly string[]).includes(value);
}

/**
 * What each type is called on a screen a human reads.
 *
 * **Apple Health's wording, not HealthKit's identifier**, wherever the two
 * differ — he is reading this beside the phone that produced the numbers, and a
 * row called "Basal energy" next to a Health app that says "Resting Energy" is
 * two names for one thing on the one screen where they have to be compared.
 * `vo2Max` is "Cardio fitness" for the same reason.
 */
export const TYPE_LABELS: Readonly<Record<HealthType, string>> = {
  heartRate: "Heart rate",
  restingHeartRate: "Resting heart rate",
  heartRateVariability: "Heart rate variability",
  sleep: "Sleep",
  steps: "Steps",
  workout: "Workouts",
  bodyMass: "Body mass",
  activeEnergy: "Active energy",
  basalEnergy: "Resting energy",
  bodyFatPercentage: "Body fat",
  vo2Max: "Cardio fitness",
  leanBodyMass: "Lean body mass",
  respiratoryRate: "Respiratory rate",
};

/** The five states the phone can report. */
export const AUTHORISATION_STATES = [
  "authorised",
  "denied",
  "notDetermined",
  "undisclosed",
  "unavailable",
] as const;

export type AuthorisationState = (typeof AUTHORISATION_STATES)[number];

/** One measurement, as `GET /health/series` returns it. */
export interface HealthSample {
  readonly type: HealthType;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly value: number;
  /** Which device or app recorded it — part of a sample's identity, not a label. */
  readonly source: string;
  /** When the service wrote it, which is not when it was measured. */
  readonly recordedAt: string;
}

/**
 * Why the server overrode the phone's report for one type.
 *
 * `syl-8ys9.3.3`. Non-null means **nothing has ever published this type**: not
 * one sample, ever, across a window in which the same source delivered
 * everything else. That is a judgement the phone cannot make —
 * `isHealthDataAvailable()` answers device-wide — and one the server can,
 * because it is the only party that sees the whole history.
 *
 * It is an inference, so it arrives carrying what it was drawn from, and this
 * screen renders those grounds rather than only the verdict. `reported` is the
 * label it overrode, kept so the two can be compared instead of one quietly
 * replacing the other.
 */
export interface UnpublishedFinding {
  readonly type: HealthType;
  /** What the phone actually said. Not destroyed by the inference. */
  readonly reported: AuthorisationState;
  /** First local day examined, `YYYY-MM-DD`. */
  readonly from: string;
  /** Last local day examined. */
  readonly to: string;
  /** Days in that window on which some other type produced a figure. */
  readonly corroboratedDays: number;
  /** Which types were arriving while this one never has. */
  readonly corroboratedBy: readonly HealthType[];
  /** The grounds as a sentence. */
  readonly because: string;
}

/**
 * One type over a window, as `GET /health/series` returns it.
 *
 * `state: null` is a real answer and means the phone has never reported on this
 * type. `silenceIsEvidence` travels beside the state, computed by the server
 * from the contract's own function — this view reads it rather than
 * re-deriving it, so a state added later cannot start licensing conclusions
 * here by accident.
 *
 * `unpublished` is the one field on this shape the phone did not produce. When
 * it is set, `state` reads `unavailable` because the SERVER concluded it, and
 * the finding says on what — see {@link UnpublishedFinding}.
 */
export interface HealthSeries {
  readonly type: HealthType;
  readonly unit: string;
  readonly state: AuthorisationState | null;
  readonly reportedAt: string | null;
  readonly silenceIsEvidence: boolean;
  /** The newest `startedAt` held for this type, over ALL time — not this window. */
  readonly watermark: string | null;
  readonly unpublished: UnpublishedFinding | null;
  readonly samples: readonly HealthSample[];
}

/* ------------------------------------------------------------- standings --- */

/**
 * The seven-way display state.
 *
 * `unreported` is this view's name for `state: null`. It is a standing in its
 * own right rather than a null check at each call site, because every one of
 * those call sites would otherwise have to remember not to fall through to
 * `denied`.
 *
 * `unpublished` is the seventh and it is not on the wire either: it is
 * `unavailable` **as the server inferred it**, which is a different fact from
 * `unavailable` as the phone reports it, with a different remedy. The phone's
 * means "HealthKit is absent from this device, for every type". This one means
 * "nothing has ever written THIS type to Health, while everything else was
 * arriving". Rendering the inferred one under the reported one's words would
 * tell him his phone has no HealthKit while thirteen other panels are full of
 * data, which reads as a broken display and would rightly cost this screen its
 * credibility.
 */
export type Standing = AuthorisationState | "unreported" | "unpublished";

/**
 * The standing to render, from the state on the wire and the grounds beside it.
 *
 * The finding wins when it is present, because it is strictly more specific:
 * the server only ever sets it alongside `unavailable`, and only when it can say
 * what the emptiness was inferred from.
 */
export function standingOf(
  state: AuthorisationState | null,
  unpublished: UnpublishedFinding | null = null,
): Standing {
  if (unpublished !== null) return "unpublished";
  return state ?? "unreported";
}

export interface StandingDescriptor {
  readonly standing: Standing;
  /** The chip text. Every one of these is a different sentence fragment. */
  readonly label: string;
  readonly tone: Tone;
  /**
   * A glyph, so the six are told apart without colour.
   *
   * Colour alone fails a colour-blind reader and fails a screenshot pasted into
   * a thread, and this is the one distinction in the feature that must survive
   * both.
   */
  readonly mark: string;
  /** The bold assertion an empty panel leads with. One clause, no hedging. */
  readonly headline: string;
  /** What an empty window means under this standing. Rendered verbatim. */
  readonly silenceMeans: string;
  /**
   * What he can do about it, or what he should understand instead.
   *
   * `null` only for `authorised`, where there is genuinely nothing wrong. Every
   * other one says something, and two of them say "there is nothing to do" —
   * which is a real answer and the honest one. Inventing an action for a fact
   * the device cannot report is how "buy a watch" got written here once.
   */
  readonly remedy: string | null;
  /** Whether an empty window is a fact about him. Only one of these is `true`. */
  readonly evidence: boolean;
}

/**
 * The six treatments.
 *
 * Written as a complete record so a state added to the contract fails the
 * typecheck here rather than rendering as `undefined` — which would land on the
 * screen as a blank chip beside an empty chart, i.e. as the exact bug.
 */
export const STANDINGS: Readonly<Record<Standing, StandingDescriptor>> = {
  authorised: {
    standing: "authorised",
    label: "authorised",
    tone: "ok",
    mark: "●",
    headline: "No samples, and that is a fact about him.",
    silenceMeans: "Nothing happened. This is the one state where an empty window is about his body.",
    remedy: null,
    evidence: true,
  },
  undisclosed: {
    standing: "undisclosed",
    label: "iOS will not say",
    tone: "warn",
    mark: "~",
    headline: "This quiet proves nothing.",
    silenceMeans:
      "iOS will not confirm a read grant either way, so an empty window here could be a refusal, a missing sensor, or a genuinely quiet week — and nothing on the device can tell those apart.",
    remedy:
      "Nothing to do, and nothing to grant. This is the ordinary state for a read-only type; one arriving sample is the only thing that settles it.",
    evidence: false,
  },
  notDetermined: {
    standing: "notDetermined",
    label: "never asked",
    tone: "pending",
    mark: "?",
    headline: "He has never been asked.",
    silenceMeans:
      "Nobody has shown him the permission sheet for this type, so nothing was ever read.",
    remedy: "Open Syl on the phone. iOS will show the prompt.",
    evidence: false,
  },
  unavailable: {
    standing: "unavailable",
    label: "HealthKit absent",
    tone: "muted",
    mark: "∅",
    headline: "There was nothing to read.",
    silenceMeans: "This device has no HealthKit at all — for this type or for any other.",
    remedy:
      "Device-wide and all-or-nothing; it is never a fact about one type. If this appears on one type and not the rest, the identifier has gone out of the SDK.",
    evidence: false,
  },
  denied: {
    standing: "denied",
    label: "refused",
    tone: "fail",
    mark: "✕",
    headline: "A refusal is on record.",
    silenceMeans: "Nothing was read, and this window says nothing about his body.",
    remedy:
      "Settings → Privacy & Security → Health → Syl. Note that no current client can PROVE a refusal, so a state of `denied` did not come from the phone and its provenance is worth asking about.",
    evidence: false,
  },
  unpublished: {
    standing: "unpublished",
    label: "nothing publishes it",
    tone: "muted",
    mark: "⊘",
    headline: "Nothing has ever published this.",
    silenceMeans:
      "Not one sample of this type has ever reached us, across a window in which his other types arrived day after day. That is a fact about what his equipment writes to Health, not about his body — and the panel says which days it was drawn from, because the server inferred it rather than the phone reporting it.",
    remedy:
      "What is missing is a publisher, not a permission — look at what is supposed to be sending this type before looking at the permission sheet. iOS cannot separate a source that does not carry a type from a read that was refused, and this screen will not pretend it can; what it can say is that nothing has ever written one. Oura writes neither heart rate variability nor resting heart rate at all — read its permission list alphabetically and both are simply absent — so for those two an estimate is the only figure there will ever be. The inference retracts itself: the first sample that ever arrives ends it.",
    evidence: false,
  },
  unreported: {
    standing: "unreported",
    label: "never reported",
    tone: "accent",
    mark: "—",
    headline: "We have never been told whether we may look.",
    silenceMeans: "The phone has never sent an authorisation report for this type. It is not a refusal.",
    remedy:
      "An old build, or a phone that has never uploaded. Nothing here is about permission at all.",
    evidence: false,
  },
};

export function standingDescriptor(
  state: AuthorisationState | null,
  unpublished: UnpublishedFinding | null = null,
): StandingDescriptor {
  return STANDINGS[standingOf(state, unpublished)];
}

/** The standing for a whole series, grounds included. */
export function seriesStanding(series: HealthSeries | null): StandingDescriptor {
  return standingDescriptor(series?.state ?? null, series?.unpublished ?? null);
}

/**
 * Whether quiet in this series may be read as "nothing happened".
 *
 * **Fails closed, and requires both halves to agree.** The server computes the
 * flag from `silenceIsEvidence()` in the contract; this checks that the state
 * beside it is the one that function returns `true` for. A disagreement is a
 * bug somewhere upstream, and the safe reading of a bug is "we did not look" —
 * the failure mode of being too cautious is a hatched panel on a type that was
 * fine, and the failure mode of trusting it is a flat line that lies about his
 * body.
 */
export function silenceIsEvidence(series: HealthSeries): boolean {
  return series.silenceIsEvidence === true && series.state === "authorised";
}

/**
 * The server said one thing and its own state field says another.
 *
 * Surfaced rather than swallowed. An instrument that quietly corrects the thing
 * it is measuring is not an instrument.
 */
export function authorisationDisagrees(series: HealthSeries): boolean {
  return series.silenceIsEvidence !== (series.state === "authorised");
}

/* --------------------------------------------------------------- reading --- */

/**
 * What the body of a type's panel must be, which is never "a chart, maybe
 * empty".
 *
 * Four shapes, and the middle two are the point of the whole bead:
 *
 * - `samples` — there is data. Draw it.
 * - `measuredZero` — authorised, and nothing in the window. A baseline is
 *   honest here, because the zero was measured.
 * - `notLooked` — empty, and quiet is not evidence. **No line is drawn at
 *   all.** A baseline would be a measurement we never took.
 * - `failed` — the request did not come back. Also not an absence of data, and
 *   also not a permission problem.
 */
export type Reading = "samples" | "measuredZero" | "notLooked" | "failed";

export interface TypeLoad {
  readonly type: HealthType;
  readonly series: HealthSeries | null;
  /** Per type, so one failing type cannot blank the other six. */
  readonly failed: boolean;
}

export function readingOf(load: TypeLoad): Reading {
  if (load.failed || load.series === null) return "failed";
  if (load.series.samples.length > 0) return "samples";
  return silenceIsEvidence(load.series) ? "measuredZero" : "notLooked";
}

/**
 * Samples held for a type the phone may no longer read.
 *
 * Not a contradiction and not an error: revocation after proof is undetectable
 * (the contract says so), so history from before it stays on disk and stays
 * true. Worth calling out on the row, because otherwise a full chart under a
 * red chip reads as a broken display.
 */
export function isHistoricOnly(load: TypeLoad): boolean {
  return (
    load.series !== null && load.series.samples.length > 0 && !silenceIsEvidence(load.series)
  );
}

/* --------------------------------------------------------------- summary --- */

export interface SourceCount {
  readonly source: string;
  readonly count: number;
}

export interface SeriesSummary {
  readonly count: number;
  /** Every device or app that contributed, commonest first. */
  readonly sources: readonly SourceCount[];
  readonly first: string | null;
  readonly last: string | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  /** The answer hit the store's cap, so this is a prefix of the window. */
  readonly truncated: boolean;
}

/**
 * The store's own default, which `GET /health/series` does not let a caller
 * change and does not report having applied.
 *
 * Hard-coded here under protest — see the note on {@link SeriesSummary.truncated}.
 * A count equal to it is the only signal a client has that the window was cut
 * short, and because the store orders oldest-first the rows that get dropped are
 * the recent ones, i.e. exactly the ones that answer "is data still arriving?".
 * The watermark is therefore read from the series envelope rather than from the
 * last row, and this flag exists so the difference is stated on the screen
 * rather than assumed.
 */
export const SERIES_CAP = 5_000;

export function summarise(samples: readonly HealthSample[]): SeriesSummary {
  if (samples.length === 0) {
    return {
      count: 0,
      sources: [],
      first: null,
      last: null,
      min: null,
      max: null,
      mean: null,
      truncated: false,
    };
  }

  const counts = new Map<string, number>();
  let first: string | null = null;
  let last: string | null = null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let total = 0;

  for (const sample of samples) {
    counts.set(sample.source, (counts.get(sample.source) ?? 0) + 1);
    if (first === null || sample.startedAt < first) first = sample.startedAt;
    if (last === null || sample.startedAt > last) last = sample.startedAt;
    if (sample.value < min) min = sample.value;
    if (sample.value > max) max = sample.value;
    total += sample.value;
  }

  const sources = [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => (b.count === a.count ? a.source.localeCompare(b.source) : b.count - a.count));

  return {
    count: samples.length,
    sources,
    first,
    last,
    min,
    max,
    mean: total / samples.length,
    truncated: samples.length >= SERIES_CAP,
  };
}

/* ---------------------------------------------------------------- window --- */

export interface WindowChoice {
  readonly id: string;
  readonly label: string;
  readonly days: number;
}

/**
 * The windows on offer.
 *
 * 60 days is the retention horizon from the spec, so there is deliberately no
 * choice above it: an option that always came back short would teach him to
 * distrust the shortfall, which is the one signal on this page that must stay
 * meaningful.
 *
 * The default is a day rather than a week because of {@link SERIES_CAP}. Heart
 * rate runs to roughly 1,400 samples a day, so a week of it is capped and a day
 * of it is not — and an uncapped window is the only one whose row counts can be
 * read as counts.
 */
const DAY: WindowChoice = { id: "1d", label: "Last 24 hours", days: 1 };

export const WINDOWS: readonly WindowChoice[] = [
  DAY,
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "60d", label: "Last 60 days", days: 60 },
];

export const DEFAULT_WINDOW_ID = DAY.id;

export function windowChoice(id: string): WindowChoice {
  return WINDOWS.find((choice) => choice.id === id) ?? DAY;
}

export interface WindowRange {
  readonly from: string;
  readonly to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `now` is passed in, never read here — a view that reads the clock is untestable across time. */
export function windowRange(choice: WindowChoice, now: Date): WindowRange {
  return {
    from: new Date(now.getTime() - choice.days * DAY_MS).toISOString(),
    to: now.toISOString(),
  };
}

/* -------------------------------------------------------------- sparkline --- */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface SparklineSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The line, in segments, positioned by TIME rather than by index.
 *
 * Two decisions, and both are the same decision:
 *
 * 1. **A gap breaks the line.** Buckets with no sample end a segment and start
 *    a new one, so a polyline is never drawn across hours nobody measured. A
 *    continuous line over a gap is the small version of the lie this whole view
 *    exists to prevent — it says the signal was there and steady.
 * 2. **x is time, not sample number.** Otherwise a burst of samples in one hour
 *    stretches to fill the window and a sparse day looks identical to a busy
 *    one.
 *
 * Returns `[]` for no samples. A segment of **one** point is kept and is the
 * caller's problem to draw — a `polyline` of one point renders as nothing, so
 * the view draws a dot. Dropping them here was the first version and it was
 * wrong in the same direction as everything else this file guards against: an
 * isolated burst of real measurements disappeared from the chart entirely.
 */
export function sparklineSegments(
  samples: readonly HealthSample[],
  range: WindowRange,
  size: SparklineSize,
  buckets = 120,
): readonly (readonly Point[])[] {
  if (samples.length === 0 || buckets < 1) return [];

  const start = new Date(range.from).getTime();
  const end = new Date(range.to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const sums = new Array<number>(buckets).fill(0);
  const hits = new Array<number>(buckets).fill(0);

  for (const sample of samples) {
    const at = new Date(sample.startedAt).getTime();
    if (!Number.isFinite(at) || at < start || at > end) continue;
    const slot = Math.min(buckets - 1, Math.floor(((at - start) / (end - start)) * buckets));
    sums[slot] = (sums[slot] ?? 0) + sample.value;
    hits[slot] = (hits[slot] ?? 0) + 1;
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let slot = 0; slot < buckets; slot += 1) {
    const count = hits[slot] ?? 0;
    if (count === 0) continue;
    const mean = (sums[slot] ?? 0) / count;
    if (mean < min) min = mean;
    if (mean > max) max = mean;
  }
  if (!Number.isFinite(min)) return [];

  // A perfectly flat run is drawn down the middle rather than at the top or
  // the bottom, so it cannot be misread as a floor or a ceiling.
  const span = max - min;
  const segments: Point[][] = [];
  let current: Point[] = [];

  for (let slot = 0; slot < buckets; slot += 1) {
    const count = hits[slot] ?? 0;
    if (count === 0) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    const mean = (sums[slot] ?? 0) / count;
    const fraction = span === 0 ? 0.5 : (mean - min) / span;
    current.push({
      x: (slot / Math.max(1, buckets - 1)) * size.width,
      // SVG y grows downward; the biggest value belongs at the top.
      y: size.height - fraction * size.height,
    });
  }
  if (current.length > 0) segments.push(current);

  return segments;
}

export function pointsAttribute(segment: readonly Point[]): string {
  return segment.map((point) => `${round(point.x)},${round(point.y)}`).join(" ");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------ formatting --- */

/**
 * Thousands separators, without `toLocaleString`.
 *
 * The admin is read beside a terminal and beside the wire, and a count that
 * renders `29 962` on one machine and `29,962` on another is a count two people
 * cannot compare over a call.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const negative = value < 0;
  const digits = Math.abs(Math.trunc(value)).toString();
  let grouped = "";
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ",";
    grouped += digits[index];
  }
  return negative ? `-${grouped}` : grouped;
}

/** A measurement, at a precision that does not invent significance. */
export function formatValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  const sign = rounded < 0 ? "-" : "";
  const magnitude = Math.abs(rounded);
  const whole = Math.trunc(magnitude);
  const tenths = Math.round((magnitude - whole) * 10);
  const decimals = tenths === 0 ? "" : `.${String(tenths)}`;
  return `${sign}${formatCount(whole)}${decimals} ${unit}`;
}

/**
 * The one-line verdict above the whole page.
 *
 * Counts types by what quiet means for them, because "3 of 7 types have data"
 * is the sentence that hides the bug: it says nothing about whether the other
 * four are quiet or unlooked-at.
 */
export interface FleetSummary {
  readonly total: number;
  /** Types with samples in this window. */
  readonly flowing: number;
  /** Authorised and empty — genuinely nothing happened. */
  readonly measuredZero: number;
  /**
   * Empty, and the quiet proves nothing. Never counted as "no data".
   *
   * **Excludes {@link unpublished}**, which is the one empty case where the
   * quiet does prove something — just not about him.
   */
  readonly notLooked: number;
  /** Empty because nothing has ever published them. Not a permission problem. */
  readonly unpublished: number;
  readonly failed: number;
}

export function summariseTypes(loads: readonly TypeLoad[]): FleetSummary {
  let flowing = 0;
  let measuredZero = 0;
  let notLooked = 0;
  let unpublished = 0;
  let failed = 0;

  for (const load of loads) {
    switch (readingOf(load)) {
      case "samples":
        flowing += 1;
        break;
      case "measuredZero":
        measuredZero += 1;
        break;
      case "notLooked":
        // Counted apart, because the headline is where the useless advice
        // starts: a type nothing publishes lumped in with "quiet proves
        // nothing" sends him looking for a permission to fix.
        if (load.series?.unpublished == null) notLooked += 1;
        else unpublished += 1;
        break;
      default:
        failed += 1;
    }
  }

  return { total: loads.length, flowing, measuredZero, notLooked, unpublished, failed };
}

export function fleetHeadline(summary: FleetSummary): string {
  const parts = [`${String(summary.flowing)} of ${String(summary.total)} types have data here`];
  if (summary.measuredZero > 0) {
    parts.push(`${String(summary.measuredZero)} authorised and quiet`);
  }
  if (summary.notLooked > 0) {
    // Deliberately never phrased as "no data" and never as "not authorised".
    // The commonest state here is `undisclosed`, where the honest claim is
    // narrower than either: we do not know what the quiet means.
    parts.push(`${String(summary.notLooked)} whose quiet proves nothing`);
  }
  if (summary.unpublished > 0) {
    parts.push(`${String(summary.unpublished)} nothing publishes`);
  }
  if (summary.failed > 0) parts.push(`${String(summary.failed)} could not be asked`);
  return `${parts.join(" · ")}.`;
}

export function fleetTone(summary: FleetSummary): Tone {
  if (summary.failed > 0) return "fail";
  if (summary.notLooked > 0) return "warn";
  return "ok";
}
