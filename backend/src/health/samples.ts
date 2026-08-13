import { instant, systemClock, type Clock } from "../services/clock.js";
import type { Database } from "../services/sqlite.js";
import {
  HEALTH_TYPES,
  isHealthType,
  unreportedTypes,
  type AuthorisationState,
  type HealthSampleInput,
  type HealthType,
} from "./contract.js";

/**
 * The observation store: measurements in, a series out, and a watermark per
 * type saying where the phone may resume.
 *
 * `syl-t9tj.2.2`. This is the bottom layer of the three the feature is built on
 * — observations, derivations, conclusions — and the only one that accumulates.
 * Read `0032_health_observations.sql` first: it carries the argument for why
 * nothing here can reach `memory_nodes`, and why constraint 6 does not bind
 * these rows.
 *
 *
 * ## Idempotence is load-bearing, not defensive
 *
 * A sample's identity is `(type, startedAt, endedAt, source)` — the contract's
 * `sampleKey`. It is deliberately NOT the request's idempotency key: that
 * guards one HTTP call, and the failure to guard against is the same measurement
 * arriving in two different calls — a retry after a lost response, a second
 * device, an app that lost its watermark and re-sent a week.
 *
 * A doubled sleep sample is a wrong average, which is a wrong baseline, which is
 * a conclusion about a pattern that does not exist, surfaced to him unprompted.
 * So {@link HealthSamples.append} reports `written` and `duplicates` separately
 * and hides neither: a re-upload that silently answered `written: 0` is
 * indistinguishable from an upload the server dropped, and the phone advances
 * its watermark on that answer.
 *
 *
 * ## Empty is not denied
 *
 * `authorisation` is a separate table and a separate read for one reason: a type
 * HealthKit was never granted reads as *empty*, not as an error. Absent, and the
 * contract's five states, are six different facts and this store keeps them six.
 * {@link HealthSamples.authorisationFor} returns `null` for a type the phone has
 * never reported on — which is not `denied`, and is the state a build too old to
 * send a report leaves behind.
 *
 * **Stored exactly as reported.** Nothing here folds `undisclosed` into
 * `denied`: `undisclosed` exists precisely because iOS cannot tell "he refused"
 * from "he granted it and there is nothing there" (`syl-m3gi`), and a server
 * that collapsed them would be destroying the distinction one layer below the
 * one that has to show it. The evidence rule does not widen with the enum —
 * `silenceIsEvidence` is still true for `authorised` alone — so a state the
 * platform could not prove simply never licenses a conclusion drawn from its
 * quiet.
 */

/** One measurement as this service holds it. */
export interface HealthSample {
  readonly type: HealthType;
  /** RFC 3339 UTC, millisecond precision. Canonical — see {@link canonicalInstant}. */
  readonly startedAt: string;
  readonly endedAt: string;
  readonly value: number;
  readonly source: string;
  /** When this service wrote it, which is not when it was measured. */
  readonly recordedAt: string;
}

/** What the phone last said about one type's permission. */
export interface AuthorisationRecord {
  readonly type: HealthType;
  readonly state: AuthorisationState;
  /** When the phone reported it, not when we stored it. */
  readonly reportedAt: string;
}

/** A watermark per type. A type with nothing held is simply absent. */
export type Watermarks = Readonly<Partial<Record<HealthType, string>>>;

/** Everything the phone reported about permission, by type. */
export type AuthorisationReport = Readonly<Partial<Record<HealthType, AuthorisationRecord>>>;

/** What {@link HealthSamples.append} was asked to write. */
export interface AppendInput {
  readonly samples: readonly HealthSampleInput[];
  /**
   * What the phone was allowed to read, per type, at the moment it read.
   *
   * **Complete or absent, never partial.** A partial report is refused rather
   * than merged, because a merge would silently carry yesterday's permission
   * into today's conclusion. Absent is allowed here — the store is also driven
   * by tests and by the downsample job, neither of which is reporting on
   * permission — and the HTTP surface requires one on every upload.
   */
  readonly authorisation?: Readonly<Record<HealthType, AuthorisationState>>;
  /** When the phone made that report. Defaults to the clock. */
  readonly reportedAt?: string;
}

/** What an append actually did. */
export interface AppendOutcome {
  /** Rows created. Zero is a valid, quiet answer. */
  readonly written: number;
  /** Rows already held, by identity. Reported rather than hidden. */
  readonly duplicates: number;
  /** Every type's watermark after the write — what the phone resumes from. */
  readonly watermarks: Watermarks;
}

/** One type, over a window. */
export interface SeriesQuery {
  readonly type: HealthType;
  /** Inclusive lower bound on `startedAt`. Omitted means from the beginning. */
  readonly from?: string;
  /** Exclusive upper bound on `startedAt`. Omitted means up to now. */
  readonly to?: string;
  /** At most this many, oldest first. */
  readonly limit?: number;
}

/** Thrown when a sample cannot be written as asked. */
export class HealthSampleError extends Error {
  readonly kind:
    | "bad_type"
    | "bad_instant"
    | "ends_before_it_starts"
    | "bad_value"
    | "empty_source"
    | "incomplete_authorisation";
  /** Which field, for the route that turns this into a contract failure. */
  readonly field: string;

  constructor(kind: HealthSampleError["kind"], field: string, message: string) {
    super(message);
    this.name = "HealthSampleError";
    this.kind = kind;
    this.field = field;
  }
}

/**
 * The most rows one call may write.
 *
 * A cold 60-day backfill of raw heart rate is on the order of 80,000 samples, so
 * the phone batches. The bound is here as well as at the route because the
 * failure it prevents is a single transaction holding the write lock long enough
 * for the reminder job to time out against it.
 */
export const MAX_SAMPLES_PER_APPEND = 5_000;

/**
 * An instant accepted at the door, canonicalised before it is stored.
 *
 * Wider than `services/clock.ts`'s `parseInstant` on purpose, and narrower
 * than `Date.parse` by a mile. It accepts `Z` with any number of fractional
 * digits — including none — because that is the range Foundation's
 * `ISO8601DateFormatter` emits depending on which options the caller set, and a
 * measurement is not worth losing to a formatter flag. It rejects a fixed UTC
 * offset outright: constraint 5, and an offset is a property of an instant
 * rather than of a place.
 *
 * **The canonicalisation is the point, not the tolerance.** A sample's identity
 * is a comparison of TEXT, so a phone sending `…:00Z` on Monday and
 * `…:00.000Z` on Tuesday would store one measurement twice under two spellings
 * and the unique index would never see it. Everything is normalised to one
 * spelling here, once, before it can reach the table.
 *
 * @returns the canonical form, or `null` if this is not an instant we accept.
 */
export function canonicalInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return instant(parsed);
}

interface SampleRow {
  readonly type: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly value: number;
  readonly source: string;
  readonly recorded_at: string;
}

interface AuthorisationRow {
  readonly type: string;
  readonly state: string;
  readonly reported_at: string;
}

const SAMPLE_COLUMNS = "type, started_at, ended_at, value, source, recorded_at";

function toSample(row: SampleRow): HealthSample {
  // Safe assertion: the column carries a CHECK naming exactly the seven types,
  // so a row that is in the table is a row whose type is one of them.
  return {
    type: row.type as HealthType,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    value: row.value,
    source: row.source,
    recordedAt: row.recorded_at,
  };
}

/** A sample that has been validated and canonicalised, but not yet stored. */
type CheckedSample = Omit<HealthSample, "recordedAt">;

/** One sample, checked and canonicalised. */
function checked(sample: HealthSampleInput, index: number): CheckedSample {
  const at = `samples[${String(index)}]`;

  if (!isHealthType(sample.type)) {
    throw new HealthSampleError(
      "bad_type",
      `${at}.type`,
      `${String(sample.type)} is not a health type. Expected one of ${HEALTH_TYPES.join(", ")}.`,
    );
  }

  const startedAt = canonicalInstant(sample.startedAt);
  if (startedAt === null) {
    throw new HealthSampleError(
      "bad_instant",
      `${at}.startedAt`,
      "startedAt must be RFC 3339 UTC ending in Z. A fixed offset is refused: an offset is a " +
        "property of an instant rather than of a place, and one that reaches storage drifts an " +
        "hour at every DST boundary.",
    );
  }

  const endedAt = canonicalInstant(sample.endedAt);
  if (endedAt === null) {
    throw new HealthSampleError(
      "bad_instant",
      `${at}.endedAt`,
      "endedAt must be RFC 3339 UTC ending in Z. Use startedAt's value for an instantaneous reading.",
    );
  }

  if (endedAt < startedAt) {
    throw new HealthSampleError(
      "ends_before_it_starts",
      `${at}.endedAt`,
      `A sample cannot end (${endedAt}) before it starts (${startedAt}).`,
    );
  }

  if (typeof sample.value !== "number" || !Number.isFinite(sample.value)) {
    throw new HealthSampleError(
      "bad_value",
      `${at}.value`,
      "value must be a finite number. SQLite stores a non-finite REAL as NULL, so an infinity " +
        "here would become a missing measurement rather than a refused one.",
    );
  }

  const source = typeof sample.source === "string" ? sample.source.trim() : "";
  if (source === "") {
    throw new HealthSampleError(
      "empty_source",
      `${at}.source`,
      "source names the device or app that recorded it, and it is part of the sample's identity: " +
        "the same minute measured by a watch and by a phone is two measurements, not a duplicate.",
    );
  }

  return { type: sample.type, startedAt, endedAt, value: sample.value, source };
}

export interface HealthSamplesOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

export class HealthSamples {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: HealthSamplesOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Write measurements, once each, and move the watermarks.
   *
   * Every sample is validated and canonicalised BEFORE the transaction opens, so
   * a batch with one bad row writes nothing at all and the phone gets one
   * refusal naming the row rather than a partial success it has to reconcile.
   *
   * **The watermark moves inside the same transaction as the rows**, which is
   * what "advances only on a confirmed write" means: a failure anywhere rolls
   * back both, and the phone re-sends a window it has already sent — harmless,
   * by identity. The opposite ordering loses measurements silently, which is the
   * direction that is not recoverable.
   *
   * A **duplicate still advances the watermark.** The row is held; that it was
   * held before this call is not a reason to make the phone send it again
   * forever.
   */
  append(input: AppendInput): AppendOutcome {
    const samples = input.samples.map((sample, index) => checked(sample, index));
    if (samples.length > MAX_SAMPLES_PER_APPEND) {
      throw new HealthSampleError(
        "bad_value",
        "samples",
        `That is ${String(samples.length)} samples in one call and the limit is ` +
          `${String(MAX_SAMPLES_PER_APPEND)}. A backfill is batched, not sent whole: one ` +
          "transaction that large holds the write lock long enough to time out the jobs.",
      );
    }

    const authorisation = input.authorisation;
    if (authorisation !== undefined) {
      const missing = unreportedTypes(authorisation);
      if (missing.length > 0) {
        throw new HealthSampleError(
          "incomplete_authorisation",
          "authorisation",
          `The authorisation report is missing ${missing.join(", ")}. It is refused rather than ` +
            "defaulted: a default would have to be a guess about permission, and a guess is " +
            "exactly what the report exists to abolish.",
        );
      }
    }

    const now = instant(this.#clock());
    const reportedAt = input.reportedAt ?? now;

    const insert = this.#db.prepare(
      `INSERT INTO health_samples (${SAMPLE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (type, started_at, ended_at, source) DO NOTHING`,
    );
    // Never backwards. See `0032_health_observations.sql`.
    const advance = this.#db.prepare(
      `INSERT INTO health_watermarks (type, through, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (type) DO UPDATE SET through = excluded.through, updated_at = excluded.updated_at
          WHERE excluded.through > health_watermarks.through`,
    );
    const record = this.#db.prepare(
      `INSERT INTO health_authorisation (type, state, reported_at) VALUES (?, ?, ?)
         ON CONFLICT (type) DO UPDATE SET state = excluded.state, reported_at = excluded.reported_at`,
    );

    // The furthest `endedAt` this batch carries per type — whether the row was
    // new or already held.
    const reached = new Map<HealthType, string>();
    let written = 0;

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const sample of samples) {
        const result = insert.run(
          sample.type,
          sample.startedAt,
          sample.endedAt,
          sample.value,
          sample.source,
          now,
        );
        if (Number(result.changes) > 0) written += 1;

        const furthest = reached.get(sample.type);
        if (furthest === undefined || sample.endedAt > furthest) {
          reached.set(sample.type, sample.endedAt);
        }
      }

      for (const [type, through] of reached) advance.run(type, through, now);

      if (authorisation !== undefined) {
        for (const type of HEALTH_TYPES) record.run(type, authorisation[type], reportedAt);
      }

      this.#db.exec("COMMIT");
    } catch (cause) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // The transaction was already gone. The original failure is the one
        // worth reporting, and swallowing this keeps it visible.
      }
      throw cause;
    }

    return { written, duplicates: samples.length - written, watermarks: this.watermarks() };
  }

  /**
   * Record what the phone was allowed to read, without writing any samples.
   *
   * The upload path that reads *nothing* still has something to say, and this is
   * it. A device whose permissions were all revoked uploads an empty batch with
   * a full report, and that is the difference between "he did nothing" and "we
   * stopped being able to look" — which is the whole of `syl-t9tj.1.4`.
   */
  recordAuthorisation(
    authorisation: Readonly<Record<HealthType, AuthorisationState>>,
    reportedAt?: string,
  ): void {
    this.append({ samples: [], authorisation, ...(reportedAt === undefined ? {} : { reportedAt }) });
  }

  /**
   * One type over a window, oldest first.
   *
   * Oldest first because every consumer is a series: the admin's raw view reads
   * it as a table in time order, and the derivations walk it forward.
   */
  series(query: SeriesQuery): readonly HealthSample[] {
    if (!isHealthType(query.type)) {
      throw new HealthSampleError(
        "bad_type",
        "type",
        `${String(query.type)} is not a health type. Expected one of ${HEALTH_TYPES.join(", ")}.`,
      );
    }

    const clauses = ["type = ?"];
    const bindings: (string | number)[] = [query.type];

    if (query.from !== undefined) {
      const from = canonicalInstant(query.from);
      if (from === null) {
        throw new HealthSampleError("bad_instant", "from", "from must be RFC 3339 UTC ending in Z.");
      }
      clauses.push("started_at >= ?");
      bindings.push(from);
    }
    if (query.to !== undefined) {
      const to = canonicalInstant(query.to);
      if (to === null) {
        throw new HealthSampleError("bad_instant", "to", "to must be RFC 3339 UTC ending in Z.");
      }
      clauses.push("started_at < ?");
      bindings.push(to);
    }

    const limit = query.limit ?? 5_000;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new HealthSampleError("bad_value", "limit", "limit must be a positive integer.");
    }
    bindings.push(limit);

    const rows = this.#db
      .prepare(
        `SELECT ${SAMPLE_COLUMNS} FROM health_samples
          WHERE ${clauses.join(" AND ")}
          ORDER BY started_at ASC, ended_at ASC, source ASC
          LIMIT ?`,
      )
      .all(...bindings);

    return rows.map((row) => toSample(row as unknown as SampleRow));
  }

  /** Where each type got to. A type with nothing held is absent, not empty-string. */
  watermarks(): Watermarks {
    const rows = this.#db.prepare("SELECT type, through FROM health_watermarks").all();
    const out: Partial<Record<HealthType, string>> = {};
    for (const row of rows) {
      // Safe assertion: the column carries a CHECK naming exactly the seven types.
      const typed = row as unknown as { type: HealthType; through: string };
      out[typed.type] = typed.through;
    }
    return out;
  }

  /** Where one type got to, or `null` because nothing has ever been held for it. */
  watermark(type: HealthType): string | null {
    const row = this.#db
      .prepare("SELECT through FROM health_watermarks WHERE type = ?")
      .get(type);
    return row === undefined ? null : (row as unknown as { through: string }).through;
  }

  /**
   * What the phone last said about each type.
   *
   * A type the phone has never reported on is **absent from this map**, and that
   * is a further answer rather than a missing one: absent means nobody has told
   * us anything, `notDetermined` means a prompt he has not seen, `denied` means
   * an answer he gave, `undisclosed` means the platform will not say, and
   * `unavailable` means this device cannot measure it. Nothing here defaults,
   * ever.
   */
  authorisation(): AuthorisationReport {
    const rows = this.#db
      .prepare("SELECT type, state, reported_at FROM health_authorisation")
      .all();
    const out: Partial<Record<HealthType, AuthorisationRecord>> = {};
    for (const row of rows) {
      const typed = row as unknown as AuthorisationRow;
      if (!isHealthType(typed.type)) continue;
      out[typed.type] = {
        type: typed.type,
        // Safe assertion: the column carries a CHECK naming exactly the states
        // in `AUTHORISATION_STATES`.
        state: typed.state as AuthorisationState,
        reportedAt: typed.reported_at,
      };
    }
    return out;
  }

  /** What the phone last said about one type, or `null` — which is not `denied`. */
  authorisationFor(type: HealthType): AuthorisationRecord | null {
    return this.authorisation()[type] ?? null;
  }

  /** How many measurements are held. For the tests that measure the live shape. */
  count(): number {
    const row = this.#db.prepare("SELECT count(*) AS n FROM health_samples").get();
    return Number((row as unknown as { n: number }).n);
  }
}
