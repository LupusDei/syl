import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FrameRunner } from "../../src/render/frames.js";
import type { ProbeRunner } from "../../src/render/probe.js";
import { RenderService } from "../../src/render/render-service.js";
import type { RenderBackend } from "../../src/render/runway.js";
import { studioAt } from "../../src/render/studio.js";
import { fixedClock } from "../../src/services/clock.js";

/**
 * Joining finished renders into the one clip she can send — `syl-5y4n`.
 *
 * She can chain segments that cut together seamlessly and had no way to
 * concatenate them: `show_him` takes ONE render name, so four fifteen-second
 * clips stayed four clips. The join itself needed nothing — `joinVideos` has
 * always taken an array — so the whole of the work is two things, and this file
 * is about both.
 *
 * **It mints a render.** That is what keeps the change small: the record's mp4
 * is already "the joined clip, if it was joined", so a join that writes a
 * record is something `see_myself` and `show_him` already understand, and
 * neither of them changes.
 *
 * **It refuses parts that do not agree.** `joinVideos` copies the streams
 * rather than re-encoding, which is safe inside one render and is exactly what
 * breaks across separately made ones — and the demuxer does not error, it
 * writes a file that plays as garbage. She would send him that.
 *
 * **Nothing here spends a credit, and mostly it cannot**: the backend is `null`
 * on every test but one, so there is no path to Runway at all. A join is local
 * ffmpeg over files already on disk.
 */

const NOW = Date.UTC(2026, 8, 1, 15, 30, 0, 0);

let root: string;
let studio: ReturnType<typeof studioAt>;
/** What each clip probes as, by absolute path. */
let shapes: Map<string, Record<string, unknown>>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syl-join-renders-"));
  studio = studioAt(root);
  shapes = new Map();
  mkdirSync(dirname(studio.reference()), { recursive: true });
  writeFileSync(studio.reference(), Buffer.alloc(8));
  writeFileSync(studio.opening(), Buffer.alloc(8));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An ffmpeg double that writes whatever the last argument names. */
function ffmpeg(options: { readonly ok?: boolean } = {}): FrameRunner & {
  readonly runs: (readonly string[])[];
} {
  const runs: (readonly string[])[] = [];
  const run: FrameRunner = async (_file, args) => {
    runs.push(args);
    if (options.ok === false) return { ok: false, message: "exited 1" };
    mkdirSync(dirname(args[args.length - 1] ?? root), { recursive: true });
    writeFileSync(args[args.length - 1] ?? "", Buffer.alloc(16));
    return { ok: true, message: "" };
  };
  return Object.assign(run, { runs });
}

/** An ffprobe double answering from {@link shapes}, keyed by the file it is asked about. */
const ffprobe: ProbeRunner = async (_file, args) => {
  const path = args[args.length - 1] ?? "";
  const stream = shapes.get(path) ?? {
    codec_name: "h264",
    codec_type: "video",
    width: 834,
    height: 1112,
    pix_fmt: "yuv420p",
    r_frame_rate: "30/1",
  };
  return { ok: true, stdout: JSON.stringify({ streams: [stream] }) };
};

interface Finished {
  readonly framing?: string;
  readonly anchor?: string | null;
  readonly model?: string;
  readonly duration?: number;
  readonly status?: string;
  readonly credits?: number | null;
  readonly onDisk?: boolean;
  /** What this clip probes as, for the compatibility check. */
  readonly shape?: Record<string, unknown>;
}

/** A finished render on disk: the mp4 and the sidecar that makes it a record. */
function finished(name: string, options: Finished = {}): string {
  const video = studio.video(name);
  mkdirSync(studio.videoDir, { recursive: true });
  if (options.onDisk !== false) writeFileSync(video, Buffer.alloc(64));
  if (options.shape !== undefined) shapes.set(video, options.shape);

  const status = options.status ?? "ready";
  const duration = options.duration ?? 15;
  writeFileSync(
    studio.sidecar(name),
    `${JSON.stringify(
      {
        name,
        status,
        renderedAt: "2026-08-30T00:00:00.000Z",
        taskId: `task-${name}`,
        model: options.model ?? "seedance2",
        ratio: "834:1112",
        resolution: null,
        keyframes: 2,
        duration,
        reference: "renders/opening-ribbon.png",
        anchor: options.anchor === undefined ? "renders/reference.png" : options.anchor,
        framing: options.framing ?? "close_portrait",
        prompt: `a prompt for ${name}`,
        scene: `a scene for ${name}`,
        because: "I wanted to see",
        startedAt: "2026-08-30T00:00:00.000Z",
        reason: null,
        credits: options.credits === undefined ? 450 : options.credits,
        usd: 4.5,
        estimated: 450,
        video: status === "ready" ? video : null,
        parts: [
          {
            taskId: `task-${name}`,
            prompt: `a prompt for ${name}`,
            duration,
            first: "renders/opening-ribbon.png",
            last: "renders/reference.png",
            video: status === "ready" ? video : null,
            credits: 450,
            charged: options.credits === undefined ? 450 : options.credits,
            status: status === "ready" ? "ready" : "failed",
            failureCode: null,
            failure: null,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return name;
}

function serviceWith(
  options: { readonly ffmpeg?: FrameRunner; readonly backend?: RenderBackend | null } = {},
): RenderService {
  return new RenderService({
    studio,
    backend: options.backend ?? null,
    clock: fixedClock(NOW),
    ffmpeg: options.ffmpeg ?? ffmpeg(),
    ffprobe,
    sleep: async () => undefined,
  });
}

describe("joining finished renders", () => {
  it("should mint a render of its own, on disk, that she can look at and send", async () => {
    const service = serviceWith();
    const names = [finished("syl-one"), finished("syl-two"), finished("syl-three")];

    const joined = await service.join({ renders: names, because: "he asked for the whole minute" });

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    // A render like any other: ready, with a video, so `show_him` takes it with
    // no change and `see_myself` pulls stills out of it.
    expect(joined.record.status).toBe("ready");
    expect(joined.record.video).toBe(studio.video(joined.record.name));
    expect(existsSync(joined.record.video ?? "")).toBe(true);
    expect(service.get(joined.record.name)?.name).toBe(joined.record.name);
    expect(service.latest()?.name).toBe(joined.record.name);
  });

  it("should carry which renders it was cut from, in the order they play", async () => {
    const service = serviceWith();
    const names = [finished("syl-one"), finished("syl-two"), finished("syl-three")];

    const joined = await service.join({ renders: names, because: "the whole minute" });

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.record.joinedFrom).toEqual(names);
    // And it survives a reload, or the provenance is a thing the service knew
    // for one call and the file cannot say.
    expect(service.get(joined.record.name)?.joinedFrom).toEqual(names);
  });

  it("should say in its own name that it is a join", async () => {
    const service = serviceWith();
    const joined = await service.join({
      renders: [finished("syl-one"), finished("syl-two")],
      because: "b",
    });

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.record.name).toMatch(/joined/u);
  });

  it("should add the parts' seconds up, and keep the concat list beside them", async () => {
    const service = serviceWith();
    const joined = await service.join({
      renders: [finished("syl-one", { duration: 15 }), finished("syl-two", { duration: 8 })],
      because: "b",
    });

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.record.duration).toBe(23);
    // Kept, like every other part of a render: it is the record of how the cut
    // was made, and the only way to re-cut it without paying again.
    const list = readFileSync(studio.partList(joined.record.name), "utf8");
    expect(list).toBe(`file '${studio.video("syl-one")}'\nfile '${studio.video("syl-two")}'\n`);
  });

  it("should take the shape from the FILES rather than from what the records asked for", async () => {
    // `ratio` on a record is what was requested; the probe is what came back,
    // and the two differ exactly where this matters — the opening picture
    // decides the aspect and overrules the ask.
    const service = serviceWith();
    const joined = await service.join({
      renders: [
        finished("syl-one", { shape: { ...base(), width: 640, height: 480 } }),
        finished("syl-two", { shape: { ...base(), width: 640, height: 480 } }),
      ],
      because: "b",
    });

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.record.ratio).toBe("640:480");
  });
});

describe("what a join costs", () => {
  it("should spend nothing, and be unable to reach Runway at all", async () => {
    const calls: string[] = [];
    const backend: RenderBackend = {
      submit: async () => {
        calls.push("submit");
        return { ok: true, data: { id: "task-x" } };
      },
      task: async () => {
        calls.push("task");
        return { ok: false, failure: { message: "no", retryable: false } };
      },
      download: async () => {
        calls.push("download");
        return { ok: false, failure: { message: "no", retryable: false } };
      },
    };
    const service = serviceWith({ backend });

    const joined = await service.join({
      renders: [finished("syl-one"), finished("syl-two")],
      because: "b",
    });
    await service.drain();

    expect(joined.ok).toBe(true);
    expect(calls).toEqual([]);
    if (!joined.ok) return;
    // Zero, not `null`. `null` means "nobody told us what this cost", which is
    // the honest answer for a render in flight and a lie about a join: nothing
    // was submitted, so nothing was charged, and that is an observation.
    expect(joined.record.credits).toBe(0);
    expect(joined.record.usd).toBe(0);
  });

  it("should not bill him twice for the same seconds", async () => {
    // The ledger's `seconds` is what the money BOUGHT. Every second in a join
    // was bought under the renders it was cut from, so counting them again
    // would report double the footage he has paid for.
    const service = serviceWith();
    finished("syl-one", { duration: 15 });
    finished("syl-two", { duration: 15 });
    const before = service.spend();

    const joined = await service.join({ renders: ["syl-one", "syl-two"], because: "b" });
    const after = service.spend();

    expect(joined.ok).toBe(true);
    expect(before.seconds).toBe(30);
    expect(after.seconds).toBe(30);
    expect(after.credits).toBe(before.credits);
    // It is still a render she has, and it is finished.
    expect(after.renders).toBe(before.renders + 1);
    expect(after.ready).toBe(before.ready + 1);
    // And it is not "unpriced" — that word means nobody reported a charge, and
    // here nobody was ever going to.
    expect(after.unpriced).toBe(before.unpriced);
  });
});

describe("what a join refuses, and what it says", () => {
  it("should refuse fewer than two renders without talking about halves", async () => {
    const service = serviceWith();
    const joined = await service.join({ renders: [finished("syl-one")], because: "b" });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.reason).not.toMatch(/half/iu);
    expect(joined.reason).toMatch(/two/iu);
    expect(joined.retryable).toBe(true);
  });

  it("should refuse a render it has never heard of, by name", async () => {
    const service = serviceWith();
    const joined = await service.join({
      renders: [finished("syl-one"), "syl-nothing-like-this"],
      because: "b",
    });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.reason).toContain("syl-nothing-like-this");
  });

  it("should refuse `latest`, because a join keeps the names it was made with forever", async () => {
    const service = serviceWith();
    const joined = await service.join({
      renders: [finished("syl-one"), "latest"],
      because: "b",
    });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.reason).toMatch(/latest/u);
  });

  it("should refuse a render that never finished, and say which and why", async () => {
    const service = serviceWith();
    const joined = await service.join({
      renders: [finished("syl-one"), finished("syl-broken", { status: "failed" })],
      because: "b",
    });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.reason).toContain("syl-broken");
    expect(joined.reason).toMatch(/did not finish|still rendering/iu);
  });

  it("should refuse a record that says finished over a file that is not there", async () => {
    const service = serviceWith();
    const joined = await service.join({
      renders: [finished("syl-one"), finished("syl-gone", { onDisk: false })],
      because: "b",
    });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.reason).toContain("syl-gone");
  });

  it("should require a reason, exactly as every other write does", async () => {
    const service = serviceWith();
    const joined = await service.join({
      renders: [finished("syl-one"), finished("syl-two")],
      because: "   ",
    });

    expect(joined.ok).toBe(false);
  });
});

describe("parts that do not cut together", () => {
  it("should refuse a shape mismatch, naming which renders disagree and what each one is", async () => {
    const service = serviceWith();
    const joined = await service.join({
      renders: [
        finished("syl-portrait", { shape: { ...base(), width: 834, height: 1112 } }),
        finished("syl-landscape", { shape: { ...base(), width: 1112, height: 834 } }),
      ],
      because: "b",
    });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.reason).toContain("syl-portrait");
    expect(joined.reason).toContain("syl-landscape");
    expect(joined.reason).toContain("834x1112");
    expect(joined.reason).toContain("1112x834");
    expect(joined.retryable).toBe(true);
  });

  it("should leave NOTHING behind when it refuses: no record, no mp4, no list", async () => {
    // A refusal that has already written half a join is worse than the corrupt
    // file it was avoiding: the record would be reachable from `latest`.
    const service = serviceWith();
    const before = service.list().length;

    const joined = await service.join({
      renders: [
        finished("syl-portrait", { shape: { ...base(), width: 834, height: 1112 } }),
        finished("syl-landscape", { shape: { ...base(), width: 1112, height: 834 } }),
      ],
      because: "b",
    });

    expect(joined.ok).toBe(false);
    expect(service.list().length).toBe(before + 2);
    expect(service.list().every((record) => record.joinedFrom === null)).toBe(true);
  });

  it("should refuse a frame-rate mismatch", async () => {
    const service = serviceWith();
    const joined = await service.join({
      renders: [
        finished("syl-one", { shape: { ...base(), r_frame_rate: "30/1" } }),
        finished("syl-two", { shape: { ...base(), r_frame_rate: "24/1" } }),
      ],
      because: "b",
    });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.reason).toContain("syl-two");
  });

  it("should refuse when it cannot read one of the parts at all, rather than assuming it matches", async () => {
    const service = new RenderService({
      studio,
      backend: null,
      clock: fixedClock(NOW),
      ffmpeg: ffmpeg(),
      ffprobe: async () => ({ ok: false, message: "ffprobe: command not found" }),
      sleep: async () => undefined,
    });

    const joined = await service.join({
      renders: [finished("syl-one"), finished("syl-two")],
      because: "b",
    });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.reason).toContain("command not found");
  });

  it("should carry ffmpeg's own words, and write no record, when the cut itself fails", async () => {
    const service = serviceWith({ ffmpeg: ffmpeg({ ok: false }) });
    const before = service.list().length;

    const joined = await service.join({
      renders: [finished("syl-one"), finished("syl-two")],
      because: "b",
    });

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.reason).toContain("exited 1");
    expect(service.list().length).toBe(before + 2);
  });
});

describe("what the joined record claims about her face", () => {
  it("should hold her likeness only when every part it was cut from does", async () => {
    // A joined clip is as much her as its least-anchored second. Reporting
    // `holdsLikeness` from the first part would make a minute that turns into a
    // stranger half way through claim it is her all the way.
    const service = serviceWith();
    const joined = await service.join({
      renders: [
        finished("syl-good", { framing: "close_portrait", anchor: "renders/reference.png" }),
        finished("syl-drift", { framing: "mid_face_visible", anchor: null }),
      ],
      because: "b",
    });

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.record.holdsLikeness).toBe(false);
    expect(service.get(joined.record.name)?.holdsLikeness).toBe(false);
  });

  it("should hold her likeness when they all do", async () => {
    const service = serviceWith();
    const joined = await service.join({
      renders: [
        finished("syl-good", { framing: "close_portrait", anchor: "renders/reference.png" }),
        finished("syl-also", { framing: "face_turned_away", anchor: null }),
      ],
      because: "b",
    });

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.record.holdsLikeness).toBe(true);
  });

  it("should name every model that made it rather than pick one", async () => {
    const service = serviceWith();
    const joined = await service.join({
      renders: [
        finished("syl-one", { model: "seedance2" }),
        finished("syl-two", { model: "seedance2_5" }),
      ],
      because: "b",
    });

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.record.model).toContain("seedance2");
    expect(joined.record.model).toContain("seedance2_5");
  });
});

/** The shape every clip probes as unless a test says otherwise. */
function base(): Record<string, unknown> {
  return {
    codec_name: "h264",
    codec_type: "video",
    width: 834,
    height: 1112,
    pix_fmt: "yuv420p",
    r_frame_rate: "30/1",
  };
}
