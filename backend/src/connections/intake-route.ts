import { Router, type RequestHandler } from "express";

import { ApiFailure, sendOk } from "../routes/envelope.js";
import { requireString } from "../routes/devices.js";
import { runIdempotent, sendIdempotent } from "../routes/idempotency.js";
import { instant, systemClock, type Clock } from "../services/clock.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { idType, isId } from "../services/id.js";
import type { ArticleIntake } from "./intake.js";
import { IntakeStoreError, type IntakeChannel } from "./intake-store.js";
import type { IntakeAnswer, ReadAllowance } from "./intake-view.js";
import { RETENTION_CLASSES, type RetentionClass } from "./retention.js";

/**
 * Submitting a link, over HTTP.
 *
 * Intake had a store, a fetcher behind an SSRF guard, a quarantined reader and
 * a retention classifier, and no way for anything outside a test to hand it a
 * URL (`syl-1o7`). This is that way: the Share Extension posts here, and so
 * does the mail poller once it has a Gmail client.
 *
 * ## Why this router lives beside intake rather than in `routes/`
 *
 * Because it is intake's surface, and the coupling is to the ladder rather
 * than to the rest of the API. `createApp` mounts it under the same base path
 * as every other router, and it uses the same envelope, the same
 * `authenticate` middleware and the same idempotency wrapper — nothing here is
 * a second way of being an HTTP route.
 *
 * ## What this endpoint does NOT do
 *
 * It does not fetch. Submission is cheap and synchronous so the caller gets an
 * answer immediately; the `content_ingestion` job does the work. A handler
 * that fetched inline would hold an HTTP connection open for however long a
 * hostile server felt like taking.
 *
 * ## What it answers with is a {@link Reading}, never the row
 *
 * `syl-r1t`. Both operations used to serve `IntakeSource` straight out of the
 * store, which was fine while the only callers were the Share Extension and a
 * test. `read_this` changed the audience: the answer now lands in a turn that
 * holds Adjutant's MCP tools and Syl's own credential, and the row carries the
 * page's own `<title>` — raw response bytes, lifted out of the document with no
 * model and no gate in between.
 *
 * So the projection in `intake-view.ts` stands between the store and every
 * caller of these two routes rather than only in front of her. One shape for
 * everyone: two shapes for two audiences is how the safe one stops being the
 * one that gets maintained.
 *
 * ## The response is not a contract type
 *
 * `shared/openapi.yaml` has no intake operation, and both routes are named in
 * `UNDECLARED` in `contract-conformance.test.ts` so the omission is visible
 * rather than silent. This serves {@link IntakeAnswer} inside the standard
 * envelope, so a client that meets these routes before the spec catches up
 * still gets something it can parse.
 */

/** How long a submitted URL may be. Longer than any real article link. */
const MAX_URL_LENGTH = 2048;

/**
 * How many readings Syl may START in a day, on her own credential.
 *
 * **A ceiling rather than a quota**, the same shape as `SENDINGS_PER_DAY`: it
 * is not a budget she should spend down, it is the number at which something
 * has gone wrong. Reading is the first thing she can do that costs the
 * Commander real time and real tokens without him having asked for anything —
 * a heartbeat turn that decides to follow links, or a page that persuades her
 * to follow more of them, spends his money in a loop nobody is watching.
 *
 * Ten rather than four. `SENDINGS_PER_DAY` bounds how often she may INTERRUPT
 * him and four is generous for that; a reading interrupts nobody, so the
 * number only has to be small enough to bound a runaway and large enough for a
 * real afternoon's research.
 *
 * **Visible, not silent.** Every answer carries {@link ReadAllowance}, so she
 * knows where she stands before she hits it rather than discovering the wall.
 * That is the `because` rule applied to spending, and the same call
 * `render_me` makes with `spent`.
 */
export const READS_PER_DAY = 10;

/**
 * The window the ceiling is counted over.
 *
 * Rolling, and deliberately not a local day. A local midnight would let twenty
 * readings start in two minutes and still be two lawful days, which is exactly
 * the runaway the number exists to bound. `SENDINGS_PER_DAY` uses his local day
 * because *he* experiences the day; spending has no midnight.
 */
export const READ_WINDOW_HOURS = 24;

/** The ways a link can arrive. */
const CHANNELS: readonly IntakeChannel[] = ["link", "email", "share"];

/** Read the optional `channel` field, defaulting to a direct submission. */
function channelOf(body: Record<string, unknown>): IntakeChannel {
  const raw = body["channel"];
  if (raw === undefined) return "link";
  const match = CHANNELS.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new ApiFailure("VALIDATION_FAILED", "That is not an intake channel.", {
      details: { field: "channel", reason: `must be one of ${CHANNELS.join(", ")}` },
    });
  }
  return match;
}

/**
 * Read the optional `retention` field.
 *
 * An explicit class always wins over the classifier: the Commander marking
 * something sensitive must not be second-guessed by a host list.
 */
function retentionOf(body: Record<string, unknown>): RetentionClass | undefined {
  const raw = body["retention"];
  if (raw === undefined) return undefined;
  const match = RETENTION_CLASSES.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new ApiFailure("VALIDATION_FAILED", "That is not a retention class.", {
      details: { field: "retention", reason: `must be one of ${RETENTION_CLASSES.join(", ")}` },
    });
  }
  return match;
}

/**
 * Refuse anything that is not a web link before it becomes a row.
 *
 * `safeFetch` refuses a `file:` or `data:` URL too, and would refuse this one
 * permanently at the fetch step — so this is defence in depth rather than the
 * control. It is here because a submission that can never succeed should be
 * answered at the door rather than recorded, advanced, failed and left in the
 * store as a source the Commander has to wonder about.
 */
function assertWebUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ApiFailure("VALIDATION_FAILED", `${raw} is not a URL Syl can record.`, {
      details: { field: "url", reason: "not a URL" },
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiFailure(
      "VALIDATION_FAILED",
      `${parsed.protocol} is not a scheme Syl fetches. Only http and https are.`,
      { details: { field: "url", reason: "scheme" } },
    );
  }
}

function sourceIdOf(raw: unknown): string {
  const id = typeof raw === "string" ? raw : "";
  if (!isId(id) || idType(id) !== "source") {
    throw new ApiFailure("NOT_FOUND", "That is not an intake source id.");
  }
  return id;
}

function bodyOf(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? // Safe assertion: guarded above, and every field is re-tested on read.
      (raw as Record<string, unknown>)
    : {};
}

export interface IntakeRouterOptions {
  readonly intake: ArticleIntake;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
  readonly clock?: Clock;
  /** Readings one agent credential may start per window. See {@link READS_PER_DAY}. */
  readonly allowance?: number;
}

export function createIntakeRouter(options: IntakeRouterOptions): Router {
  const { intake, idempotency, authenticate } = options;
  const clock = options.clock ?? systemClock;
  const ceiling = options.allowance ?? READS_PER_DAY;
  const router = Router();

  /**
   * Where a caller stands against the ceiling.
   *
   * **Only her.** The ceiling exists because a program can start reading in a
   * loop; the Commander sharing a link from his phone is a person doing one
   * thing at a time, and metering him would be the service second-guessing its
   * owner. So a `device` or `admin` key gets `allowance: null`, which says
   * plainly that there is no ceiling rather than pretending to a large one.
   */
  function allowanceFor(requestedBy: string, scope: string | undefined): ReadAllowance {
    if (scope !== "agent") {
      return { used: 0, allowance: null, windowHours: READ_WINDOW_HOURS };
    }
    const since = instant(clock() - READ_WINDOW_HOURS * 60 * 60_000);
    return {
      used: intake.readsSince(requestedBy, since),
      allowance: ceiling,
      windowHours: READ_WINDOW_HOURS,
    };
  }

  router.use("/intake", authenticate);

  router.post("/intake", (request, response) => {
    const body = bodyOf(request.body);
    const url = requireString(body, "url", MAX_URL_LENGTH);
    assertWebUrl(url);
    const channel = channelOf(body);
    const retention = retentionOf(body);

    // Who asked, from the verified principal rather than from the body. It is
    // an authorisation fact and never a trust fact: a link the Commander sent
    // himself is exactly as hostile as one Syl found.
    const requestedBy = request.auth?.principal.id ?? "unknown";
    const scope = request.auth?.key.scope;

    const outcome = runIdempotent<IntakeAnswer>(idempotency, request, () => {
      const reads = allowanceFor(requestedBy, scope);
      if (reads.allowance !== null && reads.used >= reads.allowance) {
        // Refused BEFORE the row is created, so a run against the ceiling
        // cannot walk it up one submission at a time. The sentence is written
        // to be repeated to him: she has to be able to say what stopped, and
        // "I have read ten things today already" is an answer he can overrule.
        throw new ApiFailure(
          "RATE_LIMITED",
          `Syl has started ${String(reads.used)} readings in the last ${String(reads.windowHours)} ` +
            `hours, which is her ceiling. She has read nothing more. Send the link yourself if it ` +
            `cannot wait.`,
          { details: { used: reads.used, allowance: reads.allowance } },
        );
      }

      let result;
      try {
        result = intake.submit({
          url,
          channel,
          requestedBy,
          ...(retention === undefined ? {} : { retention }),
        });
      } catch (error) {
        if (error instanceof IntakeStoreError && error.kind === "bad_url") {
          throw new ApiFailure("VALIDATION_FAILED", error.message, {
            details: { field: "url", reason: "not a URL" },
          });
        }
        throw error;
      }

      const reading = intake.reading(result.source.id);
      if (reading === null) {
        throw new ApiFailure("INTERNAL", "Syl recorded that link and could not read it back.");
      }

      // 200 rather than 201 when the link was already known. Submitting the
      // same article from the Share Extension and again from a forwarded email
      // is one source, and the status is how the caller learns which happened
      // — which is also how `read_this` tells "I have started" from "here is
      // what it says", since asking twice is how she waits.
      //
      // A repeat costs nothing against the ceiling, and that is deliberate: it
      // is the same reading, and charging for looking at it again would make
      // asking whether it had finished the expensive part.
      return {
        status: result.created ? 201 : 200,
        data: { reading, reads: allowanceFor(requestedBy, scope) },
      };
    });

    sendIdempotent(response, outcome);
  });

  router.get("/intake/:sourceId", (request, response) => {
    const reading = intake.reading(sourceIdOf(request.params["sourceId"]));
    if (reading === null) {
      throw new ApiFailure("NOT_FOUND", "Syl has no intake source with that id.");
    }
    const answer: IntakeAnswer = {
      reading,
      reads: allowanceFor(request.auth?.principal.id ?? "unknown", request.auth?.key.scope),
    };
    sendOk(response, answer);
  });

  return router;
}
