import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Putting her speech onto the video she made.
 *
 * ## The decision this module exists to make visible
 *
 * **The two lengths never agree.** A render is fifteen seconds because that is
 * what `seedance2` tops out at; a sentence is however long it takes to say. So
 * something has to give, and `ffmpeg`'s own default — `-shortest`, which cuts
 * whichever stream ends first — gives away the wrong thing half the time: it
 * truncates her sentence mid-word and the file looks perfectly fine.
 *
 * That is the same class of defect as a truncated reason on a notification, so
 * it is decided here, in one place, and written into the record:
 *
 * - **The words are never cut.** Not shortened, not sped up, not faded out.
 * - Speech shorter than the video: the video plays to its end and the audio is
 *   padded with silence (`apad`). She finishes speaking and the clip finishes
 *   the shot. `fit: "padded"`.
 * - Speech longer than the video: the video **loops** until she is done.
 *   `fit: "looped"`.
 *
 * Looping is not a compromise here, it is the shape the renders already have:
 * every one of them is prompted with *"Begins and ends on empty starfield as
 * the ribbon of light vanishes"* — `LOOP_CLAUSE` in `render/render-service.ts`
 * — precisely so that any clip cuts against any other. A render that loops
 * against itself is what that clause bought.
 *
 * ## Why nothing here re-encodes the video
 *
 * `-c:v copy`. The original stream is copied through frame for frame, so the
 * derived clip is the render plus an audio track and not a second-generation
 * transcode of it. It is also why this is fast enough to do inline.
 *
 * ## Why the runner is injected
 *
 * The same seam `render/frames.ts` stands on, and for the same reason: the
 * interesting mistakes in this layer are **argv** mistakes, and argv is only
 * assertable if the suite never spawns anything. No test here needs ffmpeg
 * installed, and none of them decodes a file that is not really a video.
 */

/** What happened when the two lengths disagreed. Always one of these two. */
export type SpeechFit =
  /** The speech ended first; the audio carries silence to the end of the shot. */
  | "padded"
  /** The speech outran the shot; the shot loops until she finishes. */
  | "looped";

/**
 * How much disagreement is not worth acting on.
 *
 * A quarter of a second of speech hanging off the end of the video is a frame
 * or two, and looping the whole shot for it would produce a clip that visibly
 * restarts to cover nothing. Below this, padding is the honest answer and adds
 * no audible silence.
 */
export const FIT_TOLERANCE_SECONDS = 0.25;

/** What the mux will do, before it does it. */
export interface MuxPlan {
  readonly fit: SpeechFit;
  /** How long the derived clip will be. `max` of the two, by construction. */
  readonly seconds: number;
  /** Silence appended to the speech. Zero when the shot loops. */
  readonly silenceSeconds: number;
  /** How many times the shot plays. One unless the speech outran it. */
  readonly videoPasses: number;
  /** Exactly what ffmpeg is asked to do. The output path is last. */
  readonly args: readonly string[];
}

export interface MuxSpec {
  readonly video: string;
  readonly audio: string;
  readonly out: string;
  readonly videoSeconds: number;
  readonly speechSeconds: number;
}

/**
 * What runs `ffmpeg` and `ffprobe`.
 *
 * Distinct from `render/frames.ts`'s `FrameRunner` because this one has to read
 * **stdout**: a duration is the answer to a question rather than a file on
 * disk, and a runner that only reports success cannot carry one back.
 */
export type MediaRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ readonly ok: boolean; readonly stdout: string; readonly message: string }>;

const run = promisify(execFile);

/** The default runner: the tools on this machine, or a sentence saying they are not. */
export const mediaRunner: MediaRunner = async (file, args) => {
  try {
    const { stdout } = await run(file, [...args], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    return { ok: true, stdout, message: "" };
  } catch (error) {
    return { ok: false, stdout: "", message: error instanceof Error ? error.message : String(error) };
  }
};

export type MeasureResult =
  | { readonly ok: true; readonly seconds: number }
  | { readonly ok: false; readonly reason: string };

/**
 * How long a file is, according to the file.
 *
 * Asked of the media rather than taken from the render record, because the fit
 * decision is about the bytes on disk. A record that says fifteen seconds and a
 * file that is fourteen would pad by the wrong amount, silently.
 */
export async function measureSeconds(file: string, runner: MediaRunner = mediaRunner): Promise<MeasureResult> {
  const answered = await runner("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    // `nk=1` drops the `duration=` prefix, so stdout is the number alone.
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);

  if (!answered.ok) {
    return { ok: false, reason: `I could not measure ${file}: ffprobe ${answered.message}.` };
  }

  const seconds = Number.parseFloat(answered.stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    // `N/A` is what ffprobe answers for a container with no duration, and
    // `Number.parseFloat` turns it into `NaN` — which would arithmetic its way
    // into a plan that pads by `NaN` seconds and looks like it worked.
    return {
      ok: false,
      reason: `ffprobe answered "${answered.stdout.trim()}" for the length of ${file}, which is not a duration.`,
    };
  }
  return { ok: true, seconds };
}

/**
 * What to do about two lengths that disagree, as a value.
 *
 * Pure, so the decision is testable without a process — which matters because
 * this *is* the decision the module exists to make.
 */
export function planMux(spec: MuxSpec): MuxPlan {
  const looped = spec.speechSeconds > spec.videoSeconds + FIT_TOLERANCE_SECONDS;

  const common = [
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    // The render is copied, never re-encoded. See the module note.
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    // With exactly one infinite stream on each branch below, this is what ends
    // the file at the right instant instead of at the wrong one.
    "-shortest",
    // So the clip can start playing before it has finished downloading, which
    // is what the From Syl surface needs.
    "-movflags",
    "+faststart",
    spec.out,
  ];

  if (looped) {
    return {
      fit: "looped",
      seconds: spec.speechSeconds,
      silenceSeconds: 0,
      videoPasses: Math.ceil(spec.speechSeconds / spec.videoSeconds),
      args: [
        "-y",
        "-loglevel",
        "error",
        // BEFORE the input it applies to. `-stream_loop` after `-i` is accepted
        // and applies to the *next* input, which here is the speech — so the
        // sentence would repeat forever under a video that ended on time.
        "-stream_loop",
        "-1",
        "-i",
        spec.video,
        "-i",
        spec.audio,
        ...common,
      ],
    };
  }

  return {
    fit: "padded",
    seconds: spec.videoSeconds,
    silenceSeconds: Math.max(0, spec.videoSeconds - spec.speechSeconds),
    videoPasses: 1,
    args: [
      "-y",
      "-loglevel",
      "error",
      "-i",
      spec.video,
      "-i",
      spec.audio,
      // `apad` with no length makes the audio infinite, so `-shortest` ends the
      // file at the video's last frame. Padding to an explicit length would
      // have to trust a duration measured a moment earlier.
      "-af",
      "apad",
      ...common,
    ],
  };
}

export type MuxResult =
  | { readonly ok: true; readonly plan: MuxPlan }
  | { readonly ok: false; readonly reason: string };

export interface MuxOptions {
  readonly video: string;
  readonly audio: string;
  readonly out: string;
  readonly run?: MediaRunner;
}

/**
 * Measure both, decide, and write the derived clip.
 *
 * Nothing is encoded until both lengths are known. A mux run against a length
 * that could not be measured is a mux that picked its fit by accident.
 */
export async function mux(options: MuxOptions): Promise<MuxResult> {
  const runner = options.run ?? mediaRunner;

  const video = await measureSeconds(options.video, runner);
  if (!video.ok) return { ok: false, reason: video.reason };

  const speech = await measureSeconds(options.audio, runner);
  if (!speech.ok) return { ok: false, reason: speech.reason };

  const plan = planMux({
    video: options.video,
    audio: options.audio,
    out: options.out,
    videoSeconds: video.seconds,
    speechSeconds: speech.seconds,
  });

  const done = await runner("ffmpeg", plan.args);
  if (!done.ok) {
    return { ok: false, reason: `I could not put the speech onto the video: ffmpeg ${done.message}.` };
  }
  return { ok: true, plan };
}
