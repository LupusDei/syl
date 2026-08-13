import { startOfLocalDay } from "../harness/schedule.js";
import { instant, systemClock, type Clock } from "../services/clock.js";
import type { Database } from "../services/sqlite.js";

import { HEALTH_TYPES, type HealthType } from "./contract.js";
import { DAILY_SUMMARY, dayOf, shiftDay } from "./derive.js";

/**
 * The 60-day downsample: full resolution near, daily aggregates far.
 *
 * `syl-t9tj.2.7` (T011). The Commander's ruling, 2026-08-12: *"Keep it stored
 * 60 days? Seems fair."*
 *
 *
 * ## CONSTRAINT 6 DOES NOT BIND MEASUREMENTS, and this file is where a reader
 * ## will come looking for the exception
 *
 * The never-delete rule is written down everywhere else in this codebase, so
 * the next person to read a `DELETE FROM` here will reach for it. It does not
 * apply, and the reason is not a loophole:
 *
 * > *"The SYSTEM never deletes an inferred edge. It demotes it."* protects
 * > **what he told her.** A heart-rate sample is not that.
 *
 * A memory is a claim: it was asserted once, by him, and if it is destroyed
 * there is no other copy of the assertion anywhere. A measurement is not a
 * claim, it is a *number a sensor produced*, and collapsing 1,440 of them into
 * a mean and a total forgets nothing that was ever known — the mean is the same
 * mean. Nothing anybody said is lost, because nobody said anything.
 *
 * What still binds, and is the actual content of the rule: a **conclusion**
 * drawn from these rows is a memory, lives in the graph, decays in confidence
 * and is never deleted by any automatic path. Nothing this job destroys can
 * destroy one of those, because a conclusion carries its own reasoning text and
 * holds no pointer to a sample row — see `remember.ts` and
 * `0032_health_observations.sql`.
 *
 * The other half of the argument is arithmetic. The table grows on the order of
 * **50,000 rows a week**, forever, on a machine in his house. Retention is not
 * tidiness here; it is the difference between a store that works in year three
 * and one that does not.
 *
 *
 * ## An aggregate is an OBSERVATION, which is why it stays in this table
 *
 * A downsample is the same measurement at coarser resolution, not an
 * interpretation of one. So it belongs in `health_samples` beside the rows it
 * replaces, rather than with the derivations — which are interpretations, and
 * which `derive.ts` refuses to persist for exactly that reason.
 *
 * An aggregate row is an ordinary sample and is valid under every CHECK the
 * table carries: it spans the local day it summarises, it carries the type's
 * own unit, and it is identified like anything else. What marks it is its
 * source, {@link DOWNSAMPLED_SOURCE} — a name no device can produce, because
 * `syl:` is this system's own id namespace.
 *
 * **Per-source detail is what is actually lost**, and it is worth naming: a day
 * whose heart rate came from both a watch and a phone becomes one number. That
 * is what "daily aggregate" means and it is not recoverable. Inside sixty days
 * nothing is folded, which is the window every derivation actually uses.
 *
 *
 * ## Idempotent, and safe to run twice — by construction rather than by a flag
 *
 * There is no "already downsampled" column and no watermark. The job is a
 * **fixed point**: aggregating a day that holds exactly one aggregate row
 * produces that same row, with the same identity
 * `(type, day start, day end, "syl:daily")`, so a second pass writes the value
 * it already had and deletes nothing. That is a stronger guarantee than a flag,
 * which can be true while the rows it describes are not.
 *
 * One case is imprecise and is documented rather than hidden: if history older
 * than sixty days arrives **after** that day has already been folded — a new
 * device backfilling a year — the day then holds an aggregate plus raw rows,
 * and re-folding treats the aggregate as one measurement beside them. For a
 * `total` type that is exactly right (the sum of the old sum and the new rows
 * is the true sum). For a `mean` type it under-weights the folded half. The
 * alternative — keeping a sample count per row — is a column on 50,000-row-a-
 * week table to correct an error that requires a backfill of year-old data into
 * an already-folded day.
 */

/**
 * How long full resolution is kept. His ruling.
 *
 * Days rather than an instant, and counted in HIS days: the boundary is a
 * calendar edge, so a sample either belongs to a folded day or it does not, and
 * nothing sits half-inside.
 */
export const DEFAULT_RETENTION_DAYS = 60;

/**
 * The source an aggregate row carries.
 *
 * `syl:` because that is this system's own id namespace and no HealthKit source
 * name can collide with it — the phone sends "Apple Watch", "iPhone",
 * "Withings". A `source` is part of a sample's identity, so this is also what
 * makes the fold a fixed point.
 */
export const DOWNSAMPLED_SOURCE = "syl:daily";

/** Whether a row is one of ours. The one predicate; never a `startsWith`. */
export function isAggregate(source: string): boolean {
  return source === DOWNSAMPLED_SOURCE;
}

/**
 * The most days one pass will fold.
 *
 * A bound rather than a limit: the first pass on a machine that has been
 * collecting for a year has a year of days to walk, and a nightly job that
 * holds `JobRunner`'s single lease for minutes is a nightly job that delays a
 * reminder. Whatever is left is folded by the next pass, and the fold is a
 * fixed point so there is no state to carry between them.
 */
export const MAX_DAYS_PER_PASS = 400;

export interface DownsampleInput {
  readonly db: Database;
  /** IANA, never a fixed offset. Days are HIS days. Constraint 5. */
  readonly tz: string;
  readonly clock?: Clock;
  readonly retentionDays?: number;
}

export interface DownsampleOutcome {
  /** Local days folded this pass. Zero is the ordinary answer once caught up. */
  readonly daysFolded: number;
  /** Rows destroyed. */
  readonly samplesReplaced: number;
  /** Aggregate rows written or rewritten. */
  readonly aggregatesWritten: number;
  /** The oldest day still held at full resolution, `YYYY-MM-DD`. */
  readonly fullResolutionFrom: string;
  /** True when the pass stopped at {@link MAX_DAYS_PER_PASS} with work left. */
  readonly more: boolean;
}

interface RangeRow {
  readonly type: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly value: number;
  readonly source: string;
}

/**
 * Fold everything older than the retention window into one row per type per day.
 *
 * One transaction for the whole pass: a half-folded day would hold an aggregate
 * beside the rows it summarises, and every mean drawn from that day would be
 * wrong in a way nothing could detect afterwards.
 */
export function downsampleHealth(input: DownsampleInput): DownsampleOutcome {
  const clock = input.clock ?? systemClock;
  const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(
      `Retention must be a positive whole number of days, got ${String(retentionDays)}. ` +
        `Zero would fold today's measurements before the day it is about has finished.`,
    );
  }

  const now = clock();
  const today = dayOf(now, input.tz);
  // Inclusive: everything from this day forward keeps full resolution, so the
  // window is `retentionDays` days ending today.
  const keepFrom = shiftDay(today, -(retentionDays - 1));
  const keepFromInstant = instant(startOfLocalDay(keepFrom, input.tz).getTime());

  const oldest = input.db
    .prepare("SELECT min(started_at) AS at FROM health_samples WHERE started_at < ?")
    .get(keepFromInstant);
  const oldestAt = (oldest as unknown as { at: string | null } | undefined)?.at ?? null;
  if (oldestAt === null) {
    return {
      daysFolded: 0,
      samplesReplaced: 0,
      aggregatesWritten: 0,
      fullResolutionFrom: keepFrom,
      more: false,
    };
  }

  const select = input.db.prepare(
    `SELECT type, started_at, ended_at, value, source FROM health_samples
      WHERE started_at >= ? AND started_at < ?
      ORDER BY type, started_at`,
  );
  const remove = input.db.prepare(
    "DELETE FROM health_samples WHERE type = ? AND started_at >= ? AND started_at < ?",
  );
  const write = input.db.prepare(
    `INSERT INTO health_samples (type, started_at, ended_at, value, source, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (type, started_at, ended_at, source)
       DO UPDATE SET value = excluded.value, recorded_at = excluded.recorded_at`,
  );

  const recordedAt = instant(now);
  let daysFolded = 0;
  let samplesReplaced = 0;
  let aggregatesWritten = 0;
  let day = dayOf(Date.parse(oldestAt), input.tz);
  let more = false;
  let walked = 0;

  input.db.exec("BEGIN IMMEDIATE");
  try {
    while (day < keepFrom) {
      if (walked >= MAX_DAYS_PER_PASS) {
        more = true;
        break;
      }
      walked += 1;

      const next = shiftDay(day, 1);
      const from = instant(startOfLocalDay(day, input.tz).getTime());
      const to = instant(startOfLocalDay(next, input.tz).getTime());

      const rows = select.all(from, to).map((row) => row as unknown as RangeRow);
      if (rows.length > 0) {
        const byType = new Map<HealthType, RangeRow[]>();
        for (const row of rows) {
          const type = row.type as HealthType;
          const bucket = byType.get(type);
          if (bucket === undefined) byType.set(type, [row]);
          else bucket.push(row);
        }

        let foldedAnything = false;
        for (const type of HEALTH_TYPES) {
          const bucket = byType.get(type);
          if (bucket === undefined || bucket.length === 0) continue;

          // Already a fixed point: one row, ours, spanning exactly this day.
          // Skipped rather than rewritten so a caught-up store does no writes
          // at all — which is what makes "safe to run twice" also mean "cheap
          // to run twice".
          const only = bucket[0];
          if (
            bucket.length === 1 &&
            only !== undefined &&
            isAggregate(only.source) &&
            only.started_at === from &&
            only.ended_at === to
          ) {
            continue;
          }

          let total = 0;
          for (const row of bucket) total += row.value;
          const value = DAILY_SUMMARY[type] === "total" ? total : total / bucket.length;

          samplesReplaced += Number(remove.run(type, from, to).changes);
          write.run(type, from, to, value, DOWNSAMPLED_SOURCE, recordedAt);
          aggregatesWritten += 1;
          foldedAnything = true;
        }
        if (foldedAnything) daysFolded += 1;
      }

      day = next;
    }

    input.db.exec("COMMIT");
  } catch (cause) {
    try {
      input.db.exec("ROLLBACK");
    } catch {
      // The transaction was already gone. The original failure is the one worth
      // reporting, and swallowing this keeps it visible.
    }
    throw cause;
  }

  return {
    daysFolded,
    samplesReplaced,
    aggregatesWritten,
    fullResolutionFrom: keepFrom,
    more,
  };
}
