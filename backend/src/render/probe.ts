import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

/**
 * What a finished clip actually is, read off the file — and whether two of them
 * cut together.
 *
 * ## The problem this module is the whole answer to
 *
 * `joinVideos` concatenates with the concat demuxer and **`-c copy`**, and its
 * own comment says why that is safe: *"both halves come from the same model at
 * the same ratio, so their streams are already compatible."* That is true of
 * two halves of one render and it is exactly what stops being true across
 * separately made ones.
 *
 * There is a specific trap behind it. `promptImage` is frame one, and every
 * model takes the video's **aspect** from it and silently overrules `ratio` —
 * measured 2026-08-11, a 1120x832 landscape still produced a 1112x834 video
 * against a portrait request. So two renders opened on differently shaped
 * stills come out different shapes, and neither record has to say anything
 * unusual for that to be true.
 *
 * **A mismatched concat does not error.** With `-c copy` ffmpeg copies packets
 * it has not been asked to understand, so what comes out is a file that plays
 * as garbage, plays half way, or does not play at all — and the exit code is
 * zero. She would send that to him. So the join has to *ask the files* first,
 * and refuse with a sentence naming which parts disagree and how.
 *
 * ## Why the record cannot answer this
 *
 * `RenderRecord.ratio` is what was **asked for**. The whole point of the trap
 * above is that the ask is overruled, so a check against the record would be a
 * consistency check against ourselves — this project's named worst defect class
 * — and it would pass on precisely the renders it exists to catch.
 *
 * ## Why the runner is its own type
 *
 * Injected exactly as `FrameRunner` is, and for the same reasons: the
 * suite must not need ffprobe installed, must not decode a file that is not
 * really a video, and the argv is where the interesting mistakes live.
 *
 * It is a *different* type because a probe's answer **is its stdout**, and
 * `FrameRunner` throws stdout away — it reports whether ffmpeg worked, which is
 * all any of its three uses needs. Reusing it would mean reading a clip's shape
 * out of a field named `message`, and the next person to widen `FrameRunner`
 * would have no way to know that field was load-bearing.
 */

/** What runs ffprobe, and hands back what it said. */
export type ProbeRunner = (
  file: string,
  args: readonly string[],
) => Promise<
  { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly message: string }
>;

const run = promisify(execFile);

/** The default runner: ffprobe on this machine, or a sentence saying it is not. */
export const ffprobeRunner: ProbeRunner = async (file, args) => {
  try {
    const { stdout } = await run(file, [...args], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * What the concat demuxer needs two clips to agree about, and nothing else.
 *
 * Deliberately not "everything ffprobe knows". A field that is in here is a
 * field a join can be **refused** over, so each one has to be a real reason
 * `-c copy` would produce a broken file rather than a difference somebody
 * noticed.
 */
export interface ClipShape {
  readonly width: number;
  readonly height: number;
  /** `h264`, `hevc`. Copied packets are meaningless to a decoder expecting another codec. */
  readonly codec: string;
  /**
   * `yuv420p`, `yuv420p10le`. `null` where the file does not declare one.
   *
   * `null` rather than a default string, so "these two do not say" and "these
   * two say the same thing" are the same answer and "one says and one does not"
   * is a disagreement. A default would make an unknown compare equal to an
   * unknown, which is a check passing by agreeing about nothing.
   */
  readonly pixelFormat: string | null;
  /** Frames per second, worked out from the file's own rational. `null` where it says none. */
  readonly frameRate: number | null;
  /** The sound, described, or `null` for a silent clip. */
  readonly audio: string | null;
}

export type ProbeResult =
  | { readonly ok: true; readonly shape: ClipShape }
  | { readonly ok: false; readonly reason: string };

export interface ProbeOptions {
  readonly video: string;
  readonly run?: ProbeRunner;
}

/**
 * A clip's own shape, from ffprobe.
 *
 * JSON rather than the default output: the human-readable format is meant for a
 * person and rewords itself between versions, and a parser built on its prose
 * is a parser that breaks on somebody else's release note.
 */
export async function probeClip(options: ProbeOptions): Promise<ProbeResult> {
  const runner = options.run ?? ffprobeRunner;

  if (!existsSync(options.video)) {
    return { ok: false, reason: `There is no video at ${options.video} to look at.` };
  }

  const outcome = await runner("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    options.video,
  ]);
  if (!outcome.ok) {
    return {
      ok: false,
      reason: `I could not read ${options.video}: ffprobe ${outcome.message}.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch (error) {
    return {
      ok: false,
      reason:
        `I could not read what ffprobe said about ${options.video} — ` +
        `${error instanceof Error ? error.message : String(error)}. So I do not know what shape ` +
        "it is, and I am not going to assume it matches the others.",
    };
  }

  const streams = (parsed as { streams?: unknown }).streams;
  const rows = Array.isArray(streams) ? (streams as Record<string, unknown>[]) : [];
  const video = rows.find((stream) => stream["codec_type"] === "video");
  if (video === undefined) {
    return {
      ok: false,
      reason: `${options.video} has no video stream in it, so there is nothing of it to cut in.`,
    };
  }

  const width = video["width"];
  const height = video["height"];
  if (typeof width !== "number" || typeof height !== "number") {
    return {
      ok: false,
      // Not a default of zero. Two zeroes compare equal, so a defaulted
      // dimension is a compatibility check that passes by agreeing about
      // nothing — and the shape is the one property most likely to differ.
      reason: `ffprobe did not say how big ${options.video} is, so I cannot tell whether it matches.`,
    };
  }

  const codec = video["codec_name"];
  if (typeof codec !== "string" || codec === "") {
    return {
      ok: false,
      reason: `ffprobe did not say what codec ${options.video} is in, so I cannot tell whether it matches.`,
    };
  }

  const sound = rows.find((stream) => stream["codec_type"] === "audio");

  return {
    ok: true,
    shape: {
      width,
      height,
      codec,
      pixelFormat: typeof video["pix_fmt"] === "string" ? video["pix_fmt"] : null,
      frameRate: rateOf(video["r_frame_rate"]),
      audio: sound === undefined ? null : describeSound(sound),
    },
  };
}

/**
 * A frame rate as a number, from the rational ffprobe reports.
 *
 * `30000/1001` and `29.97` are the same clip. Comparing the strings would
 * refuse a join over two spellings of one number, which is a refusal she can do
 * nothing about — and the whole value of refusing is that the refusal is
 * actionable.
 */
function rateOf(declared: unknown): number | null {
  if (typeof declared !== "string") return null;
  const [top, bottom] = declared.split("/");
  const numerator = Number(top);
  const denominator = bottom === undefined ? 1 : Number(bottom);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  // Rounded, so two files that declare the same rate two ways are equal on the
  // nose rather than within a tolerance nobody would remember to apply.
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/** One audio stream, in the terms a disagreement about it would be reported in. */
function describeSound(stream: Record<string, unknown>): string {
  const codec = typeof stream["codec_name"] === "string" ? stream["codec_name"] : "sound";
  const rate = stream["sample_rate"];
  const channels = stream["channels"];
  const parts = [codec];
  if (typeof rate === "string" || typeof rate === "number") parts.push(`${String(rate)}Hz`);
  if (typeof channels === "number") parts.push(`${String(channels)}ch`);
  return parts.join(" ");
}

/** One part of a join, as the comparison talks about it: by the name she used. */
export interface JoinPart {
  readonly name: string;
  readonly shape: ClipShape;
}

/** One property the demuxer needs agreed, and how to say it out loud. */
interface Property {
  /** What it is called in the sentence. */
  readonly says: string;
  readonly of: (shape: ClipShape) => string;
  /** What she can do about it, when there is something. */
  readonly note?: string;
}

const PROPERTIES: readonly Property[] = [
  {
    says: "the same shape",
    of: (shape) => `${String(shape.width)}x${String(shape.height)}`,
    // The one she can act on, and the reason this is the likeliest mismatch of
    // the five. Measured 2026-08-11 and recorded on `Picture.ratio`.
    note:
      "The picture a clip opens on is its first frame and decides its aspect, overruling any " +
      "ratio I ask for — so renders opened on differently shaped stills come out differently " +
      "shaped.",
  },
  {
    says: "the same frame rate",
    of: (shape) => (shape.frameRate === null ? "unstated" : `${String(shape.frameRate)}fps`),
  },
  { says: "the same codec", of: (shape) => shape.codec },
  {
    says: "the same pixel format",
    of: (shape) => shape.pixelFormat ?? "unstated",
  },
  { says: "the same sound", of: (shape) => shape.audio ?? "silent" },
];

/**
 * Why these parts cannot be cut together, or `null` when they can.
 *
 * **Every disagreeing part, not the first.** Reporting one at a time would have
 * her fix that one, ask again, and be told about the next — one round trip per
 * defect, at three in the morning, each of them a turn.
 *
 * The first part is the baseline because it is the one that plays first: the
 * joined clip is the shape of its opening, so "the odd one out" is meaningful
 * only relative to something, and the thing it is relative to should be the
 * thing she would keep.
 */
export function whyTheyDoNotCutTogether(parts: readonly JoinPart[]): string | null {
  const first = parts[0];
  if (first === undefined || parts.length < 2) {
    // Not a compatibility answer. Reporting "they agree" about one part would
    // be a check claiming success over something it never compared.
    return `A join is two or more finished renders cut into one, and I was given ${String(parts.length)}.`;
  }

  const clauses: string[] = [];
  const notes: string[] = [];
  for (const property of PROPERTIES) {
    const ours = property.of(first.shape);
    const others = parts.slice(1).filter((part) => property.of(part.shape) !== ours);
    if (others.length === 0) continue;

    clauses.push(
      `they are not ${property.says} — ${first.name} is ${ours}, and ` +
        `${others.map((part) => `${part.name} is ${property.of(part.shape)}`).join(", ")}`,
    );
    if (property.note !== undefined) notes.push(property.note);
  }

  if (clauses.length === 0) return null;

  return (
    `I cannot cut these together: ${clauses.join("; ")}. ` +
    "A join copies the streams rather than re-encoding them, so parts that disagree come out as " +
    "a file that plays as rubbish or does not play at all — and I would be handing him that. " +
    `${notes.length === 0 ? "" : `${notes.join(" ")} `}` +
    "Nothing has been made and nothing has been spent. Join the ones that agree, or make the odd " +
    "one again to match."
  );
}
