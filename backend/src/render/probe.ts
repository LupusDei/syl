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
 *
 * **Nothing here is nullable except `audio`, and that is the point rather than
 * a convenience.** An unknown that reaches this type is an unknown that reaches
 * the comparison, where two of them meet, compare equal, and pass — a
 * compatibility check succeeding by agreeing about nothing. The unknown is
 * therefore made *unrepresentable*: {@link probeClip} refuses before building
 * one, so `whyTheyDoNotCutTogether` has no case to handle and no "unstated"
 * to render. That guarantee is the type's, which means the compiler keeps it
 * rather than a reviewer.
 */
export interface ClipShape {
  readonly width: number;
  readonly height: number;
  /** `h264`, `hevc`. Copied packets are meaningless to a decoder expecting another codec. */
  readonly codec: string;
  /** `yuv420p`, `yuv420p10le`. Two clips that differ here do not concatenate. */
  readonly pixelFormat: string;
  /** Frames per second, worked out from the file's own rational. */
  readonly frameRate: number;
  /**
   * The sound, described, or `null` for a clip that has **no audio stream**.
   *
   * The one nullable field, and its `null` is a REAL STATE rather than an
   * unknown standing in for one: this clip is silent, which is a fact about it
   * and a genuine disagreement with a part that is not. A stream that exists
   * and cannot be described in full is refused instead — "aac" standing in for
   * "aac, and we never learned its channel count" is the same defect one level
   * down.
   */
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

  // EVERY FIELD THE COMPARISON READS, OR NOTHING — and this rule reaches all
  // of them or it is not a rule.
  //
  // It was written for the dimensions ("two zeroes compare equal, so a
  // defaulted dimension is a check that passes by agreeing about nothing") and
  // then applied to three properties out of five. The other two were allowed
  // through as `null` and stringified to "unstated" for the comparison, which
  // reads as caution and is its opposite: two parts ffprobe was silent about
  // both rendered "unstated", compared EQUAL, and passed. That is the defect
  // the rule describes, wearing the rule's own clothes. **Absence of a
  // disagreement is not agreement.**
  //
  // It is not cosmetic. A frame-rate mismatch under `-c copy` is not a
  // worse-looking clip, it is broken timing in the one she sends him.
  //
  // The cost is real, and naming it is why this is a choice rather than an
  // oversight: an "ffprobe did not say" refusal is not actionable by her, and
  // {@link rateOf}'s own note argues the value of refusing is that the refusal
  // IS actionable. It wins anyway, because the alternative is not a join she
  // can fix — it is a broken minute reaching him with nothing having noticed.
  //
  // Gathered rather than returned one at a time, so one refusal names
  // everything it could not read. Same reason
  // {@link whyTheyDoNotCutTogether} reports every disagreeing part: one round
  // trip per defect is one turn per defect, at three in the morning.
  const unreadable: string[] = [];
  const stated = <T>(field: string, value: T | null): T => {
    if (value === null) unreadable.push(field);
    // Cast, because the null is reported above and the caller never sees this
    // object — the refusal below returns first.
    return value as T;
  };

  const sound = rows.find((stream) => stream["codec_type"] === "audio");
  const shape: ClipShape = {
    width: stated("width", numberOf(video["width"])),
    height: stated("height", numberOf(video["height"])),
    codec: stated("codec", textOf(video["codec_name"])),
    pixelFormat: stated("pixel format", textOf(video["pix_fmt"])),
    frameRate: stated("frame rate", rateOf(video["r_frame_rate"])),
    // `null` only for a clip with no audio stream at all, which is a state
    // rather than an unknown. A stream that IS there goes through `stated` for
    // each of the three things the description is made of.
    audio: sound === undefined ? null : describeSound(sound, stated),
  };

  if (unreadable.length > 0) {
    return {
      ok: false,
      reason:
        `I cannot tell what ${options.video} is — ffprobe did not say its ` +
        `${prose(unreadable)}. So I cannot tell whether it matches the other parts, and I am not ` +
        "going to assume it does.",
    };
  }

  return { ok: true, shape };
}

/** How a field is read: the value, or `null` recorded against its name. */
type Stated = <T>(field: string, value: T | null) => T;

/** A finite number, or `null` where ffprobe stated none. */
function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A non-empty string, or `null` where ffprobe stated none. */
function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** `a`, `a and b`, `a, b and c` — a list a person reads rather than parses. */
function prose(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
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

/**
 * One audio stream, in the terms a disagreement about it would be reported in.
 *
 * **Every part of the description is `stated`**, because this string IS the
 * comparison for sound and a default inside it hides an unknown exactly as
 * `"unstated"` did one level up. It used to fall back to the word `"sound"` for
 * a missing codec and to simply omit an unstated sample rate or channel count —
 * so two streams neither of which named its channels produced identical
 * descriptions, compared equal, and passed. `sample_rate` arrives as a string
 * from ffprobe and `channels` as a number, which is why they are read
 * separately rather than through one helper.
 */
function describeSound(stream: Record<string, unknown>, stated: Stated): string {
  const codec = stated("sound codec", textOf(stream["codec_name"]));
  const rate = stated("sound sample rate", textOf(String(stream["sample_rate"] ?? "")));
  const channels = stated("sound channel count", numberOf(stream["channels"]));
  return `${codec} ${rate}Hz ${String(channels)}ch`;
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
  // No "unstated" anywhere below, and that absence is load-bearing. A shape
  // that reaches here cannot hold an unknown in any of these — `probeClip`
  // refuses before building one — so there is no case where two silences meet
  // and agree. `silent` is not that case: it is a clip with no audio stream,
  // which is a real state and a real disagreement with one that has sound.
  { says: "the same frame rate", of: (shape) => `${String(shape.frameRate)}fps` },
  { says: "the same codec", of: (shape) => shape.codec },
  { says: "the same pixel format", of: (shape) => shape.pixelFormat },
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
