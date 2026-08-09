import { Router, type RequestHandler } from "express";

import { ApiFailure, sendOk } from "../routes/envelope.js";
import { requireString } from "../routes/devices.js";
import { runIdempotent, sendIdempotent } from "../routes/idempotency.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { idType, isId } from "../services/id.js";
import type { ArticleIntake } from "./intake.js";
import { IntakeStoreError, type IntakeChannel, type IntakeSource } from "./intake-store.js";
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
 * ## The response is not a contract type
 *
 * `shared/openapi.yaml` has no intake operation yet — the contract is another
 * lane's this wave — so this serves the store's own shape inside the standard
 * envelope. Adding the operation to the spec is the follow-up; the envelope
 * means a client that meets this route before the spec catches up still gets
 * something it can parse.
 */

/** How long a submitted URL may be. Longer than any real article link. */
const MAX_URL_LENGTH = 2048;

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
}

export function createIntakeRouter(options: IntakeRouterOptions): Router {
  const { intake, idempotency, authenticate } = options;
  const router = Router();

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

    const outcome = runIdempotent<IntakeSource>(idempotency, request, () => {
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

      // 200 rather than 201 when the link was already known. Submitting the
      // same article from the Share Extension and again from a forwarded email
      // is one source, and the status is how the caller learns which happened.
      return { status: result.created ? 201 : 200, data: result.source };
    });

    sendIdempotent(response, outcome);
  });

  router.get("/intake/:sourceId", (request, response) => {
    const source = intake.get(sourceIdOf(request.params["sourceId"]));
    if (source === null) {
      throw new ApiFailure("NOT_FOUND", "Syl has no intake source with that id.");
    }
    sendOk(response, source);
  });

  return router;
}
