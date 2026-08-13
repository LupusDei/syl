import { HEALTH_TYPES, silenceIsEvidence, type AuthorisationState, type HealthType } from "./contract.js";
import { derive, type SeriesDerivation } from "./derive.js";
import type { HealthSample, HealthSamples } from "./samples.js";

/**
 * His health, small enough to put in front of her mid-conversation.
 *
 * `syl-t9tj.5.4`. The nightly review already derives all of this — but it does it
 * on the consolidation lane, at 03:00, for its own purposes. **She had no way to
 * look while he was talking to her**, so when he asked about his health she said,
 * correctly, that she could not see it. Two months of his data on disk and no
 * verb pointing at it.
 *
 *
 * ## Why this returns DERIVATIONS and never samples
 *
 * There are 28,726 heart-rate readings in the store. A verb that handed her rows
 * would either blow the turn's context or return an arbitrary slice of it, and an
 * arbitrary slice is worse: she would answer confidently from whichever fortnight
 * happened to fit. So the answer is the same shape the review gets — his own
 * baseline, what changed against it, and how unusual that is.
 *
 * It also means the astrology defence holds here too, and for the same structural
 * reason rather than a second copy of the rule: there is no weekday breakdown and
 * no absolute-level dump in this payload, so "he walks more at weekends" is not
 * available to be said. The shape of the input is the guard.
 *
 *
 * ## `silenceIsEvidence` travels with every type, and it is the point
 *
 * An empty series means two completely different things and only the
 * authorisation report can tell them apart. **`authorised` and empty** means
 * nothing happened — she may say "you took no steps this week". Anything else
 * means *we never looked*, and the honest sentence is "I have never been able to
 * see your heart rate variability".
 *
 * Saying the first when the second is true is a claim about his body drawn from a
 * permission dialog. That is the failure this whole feature was built around, so
 * the flag rides on every entry rather than being something she is trusted to
 * remember.
 */

/** One type, as she is shown it. */
export interface HealthDigest {
  readonly type: HealthType;
  readonly unit: string;
  /** What the phone last said about being allowed to read this. */
  readonly authorisation: AuthorisationState | null;
  /**
   * Whether an absence of numbers here is a fact about HIM.
   *
   * False means we did not look. She must not report a gap as a behaviour.
   */
  readonly silenceIsEvidence: boolean;
  /** Days with a figure, across the whole lookback. */
  readonly days: number;
  /** Set when she computed this rather than a device reporting it. */
  readonly derivedFrom: HealthType | null;
  readonly recent: SeriesDerivation["recent"];
  readonly baseline: SeriesDerivation["baseline"];
  readonly deviation: SeriesDerivation["deviation"];
  readonly run: SeriesDerivation["run"];
  readonly latest: SeriesDerivation["latest"];
}

export interface HealthSummary {
  readonly window: ReturnType<typeof derive>["window"];
  readonly recentDays: number;
  readonly baselineDays: number;
  /** Only the types asked for, in {@link HEALTH_TYPES} order. */
  readonly types: readonly HealthDigest[];
  /** True when at least one requested type has a measurement. */
  readonly anyMeasurement: boolean;
}

export interface SummariseInput {
  readonly samples: HealthSamples;
  readonly now: number;
  readonly tz: string;
  /**
   * Which types to answer about. Empty or absent means all of them.
   *
   * The filter exists because he asked for it, and because "how have I been
   * sleeping" should not cost her a paragraph about his step count. Narrowing
   * the question narrows the answer.
   */
  readonly types?: readonly HealthType[];
  readonly recentDays?: number;
  readonly baselineDays?: number;
  /** Rows read per type before deriving. A bound, not a page. */
  readonly limit?: number;
}

/** How many rows one type contributes to a derivation. */
export const SUMMARY_SERIES_LIMIT = 20_000;

export function summariseHealth(input: SummariseInput): HealthSummary {
  const recentDays = input.recentDays;
  const baselineDays = input.baselineDays;

  // A day either side of the nominal window, because a UTC range does not line
  // up with a local one — the same reasoning `HealthReview` uses, and the same
  // asymmetry: over-reading is discarded by `derive`, under-reading truncates a
  // baseline silently.
  const lookback = (recentDays ?? 7) + (baselineDays ?? 28) + 2;
  const from = new Date(input.now - lookback * 24 * 60 * 60_000).toISOString();

  const wanted =
    input.types === undefined || input.types.length === 0
      ? HEALTH_TYPES
      : HEALTH_TYPES.filter((type) => input.types?.includes(type));

  const series: Partial<Record<HealthType, readonly HealthSample[]>> = {};
  const authorisation: Partial<Record<HealthType, AuthorisationState>> = {};
  const reported = input.samples.authorisation();

  // Read only what was asked for. Deriving the other six to throw them away is
  // the kind of waste that stops being free at fifty thousand rows.
  for (const type of wanted) {
    series[type] = input.samples.series({
      type,
      from,
      limit: input.limit ?? SUMMARY_SERIES_LIMIT,
    });
    const record = reported[type];
    if (record !== undefined) authorisation[type] = record.state;
  }

  const derived = derive({
    series,
    authorisation,
    now: input.now,
    tz: input.tz,
    ...(recentDays === undefined ? {} : { recentDays }),
    ...(baselineDays === undefined ? {} : { baselineDays }),
  });

  const chosen = new Set<HealthType>(wanted);
  const types = derived.series
    .filter((entry) => chosen.has(entry.type))
    .map((entry): HealthDigest => {
      const state = authorisation[entry.type] ?? null;
      return {
        type: entry.type,
        unit: entry.unit,
        authorisation: state,
        // Read through the contract's own function rather than re-deriving the
        // rule. Written as `state === "authorised"` in two places, the two
        // drift, and the one that drifts is the one that lets her narrate a
        // permission dialog as a fact about his body.
        silenceIsEvidence: state === null ? false : silenceIsEvidence(state),
        days: entry.days.length,
        derivedFrom: entry.derivedFrom,
        recent: entry.recent,
        baseline: entry.baseline,
        deviation: entry.deviation,
        run: entry.run,
        latest: entry.latest,
      };
    });

  return {
    window: derived.window,
    recentDays: derived.recentDays,
    baselineDays: derived.baselineDays,
    types,
    anyMeasurement: types.some((entry) => entry.days > 0),
  };
}
