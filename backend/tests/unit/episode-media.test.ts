import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assemble,
  assemblyArgs,
  parseIntegratedLoudness,
  parseWhisper,
  transcribe,
  type MediaRunner,
  type MediaTools,
} from "../../src/episodes/media.js";

/**
 * ffmpeg and whisper for episodes (`syl-8tts`). No binary runs here: the runner
 * is injected, and the parsers are pinned against output captured from the real
 * binaries on this machine (ffmpeg 8.0.1, whisper-cli with ggml-base.en), never
 * against output written by hand.
 */

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

function tools(run: MediaRunner): MediaTools {
  return { ffmpeg: "ffmpeg", ffprobe: "ffprobe", whisper: "whisper-cli", whisperModel: "/m/ggml.bin", run };
}

describe("parseWhisper", () => {
  it("should read a real transcript as one line, timestamps gone", () => {
    const stdout = readFileSync(join(FIXTURES, "whisper-cli-scene.txt"), "utf8");
    expect(parseWhisper(stdout)).toBe(
      "Mars is the red planet, covered in rusty red dust. And Jupiter is the biggest of all. " +
        "With a storm so huge, it could swallow our whole Earth.",
    );
  });

  it("should read silence as nothing rather than as a line", () => {
    expect(parseWhisper("\n\n")).toBe("");
  });
});

describe("parseIntegratedLoudness", () => {
  it("should read the summary's integrated loudness from real ffmpeg output", () => {
    const stderr = readFileSync(join(FIXTURES, "ffmpeg-ebur128-summary.txt"), "utf8");
    expect(parseIntegratedLoudness(stderr)).toBe(-15.9);
  });

  it("should not take a running value from a progress line for the file's loudness", () => {
    const progressOnly = readFileSync(join(FIXTURES, "ffmpeg-ebur128-summary.txt"), "utf8").split("Summary:")[0] ?? "";
    expect(progressOnly).toContain("I: -16.0 LUFS");
    expect(parseIntegratedLoudness(progressOnly)).toBeNull();
  });
});

describe("transcribe", () => {
  it("should only ever ask whisper for the timestamped form, which never drops a segment", async () => {
    const calls: string[][] = [];
    const heard = await transcribe(
      tools(async (file, args) => {
        calls.push([file, ...args]);
        return { ok: true, stdout: file === "whisper-cli" ? "[00:00:00.000 --> 00:00:02.000]   Hello!" : "", stderr: "", message: "" };
      }),
      "/in/take.mp4",
      "/work",
      "01.take1",
    );

    expect(heard).toEqual({ ok: true, value: "Hello!" });
    const whisper = calls.find((call) => call[0] === "whisper-cli") ?? [];
    expect(whisper).not.toContain("-nt");
    expect(whisper).toEqual(["whisper-cli", "-m", "/m/ggml.bin", "-f", "/work/01.take1.16k.wav", "-np"]);
  });

  it("should answer with a sentence rather than throwing when whisper is missing", async () => {
    const heard = await transcribe(
      tools(async (file) =>
        file === "whisper-cli"
          ? { ok: false, stdout: "", stderr: "", message: "spawn whisper-cli ENOENT" }
          : { ok: true, stdout: "", stderr: "", message: "" },
      ),
      "/in/take.mp4",
      "/work",
      "01.take1",
    );
    expect(heard.ok).toBe(false);
    if (!heard.ok) expect(heard.reason).toContain("whisper could not transcribe 01.take1");
  });
});

describe("assemblyArgs", () => {
  const args = assemblyArgs(["/a.mp4", "/b.mp4"], [15, 15.2], "/bed.mp3", "/out.mp4");
  const graph = args[args.indexOf("-filter_complex") + 1] ?? "";

  it("should keep each scene's own audio, because her voice was made with the picture", () => {
    expect(graph).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][dlg]");
  });

  it("should loop one bed under the whole episode and duck it under her voice", () => {
    expect(args.slice(args.indexOf("-stream_loop"), args.indexOf("-stream_loop") + 4)).toEqual([
      "-stream_loop", "-1", "-i", "/bed.mp3",
    ]);
    expect(graph).toContain("atrim=0:30.200");
    // The KEY is her dialogue: the compressor listens to her voice and turns the bed down under it.
    expect(graph).toContain("[dlg]asplit=2[dlg1][key]");
    expect(graph).toContain("[bed][key]sidechaincompress");
  });

  it("should normalise the mix to the loudness a phone plays at", () => {
    expect(graph).toContain("loudnorm=I=-16:");
    expect(args.at(-1)).toBe("/out.mp4");
  });

  it("should refuse to guess when a clip has no measured length", () => {
    expect(() => assemblyArgs(["/a.mp4"], [], "/bed.mp3", "/out.mp4")).toThrow(RangeError);
  });
});

describe("assemble", () => {
  it("should measure every clip before assembling, and stop on one it cannot read", async () => {
    const result = await assemble(
      tools(async (file) =>
        file === "ffprobe"
          ? { ok: false, stdout: "", stderr: "", message: "moov atom not found" }
          : { ok: true, stdout: "", stderr: "", message: "" },
      ),
      ["/a.mp4"],
      "/bed.mp3",
      "/out.mp4",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("could not read how long");
  });
});
