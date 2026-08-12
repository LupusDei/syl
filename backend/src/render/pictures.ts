import { createHash } from "node:crypto";

/**
 * What a picture says about itself, read off the picture.
 *
 * Two facts live here, and they are here together because they are the same
 * discipline twice: **anything that describes a picture is computed from the
 * picture.**
 *
 * `syl-63v` is why that is a rule rather than a preference. `holdsLikeness` was
 * a boolean typed beside each framing; the mechanism it described changed, and
 * the boolean went on being true, and a render at that framing quietly became a
 * render of somebody else. Nothing broke and nothing failed. A wardrobe is
 * exactly the shape that invites the same mistake — a manifest listing a name, a
 * shape and a reason, three assertions sitting beside a file that is free to
 * disagree with all of them.
 *
 * So the shape is parsed from the header and the identity is a digest of the
 * bytes. Neither can outlive what it describes.
 */

/** A picture's real dimensions, in pixels. */
export interface PictureSize {
  readonly width: number;
  readonly height: number;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The shape of a PNG, from its IHDR.
 *
 * Fixed offsets, and legitimately so: IHDR is required by the format to be the
 * first chunk, so width is at 16 and height at 20 in every valid PNG. The length
 * check is what makes a truncated file answer `null` instead of reading past the
 * end of the buffer.
 */
function pngSize(bytes: Buffer): PictureSize | null {
  if (bytes.length < 24) return null;
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Whether a JPEG marker is a start-of-frame, which is where the size lives.
 *
 * `C4`, `C8` and `CC` sit inside the `C0`–`CF` run and are **not** frame
 * headers — they are the Huffman table, a JPEG extension, and the arithmetic
 * coding table. Reading a size out of one of those produces a confident wrong
 * number rather than a failure, which is the failure mode this whole module
 * exists to avoid.
 */
function isFrameMarker(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * The shape of a JPEG, by walking its segments.
 *
 * There is no fixed offset to read: every file this project produces has an
 * APP0 in front of the frame header, and ffmpeg's output has more than one
 * segment before it. So the segments are walked by their own declared lengths
 * until a start-of-frame turns up.
 */
function jpegSize(bytes: Buffer): PictureSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    // The padding run and the standalone markers carry no length word, so
    // walking past them by a length would walk into the middle of a segment.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }

    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (isFrameMarker(marker)) {
      if (at + 9 > bytes.length) return null;
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    }
    at += 2 + length;
  }
  return null;
}

/**
 * A picture's real dimensions, or `null` for something that is not a picture.
 *
 * **Never a default.** An opening decides the video's aspect and silently
 * overrules `ratio` — measured 2026-08-11, in both directions — so a file whose
 * shape could not be read must not be handed the shape of the one it replaced.
 * That would be the ribbon's aspect written on somebody else's picture, which is
 * the same lie as a lost prompt.
 */
export function sizeOf(bytes: Buffer): PictureSize | null {
  return pngSize(bytes) ?? jpegSize(bytes);
}

/**
 * The name of a picture she has been shown, derived from the picture.
 *
 * **This is what makes "she looked at it" enforceable rather than requested.** A
 * sighting is a digest of the exact bytes handed to her as an image, and the
 * only place those bytes are ever produced is `see_myself`. So a value she can
 * quote back is proof she was shown the thing — not a flag somebody set, not a
 * field she could fill in from a filename, and not something she can derive from
 * a path she half-remembers. Adopting a picture sight unseen is unrepresentable
 * because there is no way to name one.
 *
 * Sixteen hex characters rather than sixty-four, because she has to repeat it
 * into a verb and a long digest is a thing a model truncates. Sixty-four bits is
 * far past the point of accident across a directory of a few thousand stills,
 * and a collision is caught rather than acted on: the wardrobe refuses a
 * sighting that matches two pictures rather than picking one.
 */
export function sightingOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * The shapes a render may come out, and why the list stops where it does.
 *
 * Probed on 2026-08-11 (`docs/VIDEO.md`): `seedance2` on `image_to_video`
 * answers an invalid `ratio` with a 400 that lists every legal one, free and
 * without creating a task. That list has four resolution rows; this is the row
 * the eight loops are in.
 *
 * **The `sd` band and nothing else, on purpose.** `creditsFor` bands on the
 * longer side, and everything here is at or under 1280 — 36 credits a second,
 * which is what every render she has ever made cost. Letting the shape of an
 * opening pick a price as well as an aspect would make choosing a different
 * opening quietly cost more, and a dial that moves two things is a dial nobody
 * can learn from.
 *
 * `1470:630` is in that row of Runway's list and is **not** here for exactly
 * that reason: 1470 is over the 1280 that ends the `sd` band, so an opening of
 * roughly 2.33:1 would have been priced as `hd` without anything saying so. The
 * widest shape available is therefore `1280:720`, and a wider opening than that
 * gets the nearest shape that costs what everything else costs.
 */
export const RATIOS: readonly string[] = [
  "1280:720",
  "1112:834",
  "960:960",
  "834:1112",
  "720:1280",
];

/** A ratio string as a number, or `null` if it is not one. */
function aspectOf(ratio: string): number | null {
  const parts = ratio.split(":");
  if (parts.length !== 2) return null;
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
}

/**
 * The ratio to ask for, given the picture the clip will start from.
 *
 * `promptImage` decides the video's aspect and overrules `ratio` without saying
 * so, so this field cannot change the shape — it can only agree with it or
 * disagree with it. `DEFAULTS.ratio` used to say `720:1280` above a stream of
 * landscape videos for exactly that reason: nothing anywhere contradicted it.
 *
 * So the ratio is derived from the opening rather than written down beside it.
 * The two can no longer say different things, and an opening of a new shape
 * makes a render of that shape with a record that admits it.
 *
 * Compared on the **logarithm** of the aspect, so that a shape and its transpose
 * are the same distance apart in both directions — a linear comparison makes
 * landscape errors look larger than the identical portrait one and picks a
 * different answer depending on which way up the picture is.
 */
export function ratioFor(size: PictureSize | null): string | null {
  if (size === null || size.width <= 0 || size.height <= 0) return null;

  const wanted = Math.log(size.width / size.height);
  let best: string | null = null;
  let bestError = Number.POSITIVE_INFINITY;
  for (const ratio of RATIOS) {
    const aspect = aspectOf(ratio);
    if (aspect === null) continue;
    const error = Math.abs(Math.log(aspect) - wanted);
    if (error < bestError) {
      best = ratio;
      bestError = error;
    }
  }
  return best;
}
