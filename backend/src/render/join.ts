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
  /** The halves, in the order they play. Absolute paths. */
  readonly parts: readonly string[];
  readonly to: string;
  /** Where the concat list is written. Kept, like everything else about a render. */
  readonly listFile: string;
  readonly run?: FrameRunner;
}

/**
 * Join finished halves into the one clip that is the render.
 *
 * The concat **demuxer** with `-c copy`, not the concat filter: both halves come
 * from the same model at the same ratio, so their streams are already
 * compatible and there is no reason to re-encode her twice. `-safe 0` is
 * required because the list holds absolute paths, which is what her home gives
 * us.
 */
export async function joinVideos(options: JoinOptions): Promise<JoinResult> {
  const run = options.run ?? ffmpegRunner;

  const missing = options.parts.filter((part) => !existsSync(part));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Half of this render is not on disk (${missing.join(", ")}), so there is nothing to join.`,
    };
  }
  if (options.parts.length < 2) {
    return { ok: false, reason: "A join needs two halves and was given fewer." };
  }

  mkdirSync(dirname(options.listFile), { recursive: true });
  // Single quotes, and any quote inside a path doubled — ffmpeg's own escaping
  // for the concat list. Render names are `[a-z0-9-]` so this cannot bite
  // today; it is here so that a name rule loosened later does not silently
  // become a way to write a directive into the list file.
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
    return { ok: false, reason: `I could not join the halves: ffmpeg ${outcome.message}.` };
  }
  if (!existsSync(options.to)) {
    return {
      ok: false,
      reason: "ffmpeg reported success and wrote no joined render, so there is nothing to look at.",
    };
  }
  return { ok: true };
}
