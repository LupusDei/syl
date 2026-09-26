import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RenderService, type RenderRecord } from "../../src/render/render-service.js";
import type { RenderBackend } from "../../src/render/runway.js";
import { studioAt } from "../../src/render/studio.js";
import { fixedClock } from "../../src/services/clock.js";

/**
 * An episode is an ORDINARY RENDER (`syl-8tts`).
 *
 * That is the design, and these tests are what hold it. Because an episode is a
 * render, `see_myself` can look at it, `show_him` can send it, the render-review
 * job wakes her to look at it, and `spend()` counts what it cost, with none of
 * those changing by a line. The episode engine makes the footage; RenderService
 * stays the only thing that writes a sidecar.
 */

const NOW = Date.UTC(2026, 8, 26, 23, 30, 0, 0);

let root: string;
let studio: ReturnType<typeof studioAt>;
let reference: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syl-episode-record-"));
  studio = studioAt(root);
  reference = join(root, "episodes", "reference.png");
  mkdirSync(dirname(reference), { recursive: true });
  writeFileSync(reference, Buffer.alloc(8));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A backend that must never be asked anything: episodes are followed by their own engine. */
function untouchable(): RenderBackend & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    submit: async () => {
      asked.push("submit");
      return { ok: false, failure: { message: "no", retryable: false } };
    },
    task: async (id) => {
      asked.push(`task ${id}`);
      return { ok: false, failure: { message: "no", retryable: false } };
    },
    download: async () => {
      asked.push("download");
      return { ok: false, failure: { message: "no", retryable: false } };
    },
  };
}

function service(watched: RenderRecord[] = [], backend: RenderBackend = untouchable()): RenderService {
  return new RenderService({
    studio,
    backend,
    clock: fixedClock(NOW),
    watch: (record) => watched.push(record),
  });
}

const OPEN = {
  because: "Mira asked how rockets work",
  script: "Scene one line.\n\nScene two line.",
  prompts: ["prompt one", "prompt two", "prompt three", "prompt four"],
  model: "seedance2_5",
  ratio: "834:1112",
  reference: "",
  sceneSeconds: 15,
  creditsPerScene: 450,
};

function open(renders: RenderService): RenderRecord {
  return renders.openEpisode({ ...OPEN, reference });
}

describe("opening an episode", () => {
  it("should write an ordinary render record, still rendering, named as an episode", () => {
    const watched: RenderRecord[] = [];
    const renders = service(watched);

    const record = open(renders);

    expect(record.name).toMatch(/^syl-\d{8}t\d+z-episode$/u);
    expect(record.status).toBe("rendering");
    expect(record.duration).toBe(60);
    expect(record.reference).toBe("episodes/reference.png");
    expect(record.parts).toHaveLength(4);
    expect(record.parts.every((part) => part.taskId === null && part.status === "rendering")).toBe(true);
    expect(record.estimated).toBe(1800);
    expect(renders.get(record.name)?.status).toBe("rendering");
  });

  it("should promise to come back and look, exactly as a render does", () => {
    const watched: RenderRecord[] = [];
    const record = open(service(watched));
    expect(watched.map((w) => w.name)).toEqual([record.name]);
  });

  it("should never have the render follower pick an episode up after a restart", () => {
    const backend = untouchable();
    const first = service([], backend);
    const record = open(first);
    first.updateEpisode(record.name, record.parts.map((part, index) => ({ ...part, taskId: `task-${String(index)}` })));

    // A restart: a new service over the same studio, resuming whatever is in flight.
    const second = service([], backend);
    second.resume();

    // Following an episode as a render would submit NEW generations from its
    // last frame: credits spent on footage nobody asked for.
    expect(backend.asked).toEqual([]);
  });
});

describe("settling an episode", () => {
  it("should become ready with its video, and its credits should reach the ledger", () => {
    const renders = service();
    const record = open(renders);
    const video = studio.video(record.name);
    mkdirSync(dirname(video), { recursive: true });
    writeFileSync(video, Buffer.alloc(8));
    const paid = record.parts.map((part, index) => ({
      ...part,
      taskId: `task-${String(index)}`,
      video: `/takes/${String(index)}.mp4`,
      status: "ready" as const,
      // Scene two needed a second take, and both were charged.
      charged: index === 1 ? 900 : 450,
    }));

    const settled = renders.settleEpisode(record.name, { status: "ready", video, parts: paid });

    expect(settled?.status).toBe("ready");
    expect(settled?.video).toBe(video);
    expect(settled?.credits).toBe(2250);
    expect(renders.spend().credits).toBe(2250);
    expect(renders.spend().seconds).toBe(60);
  });

  it("should record why it failed, and keep what was paid for", () => {
    const renders = service();
    const record = open(renders);
    const paid = record.parts.map((part, index) =>
      index === 0 ? { ...part, taskId: "task-0", charged: 450, status: "ready" as const } : part,
    );

    const settled = renders.settleEpisode(record.name, {
      status: "failed",
      reason: "Scene 2 said the wrong words three times.",
      parts: paid,
    });

    expect(settled?.status).toBe("failed");
    expect(settled?.reason).toBe("Scene 2 said the wrong words three times.");
    expect(settled?.video).toBeNull();
    const onDisk = JSON.parse(readFileSync(studio.sidecar(record.name), "utf8")) as { parts: { charged: number }[] };
    expect(onDisk.parts[0]?.charged).toBe(450);
  });

  it("should refuse to settle a render that is not an episode", () => {
    const renders = service();
    expect(renders.settleEpisode("syl-20260926t233000z-mid-face-visible", { status: "failed", reason: "x", parts: [] })).toBeNull();
    expect(existsSync(studio.sidecar("syl-20260926t233000z-mid-face-visible"))).toBe(false);
  });
});
