import { Router, type Request, type RequestHandler } from "express";

import type { Message } from "@syl/shared";

import type { IdempotencyStore } from "../services/idempotency.js";
import type { MessageStore } from "../services/message-store.js";
import { TellingError, type TellingService } from "../services/telling-service.js";
import { ApiFailure } from "./envelope.js";
import { runIdempotent, sendIdempotent } from "./idempotency.js";

/**
 * Her unprompted voice, over HTTP — `syl-0x1h`.
 *
 * ## Why a route when the service is in the same process
 *
 * `routes/sendings.ts`'s reason, unchanged: **one door.** Her tool server is a
 * separate process started per turn, with no object graph to reach into, so a
 * verb she can perform is a verb with a route behind it.
 *
 * ## `POST` and nothing else
 *
 * There is no `GET /tellings/{id}` and there must not be, which is the one
 * decision in this file worth arguing. A telling's record is a **message in his
 * conversation**, and a route that read one back by id would hand Syl's own
 * credential a read into his chat history that `AGENT_SURFACES` deliberately
 * does not give her — `/conversations` is outside her reach. A convenience that
 * quietly widens a credential is how a boundary stops being one.
 *
 * So the read-back that every write in this system does — `syl-009.3.4`,
 * confirmed from the store and never from her intention — happens **here**,
 * inside the write, against `MessageStore`. What comes back to her is the row.
 *
 * ## There is no DELETE and no PATCH
 *
 * A thing she said to him is not the system's to take back. Same rule as a
 * sending, one noun along.
 */

/** A telling longer than this is a paste accident, not a paragraph. */
const MAX_WORDS = 32_000;

/** The reason she said it. Generous, but not a document. */
const MAX_BECAUSE = 2_000;

export interface TellingRouterOptions {
  /**
   * The only thing that can make one.
   *
   * It appends, publishes and enqueues in that order — and it is the same
   * object `SendingService` composes through, so there is one implementation
   * of how her words reach him rather than two that will drift.
   */
  readonly teller: TellingService;
  /** Read back from, so the answer is the row rather than what was built. */
  readonly messages: MessageStore;
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

/** Turn a service refusal into the right contract failure. */
function asFailure(error: unknown): never {
  if (error instanceof TellingError) {
    throw new ApiFailure("VALIDATION_FAILED", error.message, {
      details: {
        field: error.kind === "empty_because" ? "because" : "words",
        reason: error.kind,
      },
    });
  }
  throw error;
}

export function createTellingRouter(options: TellingRouterOptions): Router {
  const { teller, messages, idempotency, authenticate } = options;
  const router = Router();

  router.use("/tellings", authenticate);

  router.post("/tellings", (request, response) => {
    sendIdempotent(
      response,
      runIdempotent<Message>(idempotency, request, () => {
        const body = bodyOf(request);
        const words = requireText(body, "words", MAX_WORDS);
        const because = requireText(body, "because", MAX_BECAUSE);

        let said: Message;
        try {
          said = teller.tell({ words, because });
        } catch (error) {
          asFailure(error);
        }

        // The row, not the value the append built. The two differ exactly where
        // it matters — a write transformed or replayed on the way in — and that
        // is the path where telling her the wrong thing costs the most.
        const stored = messages.get(said.id);
        if (stored === null) {
          throw new ApiFailure(
            "INTERNAL",
            "The words were written and could not be read back, so I cannot confirm what he has.",
          );
        }
        return { status: 201, data: stored };
      }),
    );
  });

  return router;
}
