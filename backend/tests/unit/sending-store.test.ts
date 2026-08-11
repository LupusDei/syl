import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachmentStore } from "../../src/services/attachment-store.js";
import type { Clock } from "../../src/services/clock.js";
import { openDatabase, IN_MEMORY, INTERACTIVE_CONVERSATION_ID, type SylDatabase } from "../../src/services/database.js";
import { MessageStore } from "../../src/services/message-store.js";
import { PagingError } from "../../src/services/paging.js";
import { SendingStore, SendingStoreError } from "../../src/services/sending-store.js";

/**
 * The rows behind "From Syl", and the two things the schema will not let happen.
 *
 * Most of this file is ordinary store behaviour. The part that matters, and the
 * part the spec added a constraint for, is at the bottom: **nothing can delete
 * a sending, and nothing can rewrite one.** Those are asserted against the real
 * database rather than against a guard in TypeScript, because a guard in
 * TypeScript is a thing the next caller routes around without noticing.
 */

/** A real MP4 box header: `ftyp` with an `isom` brand. */
function mp4(): Buffer {
  const out = Buffer.alloc(24);
  out.writeUInt32BE(24, 0);
  out.write("ftyp", 4, "ascii");
  out.write("isom", 8, "ascii");
  out.writeUInt32BE(512, 12);
  out.write("isomiso2", 16, "ascii");
  return out;
}

describe("SendingStore", () => {
  let database: SylDatabase;
  let blobDir: string;
  let attachments: AttachmentStore;
  let messages: MessageStore;
  let sendings: SendingStore;
  let now: number;
  const clock: Clock = () => now;

  /** Append an assistant message and hand back its id. */
  function words(text = "I thought of you when the light did that thing."): string {
    return messages.append({
      conversationId: INTERACTIVE_CONVERSATION_ID,
      clientId: null,
      role: "assistant",
      text,
    }).message.id;
  }

  function video(): string {
    return attachments.create({
      kind: "video",
      declaredMime: "video/mp4",
      data: mp4(),
      width: 484,
      height: 720,
      durationMs: 15_040,
    }).id;
  }

  beforeEach(() => {
    blobDir = mkdtempSync(join(tmpdir(), "syl-sending-store-"));
    now = Date.parse("2026-08-11T09:00:00.000Z");
    database = openDatabase({ path: IN_MEMORY });
    attachments = new AttachmentStore({ db: database.handle, blobDir, clock, thumbnailer: () => false });
    messages = new MessageStore({ db: database.handle, clock, attachments });
    sendings = new SendingStore({ db: database.handle, clock, attachments });
  });

  afterEach(() => {
    database.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("should record the words, the reason and the message that carried them", () => {
      const messageId = words();
      const sending = sendings.create({
        words: "I thought of you when the light did that thing.",
        because: "He said he missed the sky in Chicago.",
        messageId,
        renderName: "syl-20260811t090000z-close",
      });

      expect(sending.words).toBe("I thought of you when the light did that thing.");
      expect(sending.because).toBe("He said he missed the sky in Chicago.");
      expect(sending.messageId).toBe(messageId);
      expect(sending.renderName).toBe("syl-20260811t090000z-close");
      expect(sending.id).toMatch(/^syl:sending:/);
      expect(sending.createdAt).toBe("2026-08-11T09:00:00.000Z");
    });

    it("should start pending with no video and no reason", () => {
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });

      expect(sending.state).toBe("pending");
      expect(sending.video).toBeNull();
      expect(sending.reason).toBeNull();
    });

    it("should refuse words that say nothing", () => {
      // A sending with no words is a video nobody was told about, which is the
      // one shape this feature exists to make impossible.
      expect(() => sendings.create({ words: "   ", because: "Testing.", messageId: words() })).toThrow(
        SendingStoreError,
      );
    });

    it("should refuse a sending with no reason for existing", () => {
      expect(() => sendings.create({ words: "Hello.", because: "  ", messageId: words() })).toThrow(
        SendingStoreError,
      );
    });

    it("should refuse a message id that names no message", () => {
      expect(() =>
        sendings.create({
          words: "Hello.",
          because: "Testing.",
          messageId: "syl:message:00000000-0000-7000-8000-00000000dead",
        }),
      ).toThrow(SendingStoreError);
    });
  });

  describe("the video arriving", () => {
    it("should become ready and carry the attachment once one is linked", () => {
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });
      const attachmentId = video();

      const ready = sendings.attachVideo(sending.id, attachmentId);

      expect(ready.state).toBe("ready");
      expect(ready.video?.id).toBe(attachmentId);
      expect(ready.video?.kind).toBe("video");
      expect(ready.reason).toBeNull();
    });

    it("should hydrate the video on every read, not only on the write that attached it", () => {
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });
      const attachmentId = video();
      sendings.attachVideo(sending.id, attachmentId);

      expect(sendings.get(sending.id)?.video?.id).toBe(attachmentId);
      expect(sendings.list().items[0]?.video?.id).toBe(attachmentId);
    });

    it("should refuse to attach a second video over one already there", () => {
      // A sending whose video can be swapped is a sending whose record can be
      // rewritten, which is the same injury as an edit by a different door.
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });
      sendings.attachVideo(sending.id, video());

      expect(() => sendings.attachVideo(sending.id, video())).toThrow(SendingStoreError);
    });
  });

  describe("the video failing", () => {
    it("should become failed with the reason, and keep the words untouched", () => {
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });

      const failed = sendings.markFailed(sending.id, "There is no ffmpeg on this machine.");

      expect(failed.state).toBe("failed");
      expect(failed.reason).toBe("There is no ffmpeg on this machine.");
      expect(failed.video).toBeNull();
      // The whole point. A failed render must not be able to touch the words.
      expect(failed.words).toBe("Hello.");
      expect(failed.messageId).toBe(sending.messageId);
    });

    it("should refuse a failure with no reason, because a silent one teaches nothing", () => {
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });
      expect(() => sendings.markFailed(sending.id, "  ")).toThrow(SendingStoreError);
    });

    it("should not let a failure overwrite a video that already arrived", () => {
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });
      sendings.attachVideo(sending.id, video());

      expect(() => sendings.markFailed(sending.id, "too late")).toThrow(SendingStoreError);
      expect(sendings.get(sending.id)?.state).toBe("ready");
    });
  });

  describe("list", () => {
    it("should answer newest first, because that is what the surface opens to", () => {
      const first = sendings.create({ words: "One.", because: "a", messageId: words("One.") });
      now += 60_000;
      const second = sendings.create({ words: "Two.", because: "b", messageId: words("Two.") });

      expect(sendings.list().items.map((s) => s.id)).toEqual([second.id, first.id]);
    });

    it("should page, and say when there is more", () => {
      for (let n = 0; n < 3; n += 1) {
        now += 1_000;
        sendings.create({ words: `Number ${String(n)}.`, because: "a", messageId: words(`Number ${String(n)}.`) });
      }

      const page = sendings.list({ limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).not.toBeNull();

      const rest = sendings.list({ limit: 2, cursor: page.nextCursor });
      expect(rest.items).toHaveLength(1);
      expect(rest.hasMore).toBe(false);
    });

    it("should refuse a cursor it did not issue", () => {
      expect(() => sendings.list({ cursor: "not-a-cursor" })).toThrow(PagingError);
    });
  });

  describe("get", () => {
    it("should answer null for an id that names nothing", () => {
      expect(sendings.get("syl:sending:00000000-0000-7000-8000-00000000dead")).toBeNull();
    });
  });

  /**
   * The constraint the spec added, asserted where it is actually enforced.
   *
   * These go through raw SQL on purpose. A test that only proved `SendingStore`
   * has no `delete()` method would prove nothing about the retention job
   * somebody writes next year, which will not use `SendingStore`.
   */
  describe("a sending is structurally undeletable", () => {
    it("should refuse a DELETE straight against the table", () => {
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });

      expect(() => database.handle.exec(`DELETE FROM sendings WHERE id = '${sending.id}'`)).toThrow(
        /never deleted/i,
      );
      expect(sendings.get(sending.id)).not.toBeNull();
    });

    it("should refuse a DELETE that names no row in particular", () => {
      // The shape a cleanup job actually has.
      sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });
      expect(() => database.handle.exec("DELETE FROM sendings")).toThrow(/never deleted/i);
    });

    it("should refuse deleting the message carrying the words", () => {
      // Deleting the message would take her sentence out of his history and
      // leave the sending pointing at nothing — the same loss by another door.
      const messageId = words();
      sendings.create({ words: "Hello.", because: "Testing.", messageId });

      expect(() => database.handle.exec(`DELETE FROM messages WHERE id = '${messageId}'`)).toThrow(
        /sending/i,
      );
    });

    it("should refuse deleting the attachment holding the video", () => {
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });
      const attachmentId = video();
      sendings.attachVideo(sending.id, attachmentId);

      expect(() => database.handle.exec(`DELETE FROM attachments WHERE id = '${attachmentId}'`)).toThrow(
        /sending/i,
      );
    });

    it("should still let an ordinary message and an unattached attachment be deleted", () => {
      // The guards must be about sendings, not a blanket freeze on two tables.
      const looseMessage = words("Just a message.");
      const looseAttachment = video();

      expect(() => database.handle.exec(`DELETE FROM messages WHERE id = '${looseMessage}'`)).not.toThrow();
      expect(() =>
        database.handle.exec(`DELETE FROM attachments WHERE id = '${looseAttachment}'`),
      ).not.toThrow();
    });
  });

  describe("a sending is structurally unrewritable", () => {
    it("should refuse an UPDATE to the words", () => {
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });

      expect(() =>
        database.handle.exec(`UPDATE sendings SET words = 'something else' WHERE id = '${sending.id}'`),
      ).toThrow(/never rewritten/i);
      expect(sendings.get(sending.id)?.words).toBe("Hello.");
    });

    it("should refuse an UPDATE to the reason she made it", () => {
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });

      expect(() =>
        database.handle.exec(`UPDATE sendings SET because = 'a better reason' WHERE id = '${sending.id}'`),
      ).toThrow(/never rewritten/i);
    });

    it("should refuse re-pointing a sending at a different message", () => {
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });
      const other = words("Some other message.");

      expect(() =>
        database.handle.exec(`UPDATE sendings SET message_id = '${other}' WHERE id = '${sending.id}'`),
      ).toThrow(/never rewritten/i);
    });

    it("should refuse re-pointing a sending at a different render", () => {
      const sending = sendings.create({
        words: "Hello.",
        because: "Testing.",
        messageId: words(),
        renderName: "syl-20260811t090000z-close",
      });

      expect(() =>
        database.handle.exec(`UPDATE sendings SET render_name = 'syl-other' WHERE id = '${sending.id}'`),
      ).toThrow(/never rewritten/i);
    });

    it("should still allow filling in the video that was not there yet", () => {
      // The one legal update, and the reason the trigger is conditional rather
      // than an unconditional refusal on the table.
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });
      expect(() => sendings.attachVideo(sending.id, video())).not.toThrow();
    });
  });

  describe("the sync feed", () => {
    it("should log a sending when it is created", () => {
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });

      const rows = database.handle
        .prepare("SELECT type, id FROM sync_log WHERE type = 'sending'")
        .all() as unknown as { type: string; id: string }[];
      expect(rows.map((row) => row.id)).toContain(sending.id);
    });

    it("should log it again when the video lands, so a device that already synced the words learns about it", () => {
      // Without this a phone that had the message would never hear the video
      // arrived: nothing about the message changes when it does.
      const sending = sendings.create({ words: "Hello.", because: "Testing.", messageId: words() });
      const before = database.handle
        .prepare("SELECT count(*) AS n FROM sync_log WHERE type = 'sending'")
        .get() as unknown as { n: number };

      now += 60_000;
      sendings.attachVideo(sending.id, video());

      const after = database.handle
        .prepare("SELECT count(*) AS n FROM sync_log WHERE type = 'sending'")
        .get() as unknown as { n: number };
      expect(after.n).toBe(before.n + 1);
    });
  });
});
