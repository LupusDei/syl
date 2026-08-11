import { describe, expect, it } from "vitest";

import { measureSeconds, mux, planMux, type MediaRunner } from "../../src/voice/mux.js";

/**
 * Putting her speech onto the video she made.
 *
 * **No test here spawns ffmpeg.** The runner is injected for the same reason
 * `render/frames.ts` injects one: the interesting mistakes in this layer are
 * argv mistakes, and argv is only assertable if nothing actually runs.
 *
 * The decision under test is what happens when the speech and the video are
 * different lengths, which they always are. It is written down here rather than
 * left to `-shortest`, because the default `-shortest` behaviour cuts whichever
 * stream ends first — and half the time that is her sentence.
 */

function runner(
  outcomes: readonly { readonly ok: boolean; readonly stdout?: string; readonly message?: string }[],
): MediaRunner & { readonly calls: { file: string; args: readonly string[] }[] } {
  const calls: { file: string; args: readonly string[] }[] = [];
  let index = 0;
  const run = async (file: string, args: readonly string[]) => {
    calls.push({ file, args });
    const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? { ok: true };
    index += 1;
    return { ok: outcome.ok, stdout: outcome.stdout ?? "", message: outcome.message ?? "" };
  };
  return Object.assign(run, { calls });
}

describe("planMux", () => {
  it("should pad the audio with silence when the speech is shorter than the video", () => {
    const plan = planMux({ video: "/v/a.mp4", audio: "/v/a.mp3", out: "/v/b.mp4", videoSeconds: 15, speechSeconds: 6 });

    expect(plan.fit).toBe("padded");
    expect(plan.seconds).toBe(15);
    expect(plan.silenceSeconds).toBeCloseTo(9, 5);
    expect(plan.videoPasses).toBe(1);
    expect(plan.args).toContain("apad");
    expect(plan.args).not.toContain("-stream_loop");
  });

  it("should loop the video when the speech is longer, so no word is cut", () => {
    const plan = planMux({ video: "/v/a.mp4", audio: "/v/a.mp3", out: "/v/b.mp4", videoSeconds: 15, speechSeconds: 34 });

    expect(plan.fit).toBe("looped");
    expect(plan.seconds).toBe(34);
    expect(plan.silenceSeconds).toBe(0);
    expect(plan.videoPasses).toBe(3);
    // Before the input it applies to, or ffmpeg loops the wrong one.
    expect(plan.args.indexOf("-stream_loop")).toBeLessThan(plan.args.indexOf("/v/a.mp4"));
    expect(plan.args).not.toContain("apad");
  });

  it("should pad rather than loop when the two lengths agree within the tolerance", () => {
    const plan = planMux({ video: "/v/a.mp4", audio: "/v/a.mp3", out: "/v/b.mp4", videoSeconds: 15, speechSeconds: 15.1 });

    expect(plan.fit).toBe("padded");
    expect(plan.videoPasses).toBe(1);
  });

  it("should always end at the shorter stream and keep the original video stream untouched", () => {
    const plan = planMux({ video: "/v/a.mp4", audio: "/v/a.mp3", out: "/v/b.mp4", videoSeconds: 15, speechSeconds: 6 });

    expect(plan.args).toContain("-shortest");
    // Re-encoding the video would degrade the render to add an audio track.
    expect(plan.args.join(" ")).toContain("-c:v copy");
    expect(plan.args[plan.args.length - 1]).toBe("/v/b.mp4");
  });
});

describe("measureSeconds", () => {
  it("should read a duration out of ffprobe", async () => {
    const run = runner([{ ok: true, stdout: "6.086531\n" }]);

    await expect(measureSeconds("/v/a.mp3", run)).resolves.toEqual({ ok: true, seconds: 6.086531 });
    expect(run.calls[0]?.file).toBe("ffprobe");
    expect(run.calls[0]?.args).toContain("/v/a.mp3");
  });

  it("should refuse rather than guess when ffprobe fails", async () => {
    const run = runner([{ ok: false, message: "No such file" }]);

    const measured = await measureSeconds("/v/a.mp3", run);
    expect(measured.ok).toBe(false);
    if (!measured.ok) expect(measured.reason).toContain("No such file");
  });

  it("should refuse rather than guess when ffprobe answers with something that is not a number", async () => {
    const measured = await measureSeconds("/v/a.mp3", runner([{ ok: true, stdout: "N/A\n" }]));

    expect(measured.ok).toBe(false);
    if (!measured.ok) expect(measured.reason).toContain("N/A");
  });
});

describe("mux", () => {
  it("should measure both files, then run one ffmpeg, and report the plan it used", async () => {
    const run = runner([
      { ok: true, stdout: "15.0" },
      { ok: true, stdout: "6.0" },
      { ok: true },
    ]);

    const result = await mux({ video: "/v/a.mp4", audio: "/v/a.mp3", out: "/v/b.mp4", run });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.fit).toBe("padded");
      expect(result.plan.seconds).toBe(15);
    }
    expect(run.calls).toHaveLength(3);
    expect(run.calls[2]?.file).toBe("ffmpeg");
  });

  it("should not run ffmpeg at all when a length cannot be measured", async () => {
    const run = runner([{ ok: false, message: "broken" }]);

    const result = await mux({ video: "/v/a.mp4", audio: "/v/a.mp3", out: "/v/b.mp4", run });

    expect(result.ok).toBe(false);
    expect(run.calls.every((call) => call.file === "ffprobe")).toBe(true);
  });

  it("should report a failed mux as a sentence rather than throwing", async () => {
    const run = runner([
      { ok: true, stdout: "15.0" },
      { ok: true, stdout: "6.0" },
      { ok: false, message: "Invalid data found when processing input" },
    ]);

    const result = await mux({ video: "/v/a.mp4", audio: "/v/a.mp3", out: "/v/b.mp4", run });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Invalid data found");
  });
});
