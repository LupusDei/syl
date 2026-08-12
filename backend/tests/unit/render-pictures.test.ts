import { describe, expect, it } from "vitest";

import { RATIOS, ratioFor, sightingOf, sizeOf } from "../../src/render/pictures.js";

/**
 * What a picture says about itself.
 *
 * Everything here is **read off the bytes**. That is the point rather than an
 * implementation detail: `syl-63v` went wrong because a claim about the
 * pictures was written down beside them instead of computed from them, and the
 * two facts this module produces — what shape a picture is, and which picture
 * she was shown — are exactly the two a wardrobe would otherwise be tempted to
 * store in a manifest and let drift.
 */

/** A PNG header of a given size. Enough of one for `sizeOf`, and nothing more. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/**
 * A JPEG with one APP0 segment and one SOF0, at a given size.
 *
 * The segment before the frame header is deliberate: a reader that assumed the
 * size lived at a fixed offset would pass on a file with no APP0 and fail on
 * every real one, since every camera and every ffmpeg output has several.
 */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from("JFIF\0\0\0\0\0\0", "latin1"),
  ]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(1, 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

describe("what a picture is", () => {
  it("should read a PNG's shape off its own header", () => {
    expect(sizeOf(png(834, 1112))).toEqual({ width: 834, height: 1112 });
  });

  it("should read a JPEG's shape past the segments in front of it", () => {
    expect(sizeOf(jpeg(512, 682))).toEqual({ width: 512, height: 682 });
  });

  it("should answer null for something that is not a picture at all", () => {
    // Never a guess. A file whose shape cannot be read must not be given the
    // default shape — that is how an opening of the wrong aspect would reach
    // Runway wearing the right one, and the aspect is the thing the opening
    // decides.
    expect(sizeOf(Buffer.from("this is not a picture"))).toBeNull();
  });

  it("should answer null for a truncated PNG rather than reading past the end", () => {
    expect(sizeOf(png(834, 1112).subarray(0, 18))).toBeNull();
  });
});

describe("which picture she was shown", () => {
  it("should give the same sighting for the same bytes", () => {
    expect(sightingOf(png(834, 1112))).toBe(sightingOf(png(834, 1112)));
  });

  it("should give a different sighting for a different picture", () => {
    expect(sightingOf(png(834, 1112))).not.toBe(sightingOf(png(1112, 834)));
  });

  it("should be short enough to say back, and not a path", () => {
    // She has to repeat this into a verb. A 64-character digest is a thing a
    // model truncates; a path is a thing anything could name without having
    // looked.
    const sighting = sightingOf(png(834, 1112));
    expect(sighting).toMatch(/^[0-9a-f]{16}$/u);
  });
});

describe("the shape a render comes out", () => {
  it("should keep the loops' own shape for the ribbon they all open on", () => {
    // 834x1112 is what `ffprobe` says the eight loops are, and asking for the
    // ratio that matches the opening is what stops the two disagreeing.
    expect(ratioFor({ width: 834, height: 1112 })).toBe("834:1112");
  });

  it("should follow a still pulled out of one of her own renders", () => {
    // A frame she looked at is 512 wide, and it is the same 3:4 shape as the
    // clip it came out of. An opening lifted from a render must therefore
    // produce the same video shape as the render it came from.
    expect(ratioFor({ width: 512, height: 682 })).toBe("834:1112");
  });

  it("should turn the video landscape for a landscape opening", () => {
    // The whole point of surfacing this. `reference.png` is 1120x832, and an
    // opening of that shape makes a landscape video however the ratio is
    // written — measured 2026-08-11, both directions.
    expect(ratioFor({ width: 1120, height: 832 })).toBe("1112:834");
  });

  it("should offer only shapes that cost the same as every render so far", () => {
    // A dial that quietly changed the price is not a dial for shape. Every
    // ratio this can answer is in the band `creditsFor` prices as `sd`.
    for (const ratio of RATIOS) {
      const [width, height] = ratio.split(":").map((part) => Number(part));
      expect(Math.max(width ?? 0, height ?? 0), ratio).toBeLessThanOrEqual(1280);
    }
  });

  it("should refuse to name a shape for a picture with no size", () => {
    expect(ratioFor(null)).toBeNull();
  });
});
