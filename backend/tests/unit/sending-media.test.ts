import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compressForSending,
  fitWithin,
  posterSecondFor,
  POSTER_FRACTION,
  SENDING_BUDGET_FRACTION,
  SENDING_MAX_EDGE,
  type MediaRunner,
} from "../../src/services/sending-media.js";

/**
 * Turning a render into something that fits, and something with her face on it.
 *
 * Two jobs, and both exist because of a number: the store's ceiling is 10 MB
 * and a fifteen-second render is 12-15 MB. The ceiling is not raised —
 * `routes/attachments.ts` derives its request-body limit from it, so raising
 * one inflates the other for every upload in the service.
 *
 * Nothing here runs ffmpeg. The runner is injected, which is the same seam
 * `render/frames.ts` uses and for the same two reasons: CI has no ffmpeg, and
 * the interesting mistakes in this layer are in the argv rather than in the
 * encode.
 */

const CEILING = 10 * 1024 * 1024;

/** A real MP4 box header: `ftyp` with an `isom` brand. */
function mp4(padding = 0): Buffer {
  const head = Buffer.alloc(24);
  head.writeUInt32BE(24, 0);
  head.write("ftyp", 4, "ascii");
  head.write("isom", 8, "ascii");
  head.writeUInt32BE(512, 12);
  head.write("isomiso2", 16, "ascii");
  return padding === 0 ? head : Buffer.concat([head, Buffer.alloc(padding)]);
}

/** A real JPEG: SOI, JFIF APP0, SOF0. What ffmpeg would have written. */
function jpeg(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from("JFIF\0", "ascii"),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ]);
  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x01, 0x90, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([soi, app0, sof0, Buffer.from([0xff, 0xd9])]);
}

/** ffprobe's answer, in the `-of json` shape the compressor asks for. */
function probeJson(width: number, height: number, seconds: number): string {
  return JSON.stringify({
    streams: [{ width, height, codec_type: "video" }],
    format: { duration: String(seconds) },
  });
}

describe("fitWithin", () => {
  it("should leave a clip alone when its longest edge is already under the ceiling", () => {
    expect(fitWithin(480, 640, 720)).toEqual({ width: 480, height: 640 });
  });

  it("should scale a portrait clip by its longest edge and preserve the aspect", () => {
    // 784x1168 is what the shipped clips actually are.
    const fitted = fitWithin(784, 1168, 720);
    expect(fitted.height).toBe(720);
    expect(fitted.width).toBe(484);
    // Aspect preserved to within a pixel of the rounding.
    expect(Math.abs(fitted.width / fitted.height - 784 / 1168)).toBeLessThan(0.01);
  });

  it("should scale a landscape clip by its width", () => {
    const fitted = fitWithin(1920, 1080, 720);
    expect(fitted.width).toBe(720);
    expect(fitted.height).toBe(406);
  });

  it("should always return even dimensions, because h264 refuses an odd one", () => {
    // An odd height fails the encode with a message about nothing recognisable,
    // which is the worst kind of failure to debug from a log line.
    for (const [w, h] of [[721, 1281], [999, 333], [1001, 1999], [785, 1169]] as const) {
      const fitted = fitWithin(w, h, 720);
      expect(fitted.width % 2, `width for ${w}x${h}`).toBe(0);
      expect(fitted.height % 2, `height for ${w}x${h}`).toBe(0);
    }
  });

  it("should never return a zero edge for an extreme aspect", () => {
    const fitted = fitWithin(4000, 3, 720);
    expect(fitted.width).toBeGreaterThan(0);
    expect(fitted.height).toBeGreaterThan(0);
  });
});

describe("posterSecondFor", () => {
  it("should never be frame zero, because her loops open on empty starfield", () => {
    // The whole reason this function exists. `-ss 0` is valid and lands on a
    // frame with nothing in it at all.
    for (const seconds of [1, 5, 15, 0.5, 120]) {
      expect(posterSecondFor(seconds), `at ${String(seconds)}s`).toBeGreaterThan(0);
    }
  });

  it("should stay inside the clip, because seeking past the end writes no file", () => {
    for (const seconds of [0.4, 1, 15, 120]) {
      expect(posterSecondFor(seconds)).toBeLessThan(seconds);
    }
  });

  it("should take the frame from the agreed fraction of the clip", () => {
    expect(posterSecondFor(20)).toBeCloseTo(20 * POSTER_FRACTION, 5);
  });

  it("should still answer for a clip too short to have a fraction worth naming", () => {
    const at = posterSecondFor(0.05);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(0.05);
  });
});

describe("compressForSending", () => {
  let dir: string;
  let source: string;
  let outDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "syl-sending-media-"));
    outDir = join(dir, "out");
    source = join(dir, "render.mp4");
    // 14 MB: over the ceiling, which is the case this module exists for.
    writeFileSync(source, mp4(14 * 1024 * 1024));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A runner that answers ffprobe honestly and writes a plausible file for
   * every ffmpeg call, so the happy path can be driven end to end without a
   * codec anywhere near it.
   */
  function workingRunner(options: { readonly outputBytes?: number } = {}): {
    run: MediaRunner;
    calls: { file: string; args: readonly string[] }[];
  } {
    const calls: { file: string; args: readonly string[] }[] = [];
    const run: MediaRunner = async (file, args) => {
      calls.push({ file, args });
      if (file === "ffprobe") {
        return { ok: true, stdout: probeJson(784, 1168, 15.04), message: "" };
      }
      // The last argument of an ffmpeg invocation is its output path.
      const target = args[args.length - 1] ?? "";
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, target.endsWith(".jpg") ? jpeg() : mp4(options.outputBytes ?? 2 * 1024 * 1024));
      return { ok: true, stdout: "", message: "" };
    };
    return { run, calls };
  }

  it("should produce a copy under the ceiling, with its own dimensions and duration", async () => {
    const { run } = workingRunner();
    const result = await compressForSending({ source, outDir, ceilingBytes: CEILING, run });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBeLessThanOrEqual(CEILING);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.width).toBe(484);
    expect(result.height).toBe(720);
    expect(result.durationMs).toBe(15040);
    expect(readFileSync(result.path).length).toBe(result.bytes);
  });

  it("should never modify the full-quality render, which is the record", async () => {
    const before = readFileSync(source);
    const { run } = workingRunner();
    const result = await compressForSending({ source, outDir, ceilingBytes: CEILING, run });

    expect(result.ok).toBe(true);
    expect(readFileSync(source).equals(before)).toBe(true);
    if (result.ok) expect(result.path).not.toBe(source);
  });

  it("should return a JPEG poster taken from inside the clip, never frame zero", async () => {
    const { run, calls } = workingRunner();
    const result = await compressForSending({ source, outDir, ceilingBytes: CEILING, run });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // FF D8 FF — a real JPEG, not an empty buffer standing in for one.
    expect(result.poster.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    const seek = calls.find((call) => call.args.includes("-ss"));
    expect(seek, "something must seek for the poster frame").toBeDefined();
    const at = Number(seek?.args[(seek.args.indexOf("-ss") ?? 0) + 1]);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(15.04);
  });

  it("should cap the encode against the ceiling rather than hoping the result fits", async () => {
    const { run, calls } = workingRunner();
    await compressForSending({ source, outDir, ceilingBytes: CEILING, run });

    const encode = calls.find((call) => call.file === "ffmpeg" && call.args.includes("-maxrate"));
    expect(encode, "the encode must bound its own bitrate").toBeDefined();

    const maxrate = encode?.args[(encode.args.indexOf("-maxrate") ?? 0) + 1] ?? "";
    const capBits = Number(maxrate.replace(/k$/u, "")) * 1000;
    // The cap must spend at most the budget fraction of the ceiling over the
    // clip's length, or it is not a cap against anything.
    const budgetBits = (CEILING * SENDING_BUDGET_FRACTION * 8) / 15.04;
    expect(capBits).toBeLessThanOrEqual(Math.ceil(budgetBits) + 1000);
    expect(encode?.args).toContain("-bufsize");
  });

  it("should start the file with its moov atom, so the phone can play before it has all of it", async () => {
    const { run, calls } = workingRunner();
    await compressForSending({ source, outDir, ceilingBytes: CEILING, run });

    const encode = calls.find((call) => call.file === "ffmpeg" && call.args.includes("-movflags"));
    expect(encode?.args).toContain("+faststart");
  });

  it("should refuse a result that is still over the ceiling rather than hand back bytes the store will reject", async () => {
    // The encode can overshoot. If it does, the honest answer is a reason —
    // not an upload that fails later with `too-large` and no explanation.
    const { run } = workingRunner({ outputBytes: 11 * 1024 * 1024 });
    const result = await compressForSending({ source, outDir, ceilingBytes: CEILING, run });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/ceiling|too large|10485760|larger/i);
  });

  it("should say so plainly when there is no ffmpeg on the machine", async () => {
    const run: MediaRunner = async () => ({
      ok: false,
      stdout: "",
      message: "spawn ffprobe ENOENT",
    });
    const result = await compressForSending({ source, outDir, ceilingBytes: CEILING, run });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/ffprobe|ffmpeg/i);
  });

  it("should refuse a source that is not on disk", async () => {
    const { run } = workingRunner();
    const result = await compressForSending({
      source: join(dir, "nothing-here.mp4"),
      outDir,
      ceilingBytes: CEILING,
      run,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no video|not on disk|does not exist/i);
  });

  it("should refuse a clip whose duration ffprobe cannot read", async () => {
    // Without a duration there is no bitrate budget and no poster second, and
    // guessing either produces a file that silently does not fit.
    const run: MediaRunner = async (file) =>
      file === "ffprobe"
        ? { ok: true, stdout: JSON.stringify({ streams: [{ width: 784, height: 1168 }], format: {} }), message: "" }
        : { ok: true, stdout: "", message: "" };

    const result = await compressForSending({ source, outDir, ceilingBytes: CEILING, run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/duration|how long/i);
  });

  it("should refuse when ffmpeg reports success and writes nothing", async () => {
    const run: MediaRunner = async (file) =>
      file === "ffprobe"
        ? { ok: true, stdout: probeJson(784, 1168, 15), message: "" }
        : { ok: true, stdout: "", message: "" };

    const result = await compressForSending({ source, outDir, ceilingBytes: CEILING, run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/wrote no|nothing|no file/i);
  });

  it("should not scale a clip that is already smaller than the longest edge", async () => {
    const run: MediaRunner = async (file, args) => {
      if (file === "ffprobe") return { ok: true, stdout: probeJson(400, 600, 10), message: "" };
      const target = args[args.length - 1] ?? "";
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, target.endsWith(".jpg") ? jpeg() : mp4(1024));
      return { ok: true, stdout: "", message: "" };
    };

    const result = await compressForSending({ source, outDir, ceilingBytes: CEILING, run });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.width).toBe(400);
    expect(result.height).toBe(600);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(SENDING_MAX_EDGE);
  });
});
