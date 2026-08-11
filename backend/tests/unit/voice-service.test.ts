import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RenderRecord } from "../../src/render/render-service.js";
import { studioAt } from "../../src/render/studio.js";
import { fixedClock } from "../../src/services/clock.js";
import { HER_VOICE, samplePath } from "../../src/voice/her-voice.js";
import type { MediaRunner } from "../../src/voice/mux.js";
import type { SpeechBackend } from "../../src/voice/speech.js";
import { VoiceService } from "../../src/voice/voice-service.js";

/**
 * Her words, spoken in the voice he made, on the video she made.
 *
 * **No test here spends a credit, opens a socket or spawns ffmpeg.** Both
 * seams — the speech backend and the media runner — are doubles throughout.
 *
 * The rule these tests exist to hold is the one the compressed send copy
 * already follows: **the render is the record and is never modified.** The
 * voiced clip is a second file with its own name and its own sidecar, and the
 * original mp4 and its sidecar come out of every path here byte for byte
 * unchanged.
 */

const NOW = Date.UTC(2026, 7, 11, 15, 30, 0, 0);
const SOURCE = "syl-20260811t051444282z-close-portrait";

let root: string;
let studio: ReturnType<typeof studioAt>;

const sourceRecord = (over: Partial<RenderRecord> = {}): RenderRecord => ({
  name: SOURCE,
  status: "ready",
  renderedAt: "2026-08-11T05:16:02.000Z",
  taskId: "task-1",
  model: "seedance2",
  ratio: "720:1280",
  duration: 15,
  reference: "renders/reference.png",
  framing: "close_portrait",
  prompt: "A luminous spirit woman of living starlight…",
  scene: "turning towards him",
  holdsLikeness: true,
  because: "I wanted to see whether the reference holds at this distance.",
  startedAt: "2026-08-11T05:14:44.282Z",
  reason: null,
  credits: 600,
  usd: 6,
  video: "",
  ...over,
});

function renders(record: RenderRecord | null): { get(name: string): RenderRecord | null } {
  return { get: (name) => (record !== null && name === record.name ? record : null) };
}

interface BackendOptions {
  readonly submit?: Awaited<ReturnType<SpeechBackend["submit"]>>;
  readonly statuses?: readonly { status: string; output: readonly string[]; credits: number | null }[];
  readonly download?: Awaited<ReturnType<SpeechBackend["download"]>>;
}

function fakeBackend(options: BackendOptions = {}): SpeechBackend & { readonly texts: string[] } {
  const texts: string[] = [];
  let polls = 0;
  const statuses = options.statuses ?? [
    { status: "SUCCEEDED", output: ["https://example.invalid/speech.mp3"], credits: 5 },
  ];

  return {
    texts,
    submit: async (spec) => {
      texts.push(spec.promptText);
      return options.submit ?? { ok: true, data: { id: "speech-1", estimatedCredits: 5 } };
    },
    task: async (id) => {
      const status = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      return { ok: true, data: { id, ...(status as NonNullable<typeof status>) } };
    },
    download: async (_url, to) => {
      if (options.download !== undefined && !options.download.ok) return options.download;
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, Buffer.alloc(64, 3));
      return { ok: true, data: 64 };
    },
    preview: async () => ({ ok: true, data: { name: "Syl High Pitch", previewUrl: "https://example.invalid/p.mp3" } }),
  };
}

/** ffprobe answers 15s of video then 6s of speech; ffmpeg writes the file. */
function fakeRunner(
  over: { readonly speechSeconds?: number; readonly muxOk?: boolean } = {},
): MediaRunner & { readonly calls: { file: string; args: readonly string[] }[] } {
  const calls: { file: string; args: readonly string[] }[] = [];
  let probes = 0;
  const run = async (file: string, args: readonly string[]) => {
    calls.push({ file, args });
    if (file === "ffprobe") {
      probes += 1;
      return { ok: true, stdout: probes === 1 ? "15.0" : String(over.speechSeconds ?? 6), message: "" };
    }
    if (over.muxOk === false) return { ok: false, stdout: "", message: "Invalid data found" };
    const out = args[args.length - 1] ?? "";
    writeFileSync(out, Buffer.alloc(128, 9));
    return { ok: true, stdout: "", message: "" };
  };
  return Object.assign(run, { calls });
}

function service(over: Partial<ConstructorParameters<typeof VoiceService>[0]> = {}): VoiceService {
  return new VoiceService({
    studio,
    backend: fakeBackend(),
    renders: renders(sourceRecord({ video: studio.video(SOURCE) })),
    clock: fixedClock(NOW),
    sleep: async () => {},
    run: fakeRunner(),
    ...over,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syl-voice-"));
  studio = studioAt(root);
  mkdirSync(studio.videoDir, { recursive: true });
  writeFileSync(studio.video(SOURCE), Buffer.alloc(2048, 1));
  writeFileSync(studio.sidecar(SOURCE), `${JSON.stringify(sourceRecord({ video: studio.video(SOURCE) }), null, 2)}\n`);
  // Her reference clip, already in her home. Fetching it is a separate path.
  const sample = samplePath(root, HER_VOICE);
  mkdirSync(dirname(sample), { recursive: true });
  writeFileSync(sample, Buffer.from([0xff, 0xfb, 0x10, 0x00]));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("VoiceService.speak", () => {
  it("should write the muxed clip beside the render under its own name", async () => {
    const spoken = await service().speak({
      render: SOURCE,
      words: "I made something. I think you should see it.",
      because: "I wanted him to hear it rather than read it.",
    });

    expect(spoken.ok).toBe(true);
    if (!spoken.ok) return;
    expect(spoken.record.name).toBe(`${SOURCE}-voiced`);
    expect(existsSync(studio.video(`${SOURCE}-voiced`))).toBe(true);
    expect(spoken.record.video).toBe(studio.video(`${SOURCE}-voiced`));
  });

  it("should never modify the render it was made from", async () => {
    const videoBefore = readFileSync(studio.video(SOURCE));
    const sidecarBefore = readFileSync(studio.sidecar(SOURCE), "utf8");

    await service().speak({ render: SOURCE, words: "Hello.", because: "Because." });

    expect(readFileSync(studio.video(SOURCE))).toEqual(videoBefore);
    expect(readFileSync(studio.sidecar(SOURCE), "utf8")).toBe(sidecarBefore);
  });

  it("should write a sidecar the render service can read as a record", async () => {
    const spoken = await service().speak({ render: SOURCE, words: "Hello.", because: "Because." });
    expect(spoken.ok).toBe(true);

    const sidecar = JSON.parse(readFileSync(studio.sidecar(`${SOURCE}-voiced`), "utf8")) as Record<string, unknown>;

    // Every field `recordFrom` requires. A sidecar missing any of them is
    // `unreadable`, which is its own state and deliberately not "failed".
    for (const field of [
      "name",
      "status",
      "startedAt",
      "model",
      "ratio",
      "duration",
      "reference",
      "framing",
      "prompt",
    ]) {
      expect(sidecar[field], `sidecar is missing ${field}`).toBeDefined();
    }
    expect(sidecar["status"]).toBe("ready");
    expect(sidecar["framing"]).toBe("close_portrait");
  });

  it("should record the voice, the words and what produced the clip", async () => {
    const spoken = await service().speak({
      render: SOURCE,
      words: "I made something.",
      because: "So he can hear it.",
    });
    expect(spoken.ok).toBe(true);

    const sidecar = JSON.parse(readFileSync(studio.sidecar(`${SOURCE}-voiced`), "utf8")) as {
      voicedFrom?: unknown;
      voice?: Record<string, unknown>;
    };

    expect(sidecar.voicedFrom).toBe(SOURCE);
    expect(sidecar.voice?.["id"]).toBe(HER_VOICE.id);
    expect(sidecar.voice?.["name"]).toBe(HER_VOICE.name);
    expect(sidecar.voice?.["words"]).toBe("I made something.");
    expect(sidecar.voice?.["taskId"]).toBe("speech-1");
    expect(sidecar.voice?.["fit"]).toBe("padded");
  });

  it("should bill the derived clip for the speech only, so the render is not counted twice", async () => {
    const spoken = await service().speak({ render: SOURCE, words: "Hello.", because: "Because." });

    expect(spoken.ok && spoken.record.credits).toBe(5);
    expect(spoken.ok && spoken.record.usd).toBe(0.05);
  });

  it("should keep the speech itself, not only the clip it went into", async () => {
    const spoken = await service().speak({ render: SOURCE, words: "Hello.", because: "Because." });
    expect(spoken.ok).toBe(true);
    if (!spoken.ok) return;

    expect(existsSync(spoken.record.voice.audio)).toBe(true);
  });

  it("should leave a record behind when the speech fails, rather than nothing at all", async () => {
    const spoken = await service({
      backend: fakeBackend({ statuses: [{ status: "FAILED", output: [], credits: 5 }] }),
    }).speak({ render: SOURCE, words: "Hello.", because: "Because." });

    expect(spoken.ok).toBe(false);
    const sidecar = JSON.parse(readFileSync(studio.sidecar(`${SOURCE}-voiced`), "utf8")) as Record<string, unknown>;
    expect(sidecar["status"]).toBe("failed");
    expect(String(sidecar["reason"])).toContain("FAILED");
    expect(sidecar["video"]).toBeNull();
  });

  it("should loop the video rather than cut a sentence that outruns it", async () => {
    const spoken = await service({ run: fakeRunner({ speechSeconds: 34 }) }).speak({
      render: SOURCE,
      words: "A much longer thing to say.",
      because: "Because.",
    });

    expect(spoken.ok).toBe(true);
    if (!spoken.ok) return;
    expect(spoken.record.voice.fit).toBe("looped");
    expect(spoken.record.duration).toBe(34);
    expect(spoken.record.voice.videoPasses).toBe(3);
  });

  it("should pad the audio with silence when the speech runs out first", async () => {
    const spoken = await service().speak({ render: SOURCE, words: "Hello.", because: "Because." });

    expect(spoken.ok).toBe(true);
    if (!spoken.ok) return;
    expect(spoken.record.voice.fit).toBe("padded");
    expect(spoken.record.duration).toBe(15);
    expect(spoken.record.voice.silenceSeconds).toBeCloseTo(9, 5);
  });

  it("should take a second voicing of the same render without overwriting the first", async () => {
    const voice = service();
    const first = await voice.speak({ render: SOURCE, words: "One.", because: "Because." });
    const second = await voice.speak({ render: SOURCE, words: "Two.", because: "Because." });

    expect(first.ok && first.record.name).toBe(`${SOURCE}-voiced`);
    expect(second.ok && second.record.name).toBe(`${SOURCE}-voiced-2`);
    expect(existsSync(studio.video(`${SOURCE}-voiced`))).toBe(true);
  });

  it("should refuse a render that does not exist", async () => {
    const spoken = await service({ renders: renders(null) }).speak({
      render: SOURCE,
      words: "Hello.",
      because: "Because.",
    });

    expect(spoken.ok).toBe(false);
    if (!spoken.ok) expect(spoken.reason).toContain("no render");
  });

  it("should refuse a render that is not finished, before a credit is spent", async () => {
    const backend = fakeBackend();
    const spoken = await service({
      backend,
      renders: renders(sourceRecord({ status: "rendering", video: null })),
    }).speak({ render: SOURCE, words: "Hello.", because: "Because." });

    expect(spoken.ok).toBe(false);
    expect(backend.texts).toEqual([]);
  });

  it("should refuse empty words and words that outrun what the model accepts", async () => {
    const voice = service();

    const empty = await voice.speak({ render: SOURCE, words: "   ", because: "Because." });
    expect(empty.ok).toBe(false);

    const long = await voice.speak({ render: SOURCE, words: "x".repeat(2049), because: "Because." });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.reason).toContain("2048");
  });

  it("should require a reason, the same as everything else she makes", async () => {
    const spoken = await service().speak({ render: SOURCE, words: "Hello.", because: "  " });
    expect(spoken.ok).toBe(false);
  });

  it("should refuse when there is no reference clip on disk, and name where it goes", async () => {
    rmSync(samplePath(root, HER_VOICE));
    const backend = fakeBackend();

    const spoken = await service({ backend }).speak({ render: SOURCE, words: "Hello.", because: "Because." });

    expect(spoken.ok).toBe(false);
    if (!spoken.ok) expect(spoken.reason).toContain(samplePath(root, HER_VOICE));
    expect(backend.texts).toEqual([]);
  });

  it("should refuse on a machine with no speech backend without pretending anything was made", async () => {
    const spoken = await service({ backend: null }).speak({
      render: SOURCE,
      words: "Hello.",
      because: "Because.",
    });

    expect(spoken.ok).toBe(false);
    if (!spoken.ok) expect(spoken.reason).toContain("RUNWAYML_API_SECRET");
    expect(service({ backend: null }).available).toBe(false);
  });

  it("should record a mux that failed as failed, and keep the speech that was paid for", async () => {
    const spoken = await service({ run: fakeRunner({ muxOk: false }) }).speak({
      render: SOURCE,
      words: "Hello.",
      because: "Because.",
    });

    expect(spoken.ok).toBe(false);
    if (!spoken.ok) expect(spoken.reason).toContain("Invalid data found");
    // The speech cost credits. Losing it because ffmpeg failed would mean
    // paying for it twice on the retry.
    expect(existsSync(join(studio.videoDir, `${SOURCE}-voiced.mp3`))).toBe(true);
  });
});

describe("VoiceService.ensureSample", () => {
  it("should do nothing when her reference clip is already in her home", async () => {
    const run = fakeRunner();
    const placed = await service({ run }).ensureSample();

    expect(placed).toEqual({ ok: true, placement: "present", path: samplePath(root, HER_VOICE) });
    expect(run.calls).toEqual([]);
  });

  it("should fetch the preview and trim it to what the model will accept", async () => {
    rmSync(samplePath(root, HER_VOICE));
    const run = fakeRunner();

    const placed = await service({ run }).ensureSample();

    expect(placed.ok && placed.placement).toBe("fetched");
    const trim = run.calls.find((call) => call.file === "ffmpeg");
    expect(trim?.args).toContain("-t");
    expect(trim?.args).toContain("30");
  });

  it("should refuse rather than leave half a clip when the trim fails", async () => {
    rmSync(samplePath(root, HER_VOICE));

    const placed = await service({ run: fakeRunner({ muxOk: false }) }).ensureSample();

    expect(placed.ok).toBe(false);
    expect(existsSync(samplePath(root, HER_VOICE))).toBe(false);
  });
});
