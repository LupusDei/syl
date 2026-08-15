import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HEALTH_TYPES } from "../../src/health/contract.js";
import { HealthSamples } from "../../src/health/samples.js";
import { summariseHealth } from "../../src/health/summarise.js";
import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { seedHealthCorpus } from "../helpers/health-corpus.js";
import { testDatabase } from "../helpers/service.js";

/**
 * `how_has_he_been` is a verb she calls MID-CONVERSATION, and this is a
 * stopwatch rather than an assertion about a fixture.
 *
 * `syl-8ys9.2.3` (T008), closing `syl-6ig6`.
 *
 *
 * ## The defect this test exists because of
 *
 * `SUMMARY_SERIES_LIMIT` was set to 20,000 rows per type without anyone timing
 * what honouring it cost. Every test was green, because every test ran against
 * a handful of samples. On his machine — 61,030 samples, and now fourteen types
 * rather than seven — `GET /health/summary` took **8.675 seconds**.
 *
 * Nine seconds of silence before she can answer *"how have I been sleeping"* is
 * not a slow endpoint. It is her appearing to hang, and the tool timeout is the
 * next thing it meets. The nightly review can afford eight seconds on the
 * consolidation lane at 03:00; a turn he is sitting in front of cannot.
 *
 *
 * ## Which is why the corpus is his size and not a fixture's
 *
 * A cap chosen without a stopwatch is what caused this. A fix verified without
 * one would be the same mistake pointing the other way — and it would pass
 * against ten rows no matter how slow the path became afterwards. So this seeds
 * `seedHealthCorpus` at his measured shape and times the real call: the real
 * store, a real migrated database, all fourteen types, no filter.
 *
 * **It lives in `tests/acceptance/` so it runs in the heavy pass**, alone, with
 * the machine to itself. A latency budget measured beside three worker threads
 * and five thousand unit tests is measuring the fleet, not the code.
 *
 * The budget has roughly an order of magnitude of headroom over what the
 * aggregate path actually costs, which is deliberate: a timing test that sits
 * just under its own bar goes red on a busy machine and teaches everyone to
 * re-run it, and then it is not a gate.
 */

/** Under a second, and this is the number the epic is judged against. */
const BUDGET_MS = 1_000;

const NOW = Date.parse("2026-08-13T18:00:00.000Z");
const TZ = "America/Chicago";

let db: SylDatabase;
let health: HealthSamples;
let seeded = 0;

beforeAll(() => {
  db = testDatabase();
  health = new HealthSamples({ db: db.handle, clock: fixedClock(NOW) });
  seeded = seedHealthCorpus(health, { now: NOW, days: 62 });
});

afterAll(() => {
  db.close();
});

describe("how_has_he_been, against a corpus his size", () => {
  it("should be answering from a store the size of his, or it is measuring nothing", () => {
    // The guard on the guard. If the corpus ever shrinks — a helper edited, a
    // type dropped — the timing assertion below would still pass and would mean
    // nothing at all, which is exactly how the original cap survived.
    expect(seeded).toBeGreaterThan(55_000);
    expect(health.count()).toBe(seeded);
  });

  it("should answer in under a second with all fourteen types and no filter", () => {
    const runs: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      const summary = summariseHealth({ samples: health, now: NOW, tz: TZ });
      runs.push(performance.now() - started);

      expect(summary.types).toHaveLength(HEALTH_TYPES.length);
      expect(summary.anyMeasurement).toBe(true);
    }

    // EVERY run, not the best of three. A fast median with one nine-second
    // outlier is still her hanging, once, in front of him.
    const slowest = Math.max(...runs);
    expect(
      slowest,
      `slowest of ${String(runs.length)} runs was ${slowest.toFixed(0)}ms over ` +
        `${String(seeded)} samples: ${runs.map((ms) => `${ms.toFixed(0)}ms`).join(", ")}`,
    ).toBeLessThan(BUDGET_MS);
  });

  it("should answer about his heart, which is the heaviest series he has", () => {
    // `?types=` narrows the ANSWER; it must never have become the thing that
    // makes the verb affordable. Asking about the single densest type — 28,726
    // heart-rate readings, more than any other — is the worst case a filtered
    // question can reach, and it has to fit the same budget as all fourteen.
    const started = performance.now();
    const summary = summariseHealth({ samples: health, now: NOW, tz: TZ, types: ["heartRate"] });
    const elapsed = performance.now() - started;

    expect(summary.types).toHaveLength(1);
    expect(summary.types[0]?.days).toBeGreaterThan(30);
    expect(elapsed, `heartRate alone took ${elapsed.toFixed(0)}ms`).toBeLessThan(BUDGET_MS);
  });
});
