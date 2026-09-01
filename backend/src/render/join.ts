import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ffmpegRunner, type FrameRunner } from "./frames.js";

/**
 * Cutting two generations together on the frame they were both pinned to.
 *
 * ## Why a render is ever more than one generation
 *
 * Runway's `image_to_video` gives a clip exactly **two** keyframe slots. Probed
 * on 2026-08-11: `promptImage` takes `{uri, position}` and the 400 enumerates
 * the whole position vocabulary as `"first"|"last"` — there is no third place to
 * put a picture. seedance2's entire request body is `model`, `promptImage`,
 * `promptText`, `ratio` and `duration`; `references`, `referenceImages`,
 * `characterId`, `seed` and fifteen other candidates all come back as
 * *Unrecognized key*, which is a strict validator answering rather than a
 * silence being interpreted.
 *
 * So a clip that opens on the bare ribbon **and closes on it** has spent both
 * slots on the ribbon, and there is nowhere left to pin her face. The Commander
 * asked for both ends back on 2026-08-11, so the likeness moves to the **join**:
 * one generation gathers the ribbon into her and ends on her portrait, a second
 * starts from the frame the first one ended on and unravels back to the ribbon,
 * and the two are cut together there.
 *
 * The join is invisible for the same reason the reel's joins are invisible —
 * the two clips meet on the *same frame*, not on two renderings of a similar
 * one. {@link lastFrame} is what makes that true: the second half's opening
 * picture is pulled out of the first half rather than chosen to resemble it.
 *
 * ## Why the second half starts from an extracted frame and not from her reference
 *
 * Shape. Measured 2026-08-11 with a 4-second probe: handing the 1120x832
 * landscape `reference.png` over as the `first` picture produced a **1112x834
 * landscape** video, because the opening frame decides the aspect and overrules
 * `ratio`. Two halves of different shapes do not cut together at all. The frame
 * pulled out of the first half is already 834x1112, so the second half inherits
 * the shape rather than arguing with it, and no second portrait asset has to be
 * kept in step with the first.
 */

/** How a step of the join went, as a sentence rather than an exit code. */
export type JoinResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface LastFrameOptions {
  readonly video: string;
  /** Where to write it. A `.png`, so the join frame is lossless. */
  readonly to: string;
  readonly run?: FrameRunner;
}

/**
 * The final frame of a clip, as a still the next generation can start from.
 *
 * `-sseof` seeks from the END of the file, which is the only way to ask for the
 * last frame without knowing the duration to the millisecond — and the duration
 * Runway returns is the one it was asked for, not the one it produced (the
 * probe above came back 4.041667s for a 4-second request). `-update 1` lets a
 * single output file be overwritten as frames arrive, so the file left behind
 * is the last one decoded rather than the first.
 */
export async function lastFrame(options: LastFrameOptions): Promise<JoinResult> {
  const run = options.run ?? ffmpegRunner;

  if (!existsSync(options.video)) {
    return {
      ok: false,
      reason: `There is no video at ${options.video} to take a closing frame from.`,
    };
  }

  mkdirSync(dirname(options.to), { recursive: true });
  const outcome = await run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-sseof",
    "-0.2",
    "-i",
    options.video,
    "-update",
    "1",
    "-frames:v",
    "1",
    options.to,
  ]);

  if (!outcome.ok) {
    return {
      ok: false,
      reason: `I could not take the closing frame off the first half: ffmpeg ${outcome.message}.`,
    };
  }
  if (!existsSync(options.to)) {
    return {
      ok: false,
      reason:
        "ffmpeg reported success and wrote no closing frame, so there is nothing for the second " +
        "half to start from.",
    };
  }
  return { ok: true };
}

export interface JoinOptions {
  /**
   * The parts, in the order they play. Absolute paths. Two or more.
   *
   * **Always an array, and the arity limit has always been two** — the concat
   * demuxer's list file is the mechanism built for arbitrary counts. This looked
   * like a two-part function only because its sole caller joined the two halves
   * of one anchored render; `syl-5y4n` gave it a second caller that joins four
   * finished ones, and the only thing that had to change was the sentences.
   */
  readonly parts: readonly string[];
  readonly to: string;
  /** Where the concat list is written. Kept, like everything else about a render. */
  readonly listFile: string;
  readonly run?: FrameRunner;
}

/**
 * Join finished parts into one clip.
 *
 * The concat **demuxer** with `-c copy`, not the concat filter: re-encoding
 * would cost a generation of quality on footage that is her face, and buy
 * nothing where the streams already agree. `-safe 0` is required because the
 * list holds absolute paths, which is what her home gives us.
 *
 * **`-c copy` is safe only while the parts DO agree, and that is a property of
 * the caller rather than of this function.** Inside one render it is free: both
 * halves come from the same model at the same ratio. Across separately made
 * renders it is not, and a mismatch here does not fail — it writes a file that
 * plays as rubbish, at exit code zero. `probe.ts` is where that is checked, and
 * `RenderService.join` is what refuses before reaching this.
 *
 * ## The sentences are n-ary too
 *
 * They used to say "half". Join four and it reported about halves — the
 * two-part assumption leaking into the one thing that has to be true at three
 * in the morning, which is what a failure says.
 */
export async function joinVideos(options: JoinOptions): Promise<JoinResult> {
  const run = options.run ?? ffmpegRunner;

  // The POSITION as well as the path. With two parts a path answers "which
  // one"; with four it answers it slowly, and this is read by somebody who is
  // already having a bad time.
  const missing = options.parts
    .map((part, index) => ({ part, at: index + 1 }))
    .filter(({ part }) => !existsSync(part));
  if (missing.length > 0) {
    const named = missing.map(({ part, at }) => `part ${String(at)} (${part})`).join(", ");
    return {
      ok: false,
      reason: `${missing.length === 1 ? "One part" : `${String(missing.length)} parts`} of this join ${
        missing.length === 1 ? "is" : "are"
      } not on disk — ${named} — so there is nothing to join.`,
    };
  }
  if (options.parts.length < 2) {
    return {
      ok: false,
      reason: `A join needs two or more parts and was given ${String(options.parts.length)}.`,
    };
  }

  mkdirSync(dirname(options.listFile), { recursive: true });
  // Single quotes, and a quote inside a path closed, escaped and reopened —
  // `'\''`, the concat demuxer's own convention. Render names are `[a-z0-9-]`
  // so this cannot bite today; it is here so that a name rule loosened later
  // does not silently become a way to write a directive into the list file.
  writeFileSync(
    options.listFile,
    `${options.parts.map((part) => `file '${part.replace(/'/gu, "'\\''")}'`).join("\n")}\n`,
  );

  mkdirSync(dirname(options.to), { recursive: true });
  const outcome = await run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    options.listFile,
    "-c",
    "copy",
    options.to,
  ]);

  if (!outcome.ok) {
    return {
      ok: false,
      reason: `I could not cut the ${String(options.parts.length)} parts together: ffmpeg ${outcome.message}.`,
    };
  }
  if (!existsSync(options.to)) {
    return {
      ok: false,
      reason: "ffmpeg reported success and wrote no joined render, so there is nothing to look at.",
    };
  }
  return { ok: true };
}
