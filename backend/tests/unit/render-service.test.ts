import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/services/clock.js";
import { RenderService } from "../../src/render/render-service.js";
import type { RenderBackend, RunwayResult, RunwayTask, SubmitSpec } from "../../src/render/runway.js";
import { studioAt } from "../../src/render/studio.js";

/**
 * Syl rendering herself, and being able to say what it cost.
 *
 * **No test here spends a credit or opens a socket.** The backend is a double
 * throughout: the one thing this whole capability must never do is reach Runway
 * from a test run, and the seam that guarantees it is that `RenderService`
 * never constructs its own client.
 *
 * The behaviour under test is mostly about the *record*. `docs/VIDEO.md` says
 * why: the first eight loops were made and their prompts lost, so there was no
 * way to make a ninth in the same voice or to re-run a failure with one thing
 * changed. The outputs survived and the inputs did not. Every render here
 * writes its sidecar before it can possibly succeed, so even a render that
 * fails leaves behind the thing that would let it be tried again.
 */

const NOW = Date.UTC(2026, 7, 11, 15, 30, 0, 0);

let root: string;
let studio: ReturnType<typeof studioAt>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syl-studio-"));
  studio = studioAt(root);
  // The reference. Everything hangs on it — see `docs/VIDEO.md` — so the tests
  // put a real file where the real one lives rather than stubbing the read.
  const reference = studio.reference();
  mkdirSync(dirname(reference), { recursive: true });
  writeFileSync(reference, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface FakeOptions {
  readonly submit?: RunwayResult<{ readonly id: string }>;
  /** Statuses handed back in order; the last one repeats. */
  readonly statuses?: readonly RunwayTask[];
  readonly download?: RunwayResult<number>;
}

function fakeBackend(options: FakeOptions = {}): RenderBackend & { readonly specs: SubmitSpec[] } {
  const specs: SubmitSpec[] = [];
  let polls = 0;
  const statuses = options.statuses ?? [
    { id: "task-1", status: "SUCCEEDED", output: ["https://example.invalid/render.mp4"] },
  ];

  return {
    specs,
    submit: async (spec) => {
      specs.push(spec);
      return options.submit ?? { ok: true, data: { id: "task-1" } };
    },
    task: async () => {
      const status = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      return { ok: true, data: status as RunwayTask };
    },
    download: async (_url, to) => {
      if (options.download !== undefined && !options.download.ok) return options.download;
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, Buffer.alloc(1024, 7));
      return { ok: true, data: 1024 };
    },
  };
}

function serviceWith(backend: RenderBackend | null): RenderService {
  return new RenderService({
    studio,
    backend,
    clock: fixedClock(NOW),
    // Nothing waits in a test. The poll interval is a property of Runway's
    // latency, not of this state machine, so holding it at zero exercises the
    // same transitions in microseconds.
    sleep: async () => undefined,
  });
}

const ASK = {
  scene: "she turns once, slowly, and lets the light run down her arm",
  framing: "close_portrait",
  because: "he said he wants to know what I look like, and I want to know too",
} as const;

describe("asking for a render", () => {
  it("should come back immediately rather than holding a turn open for two minutes", async () => {
    const service = serviceWith(fakeBackend());

    const started = await service.start(ASK);

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // The render has been submitted and is NOT finished. A verb that waited for
    // the mp4 would block her whole turn on somebody else's GPU queue.
    expect(started.record.status).toBe("rendering");
    expect(started.record.video).toBeNull();

    await service.drain();
    expect(service.get(started.record.name)?.status).toBe("ready");
  });

  it("should write the sidecar before the render can possibly have succeeded", async () => {
    // The rule `docs/VIDEO.md` exists to enforce, one step stricter than
    // `generate.mjs`: that script writes the record AFTER a successful
    // download, so a render that failed left nothing behind at all.
    const service = serviceWith(fakeBackend({ statuses: [{ id: "t", status: "PENDING", output: [] }] }));

    const started = await service.start(ASK);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const sidecar = JSON.parse(readFileSync(studio.sidecar(started.record.name), "utf8")) as Record<
      string,
      unknown
    >;

    expect(sidecar["status"]).toBe("rendering");
    expect(sidecar["taskId"]).toBe("task-1");
    expect(sidecar["prompt"]).toEqual(expect.stringContaining("light run down her arm"));
    expect(sidecar["reference"]).toEqual(expect.any(String));
    expect(sidecar["model"]).toEqual(expect.any(String));
    expect(sidecar["ratio"]).toEqual(expect.any(String));
    expect(sidecar["duration"]).toEqual(expect.any(Number));

    // The render never finishes in this test, so let the follower give up
    // rather than leaving it polling into the next one.
    await service.drain();
  });

  it("should keep her own words for the scene beside the prompt they became", async () => {
    // Same rule as `WHEN.said` on `remind_me`: the interpretation and the words
    // it came from both survive, because only one of them can be checked later.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    const started = await service.start(ASK);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(started.record.scene).toBe(ASK.scene);
    expect(started.record.prompt).not.toBe(ASK.scene);
    expect(started.record.prompt).toContain(ASK.scene);
  });

  it("should compose the prompt from the recipe that made the loops, not from the scene alone", async () => {
    const backend = fakeBackend();
    const service = serviceWith(backend);

    await service.start(ASK);

    const prompt = backend.specs[0]?.promptText ?? "";
    // The identity phrase every one of the eight shots opens with.
    expect(prompt).toMatch(/luminous spirit woman of living starlight/iu);
    // And the loop clause, which is a property of the PROMPT and not of the
    // editing: drop it and the clip will not cut against its neighbours.
    expect(prompt).toMatch(/begins and ends on empty starfield/iu);
  });

  it("should hand the reference over as the image the model anchors on", async () => {
    const backend = fakeBackend();
    const service = serviceWith(backend);

    await service.start(ASK);

    expect(backend.specs[0]?.promptImage).toMatch(/^data:image\/png;base64,/u);
  });

  it("should record the framing and whether it is one that holds her likeness", async () => {
    const service = serviceWith(fakeBackend());

    const drifting = await service.start({ ...ASK, framing: "mid_face_visible" });

    expect(drifting.ok).toBe(true);
    if (!drifting.ok) return;
    expect(drifting.record.framing).toBe("mid_face_visible");
    expect(drifting.record.holdsLikeness).toBe(false);
  });

  it("should still render a framing known to drift, because trying things is not rationed", async () => {
    // The Commander, 2026-08-11: the credits are for exactly this sort of
    // experiment. There is no approval gate here on purpose, and adding one
    // later needs his say-so rather than a refactor.
    const service = serviceWith(fakeBackend());

    const started = await service.start({ ...ASK, framing: "wide_face_visible" });
    expect(started.ok).toBe(true);

    await service.drain();
    expect(service.list().filter((r) => r.status === "ready").length).toBe(1);
  });
});

describe("what a render refuses", () => {
  it("should refuse a scene it was not given", async () => {
    const service = serviceWith(fakeBackend());
    const refused = await service.start({ ...ASK, scene: "   " });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/scene|describe/iu);
  });

  it("should refuse a framing outside the four, naming the ones that exist", async () => {
    const service = serviceWith(fakeBackend());
    const refused = await service.start({ ...ASK, framing: "dramatic" });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain("close_portrait");
  });

  it("should refuse without a reason, exactly as every other write does", async () => {
    const service = serviceWith(fakeBackend());
    const refused = await service.start({ ...ASK, because: "" });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/why|reason/iu);
  });

  it("should say plainly when this machine has no way to render at all", async () => {
    // `RUNWAYML_API_SECRET` absent is the ORDINARY state of a machine that is
    // not the Commander's, so it is a sentence rather than a crash — the same
    // decision `ToolContext.fleet` makes about a missing Adjutant.
    const service = serviceWith(null);
    const refused = await service.start(ASK);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/RUNWAYML_API_SECRET/u);
    expect(service.list()).toEqual([]);
  });

  it("should say the reference is missing rather than render somebody else", async () => {
    rmSync(studio.reference(), { force: true });
    const service = serviceWith(fakeBackend());

    const refused = await service.start(ASK);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/reference/iu);
  });
});

describe("a render that does not succeed", () => {
  it("should leave the record behind, with the reason, so it can be run again", async () => {
    const service = serviceWith(
      fakeBackend({ statuses: [{ id: "t", status: "FAILED", output: [] }] }),
    );

    const started = await service.start(ASK);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    const record = service.get(started.record.name);
    expect(record?.status).toBe("failed");
    expect(record?.reason).not.toBe(null);
    // The inputs survive the failure. That is the whole point of the sidecar.
    expect(record?.prompt).toContain(ASK.scene);
  });

  it("should refuse at submission without leaving a record claiming to be rendering", async () => {
    const service = serviceWith(
      fakeBackend({
        submit: { ok: false, failure: { message: "Runway answered 402.", retryable: false } },
      }),
    );

    const refused = await service.start(ASK);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain("402");
    // A record left at `rendering` would be chased forever by `resume`, and
    // would read to her as a render still in flight that will never arrive.
    expect(service.list().some((record) => record.status === "rendering")).toBe(false);
  });

  it("should not report a video it never downloaded", async () => {
    const service = serviceWith(
      fakeBackend({
        download: { ok: false, failure: { message: "the download stopped.", retryable: true } },
      }),
    );

    const started = await service.start(ASK);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    const record = service.get(started.record.name);
    expect(record?.status).toBe("failed");
    expect(record?.video).toBeNull();
    expect(existsSync(studio.video(started.record.name))).toBe(false);
  });
});

describe("what she has spent", () => {
  it("should price a finished render from the published rate and hold it on the record", async () => {
    const service = serviceWith(fakeBackend());

    const started = await service.start(ASK);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    const record = service.get(started.record.name);
    // Seedance2 at 720p is 36 credits a second, fifteen seconds, a credit is a
    // cent. The number is Runway's, not ours.
    expect(record?.credits).toBe(540);
    expect(record?.usd).toBeCloseTo(5.4, 5);
  });

  it("should total everything on disk, so the answer cannot drift from the records", async () => {
    // Derived rather than kept: a second ledger beside the sidecars is a second
    // thing to get wrong, and the sidecars are the ones that must be right.
    const service = serviceWith(fakeBackend());

    await service.start(ASK);
    await service.drain();
    await service.start({ ...ASK, scene: "she drifts backwards into the dark, laughing" });
    await service.drain();

    const spend = service.spend();
    expect(spend.renders).toBe(2);
    expect(spend.ready).toBe(2);
    expect(spend.credits).toBe(1080);
    expect(spend.usd).toBeCloseTo(10.8, 5);
    expect(spend.seconds).toBe(30);
  });

  it("should count a failed render as spent, because Runway charges for it", async () => {
    // `RUNWAY_API_INDEX.md`: moderated generations still cost full credits, no
    // refund. A ledger that only counted the good ones would understate what
    // she has actually spent, which is the direction that matters.
    const service = serviceWith(
      fakeBackend({ statuses: [{ id: "t", status: "FAILED", output: [] }] }),
    );

    await service.start(ASK);
    await service.drain();

    const spend = service.spend();
    expect(spend.renders).toBe(1);
    expect(spend.failed).toBe(1);
    expect(spend.credits).toBe(540);
  });

  it("should start at nothing on a machine that has never rendered", () => {
    const spend = serviceWith(fakeBackend()).spend();

    expect(spend.renders).toBe(0);
    expect(spend.credits).toBe(0);
    expect(spend.usd).toBe(0);
  });

  it("should not count the eight loops he made, which have no record of what they cost", async () => {
    // `syl-loop-*.mp4` predate the sidecar and sit in the same directory. They
    // are not hers and there is no honest number to attach to them, so the
    // ledger simply does not see them — it reads records, not files.
    mkdirSync(studio.videoDir, { recursive: true });
    writeFileSync(join(studio.videoDir, "syl-loop-1-emerge.mp4"), Buffer.alloc(16));

    expect(serviceWith(fakeBackend()).spend().renders).toBe(0);
  });
});

describe("a render interrupted by a restart", () => {
  it("should be picked up again rather than left saying `rendering` forever", async () => {
    const first = new RenderService({
      studio,
      backend: fakeBackend({ statuses: [{ id: "t", status: "PENDING", output: [] }] }),
      clock: fixedClock(NOW),
      // The process dies mid-poll: the follower parks and never writes again,
      // which is exactly what a `SIGTERM` between two polls looks like on disk.
      sleep: () => new Promise<void>(() => undefined),
    });
    const started = await first.start(ASK);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // The process goes away mid-poll. The sidecar is all that survives, and it
    // holds the task id — which `generate.mjs` keeps for exactly this reason:
    // it is the only handle Runway will accept for chasing a render up later.
    expect(first.get(started.record.name)?.status).toBe("rendering");

    const second = serviceWith(fakeBackend());
    second.resume();
    await second.drain();

    expect(second.get(started.record.name)?.status).toBe("ready");
  });
});

describe("naming a render", () => {
  it("should give two renders in the same second different names and different files", async () => {
    // The clock is frozen here, which is the worst case and the realistic one:
    // she can ask twice in a turn. A collision would have the second render
    // overwrite the first one's video and its record.
    const service = serviceWith(fakeBackend());

    const one = await service.start(ASK);
    const two = await service.start({ ...ASK, scene: "she folds herself small and vanishes" });

    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.record.name).not.toBe(two.record.name);

    await service.drain();
    expect(service.list().length).toBe(2);
  });

  it("should keep the names path-safe, since they address a file and a route", async () => {
    const service = serviceWith(fakeBackend());
    const started = await service.start({ ...ASK, scene: "../../etc/passwd, she says, drily" });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.record.name).toMatch(/^[a-z0-9][a-z0-9-]*$/u);
  });

  it("should answer nothing for a name that is not a render, without touching the disk", () => {
    const service = serviceWith(fakeBackend());

    expect(service.get("../../../etc/passwd")).toBeNull();
    expect(service.get("")).toBeNull();
  });

  it("should know which render is the most recent, so `latest` means something", async () => {
    const service = serviceWith(fakeBackend());

    const one = await service.start(ASK);
    await service.drain();
    const two = await service.start({ ...ASK, scene: "she looks straight back at me" });
    await service.drain();

    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(service.latest()?.name).toBe(two.record.name);
  });
});
