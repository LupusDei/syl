import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  probeClip,
  whyTheyDoNotCutTogether,
  type ClipShape,
  type ProbeRunner,
} from "../../src/render/probe.js";

/**
 * What a finished clip actually IS, read off the file rather than off a record.
 *
 * **Nothing here runs ffprobe.** The runner is injected for the same reason the
 * ffmpeg one is: a unit test must not depend on a program being installed, and
 * the interesting mistakes in this layer are the argv and the parse.
 *
 * The behaviour that matters is the REFUSAL. `joinVideos` concatenates with
 * `-c copy`, which is safe only while the parts already agree — true inside one
 * render, and not true across separately made ones. With mismatched streams the
 * demuxer does not error; it writes a file that plays as garbage. She would send
 * that to him. So a join that refuses, naming which parts disagree and how, is
 * the whole point of this module.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syl-probe-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function video(name: string): string {
  const path = join(root, name);
  writeFileSync(path, Buffer.alloc(64));
  return path;
}

/** A runner that records its argv and answers with whatever it is given. */
function runner(answer: string | { readonly fails: string }): ProbeRunner & {
  readonly runs: (readonly string[])[];
} {
  const runs: (readonly string[])[] = [];
  const run: ProbeRunner = async (_file, args) => {
    runs.push(args);
    return typeof answer === "string"
      ? { ok: true, stdout: answer }
      : { ok: false, message: answer.fails };
  };
  return Object.assign(run, { runs });
}

/** ffprobe's own JSON, in the shape it actually emits. */
function streams(...entries: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ streams: entries });
}

function videoStream(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 0,
    codec_name: "h264",
    codec_type: "video",
    width: 834,
    height: 1112,
    pix_fmt: "yuv420p",
    r_frame_rate: "30/1",
    ...overrides,
  };
}

/** A shape, so the comparison tests do not have to go through a probe to get one. */
function shape(overrides: Partial<ClipShape> = {}): ClipShape {
  return {
    width: 834,
    height: 1112,
    codec: "h264",
    pixelFormat: "yuv420p",
    frameRate: 30,
    audio: null,
    ...overrides,
  };
}

describe("reading a clip's own shape", () => {
  it("should ask ffprobe for its streams as JSON rather than parsing its prose", async () => {
    const run = runner(streams(videoStream()));
    const file = video("a.mp4");

    const probed = await probeClip({ video: file, run });

    expect(probed.ok).toBe(true);
    const args = run.runs[0] ?? [];
    // JSON, not the default human-readable output: a format meant for a person
    // is a format that changes wording between versions.
    expect(args).toEqual(expect.arrayContaining(["-print_format", "json", "-show_streams", file]));
  });

  it("should read the shape, the codec, the pixel format and the frame rate off the video stream", async () => {
    const probed = await probeClip({ video: video("a.mp4"), run: runner(streams(videoStream())) });

    expect(probed.ok).toBe(true);
    if (!probed.ok) return;
    expect(probed.shape).toEqual(shape());
  });

  it("should work the frame rate out of the rational the file declares", async () => {
    // 30000/1001 is 29.97, and a file that says one and a file that says the
    // other are the same clip. Comparing the strings would refuse a join over
    // two spellings of one number.
    const probed = await probeClip({
      video: video("a.mp4"),
      run: runner(streams(videoStream({ r_frame_rate: "30000/1001" }))),
    });

    expect(probed.ok).toBe(true);
    if (!probed.ok) return;
    expect(probed.shape.frameRate).toBeCloseTo(29.97, 2);
  });

  it("should describe the sound when there is some, and say silent when there is none", async () => {
    const silent = await probeClip({ video: video("a.mp4"), run: runner(streams(videoStream())) });
    const heard = await probeClip({
      video: video("b.mp4"),
      run: runner(
        streams(videoStream(), {
          codec_type: "audio",
          codec_name: "aac",
          sample_rate: "44100",
          channels: 2,
        }),
      ),
    });

    expect(silent.ok && silent.shape.audio).toBe(null);
    expect(heard.ok && heard.shape.audio).toContain("aac");
  });

  it("should say so rather than guess when the file has no video stream in it", async () => {
    const probed = await probeClip({
      video: video("a.mp4"),
      run: runner(streams({ codec_type: "audio", codec_name: "aac" })),
    });

    expect(probed.ok).toBe(false);
    if (probed.ok) return;
    expect(probed.reason).toMatch(/no video/iu);
  });

  it("should refuse a file it cannot find rather than reporting on nothing", async () => {
    const probed = await probeClip({ video: join(root, "absent.mp4"), run: runner(streams()) });

    expect(probed.ok).toBe(false);
    if (probed.ok) return;
    expect(probed.reason).toContain("absent.mp4");
  });

  it("should carry ffprobe's own words when it fails, not a code", async () => {
    const probed = await probeClip({
      video: video("a.mp4"),
      run: runner({ fails: "ffprobe: command not found" }),
    });

    expect(probed.ok).toBe(false);
    if (probed.ok) return;
    expect(probed.reason).toContain("command not found");
  });

  it("should refuse an answer it cannot parse instead of reading a shape out of nothing", async () => {
    const probed = await probeClip({ video: video("a.mp4"), run: runner("not json at all") });

    expect(probed.ok).toBe(false);
    if (probed.ok) return;
    expect(probed.reason).toMatch(/could not read|not.*json/iu);
  });

  // -------------------------------------------------------------------------
  // THE RULE, APPLIED TO EVERY FIELD THE COMPARISON READS.
  //
  // It was applied to three of them and not the other two, which is the defect
  // the rule describes wearing the rule's own clothes: two parts whose frame
  // rate ffprobe did not state both rendered as "unstated", compared equal, and
  // passed. A frame-rate mismatch under `-c copy` is broken timing in the clip
  // she sends him, so that is not a cosmetic hole.
  //
  // Table-driven on purpose. A sixth property added next month is covered
  // without anyone remembering this file exists — which is the same reason
  // `tool-server.test.ts` guards `because` by shape rather than by a list.
  // -------------------------------------------------------------------------
  const unstated: readonly { readonly field: string; readonly answer: string }[] = [
    { field: "width", answer: streams(videoStream({ width: undefined })) },
    { field: "height", answer: streams(videoStream({ height: undefined })) },
    { field: "codec", answer: streams(videoStream({ codec_name: undefined })) },
    { field: "pixel format", answer: streams(videoStream({ pix_fmt: undefined })) },
    { field: "frame rate", answer: streams(videoStream({ r_frame_rate: undefined })) },
    // `0/0` is a real thing ffprobe emits, and it is ffprobe saying it does not
    // know rather than saying zero.
    { field: "frame rate", answer: streams(videoStream({ r_frame_rate: "0/0" })) },
    {
      field: "sound",
      answer: streams(videoStream(), { codec_type: "audio", sample_rate: "44100", channels: 2 }),
    },
    {
      field: "sound",
      answer: streams(videoStream(), { codec_type: "audio", codec_name: "aac", channels: 2 }),
    },
    {
      field: "sound",
      answer: streams(videoStream(), { codec_type: "audio", codec_name: "aac", sample_rate: "44100" }),
    },
  ];

  for (const { field, answer } of unstated) {
    it(`should refuse a clip whose ${field} ffprobe did not state, and say which`, async () => {
      const probed = await probeClip({ video: video("a.mp4"), run: runner(answer) });

      expect(probed.ok, `an unstated ${field} was accepted`).toBe(false);
      if (probed.ok) return;
      // Named, because "I cannot read this file" is not something she can act
      // on and "it does not say its frame rate" is.
      expect(probed.reason.toLowerCase()).toContain(field);
    });
  }

  // A test asserting that `ClipShape` forbids an unknown was written here and
  // DELETED. It read `typeof shape().frameRate === "number"` against this
  // file's own fixture, so it was green before the fix, green after it, and
  // green against any implementation whatsoever — a test about the guarantee
  // that could not see the guarantee. The unknown is unrepresentable because
  // the TYPE says so (`pixelFormat: string`, `frameRate: number`), and `tsc`
  // is what enforces that; there is no runtime observation to make. The
  // enforceable half is the table above, and it is above.

  it("should name EVERY field it could not read, in one refusal", async () => {
    // One round trip per unreadable field is one turn per unreadable field.
    // This is the case the old dimension-only test used to cover; it asserted
    // the refusal's WORDING (/how big|dimension|size/) rather than which field
    // was named, so it went red when the five guards were unified into one
    // sentence even though the behaviour it cared about had strengthened. The
    // table above now covers width and height individually and by name, which
    // is the durable form of that assertion.
    const probed = await probeClip({
      video: video("a.mp4"),
      run: runner(streams(videoStream({ width: undefined, height: undefined, pix_fmt: undefined }))),
    });

    expect(probed.ok).toBe(false);
    if (probed.ok) return;
    expect(probed.reason).toContain("width");
    expect(probed.reason).toContain("height");
    expect(probed.reason).toContain("pixel format");
  });
});

describe("whether finished renders cut together", () => {
  it("should say nothing at all when every part agrees", () => {
    expect(
      whyTheyDoNotCutTogether([
        { name: "syl-a", shape: shape() },
        { name: "syl-b", shape: shape() },
        { name: "syl-c", shape: shape() },
      ]),
    ).toBe(null);
  });

  it("should name which parts are different shapes, and what each of them is", () => {
    const why = whyTheyDoNotCutTogether([
      { name: "syl-a", shape: shape() },
      { name: "syl-c", shape: shape({ width: 1112, height: 834 }) },
    ]);

    expect(why).not.toBe(null);
    expect(why ?? "").toContain("syl-a");
    expect(why ?? "").toContain("syl-c");
    expect(why ?? "").toContain("834x1112");
    expect(why ?? "").toContain("1112x834");
  });

  it("should name the trap that causes it: the opening picture decides the aspect", () => {
    // Measured 2026-08-11 and documented on `Picture.ratio`: `promptImage` is
    // frame one and the model takes the video's aspect from it, silently
    // overruling `ratio`. So clips opened on differently shaped stills come out
    // different shapes, and that is the one thing she can act on.
    const why =
      whyTheyDoNotCutTogether([
        { name: "syl-a", shape: shape() },
        { name: "syl-c", shape: shape({ width: 1112, height: 834 }) },
      ]) ?? "";

    expect(why).toMatch(/open/iu);
  });

  it("should name a frame-rate disagreement with both rates in it", () => {
    const why =
      whyTheyDoNotCutTogether([
        { name: "syl-a", shape: shape() },
        { name: "syl-b", shape: shape({ frameRate: 24 }) },
      ]) ?? "";

    expect(why).toContain("syl-b");
    expect(why).toMatch(/24/u);
    expect(why).toMatch(/30/u);
  });

  it("should name a codec disagreement", () => {
    const why =
      whyTheyDoNotCutTogether([
        { name: "syl-a", shape: shape() },
        { name: "syl-b", shape: shape({ codec: "hevc" }) },
      ]) ?? "";

    expect(why).toContain("hevc");
    expect(why).toContain("h264");
  });

  it("should name a pixel-format disagreement", () => {
    const why =
      whyTheyDoNotCutTogether([
        { name: "syl-a", shape: shape() },
        { name: "syl-b", shape: shape({ pixelFormat: "yuv420p10le" }) },
      ]) ?? "";

    expect(why).toContain("yuv420p10le");
  });

  it("should notice that one part has sound and another does not", () => {
    // The disagreement that is invisible in a still and fatal to the demuxer: a
    // stream present in one part and absent in the next.
    const why =
      whyTheyDoNotCutTogether([
        { name: "syl-a", shape: shape() },
        { name: "syl-b", shape: shape({ audio: "aac 44100Hz 2ch" }) },
      ]) ?? "";

    expect(why).toContain("syl-b");
    expect(why).toMatch(/sound|silent|audio/iu);
  });

  it("should report EVERY part that disagrees, not only the first one it meets", () => {
    // She would otherwise fix the one it named, ask again, and be told about
    // the next — one round trip per defect, at three in the morning.
    const why =
      whyTheyDoNotCutTogether([
        { name: "syl-a", shape: shape() },
        { name: "syl-b", shape: shape({ width: 1112, height: 834 }) },
        { name: "syl-c", shape: shape({ width: 640, height: 480 }) },
      ]) ?? "";

    expect(why).toContain("syl-b");
    expect(why).toContain("syl-c");
  });

  it("should say that nothing was made and nothing was spent", () => {
    // The refusal is the sentence she reads at three in the morning. What she
    // needs from it is what happened to the credits — a refusal that leaves her
    // wondering whether she has just paid for a broken file is a refusal that
    // costs a turn to resolve.
    const why =
      whyTheyDoNotCutTogether([
        { name: "syl-a", shape: shape() },
        { name: "syl-b", shape: shape({ frameRate: 24 }) },
      ]) ?? "";

    expect(why).toMatch(/spent|cost/iu);
  });

  it("should refuse to answer about fewer than two parts", () => {
    // Not a compatibility question. `joinVideos` refuses the arity itself, and
    // a comparison that returned "they agree" about one part would be a check
    // reporting success over something it never looked at.
    expect(whyTheyDoNotCutTogether([{ name: "syl-a", shape: shape() }])).not.toBe(null);
    expect(whyTheyDoNotCutTogether([])).not.toBe(null);
  });
});
