import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { ReadStream } from "node:fs";
import { join, resolve, sep } from "node:path";

import type { Attachment, AttachmentKind } from "@syl/shared";

import { instant, systemClock, type Clock } from "./clock.js";
import { newId } from "./id.js";
import type { Database } from "./sqlite.js";

/**
 * Images and video: the bytes on disk, and the row that describes them.
 *
 * Mined from Adjutant's `backend/src/services/upload-storage.ts`, which is the
 * right model for one reason above all the others: **it never trusts the
 * declared content type.** Everything else here follows from that. The file's
 * magic bytes decide what it is; the declared type is cross-checked against
 * them and a disagreement is refused rather than resolved; the extension comes
 * from a MIME map and never from a filename; the stored name is generated
 * server-side and cannot contain a separator.
 *
 * `index.ts` used to say, in the comment on its own body-size limit, "Syl
 * exchanges text, not uploads." This module is where that stops being true,
 * and it is therefore the one place in the service where bytes the Commander
 * did not author reach the disk. It is deliberately narrow: no HTTP, no
 * knowledge of messages beyond a foreign key, and every refusal named.
 *
 * ## What this does NOT do, and why that is the safe part
 *
 * **Nothing here ever puts an attachment into a turn's prompt.** The Reader
 * quarantine (`harness/reader.ts`) exists because untrusted content in a
 * context window is a live prompt-injection surface, and an image is untrusted
 * content with a legible surface to paint instructions onto. Storing and
 * serving bytes is not that surface: the bytes go from a client to disk and
 * back to a client, and Claude never sees them. The day something feeds an
 * attachment to a turn, it goes through the quarantine — and that is a
 * decision somebody has to make on purpose, not one this module can leak into.
 */

/**
 * The per-file ceiling: 10 MB.
 *
 * The same number Adjutant chose, for the same reason — it is a screenshot and
 * a short clip, and anything larger is a different problem with a different
 * transport. The upload body is base64, so a file at the ceiling is a ~13.4 MB
 * request; the route's JSON limit is derived from this constant rather than
 * chosen beside it, so the two cannot drift apart.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** How wide a thumbnail's longest edge is, in pixels. */
export const THUMBNAIL_MAX_EDGE = 640;

/** What a thumbnail is, once generated. Always a JPEG, whatever the source. */
export const THUMBNAIL_MIME = "image/jpeg";

/**
 * Every type the service will store, and the extension each is written under.
 *
 * An allowlist, so a format is storable only because somebody added it. The
 * extension comes from this map and never from the client's filename — which
 * is the whole reason a `.php` or a `.command` cannot end up in the blob
 * directory no matter what a caller names its upload.
 */
const MIME_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
} as const;

export type AllowedMime = keyof typeof MIME_TO_EXT;

/** Which `AttachmentKind` each allowed type belongs to. */
const MIME_TO_KIND: Readonly<Record<AllowedMime, AttachmentKind>> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "video/mp4": "video",
  "video/quicktime": "video",
};

/** The only extensions this service will ever emit. */
const ALLOWED_EXTS: ReadonlySet<string> = new Set(Object.values(MIME_TO_EXT));

// ---------------------------------------------------------------------------
// Magic-byte sniffing
// ---------------------------------------------------------------------------

/**
 * What a file actually is, from its leading bytes. `null` when it is nothing
 * this service stores.
 *
 * **Never consults a declared content type.** A caller that has one passes it
 * separately so the two can be compared; there is no parameter here to be
 * tempted by.
 */
export function sniffMime(buffer: Buffer): AllowedMime | null {
  if (hasPngSignature(buffer)) return "image/png";
  if (hasJpegSignature(buffer)) return "image/jpeg";
  if (hasGifSignature(buffer)) return "image/gif";
  if (hasWebpSignature(buffer)) return "image/webp";
  return sniffIsoBmff(buffer);
}

function hasPngSignature(b: Buffer): boolean {
  // 89 50 4E 47 0D 0A 1A 0A
  return (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  );
}

function hasJpegSignature(b: Buffer): boolean {
  // FF D8 FF. Three bytes and not two: `FF D8` alone also opens several
  // unrelated formats.
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function hasGifSignature(b: Buffer): boolean {
  // The full six-byte header, and only the two real versions. Adjutant's first
  // version matched the four bytes `GIF8` and accepted malformed terminators
  // (`adj-203.2.8`); that is the bug this line exists not to reinherit.
  if (b.length < 6) return false;
  const header = b.subarray(0, 6).toString("ascii");
  return header === "GIF87a" || header === "GIF89a";
}

function hasWebpSignature(b: Buffer): boolean {
  // "RIFF" ....size.... "WEBP"
  return (
    b.length >= 12 &&
    b.subarray(0, 4).toString("ascii") === "RIFF" &&
    b.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

/**
 * MP4 and QuickTime, which share the ISO base media container.
 *
 * Both open with a box whose type is `ftyp`, followed by a four-character
 * brand. `qt  ` is QuickTime; the `isom`/`mp4x`/`M4V ` family is MP4. A brand
 * outside both lists is refused rather than guessed at — an unrecognised
 * container is exactly the file worth not storing.
 */
function sniffIsoBmff(b: Buffer): AllowedMime | null {
  if (b.length < 12) return null;
  if (b.subarray(4, 8).toString("ascii") !== "ftyp") return null;
  const brand = b.subarray(8, 12).toString("ascii");
  if (brand === "qt  ") return "video/quicktime";
  if (/^(isom|iso[2-9]|mp4[12]|avc1|M4V |M4A |dash)$/u.test(brand)) return "video/mp4";
  return null;
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** Pixels. */
export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * An image's own answer about its size, or `null`.
 *
 * The file header is the only source that cannot disagree with the file, which
 * is why the uploader's claim is ignored for every format parsed here. Video
 * returns `null` — the dimensions live in a `moov` atom behind a variable-
 * length box walk, and shipping a partial demuxer to avoid trusting a number
 * that is only ever a layout hint is the wrong trade. Never throws: a
 * truncated header is a `null`, not a 500.
 */
export function probeDimensions(buffer: Buffer, mime: AllowedMime): Dimensions | null {
  try {
    switch (mime) {
      case "image/png":
        return pngDimensions(buffer);
      case "image/jpeg":
        return jpegDimensions(buffer);
      case "image/gif":
        return gifDimensions(buffer);
      case "image/webp":
        return webpDimensions(buffer);
      case "video/mp4":
      case "video/quicktime":
        return null;
    }
  } catch {
    return null;
  }
}

function ok(width: number, height: number): Dimensions | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function pngDimensions(b: Buffer): Dimensions | null {
  // IHDR is always the first chunk: 8-byte signature, 4-byte length, "IHDR",
  // then width and height as big-endian 32-bit.
  if (b.length < 24 || b.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return ok(b.readUInt32BE(16), b.readUInt32BE(20));
}

function jpegDimensions(b: Buffer): Dimensions | null {
  // Walk the segment chain to the first start-of-frame marker. Everything
  // before it is metadata of unpredictable length, which is why this cannot be
  // a fixed offset the way the others can.
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = b[offset + 1] ?? 0;
    // SOF0..SOF15, minus the three that are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return ok(b.readUInt16BE(offset + 7), b.readUInt16BE(offset + 5));
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    offset += 2 + b.readUInt16BE(offset + 2);
  }
  return null;
}

function gifDimensions(b: Buffer): Dimensions | null {
  if (b.length < 10) return null;
  return ok(b.readUInt16LE(6), b.readUInt16LE(8));
}

function webpDimensions(b: Buffer): Dimensions | null {
  const chunk = b.subarray(12, 16).toString("ascii");
  if (chunk === "VP8 " && b.length >= 30) {
    // Lossy: a 3-byte start code at 23, then 14-bit width and height.
    return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === "VP8L" && b.length >= 25) {
    // Lossless: 14 bits each, packed across four bytes after the signature.
    const bits = b.readUInt32LE(21);
    return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X" && b.length >= 30) {
    // Extended: 24-bit canvas size, minus one, little-endian.
    return ok(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Every way this store says no.
 *
 * Adjutant's four (`empty`, `too-large`, `unsupported-type`, `mime-mismatch`)
 * ported as they stand, plus four this contract needs that Adjutant's did not:
 * it stored images only, unlinked, one at a time.
 *
 * Each is a distinct thing the caller did wrong, and they are separate because
 * the client's next move differs for each — re-encode, resize, pick a
 * different file, fix the label, fix the request. One `invalid` would collapse
 * five different fixes into one message.
 */
export type AttachmentErrorCode =
  /** Zero bytes. */
  | "empty"
  /** Past {@link MAX_ATTACHMENT_BYTES}. */
  | "too-large"
  /** The magic bytes match nothing on the allowlist. */
  | "unsupported-type"
  /** The declared type and the sniffed type disagree. */
  | "mime-mismatch"
  /** The declared `kind` and the sniffed type's family disagree. */
  | "kind-mismatch"
  /** A video whose dimensions the caller did not declare and we cannot read. */
  | "dimensions-unknown"
  /** A video whose duration the caller did not declare. */
  | "duration-unknown"
  /** An id no upload ever produced. */
  | "unknown-attachment"
  /** That attachment already belongs to a message. */
  | "already-attached"
  /** A supplied poster frame that is not a JPEG, or is on an image. */
  | "poster-unusable";

/** A refusal with a name. The route maps the name to a contract failure. */
export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;

  constructor(code: AttachmentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttachmentError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/**
 * Downscale `source` into `target`. `true` if it produced a file.
 *
 * A seam, and not for tidiness: the default implementation shells out to a
 * macOS binary, and CI runs on ubuntu. A store whose happy path could only be
 * exercised on the Commander's own machine would have the thumbnail logic
 * tested nowhere.
 */
export type Thumbnailer = (source: string, target: string, maxEdge: number) => boolean;

/**
 * ## The T027 decision: thumbnails ship, via `sips`, for images only.
 *
 * Adjutant has none. It downloads the full file and renders it at 160x160, so
 * a 4 MB screenshot costs 4 MB to show a thumbnail. Over a tailnet on cellular
 * that is somewhere between four and ten seconds against roughly a tenth of
 * one — the difference between a transcript that scrolls and a transcript that
 * stalls, on every message with a picture in it, forever. A 640-pixel JPEG of
 * that same screenshot is around 60 KB: **about sixty times less**, and it is
 * the variant the inline bubble actually wants.
 *
 * The cost of taking that win is normally an image-processing dependency, and
 * that cost is real: `sharp` is a native binary, and this repository already
 * carries an `onnxruntime-node` pin whose entire existence is a native module
 * that stopped shipping a darwin-x64 build. A second one is a second version
 * of that afternoon. `jimp` avoids the native build and brings a decoder for
 * every format in pure JavaScript, which is megabytes of dependency to resize
 * a screenshot.
 *
 * `sips` is neither. It is `/usr/bin/sips`, it has shipped with macOS since
 * forever, and the service is already macOS-only in several load-bearing ways
 * — launchd, `tailscale cert`, `com.jmm.syl.update`. So the dependency cost of
 * this decision is **zero new packages**, and the portability cost is a
 * capability the store already has to degrade gracefully without.
 *
 * **What is deferred, said out loud:** there is no video poster frame. That
 * needs ffmpeg, which is a genuine third-party binary with a genuine install
 * story, and no macOS built-in extracts a frame. So a video bubble on cellular
 * costs the full clip or nothing, and `hasThumbnail` is false for every video
 * so the client can at least tell which it is facing. If video attachments
 * turn out to be common the answer is a client-generated poster uploaded
 * alongside the clip — the phone already has AVFoundation — rather than
 * putting ffmpeg on the Commander's machine.
 */
export const sipsThumbnailer: Thumbnailer = (source, target, maxEdge) => {
  try {
    execFileSync(
      "/usr/bin/sips",
      ["-Z", String(maxEdge), "-s", "format", "jpeg", source, "--out", target],
      { stdio: "ignore", timeout: 10_000 },
    );
    return existsSync(target);
  } catch {
    // No sips (ubuntu CI), an image it cannot read, a timeout. Every one of
    // them means "no preview", which is a state the client renders. None of
    // them means "reject the upload".
    return false;
  }
};

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** What to store. `data` is the decoded file, never base64. */
export interface CreateAttachmentInput {
  readonly kind: AttachmentKind;
  /** What the caller says it is. Cross-checked, never believed. */
  readonly declaredMime: string;
  readonly data: Buffer;
  /** Ignored for an image; required for a video. */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** Required for a video; must be absent on an image. */
  readonly durationMs?: number | undefined;
  /**
   * A pre-rendered JPEG to keep as this attachment's thumbnail. Video only.
   *
   * **Why the bytes are handed in rather than made here.** `hasThumbnail` was
   * false for every video because no macOS built-in extracts a frame, and this
   * store deliberately shells out to nothing heavier than `sips`. Pulling a
   * still needs ffmpeg — a genuine third-party binary — and a store that
   * spawns a video toolchain is a store with a new dependency and a new way to
   * hang. `services/sending-media.ts` owns that seam and passes the result
   * here, so this module keeps doing what it does: bytes, and a row that
   * describes them truthfully.
   *
   * Validated like everything else: sniffed rather than believed, and kept
   * only if it is actually cheaper than the clip it previews.
   */
  readonly poster?: Buffer | undefined;
}

/** The wire shape plus the two columns that never leave the service. */
export interface StoredAttachment extends Attachment {
  /** `<uuid>.<ext>`, relative to the blob directory. */
  readonly storedName: string;
  /** The preview's name, or null. */
  readonly thumbName: string | null;
}

/** Which file a read wants. */
export type AttachmentVariant = "original" | "thumb";

/** An open file, ready to be piped at a response. */
export interface OpenAttachment {
  readonly mimeType: string;
  readonly bytes: number;
  readonly stream: ReadStream;
}

interface AttachmentRow {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly mime_type: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly duration_ms: number | null;
  readonly sha256: string;
  readonly stored_name: string;
  readonly thumb_name: string | null;
  readonly created_at: string;
}

const COLUMNS =
  "id, kind, mime_type, bytes, width, height, duration_ms, sha256, stored_name, thumb_name, created_at";

function toStored(row: AttachmentRow): StoredAttachment {
  return {
    id: row.id,
    kind: row.kind,
    mimeType: row.mime_type,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    sha256: row.sha256,
    createdAt: row.created_at,
    hasThumbnail: row.thumb_name !== null,
    storedName: row.stored_name,
    thumbName: row.thumb_name,
  };
}

/** Strip the two internal columns. What a client is allowed to see. */
export function toAttachment(stored: StoredAttachment): Attachment {
  const { storedName: _storedName, thumbName: _thumbName, ...wire } = stored;
  return wire;
}

export interface AttachmentStoreOptions {
  readonly db: Database;
  /** Where the blobs go. Created on first write. */
  readonly blobDir: string;
  readonly clock?: Clock;
  /** Defaults to {@link MAX_ATTACHMENT_BYTES}. */
  readonly maxBytes?: number;
  /** Defaults to {@link sipsThumbnailer}. */
  readonly thumbnailer?: Thumbnailer;
}

export class AttachmentStore {
  readonly blobDir: string;
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #maxBytes: number;
  readonly #thumbnail: Thumbnailer;

  constructor(options: AttachmentStoreOptions) {
    // Resolved once, at construction. Every confinement check below compares
    // against this value, so a relative configuration cannot make the guard
    // depend on the process's working directory.
    this.blobDir = resolve(options.blobDir);
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
    this.#maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
    this.#thumbnail = options.thumbnailer ?? sipsThumbnailer;
  }

  /**
   * Validate, write the bytes, insert the row.
   *
   * Order matters: nothing is written anywhere until every check has passed,
   * and the blob is removed again if the insert fails. A refused upload must
   * leave no trace — a file on disk that no row points at is a byte nobody
   * will ever delete.
   */
  create(input: CreateAttachmentInput): StoredAttachment {
    const mime = this.#validate(input);
    const kind = MIME_TO_KIND[mime];
    const size = this.#dimensionsFor(input, mime);
    const durationMs = this.#durationFor(input, kind);

    const storedName = generateStoredName(MIME_TO_EXT[mime]);
    const path = this.#pathOf(storedName);
    this.#ensureDir();
    writeFileSync(path, input.data);

    // After the original is on disk, because `sips` reads a file rather than a
    // buffer — and best-effort, because a machine without it is a machine
    // without previews, not a machine that cannot receive a picture.
    //
    // An image makes its own preview; a video can only have one it was given.
    const thumbName =
      kind === "image"
        ? this.#thumbnailFor(storedName, path)
        : this.#posterFor(storedName, input.poster, input.data.length);

    const row: AttachmentRow = {
      id: newId("attachment"),
      kind,
      mime_type: mime,
      bytes: input.data.length,
      width: size.width,
      height: size.height,
      duration_ms: durationMs,
      sha256: createHash("sha256").update(input.data).digest("hex"),
      stored_name: storedName,
      thumb_name: thumbName,
      created_at: instant(this.#clock()),
    };

    try {
      this.#db
        .prepare(`INSERT INTO attachments (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          row.id,
          row.kind,
          row.mime_type,
          row.bytes,
          row.width,
          row.height,
          row.duration_ms,
          row.sha256,
          row.stored_name,
          row.thumb_name,
          row.created_at,
        );
    } catch (error) {
      this.#remove(storedName);
      if (thumbName !== null) this.#remove(thumbName);
      throw error;
    }

    return toStored(row);
  }

  /** One row by id, or `null`. */
  get(id: string): StoredAttachment | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM attachments WHERE id = ?`).get(id);
    return row === undefined ? null : toStored(row as unknown as AttachmentRow);
  }

  /** Every row, newest first. The admin's view, and the retention job's. */
  list(): readonly StoredAttachment[] {
    return this.#db
      .prepare(`SELECT ${COLUMNS} FROM attachments ORDER BY created_at DESC, id DESC`)
      .all()
      .map((row) => toStored(row as unknown as AttachmentRow));
  }

  /**
   * Open a variant for serving, or `null`.
   *
   * `null` covers three cases on purpose — no such row, no such variant, and a
   * row whose blob is missing — because a client can do exactly one thing
   * about all three. A missing thumbnail is deliberately **not** answered with
   * the original: a silent fallback turns a 60 KB request into a 4 MB one on
   * the connection least able to afford it, and it does so invisibly.
   */
  open(id: string, variant: AttachmentVariant): OpenAttachment | null {
    const row = this.get(id);
    if (row === null) return null;

    const name = variant === "thumb" ? row.thumbName : row.storedName;
    if (name === null) return null;

    const path = this.#pathOf(name);
    if (!existsSync(path)) return null;

    return {
      mimeType: variant === "thumb" ? THUMBNAIL_MIME : row.mimeType,
      bytes: statSync(path).size,
      stream: createReadStream(path),
    };
  }

  /**
   * Claim attachments for a message, in the order given.
   *
   * All or nothing: a message that ended up with two of its three pictures is
   * a message whose author cannot tell anything went wrong. The uniqueness of
   * the pairing is a schema constraint too, so a concurrent claim loses at the
   * index rather than at the check here.
   *
   * **Joins a transaction already in progress rather than opening a second
   * one.** `MessageStore.append` links inside the transaction that writes the
   * message — which is what makes the sync feed correct without a second
   * mechanism — and SQLite has no nested `BEGIN`. Asking the connection
   * whether it is already in one keeps that from being a rule two call sites
   * have to remember in opposite directions.
   */
  link(messageId: string, attachmentIds: readonly string[]): void {
    if (attachmentIds.length === 0) return;

    const owned = !this.#db.isTransaction;
    if (owned) this.#db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.#db.prepare(
        "INSERT INTO message_attachments (message_id, attachment_id, position) VALUES (?, ?, ?)",
      );
      attachmentIds.forEach((attachmentId, position) => {
        if (this.get(attachmentId) === null) {
          throw new AttachmentError(
            "unknown-attachment",
            `There is no attachment ${attachmentId}.`,
          );
        }
        try {
          insert.run(messageId, attachmentId, position);
        } catch (error) {
          // The UNIQUE index on `attachment_id` is what actually enforces
          // one-message-per-attachment, so this translation covers both the
          // repeat inside one call and the race between two.
          throw new AttachmentError(
            "already-attached",
            `Attachment ${attachmentId} already belongs to a message.`,
            { cause: error },
          );
        }
      });
      if (owned) this.#db.exec("COMMIT");
    } catch (error) {
      if (owned) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          // Already unwound. The original failure is the one worth reporting.
        }
      }
      throw error;
    }
  }

  /**
   * Attachments for a page of messages, keyed by message id.
   *
   * One query for the whole page rather than one per message: a fifty-message
   * page is the common case and fifty round trips through SQLite to find that
   * forty-nine of them have no picture is the shape of every N+1 anybody has
   * ever shipped. A message with nothing attached is simply absent from the
   * map, so a caller reads `?? []`.
   */
  forMessages(messageIds: readonly string[]): ReadonlyMap<string, readonly Attachment[]> {
    const found = new Map<string, Attachment[]>();
    if (messageIds.length === 0) return found;

    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(
        `SELECT ma.message_id AS message_id, ${COLUMNS.split(", ")
          .map((column) => `a.${column}`)
          .join(", ")}
           FROM message_attachments ma
           JOIN attachments a ON a.id = ma.attachment_id
          WHERE ma.message_id IN (${placeholders})
          ORDER BY ma.message_id, ma.position`,
      )
      .all(...messageIds);

    for (const raw of rows) {
      const row = raw as unknown as AttachmentRow & { readonly message_id: string };
      const list = found.get(row.message_id) ?? [];
      list.push(toAttachment(toStored(row)));
      found.set(row.message_id, list);
    }
    return found;
  }

  // ------------------------------------------------------------ internals ---

  /**
   * The three checks Adjutant does, in the order that leaks least.
   *
   * Size before sniffing, so a 400 MB payload is refused without hashing it;
   * sniffing before the cross-check, so the error says what the file *is*
   * rather than only that it is not what was claimed.
   */
  #validate(input: CreateAttachmentInput): AllowedMime {
    if (input.data.length === 0) {
      throw new AttachmentError("empty", "That upload carried no bytes.");
    }
    if (input.data.length > this.#maxBytes) {
      throw new AttachmentError(
        "too-large",
        `That file is ${String(input.data.length)} bytes; the ceiling is ${String(this.#maxBytes)}.`,
      );
    }

    const mime = sniffMime(input.data);
    if (mime === null) {
      throw new AttachmentError(
        "unsupported-type",
        "Those bytes are not a format this service stores.",
      );
    }

    const declared = input.declaredMime.trim().toLowerCase();
    if (declared !== "" && declared !== mime) {
      throw new AttachmentError(
        "mime-mismatch",
        `That file says it is ${mime}; the request declared ${declared}.`,
      );
    }
    if (MIME_TO_KIND[mime] !== input.kind) {
      throw new AttachmentError(
        "kind-mismatch",
        `That file is a ${MIME_TO_KIND[mime]}; the request declared a ${input.kind}.`,
      );
    }

    // Checked here rather than at the point of use, so a bad poster refuses
    // the upload before a single byte is written. The store's standing rule is
    // that a refused upload leaves no trace.
    if (input.poster !== undefined) {
      if (MIME_TO_KIND[mime] !== "video") {
        throw new AttachmentError(
          "poster-unusable",
          "Only a video takes a poster frame; an image is its own preview.",
        );
      }
      if (sniffMime(input.poster) !== "image/jpeg") {
        // Sniffed, never believed. A PNG accepted here would be served under
        // `image/jpeg` and fail to decode on the phone, which reads as a
        // broken video rather than as a bad poster.
        throw new AttachmentError(
          "poster-unusable",
          "A poster frame must be a JPEG; those bytes are not one.",
        );
      }
    }

    return mime;
  }

  /** The file's own answer where there is one; the caller's where there is not. */
  #dimensionsFor(input: CreateAttachmentInput, mime: AllowedMime): Dimensions {
    const probed = probeDimensions(input.data, mime);
    if (probed !== null) return probed;

    const width = input.width;
    const height = input.height;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1
    ) {
      throw new AttachmentError(
        "dimensions-unknown",
        "This service cannot read that file's dimensions, so the request must declare them.",
      );
    }
    return { width, height };
  }

  #durationFor(input: CreateAttachmentInput, kind: AttachmentKind): number | null {
    if (kind === "image") return null;
    const durationMs = input.durationMs;
    if (typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs < 0) {
      throw new AttachmentError(
        "duration-unknown",
        "A video upload must declare durationMs; this service has no demuxer to read it.",
      );
    }
    return durationMs;
  }

  /**
   * Make a preview, and keep it only if it is actually cheaper.
   *
   * The size check is not defensive tidying — it is a case that happens.
   * Downscaling re-encodes as JPEG, and JPEG is expensive for exactly the
   * images that are cheap as PNG: screenshots of text, flat UI, line art, and
   * anything small enough that 640 pixels is not a reduction at all. Measured
   * on a 1200x900 synthetic PNG, the "thumbnail" came out **fourteen times
   * larger than the original**.
   *
   * A preview that costs more than the thing it previews is worse than no
   * preview, and the whole reason this feature exists is the cellular byte
   * count. So a thumbnail that is not smaller is deleted, and `hasThumbnail`
   * is false — the client fetches the original, which was the cheaper request
   * all along.
   */
  #thumbnailFor(storedName: string, sourcePath: string): string | null {
    const name = `${storedName}.thumb.jpg`;
    const target = this.#pathOf(name);
    if (!this.#thumbnail(sourcePath, target, THUMBNAIL_MAX_EDGE)) return null;

    try {
      if (statSync(target).size < statSync(sourcePath).size) return name;
    } catch {
      // The thumbnailer said it wrote a file and we cannot stat it. Treat that
      // as no preview rather than as a row pointing at nothing.
    }
    this.#remove(name);
    return null;
  }

  /**
   * Keep a caller-supplied poster frame, under the same rule thumbnails obey.
   *
   * The size check is the whole justification for the feature. A video's
   * inline cell has no preview today, so a client that wants to draw one
   * fetches the original — the entire clip, megabytes of it, to render a play
   * triangle and a duration. A poster is worth having exactly to the extent it
   * is cheaper than that, so one that is not smaller is discarded and
   * `hasThumbnail` stays false, which is the honest answer.
   *
   * The bytes are already validated as a JPEG by `#validate`; this only
   * decides whether keeping them pays.
   */
  #posterFor(storedName: string, poster: Buffer | undefined, originalBytes: number): string | null {
    if (poster === undefined || poster.length >= originalBytes) return null;

    const name = `${storedName}.thumb.jpg`;
    try {
      writeFileSync(this.#pathOf(name), poster);
    } catch {
      // No preview, rather than a failed upload. Same degradation as a machine
      // without `sips`: the clip itself is already safely on disk.
      return null;
    }
    return name;
  }

  #ensureDir(): void {
    if (!existsSync(this.blobDir)) mkdirSync(this.blobDir, { recursive: true });
  }

  /**
   * A stored name to an absolute path, refusing anything that could escape.
   *
   * Belt and braces over the schema's own CHECK constraints, because this is
   * the function a future caller will reach for with a name from somewhere
   * else. A separator, a null byte, or any `..` at all is a throw rather than
   * a sanitised value — quietly repairing a hostile name is how the repair
   * becomes the vulnerability.
   */
  #pathOf(storedName: string): string {
    if (
      storedName.length === 0 ||
      storedName.includes("/") ||
      storedName.includes("\\") ||
      storedName.includes("\0") ||
      storedName.includes("..")
    ) {
      throw new Error(`Unsafe attachment name: ${JSON.stringify(storedName)}`);
    }
    const absolute = resolve(this.blobDir, storedName);
    if (absolute !== join(this.blobDir, storedName) || !absolute.startsWith(this.blobDir + sep)) {
      throw new Error(`Attachment name escapes the blob directory: ${JSON.stringify(storedName)}`);
    }
    return absolute;
  }

  #remove(storedName: string): void {
    try {
      unlinkSync(this.#pathOf(storedName));
    } catch {
      // Already gone, or never written. Nothing to unwind.
    }
  }
}

/**
 * A safe `<uuid>.<ext>` name.
 *
 * The extension comes from {@link MIME_TO_EXT} and is re-checked here, so the
 * only names this service ever writes are ones it can spell — no filename from
 * a client reaches the disk, in any form, at any point.
 */
export function generateStoredName(ext: string): string {
  const clean = ext.toLowerCase().replace(/^\./u, "");
  if (!ALLOWED_EXTS.has(clean)) {
    throw new Error(`Extension not allowed: ${JSON.stringify(ext)}`);
  }
  return `${randomUUID()}.${clean}`;
}
