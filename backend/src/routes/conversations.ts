import { Router, type Request, type RequestHandler } from "express";

import type { ConversationLane, DeliveryConfirmation } from "@syl/shared";

import { AttachmentError } from "../services/attachment-store.js";
import type { ConversationService } from "../services/conversation-service.js";
import { isId } from "../services/id.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import {
  MessageStoreError,
  type MessageStore,
  type PageOptions,
} from "../services/message-store.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { runIdempotent, sendIdempotent } from "./idempotency.js";

/**
 * Conversations and their history.
 *
 * `POST /conversations/{id}/messages` is the HTTP half of a pair: the same
 * send exists as a WebSocket frame, and a client falls back to this when the
 * socket is down. Both paths reconcile identically, by `clientId`, and both
 * answer with the same `DeliveryConfirmation` shape — a client that had to
 * fall back must not need a second code path to finish the job it started.
 *
 * Note that the confirmation's `seq` is the **message** sequence. This is the
 * one place the bare name means that space: there is no frame stream in an
 * HTTP response for a position to be in.
 */

/** Turn a store refusal into the right contract failure. */
function asFailure(error: unknown): never {
  if (error instanceof AttachmentError) {
    // A message that quietly lost its picture is worse than a send that failed
    // — the first is discovered by the person who thought they had sent one.
    if (error.code === "already-attached") {
      throw new ApiFailure("CONFLICT", error.message, {
        details: { field: "attachmentIds", reason: error.code },
      });
    }
    throw new ApiFailure("VALIDATION_FAILED", error.message, {
      details: { field: "attachmentIds", reason: error.code },
    });
  }
  if (error instanceof MessageStoreError) {
    switch (error.kind) {
      case "unknown_conversation":
        throw new ApiFailure("NOT_FOUND", error.message);
      case "bad_cursor":
        throw new ApiFailure("VALIDATION_FAILED", error.message, {
          details: { field: "cursor", reason: "not a cursor this service issued" },
        });
      case "bad_limit":
        throw new ApiFailure("VALIDATION_FAILED", error.message, {
          details: { field: "limit", reason: error.message },
        });
      case "empty_text":
        throw new ApiFailure("VALIDATION_FAILED", error.message, {
          details: { field: "text", reason: "must carry some text" },
        });
    }
  }
  throw error;
}

/** Read `cursor` and `limit` off a query string. */
function pageOptions(request: Request): PageOptions {
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

/** Validate a path id before it reaches a query. */
function conversationIdOf(request: Request): string {
  // Express 5 types a path parameter as `string | string[]`, because a wildcard
  // segment can repeat. Ours cannot, but the type is honest about the shape and
  // a non-string here means the route was mounted differently than it reads.
  const raw = request.params["conversationId"];
  const id = typeof raw === "string" ? raw : "";
  if (!isId(id, "conversation")) {
    throw new ApiFailure("NOT_FOUND", "That is not a conversation id.");
  }
  return id;
}

/** Read a required string body field. */
function requireString(body: unknown, field: string, maxLength: number): string {
  const value =
    typeof body === "object" && body !== null
      ? // Safe assertion: guarded above, and the value is re-tested.
        (body as Record<string, unknown>)[field]
      : undefined;

  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiFailure("VALIDATION_FAILED", `${field} is required.`, {
      details: { field, reason: "must be a non-empty string" },
    });
  }
  if (value.length > maxLength) {
    throw new ApiFailure("VALIDATION_FAILED", `${field} is too long.`, {
      details: { field, reason: `must be at most ${maxLength} characters` },
    });
  }
  return value;
}

/**
 * Read `attachmentIds` off a send, or refuse it.
 *
 * Absent is fine; present-and-empty is not. An empty array reaches here only
 * from a client that built the field and then had nothing to put in it, which
 * is a bug on the send path worth saying out loud rather than treating as a
 * plain text message.
 */
function attachmentIdsOf(body: unknown): readonly string[] | undefined {
  const value =
    typeof body === "object" && body !== null
      ? // Safe assertion: guarded above, and every element is re-tested below.
        (body as Record<string, unknown>)["attachmentIds"]
      : undefined;
  if (value === undefined || value === null) return undefined;

  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiFailure("VALIDATION_FAILED", "attachmentIds must be a non-empty array.", {
      details: { field: "attachmentIds", reason: "omit it rather than sending an empty array" },
    });
  }
  if (value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new ApiFailure("VALIDATION_FAILED", "That is too many attachments for one message.", {
      details: {
        field: "attachmentIds",
        reason: `at most ${String(MAX_ATTACHMENTS_PER_MESSAGE)}`,
      },
    });
  }
  for (const candidate of value) {
    if (typeof candidate !== "string" || !isId(candidate, "attachment")) {
      throw new ApiFailure("VALIDATION_FAILED", "That is not an attachment id.", {
        details: { field: "attachmentIds", reason: "every element must be an attachment id" },
      });
    }
  }
  return value as readonly string[];
}

/**
 * A message longer than this is a paste accident, not a message.
 */
const MAX_MESSAGE_TEXT = 32_000;

/**
 * More pictures than this on one message is a mistake, not an album.
 *
 * Bounded here rather than left open because each id costs a row lookup inside
 * the message's own transaction, and an unbounded list is an unbounded time
 * spent holding a write lock on the conversation.
 */
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** Client ids are opaque, but a UUID is 36 characters and this is generous. */
const MAX_CLIENT_ID = 128;

const LANES: readonly ConversationLane[] = ["interactive", "job"];

export interface ConversationRouterOptions {
  /** Reading history. */
  readonly messages: MessageStore;
  /**
   * Writing to it, announcing it, and answering it.
   *
   * The three are one operation and this route used to do only the first
   * (`syl-vls`): a message posted here was stored and never broadcast, so every
   * attached client showed a conversation missing a message until it reloaded,
   * and nothing ever answered it. Both send paths now go through the same two
   * calls on the same object.
   */
  readonly chat: ConversationService;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
}

export function createConversationRouter(options: ConversationRouterOptions): Router {
  const { messages, chat, idempotency, authenticate } = options;
  const router = Router();

  // Every route here is the Commander's own history. None is public.
  router.use("/conversations", authenticate);

  router.get("/conversations", (request, response) => {
    const rawLane = request.query["lane"];
    let lane: ConversationLane | undefined;
    if (rawLane !== undefined) {
      const match = LANES.find((candidate) => candidate === rawLane);
      if (match === undefined) {
        throw new ApiFailure("VALIDATION_FAILED", "lane must be interactive or job.", {
          details: { field: "lane", reason: `must be one of ${LANES.join(", ")}` },
        });
      }
      lane = match;
    }

    try {
      sendOk(
        response,
        messages.listConversations(
          lane === undefined ? pageOptions(request) : { ...pageOptions(request), lane },
        ),
      );
    } catch (error) {
      asFailure(error);
    }
  });

  router.get("/conversations/:conversationId", (request, response) => {
    const conversation = messages.conversation(conversationIdOf(request));
    if (conversation === null) {
      throw new ApiFailure("NOT_FOUND", "There is no such conversation.");
    }
    sendOk(response, conversation);
  });

  router.get("/conversations/:conversationId/messages", (request, response) => {
    const id = conversationIdOf(request);
    if (messages.conversation(id) === null) {
      throw new ApiFailure("NOT_FOUND", "There is no such conversation.");
    }

    try {
      sendOk(response, messages.list(id, pageOptions(request)));
    } catch (error) {
      asFailure(error);
    }
  });

  /**
   * `syl-ux1`, `syl-9e0`. This was the one write that never asked for an
   * `Idempotency-Key`, and the only write route that did not go through
   * `routes/idempotency.ts` — so it also could not answer
   * `IDEMPOTENCY_KEY_REUSE` when a client reused a key for a different body.
   * `MessageStore` deduping on `clientId` masked the common case, which is why
   * no unit test noticed.
   *
   * The two dedupe mechanisms are not redundant. `clientId` is what the
   * optimistic bubble reconciles against and is the same on both send paths,
   * HTTP and socket. The ledger is what makes *this* call safe to repeat,
   * including the answer it gives — and the status is part of the answer,
   * which is why a replay now returns the contract's 201 rather than the 200
   * this route used to invent.
   */
  router.post("/conversations/:conversationId/messages", (request, response) => {
    const conversationId = conversationIdOf(request);

    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => {
        const clientId = requireString(request.body, "clientId", MAX_CLIENT_ID);
        const text = requireString(request.body, "text", MAX_MESSAGE_TEXT);
        const attachmentIds = attachmentIdsOf(request.body);

        try {
          const result = chat.append({
            conversationId,
            clientId,
            role: "user",
            text,
            ...(attachmentIds === undefined ? {} : { attachmentIds }),
          });

          const confirmation: DeliveryConfirmation = {
            clientId,
            serverId: result.message.id,
            conversationId,
            // The MESSAGE sequence, not a frame sequence. See the module note.
            seq: result.message.seq,
            acceptedAt: result.message.createdAt,
          };

          // The store recognised the `clientId` under a key the ledger has
          // never seen — a client that regenerated its key across a reinstall,
          // or the socket path having landed the same message first. Worth
          // saying out loud, because the caller's optimistic bubble is about to
          // be reconciled against a message it did not think had arrived.
          if (result.replayed) response.setHeader("Idempotency-Replayed", "true");

          // Announced and answered. **Not awaited**: a turn runs for up to ten
          // minutes, and a client that had to hold a connection open for one
          // would time out long before Syl finished thinking. The reply arrives
          // on the socket and is persisted on the way past, so a client that
          // was not attached still finds it in history.
          //
          // Inside the idempotent body on purpose — a replayed request answers
          // from the ledger and must not start a second turn.
          chat.accept(result);

          // 201 either way. The contract documents exactly one success status
          // for this operation, and a client that got 201 once and 200 the
          // next time has to reconcile two answers to one send.
          return { status: 201, data: confirmation };
        } catch (error) {
          asFailure(error);
        }
      }),
    );
  });

  return router;
}
