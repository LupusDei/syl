import { HEALTH_TYPES, silenceIsEvidence, type AuthorisationState, type HealthType } from "./contract.js";
import { derivationSpan, derive, shiftDay, type DailyStat, type SeriesDerivation } from "./derive.js";
import type { DailyQuery, DailyByType, HealthSamples, Watermarks } from "./samples.js";
import type { AuthorisationReport } from "./samples.js";

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

/* ---------------------------------------------- the unavailable judgement --- */

/**
 * ## THE JUDGEMENT NO CLIENT CAN MAKE
 *
 * `syl-8ys9.3.1`. `restingHeartRate` and `heartRateVariability` are reported by
 * his phone as **`denied`**, and they are not denied. **Oura does not publish
 * either type to Apple Health** — established from his own screenshot of Oura's
 * permission list, where both are simply absent between the types that bracket
 * them alphabetically. So the label blames *his permissions* for *a vendor's
 * integration gap*, and every sentence downstream inherits it: she would say
 * "you have no HRV", which is a claim about his body. The true sentence is
 * "your ring does not publish HRV", which is a claim about his equipment.
 *
 * `HKHealthStore.isHealthDataAvailable()` answers **device-wide, never per
 * type**, so the phone cannot tell a source that does not carry a type from a
 * type he declined — the iOS side established that and correctly refused to
 * invent a detector for it. The server can see one thing no client can: a type
 * that has **never once arrived** across weeks in which the same source
 * delivered everything else.
 *
 * That is an inference rather than a reading, so it arrives carrying what it
 * was drawn from ({@link UnpublishedFinding}) — the same discipline every other
 * inference in this system carries.
 *
 *
 * ## THE STATED CONDITION IS UNREACHABLE, AND THAT IS A FINDING RATHER THAN A
 * ## DEVIATION
 *
 * The epic asks for *`authorised` + zero samples + a long authorised window*.
 * Two of those three cannot be had, and both matter:
 *
 * 1. **There is no authorised window to measure.** `health_authorisation` holds
 *    ONE row per type and `append` overwrites `reported_at` on every upload, so
 *    that column is "when the phone last spoke", not "since when". On his live
 *    store every type's `reported_at` is the same instant — today's upload.
 *    Elapsed-authorisation is not a quantity this schema can answer, so the
 *    window here is measured in **his data** instead: the days on which the
 *    source demonstrably delivered while this type did not.
 * 2. **`authorised` + never-a-sample is a contradiction on iOS.** `authorised`
 *    is minted only by a sample actually coming back — it is the platform's one
 *    positive proof — and remembered in a ledger that never expires. A type that
 *    has never produced a sample therefore *cannot* be reported `authorised`;
 *    what it is reported as is `undisclosed`, or, from a build old enough,
 *    `denied`. Waiting for `authorised` would be waiting forever.
 *
 * So the judgement speaks wherever the phone's report leaves "nothing has ever
 * arrived" **unexplained**, and stays silent where it is already explained:
 * `notDetermined` means he has never been asked, which accounts for the silence
 * completely and has a real remedy; `unavailable` has already said it; and no
 * report at all is a different missing fact — we have not been told whether we
 * may look — that this inference has no standing over.
 *
 *
 * ## THREE CONDITIONS, EACH ANSWERING A WAY OF BEING WRONG
 *
 * 1. **Not one sample, ever** — the watermark over ALL time, not over the
 *    window. This is what separates a source that does not carry a type from a
 *    grant that was revoked after it worked: revocation after proof is
 *    undetectable (the contract says so), the samples simply stop, and history
 *    from before it stays on disk. A type with a watermark has been published at
 *    least once, so the source demonstrably carries it, whatever it is doing
 *    now.
 * 2. **Corroboration** — {@link CORROBORATED_DAYS} distinct days inside the
 *    window on which some *other* type produced a figure. This is the answer to
 *    the objection that matters: a type can be silent for sixty days because the
 *    ring spent them in a drawer. When the ring is off, everything is silent,
 *    there is nothing to corroborate against, and the judgement declines to
 *    speak. Silence only means something beside data.
 * 3. **Recency** — that corroboration reaches within {@link
 *    CORROBORATION_STALE_DAYS} of today. A store that stopped hearing from the
 *    phone a fortnight ago cannot tell a type that never arrives from a phone
 *    that no longer uploads.
 *
 *
 * ## WHAT IT DOES NOT ESTABLISH, SAID PLAINLY
 *
 * It cannot separate "no source publishes this" from "he refused read access",
 * because on this platform nothing can — `undisclosed` is precisely that union.
 * What it establishes is narrower and still worth saying: **nothing has ever
 * written this type to Health**, while everything else was arriving. Both
 * "you have no HRV" and "go and grant the permission" are wrong as the leading
 * sentence, and {@link UnpublishedFinding.because} names both remaining causes
 * rather than picking one.
 */

/**
 * Distinct days the source must have delivered on before the inference speaks.
 *
 * **Twenty-one out of the thirty-five-day derivation window**, and the number is
 * a trade between two failures the Commander should be able to check:
 *
 * - **Too short** and a type he authorised this morning reads as unpublishable.
 *   One day of upload must never be enough; a fresh install with three days of
 *   history says nothing, because a type that reports weekly has not had its
 *   turn yet.
 * - **Too long** and he waits weeks for an honest answer while the screen goes
 *   on blaming his permissions.
 *
 * Twenty-one is three weeks of *his data's own calendar*, which is not the same
 * as three weeks of waiting: a cold backfill lands sixty days at once, so a new
 * install reaches this threshold as soon as it has uploaded, not a fortnight
 * later. What the number really buys is that the source has been in continuous
 * service long enough for anything it publishes weekly — body mass, VO₂ max —
 * to have appeared at least twice.
 *
 * It is also cheap to be wrong in one direction and not the other: the finding
 * is computed from the store on every read and stored nowhere, so **the first
 * sample that ever arrives retracts it**, permanently and without a migration.
 */
export const CORROBORATED_DAYS = 21;

/**
 * How stale the corroborating data may be and still corroborate anything.
 *
 * Two days. Beyond that the phone has stopped uploading, and a store that is not
 * being told anything cannot conclude that nothing is being published — it would
 * be reporting its own silence as a fact about his equipment.
 */
export const CORROBORATION_STALE_DAYS = 2;

/**
 * The states the judgement may override.
 *
 * Written as an explicit list rather than as exclusions, for the reason
 * `silenceIsEvidence` gives: a state added to the contract later must have to be
 * *considered* here rather than inheriting a behaviour by default. `authorised`
 * is on it because the epic named that case, even though iOS cannot produce it
 * alongside an empty watermark; if some future client does, "nothing has ever
 * published this" is still the true sentence, and moving it off `authorised`
 * only ever narrows what silence licenses.
 */
const OVERRIDABLE: readonly AuthorisationState[] = ["authorised", "denied", "undisclosed"];

/**
 * Why the server overrode the phone's report for one type.
 *
 * Every field is grounds. A reader who disagrees with the conclusion has, in
 * this object, exactly what it was drawn from — which is the difference between
 * an inference and an assertion.
 */
export interface UnpublishedFinding {
  readonly type: HealthType;
  /**
   * What the phone actually reported.
   *
   * Carried, never destroyed. The store still holds it and this is the label the
   * inference argued with; erasing it would leave nothing to check the
   * inference against.
   */
  readonly reported: AuthorisationState;
  /** First local day examined, `YYYY-MM-DD` in his zone. */
  readonly from: string;
  /** Last local day examined. */
  readonly to: string;
  /** Days in that window on which some other type produced a figure. */
  readonly corroboratedDays: number;
  /** Which types were arriving while this one never has, in contract order. */
  readonly corroboratedBy: readonly HealthType[];
  /** The grounds as a sentence, because she reasons in sentences. */
  readonly because: string;
}

export type UnpublishedFindings = Readonly<Partial<Record<HealthType, UnpublishedFinding>>>;

/**
 * The store, narrowed to what the judgement reads.
 *
 * A structural type rather than `HealthSamples` so the reader can see the whole
 * cost of this inference in one place: two single-row table reads, plus at most
 * one day-aggregate query — and that one only when there is a candidate to
 * judge. A store where every type is arriving pays nothing.
 */
export interface UnpublishedStore {
  daily(query: DailyQuery): DailyByType;
  watermarks(): Watermarks;
  authorisation(): AuthorisationReport;
}

export interface UnpublishedInput {
  readonly samples: UnpublishedStore;
  readonly now: number;
  readonly tz: string;
  /** Which types to judge. Empty or absent means all of them. */
  readonly types?: readonly HealthType[];
  /**
   * Day aggregates the caller has already read, reused rather than re-queried.
   *
   * A type present with an empty array means "read, and it had no days"; a type
   * absent means "not read". The difference is what stops a narrowed summary
   * paying for a second query it does not need.
   */
  readonly days?: DailyByType;
  readonly recentDays?: number;
  readonly baselineDays?: number;
}

/**
 * Which types nothing has ever published, and what says so.
 *
 * Returns `{}` — not a map of nulls — whenever it has nothing to say, which is
 * the common case and the cheap one.
 */
export function unpublishedTypes(input: UnpublishedInput): UnpublishedFindings {
  const span = derivationSpan({
    now: input.now,
    tz: input.tz,
    ...(input.recentDays === undefined ? {} : { recentDays: input.recentDays }),
    ...(input.baselineDays === undefined ? {} : { baselineDays: input.baselineDays }),
  });

  const marks = input.samples.watermarks();
  const report = input.samples.authorisation();
  const judged =
    input.types === undefined || input.types.length === 0
      ? HEALTH_TYPES
      : HEALTH_TYPES.filter((type) => input.types?.includes(type));

  const candidates = judged.filter((type) => {
    // Never a single sample, over all of history. See condition 1 above.
    if (marks[type] !== undefined) return false;
    const state = report[type]?.state;
    // No report at all is not a candidate: it is a different missing fact.
    return state !== undefined && OVERRIDABLE.includes(state);
  });
  if (candidates.length === 0) return {};

  // Corroborators are the types that have ever produced anything. A candidate
  // has no rows by definition, so it can neither corroborate itself nor another.
  const corroborators = HEALTH_TYPES.filter((type) => marks[type] !== undefined);
  if (corroborators.length === 0) return {};

  const known = input.days ?? {};
  const unread = corroborators.filter((type) => known[type] === undefined);
  const fetched =
    unread.length === 0
      ? {}
      : input.samples.daily({
          types: unread,
          from: span.baselineFrom,
          to: span.today,
          tz: input.tz,
        });

  const daysSeen = new Set<string>();
  const corroboratedBy: HealthType[] = [];
  let newest: string | null = null;

  for (const type of corroborators) {
    const days: readonly DailyStat[] = known[type] ?? fetched[type] ?? [];
    if (days.length === 0) continue;
    corroboratedBy.push(type);
    for (const day of days) {
      daysSeen.add(day.day);
      if (newest === null || day.day > newest) newest = day.day;
    }
  }

  if (daysSeen.size < CORROBORATED_DAYS) return {};
  if (newest === null || newest < shiftDay(span.today, -CORROBORATION_STALE_DAYS)) return {};

  const findings: Partial<Record<HealthType, UnpublishedFinding>> = {};
  for (const type of candidates) {
    // Safe assertion: `candidates` was filtered on a defined, overridable state.
    const reported = report[type]?.state as AuthorisationState;
    findings[type] = {
      type,
      reported,
      from: span.baselineFrom,
      to: span.today,
      corroboratedDays: daysSeen.size,
      corroboratedBy,
      because:
        `Not one ${type} sample has ever been held, while ${corroboratedBy.join(", ")} ` +
        `arrived on ${String(daysSeen.size)} of the days from ${span.baselineFrom} to ` +
        `${span.today}. Nothing is publishing ${type} to Health. The phone reported ` +
        `"${reported}", which on this platform cannot tell a source that does not carry a ` +
        `type from a read that was refused — so this is about what his equipment writes, ` +
        `not about his body, and no figure for it should be expected or invented.`,
    };
  }
  return findings;
}

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
  /**
   * Set when {@link authorisation} above was INFERRED rather than reported.
   *
   * Non-null means nothing has ever published this type — see
   * {@link unpublishedTypes} — and `authorisation` reads `unavailable` where the
   * phone said something else. The grounds travel with it so the claim can be
   * argued with, and {@link UnpublishedFinding.reported} keeps the label it
   * overrode.
   *
   * `restingHeartRate` carries this **and** a `derivedFrom`, and the two are not
   * in tension: his ring does not publish it, which is exactly why the quiet
   * floor of raw heart rate is the only way he will ever have that number.
   */
  readonly unpublished: UnpublishedFinding | null;
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

  // Every requested type is named, including the ones with nothing, so `derive`
  // never falls back to looking for raw rows that were not read. An absent key
  // means "no aggregate given"; an empty array means "no days", and only the
  // second is true here. Reused below, so the judgement knows which types were
  // read and empty rather than simply not read.
  const read: DailyByType = Object.fromEntries(wanted.map((type) => [type, days[type] ?? []]));

  const derived = derive({
    days: read,
    // The state the PHONE reported, unchanged. The judgement below relabels what
    // she is shown, never what `derive` reasoned over: `evidence` is `unproven`
    // for every state it could override, so the two agree, and passing an
    // inferred state into the derivation would put a conclusion where a reading
    // belongs.
    authorisation,
    ...window,
  });

  const unpublished = unpublishedTypes({
    samples: input.samples,
    now: input.now,
    tz: input.tz,
    types: wanted,
    days: read,
    ...(recentDays === undefined ? {} : { recentDays }),
    ...(baselineDays === undefined ? {} : { baselineDays }),
  });

  const chosen = new Set<HealthType>(wanted);
  const types = derived.series
    .filter((entry) => chosen.has(entry.type))
    .map((entry): HealthDigest => {
      const finding = unpublished[entry.type] ?? null;
      // The inferred label wins over the reported one, and it is the only place
      // that swap happens. `unavailable` is deliberately the state chosen for
      // it: it is the one the contract already carries whose remedy is NOT a
      // permission change, which is the whole point — telling him to grant
      // something he already granted is useless advice.
      const state = finding === null ? authorisation[entry.type] ?? null : "unavailable";
      return {
        type: entry.type,
        unit: entry.unit,
        authorisation: state,
        // Read through the contract's own function rather than re-deriving the
        // rule. Written as `state === "authorised"` in two places, the two
        // drift, and the one that drifts is the one that lets her narrate a
        // permission dialog as a fact about his body.
        //
        // Note which direction the judgement can move this: only towards false.
        // Silence from a type nothing publishes is not a fact about him, and
        // `unavailable` never licensed a conclusion in the first place.
        silenceIsEvidence: state === null ? false : silenceIsEvidence(state),
        days: entry.days.length,
        derivedFrom: entry.derivedFrom,
        unpublished: finding,
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
