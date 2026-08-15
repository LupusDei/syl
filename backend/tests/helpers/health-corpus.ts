import {
  HEALTH_TYPES,
  type AuthorisationState,
  type HealthSampleInput,
  type HealthType,
} from "../../src/health/contract.js";
import { HealthSamples } from "../../src/health/samples.js";

/**
 * A corpus HIS SIZE, because the defect this fixture exists to catch was
 * measured on a fixture and missed on a machine.
 *
 * `syl-8ys9.2.3`. `SUMMARY_SERIES_LIMIT` was set to 20,000 rows per type
 * without anyone timing what honouring it cost. Against a handful of rows the
 * summary path is instant and every test agreed; against the 61,030 samples on
 * his machine it took **8.675 seconds**, on a verb Syl calls mid-conversation.
 * A fixture of ten samples cannot tell those apart, so the timing test has to
 * seed something the shape of his real store or it is measuring nothing.
 *
 *
 * ## The numbers are his, counted on 2026-08-13
 *
 *     steps 29,962 · heartRate 28,726 · sleep 2,336 · workout 6
 *     restingHeartRate 0 · heartRateVariability 0 · bodyMass 0
 *
 * over roughly two months — so {@link HIS_SHAPE} is those totals divided by 62
 * days. The three empty types are empty here too, and deliberately: two of them
 * are empty because **Oura does not publish them** (`syl-8ys9`), and a
 * derivation path that is only ever exercised against full series would never
 * meet the branch that estimates resting heart rate from raw heart rate.
 *
 *
 * ## The values carry fractions ON PURPOSE
 *
 * A corpus of small integers makes every sum exact, which would hide the one
 * arithmetic difference that actually bites: SQLite's `sum()` is compensated
 * (Kahan-Babuska-Neumaier) and a naive `+=` in JavaScript is not, so the two
 * disagree in the last bits over a day of readings. `derive.ts` sums the same
 * way SQLite does for exactly that reason, and a corpus of round numbers would
 * let that agreement rot without a test noticing.
 */
export const HIS_SHAPE: Readonly<Partial<Record<HealthType, number>>> = {
  steps: 484,
  heartRate: 464,
  sleep: 38,
  workout: 1,
};

const DAY_MS = 86_400_000;

export interface CorpusOptions {
  /** The instant the corpus ends at. The newest sample is just before it. */
  readonly now: number;
  /** How many days back to fill. */
  readonly days?: number;
  /** Samples per day per type. Defaults to {@link HIS_SHAPE}. */
  readonly perDay?: Readonly<Partial<Record<HealthType, number>>>;
  /** Every type's authorisation. Defaults to `authorised` for all fourteen. */
  readonly authorisation?: Readonly<Partial<Record<HealthType, AuthorisationState>>>;
}

/**
 * A deterministic pseudo-random stream.
 *
 * Not `Math.random`: a timing test that fails needs to be reproducible, and a
 * correctness test that compares two derivations of the same corpus needs the
 * corpus to be the same corpus on the second run.
 */
function stream(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32 — small, deterministic, and good enough to spread values.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4_294_967_296;
  };
}

/** Plausible readings per type, with fractions. See the note above. */
function valueFor(type: HealthType, random: () => number): number {
  switch (type) {
    case "heartRate":
      return 48 + random() * 72;
    case "steps":
      return Math.round(random() * 60) + random();
    case "sleep":
      return 4 + random() * 26;
    case "workout":
      return 15 + random() * 60;
    default:
      return 1 + random() * 99;
  }
}

/**
 * Fill a store with a corpus the shape of his.
 *
 * @returns how many samples were written.
 */
export function seedHealthCorpus(health: HealthSamples, options: CorpusOptions): number {
  const days = options.days ?? 62;
  const perDay = options.perDay ?? HIS_SHAPE;
  const random = stream(0x571ec7);
  let written = 0;

  for (let back = days - 1; back >= 0; back -= 1) {
    const endsAt = options.now - back * DAY_MS;
    const batch: HealthSampleInput[] = [];
    for (const type of HEALTH_TYPES) {
      const count = perDay[type] ?? 0;
      for (let index = 0; index < count; index += 1) {
        // Spread across the day rather than clustered, so the local-day
        // bucketing is actually exercised at both edges.
        const at = new Date(endsAt - Math.floor((index * DAY_MS) / count)).toISOString();
        batch.push({
          type,
          startedAt: at,
          endedAt: at,
          value: valueFor(type, random),
          source: "Oura",
        });
      }
    }
    written += batch.length;
    // The store refuses more than MAX_SAMPLES_PER_APPEND in one call, which is
    // itself the shape a real backfill arrives in.
    for (let i = 0; i < batch.length; i += 2_000) {
      health.append({ samples: batch.slice(i, i + 2_000) });
    }
  }

  const report: Partial<Record<HealthType, AuthorisationState>> = {};
  for (const type of HEALTH_TYPES) report[type] = options.authorisation?.[type] ?? "authorised";
  // Safe assertion: the loop above visits every member of HEALTH_TYPES.
  health.recordAuthorisation(report as Record<HealthType, AuthorisationState>);

  return written;
}
