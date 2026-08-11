import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Sending } from "@syl/shared";

import type { RenderRecord } from "../render/render-service.js";
import { MAX_ATTACHMENT_BYTES, type AttachmentStore } from "./attachment-store.js";
import type { ConversationService } from "./conversation-service.js";
import { INTERACTIVE_CONVERSATION_ID } from "./database.js";
import type { Outbox } from "./outbox.js";
import { compressForSending, type CompressOptions, type CompressResult } from "./sending-media.js";
import type { AppendResult } from "./message-store.js";
import { SendingStore, SendingStoreError } from "./sending-store.js";

/**
 * Composing a sending: her words, then her face.
 *
 * ## The order is the feature
 *
 * ```
 *   1. append the assistant message      the words are in his conversation
 *   2. publish it                        an attached client sees them now
 *   3. write the sending row             the surface has something to show
 *   4. enqueue the push                  carrying HER SENTENCE
 *   ------------------------------------ everything above is synchronous
 *   5. resolve the render
 *   6. compress, poster, attach          detached; minutes; may fail
 * ```
 *
 * Steps 1-4 finish before step 5 begins, and nothing in 5 or 6 can reach back
 * across the line. That is what makes **"the words are never contingent on the
 * video"** structural rather than a rule somebody has to remember: there is no
 * ordering a future caller could choose that would deliver the video first,
 * because `compose` does not expose one.
 *
 * It is constraint 4 applied to something new. A vanished reminder destroys
 * trust; words that vanished because their decoration did would be the same
 * injury with a nicer excuse.
 *
 * ## Why the answer comes back before the video
 *
 * A flagship render is 12-15 MB and an ffmpeg pass over it takes real seconds;
 * `RenderService` already establishes that a turn which blocks is the
 * Commander watching a cursor. So `compose` returns a `pending` sending and
 * the work continues behind it — the same shape `backend/src/jobs/` uses, and
 * the same shape `POST /renders` answers with.
 *
 * ## Why a failure is always recorded
 *
 * Every path out of the detached work ends in `attachVideo` or `markFailed`.
 * A sending left saying `pending` forever is the render-shaped version of a
 * dropped reminder — she told him something was coming and it never came, and
 * nothing anywhere says so.
 */

/**
 * The half of `RenderService` this needs.
 *
 * Narrow on purpose, and not only for testing: `RenderService` can *start*
 * renders, and composing a sending must never be able to spend a credit. A
 * service handed the whole object could grow that ability by accident; one
 * handed two readers cannot.
 */
export interface RenderSource {
  get(name: string): RenderRecord | null;
  latest(): RenderRecord | null;
}

/** The compressor, injected so no test needs ffmpeg or a real mp4. */
export type Compressor = (options: CompressOptions) => Promise<CompressResult>;

/**
 * What the notification says.
 *
 * `title` is her name and `body` is exactly what she said — no prefix, no
 * count, no "sent you a video". The spec is explicit and the reason is worth
 * keeping next to the code: a notification about the app is not a notification
 * from her, and the whole point of a sending is that she thought of him.
 *
 * Same shape a reminder uses, deliberately. He should not be able to tell from
 * the lock screen which subsystem produced a sentence she meant.
 */
const PUSH_TITLE = "Syl";

/**
 * How a sending interrupts.
 *
 * `active` rather than `time-sensitive`. A commitment breaks through Focus
 * because he undertook to do something at a time; a sending is a gift, and a
 * gift that overrides Do Not Disturb is not a gift. It also respects quiet
 * hours by taking the outbox's default release instant.
 */
const PUSH_LEVEL = "active" as const;

/** Deliveries from this path, so the outbox can be read by cause. */
export const SENDING_MESSAGE_CLASS = "sending";

export interface SendingServiceOptions {
  readonly sendings: SendingStore;
  /**
   * How the words reach the conversation AND the wire.
   *
   * `ConversationService` rather than `MessageStore`, and the difference is
   * the whole of gap 1's delivery half. The socket **subscribes itself** to
   * this object (`ws-server.ts` calls `chat.setSink`), so appending through it
   * and calling `accept` puts her words in front of an attached client with no
   * new wiring at all. A second sink of this module's own would be one
   * bootstrap edit away from `syl-vls` — a message stored and never broadcast,
   * leaving every client showing a conversation missing a message until it
   * reloaded.
   *
   * `accept` is safe here: it publishes, then returns without queueing a turn
   * for anything that is not `role: "user"`. A sending must not make Syl
   * answer herself.
   */
  readonly chat: ConversationService;
  readonly attachments: AttachmentStore;
  readonly outbox: Outbox;
  readonly renders: RenderSource;
  /** Where compressed copies and posters are written. Never the studio directory. */
  readonly workDir: string;
  /** Defaults to the Commander's own thread. */
  readonly conversationId?: string;
  /** Defaults to the real ffmpeg pass. */
  readonly compress?: Compressor;
  /** Defaults to the store's ceiling. */
  readonly ceilingBytes?: number;
  readonly log?: (line: string, error?: unknown) => void;
}

export interface ComposeSending {
  /** What she wants to say. Delivered before anything is done about a video. */
  readonly words: string;
  /** Why she is sending it. Kept forever. */
  readonly because: string;
  /** A render of hers, by name, or `latest`. */
  readonly renderName: string;
}

export class SendingService {
  readonly #sendings: SendingStore;
  readonly #chat: ConversationService;
  readonly #attachments: AttachmentStore;
  readonly #outbox: Outbox;
  readonly #renders: RenderSource;
  readonly #workDir: string;
  readonly #conversationId: string;
  readonly #compress: Compressor;
  readonly #ceilingBytes: number;
  readonly #log: (line: string, error?: unknown) => void;
  /** Video work in flight, so `drain` can wait for it. */
  readonly #inFlight = new Set<Promise<void>>();

  constructor(options: SendingServiceOptions) {
    this.#sendings = options.sendings;
    this.#chat = options.chat;
    this.#attachments = options.attachments;
    this.#outbox = options.outbox;
    this.#renders = options.renders;
    this.#workDir = options.workDir;
    this.#conversationId = options.conversationId ?? INTERACTIVE_CONVERSATION_ID;
    this.#compress = options.compress ?? compressForSending;
    this.#ceilingBytes = options.ceilingBytes ?? MAX_ATTACHMENT_BYTES;
    this.#log =
      options.log ??
      ((line, error) => {
        if (error === undefined) console.error(`[syl] ${line}`);
        else console.error(`[syl] ${line}`, error);
      });
  }

  /**
   * Say something to him, in her own face.
   *
   * Returns as soon as the words are his. The video follows.
   *
   * @throws {SendingStoreError} only for things that are wrong about the
   * WORDS — blank text, no reason, no render named. Every one of those is
   * checked before a message is appended, so a refusal leaves nothing behind.
   * Nothing about the video ever throws from here.
   */
  async compose(input: ComposeSending): Promise<Sending> {
    const words = input.words.trim();
    const because = input.because.trim();
    const renderName = input.renderName.trim();

    // Checked here, before the message, so a refusal writes nothing at all.
    // The store enforces the same rules, but by then a message would exist.
    if (words === "") {
      throw new SendingStoreError(
        "empty_words",
        "A sending must say something. A video with no words is a thing he was never told about.",
      );
    }
    if (because === "") {
      throw new SendingStoreError(
        "empty_because",
        "Every sending says why it exists, the same as everything else she makes.",
      );
    }
    if (renderName === "") {
      throw new SendingStoreError(
        "empty_words",
        "A sending is her saying something in her own face; name the render it is made from. " +
          "Words with no face is an ordinary message.",
      );
    }

    // ---- 1. The words reach the conversation. ------------------------------
    const appended = this.#chat.append({
      conversationId: this.#conversationId,
      // Null for anything Syl originated: there is no optimistic bubble on the
      // client to reconcile against.
      clientId: null,
      role: "assistant",
      text: words,
    });

    // ---- 2. And the wire. --------------------------------------------------
    this.#announce(appended);

    // ---- 3. The row the surface reads. -------------------------------------
    const sending = this.#sendings.create({
      words,
      because,
      messageId: appended.message.id,
      renderName,
    });

    // ---- 4. The push, carrying her sentence. -------------------------------
    this.#notify(sending);

    // ---- 5/6. The video, behind all of it. ---------------------------------
    this.#follow(sending, renderName);
    return sending;
  }

  /** Wait for every video in flight. For tests and for a clean shutdown. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
  }

  // ------------------------------------------------------------- internals ---

  /**
   * Put the message on the wire.
   *
   * `accept` never throws — it is called after a write has already been
   * committed, and there is nothing useful a caller could do with a failure
   * from it. Wrapped anyway, because "the socket was gone" must not be able to
   * cost a sending whose words are already persisted.
   */
  #announce(appended: AppendResult): void {
    try {
      this.#chat.accept(appended);
    } catch (error) {
      this.#log(`failed to publish the words of a sending (message ${appended.message.id})`, error);
    }
  }

  /**
   * Enqueue the notification.
   *
   * Keyed on the sending's own id, so a retried compose — or a recovery pass
   * that finds the row again — writes one row rather than a second buzz for a
   * sentence he has already read.
   *
   * Never throws. The words are already in his conversation by the time this
   * runs; failing the whole compose because the outbox was busy would trade a
   * missing notification for a missing sending.
   */
  #notify(sending: Sending): void {
    try {
      this.#outbox.enqueue({
        channel: "apns",
        messageClass: SENDING_MESSAGE_CLASS,
        payload: {
          title: PUSH_TITLE,
          // Her sentence, verbatim. Not a summary and not a notice about the
          // app — see the constant.
          body: sending.words,
          interruptionLevel: PUSH_LEVEL,
        },
        idempotencyKey: `sending:${sending.id}`,
      });
    } catch (error) {
      this.#log(`failed to enqueue the notification for sending ${sending.id}`, error);
    }
  }

  /** Chase the video without anybody awaiting it. */
  #follow(sending: Sending, renderName: string): void {
    const running = this.#makeVideo(sending, renderName)
      .catch((error: unknown) => {
        this.#log(`the video for sending ${sending.id} threw`, error);
        this.#settleFailed(
          sending.id,
          `Something went wrong making the video for this one: ${String(error)}. What I said still stands.`,
        );
      })
      .finally(() => {
        this.#inFlight.delete(running);
      });
    this.#inFlight.add(running);
  }

  /**
   * Resolve the render, compress it, and attach the result.
   *
   * Every branch ends in `attachVideo` or `#settleFailed`. There is no path
   * that leaves the row `pending`.
   */
  async #makeVideo(sending: Sending, renderName: string): Promise<void> {
    const record = renderName === "latest" ? this.#renders.latest() : this.#renders.get(renderName);

    if (record === null) {
      this.#settleFailed(sending.id, "There is no render by that name, so this one goes without a video.");
      return;
    }
    if (record.status === "rendering") {
      // Deliberately not "wait for it". A sending is a thing she decided to
      // send now; a compose that silently waited minutes for a render would
      // make `pending` mean two different things and give the recovery path
      // nothing to distinguish them by.
      this.#settleFailed(
        sending.id,
        `"${record.name}" is still rendering, so this one goes without a video for now.`,
      );
      return;
    }
    if (record.status !== "ready" || record.video === null) {
      this.#settleFailed(
        sending.id,
        `"${record.name}" did not finish: ${record.reason ?? "no reason was recorded."}`,
      );
      return;
    }

    const compressed = await this.#compress({
      // The full-quality render, read only. The output goes somewhere else
      // entirely — see `workDir`.
      source: record.video,
      outDir: join(this.#workDir, sending.id),
      ceilingBytes: this.#ceilingBytes,
    });

    if (!compressed.ok) {
      this.#settleFailed(sending.id, compressed.reason);
      return;
    }

    let attachmentId: string;
    try {
      const stored = this.#attachments.create({
        kind: "video",
        declaredMime: "video/mp4",
        data: readFileSync(compressed.path),
        width: compressed.width,
        height: compressed.height,
        durationMs: compressed.durationMs,
        // The frame that puts her face on the row rather than a generic video
        // affordance — and, because `hasThumbnail` becomes true, the reason a
        // client fetches a small JPEG instead of the whole clip.
        poster: compressed.poster,
      });
      attachmentId = stored.id;
    } catch (error) {
      // The store refused the bytes — an encode that overshot the ceiling, or
      // a file that is not the container it claims. Her words are untouched.
      this.#settleFailed(
        sending.id,
        `I could not store the video for this one: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    this.#sendings.attachVideo(sending.id, attachmentId);

    // The compressed copy now exists twice: once in the blob directory, where
    // the store owns it, and once here, where nothing does. Reaping the second
    // is not tidiness — a 2 MB duplicate per sending accumulates on the
    // Commander's own disk forever, and the one place it must NOT reach is the
    // studio directory, which is why `workDir` is separate in the first place.
    //
    // Best-effort: the sending is already `ready` and a file left behind is a
    // wasted megabyte, not a lost video.
    this.#reap(sending.id);
  }

  /** Drop this sending's scratch directory. Never the studio, never the blobs. */
  #reap(sendingId: string): void {
    try {
      rmSync(join(this.#workDir, sendingId), { recursive: true, force: true });
    } catch (error) {
      this.#log(`could not clear the scratch directory for sending ${sendingId}`, error);
    }
  }

  /**
   * Record that there will be no video.
   *
   * Swallows its own failure on purpose: this runs inside a detached promise
   * and is frequently the handler for an earlier failure. Throwing here would
   * replace a legible "no video, and here is why" with an unhandled rejection.
   */
  #settleFailed(id: string, reason: string): void {
    try {
      this.#sendings.markFailed(id, reason);
    } catch (error) {
      this.#log(`could not record the failure of sending ${id}`, error);
    }
  }
}

// Re-exported so a caller catching a refusal from `compose` does not have to
// import from two modules to name what it caught.
export { SendingStoreError };
