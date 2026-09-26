import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { episodeHome, loadEpisodeAssets } from "../../src/episodes/assets.js";
import { EpisodeService, MAX_ATTEMPTS } from "../../src/episodes/episode-service.js";
import type { MediaRunner } from "../../src/episodes/media.js";
import type { EpisodeScene } from "../../src/episodes/rules.js";
import { RenderService } from "../../src/render/render-service.js";
import type { RenderBackend, SubmitSpec } from "../../src/render/runway.js";
import { studioAt } from "../../src/render/studio.js";
import { fixedClock } from "../../src/services/clock.js";

/**
 * The episode engine (`syl-8tts`), end to end with nothing real behind it. The
 * Runway backend, ffmpeg and whisper are doubles, and the RenderService and the
 * studio are real, because "an episode is an ordinary render" is the claim
 * under test.
 *
 * The children are fictional. The repository is public.
 */

const NOW = Date.UTC(2026, 8, 26, 23, 45, 0, 0);

let home: string;

const SCENES: EpisodeScene[] = [
  { line: "Mee-ra! Thee-oh! Today we race a beam of light!", action: "She waves.", sfx: "whoosh", factCheck: "c = 299,792 km/s" },
  { line: "Light goes round the Earth seven times in one second.", action: "A streak circles Earth.", sfx: "zip", factCheck: "40,075 km equator" },
  { line: "It reaches the Moon in about one second.", action: "A beam hits the Moon.", sfx: "ping", factCheck: "384,400 km" },
  { line: "See you soon, Mee-ra! See you soon, Thee-oh!", action: "She waves goodbye.", sfx: "chime", factCheck: "no factual claims" },
];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "syl-episode-"));
  const dir = episodeHome(home);
  mkdirSync(dir, { recursive: true });
  for (const file of ["reference.png", "voice.mp3", "bed.mp3", "ggml-base.en.bin"]) writeFileSync(join(dir, file), Buffer.alloc(8));
  writeFileSync(join(dir, "cast.json"), JSON.stringify({ look: "Syl, the starlight woman. ", pronoun: "She" }));
  writeFileSync(
    join(dir, "names.json"),
    JSON.stringify([
      { spoken: "Mee-ra", heard: ["mira", "myra"] },
      { spoken: "Thee-oh", heard: ["theo"] },
    ]),
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * A Runway double. Every submit gets a task; each task succeeds, charged 450,
 * unless `refuse` names it. Downloads write a file where they are told.
 */
function runway(options: { readonly refuse?: (n: number) => boolean } = {}): RenderBackend & {
  readonly specs: SubmitSpec[];
} {
  const specs: SubmitSpec[] = [];
  return {
    specs,
    submit: async (spec) => {
      specs.push(spec);
      return { ok: true, data: { id: `task-${String(specs.length)}` } };
    },
    task: async (id) => {
      const n = Number(id.split("-")[1]);
      const refused = options.refuse?.(n) ?? false;
      return {
        ok: true,
        data: {
          id,
          status: refused ? "FAILED" : "SUCCEEDED",
          output: refused ? [] : [`https://runway.example/${id}.mp4`],
          failureCode: refused ? "SAFETY.OUTPUT.THIRD_PARTY" : null,
          failure: refused ? "refused" : null,
          charged: refused ? 0 : 450,
        },
      };
    },
    download: async (_url, to) => {
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, Buffer.alloc(16));
      return { ok: true, data: 16 };
    },
  };
}

/**
 * ffmpeg, ffprobe and whisper. whisper "hears" whatever `hear` says for a
 * given take stem (`scene-2.take1`), and the whole script for the finished
 * episode.
 */
function media(hear: (stem: string) => string, options: { readonly lufs?: number } = {}): MediaRunner {
  return async (file, args) => {
    if (file === "ffprobe") {
      // A scene is fifteen seconds; the finished episode is all of them.
      const seconds = (args.at(-1) ?? "").endsWith("-episode.mp4") ? SCENES.length * 15 : 15;
      return { ok: true, stdout: `${String(seconds)}.0\n`, stderr: "", message: "" };
    }
    if (file === "whisper-cli") {
      const wav = args[args.indexOf("-f") + 1] ?? "";
      const stem = basename(wav).replace(/\.16k\.wav$/u, "");
      return { ok: true, stdout: `[00:00:00.000 --> 00:00:14.000]   ${hear(stem)}`, stderr: "", message: "" };
    }
    if (args.includes("ebur128")) {
      return { ok: true, stdout: "", stderr: `Summary:\n\n  Integrated loudness:\n    I:         ${String(options.lufs ?? -16.1)} LUFS\n`, message: "" };
    }
    const out = args.at(-1) ?? "";
    if (out.endsWith(".mp4")) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.alloc(16));
    }
    return { ok: true, stdout: "", stderr: "", message: "" };
  };
}

/** Each scene's line as whisper would write it back, names and all. */
function faithful(stem: string): string {
  if (stem === "episode") return SCENES.map((s) => s.line).join(" ").replace(/Mee-ra/gu, "Myra").replace(/Thee-oh/gu, "Theo");
  const index = Number(/scene-(\d+)/u.exec(stem)?.[1] ?? "0") - 1;
  return (SCENES[index]?.line ?? "").replace(/Mee-ra/gu, "Myra").replace(/Thee-oh/gu, "Theo");
}

function build(backend: RenderBackend | null, run: MediaRunner): { renders: RenderService; episodes: EpisodeService } {
  const studio = studioAt(home);
  const renders = new RenderService({ studio, backend, clock: fixedClock(NOW) });
  const episodes = new EpisodeService({
    renders,
    studio,
    backend,
    assets: () => loadEpisodeAssets(home),
    media: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", whisper: "whisper-cli", run },
    dataUri: (path) => `data:x;base64,${path}`,
    sleep: async () => {},
    pollMs: 0,
  });
  return { renders, episodes };
}

describe("making an episode", () => {
  it("should render every scene, hear it, assemble it and settle a ready render", async () => {
    const backend = runway();
    const { renders, episodes } = build(backend, media(faithful));

    const started = episodes.start({ scenes: SCENES, because: "Mira asked about light" });
    expect(started.ok).toBe(true);
    await episodes.drain();

    if (!started.ok) return;
    const record = renders.get(started.record.name);
    expect(record?.status).toBe("ready");
    expect(record?.video !== null && existsSync(record?.video ?? "")).toBe(true);
    expect(record?.credits).toBe(4 * 450);
    expect(backend.specs).toHaveLength(4);
  });

  it("should send each scene as one voiced generation: her reference, her voice, native sound", async () => {
    const backend = runway();
    const { episodes } = build(backend, media(faithful));
    episodes.start({ scenes: SCENES, because: "light" });
    await episodes.drain();

    const spec = backend.specs[0];
    expect(spec).toMatchObject({
      model: "seedance2_5",
      ratio: "834:1112",
      duration: 15,
      audio: true,
      referenceAudio: [{ type: "audio", uri: `data:x;base64,${join(episodeHome(home), "voice.mp3")}` }],
      promptImage: [{ uri: `data:x;base64,${join(episodeHome(home), "reference.png")}` }],
    });
    expect(spec?.promptText).toContain('She speaks to the viewer: "Mee-ra! Thee-oh!');
  });

  it("should re-roll a take that said the wrong words, with a new seed, and bill both takes", async () => {
    const backend = runway();
    let seed = 0;
    const studio = studioAt(home);
    const renders = new RenderService({ studio, backend, clock: fixedClock(NOW) });
    const episodes = new EpisodeService({
      renders,
      studio,
      backend,
      assets: () => loadEpisodeAssets(home),
      media: {
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
        whisper: "whisper-cli",
        run: media((stem) => (stem === "scene-2.take1" ? "Hello there, let us sing a song." : faithful(stem))),
      },
      dataUri: (path) => path,
      sleep: async () => {},
      pollMs: 0,
      seed: () => (seed += 1),
    });

    const started = episodes.start({ scenes: SCENES, because: "light" });
    await episodes.drain();

    if (!started.ok) throw new Error(started.reason);
    const record = renders.get(started.record.name);
    expect(record?.status).toBe("ready");
    expect(backend.specs).toHaveLength(5);
    expect(new Set(backend.specs.map((spec) => ("seed" in spec ? spec.seed : undefined))).size).toBe(5);
    expect(record?.parts[1]?.charged).toBe(900);
    expect(record?.credits).toBe(5 * 450);
  });

  it("should re-roll a take Runway refused, which it charges nothing for", async () => {
    const backend = runway({ refuse: (n) => n === 1 });
    const { renders, episodes } = build(backend, media(faithful));

    const started = episodes.start({ scenes: SCENES, because: "light" });
    await episodes.drain();

    if (!started.ok) throw new Error(started.reason);
    const record = renders.get(started.record.name);
    expect(record?.status).toBe("ready");
    expect(backend.specs).toHaveLength(5);
    expect(record?.credits).toBe(4 * 450);
  });

  it(`should give up on a scene after ${String(MAX_ATTEMPTS)} bad takes, say which, and keep what was paid`, async () => {
    const backend = runway();
    const { renders, episodes } = build(backend, media((stem) => (stem.startsWith("scene-3") ? "Something else entirely." : faithful(stem))));

    const started = episodes.start({ scenes: SCENES, because: "light" });
    await episodes.drain();

    if (!started.ok) throw new Error(started.reason);
    const record = renders.get(started.record.name);
    // `partial`, not `failed`: the reader derives it from paid takes that are on
    // disk (render-service `settledStatus`), which is the truth about the money.
    expect(record?.status).toBe("partial");
    expect(record?.reason).toContain("Scene 3 said the wrong words");
    expect(backend.specs).toHaveLength(3 + MAX_ATTEMPTS);
    expect(record?.credits).toBe((3 + MAX_ATTEMPTS) * 450);
    expect(existsSync(studioAt(home).video(started.record.name))).toBe(false);
  });

  it("should reject a bookend take that garbles a child's name", async () => {
    const backend = runway();
    const { renders, episodes } = build(
      backend,
      media((stem) => (stem.startsWith("scene-1") ? "Myra! Leo! Today we race a beam of light!" : faithful(stem))),
    );

    const started = episodes.start({ scenes: SCENES, because: "light" });
    await episodes.drain();

    if (!started.ok) throw new Error(started.reason);
    expect(renders.get(started.record.name)?.reason).toContain("Scene 1 did not clearly say Thee-oh");
  });

  it("should not deliver an episode whose finished mix fails its final check", async () => {
    const { renders, episodes } = build(runway(), media(faithful, { lufs: -30 }));

    const started = episodes.start({ scenes: SCENES, because: "light" });
    await episodes.drain();

    if (!started.ok) throw new Error(started.reason);
    const record = renders.get(started.record.name);
    expect(record?.status).toBe("partial");
    expect(record?.reason).toContain("LUFS");
  });
});

describe("refusing before anything is spent", () => {
  it("should refuse a script that breaks the formula, write nothing and send nothing", () => {
    const backend = runway();
    const { renders, episodes } = build(backend, media(faithful));

    const started = episodes.start({ scenes: SCENES.slice(0, 2), because: "light" });

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.reason).toContain("Nothing was spent");
    expect(backend.specs).toHaveLength(0);
    expect(renders.list()).toHaveLength(0);
  });

  it("should say which file is missing when her episode home is not set up", () => {
    rmSync(join(episodeHome(home), "voice.mp3"));
    const { episodes } = build(runway(), media(faithful));

    const started = episodes.start({ scenes: SCENES, because: "light" });

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.reason).toContain("voice.mp3 missing");
    expect(episodes.availability().ok).toBe(false);
  });

  it("should refuse with no Runway key rather than pretending to start", () => {
    const { episodes } = build(null, media(faithful));
    expect(episodes.start({ scenes: SCENES, because: "light" }).ok).toBe(false);
  });
});

describe("after a restart", () => {
  it("should settle an episode that was in flight as failed, never resume it", () => {
    const backend = runway();
    const { renders, episodes } = build(backend, media(faithful));
    const record = renders.openEpisode({
      because: "light",
      script: "x",
      prompts: ["a", "b", "c", "d"],
      model: "seedance2_5",
      ratio: "834:1112",
      reference: join(episodeHome(home), "reference.png"),
      sceneSeconds: 15,
      creditsPerScene: 450,
    });

    episodes.resume();

    const settled = renders.get(record.name);
    expect(settled?.status).toBe("failed");
    expect(settled?.reason).toContain("restarted");
    expect(backend.specs).toHaveLength(0);
  });
});

describe("the formula she reads first", () => {
  it("should carry the rules and the children's names spelled the way they are said", () => {
    const { episodes } = build(runway(), media(faithful));
    const guide = episodes.guide();
    expect(guide).toContain("At most 34 words");
    expect(guide).toContain("factCheck");
    expect(guide).toContain("Mee-ra, Thee-oh");
    expect(guide).not.toContain("cannot run");
  });

  it("should say why one cannot run here, rather than hand her a formula she cannot use", () => {
    rmSync(join(episodeHome(home), "bed.mp3"));
    const { episodes } = build(runway(), media(faithful));
    expect(episodes.guide()).toContain("Right now it cannot run: Episodes are not set up on this machine: bed.mp3 missing");
  });
});
