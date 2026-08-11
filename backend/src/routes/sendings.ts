import { Router, type Request, type RequestHandler } from "express";

import type { Sending } from "@syl/shared";

import { isId } from "../services/id.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { PagingError } from "../services/paging.js";
import type { SendingService } from "../services/sending-service.js";
import { SendingStoreError, type SendingStore } from "../services/sending-store.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { runIdempotentAsync, sendIdempotent } from "./idempotency.js";

/**
 * "From Syl", over HTTP.
 *
 * ## Why a route when the service is in the same process
 *
 * `routes/renders.ts`'s reason, unchanged: **one door.** Her tool server is a
 * separate process started per turn, with no object graph to reach into and no
 * business having one, so a verb she can perform is a verb with a route behind
 * it. The alternative is a second path into the same stores, re-implementing
 * the same validation, drifting.
 *
 * ## `POST` answers when the WORDS are delivered
 *
 * Not when the compressed copy is attached. `201` here means the message is in
 * his conversation; the returned sending says `pending`, and the playable copy
 * lands on it seconds later. A client that wants the video polls
 * `GET /sendings/{sendingId}`, or — far better — waits for the `sending` change
 * to arrive on `GET /sync`, which is why that resource type exists.
 *
 * **The notification is NOT enqueued here.** It goes out when the video settles
 * on the row, which is the Commander's ruling of 2026-08-11: a buzz that leads
 * to a pending video is worse than a buzz a moment later that leads to a
 * finished one.
 *
 * ## A render that is not finished is a `422`, not a `201`
 *
 * This used to be the opposite, and the reversal is the same ruling. The old
 * rule was that by the time the render was looked at her words had already been
 * said, so a missing clip was reported *in the body* — `state: "failed"` with a
 * reason — and the status stayed `201`. That could only produce a message, and
 * a notification, about a video that did not exist.
 *
 * `SendingService.compose` now resolves the render **first** and refuses one
 * that is not `ready`, before anything is written, so this route answers
 * `VALIDATION_FAILED` and nothing at all has happened. The caller is Syl
 * herself, by way of `show_him`, and she is told which render and why — which
 * is a thing she can act on, unlike a `201` describing a video nobody will
 * ever see.
 *
 * The `4xx` this route emits on a write is therefore for two things: something
 * wrong with the WORDS, and a render that is not there to send. Both are
 * checked before anything is written at all.
 *
 * ## There is no DELETE and no PATCH
 *
 * Not an omission. The database refuses both — see `0024_sendings.sql`. A
 * route offering them would be a route whose every call is a 500.
 */

/** A sending's words longer than this is a paste accident, not a sentence. */
const MAX_WORDS = 32_000;

/** The reason she made it. Generous, but not a document. */
const MAX_BECAUSE = 2_000;

/** A render name is a filename stem; anything longer is not one. */
const MAX_RENDER_NAME = 200;

export interface SendingRouterOptions {
  readonly sendings: SendingStore;
  readonly composer: SendingService;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
}

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

function requireText(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiFailure("VALIDATION_FAILED", `${field} is required.`, {
      details: { field, reason: "must be a non-empty string" },
    });
  }
  if (value.length > maxLength) {
    throw new ApiFailure("VALIDATION_FAILED", `${field} is too long.`, {
      details: { field, reason: `must be at most ${String(maxLength)} characters` },
    });
  }
  return value;
}

/** Validate the path id before it reaches a query. */
function sendingIdOf(request: Request): string {
  const raw = request.params["sendingId"];
  const id = typeof raw === "string" ? raw : "";
  if (!isId(id, "sending")) {
    throw new ApiFailure("NOT_FOUND", "That is not a sending id.");
  }
  return id;
}

/** Read `cursor` and `limit` off a query string. */
function pageOf(request: Request): { readonly cursor?: string; readonly limit?: number } {
  const rawCursor = request.query["cursor"];
  const rawLimit = request.query["limit"];

  if (rawCursor !== undefined && typeof rawCursor !== "string") {
    throw new ApiFailure("VALIDATION_FAILED", "cursor must appear at most once.", {
      details: { field: "cursor", reason: "repeated" },
    });
  }
  if (rawLimit !== undefined && typeof rawLimit !== "string") {
    throw new ApiFailure("VALIDATION_FAILED", "limit must appear at most once.", {
      details: { field: "limit", reason: "repeated" },
    });
  }

  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && !Number.isInteger(limit)) {
    throw new ApiFailure("VALIDATION_FAILED", "limit must be a whole number.", {
      details: { field: "limit", reason: "not a whole number" },
    });
  }

  return {
    ...(rawCursor === undefined ? {} : { cursor: rawCursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** Turn a store refusal into the right contract failure. */
function asFailure(error: unknown): never {
  if (error instanceof PagingError) {
    throw new ApiFailure("VALIDATION_FAILED", error.message, {
      details: { field: error.kind === "bad_cursor" ? "cursor" : "limit", reason: error.kind },
    });
  }
  if (error instanceof SendingStoreError) {
    // Named by the field it is actually about. A refusal about a render that
    // is still going, reported against `words`, sends the caller to look at
    // the one thing that was fine.
    const aboutTheRender = error.kind === "unknown_render" || error.kind === "render_not_ready";
    throw new ApiFailure("VALIDATION_FAILED", error.message, {
      details: { field: aboutTheRender ? "renderName" : "words", reason: error.kind },
    });
  }
  throw error;
}

export function createSendingRouter(options: SendingRouterOptions): Router {
  const { sendings, composer, idempotency, authenticate } = options;
  const router = Router();

  // His own keepsakes, on his own phone. A `device` token is enough — the same
  // argument `routes/attachments.ts` makes: this is the data, not the audit
  // trail of what a pre-authorised program did on his machine.
  router.use("/sendings", authenticate);

  router.get("/sendings", (request, response) => {
    try {
      sendOk(response, sendings.list(pageOf(request)));
    } catch (error) {
      asFailure(error);
    }
  });

  router.post("/sendings", (request, response, next) => {
    // `.then(...).catch(next)` rather than an `async` handler, matching
    // `routes/renders.ts`: relying on Express 5's promise forwarding would make
    // this the one route whose error path is a framework behaviour rather than
    // a visible line.
    void runIdempotentAsync<Sending>(idempotency, request, async () => {
      const body = bodyOf(request);
      const words = requireText(body, "words", MAX_WORDS);
      const because = requireText(body, "because", MAX_BECAUSE);
      const renderName = requireText(body, "renderName", MAX_RENDER_NAME);

      try {
        // Returns as soon as the words are his. Whatever happens to the video
        // afterwards is reported on the row, never as a failure of this call.
        return { status: 201, data: await composer.compose({ words, because, renderName }) };
      } catch (error) {
        asFailure(error);
      }
    })
      .then((outcome) => {
        sendIdempotent(response, outcome);
      })
      .catch(next);
  });

  router.get("/sendings/:sendingId", (request, response) => {
    const sending = sendings.get(sendingIdOf(request));
    if (sending === null) throw new ApiFailure("NOT_FOUND", "There is no such sending.");
    sendOk(response, sending);
  });

  return router;
}
