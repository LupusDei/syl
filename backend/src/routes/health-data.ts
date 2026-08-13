import { Router, type Request, type RequestHandler } from "express";

import {
  AUTHORISATION_STATES,
  HEALTH_TYPES,
  UNITS,
  isHealthType,
  silenceIsEvidence,
  unreportedTypes,
  type AuthorisationState,
  type HealthSampleInput,
  type HealthType,
} from "../health/contract.js";
import {
  HealthSampleError,
  type AuthorisationRecord,
  type HealthSamples,
} from "../health/samples.js";
import { summariseHealth } from "../health/summarise.js";
import type { Clock } from "../services/clock.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { runIdempotent, sendIdempotent } from "./idempotency.js";

/**
 * His health data over HTTP: the upload, the resume point, and the raw series.
 *
 * `syl-t9tj.2.3`. Three routes — `POST /health/samples`,
 * `GET /health/watermarks`, `GET /health/series`.
 *
 *
 * ## Why this file is not `routes/health.ts`
 *
 * **It could not be.** `routes/health.ts` already exists and is the service's
 * *liveness* endpoint — `GET /health`, the one route a monitor may call without
 * a token, reporting the commit this process was built from. `plan.md` and
 * `tasks.md` both name `backend/src/routes/health.ts` for this work, written
 * before anyone checked, and following them literally would have meant merging
 * an authenticated data surface into the one unauthenticated route in the
 * contract. Two files, two concerns, one shared path prefix and nothing else.
 *
 * The prefix sharing is handled deliberately: this router mounts its
 * authentication on `/health/samples`, `/health/watermarks` and `/health/series`
 * **by name**, never on `/health`. A `router.use("/health", authenticate)` here
 * would put a bearer check in front of liveness — silently, and only in whichever
 * mount order `createApp` happens to have today.
 *
 *
 * ## Device scope, not admin — and the distinction is worth stating
 *
 * `GET /logs` is the one route a paired phone may not reach, because the log is
 * the record of what a **pre-authorised program did on his machine**, which is
 * not his data. This *is* his data: his heart, his sleep, his weight. It takes an
 * ordinary authenticated device token like every other read of his own things.
 *
 * Syl's own `agent` credential does **not** reach it. `/health` is not on
 * `AGENT_SURFACES`, so `confineAgent` refuses her by default — which is the
 * correct default and not an oversight: the raw series is an input to the review
 * turn, handed to her by the service, not something she goes and reads.
 *
 *
 * ## The upload is refused if the authorisation report is incomplete
 *
 * A type HealthKit was never granted reads as *empty*, so on the wire "he walked
 * nowhere on Tuesday" and "we were never allowed to look at steps" are the same
 * zero samples. Only the phone knows the difference. An upload that omits a type
 * is therefore refused rather than defaulted: the default would have to be a
 * guess about permission, and the report exists to abolish guessing.
 */

/** The largest batch one upload may carry. Matches the store's own bound. */
const MAX_SAMPLES = 5_000;

/** Turn a store refusal into the right contract failure. */
function asHealthFailure(error: unknown): never {
  if (error instanceof HealthSampleError) {
    throw new ApiFailure("VALIDATION_FAILED", error.message, {
      details: { field: error.field, reason: error.kind },
    });
  }
  throw error;
}

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  return typeof body === "object" && body !== null
    ? // Safe assertion: guarded above, and every field is re-tested on read.
      (body as Record<string, unknown>)
    : {};
}

/**
 * The authorisation report, complete or not at all.
 *
 * Read here rather than left to the store because this is the door the phone
 * knocks on, and the refusal has to name the types that are missing — a client
 * told only "incomplete" has to diff two lists to find out what it forgot.
 */
function reportOf(body: Record<string, unknown>): Record<HealthType, AuthorisationState> {
  const raw = body["authorisation"];
  if (typeof raw !== "object" || raw === null) {
    throw new ApiFailure(
      "VALIDATION_FAILED",
      "Every upload carries an authorisation report: what this device was ALLOWED to read, per " +
        "type, at the moment it read. Without it a type that returned nothing is " +
        "indistinguishable from a type we were never permitted to look at, and the server will " +
        "not guess which.",
      { details: { field: "authorisation", reason: "missing" } },
    );
  }

  // Safe assertion: guarded above, and every value is re-tested below.
  const stated = raw as Record<string, unknown>;
  const report: Partial<Record<HealthType, AuthorisationState>> = {};
  for (const type of HEALTH_TYPES) {
    const value = stated[type];
    if (value === undefined) continue;
    // Derived from the contract's own list rather than written out here. The
    // list went from three states to five mid-build (`syl-m3gi`), and a
    // hand-written triple in this file would have refused the two new ones while
    // reading as a correct guard.
    if (typeof value !== "string" || !(AUTHORISATION_STATES as readonly string[]).includes(value)) {
      throw new ApiFailure(
        "VALIDATION_FAILED",
        `authorisation.${type} must be one of ${AUTHORISATION_STATES.join(", ")}.`,
        { details: { field: `authorisation.${type}`, reason: "not an authorisation state" } },
      );
    }
    // Safe assertion: `includes` just proved membership.
    report[type] = value as AuthorisationState;
  }

  const missing = unreportedTypes(report);
  if (missing.length > 0) {
    throw new ApiFailure(
      "VALIDATION_FAILED",
      `The authorisation report is missing ${missing.join(", ")}. It is refused rather than ` +
        "defaulted: a defaulted permission is a guess, and the report exists so that nothing " +
        "here has to guess.",
      { details: { field: "authorisation", reason: "incomplete", missing } },
    );
  }

  // Safe assertion: `unreportedTypes` just proved every type is present.
  return report as Record<HealthType, AuthorisationState>;
}

/** The samples array, shape-checked only — the store validates each one. */
function samplesOf(body: Record<string, unknown>): readonly HealthSampleInput[] {
  const raw = body["samples"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ApiFailure("VALIDATION_FAILED", "samples must be an array.", {
      details: { field: "samples", reason: "not an array" },
    });
  }
  if (raw.length > MAX_SAMPLES) {
    throw new ApiFailure(
      "VALIDATION_FAILED",
      `That is ${String(raw.length)} samples and the limit is ${String(MAX_SAMPLES)} per upload. ` +
        "A backfill is batched: the watermark in the reply is where to resume from.",
      { details: { field: "samples", reason: "too many", limit: MAX_SAMPLES } },
    );
  }
  // Safe assertion: each element is fully validated by `HealthSamples.append`,
  // which refuses the whole batch on the first bad row rather than writing part
  // of it.
  return raw as readonly HealthSampleInput[];
}

/** The `type` query parameter, which is required and must be one of the seven. */
function typeOf(request: Request): HealthType {
  const raw = request.query["type"];
  if (!isHealthType(raw)) {
    throw new ApiFailure(
      "VALIDATION_FAILED",
      `type must be one of ${HEALTH_TYPES.join(", ")}.`,
      { details: { field: "type", reason: raw === undefined ? "missing" : "unknown type" } },
    );
  }
  return raw;
}

function optionalInstant(request: Request, field: string): string | undefined {
  const raw = request.query[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new ApiFailure("VALIDATION_FAILED", `${field} must be a single RFC 3339 instant.`, {
      details: { field, reason: "repeated" },
    });
  }
  return raw;
}

/**
 * What one type's permission looks like on the wire.
 *
 * `state: null` is a real answer and the most important one in this file: the
 * phone has never reported on this type at all. It is **not** `denied` — a build
 * too old to send a report and a permission he refused are different facts, and
 * a client that rendered them the same would be telling him he had said no to
 * something nobody ever asked him about.
 *
 * `silenceIsEvidence` travels beside it, derived from the contract's own
 * function rather than recomputed, so no reader has to know that `authorised` is
 * the only state under which an empty series means "nothing happened".
 */
function authorisationOnTheWire(record: AuthorisationRecord | null): {
  readonly state: AuthorisationState | null;
  readonly reportedAt: string | null;
  readonly silenceIsEvidence: boolean;
} {
  return {
    state: record?.state ?? null,
    reportedAt: record?.reportedAt ?? null,
    silenceIsEvidence: record === null ? false : silenceIsEvidence(record.state),
  };
}

export interface HealthDataRouterOptions {
  readonly health: HealthSamples;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
  /** The service's clock. Never a second one — see `AppDependencies.clock`. */
  readonly clock: Clock;
  /** His zone. IANA, never a fixed offset (constraint 5). Days are HIS days. */
  readonly tz: string;
}

export function createHealthDataRouter(options: HealthDataRouterOptions): Router {
  const { health, idempotency, authenticate, clock, tz } = options;
  const router = Router();

  // BY NAME, never `/health`. See the note at the top of this file: mounting on
  // the prefix would put a bearer check in front of the liveness endpoint, which
  // is the one route in the contract that must answer without a token.
  router.use("/health/samples", authenticate);
  router.use("/health/watermarks", authenticate);
  router.use("/health/series", authenticate);

  /**
   * The upload.
   *
   * Idempotent twice over, and the two layers guard different things.
   * `Idempotency-Key` guards **this HTTP call** — a lost response, a retried
   * request. The sample identity in the store guards **the measurement**, which
   * is what makes a second device, or an app that lost its watermark, harmless.
   * Neither subsumes the other: the same reading arriving in two different calls
   * has two different keys.
   */
  router.post("/health/samples", (request, response) => {
    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => {
        const body = bodyOf(request);
        // The report is read BEFORE the samples, so an upload with no report is
        // refused before the ledger holds anything about it.
        const authorisation = reportOf(body);
        const samples = samplesOf(body);

        try {
          const outcome = health.append({ samples, authorisation });
          return { status: 200, data: outcome };
        } catch (error) {
          asHealthFailure(error);
        }
      }),
    );
  });

  /**
   * Where each type got to, and what we were allowed to read.
   *
   * Both in one answer on purpose. A watermark alone cannot tell the phone
   * whether an absent type is one it has never sent or one it is not permitted
   * to read, and those want different behaviour from it: resume, versus stop
   * asking and tell him why.
   */
  router.get("/health/watermarks", (_request, response) => {
    const watermarks = health.watermarks();
    const authorisation = health.authorisation();
    sendOk(response, {
      watermarks,
      types: HEALTH_TYPES.map((type) => ({
        type,
        unit: UNITS[type],
        watermark: watermarks[type] ?? null,
        ...authorisationOnTheWire(authorisation[type] ?? null),
      })),
    });
  });

  /**
   * The raw series, for the admin view he asked for.
   *
   * **The answer always carries the authorisation state**, even when there are
   * samples. That is what makes `samples: []` readable: an empty array beside
   * `state: "authorised"` means nothing happened, beside `state: "denied"` means
   * we did not look, and beside `state: null` means nobody has ever told us
   * which. Returning the array alone would put the admin in exactly the position
   * `syl-kqc` put the notification path in — a layer reporting success over a
   * capability it never had.
   */
  /**
   * His health, derived, small enough for a turn (`syl-t9tj.5.4`).
   *
   * `?types=` narrows it — "how have I been sleeping" should not cost her a
   * paragraph about his step count. Absent means all of them.
   *
   * Returns derivations and never samples. 28,726 heart-rate rows do not fit in
   * a turn, and an arbitrary slice of them is worse than none: she would answer
   * confidently from whichever fortnight happened to fit.
   */
  router.get("/health/summary", (request, response) => {
    const raw = request.query["types"];
    const asked = typeof raw === "string" && raw.trim() !== "" ? raw.split(",").map((t) => t.trim()) : [];
    const unknown = asked.filter((t) => !isHealthType(t));
    if (unknown.length > 0) {
      throw new ApiFailure(
        "VALIDATION_FAILED",
        `unknown type(s) ${unknown.join(", ")}. Known types are ${HEALTH_TYPES.join(", ")}.`,
        { details: { field: "types", reason: "unknown type" } },
      );
    }

    sendOk(
      response,
      summariseHealth({
        samples: health,
        now: clock(),
        tz,
        types: asked.filter(isHealthType),
      }),
    );
  });

  router.get("/health/series", (request, response) => {
    const type = typeOf(request);
    const from = optionalInstant(request, "from");
    const to = optionalInstant(request, "to");

    try {
      const samples = health.series({
        type,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      });
      sendOk(response, {
        type,
        unit: UNITS[type],
        ...authorisationOnTheWire(health.authorisationFor(type)),
        watermark: health.watermark(type),
        samples,
      });
    } catch (error) {
      asHealthFailure(error);
    }
  });

  return router;
}
