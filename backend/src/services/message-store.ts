import type {
  Conversation,
  ConversationLane,
  ConversationPage,
  Message,
  MessagePage,
  MessageRole,
} from "@syl/shared";

import { instant, systemClock, type Clock } from "./clock.js";
import { INTERACTIVE_CONVERSATION_ID } from "./database.js";
import { newId } from "./id.js";
import type { Database } from "./sqlite.js";

/**
 * Conversation history.
 *
 * **Every message carries a `conversationId`, from message number one.** The
 * column is `NOT NULL` with a foreign key, so this is not a convention a code
 * path can forget — it is a constraint the database enforces. Adjutant derived
 * conversation scope from sender and recipient instead, shipped messages into
 * the wrong thread, and paid for it twice: once in the bug, once in a backfill
 * migration with an audit log.
 *
 * Two sequence spaces exist in Syl and they are not the same number. This one
 * is `message.seq`: per conversation, ordering history inside a thread. The
 * *frame* sequence on the WebSocket is a different counter over a different
 * scope. Feeding one to the other silently desynchronises a client.
 */

/** History is read newest first; this is how much of it at a time. */
export const DEFAULT_PAGE_LIMIT = 50;

/** A page larger than this is a client mistake, not a request. */
export const MAX_PAGE_LIMIT = 200;

/**
 * The affect hint a turn may emit.
 *
 * It drives the `presence` frame and must never reach a client as message
 * content, so it is stripped on the way in rather than on the way out — one
 * removal at one seam, instead of one per read path.
 */
const AFFECT_HINT = /<!--\s*affect:\s*([a-z_]+)([^>]*)-->/gi;

/** A parsed affect hint. */
export interface AffectHint {
  readonly state: string;
  readonly intensity: number;
}

/** Text with the hint removed, plus the hint if there was one. */
export interface StrippedText {
  readonly text: string;
  readonly affect: AffectHint | null;
}

/**
 * Remove the affect marker from a turn's text.
 *
 * The marker is stripped on the shape of the *comment*, not on the shape of
 * its contents. A model that emits `<!--affect: alert oops-->` has written a
 * malformed hint, and the wrong response is to leave the marker in the message
 * because the number failed to parse — that puts the machinery on screen. The
 * hint always goes; only its intensity falls back.
 *
 * `intensity` is clamped to 0..1 rather than trusted. The value comes from a
 * model, and a client that renders `1.4` as a scale factor produces something
 * visibly wrong.
 */
export function stripAffectHint(raw: string): StrippedText {
  let affect: AffectHint | null = null;

  const text = raw
    .replace(AFFECT_HINT, (_match, state: string, rest: string) => {
      const parsed = Number.parseFloat(rest.trim());
      affect = {
        state: state.toLowerCase(),
        intensity: Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1,
      };
      return "";
    })
    .trim();

  return { text, affect };
}

/** Encode a page cursor. Opaque to clients; base64 of the seq it stops at. */
export function encodeCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ seq }), "utf8").toString("base64");
}

/**
 * Decode a page cursor, or `null` if it is not one.
 *
 * Cursors arrive from clients and from URLs people edit. A cursor that cannot
 * be read must be refused rather than silently treated as "start from the
 * beginning", which would make a paginating client loop forever.
 */
export function decodeCursor(cursor: string): number | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return null;
    // Safe assertion: guarded above, and the field is type-tested.
    const seq = (decoded as Record<string, unknown>)["seq"];
    return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : null;
  } catch {
    return null;
  }
}

/** What to append. */
export interface AppendMessage {
  /** Defaults to the Commander's own thread. */
  readonly conversationId?: string;
  /** The client's own id, for reconciling an optimistic bubble. */
  readonly clientId?: string | null;
  readonly role: MessageRole;
  readonly text: string;
}

/** The result of an append. */
export interface AppendResult {
  readonly message: Message;
  /**
   * True when this `clientId` had already been accepted and the stored message
   * was returned instead of a second one being written. The mobile outbox
   * retries by design; without this a flaky tunnel turns one message into
   * three.
   */
  readonly replayed: boolean;
  /** The affect hint stripped from the text, if there was one. */
  readonly affect: AffectHint | null;
}

export interface PageOptions {
  readonly cursor?: string | null;
  readonly limit?: number;
}

/** Thrown when a request cannot be satisfied as asked. */
export class MessageStoreError extends Error {
  readonly kind: "unknown_conversation" | "bad_cursor" | "bad_limit" | "empty_text";

  constructor(kind: MessageStoreError["kind"], message: string) {
    super(message);
    this.name = "MessageStoreError";
    this.kind = kind;
  }
}

interface MessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly client_id: string | null;
  readonly role: MessageRole;
  readonly text: string;
  readonly created_at: string;
  readonly seq: number;
}

interface ConversationRow {
  readonly id: string;
  readonly lane: ConversationLane;
  readonly title: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_message_at: string | null;
  readonly message_count: number;
}

const MESSAGE_COLUMNS = "id, conversation_id, client_id, role, text, created_at, seq";
const CONVERSATION_COLUMNS =
  "id, lane, title, created_at, updated_at, last_message_at, message_count";

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    clientId: row.client_id,
    role: row.role,
    text: row.text,
    createdAt: row.created_at,
    seq: row.seq,
  };
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    lane: row.lane,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
  };
}

/** Validate a requested page size. */
function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new MessageStoreError(
      "bad_limit",
      `limit must be a whole number between 1 and ${MAX_PAGE_LIMIT}.`,
    );
  }
  return limit;
}

export interface MessageStoreOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

export class MessageStore {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: MessageStoreOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Append a message to a conversation.
   *
   * The message, the sequence number and the conversation's counters all move
   * in one transaction. A crash between them would leave a thread whose
   * `messageCount` disagreed with the rows in it, and every client that
   * trusted the count would then believe it was missing history.
   */
  append(input: AppendMessage): AppendResult {
    const conversationId = input.conversationId ?? INTERACTIVE_CONVERSATION_ID;
    const clientId = input.clientId ?? null;
    const stripped = stripAffectHint(input.text);

    if (stripped.text === "") {
      throw new MessageStoreError("empty_text", "A message must carry some text.");
    }

    if (this.conversation(conversationId) === null) {
      throw new MessageStoreError(
        "unknown_conversation",
        `There is no conversation ${conversationId}.`,
      );
    }

    // A retried send is not a second message. Checked before the transaction
    // so the common case does no write at all, and enforced by a UNIQUE index
    // so a race cannot slip past the check.
    if (clientId !== null) {
      const existing = this.#byClientId(conversationId, clientId);
      if (existing !== null) {
        return { message: existing, replayed: true, affect: stripped.affect };
      }
    }

    const createdAt = instant(this.#clock());
    const id = newId("message");

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const nextSeq = this.#nextSeq(conversationId);

      this.#db
        .prepare(
          `INSERT INTO messages (${MESSAGE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, conversationId, clientId, input.role, stripped.text, createdAt, nextSeq);

      this.#db
        .prepare(
          `UPDATE conversations
              SET message_count = message_count + 1,
                  last_message_at = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(createdAt, createdAt, conversationId);

      this.#db.exec("COMMIT");

      return {
        message: {
          id,
          conversationId,
          clientId,
          role: input.role,
          text: stripped.text,
          createdAt,
          seq: nextSeq,
        },
        replayed: false,
        affect: stripped.affect,
      };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Already unwound. The original failure is the one worth reporting.
      }
      throw error;
    }
  }

  /** One message by id, or `null`. */
  get(id: string): Message | null {
    const row = this.#db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(id);
    return row === undefined ? null : toMessage(row as unknown as MessageRow);
  }

  /**
   * A page of history, newest first.
   *
   * Newest first because that is what a chat view opens to and what a sync
   * catches up on; walking forward from the beginning of a thousand-message
   * thread to show the last twenty is the wrong shape for every caller.
   */
  list(conversationId: string, options: PageOptions = {}): MessagePage {
    const limit = pageLimit(options.limit);
    const cursor = options.cursor ?? null;

    let before = Number.MAX_SAFE_INTEGER;
    if (cursor !== null) {
      const decoded = decodeCursor(cursor);
      if (decoded === null) {
        throw new MessageStoreError("bad_cursor", "That cursor is not one this service issued.");
      }
      before = decoded;
    }

    // One extra row answers "is there more" without a second COUNT query.
    const rows = this.#db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
          WHERE conversation_id = ? AND seq < ?
          ORDER BY seq DESC
          LIMIT ?`,
      )
      .all(conversationId, before, limit + 1);

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => toMessage(row as unknown as MessageRow));
    const last = items.at(-1);

    return {
      items,
      nextCursor: hasMore && last !== undefined ? encodeCursor(last.seq) : null,
      hasMore,
    };
  }

  /**
   * Keyword search across history.
   *
   * The query goes to FTS5 as a parameter, never concatenated — and a query
   * FTS5 cannot parse (an unbalanced quote, a bare `*`) is answered with no
   * results rather than an error, because the caller here is a person typing
   * into a box, not a program.
   */
  search(query: string, options: { limit?: number } = {}): readonly Message[] {
    const limit = pageLimit(options.limit);
    if (query.trim() === "") return [];

    try {
      const rows = this.#db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS.split(", ")
            .map((column) => `m.${column}`)
            .join(", ")}
             FROM messages_fts
             JOIN messages m ON m.rowid = messages_fts.rowid
            WHERE messages_fts MATCH ?
            ORDER BY rank
            LIMIT ?`,
        )
        .all(query, limit);
      return rows.map((row) => toMessage(row as unknown as MessageRow));
    } catch {
      return [];
    }
  }

  /** One conversation by id, or `null`. */
  conversation(id: string): Conversation | null {
    const row = this.#db
      .prepare(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`)
      .get(id);
    return row === undefined ? null : toConversation(row as unknown as ConversationRow);
  }

  /** A page of conversations, most recently touched first. */
  listConversations(
    options: PageOptions & { readonly lane?: ConversationLane } = {},
  ): ConversationPage {
    const limit = pageLimit(options.limit);
    const cursor = options.cursor ?? null;

    let offset = 0;
    if (cursor !== null) {
      const decoded = decodeCursor(cursor);
      if (decoded === null) {
        throw new MessageStoreError("bad_cursor", "That cursor is not one this service issued.");
      }
      offset = decoded;
    }

    const lane = options.lane;
    const rows =
      lane === undefined
        ? this.#db
            .prepare(
              `SELECT ${CONVERSATION_COLUMNS} FROM conversations
                ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
            )
            .all(limit + 1, offset)
        : this.#db
            .prepare(
              `SELECT ${CONVERSATION_COLUMNS} FROM conversations
                WHERE lane = ?
                ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
            )
            .all(lane, limit + 1, offset);

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => toConversation(row as unknown as ConversationRow));

    return {
      items,
      nextCursor: hasMore ? encodeCursor(offset + items.length) : null,
      hasMore,
    };
  }

  /**
   * Open a lane for background work.
   *
   * Job lanes exist so Syl's inner monologue — the heartbeat, the nightly
   * consolidation, a research run — never interleaves with talking to the
   * Commander. Their ids are assigned here and never derived by a client.
   */
  createJobConversation(title: string): Conversation {
    const id = newId("conversation");
    const at = instant(this.#clock());

    this.#db
      .prepare(
        `INSERT INTO conversations (id, lane, title, created_at, updated_at, last_message_at, message_count)
         VALUES (?, 'job', ?, ?, ?, NULL, 0)`,
      )
      .run(id, title, at, at);

    return {
      id,
      lane: "job",
      title,
      createdAt: at,
      updatedAt: at,
      lastMessageAt: null,
      messageCount: 0,
    };
  }

  #byClientId(conversationId: string, clientId: string): Message | null {
    const row = this.#db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ? AND client_id = ?`,
      )
      .get(conversationId, clientId);
    return row === undefined ? null : toMessage(row as unknown as MessageRow);
  }

  #nextSeq(conversationId: string): number {
    const row = this.#db
      .prepare("SELECT coalesce(max(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?")
      .get(conversationId);
    // Safe assertion: `coalesce(max(...), 0) + 1` is always an integer.
    return (row as unknown as { next: number }).next;
  }
}
