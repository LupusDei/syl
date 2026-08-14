import { HEALTH_TYPES, silenceIsEvidence, type AuthorisationState, type HealthType } from "./contract.js";
import { derivationSpan, derive, type SeriesDerivation } from "./derive.js";
import type { HealthSamples } from "./samples.js";

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
 *
 *
 * ## IT ANSWERS MID-CONVERSATION, SO ITS COST IS BOUNDED BY DAYS AND NOT SAMPLES
 *
 * `syl-8ys9.2.2`, closing `syl-6ig6`. This file shipped reading up to 20,000
 * raw rows per type through `series()` and handing them to `derive()` to
 * bucket. The cap was a number chosen without a stopwatch, which is the entire
 * defect: against a fixture it was instant, and against his real store —
 * 61,030 samples, fourteen types — the verb took **8.675 seconds**. Nine
 * seconds of silence before she can answer *"how have I been sleeping"* is not
 * a slow endpoint, it is her appearing to hang, and the tool timeout is the
 * next thing it meets.
 *
 * So the summary asks the store for `daily()` — the same rows, reduced to one
 * per local day inside SQLite — and hands those to `derive()`. Nothing this
 * file reports is finer than a day, so nothing is lost, and the read is now
 * ~37 rows per type instead of up to 20,000. Measured on a corpus his size:
 * 3,255ms to 62ms of query time.
 *
 * **There is no row limit here any more, and its absence is the fix.** A cap
 * exists to stop an unbounded read; this read is bounded by the WINDOW, which
 * is 35 days whatever his history is. A limit would now be a way to truncate a
 * baseline silently, which is the failure the old one was quietly causing —
 * 20,000 heart-rate rows is a fortnight of his data, not the five weeks the
 * baseline claims to cover.
 *
 * The nightly review still reads raw rows (`review.ts`), on purpose: it runs at
 * 03:00 on the consolidation lane, where eight seconds costs nothing, and it is
 * the path that would notice if the two ever stopped agreeing.
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
}

export function summariseHealth(input: SummariseInput): HealthSummary {
  const recentDays = input.recentDays;
  const baselineDays = input.baselineDays;
  const window = {
    now: input.now,
    tz: input.tz,
    ...(recentDays === undefined ? {} : { recentDays }),
    ...(baselineDays === undefined ? {} : { baselineDays }),
  };

  // Ask `derive` which days it is going to keep, rather than computing a
  // lookback beside it. The old code here had its own `recent + baseline + 2`
  // with a comment explaining the two spare days, and so did `review.ts`; a
  // window written down twice is a window that eventually disagrees, in the
  // direction that truncates a baseline without saying so.
  const span = derivationSpan(window);

  const wanted =
    input.types === undefined || input.types.length === 0
      ? HEALTH_TYPES
      : HEALTH_TYPES.filter((type) => input.types?.includes(type));

  // Read only what was asked for. Deriving the other thirteen to throw them
  // away is the kind of waste that stops being free at sixty thousand rows.
  const days = input.samples.daily({
    types: wanted,
    from: span.baselineFrom,
    to: span.today,
    tz: input.tz,
  });

  const authorisation: Partial<Record<HealthType, AuthorisationState>> = {};
  const reported = input.samples.authorisation();
  for (const type of wanted) {
    const record = reported[type];
    if (record !== undefined) authorisation[type] = record.state;
  }

  const derived = derive({
    // Every requested type is named, including the ones with nothing, so
    // `derive` never falls back to looking for raw rows that were not read.
    // An absent key means "no aggregate given"; an empty array means "no days",
    // and only the second is true here.
    days: Object.fromEntries(wanted.map((type) => [type, days[type] ?? []])),
    authorisation,
    ...window,
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
