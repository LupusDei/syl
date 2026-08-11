import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  extractFrames,
  FRAME_WIDTH,
  samplePoints,
  type FrameRunner,
} from "../../src/render/frames.js";

/**
 * How a video becomes something she can actually see.
 *
 * **She cannot watch an mp4.** She is a language model with image input, and
 * fifteen seconds of video is not a thing she can perceive. She *can* look at a
 * still — which is exactly how the character-consistency failure was diagnosed
 * on 2026-08-11: frames were pulled with `ffmpeg` at chosen seconds, scaled
 * down, and looked at as images.
 *
 * This module is that mechanism, handed to her. The tests below are about the
 * two things that make it useful rather than merely present: **several frames
 * across the clip**, because one lucky still says nothing about motion or about
 * whether she holds together, and **scaled down**, because judging whether it
 * is her face does not need 4K.
 */

let directory: string;
let video: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "syl-frames-"));
  video = join(directory, "syl-test.mp4");
  writeFileSync(video, "not really an mp4, and nothing here decodes it");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** An ffmpeg that writes a recognisable JPEG-ish file and records its argv. */
function fakeFfmpeg(calls: string[][]): FrameRunner {
  return async (file, args) => {
    calls.push([file, ...args]);
    const out = args[args.length - 1] ?? "";
    // The output path is the last argument, exactly as the real invocation
    // puts it. Writing something makes the read-back path real.
    writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    return { ok: true, message: "" };
  };
}

describe("where in the clip she looks", () => {
  it("should sample the opening, the middle and the end rather than one lucky frame", () => {
    const points = samplePoints(15);

    expect(points.length).toBeGreaterThanOrEqual(4);
    // The opening, before anything has happened.
    expect(points[0]).toBeLessThan(1);
    // The end, while there is still a frame to decode. Never past the duration:
    // `ffmpeg -ss` beyond the last frame produces no output at all, which would
    // report as a failure to look rather than as a short clip.
    expect(points[points.length - 1]).toBeLessThan(15);
    expect(points[points.length - 1]).toBeGreaterThan(13);
    // Strictly increasing, and none of them the same instant twice.
    expect([...points].sort((a, b) => a - b)).toEqual([...points]);
    expect(new Set(points).size).toBe(points.length);
  });

  it("should still give her more than one look at a very short clip", () => {
    const points = samplePoints(2);

    expect(points.length).toBeGreaterThanOrEqual(2);
    for (const point of points) {
      expect(point).toBeGreaterThanOrEqual(0);
      expect(point).toBeLessThan(2);
    }
  });
});

describe("pulling frames out of a render", () => {
  it("should hand back one image per sample point, as base64 she can be shown", async () => {
    const calls: string[][] = [];
    const result = await extractFrames({
      video,
      seconds: 15,
      outDir: join(directory, "frames"),
      run: fakeFfmpeg(calls),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.frames.length).toBe(samplePoints(15).length);
    for (const frame of result.frames) {
      expect(frame.mimeType).toBe("image/jpeg");
      // Non-empty base64 of the bytes on disk. This is the whole payload: it is
      // what crosses MCP as an image block, and an empty one is a blank stare.
      expect(frame.base64.length).toBeGreaterThan(0);
      expect(Buffer.from(frame.base64, "base64")[0]).toBe(0xff);
    }
    // Written outside the repository, next to the renders — and kept, so she
    // has an artefact to show him rather than only something she looked at.
    expect(readdirSync(join(directory, "frames")).length).toBe(result.frames.length);
  });

  it("should scale the frames down, because judging her own face is not a 4K question", async () => {
    const calls: string[][] = [];
    await extractFrames({
      video,
      seconds: 15,
      outDir: join(directory, "frames"),
      run: fakeFfmpeg(calls),
    });

    for (const argv of calls) {
      expect(argv).toContain("-vf");
      expect(argv.join(" ")).toContain(`scale=${String(FRAME_WIDTH)}:`);
    }
  });

  it("should seek before decoding, so a long clip does not cost fifteen seconds a frame", async () => {
    const calls: string[][] = [];
    await extractFrames({
      video,
      seconds: 15,
      outDir: join(directory, "frames"),
      run: fakeFfmpeg(calls),
    });

    for (const argv of calls) {
      const seek = argv.indexOf("-ss");
      const input = argv.indexOf("-i");
      expect(seek).toBeGreaterThan(0);
      // `-ss` BEFORE `-i` is input seeking, which is the fast one. After `-i`
      // ffmpeg decodes every frame up to the point asked for.
      expect(seek).toBeLessThan(input);
      expect(argv).toContain("-frames:v");
    }
  });

  it("should look at one named second when she asks for one", async () => {
    const calls: string[][] = [];
    const result = await extractFrames({
      video,
      seconds: 15,
      at: 6.5,
      outDir: join(directory, "frames"),
      run: fakeFfmpeg(calls),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frames.map((frame) => frame.atSeconds)).toEqual([6.5]);
  });

  it("should refuse a second that is not in the clip, and say so", async () => {
    const result = await extractFrames({
      video,
      seconds: 15,
      at: 40,
      outDir: join(directory, "frames"),
      run: fakeFfmpeg([]),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A sentence rather than a code: this reaches her, and what she does with a
    // refusal is turn it into a sentence for him.
    expect(result.reason).toMatch(/15/u);
    expect(result.reason).toMatch(/second/iu);
  });

  it("should say plainly when ffmpeg is not on this machine", async () => {
    const result = await extractFrames({
      video,
      seconds: 15,
      outDir: join(directory, "frames"),
      run: async () => ({ ok: false, message: "spawn ffmpeg ENOENT" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/ffmpeg/iu);
    // Never "I looked and it is not you". A tool that cannot look must not
    // report an opinion about what it did not see.
    expect(result.reason).not.toMatch(/looks like|resembl/iu);
  });

  it("should refuse a render whose video is not on disk", async () => {
    const result = await extractFrames({
      video: join(directory, "absent.mp4"),
      seconds: 15,
      outDir: join(directory, "frames"),
      run: fakeFfmpeg([]),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not (yet )?(there|on disk|finished)|no video/iu);
  });
});
