import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { extractFrames, type FrameRunner } from "../render/frames.js";

/**
 * How a render becomes something that can be sent.
 *
 * ## The number this module exists for
 *
 * `MAX_ATTACHMENT_BYTES` is 10 MB and a fifteen-second render is 12-15 MB.
 * **The ceiling is not raised.** `routes/attachments.ts` derives its
 * request-body limit *from* the store's ceiling precisely so the two cannot
 * disagree, so raising one inflates the accepted request size for every upload
 * in the service — an SSRF-adjacent surface widened to solve a video problem.
 * The clips already shipped in `ios/Syl/Resources/` are 1.3-2.3 MB from the
 * same source at 784x1168, so the budget is comfortable and compressing is the
 * cheap half of this trade.
 *
 * ## The compressed copy is derived; the render is the record
 *
 * Nothing here opens the source for writing, and the output always goes to a
 * different path. A re-encode that overwrote the original would trade a
 * regenerable file for an unregenerable one, and it would do it silently.
 *
 * ## Why it probes rather than assumes
 *
 * The width, height and duration stored on the attachment row come from
 * `ffprobe` reading the file, not from a render record's `ratio` field or from
 * anything a caller believes. That is the same rule `attachment-store.ts` is
 * built on: the file's own answer is the only source that cannot disagree with
 * the file. A layout hint taken from a claim is a bubble that jumps.
 *
 * ## Nothing here spawns a process in a test
 *
 * The runner is injected, exactly as `render/frames.ts` does it, for the same
 * two reasons: CI has no ffmpeg, and the interesting mistakes in this layer
 * live in the argv rather than in the encode.
 */

/**
 * The longest edge of the copy that gets sent.
 *
 * 720 rather than the source's own 1168: this is a phone-sized clip in a list
 * and then in a player on the same phone, and the bytes are crossing a tailnet
 * on cellular. The shipped clips prove the quality holds — they are 784 wide
 * and nobody has complained about how they look.
 */
export const SENDING_MAX_EDGE = 720;

/**
 * How much of the ceiling the encode is allowed to aim at.
 *
 * Not 1.0, and the gap is not timidity. A capped encode still overshoots a
 * little around scene changes, and a file that lands at 10.2 MB is refused by
 * the store with `too-large` — which reaches her as a failed sending rather
 * than as the near-miss it actually was. Aiming at 60% makes the overshoot
 * case rare rather than routine, and 6 MB is still four times what the shipped
 * clips spend on the same fifteen seconds.
 */
export const SENDING_BUDGET_FRACTION = 0.6;

/**
 * Where in the clip the poster frame comes from, as a fraction of its length.
 *
 * **Never zero.** `frames.ts` says why and it is the whole reason this is a
 * named constant rather than a `0` somebody would find reasonable: her loops
 * open and close on empty starfield — the trick that makes any clip cut
 * against any other — so frame zero is a picture of nothing at all. A list of
 * sendings showing eight identical black rectangles would be worse than
 * showing no still.
 *
 * 0.35 rather than 0.5 because the middle of a fifteen-second clip is often
 * mid-gesture; a third of the way in she is generally settled and facing
 * forward.
 */
export const POSTER_FRACTION = 0.35;

/** Audio bitrate, when the render has a voice on it. */
const AUDIO_KBPS = 96;

/**
 * What actually runs ffmpeg and ffprobe.
 *
 * Distinct from `FrameRunner` by exactly one field: `stdout`. `frames.ts` only
 * ever needs to know whether ffmpeg succeeded, and this module has to *read*
 * ffprobe's answer. Rather than widen the render module's type — which is
 * another agent's file and a shape three call sites depend on — the wider
 * contract lives here and is narrowed on the way in when `extractFrames` is
 * called.
 */
export type MediaRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ readonly ok: boolean; readonly stdout: string; readonly message: string }>;

const run = promisify(execFile);

/** The default runner: the binaries on this machine, or a sentence saying they are not. */
export const ffmpegMediaRunner: MediaRunner = async (file, args) => {
  try {
    const { stdout } = await run(file, [...args], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout, message: "" };
  } catch (error) {
    return { ok: false, stdout: "", message: error instanceof Error ? error.message : String(error) };
  }
};

/** Pixels. */
export interface Fitted {
  readonly width: number;
  readonly height: number;
}

/**
 * Scale to fit inside `maxEdge`, preserving the aspect, always even.
 *
 * Even is not tidiness: h264's chroma subsampling wants even dimensions and an
 * odd one fails the encode with a message about nothing recognisable. It is
 * the kind of failure that costs an afternoon because the error names a pixel
 * format rather than the number that was wrong.
 *
 * A clip already inside the box is returned untouched rather than re-scaled to
 * a nearby even number — upscaling nothing to nothing costs quality for no
 * reason.
 */
export function fitWithin(width: number, height: number, maxEdge: number): Fitted {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width: even(width), height: even(height) };

  const scale = maxEdge / longest;
  return { width: even(width * scale), height: even(height * scale) };
}

/** Nearest even integer, never below 2 — a zero edge is not a picture. */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Which second to pull the poster from.
 *
 * Strictly inside the clip at both ends. `ffmpeg -ss 0` is valid and lands on
 * the empty starfield; `-ss <duration>` seeks past the last frame and writes
 * no file at all, which would report as "I could not look at it" rather than
 * as a clip that ended.
 */
export function posterSecondFor(seconds: number): number {
  const at = Math.round(seconds * POSTER_FRACTION * 100) / 100;
  if (at > 0 && at < seconds) return at;
  // A clip so short the fraction rounds to nothing, or to the whole thing.
  // Half of it is inside it by construction, for any positive length.
  return seconds / 2;
}

export interface CompressOptions {
  /** The full-quality render. Read only, never written. */
  readonly source: string;
  /** Where the compressed copy and the poster go. Created if absent. */
  readonly outDir: string;
  /** The store's ceiling. Passed in rather than imported, so a test can shrink it. */
  readonly ceilingBytes: number;
  readonly run?: MediaRunner;
}

export type CompressResult =
  | {
      readonly ok: true;
      /** The compressed copy, on disk. */
      readonly path: string;
      readonly bytes: number;
      readonly width: number;
      readonly height: number;
      readonly durationMs: number;
      /** A JPEG of her, from inside the clip. Becomes the attachment's thumbnail. */
      readonly poster: Buffer;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Make a sendable copy of a render, and a still to put on it.
 *
 * Every refusal is a sentence rather than a code, because every one of them
 * ends up in a `Sending.reason` that she reads and that he may see.
 */
export async function compressForSending(options: CompressOptions): Promise<CompressResult> {
  const runner = options.run ?? ffmpegMediaRunner;

  if (!existsSync(options.source)) {
    return {
      ok: false,
      reason:
        "There is no video on disk for that render, so there is nothing to send. " +
        "It may still be rendering, or it may have failed — the record says which.",
    };
  }

  const probed = await probe(options.source, runner);
  if (!probed.ok) return probed;

  const fitted = fitWithin(probed.width, probed.height, SENDING_MAX_EDGE);
  const seconds = probed.durationMs / 1000;

  mkdirSync(options.outDir, { recursive: true });
  const target = join(options.outDir, "sending.mp4");

  // The whole budget in bits, spread over the clip, minus what the audio will
  // take. A cap computed from the ceiling is the only kind that means
  // anything: a fixed bitrate is right for exactly one duration.
  const budgetBits = options.ceilingBytes * SENDING_BUDGET_FRACTION * 8;
  const videoKbps = Math.max(200, Math.floor(budgetBits / seconds / 1000) - AUDIO_KBPS);

  const encoded = await runner("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    options.source,
    "-vf",
    `scale=${String(fitted.width)}:${String(fitted.height)}`,
    "-c:v",
    "libx264",
    // Universally playable, and the one every AVPlayer path handles without
    // thinking about it.
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    `${String(videoKbps)}k`,
    // The pair that turns an average into a ceiling. Without `-maxrate` the
    // encoder is free to spend whatever a hard scene needs and apologise
    // afterwards, which is how a "compressed" clip comes back over the limit.
    "-maxrate",
    `${String(videoKbps)}k`,
    "-bufsize",
    `${String(videoKbps * 2)}k`,
    // No `-map`: ffmpeg's default picks the best video stream and the best
    // audio stream IF THERE IS ONE. The shipped clips are silent and her
    // voice is the next thing being built, so this path has to work both ways
    // without a branch.
    "-c:a",
    "aac",
    "-b:a",
    `${String(AUDIO_KBPS)}k`,
    // The moov atom at the front. Without it a player must fetch the whole
    // file before the first frame, which on a tailnet over cellular is the
    // difference between tapping a row and watching a spinner.
    "-movflags",
    "+faststart",
    target,
  ]);

  if (!encoded.ok) {
    return {
      ok: false,
      reason: `I could not compress that render to something small enough to send: ffmpeg ${encoded.message}`,
    };
  }
  if (!existsSync(target)) {
    return {
      ok: false,
      reason:
        "ffmpeg reported success and wrote no file, so there is nothing to send. " +
        "The render itself is untouched.",
    };
  }

  const bytes = statSync(target).size;
  if (bytes > options.ceilingBytes) {
    // The cap was not enough — a very busy clip, or a duration the budget did
    // not suit. Saying so here is far better than handing the store bytes it
    // will refuse with `too-large`, which reaches her as a failure that names
    // a number instead of a cause.
    return {
      ok: false,
      reason:
        `The compressed copy came out at ${String(bytes)} bytes, still over the ` +
        `${String(options.ceilingBytes)} byte ceiling, so I have not sent it. The render is fine.`,
    };
  }

  const poster = await posterFor({
    video: target,
    seconds,
    outDir: options.outDir,
    run: runner,
  });
  if (!poster.ok) return poster;

  return {
    ok: true,
    path: target,
    bytes,
    width: fitted.width,
    height: fitted.height,
    durationMs: probed.durationMs,
    poster: poster.jpeg,
  };
}

/** What ffprobe was asked and what it said. */
type ProbeResult =
  | { readonly ok: true; readonly width: number; readonly height: number; readonly durationMs: number }
  | { readonly ok: false; readonly reason: string };

async function probe(video: string, runner: MediaRunner): Promise<ProbeResult> {
  const probed = await runner("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    video,
  ]);

  if (!probed.ok) {
    return {
      ok: false,
      reason:
        `I could not read that render to find out how big it is: ffprobe ${probed.message}. ` +
        "Without that I would be guessing at what to send.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(probed.stdout);
  } catch {
    return { ok: false, reason: "ffprobe answered with something that is not JSON, so I have not read that render." };
  }

  // Safe assertion: every field is type-tested immediately below, and a shape
  // that does not match falls through to a named refusal.
  const shape = parsed as {
    streams?: readonly { width?: unknown; height?: unknown }[];
    format?: { duration?: unknown };
  };

  const stream = shape.streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return {
      ok: false,
      reason: "ffprobe could not tell me that render's dimensions, so I cannot size the copy to send.",
    };
  }

  const seconds = Number(shape.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    // Not recoverable by guessing: the duration is both the bitrate budget and
    // the poster second, and a wrong one produces a file that silently does
    // not fit or a still from past the end of the clip.
    return {
      ok: false,
      reason: "ffprobe could not tell me how long that render is, and I will not guess at it.",
    };
  }

  return { ok: true, width, height, durationMs: Math.round(seconds * 1000) };
}

/**
 * One still, from inside the clip.
 *
 * Delegates to `render/frames.ts` rather than shelling out again: that module
 * is where "pull a frame out of a video" already lives, it already knows never
 * to ask for frame zero, and having a second implementation of the same seek
 * is how the two drift. **One mechanism, three uses** — she judges herself by
 * it, the From Syl list shows it, and it is the poster the player needs.
 */
async function posterFor(options: {
  readonly video: string;
  readonly seconds: number;
  readonly outDir: string;
  readonly run: MediaRunner;
}): Promise<{ readonly ok: true; readonly jpeg: Buffer } | { readonly ok: false; readonly reason: string }> {
  // Narrowed to the render module's own runner shape. It never reads stdout.
  const frameRunner: FrameRunner = async (file, args) => {
    const outcome = await options.run(file, args);
    return { ok: outcome.ok, message: outcome.message };
  };

  const extracted = await extractFrames({
    video: options.video,
    seconds: options.seconds,
    at: posterSecondFor(options.seconds),
    outDir: join(options.outDir, "poster"),
    run: frameRunner,
  });

  if (!extracted.ok) return { ok: false, reason: extracted.reason };

  const frame = extracted.frames[0];
  if (frame === undefined) {
    return {
      ok: false,
      reason: "Nothing came back when I pulled a still out of that clip, so it would arrive with no face on it.",
    };
  }

  return { ok: true, jpeg: readFileSync(frame.path) };
}
