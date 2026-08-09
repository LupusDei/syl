import { Router, type Request, type RequestHandler } from "express";

import type { ConversationLane, DeliveryConfirmation } from "@syl/shared";

import { isId } from "../services/id.js";
import {
  MessageStoreError,
  type MessageStore,
  type PageOptions,
} from "../services/message-store.js";
import { ApiFailure, sendOk } from "./envelope.js";

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

/** A message longer than this is a paste accident, not a message. */
const MAX_MESSAGE_TEXT = 32_000;
/** Client ids are opaque, but a UUID is 36 characters and this is generous. */
const MAX_CLIENT_ID = 128;

const LANES: readonly ConversationLane[] = ["interactive", "job"];

export interface ConversationRouterOptions {
  readonly messages: MessageStore;
  readonly authenticate: RequestHandler;
}

export function createConversationRouter(options: ConversationRouterOptions): Router {
  const { messages, authenticate } = options;
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

  router.post("/conversations/:conversationId/messages", (request, response) => {
    const conversationId = conversationIdOf(request);
    const clientId = requireString(request.body, "clientId", MAX_CLIENT_ID);
    const text = requireString(request.body, "text", MAX_MESSAGE_TEXT);

    try {
      const result = messages.append({ conversationId, clientId, role: "user", text });

      const confirmation: DeliveryConfirmation = {
        clientId,
        serverId: result.message.id,
        conversationId,
        // The MESSAGE sequence, not a frame sequence. See the module note.
        seq: result.message.seq,
        acceptedAt: result.message.createdAt,
      };

      // A replayed send is the same operation, not a new one, so it answers
      // 200 rather than 201 and says so in a header the client can see.
      if (result.replayed) response.setHeader("Idempotency-Replayed", "true");
      sendOk(response, confirmation, result.replayed ? 200 : 201);
    } catch (error) {
      asFailure(error);
    }
  });

  return router;
}
