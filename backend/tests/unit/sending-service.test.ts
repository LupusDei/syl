import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Message } from "@syl/shared";

import { SylAgent, memorySessionStore } from "../../src/harness/agent.js";
import type { RenderRecord } from "../../src/render/render-service.js";
import { AttachmentStore } from "../../src/services/attachment-store.js";
import type { Clock } from "../../src/services/clock.js";
import { openDatabase, IN_MEMORY, INTERACTIVE_CONVERSATION_ID, type SylDatabase } from "../../src/services/database.js";
import { ConversationService } from "../../src/services/conversation-service.js";
import { MessageStore } from "../../src/services/message-store.js";
import { Outbox } from "../../src/services/outbox.js";
import type { CompressOptions, CompressResult } from "../../src/services/sending-media.js";
import { SendingService, type RenderSource } from "../../src/services/sending-service.js";
import { SendingStore } from "../../src/services/sending-store.js";

/**
 * A sending, composed.
 *
 * Every test in this file is really one test asked in different ways:
 *
 * > **Can anything that happens to the video stop the words reaching him?**
 *
 * The answer has to be no, for a render that does not exist, a render still
 * going, a machine with no ffmpeg, a compression that overshoots, and a store
 * that refuses the bytes. So each of those is a case below, and each asserts
 * the same two things — the message is in the conversation, and the push
 * carries her sentence.
 *
 * Nothing here spends a credit or reaches the network: the render source and
 * the compressor are both injected.
 */

/** A real JPEG, small enough to be worth keeping as a poster. */
function jpeg(): Buffer {
  const out = Buffer.alloc(32);
  out.writeUInt16BE(0xffd8, 0);
  out.writeUInt16BE(0xffe0, 2);
  out.writeUInt16BE(16, 4);
  out.write("JFIF\0", 6, "ascii");
  out.writeUInt16BE(0xffc0, 20);
  out.writeUInt16BE(11, 22);
  out[24] = 8;
  out.writeUInt16BE(480, 25);
  out.writeUInt16BE(320, 27);
  out[29] = 3;
  return out;
}

/** A real MP4 box header, padded to a plausible clip size. */
function mp4(bytes = 64 * 1024): Buffer {
  const head = Buffer.alloc(24);
  head.writeUInt32BE(24, 0);
  head.write("ftyp", 4, "ascii");
  head.write("isom", 8, "ascii");
  head.writeUInt32BE(512, 12);
  head.write("isomiso2", 16, "ascii");
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - 24))]);
}

function readyRender(overrides: Partial<RenderRecord> = {}): RenderRecord {
  return {
    name: "syl-20260811t090000z-close",
    status: "ready",
    renderedAt: "2026-08-11T09:02:00.000Z",
    taskId: "task-1",
    model: "seedance2",
    ratio: "720:1280",
    duration: 15,
    reference: "reference/syl.png",
    framing: "close_portrait",
    prompt: "a luminous spirit woman…",
    scene: "turning toward him as the light moves through her",
    holdsLikeness: true,
    because: "he said he missed the sky",
    startedAt: "2026-08-11T09:00:00.000Z",
    reason: null,
    credits: 600,
    usd: 6,
    video: "/studio/videos/syl-20260811t090000z-close.mp4",
    ...overrides,
  } as RenderRecord;
}

/**
 * An agent that would throw if a turn were ever run.
 *
 * `ConversationService` needs one, and a sending must never cause a turn: the
 * words are appended as `role: "assistant"`, and `accept` publishes those and
 * returns without queueing anything. If that ever changes, Syl starts
 * answering herself, and this is what makes that show up as a failure rather
 * than as a mysterious extra message.
 */
function unusedAgent(): SylAgent {
  return new SylAgent({
    store: memorySessionStore(),
    runner: () => {
      throw new Error("a sending must never run a turn");
    },
  });
}

describe("SendingService", () => {
  let database: SylDatabase;
  let blobDir: string;
  let workDir: string;
  let attachments: AttachmentStore;
  let messages: MessageStore;
  let chat: ConversationService;
  let sendings: SendingStore;
  let outbox: Outbox;
  let service: SendingService;
  let published: Message[];
  let now: number;
  const clock: Clock = () => now;

  /** The compressor, standing in for ffmpeg. Overridden per test. */
  let compress: (options: CompressOptions) => Promise<CompressResult>;
  /** What `renders.get` answers. Overridden per test. */
  let renders: RenderSource;

  function build(): SendingService {
    return new SendingService({
      sendings,
      chat,
      attachments,
      outbox,
      renders,
      workDir,
      compress: (options) => compress(options),
      log: () => undefined,
    });
  }

  beforeEach(() => {
    blobDir = mkdtempSync(join(tmpdir(), "syl-sending-blobs-"));
    workDir = mkdtempSync(join(tmpdir(), "syl-sending-work-"));
    now = Date.parse("2026-08-11T09:05:00.000Z");
    published = [];
    database = openDatabase({ path: IN_MEMORY });
    attachments = new AttachmentStore({ db: database.handle, blobDir, clock, thumbnailer: () => false });
    messages = new MessageStore({ db: database.handle, clock, attachments });
    // The real seam. `ws-server.ts` subscribes to exactly this in production,
    // so capturing here is capturing what a connected phone would receive.
    chat = new ConversationService({ messages, agent: unusedAgent(), log: () => undefined });
    chat.setSink((message) => published.push(message));
    sendings = new SendingStore({ db: database.handle, clock, attachments });
    outbox = new Outbox({ db: database.handle, clock });

    renders = { get: () => readyRender(), latest: () => readyRender() };
    // Replaced in every test that gets as far as the video. The default just
    // refuses, so a test that forgot to set one fails loudly rather than
    // reading a file nobody wrote.
    compress = async () => ({ ok: false, reason: "no compressor was set for this test" });

    service = build();
  });

  afterEach(async () => {
    // Drained before the directories go. The video is a DETACHED promise by
    // design — that is the feature — so a test which only asserts on the words
    // legitimately returns with one still running, and tearing the blob
    // directory out from under it surfaces as an unhandled ENOENT attributed
    // to no test at all.
    await service.drain();
    database.close();
    rmSync(blobDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  /**
   * A compressor that writes real bytes where the real one would.
   *
   * Into `options.outDir` — which the service sets to `workDir/<sendingId>` —
   * rather than somewhere this test picked, so the scratch-reaping assertion
   * is about the directory production actually uses.
   */
  function compressorWriting(bytes: Buffer): (options: CompressOptions) => Promise<CompressResult> {
    return async (options) => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(options.outDir, { recursive: true });
      const path = join(options.outDir, "sending.mp4");
      writeFileSync(path, bytes);
      return {
        ok: true,
        path,
        bytes: bytes.length,
        width: 484,
        height: 720,
        durationMs: 15_040,
        poster: jpeg(),
      };
    };
  }

  describe("the words", () => {
    it("should reach the conversation as an assistant message before any video work", async () => {
      compress = compressorWriting(mp4());
      const sending = await service.compose({
        words: "I thought of you when the light did that thing.",
        because: "He said he missed the sky.",
        renderName: "syl-20260811t090000z-close",
      });

      const message = messages.get(sending.messageId);
      expect(message).not.toBeNull();
      expect(message?.role).toBe("assistant");
      expect(message?.text).toBe("I thought of you when the light did that thing.");
      expect(message?.conversationId).toBe(INTERACTIVE_CONVERSATION_ID);
    });

    it("should put the message on the wire so an attached client sees it at once", async () => {
      compress = compressorWriting(mp4());
      const sending = await service.compose({
        words: "Hello.",
        because: "Testing.",
        renderName: "latest",
      });

      expect(published.map((m) => m.id)).toContain(sending.messageId);
    });

    it("should carry HER SENTENCE in the push, never a notice about the app", async () => {
      compress = compressorWriting(mp4());
      await service.compose({
        words: "The rain stopped and I wanted you to know.",
        because: "He was worried about the drive.",
        renderName: "latest",
      });
      // Drained, because the push now follows the video rather than running
      // ahead of it. See "the push waits for the video" below.
      await service.drain();

      const delivery = outbox.list().items[0];
      expect(delivery?.payload.body).toBe("The rain stopped and I wanted you to know.");
      // The failure this asserts against by name. A notification saying "Syl
      // sent you a video" is a notification about the app rather than from her.
      expect(delivery?.payload.body).not.toMatch(/sent you a video/i);
      expect(delivery?.payload.title).toBe("Syl");
    });

    it("should enqueue exactly one push per sending, keyed so a retry cannot double it", async () => {
      compress = compressorWriting(mp4());
      const sending = await service.compose({ words: "Hi.", because: "b", renderName: "latest" });
      await service.drain();

      const deliveries = outbox.list().items;
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.idempotencyKey).toContain(sending.id);
    });
  });

  describe("when the video works", () => {
    it("should attach a compressed copy with a poster, and go ready", async () => {
      compress = compressorWriting(mp4());
      const sending = await service.compose({ words: "Hi.", because: "b", renderName: "latest" });
      await service.drain();

      const settled = sendings.get(sending.id);
      expect(settled?.state).toBe("ready");
      expect(settled?.video).not.toBeNull();
      expect(settled?.video?.kind).toBe("video");
      expect(settled?.video?.durationMs).toBe(15_040);
      // The poster is the whole of gap 3: without it the list shows a generic
      // video affordance and the phone fetches the entire clip to draw it.
      expect(settled?.video?.hasThumbnail).toBe(true);
    });

    it("should clear its scratch copy once the bytes are in the store", async () => {
      // The compressed copy exists twice the moment it is created: in the blob
      // directory, where the store owns it, and in the scratch directory,
      // where nothing does. A 2 MB duplicate per sending accumulates on the
      // Commander's own disk forever.
      const { existsSync } = await import("node:fs");
      compress = compressorWriting(mp4());
      const sending = await service.compose({ words: "Hi.", because: "b", renderName: "latest" });
      await service.drain();

      expect(sendings.get(sending.id)?.state).toBe("ready");
      expect(existsSync(join(workDir, sending.id))).toBe(false);
      // And the bytes are still served, from the place that does own them.
      const video = sendings.get(sending.id)?.video;
      const opened = attachments.open(video?.id ?? "", "original");
      expect(opened).not.toBeNull();
      // Let go of it before the temp directory does. `createReadStream` opens
      // asynchronously, so a stream left dangling reports the teardown's
      // ENOENT as an unhandled error attributed to no test at all.
      opened?.stream.on("error", () => undefined);
      opened?.stream.destroy();
    });

    it("should keep the render name as the record", async () => {
      compress = compressorWriting(mp4());
      const sending = await service.compose({
        words: "Hi.",
        because: "b",
        renderName: "syl-20260811t090000z-close",
      });
      await service.drain();

      expect(sendings.get(sending.id)?.renderName).toBe("syl-20260811t090000z-close");
    });

    it("should never hand the compressor the render's own path as an output", async () => {
      // The full-quality render is the record. A compressor invoked with the
      // source as its target would destroy the only unregenerable artefact.
      const seen: string[] = [];
      compress = async (options) => {
        seen.push(options.source);
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(options.outDir, { recursive: true });
        const path = join(options.outDir, "sending.mp4");
        writeFileSync(path, mp4());
        return { ok: true, path, bytes: mp4().length, width: 484, height: 720, durationMs: 15_040, poster: jpeg() };
      };

      await service.compose({ words: "Hi.", because: "b", renderName: "latest" });
      await service.drain();

      expect(seen).toEqual(["/studio/videos/syl-20260811t090000z-close.mp4"]);
    });

    it("should return before the video is done, because a render takes minutes", async () => {
      let release: (() => void) | undefined;
      compress = async (options) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(options.outDir, { recursive: true });
        const path = join(options.outDir, "sending.mp4");
        writeFileSync(path, mp4());
        return { ok: true, path, bytes: mp4().length, width: 484, height: 720, durationMs: 15_040, poster: jpeg() };
      };

      const sending = await service.compose({ words: "Hi.", because: "b", renderName: "latest" });

      // The words are already his, and the answer is already back.
      expect(sending.state).toBe("pending");
      expect(messages.get(sending.messageId)).not.toBeNull();
      // AND HE HAS NOT BEEN BUZZED. The Commander's ruling: a notification that
      // runs ahead of the video leads him to a spinner. The render was finished
      // before `compose` would run at all, so this is a wait of seconds rather
      // than the minutes it used to be — but it is still a wait, and the push
      // is on the far side of it.
      expect(outbox.list().items).toHaveLength(0);

      release?.();
      await service.drain();
      expect(sendings.get(sending.id)?.state).toBe("ready");
      expect(outbox.list().items).toHaveLength(1);
    });
  });

  /**
   * The Commander's ruling, 2026-08-11, and the reason this file changed shape.
   *
   * > *"It sounds like the push notification goes out, regardless of whether a
   * > video was created or not — that seems a little bit backwards to me."*
   *
   * Two halves, and both are asserted here rather than left to the job that
   * arranges the looking: **a render that is not finished cannot be composed
   * at all**, and **the push is enqueued when the video settles**. Together
   * they make "he is never buzzed about a video that is not there" a property
   * of this class rather than a rule the caller has to keep.
   */
  describe("nothing reaches him before the video does", () => {
    it("should refuse a render that is still going, without writing anything", async () => {
      renders = {
        get: () => readyRender({ status: "rendering", video: null, renderedAt: null }),
        latest: () => readyRender({ status: "rendering", video: null, renderedAt: null }),
      };
      service = build();
      const before = messages.list(INTERACTIVE_CONVERSATION_ID).items.length;

      await expect(
        service.compose({ words: "Look.", because: "b", renderName: "latest" }),
      ).rejects.toThrow(/still rendering/i);

      // No message, no row, no notification. A refusal here costs nothing and
      // reaches nobody, which is the whole point of doing it first.
      expect(messages.list(INTERACTIVE_CONVERSATION_ID).items).toHaveLength(before);
      expect(sendings.list().items).toHaveLength(0);
      expect(outbox.list().items).toHaveLength(0);
    });

    it("should refuse a render that failed, and say why in a sentence", async () => {
      renders = {
        get: () =>
          readyRender({ status: "failed", video: null, reason: "Runway ended this render as FAILED." }),
        latest: () =>
          readyRender({ status: "failed", video: null, reason: "Runway ended this render as FAILED." }),
      };
      service = build();

      await expect(
        service.compose({ words: "Look.", because: "b", renderName: "latest" }),
      ).rejects.toThrow(/Runway ended this render as FAILED/);
      expect(outbox.list().items).toHaveLength(0);
    });

    it("should refuse a render name that resolves to nothing", async () => {
      // Her mistake, not his problem. She named a render she does not have, so
      // she is told so and can name the right one — rather than his phone
      // buzzing about a video nobody could ever have found.
      renders = { get: () => null, latest: () => null };
      service = build();

      await expect(
        service.compose({ words: "I made you something.", because: "b", renderName: "syl-nope" }),
      ).rejects.toThrow(/no render called/i);
      expect(sendings.list().items).toHaveLength(0);
      expect(outbox.list().items).toHaveLength(0);
    });

    it("should buzz him once the clip is actually on the row", async () => {
      compress = compressorWriting(mp4());
      const sending = await service.compose({ words: "Here.", because: "b", renderName: "latest" });
      await service.drain();

      expect(sendings.get(sending.id)?.state).toBe("ready");
      expect(outbox.list().items).toHaveLength(1);
      expect(outbox.list().items[0]?.payload.body).toBe("Here.");
    });

    it("should still buzz him when the compression fails, because the words are already his", async () => {
      // The one case where a notification accompanies no video, and it is the
      // right answer: `compose` already verified the render, so the only way
      // here is for the derived copy to have failed AFTER her words reached his
      // conversation. Silence would leave him a message he is never told about.
      compress = async () => ({ ok: false, reason: "I could not compress that render: ffmpeg ENOENT" });

      const sending = await service.compose({ words: "Here.", because: "b", renderName: "latest" });
      await service.drain();

      expect(sendings.get(sending.id)?.state).toBe("failed");
      expect(outbox.list().items).toHaveLength(1);
      expect(outbox.list().items[0]?.payload.body).toBe("Here.");
    });
  });

  /**
   * The heart of it. Three ways the video can fail once the render itself was
   * finished, and in every one the words must already be his.
   *
   * There used to be five. The two that are gone — a render that was still
   * going, and one that had failed — are no longer reachable from `compose`:
   * they are refused before a message exists, because a notification about a
   * video that does not exist is worse than no notification at all. They are
   * asserted as refusals in "nothing reaches him before the video does". What
   * remains is everything that can only go wrong AFTER she looked at a finished
   * clip and decided to send it, and for those the old rule stands exactly:
   * **the words are never contingent on the video.**
   */
  describe("when the video does not work, the words still stand", () => {
    /** Assert the invariant that this whole feature is built around. */
    function expectWordsDelivered(sending: { messageId: string }, words: string): void {
      expect(messages.get(sending.messageId)?.text).toBe(words);
      expect(outbox.list().items[0]?.payload.body).toBe(words);
    }

    it("should still deliver the words when there is no ffmpeg to compress with", async () => {
      compress = async () => ({ ok: false, reason: "I could not compress that render: ffmpeg ENOENT" });

      const sending = await service.compose({ words: "Here.", because: "b", renderName: "latest" });
      await service.drain();

      expectWordsDelivered(sending, "Here.");
      expect(sendings.get(sending.id)?.state).toBe("failed");
      expect(sendings.get(sending.id)?.reason).toMatch(/ffmpeg/i);
    });

    it("should still deliver the words when the store refuses the compressed bytes", async () => {
      // Not hypothetical: an overshooting encode lands over the ceiling and
      // `AttachmentStore` says `too-large`. That must not reach back to chat.
      compress = compressorWriting(Buffer.from("not a video at all", "utf8"));

      const sending = await service.compose({ words: "Take a look.", because: "b", renderName: "latest" });
      await service.drain();

      expectWordsDelivered(sending, "Take a look.");
      expect(sendings.get(sending.id)?.state).toBe("failed");
      expect(sendings.get(sending.id)?.reason).not.toBeNull();
    });

    it("should still deliver the words when the compressor throws outright", async () => {
      compress = async () => {
        throw new Error("something nobody predicted");
      };

      const sending = await service.compose({ words: "Still here.", because: "b", renderName: "latest" });
      await service.drain();

      expectWordsDelivered(sending, "Still here.");
      expect(sendings.get(sending.id)?.state).toBe("failed");
    });

    it("should never leave a sending stuck pending after a failure", async () => {
      // A row that says `pending` forever is the render-shaped version of a
      // dropped reminder: she told him something was coming that never was.
      compress = async () => {
        throw new Error("boom");
      };

      const sending = await service.compose({ words: "Hi.", because: "b", renderName: "latest" });
      await service.drain();

      expect(sendings.get(sending.id)?.state).not.toBe("pending");
    });
  });

  describe("refusals that happen before anything is written", () => {
    it("should refuse words that say nothing, without appending a message", async () => {
      const before = messages.list(INTERACTIVE_CONVERSATION_ID).items.length;
      await expect(service.compose({ words: "   ", because: "b", renderName: "latest" })).rejects.toThrow();
      expect(messages.list(INTERACTIVE_CONVERSATION_ID).items).toHaveLength(before);
    });

    it("should refuse a sending with no reason for existing, without appending a message", async () => {
      const before = messages.list(INTERACTIVE_CONVERSATION_ID).items.length;
      await expect(service.compose({ words: "Hello.", because: " ", renderName: "latest" })).rejects.toThrow();
      expect(messages.list(INTERACTIVE_CONVERSATION_ID).items).toHaveLength(before);
    });

    it("should refuse a sending with no render named", async () => {
      // A sending is she says something and the form it takes is her own face.
      // Words with no face is an ordinary message.
      await expect(service.compose({ words: "Hello.", because: "b", renderName: "  " })).rejects.toThrow();
    });
  });

  /**
   * The one state the in-process promise cannot cover: a restart.
   *
   * `#follow` is detached and `drain` only survives a clean shutdown, so a
   * process that dies between `create` and `attachVideo`/`markFailed` leaves a
   * row saying `pending` with nothing left to re-drive it. Her words already
   * reached him saying something was coming, it never comes, and nothing says
   * so — constraint 4 wearing the render's hat.
   *
   * Every row here is built through the STORE rather than through `compose`,
   * deliberately: that is how a crash constructs one, a row that exists with
   * no promise behind it. `resume()` is then called on a service built fresh,
   * which is a restarted process as closely as a unit test can stand in for
   * one. Nothing mocks the follower; the pass is judged on what the data says
   * afterwards.
   */
  describe("a sending stranded pending by a restart", () => {
    /** A row a dead process left behind, with its words already delivered. */
    function stranded(
      words: string,
      renderName: string | null = "syl-20260811t090000z-close",
    ): { readonly id: string; readonly messageId: string } {
      const appended = chat.append({
        conversationId: INTERACTIVE_CONVERSATION_ID,
        clientId: null,
        role: "assistant",
        text: words,
      });
      const row = sendings.create({
        words,
        because: "He said he missed the sky.",
        messageId: appended.message.id,
        renderName,
      });
      expect(row.state).toBe("pending");
      return { id: row.id, messageId: row.messageId };
    }

    /** A restarted process: a new service over the same stores. */
    function restart(): SendingService {
      service = build();
      service.resume();
      return service;
    }

    it("should pick a pending row up on boot and drive it to ready when the render is still there", async () => {
      compress = compressorWriting(mp4());
      const row = stranded("I made you something.");

      await restart().drain();

      const settled = sendings.get(row.id);
      expect(settled?.state).toBe("ready");
      expect(settled?.video).not.toBeNull();
      expect(settled?.video?.hasThumbnail).toBe(true);
    });

    it("should drive a pending row whose render is gone to failed, WITH a sentence", async () => {
      // Not merely "not pending". A row moved to `failed` with nothing in
      // `reason` reads as a bug on his screen, and the whole point of settling
      // it is that he is told rather than left waiting.
      renders = { get: () => null, latest: () => null };
      const row = stranded("Look at this.");

      await restart().drain();

      const settled = sendings.get(row.id);
      expect(settled?.state).toBe("failed");
      expect(settled?.reason).toMatch(/no render/iu);
      expect((settled?.reason ?? "").trim().length).toBeGreaterThan(20);
    });

    it("should settle a pending row whose render failed, rather than leave it claiming a video", async () => {
      renders = {
        get: () => readyRender({ status: "failed", video: null, reason: "Runway ended this render as FAILED." }),
        latest: () => readyRender({ status: "failed", video: null, reason: "Runway ended this render as FAILED." }),
      };
      const row = stranded("Here.");

      await restart().drain();

      expect(sendings.get(row.id)?.state).toBe("failed");
      expect(sendings.get(row.id)?.reason).not.toBeNull();
    });

    it("should settle a pending row whose render is still going, so nothing is left claiming a video", async () => {
      // The pass hands the row back to the SAME follower `compose` uses, and
      // that follower's verdict on a render still in flight is a settled
      // failure with a sentence — see `#makeVideo`. It deliberately does not
      // wait: waiting would make `pending` mean two different things, and this
      // is the pass that has to tell them apart.
      renders = {
        get: () => readyRender({ status: "rendering", video: null, renderedAt: null }),
        latest: () => readyRender({ status: "rendering", video: null, renderedAt: null }),
      };
      const row = stranded("Nearly.");

      await restart().drain();

      expect(sendings.get(row.id)?.state).not.toBe("pending");
      expect(sendings.get(row.id)?.reason).toMatch(/still rendering/iu);
    });

    it("should settle a pending row that named no render at all", async () => {
      // The store allows a NULL `render_name`; nothing is ever coming for such
      // a row, so leaving it pending would be the same lie by omission.
      const row = stranded("Just this.", null);

      await restart().drain();

      expect(sendings.get(row.id)?.state).toBe("failed");
      expect(sendings.get(row.id)?.reason).not.toBeNull();
    });

    it("should leave a ready row and a failed row exactly as it found them", async () => {
      compress = compressorWriting(mp4());
      const done = await service.compose({ words: "Done.", because: "b", renderName: "latest" });
      await service.drain();
      const gone = stranded("Failed.");
      sendings.markFailed(gone.id, "There is no render by that name.");
      // And one genuinely stranded row, so the pass has work to do rather than
      // passing this test by finding nothing at all.
      stranded("Still waiting.");

      const before = { done: sendings.get(done.id), gone: sendings.get(gone.id) };
      expect(before.done?.state).toBe("ready");
      // A later clock, so a pass that rewrote a settled row would move
      // `updatedAt` and be visible rather than idempotent-looking.
      now += 60_000;

      await restart().drain();

      expect(sendings.get(done.id)).toEqual(before.done);
      expect(sendings.get(gone.id)).toEqual(before.gone);
    });

    it("should never touch the words, the reason for them, or the message that carried them", async () => {
      // Said on purpose rather than left implicit: `sendings_never_rewritten`
      // in `0024_sendings.sql` is a BEFORE UPDATE trigger that ABORTS on any
      // change to `words`, `because`, `message_id`, `id` or `created_at`. So a
      // pass that reached the words would not quietly differ here — it would
      // throw out of `markFailed`, the row would stay pending, and the boot
      // would carry a stranded sending anyway. This asserts both halves: the
      // fields are untouched, and the pass settled the row while not touching
      // them.
      renders = { get: () => null, latest: () => null };
      const row = stranded("The exact words she chose.");
      const before = sendings.get(row.id);

      await restart().drain();

      const after = sendings.get(row.id);
      expect(after?.words).toBe(before?.words);
      expect(after?.because).toBe(before?.because);
      expect(after?.messageId).toBe(before?.messageId);
      expect(after?.createdAt).toBe(before?.createdAt);
      expect(after?.state).toBe("failed");
    });

    it("should drive every stranded row, not merely the first one it finds", async () => {
      compress = compressorWriting(mp4());
      const rows = [stranded("One."), stranded("Two."), stranded("Three.")];

      await restart().drain();

      expect(rows.map((row) => sendings.get(row.id)?.state)).toEqual(["ready", "ready", "ready"]);
    });

    it("should buzz him when it finally settles, because nothing buzzed before", async () => {
      // The push is enqueued at the video's SETTLEMENT now, so a row stranded
      // `pending` by a crash is a row he was never notified about. The recovery
      // pass finishing it is the thing that finally tells him — the opposite of
      // what this assertion used to say, and for the reason the Commander
      // overruled: nothing reaches him until there is something to reach him
      // about.
      compress = compressorWriting(mp4());
      stranded("Already read.");

      await restart().drain();

      expect(outbox.list().items).toHaveLength(1);
      expect(outbox.list().items[0]?.payload.body).toBe("Already read.");
    });

    it("should never buzz him twice for one sending, however often it is recovered", async () => {
      // The idempotency property, stated where it is actually load-bearing. The
      // key is derived from the sending's own id, so a second recovery pass —
      // or a retried settlement — writes no second row.
      compress = compressorWriting(mp4());
      const row = stranded("Only once.");

      await restart().drain();
      await restart().drain();

      expect(outbox.list().items).toHaveLength(1);
      expect(outbox.list().items[0]?.idempotencyKey).toContain(row.id);
    });
  });

  describe("a publish that fails", () => {
    it("should not cost the sending, because the message is already persisted", async () => {
      compress = compressorWriting(mp4());
      const brokenSink = new ConversationService({
        messages,
        agent: unusedAgent(),
        log: () => undefined,
      });
      brokenSink.setSink(() => {
        throw new Error("socket is gone");
      });
      const exploding = new SendingService({
        sendings,
        chat: brokenSink,
        attachments,
        outbox,
        renders,
        workDir,
        compress: (options) => compress(options),
        log: () => undefined,
      });

      const sending = await exploding.compose({ words: "Hi.", because: "b", renderName: "latest" });
      await exploding.drain();

      expect(messages.get(sending.messageId)).not.toBeNull();
      expect(sendings.get(sending.id)?.state).toBe("ready");
    });
  });
});
