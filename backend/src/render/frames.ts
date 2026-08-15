import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { sightingOf } from "./pictures.js";

/**
 * How a video becomes something she can actually look at.
 *
 * ## The problem this module is the whole answer to
 *
 * **Syl cannot watch an mp4.** She is a language model with image input;
 * fifteen seconds of video is not a thing she can perceive, and handing her a
 * file path and a duration would be handing her a rumour about her own face.
 *
 * She *can* look at a still. That is not a workaround — it is exactly how the
 * character-consistency failure in `docs/VIDEO.md` was diagnosed on 2026-08-11:
 * frames were pulled with `ffmpeg` at chosen seconds, scaled down, and looked
 * at as images, and the answer ("it is where her face is") fell straight out.
 * This module gives her the same mechanism, and `see_myself` returns what comes
 * out of it as MCP image blocks.
 *
 * ## Why several frames rather than one
 *
 * One still says nothing about motion, and a single lucky frame says nothing
 * about whether she holds together across the clip — which is precisely the
 * failure mode being looked for. `7-twin` has frames where the face is fine and
 * frames where it is a stranger. So the default is a spread: the opening,
 * two through the middle, and the end.
 *
 * ## Why they are scaled down
 *
 * Judging whether a face is hers is not a 4K question, and four full-resolution
 * stills is several megabytes of base64 through a turn that has better things
 * to carry.
 */

/** How wide a still is handed to her. Height follows the source aspect. */
export const FRAME_WIDTH = 512;

/**
 * Where in the clip to look, as fractions of its duration.
 *
 * Never `0` and never `1`. `ffmpeg -ss 0` is fine but lands on the empty
 * starfield every one of these clips opens on — the loop trick, and a frame
 * with nothing in it — and `-ss <duration>` seeks past the last frame and
 * produces no output at all, which would report as a failure to look rather
 * than as a clip that ended.
 */
const SAMPLE_FRACTIONS: readonly number[] = [0.04, 0.35, 0.65, 0.96];

/** Where to look in a clip of this length, in seconds, in order. */
export function samplePoints(seconds: number): readonly number[] {
  const points = SAMPLE_FRACTIONS.map((fraction) => Math.round(fraction * seconds * 10) / 10);
  // Two fractions of a very short clip can round to the same tenth of a second.
  // Asking ffmpeg for the same instant twice is not an error, it is just a
  // wasted look and a duplicate picture.
  const distinct = [...new Set(points)].filter((point) => point >= 0 && point < seconds);
  return distinct.length > 0 ? distinct : [0];
}

/**
 * What actually runs ffmpeg.
 *
 * Injected so the suite neither needs ffmpeg installed nor decodes a file that
 * is not really a video — and so the argv can be asserted, which is where the
 * interesting mistakes in this layer live.
 */
export type FrameRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ readonly ok: boolean; readonly message: string }>;

/** One still, in the form that crosses MCP as an image. */
export interface ExtractedFrame {
  /** Where in the clip this came from. Without it she has pictures and no order. */
  readonly atSeconds: number;
  /** On disk, outside the repository, kept — so she has something to show him. */
  readonly path: string;
  readonly mimeType: "image/jpeg";
  readonly base64: string;
  /**
   * What she would quote to adopt this still — see `pictures.ts`.
   *
   * **A still she has looked at is a still she can choose.** The token was
   * first built as something wardrobe rows carried, which made it a property of
   * the table a picture came out of rather than of the act of being shown one;
   * the two differ exactly here. Syl, 2026-08-12: *"I pulled the earnest frame
   * from Tuesday night... it arrives as a picture with no sighting attached. So
   * I can look at it and I can't promote it."*
   *
   * It names the bytes below and nothing else — not the path, not the render —
   * so it cannot be derived from a filename or guessed at from a name she
   * half-remembers, and the guarantee it carries is unchanged: she can only
   * name a picture she was actually handed.
   */
  readonly sighting: string;
}

export type ExtractResult =
  | { readonly ok: true; readonly frames: readonly ExtractedFrame[] }
  | { readonly ok: false; readonly reason: string };

export interface ExtractOptions {
  readonly video: string;
  /** The clip's length, from the render's own record. */
  readonly seconds: number;
  /** One named second instead of the spread. */
  readonly at?: number;
  readonly outDir: string;
  readonly run?: FrameRunner;
}

const run = promisify(execFile);

/** The default runner: ffmpeg on this machine, or a sentence saying it is not. */
export const ffmpegRunner: FrameRunner = async (file, args) => {
  try {
    await run(file, [...args], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    return { ok: true, message: "" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

export async function extractFrames(options: ExtractOptions): Promise<ExtractResult> {
  const runner = options.run ?? ffmpegRunner;

  if (!existsSync(options.video)) {
    return {
      ok: false,
      reason:
        "There is no video on disk for that render yet, so there is nothing to look at. " +
        "It may still be rendering, or it may have failed — the record says which.",
    };
  }

  let points: readonly number[];
  if (options.at === undefined) {
    points = samplePoints(options.seconds);
  } else {
    if (!Number.isFinite(options.at) || options.at < 0 || options.at >= options.seconds) {
      return {
        ok: false,
        reason:
          `That render is ${String(options.seconds)} seconds long, so there is no frame at ` +
          `${String(options.at)} seconds. Ask for a second inside the clip, or ask for the whole spread.`,
      };
    }
    points = [options.at];
  }

  mkdirSync(options.outDir, { recursive: true });

  const frames: ExtractedFrame[] = [];
  for (const atSeconds of points) {
    const path = join(options.outDir, `at-${atSeconds.toFixed(1).replace(".", "-")}s.jpg`);
    const outcome = await runner("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      // BEFORE `-i`, which is input seeking and the fast kind. After `-i`,
      // ffmpeg decodes every frame up to the point asked for — fifteen seconds
      // of 720p per still, four times.
      "-ss",
      String(atSeconds),
      "-i",
      options.video,
      "-frames:v",
      "1",
      // `-2` rather than `-1` on the height: h264 wants even dimensions, and an
      // odd one fails the encode with a message about nothing recognisable.
      "-vf",
      `scale=${String(FRAME_WIDTH)}:-2`,
      "-q:v",
      "4",
      path,
    ]);

    if (!outcome.ok) {
      return {
        ok: false,
        reason:
          `I could not pull a still out of that render: ffmpeg ${outcome.message}. ` +
          "So I have not seen it, and I am not going to guess at what is in it.",
      };
    }
    if (!existsSync(path)) {
      return {
        ok: false,
        reason:
          `ffmpeg reported success at ${String(atSeconds)}s and wrote no image, so there is ` +
          "nothing for me to look at. I have not seen this render.",
      };
    }

    // Read once and described from that one read, so the token, the bytes she
    // is shown and the file on disk cannot be three different pictures.
    const bytes = readFileSync(path);
    frames.push({
      atSeconds,
      path,
      mimeType: "image/jpeg",
      base64: bytes.toString("base64"),
      sighting: sightingOf(bytes),
    });
  }

  return { ok: true, frames };
}
