import type { Attachment, Sending, SendingState } from "@syl/shared";

import type { AttachmentStore } from "./attachment-store.js";
import { instant, systemClock, type Clock } from "./clock.js";
import { newId } from "./id.js";
import { pageOf, resolvePage, type Page, type PageOptions } from "./paging.js";
import type { Database } from "./sqlite.js";

/**
 * The rows behind "From Syl".
 *
 * A **sending** is one thing with two parts: the WORDS she wanted to say, and
 * the VIDEO of her saying them. This store owns the row that joins them, and
 * its whole shape follows from one rule:
 *
 * > **The words are never contingent on the video.**
 *
 * So `create` takes a message that already exists — the words are in the
 * conversation and have already carried the notification before a row appears
 * here at all — and every later write touches only the video's half.
 * `attachVideo` and `markFailed` are the only two, and neither has a parameter
 * that could reach the words.
 *
 * ## Why there is no `delete`, and why that is not the interesting part
 *
 * There is no delete method, but the absence of a method is not a guarantee —
 * the retention job somebody writes next year will not go through this class.
 * The guarantee is in `0024_sendings.sql`: `BEFORE DELETE` and `BEFORE UPDATE`
 * triggers that `RAISE(ABORT)`, with no named exception, plus guards on
 * `messages` and `attachments` so a sending cannot be gutted from either end.
 * This class is merely the shape that never needs to argue with them.
 *
 * ## Why `video` is hydrated rather than stored
 *
 * The row keeps an attachment id; the wire shape carries the whole
 * `Attachment`. Reading it through `AttachmentStore` on every read means the
 * dimensions, the byte count and `hasThumbnail` come from the one place that
 * owns them, so a sending cannot disagree with the attachment it names — which
 * is the drift `sync-service.ts` avoids by resolving resources fresh.
 */

/** Thrown when a write cannot be made as asked. */
export class SendingStoreError extends Error {
  readonly kind:
    | "empty_words"
    | "empty_because"
    | "empty_reason"
    | "unknown_message"
    | "unknown_sending"
    | "unknown_attachment"
    | "already_settled";

  constructor(kind: SendingStoreError["kind"], message: string) {
    super(message);
    this.name = "SendingStoreError";
    this.kind = kind;
  }
}

/** What to record, once the words are already his. */
export interface CreateSending {
  /** What she said. Already appended to the conversation. */
  readonly words: string;
  /** Why she made it. Kept forever, alongside the words. */
  readonly because: string;
  /** The assistant message carrying `words`. Must exist. */
  readonly messageId: string;
  /** The full-quality render this came from — the record. */
  readonly renderName?: string | null;
}

interface SendingRow {
  readonly id: string;
  readonly words: string;
  readonly because: string;
  readonly message_id: string;
  readonly render_name: string | null;
  readonly attachment_id: string | null;
  readonly state: SendingState;
  readonly reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS =
  "id, words, because, message_id, render_name, attachment_id, state, reason, created_at, updated_at";

export interface SendingStoreOptions {
  readonly db: Database;
  readonly clock?: Clock;
  /**
   * Where the video comes from.
   *
   * Required rather than optional, unlike `MessageStore`'s: a message is
   * usually about text and a sending is never about text alone — half of what
   * this store exists to describe lives in the attachment table.
   */
  readonly attachments: AttachmentStore;
}

export class SendingStore {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #attachments: AttachmentStore;

  constructor(options: SendingStoreOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
    this.#attachments = options.attachments;
  }

  /**
   * Record a sending whose words have already been delivered.
   *
   * Deliberately cannot append the message itself. Taking a `messageId` that
   * must already exist is what makes the ordering — words first, always —
   * impossible to get wrong from here: there is no argument to this method
   * that would let a caller create a sending and hope to deliver the words
   * afterwards.
   */
  create(input: CreateSending): Sending {
    const words = input.words.trim();
    if (words === "") {
      throw new SendingStoreError(
        "empty_words",
        "A sending must say something. A video with no words is a thing he was never told about.",
      );
    }

    const because = input.because.trim();
    if (because === "") {
      throw new SendingStoreError(
        "empty_because",
        "Every sending says why it exists, the same as everything else she makes.",
      );
    }

    if (!this.#messageExists(input.messageId)) {
      // Checked here as well as by the foreign key, so the caller gets a named
      // refusal rather than a constraint violation from three layers down.
      throw new SendingStoreError(
        "unknown_message",
        `There is no message ${input.messageId} to carry those words.`,
      );
    }

    const at = instant(this.#clock());
    const row: SendingRow = {
      id: newId("sending"),
      words,
      because,
      message_id: input.messageId,
      render_name: input.renderName?.trim() === "" ? null : (input.renderName ?? null),
      attachment_id: null,
      state: "pending",
      reason: null,
      created_at: at,
      updated_at: at,
    };

    this.#db
      .prepare(`INSERT INTO sendings (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id,
        row.words,
        row.because,
        row.message_id,
        row.render_name,
        row.attachment_id,
        row.state,
        row.reason,
        row.created_at,
        row.updated_at,
      );

    return this.#hydrate(row);
  }

  /**
   * The video arrived. Move the sending to `ready`.
   *
   * Refuses a sending that already has one. A video that can be swapped is a
   * record that can be rewritten, which is the same injury as an edit — and
   * the schema refuses it too, so this is the sentence rather than the fence.
   */
  attachVideo(id: string, attachmentId: string): Sending {
    const row = this.#row(id);
    if (row.attachment_id !== null) {
      throw new SendingStoreError(
        "already_settled",
        `Sending ${id} already has a video, and a sending's video is never replaced.`,
      );
    }
    if (this.#attachments.get(attachmentId) === null) {
      throw new SendingStoreError("unknown_attachment", `There is no attachment ${attachmentId}.`);
    }

    const at = instant(this.#clock());
    this.#db
      .prepare(
        `UPDATE sendings
            SET attachment_id = ?, state = 'ready', reason = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(attachmentId, at, id);

    return this.#hydrate(this.#row(id));
  }

  /**
   * There will be no video, and this is why.
   *
   * The words are untouched by construction — this statement names four
   * columns and none of them is `words`, `because` or `message_id`. A sending
   * in this state is a complete row that the surface renders: her words, the
   * date, and no still. Hiding it would be the silence this project refuses.
   */
  markFailed(id: string, reason: string): Sending {
    const settled = reason.trim();
    if (settled === "") {
      throw new SendingStoreError(
        "empty_reason",
        "A failure without a reason teaches nothing and reads as a bug.",
      );
    }

    const row = this.#row(id);
    if (row.attachment_id !== null) {
      // A late failure against a sending that already succeeded. Refusing is
      // the only safe answer: the schema will not let the attachment go, so
      // "failed" would be a lie about a row that has a playable video on it.
      throw new SendingStoreError(
        "already_settled",
        `Sending ${id} already has a video, so it cannot be recorded as failed.`,
      );
    }

    this.#db
      .prepare("UPDATE sendings SET state = 'failed', reason = ?, updated_at = ? WHERE id = ?")
      .run(settled, instant(this.#clock()), id);

    return this.#hydrate(this.#row(id));
  }

  /** One sending, or `null`. */
  get(id: string): Sending | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM sendings WHERE id = ?`).get(id);
    return row === undefined ? null : this.#hydrate(row as unknown as SendingRow);
  }

  /**
   * A page of sendings, newest first.
   *
   * Newest first because that is what the surface opens to: the thing she sent
   * this morning, not the first one she ever made.
   *
   * @throws {PagingError} on an unreadable cursor or an out-of-range limit.
   */
  list(options: PageOptions = {}): Page<Sending> {
    const { limit, offset } = resolvePage(options);

    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM sendings
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(limit + 1, offset);

    return pageOf(
      rows.map((row) => this.#hydrate(row as unknown as SendingRow)),
      limit,
      offset,
    );
  }

  // ------------------------------------------------------------ internals ---

  #row(id: string): SendingRow {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM sendings WHERE id = ?`).get(id);
    if (row === undefined) {
      throw new SendingStoreError("unknown_sending", `There is no sending ${id}.`);
    }
    return row as unknown as SendingRow;
  }

  #messageExists(id: string): boolean {
    return this.#db.prepare("SELECT 1 FROM messages WHERE id = ?").get(id) !== undefined;
  }

  /**
   * The row plus the attachment it names.
   *
   * One lookup per sending rather than one per page. That is the N+1 this
   * codebase calls out elsewhere, and it is knowingly accepted here: a page is
   * fifty rows, at most fifty of them have a video, and the alternative is a
   * second projection of the attachment wire shape living in this file — which
   * is exactly the drift `AttachmentStore.forMessages` exists to prevent. If a
   * sendings page ever gets slow, the fix is a `forSendings` on the attachment
   * store, not a copy of `toAttachment` here.
   */
  #hydrate(row: SendingRow): Sending {
    let video: Attachment | null = null;
    if (row.attachment_id !== null) {
      const stored = this.#attachments.get(row.attachment_id);
      if (stored !== null) {
        const { storedName: _storedName, thumbName: _thumbName, ...wire } = stored;
        video = wire;
      }
    }

    return {
      id: row.id,
      words: row.words,
      because: row.because,
      messageId: row.message_id,
      state: row.state,
      renderName: row.render_name,
      video,
      reason: row.reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
