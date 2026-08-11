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
 * ## The render has to be FINISHED before any of this starts
 *
 * The Commander's ruling, 2026-08-11:
 *
 * > *"It sounds like the push notification goes out, regardless of whether a
 * > video was created or not — that seems a little bit backwards to me. […]
 * > If she decides to send it at that point, the push notification would go
 * > out."*
 *
 * So `compose` **refuses** a render that is not `ready`, before a message is
 * appended, before a row exists, before anything is enqueued. A sending is now
 * something she composes about a clip she has already seen — the seeing happens
 * on the `studio` lane (`jobs/render-review-job.ts`), minutes after the render
 * was asked for, and the decision she reaches there is the only thing that
 * reaches him.
 *
 * That inverts what this file used to argue for, which was that the words
 * should never wait on the video. The words still never wait on the video —
 * they are refused, together, or delivered, together. What changed is that a
 * buzz leading to a `pending` or `failed` video is worse than a buzz two
 * minutes later leading to a finished one, and the old ordering could only
 * produce the first.
 *
 * ## The order, once the render is known finished
 *
 * ```
 *   0. resolve the render                REFUSES unless it is `ready`
 *   ------------------------------------ nothing above this line writes
 *   1. append the assistant message      the words are in his conversation
 *   2. publish it                        an attached client sees them now
 *   3. write the sending row             the surface has something to show
 *   ------------------------------------ everything above is synchronous
 *   4. compress, poster, attach          detached; seconds; may fail
 *   5. enqueue the push                  carrying HER SENTENCE
 * ```
 *
 * The push is last, and that is the other half of the ruling: it is enqueued
 * when the video has actually landed on the row (or when it provably will not),
 * never in the hope that it will. Nothing in 4 or 5 can reach back and touch
 * the words, so "a failed compression cannot swallow what she wanted to say"
 * survives the reordering — `#makeVideo` and `#settleFailed` name the video's
 * columns and no other.
 *
 * It is still constraint 4 applied to something new. A vanished reminder
 * destroys trust; words that vanished because their decoration did would be
 * the same injury with a nicer excuse, and a notification about a video that
 * is not there is the same injury pointed at him.
 *
 * ## Why the answer still comes back before the attachment
 *
 * An ffmpeg pass over a 12-15 MB clip takes real seconds; `RenderService`
 * already establishes that a turn which blocks is the Commander watching a
 * cursor. So `compose` returns a `pending` sending and the compression
 * continues behind it — the same shape `backend/src/jobs/` uses. The wait is
 * now seconds rather than the minutes it used to be, because the render itself
 * is already done by the time anything here runs.
 *
 * ## Why a failure is always recorded
 *
 * Every path out of the detached work ends in `attachVideo` or `markFailed`.
 * A sending left saying `pending` forever is the render-shaped version of a
 * dropped reminder — she told him something was coming and it never came, and
 * nothing anywhere says so.
 *
 * **That covers this process and not a restart**, which is the one case the
 * sentence above cannot reach: the promise chasing the video lives in memory,
 * so a crash between the row and its settlement takes the only thing that was
 * going to settle it. {@link SendingService.resume} is the other half, called
 * from `bootstrap` for every `pending` row, and the two together are what make
 * "never left claiming a video is coming" true rather than nearly true.
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
   * @throws {SendingStoreError} for anything wrong with the WORDS — blank
   * text, no reason, no render named — and for a RENDER that is not finished:
   * a name that resolves to nothing, a clip still going, a clip that failed.
   * Every one of those is checked before a message is appended, so a refusal
   * leaves nothing behind and nothing reaches him. Once past those checks,
   * nothing about the video throws from here.
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

    // ---- 0. The render, which must already be finished. --------------------
    //
    // Before anything is written. A refusal here leaves no message, no row and
    // no notification — which is the whole of the Commander's ruling: the
    // decision to send happens after she has seen the finished render, so
    // there is no path through this method that puts something in front of him
    // about a video that does not exist yet.
    const record = this.#resolve(renderName);

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

    // ---- 4/5. The video, then the push it carries. -------------------------
    //
    // The record resolved above is handed on rather than looked up again, so
    // the clip this sending is made from is the clip that was checked. Two
    // reads could disagree, and the second one is the one nobody would see.
    this.#follow(sending, renderName, record);
    return sending;
  }

  /**
   * Pick up sendings a restart interrupted.
   *
   * `RenderService.resume()`'s shape, called from the same place in
   * `bootstrap`, and it exists for the same reason one layer along. `#follow`
   * is a detached in-process promise and `drain` only survives a **clean**
   * shutdown, so a crash between `create` and `attachVideo`/`markFailed`
   * leaves a row saying `pending` with nothing left to re-drive it. Her words
   * already reached him saying something was coming; without this it never
   * comes and nothing anywhere says so, which is constraint 4 wearing the
   * render's hat.
   *
   * Every pending row goes back to the SAME follower `compose` uses, so there
   * is one place that decides what becomes of a video and this is not a second
   * one. Its verdict covers the three states a render can be in when a process
   * comes back up: still `ready` on disk, so the clip is compressed and
   * attached; gone or `failed`, so the sending is settled `failed` with a
   * sentence; still `rendering`, which `#makeVideo` also settles with a
   * sentence rather than waiting — see the note there for why waiting is
   * refused. What it never does is leave the row claiming a video is coming
   * when nothing is coming.
   *
   * It DOES notify, now that the push is enqueued at the video's settlement
   * rather than with the words. A row stranded `pending` is a row he was never
   * buzzed about, so the recovery pass finishing it is the thing that finally
   * tells him. `idempotencyKey: sending:<id>` is what makes that safe: if the
   * push had somehow already gone out, the outbox writes no second row, so a
   * recovery cannot buzz him twice about one sentence.
   */
  resume(): void {
    for (const sending of this.#sendings.pending()) {
      if (sending.renderName === null) {
        // The store allows a NULL render name. Nothing was ever going to
        // arrive for such a row, so it is settled here rather than handed to a
        // follower that has nothing to look up.
        this.#settleFailed(
          sending.id,
          "This one named no render, so there was never a video coming for it. What I said still stands.",
        );
        continue;
      }
      this.#follow(sending, sending.renderName);
    }
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
   * The render this sending is made from, or a refusal.
   *
   * Every branch out of here that is not `ready` throws, and that is the point:
   * this runs before a message exists, so a refusal costs nothing and reaches
   * nobody. The sentences are hers to say back to him or to herself, so they
   * are sentences rather than codes — and each one names the next move,
   * because "renderName is invalid" is not something she can turn into speech.
   *
   * @throws {SendingStoreError} `unknown_render` or `render_not_ready`.
   */
  #resolve(renderName: string): RenderRecord {
    const record = renderName === "latest" ? this.#renders.latest() : this.#renders.get(renderName);

    if (record === null) {
      throw new SendingStoreError(
        "unknown_render",
        `There is no render called "${renderName}", so there is no face for this to arrive in. ` +
          "Look at what you have made and name one of those.",
      );
    }
    if (record.status === "rendering") {
      throw new SendingStoreError(
        "render_not_ready",
        `"${record.name}" is still rendering, so there is nothing to send yet. Nothing has ` +
          "reached him and nothing is lost — you will be woken to look at it when it is done.",
      );
    }
    if (record.status !== "ready" || record.video === null) {
      throw new SendingStoreError(
        "render_not_ready",
        `"${record.name}" did not finish: ${record.reason ?? "no reason was recorded."} ` +
          "There is no clip to send. Say it to him in words, or make another one.",
      );
    }

    return record;
  }

  /**
   * Enqueue the notification.
   *
   * **Called when the video has settled, never before.** That is the
   * Commander's ruling in one line: a buzz that leads to a video which is
   * still rendering is worse than a buzz that comes after it landed. By the
   * time this runs the row is `ready` with a playable clip on it, or `failed`
   * with a reason — and a failure still buzzes, because the words are already
   * in his conversation by then and silence would leave him a message he is
   * never told about.
   *
   * Keyed on the sending's own id, so a retried settlement — or a recovery
   * pass that finds the row again after a restart — writes one row rather than
   * a second buzz for a sentence he has already read.
   *
   * Never throws. The words are already persisted by the time this runs;
   * failing the video's settlement because the outbox was busy would trade a
   * missing notification for a row left claiming a video is coming.
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
  #follow(sending: Sending, renderName: string, record?: RenderRecord): void {
    const running = this.#makeVideo(sending, renderName, record)
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
   * Every branch ends in `attachVideo` or `#settleFailed`, and both of those
   * end in {@link SendingService.#notify}. No path *through this function*
   * leaves the row `pending` — the way a row survives as `pending` is for the
   * process to die before this runs, which is what
   * {@link SendingService.resume} exists to pick up.
   *
   * `known` is the record `compose` already checked, handed through so the
   * clip that was verified `ready` is the clip that gets compressed. It is
   * absent on the recovery path, which has only a name — and which is the one
   * caller that still has to cope with a render that is missing, unfinished or
   * failed, because those rows predate this process and were written when
   * `compose` still allowed them.
   */
  async #makeVideo(sending: Sending, renderName: string, known?: RenderRecord): Promise<void> {
    const record =
      known ??
      (renderName === "latest" ? this.#renders.latest() : this.#renders.get(renderName));

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

    const ready = this.#sendings.attachVideo(sending.id, attachmentId);

    // NOW he is told, and not one step earlier. There is a playable clip on the
    // row by the time this line runs, so the notification he taps leads to the
    // video rather than to a spinner.
    this.#notify(ready);

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
   * Record that there will be no video, and tell him anyway.
   *
   * The notification still goes out. By the time anything reaches here her
   * words are already in his conversation — `compose` refused every render
   * that was not finished, so the only way to arrive is for the compression or
   * the store to have failed after that — and staying silent would leave him a
   * message he is never told about. The row says why there is no clip; the
   * buzz says there is something to read.
   *
   * Swallows its own failure on purpose: this runs inside a detached promise
   * and is frequently the handler for an earlier failure. Throwing here would
   * replace a legible "no video, and here is why" with an unhandled rejection.
   */
  #settleFailed(id: string, reason: string): void {
    let failed: Sending;
    try {
      failed = this.#sendings.markFailed(id, reason);
    } catch (error) {
      this.#log(`could not record the failure of sending ${id}`, error);
      return;
    }
    this.#notify(failed);
  }
}

// Re-exported so a caller catching a refusal from `compose` does not have to
// import from two modules to name what it caught.
export { SendingStoreError };
