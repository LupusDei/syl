import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AttachmentStore,
  MAX_ATTACHMENT_BYTES,
  probeDimensions,
  sniffMime,
  type Thumbnailer,
} from "../../src/services/attachment-store.js";
import { fixedClock } from "../../src/services/clock.js";
import { openDatabase, IN_MEMORY, type SylDatabase } from "../../src/services/database.js";
import { TEST_NOW } from "../helpers/service.js";

/**
 * The blob store, and the six ways it says no.
 *
 * Mined from Adjutant's `upload-storage.ts`, which is the right model because
 * it does the thing that actually matters: it never trusts the declared
 * content type. Everything here is about that seam — bytes in, and either a
 * row that describes them truthfully or a named refusal.
 *
 * The fixtures are real files, built byte by byte from the format
 * specifications rather than from our own `sniffMime`. A "PNG" assembled by
 * calling the function under test would prove only that the function agrees
 * with itself.
 */

/** A real 1x1 PNG. Bytes from the PNG spec: signature, IHDR, IDAT, IEND. */
function png(width = 1, height = 1): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrBody = Buffer.alloc(17);
  ihdrBody.write("IHDR", 0, "ascii");
  ihdrBody.writeUInt32BE(width, 4);
  ihdrBody.writeUInt32BE(height, 8);
  ihdrBody[12] = 8; // bit depth
  ihdrBody[13] = 6; // colour type: RGBA
  const ihdr = Buffer.concat([lengthOf(13), ihdrBody, Buffer.alloc(4)]);
  const idatBody = Buffer.concat([Buffer.from("IDAT", "ascii"), Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])]);
  const idat = Buffer.concat([lengthOf(9), idatBody, Buffer.alloc(4)]);
  const iend = Buffer.concat([lengthOf(0), Buffer.from("IEND", "ascii"), Buffer.alloc(4)]);
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function lengthOf(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

/**
 * A real JPEG header: SOI, a JFIF APP0 segment, then the SOF0 frame.
 *
 * The APP0 is not decoration. A JPEG's dimensions are not at a fixed offset —
 * they sit behind a chain of variable-length segments — so a fixture without
 * one would let a parser that ignores segment lengths pass.
 */
function jpeg(width = 6, height = 4): Buffer {
  const out = Buffer.alloc(32);
  out.writeUInt16BE(0xffd8, 0); // SOI
  out.writeUInt16BE(0xffe0, 2); // APP0
  out.writeUInt16BE(16, 4); // APP0 payload length, so the next marker is at 20
  out.write("JFIF\0", 6, "ascii");
  out.writeUInt16BE(0xffc0, 20); // SOF0
  out.writeUInt16BE(11, 22); // segment length
  out[24] = 8; // sample precision
  out.writeUInt16BE(height, 25);
  out.writeUInt16BE(width, 27);
  out[29] = 3; // component count
  return out;
}

/** A real GIF89a header, dimensions little-endian at offset 6. */
function gif(width = 3, height = 7): Buffer {
  const out = Buffer.alloc(13);
  out.write("GIF89a", 0, "ascii");
  out.writeUInt16LE(width, 6);
  out.writeUInt16LE(height, 8);
  return out;
}

/** A real lossy WebP (`VP8 ` chunk), dimensions at offset 26. */
function webp(width = 9, height = 5): Buffer {
  const out = Buffer.alloc(30);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(22, 4);
  out.write("WEBP", 8, "ascii");
  out.write("VP8 ", 12, "ascii");
  out.writeUInt32LE(10, 16);
  out[20] = 0x00;
  out.writeUIntLE(0x9d012a, 23, 3);
  out.writeUInt16LE(width, 26);
  out.writeUInt16LE(height, 28);
  return out;
}

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

/** A thumbnailer that always succeeds, so the happy path does not need sips. */
const alwaysThumbnails: Thumbnailer = (_source, target) => {
  writeFileSync(target, Buffer.from("thumbnail-bytes"));
  return true;
};

/** A thumbnailer that always declines — every non-macOS machine, and ubuntu CI. */
const neverThumbnails: Thumbnailer = () => false;

/**
 * Let go of a stream this test only wanted the metadata from.
 *
 * The error handler is the point, not the destroy: `createReadStream` starts
 * an asynchronous `open`, and a `destroy()` that lands first still lets the
 * `ENOENT` from the temp directory's teardown surface — as an *unhandled*
 * error, which vitest reports outside any test and which therefore cannot be
 * attributed to one. The route attaches the same handler for the same reason.
 */
function close(opened: { readonly stream: { on: (event: string, fn: () => void) => unknown; destroy: () => void } } | null): void {
  opened?.stream.on("error", () => undefined);
  opened?.stream.destroy();
}

describe("AttachmentStore", () => {
  let directory: string;
  let db: SylDatabase;

  const build = (thumbnailer: Thumbnailer = alwaysThumbnails): AttachmentStore =>
    new AttachmentStore({
      db: db.handle,
      clock: fixedClock(TEST_NOW),
      blobDir: directory,
      thumbnailer,
    });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "syl-attachments-"));
    db = openDatabase({ path: IN_MEMORY });
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  describe("sniffMime", () => {
    it("should recognise every type on the allowlist from its magic bytes", () => {
      expect(sniffMime(png())).toBe("image/png");
      expect(sniffMime(jpeg())).toBe("image/jpeg");
      expect(sniffMime(gif())).toBe("image/gif");
      expect(sniffMime(webp())).toBe("image/webp");
      expect(sniffMime(mp4())).toBe("video/mp4");
    });

    it("should refuse a file whose bytes match nothing on the allowlist", () => {
      // An HTML page named `.png` is the shape of the attack this exists for.
      expect(sniffMime(Buffer.from("<html><script>alert(1)</script>", "utf8"))).toBeNull();
      // A GIF header that is nearly right. Adjutant's first version took the
      // four bytes `GIF8` and accepted this.
      expect(sniffMime(Buffer.from("GIF8xa", "ascii"))).toBeNull();
    });

    it("should refuse a truncated file rather than guessing", () => {
      expect(sniffMime(Buffer.alloc(0))).toBeNull();
      expect(sniffMime(png().subarray(0, 4))).toBeNull();
    });
  });

  describe("probeDimensions", () => {
    it("should read an image's own header rather than believing the uploader", () => {
      expect(probeDimensions(png(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
      expect(probeDimensions(jpeg(6, 4), "image/jpeg")).toEqual({ width: 6, height: 4 });
      expect(probeDimensions(gif(3, 7), "image/gif")).toEqual({ width: 3, height: 7 });
      expect(probeDimensions(webp(9, 5), "image/webp")).toEqual({ width: 9, height: 5 });
    });

    it("should return null for a video, which would need a demuxer", () => {
      expect(probeDimensions(mp4(), "video/mp4")).toBeNull();
    });

    it("should return null rather than throw on a header it cannot parse", () => {
      // A PNG signature with no IHDR. Truncation must not take the route down.
      expect(probeDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png")).toBeNull();
    });
  });

  describe("create", () => {
    it("should store an image, sniff its type, and read its dimensions from the file", () => {
      const store = build();
      const attachment = store.create({
        kind: "image",
        declaredMime: "image/png",
        data: png(320, 200),
        // Deliberately wrong. The file is the authority about itself.
        width: 1,
        height: 1,
      });

      expect(attachment.kind).toBe("image");
      expect(attachment.mimeType).toBe("image/png");
      expect(attachment.width).toBe(320);
      expect(attachment.height).toBe(200);
      expect(attachment.durationMs).toBeNull();
      expect(attachment.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(attachment.id).toMatch(/^syl:attachment:/u);
      expect(attachment.createdAt).toBe(new Date(TEST_NOW).toISOString());
    });

    it("should take a video's dimensions and duration on trust, having no demuxer", () => {
      const attachment = build().create({
        kind: "video",
        declaredMime: "video/mp4",
        data: mp4(),
        width: 1920,
        height: 1080,
        durationMs: 4200,
      });

      expect(attachment.kind).toBe("video");
      expect(attachment.mimeType).toBe("video/mp4");
      expect(attachment.width).toBe(1920);
      expect(attachment.durationMs).toBe(4200);
      // R4: no poster frame without ffmpeg. See the store's own note.
      expect(attachment.hasThumbnail).toBe(false);
    });

    it("should write the bytes under a server-generated name that cannot escape the directory", () => {
      const store = build();
      const attachment = store.create({ kind: "image", declaredMime: "image/png", data: png() });
      const row = store.get(attachment.id);

      expect(row?.storedName).toMatch(/^[0-9a-f-]{36}\.png$/u);
      expect(readFileSync(join(directory, row?.storedName ?? ""))).toEqual(png());
    });

    it("should refuse an empty upload", () => {
      expect(() => build().create({ kind: "image", declaredMime: "image/png", data: Buffer.alloc(0) }))
        .toThrowError(expect.objectContaining({ code: "empty" }));
    });

    it("should refuse an upload past the ceiling", () => {
      const store = new AttachmentStore({
        db: db.handle,
        clock: fixedClock(TEST_NOW),
        blobDir: directory,
        thumbnailer: alwaysThumbnails,
        maxBytes: 32,
      });
      expect(() => store.create({ kind: "image", declaredMime: "image/png", data: png(1000, 1000) }))
        .toThrowError(expect.objectContaining({ code: "too-large" }));
    });

    it("should refuse a file whose bytes are not on the allowlist, whatever it claims to be", () => {
      expect(() =>
        build().create({
          kind: "image",
          declaredMime: "image/png",
          data: Buffer.from("<svg onload=alert(1)>", "utf8"),
        }),
      ).toThrowError(expect.objectContaining({ code: "unsupported-type" }));
    });

    it("should refuse a file whose magic bytes disagree with the declared type", () => {
      expect(() => build().create({ kind: "image", declaredMime: "image/jpeg", data: png() }))
        .toThrowError(expect.objectContaining({ code: "mime-mismatch" }));
    });

    it("should refuse a video's bytes declared as an image", () => {
      // `kind` drives which UI renders it. A video in an `<img>` is a broken
      // bubble; a `mime-mismatch` would be the wrong diagnosis for it.
      expect(() =>
        build().create({ kind: "image", declaredMime: "video/mp4", data: mp4(), width: 4, height: 4 }),
      ).toThrowError(expect.objectContaining({ code: "kind-mismatch" }));
    });

    it("should refuse a video that declares no dimensions, rather than storing zeroes", () => {
      expect(() => build().create({ kind: "video", declaredMime: "video/mp4", data: mp4(), durationMs: 10 }))
        .toThrowError(expect.objectContaining({ code: "dimensions-unknown" }));
    });

    it("should refuse a video that declares no duration", () => {
      expect(() =>
        build().create({ kind: "video", declaredMime: "video/mp4", data: mp4(), width: 4, height: 4 }),
      ).toThrowError(expect.objectContaining({ code: "duration-unknown" }));
    });

    it("should leave no blob behind when validation refuses the upload", () => {
      const store = build();
      expect(() => store.create({ kind: "image", declaredMime: "image/jpeg", data: png() })).toThrow();
      expect(store.list().length).toBe(0);
    });
  });

  describe("thumbnails", () => {
    it("should generate one on upload and serve it as a variant", () => {
      const store = build(alwaysThumbnails);
      const attachment = store.create({ kind: "image", declaredMime: "image/png", data: png(400, 300) });

      expect(attachment.hasThumbnail).toBe(true);
      const opened = store.open(attachment.id, "thumb");
      expect(opened?.mimeType).toBe("image/jpeg");
      expect(opened?.bytes).toBe("thumbnail-bytes".length);
      close(opened);
    });

    it("should still store the image when no thumbnailer is available", () => {
      // ubuntu CI, and any machine without `sips`. A missing preview must
      // degrade to "fetch the original", never to a failed upload.
      const store = build(neverThumbnails);
      const attachment = store.create({ kind: "image", declaredMime: "image/png", data: png() });

      expect(attachment.hasThumbnail).toBe(false);
      const opened = store.open(attachment.id, "original");
      expect(opened).not.toBeNull();
      close(opened);
    });

    it("should discard a thumbnail that came out no smaller than the original", () => {
      // Not a hypothetical. Downscaling re-encodes as JPEG, and JPEG is dear
      // for exactly the images PNG is cheap for — screenshots of text, flat
      // UI, line art. Measured on a 1200x900 synthetic PNG, `sips` produced a
      // "thumbnail" fourteen times larger than the file it previewed. A
      // preview that costs more than its subject defeats the entire point.
      const fat: Thumbnailer = (_source, target) => {
        writeFileSync(target, Buffer.alloc(1024 * 1024));
        return true;
      };
      const store = build(fat);
      const attachment = store.create({ kind: "image", declaredMime: "image/png", data: png(4, 4) });

      expect(attachment.hasThumbnail).toBe(false);
      expect(store.open(attachment.id, "thumb")).toBeNull();
    });

    it("should answer nothing for a thumbnail that does not exist rather than the full file", () => {
      // A silent fallback turns a 60 KB request into a 4 MB one, invisibly, on
      // the connection least able to afford it.
      const store = build(neverThumbnails);
      const attachment = store.create({ kind: "image", declaredMime: "image/png", data: png() });

      expect(store.open(attachment.id, "thumb")).toBeNull();
    });
  });

  describe("open", () => {
    it("should stream the stored original with its sniffed type", async () => {
      const store = build();
      const attachment = store.create({ kind: "image", declaredMime: "image/png", data: png(8, 8) });
      const opened = store.open(attachment.id, "original");

      expect(opened?.mimeType).toBe("image/png");
      expect(opened?.bytes).toBe(png(8, 8).length);
      const chunks: Buffer[] = [];
      for await (const chunk of opened?.stream ?? []) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks)).toEqual(png(8, 8));
    });

    it("should answer nothing for an id it never issued", () => {
      expect(build().open("syl:attachment:00000000-0000-7000-8000-0000000000ff", "original")).toBeNull();
    });

    it("should answer nothing when the row exists but the blob is gone", () => {
      // A restored database without its blob directory. An honest "not there"
      // beats an exception that reads as a service fault.
      const store = build();
      const attachment = store.create({ kind: "image", declaredMime: "image/png", data: png() });
      rmSync(directory, { recursive: true, force: true });

      expect(store.open(attachment.id, "original")).toBeNull();
    });
  });

  describe("link and forMessages", () => {
    const conversationId = "syl:conversation:00000000-0000-7000-8000-000000000001";

    function seedMessage(id: string, seq: number): string {
      db.handle
        .prepare(
          `INSERT INTO messages (id, conversation_id, client_id, role, text, created_at, seq)
           VALUES (?, ?, NULL, 'assistant', 'here', '2026-08-09T07:00:00.000Z', ?)`,
        )
        .run(id, conversationId, seq);
      return id;
    }

    it("should hand attachments back per message, in the order they were attached", () => {
      const store = build();
      const message = seedMessage("syl:message:00000000-0000-7000-8000-00000000a001", 1);
      const first = store.create({ kind: "image", declaredMime: "image/png", data: png(2, 2) });
      const second = store.create({ kind: "image", declaredMime: "image/gif", data: gif(3, 7) });

      store.link(message, [second.id, first.id]);

      const found = store.forMessages([message]);
      expect(found.get(message)?.map((item) => item.id)).toEqual([second.id, first.id]);
    });

    it("should hand back an empty list for a message with nothing attached", () => {
      const store = build();
      const message = seedMessage("syl:message:00000000-0000-7000-8000-00000000a002", 1);

      expect(store.forMessages([message]).get(message)).toBeUndefined();
      expect(store.forMessages([]).size).toBe(0);
    });

    it("should refuse to attach an id it never issued", () => {
      const store = build();
      const message = seedMessage("syl:message:00000000-0000-7000-8000-00000000a003", 1);

      expect(() => store.link(message, ["syl:attachment:00000000-0000-7000-8000-0000000000ff"]))
        .toThrowError(expect.objectContaining({ code: "unknown-attachment" }));
    });

    it("should refuse to attach one picture to two messages", () => {
      const store = build();
      const first = seedMessage("syl:message:00000000-0000-7000-8000-00000000a004", 1);
      const second = seedMessage("syl:message:00000000-0000-7000-8000-00000000a005", 2);
      const attachment = store.create({ kind: "image", declaredMime: "image/png", data: png() });

      store.link(first, [attachment.id]);
      expect(() => store.link(second, [attachment.id]))
        .toThrowError(expect.objectContaining({ code: "already-attached" }));
    });

    it("should refuse a duplicate inside one link, rather than writing a half-attached message", () => {
      const store = build();
      const message = seedMessage("syl:message:00000000-0000-7000-8000-00000000a006", 1);
      const attachment = store.create({ kind: "image", declaredMime: "image/png", data: png() });

      expect(() => store.link(message, [attachment.id, attachment.id]))
        .toThrowError(expect.objectContaining({ code: "already-attached" }));
      expect(store.forMessages([message]).get(message)).toBeUndefined();
    });
  });

  describe("the ceiling", () => {
    it("should be a stated number rather than whatever the body parser allows", () => {
      // The route's JSON limit is derived from this, not the other way round:
      // a limit that lives only in middleware is one nothing can test.
      expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
    });
  });
});
