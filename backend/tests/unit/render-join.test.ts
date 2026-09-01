import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FrameRunner } from "../../src/render/frames.js";
import { joinVideos, lastFrame } from "../../src/render/join.js";

/**
 * Cutting two generations together on the frame they were both pinned to.
 *
 * **Nothing here runs ffmpeg.** The runner is injected for the same reason the
 * Runway client is: a unit test must not depend on a program being installed,
 * and the interesting mistakes in this layer are in the ARGV — a seek that
 * lands on the wrong frame, a concat that re-encodes, a list file the demuxer
 * refuses. Those are all readable from the arguments.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syl-join-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A runner that records its argv and writes whatever the last argument names. */
function runner(options: { readonly ok?: boolean; readonly writes?: boolean } = {}): FrameRunner & {
  readonly runs: (readonly string[])[];
} {
  const runs: (readonly string[])[] = [];
  const run: FrameRunner = async (_file, args) => {
    runs.push(args);
    if (options.writes !== false) writeFileSync(args[args.length - 1] ?? "", Buffer.alloc(8));
    return options.ok === false ? { ok: false, message: "exited 1" } : { ok: true, message: "" };
  };
  return Object.assign(run, { runs });
}

function video(name: string): string {
  const path = join(root, name);
  writeFileSync(path, Buffer.alloc(64));
  return path;
}

describe("the frame a half ends on", () => {
  it("should seek from the END of the file rather than to a duration it was told", async () => {
    // The duration Runway reports is the one it was ASKED for: a 4-second
    // request came back 4.041667s, measured 2026-08-11. Seeking to 4.0 would
    // land a frame or two short of the end, and seeking to 4.041667 would need
    // a number nothing on the request side knows. `-sseof` needs neither.
    const run = runner();
    const to = join(root, "half-1-last.png");

    const taken = await lastFrame({ video: video("half-1.mp4"), to, run });

    expect(taken.ok).toBe(true);
    const args = run.runs[0] ?? [];
    expect(args).toEqual(expect.arrayContaining(["-sseof", "-update", "1", "-frames:v", "1", to]));
    // Seeking BEFORE `-i`, which is input seeking; after it, ffmpeg decodes the
    // whole clip to get to the end.
    expect(args.indexOf("-sseof")).toBeLessThan(args.indexOf("-i"));
  });

  it("should say so rather than take a frame off a video that is not there", async () => {
    const taken = await lastFrame({ video: join(root, "absent.mp4"), to: join(root, "x.png"), run: runner() });

    expect(taken.ok).toBe(false);
    if (taken.ok) return;
    expect(taken.reason).toContain("absent.mp4");
  });

  it("should refuse to report success when ffmpeg wrote nothing", async () => {
    // The failure mode that would otherwise reach Runway as an empty picture:
    // ffmpeg exiting zero and producing no file. The next generation would be
    // asked to start from something that does not exist, at full price.
    const taken = await lastFrame({
      video: video("half-1.mp4"),
      to: join(root, "half-1-last.png"),
      run: runner({ writes: false }),
    });

    expect(taken.ok).toBe(false);
    if (taken.ok) return;
    expect(taken.reason).toMatch(/wrote no closing frame/iu);
  });

  it("should carry ffmpeg's own words when it fails, not a code", async () => {
    const taken = await lastFrame({
      video: video("half-1.mp4"),
      to: join(root, "half-1-last.png"),
      run: runner({ ok: false }),
    });

    expect(taken.ok).toBe(false);
    if (taken.ok) return;
    expect(taken.reason).toContain("exited 1");
  });
});

describe("joining the halves", () => {
  it("should copy the streams rather than re-encode her twice", async () => {
    // Both halves come from one model at one ratio, so their streams are
    // already compatible. Re-encoding would cost a generation of quality on a
    // clip that is fifteen seconds of her face, and buy nothing.
    const run = runner();
    const to = join(root, "joined.mp4");
    const listFile = join(root, "parts", "joined.txt");

    const joined = await joinVideos({ parts: [video("a.mp4"), video("b.mp4")], to, listFile, run });

    expect(joined.ok).toBe(true);
    const args = run.runs[0] ?? [];
    expect(args).toEqual(expect.arrayContaining(["-f", "concat", "-c", "copy", "-i", listFile, to]));
    // `-safe 0`, because the list holds absolute paths and her home is where
    // they are. Without it the demuxer refuses every line.
    expect(args).toEqual(expect.arrayContaining(["-safe", "0"]));
  });

  it("should write a list the demuxer can read, in the order the halves play", async () => {
    const to = join(root, "joined.mp4");
    const listFile = join(root, "parts", "joined.txt");
    const first = video("a.mp4");
    const second = video("b.mp4");

    await joinVideos({ parts: [first, second], to, listFile, run: runner() });

    const list = readFileSync(listFile, "utf8");
    expect(list).toBe(`file '${first}'\nfile '${second}'\n`);
    // Kept, like everything else about a render: it is the record of how the
    // cut was made.
    expect(existsSync(listFile)).toBe(true);
  });

  it("should say which half is missing rather than join what it has", async () => {
    // Half a render joined into a whole one is a clip that opens on the ribbon
    // and stops on her face — which is precisely the defect this shape exists
    // to remove, arriving as a silent success.
    const missing = join(root, "b.mp4");

    const joined = await joinVideos({
      parts: [video("a.mp4"), missing],
      to: join(root, "joined.mp4"),
      listFile: join(root, "parts", "joined.txt"),
      run: runner(),
    });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.reason).toContain(missing);
  });

  it("should refuse a join of fewer than two halves", async () => {
    const joined = await joinVideos({
      parts: [video("a.mp4")],
      to: join(root, "joined.mp4"),
      listFile: join(root, "parts", "joined.txt"),
      run: runner(),
    });

    expect(joined.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // FOUR PARTS, NOT TWO HALVES — `syl-5y4n`.
  //
  // This function has always taken an array and its only arity limit is two.
  // Its SENTENCES did not: they said "half", because the one caller joined the
  // two halves of one anchored render. Join four finished renders and it
  // reported about halves — and these are the sentences she reads when
  // something has failed at three in the morning.
  // -------------------------------------------------------------------------

  it("should join four parts, in the order they were given", async () => {
    const parts = [video("a.mp4"), video("b.mp4"), video("c.mp4"), video("d.mp4")];
    const listFile = join(root, "parts", "joined.txt");

    const joined = await joinVideos({
      parts,
      to: join(root, "joined.mp4"),
      listFile,
      run: runner(),
    });

    expect(joined.ok).toBe(true);
    expect(readFileSync(listFile, "utf8")).toBe(`${parts.map((p) => `file '${p}'`).join("\n")}\n`);
  });

  it("should report a missing part as a PART, and say which position it is in", async () => {
    const missing = join(root, "c.mp4");

    const joined = await joinVideos({
      parts: [video("a.mp4"), video("b.mp4"), missing, video("d.mp4")],
      to: join(root, "joined.mp4"),
      listFile: join(root, "parts", "joined.txt"),
      run: runner(),
    });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    // The path, so she can go and look — and its POSITION, because with four
    // parts "which one" is a question a path alone answers slowly.
    expect(joined.reason).toContain(missing);
    expect(joined.reason).toContain("3");
    // And never "half". A four-part join reporting about halves is the
    // two-part assumption leaking into the one sentence that has to be true.
    expect(joined.reason).not.toMatch(/half/iu);
  });

  it("should refuse fewer than two parts in words that are not about halves", async () => {
    const joined = await joinVideos({
      parts: [video("a.mp4")],
      to: join(root, "joined.mp4"),
      listFile: join(root, "parts", "joined.txt"),
      run: runner(),
    });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.reason).not.toMatch(/half/iu);
    expect(joined.reason).toMatch(/two/iu);
  });

  it("should say a join failed without claiming it was a join of two", async () => {
    const joined = await joinVideos({
      parts: [video("a.mp4"), video("b.mp4"), video("c.mp4")],
      to: join(root, "joined.mp4"),
      listFile: join(root, "parts", "joined.txt"),
      run: runner({ ok: false }),
    });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.reason).toContain("exited 1");
    expect(joined.reason).not.toMatch(/half/iu);
  });

  it("should refuse to report success when ffmpeg wrote no joined clip", async () => {
    mkdirSync(join(root, "parts"), { recursive: true });
    const joined = await joinVideos({
      parts: [video("a.mp4"), video("b.mp4")],
      to: join(root, "joined.mp4"),
      listFile: join(root, "parts", "joined.txt"),
      run: runner({ writes: false }),
    });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.reason).toMatch(/wrote no joined render/iu);
  });
});
