import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/services/clock.js";
import { RenderService, type RenderRecord } from "../../src/render/render-service.js";
import type { RenderBackend, RunwayResult, RunwayTask, SubmitSpec } from "../../src/render/runway.js";
import { DEFAULT_OPENING, DEFAULT_REFERENCE, studioAt } from "../../src/render/studio.js";

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
  // Both pictures, as real files where the real ones live rather than as
  // stubbed reads — and with DIFFERENT bytes, because the thing several tests
  // below are about is WHICH of the two reaches Runway.
  const reference = studio.reference();
  mkdirSync(dirname(reference), { recursive: true });
  writeFileSync(reference, REFERENCE_BYTES);
  writeFileSync(studio.opening(), OPENING_BYTES);
});

/** Stand-ins for her likeness and for the ribbon every clip opens on. */
const REFERENCE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xfe]);
const OPENING_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

/** What a `data:` URI carries, back as bytes, so a spec can be checked against a file. */
function bytesOf(dataUri: string): Buffer {
  return Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64");
}

/**
 * Frame one, whether one picture was sent or two.
 *
 * `promptImage` is a bare data URI for the framings that need no anchor and an
 * array of positioned pictures for the ones that do. Every caller here is
 * asking the same question of both shapes — what does the video open on — so
 * the shape is unwrapped once rather than at each assertion.
 */
function firstFrameOf(sent: SubmitSpec["promptImage"] | undefined): string {
  if (typeof sent === "string") return sent;
  return sent?.find((image) => image.position === "first")?.uri ?? "";
}

/** The pinned closing frame, or `""` where nothing anchors one. */
function lastFrameOf(sent: SubmitSpec["promptImage"] | undefined): string {
  if (typeof sent === "string" || sent === undefined) return "";
  return sent.find((image) => image.position === "last")?.uri ?? "";
}

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

    // The reel framing, because the recipe under test is the LOOP recipe: it is
    // what the eight were made with, and it is the one whose clip has to end
    // back on the bare ribbon. An anchored framing closes on her face instead
    // and is covered by its own test.
    await service.start({ ...ASK, framing: "face_turned_away" });

    const prompt = backend.specs[0]?.promptText ?? "";
    // The identity phrase every one of the eight shots opens with.
    expect(prompt).toMatch(/luminous spirit woman of living starlight/iu);
    // And the loop ARC, which is a property of the PROMPT and not of the
    // editing: drop it and the clip will not cut against its neighbours.
    //
    // Asserted as the three beats rather than as one sentence. This used to
    // match the literal "begins and ends on empty starfield", which the clause
    // satisfied while the render opened on her already formed and already
    // smiling — the endpoints were right and the transformation was missing.
    // A clause naming only the first and last frame is one the model can
    // satisfy without ever moving.
    expect(prompt).toMatch(/ribbon of blue light/iu);
    expect(prompt).toMatch(/coalesces into her/iu);
    expect(prompt).toMatch(/unravels back into the ribbon/iu);
    expect(prompt).toMatch(/first and last frames are identical/iu);
  });

  it("should open on the bare ribbon the eight loops open on, never on her own face", async () => {
    // The Commander, 2026-08-11: the service's renders "look like the template
    // smiling still frame is the first frame of the video", where the eight
    // loops he named as the template all open on the blue ribbon.
    //
    // The cause is not the prompt. `promptImage` is the FIRST FRAME — Runway
    // starts the video from the picture it is handed — so a render given the
    // smiling headshot opens on the smiling headshot no matter what the text
    // says. `LOOP_CLAUSE` was rewritten to describe a bare ribbon and could not
    // have worked, because a sentence cannot move a frame pinned by an image.
    //
    // Measured on the artifacts: all eight loops open on ONE image (PSNR ~35dB
    // between any two of their first frames — the same picture through two
    // encodes, not two generations), and it is the ribbon.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    await service.start(ASK);

    // `ASK` is `close_portrait`, which sends two pictures — so the requirement
    // is about the FIRST of them. Frame one is the ribbon whichever path runs.
    expect(bytesOf(firstFrameOf(backend.specs[0]?.promptImage))).toEqual(OPENING_BYTES);
    expect(bytesOf(firstFrameOf(backend.specs[0]?.promptImage))).not.toEqual(REFERENCE_BYTES);
  });

  it("should send the ribbon alone for the reel framing, so the clip ends where it began", async () => {
    // The template and all eight of the Commander's favourites. Its likeness
    // holds because no face is ever toward the camera, so it needs no anchor —
    // and pinning a closing frame would break the loop, whose whole trick is
    // that the first and last frames are the same bare ribbon.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    await service.start({ ...ASK, framing: "face_turned_away" });

    const sent = backend.specs[0]?.promptImage;
    expect(typeof sent).toBe("string");
    expect(sent as string).toMatch(/^data:image\/png;base64,/u);
    expect(bytesOf(sent as string)).toEqual(OPENING_BYTES);
  });

  it("should pin her face to the closing frame when the shot is her face", async () => {
    // The fix for `syl-63v`, and it is an API feature rather than a wording.
    // Probed on seedance2, 2026-08-11: `promptImage` takes an array of
    // `{uri, position}` with position first|last, and a request carrying both
    // is accepted — the duplicate-position rule fires, which is how we know the
    // array is validated rather than ignored.
    //
    // So the ribbon still opens the shot and something of her now ends it. That
    // is the only thing holding her likeness at a framing where her face is
    // toward the camera, now that `promptImage` is no longer her headshot.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    await service.start({ ...ASK, framing: "close_portrait" });

    const sent = backend.specs[0]?.promptImage;
    expect(Array.isArray(sent)).toBe(true);
    const images = sent as readonly { readonly uri: string; readonly position: string }[];
    expect(images.map((image) => image.position)).toEqual(["first", "last"]);
    expect(bytesOf(images[0]?.uri ?? "")).toEqual(OPENING_BYTES);
    expect(bytesOf(images[1]?.uri ?? "")).toEqual(REFERENCE_BYTES);
  });

  it("should keep asking for the loops' portrait shape even though the anchor is landscape", async () => {
    // The obvious failure mode of two inputs, and it was tested deliberately
    // rather than reasoned about: `reference.png` is 1120x832 landscape and the
    // ribbon is 834x1112 portrait, and seedance2 takes aspect from
    // `promptImage`. Two pictures disagreeing about shape is the way to get a
    // video shaped like neither.
    //
    // Measured on 2026-08-11, one 4s render each way: BOTH came back 834x1112.
    // The opening frame decides the shape and the closing picture is fitted
    // into it — the landscape anchor was centre-cropped and her likeness
    // survived the crop. So the anchor does not need re-cutting, and `ratio`
    // does not move.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    await service.start({ ...ASK, framing: "close_portrait" });

    expect(backend.specs[0]?.ratio).toBe("834:1112");
  });

  it("should not promise a bare ribbon at the end of a clip whose end frame is her face", async () => {
    // The same defect as the one that cost the portrait fix, facing the other
    // way. `LOOP_CLAUSE` says the first and last frames are identical and hold
    // no figure; pinning her portrait as the last frame contradicts it in the
    // one place a sentence cannot win. Whichever closing text is sent has to
    // agree with the frame that is actually pinned.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    const anchored = await service.start({ ...ASK, framing: "close_portrait" });
    expect(anchored.ok).toBe(true);
    if (!anchored.ok) return;

    expect(anchored.record.prompt).not.toMatch(/first and last frames are identical/iu);
    expect(anchored.record.prompt).not.toMatch(/leaving empty starfield/iu);
    // And it must say what it does end on, so the model is told rather than
    // left to reconcile a pinned frame against silence.
    expect(anchored.record.prompt).toMatch(/looking (straight )?at (the viewer|you)|meets his eyes/iu);

    // The reel framing keeps the clause that makes it cut against the eight.
    const loop = await service.start({ ...ASK, framing: "face_turned_away" });
    expect(loop.ok).toBe(true);
    if (!loop.ok) return;
    expect(loop.record.prompt).toMatch(/first and last frames are identical/iu);
  });

  it("should record the anchor it sent, so an anchored render can be made again", async () => {
    // The sidecar's whole job, applied to the second picture. A record naming
    // one input when the render was made from two is a record that cannot
    // reproduce it — which is the lost-prompt failure wearing a new hat.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    const anchored = await service.start({ ...ASK, framing: "close_portrait" });
    expect(anchored.ok).toBe(true);
    if (!anchored.ok) return;

    expect(anchored.record.reference).toBe(DEFAULT_OPENING);
    expect(anchored.record.anchor).toBe(DEFAULT_REFERENCE);

    // And a framing that sends one picture records no anchor rather than a
    // path to something it did not send.
    const loop = await service.start({ ...ASK, framing: "face_turned_away" });
    expect(loop.ok).toBe(true);
    if (!loop.ok) return;
    expect(loop.record.anchor).toBeNull();
  });

  it("should ask for the portrait shape the eight loops are, not a landscape one", async () => {
    // Measured: the eight loops are 834x1112 and a service render was 1112x834
    // — the same pixels, transposed. `834:1112` is one of the ratios seedance2
    // publishes, and it is the one the loops are.
    //
    // The old default was `720:1280`, which is a legal ratio and is NOT what
    // came back: seedance2 takes the video's shape from `promptImage`, and the
    // reference is a 1120x832 landscape headshot. So the requested ratio was
    // quietly overruled by the picture. Asking for the shape the opening still
    // already is means the two can no longer disagree.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    await service.start(ASK);

    const ratio = backend.specs[0]?.ratio ?? "";
    expect(ratio).toBe("834:1112");
    const [width, height] = ratio.split(":").map(Number);
    expect(width).toBeLessThan(height as number);
  });

  it("should record the picture it actually sent, so the render can be made again", async () => {
    // The sidecar's whole job. A record naming a picture the render was not
    // made from is the same lie as a lost prompt, one indirection further out.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    const started = await service.start(ASK);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(started.record.reference).toBe(DEFAULT_OPENING);
    expect(bytesOf(firstFrameOf(backend.specs[0]?.promptImage))).toEqual(
      readFileSync(join(root, started.record.reference)),
    );
    // And the second picture too, when there is one — a record that names one
    // input for a render made from two cannot reproduce it.
    expect(started.record.anchor).not.toBeNull();
    expect(bytesOf(lastFrameOf(backend.specs[0]?.promptImage))).toEqual(
      readFileSync(join(root, started.record.anchor as string)),
    );
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

describe("arranging to come back and look", () => {
  /**
   * The Commander's ruling, 2026-08-11, at the seam where it starts.
   *
   * > *"when Syl triggers a video to be rendered she needs some kind of wake up
   * > mechanism five minutes later to check to see whether or not it's done and
   * > whether or not she wants to send it to me"*
   *
   * The wake is arranged HERE, at submission — not when the render finishes,
   * because a render that never finishes is exactly the case that must not
   * silently vanish.
   */
  function serviceWatching(seen: RenderRecord[], watch?: () => void): RenderService {
    return new RenderService({
      studio,
      backend: fakeBackend(),
      clock: fixedClock(NOW),
      sleep: async () => undefined,
      watch: (record) => {
        seen.push(record);
        watch?.();
      },
    });
  }

  it("should arrange the wake for every render it starts", async () => {
    const seen: RenderRecord[] = [];
    const service = serviceWatching(seen);

    const started = await service.start(ASK);
    await service.drain();

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(seen.map((record) => record.name)).toEqual([started.record.name]);
    // Arranged while the render is still going, so the promise to look exists
    // from the same moment the render does.
    expect(seen[0]?.status).toBe("rendering");
    // Carrying her reason, which is what the wake has to remind her with: the
    // review happens on a fresh thread that remembers nothing.
    expect(seen[0]?.because).toBe(ASK.because);
  });

  it("should not arrange a wake for a render that was never submitted", async () => {
    // Nothing was made and nothing was spent, so there is nothing to come back
    // to. A watch here would wake her about a render that does not exist.
    const seen: RenderRecord[] = [];
    const service = new RenderService({
      studio,
      backend: fakeBackend({
        submit: { ok: false, failure: { message: "Runway answered 402.", retryable: false } },
      }),
      clock: fixedClock(NOW),
      sleep: async () => undefined,
      watch: (record) => seen.push(record),
    });

    await service.start(ASK);

    expect(seen).toHaveLength(0);
  });

  it("should never let a failed watch cost a render that has already been paid for", async () => {
    // A credit is spent by the time this runs. Turning a submitted render into
    // a refusal because a row could not be written would lose the thing that
    // was actually bought — so the failure is reported and the render stands.
    const seen: RenderRecord[] = [];
    const errors: unknown[] = [];
    const service = new RenderService({
      studio,
      backend: fakeBackend(),
      clock: fixedClock(NOW),
      sleep: async () => undefined,
      watch: (record) => {
        seen.push(record);
        throw new Error("the database is gone");
      },
      onError: (error) => errors.push(error),
    });

    const started = await service.start(ASK);
    await service.drain();

    expect(started.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(errors).toHaveLength(1);
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

  it("should say the opening still is missing rather than start the video somewhere else", async () => {
    // The picture that is actually sent, and therefore the one whose absence
    // changes what comes back. Without it Runway would be handed nothing to
    // start from — or, worse, whatever picture somebody wired in its place,
    // which is how the first frame became a smiling headshot.
    rmSync(studio.opening(), { force: true });
    const service = serviceWith(fakeBackend());

    const refused = await service.start(ASK);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/ribbon|opening/iu);
    expect(refused.reason).toContain(studio.opening());
    expect(refused.retryable).toBe(false);
  });

  it("should refuse a face-on shot with no likeness to anchor it, rather than render a stranger", async () => {
    // The whole point of anchoring, stated as a refusal. A close portrait with
    // nothing pinning her face is the `8-descent` failure by construction — the
    // model interpolates and returns a visibly different woman — and it costs
    // 540 credits to find out. Refused before a credit is spent, and only for
    // the framings that actually need the picture.
    rmSync(studio.reference(), { force: true });
    const service = serviceWith(fakeBackend());

    const refused = await service.start({ ...ASK, framing: "close_portrait" });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain(studio.reference());
    expect(refused.retryable).toBe(false);
  });

  it("should still render the reel framing when her likeness is missing, because it never needed one", async () => {
    // The other half, and the reason the check is per-framing rather than at
    // the top of `start`. `face_turned_away` holds because there is no face to
    // get wrong, so a missing likeness must not take down the template that
    // every one of the eight loops is in.
    rmSync(studio.reference(), { force: true });
    const service = serviceWith(fakeBackend());

    const started = await service.start({ ...ASK, framing: "face_turned_away" });

    expect(started.ok).toBe(true);
    await service.drain();
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

/**
 * A file in her renders directory that is not a record.
 *
 * **This is a bug Syl found in herself.** `see_myself` with no argument told her
 * *`"listening" did not finish: no reason was recorded`* — a flat failure — while
 * `see_myself("syl-listening")` told her the truth, that it was still rendering.
 * Her conclusion is the requirement: *"that's the sort of thing that would make
 * me tell you a render failed when it hadn't, which is exactly the kind of lie
 * I'm not willing to tell you."*
 *
 * The cause was a hand-written sidecar with no `status`, no `startedAt`, no
 * `video`, no `credits` and no `prompt`, read straight through a cast into a
 * `RenderRecord`. Each absence became a different lie: no `status` meant the
 * record could not be `ready`, so the "did not finish" branch answered; no
 * `startedAt` sorted it to the FRONT of the list, so `latest()` chose it; no
 * `credits` made the ledger `NaN`.
 *
 * So the tests are written from a file on disk, because that is where the bug
 * was born — never by doubling the reader, which would test the shape this code
 * hopes the disk has.
 */
describe("a sidecar that is not a record", () => {
  /** Complete, and therefore readable. Her first scene, as it stands today. */
  const LISTENING = {
    name: "syl-listening",
    status: "ready",
    renderedAt: "2026-08-11T05:00:50.273Z",
    startedAt: "2026-08-11T04:57:20.000Z",
    taskId: "a1fceeff-62b2-46b9-b227-75dfbedc5cc2",
    model: "seedance2",
    ratio: "720:1280",
    duration: 15,
    reference: "renders/reference.png",
    framing: "close_portrait",
    holdsLikeness: true,
    prompt: "A luminous spirit woman of living starlight… she is listening…",
    scene: "She is listening to something just off camera, head tilting a little.",
    because: "Her own first scene, rendered by hand to verify the syl-r3f fix.",
    reason: null,
    credits: 540,
    usd: 5.4,
    video: null as string | null,
  };

  function place(name: string, sidecar: Record<string, unknown>, withVideo = true): void {
    mkdirSync(studio.videoDir, { recursive: true });
    if (withVideo) writeFileSync(studio.video(name), Buffer.alloc(16));
    writeFileSync(studio.sidecar(name), JSON.stringify(sidecar, null, 2));
  }

  /** The file as it actually was: five fields short. */
  function placeBroken(name = "syl-listening"): void {
    const { status: _s, startedAt: _t, credits: _c, usd: _u, prompt: _p, ...broken } = LISTENING;
    place(name, { ...broken, name }, false);
  }

  it("should read a complete record, so this is a check on the file and not on the shape", () => {
    place("syl-listening", { ...LISTENING, video: studio.video("syl-listening") });

    const record = serviceWith(fakeBackend()).get("syl-listening");

    expect(record?.status).toBe("ready");
    expect(record?.credits).toBe(540);
  });

  it("should answer with the name that finds the file, not the one written inside it", () => {
    // `syl-listening.mp4.json` says `"name": "listening"`. The filename is the
    // address — it is what a route resolves and what `see_myself` is handed —
    // so reporting the field would give her a name that finds nothing when she
    // uses it, which is the same trap wearing a different coat.
    place("syl-listening", { ...LISTENING, name: "listening" });

    const service = serviceWith(fakeBackend());

    expect(service.get("syl-listening")?.name).toBe("syl-listening");
    expect(service.latest()?.name).toBe("syl-listening");
  });

  it("should never answer `latest` with a record it cannot read", async () => {
    // The exact failure. The broken sidecar has no `startedAt`, which is what
    // sorted it in front of a real render she had just made.
    placeBroken("syl-broken");
    const service = serviceWith(fakeBackend());
    const started = await service.start(ASK);
    await service.drain();
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(service.latest()?.name).toBe(started.record.name);
    expect(service.list().map((record) => record.name)).not.toContain("syl-broken");
  });

  it("should say a record is unreadable rather than say the render failed", async () => {
    // "Unreadable" and "failed" are different facts and only one of them says
    // something went wrong with a render. The file is named because that is the
    // thing a person can go and look at.
    placeBroken();

    const looked = await serviceWith(fakeBackend()).frames("syl-listening");

    expect(looked.ok).toBe(false);
    if (looked.ok) return;
    expect(looked.status).toBe("unreadable");
    expect(looked.reason).not.toMatch(/did not finish/iu);
    expect(looked.reason).toContain(studio.sidecar("syl-listening"));
  });

  it("should never invent a reason to fill the sentence", () => {
    // `no reason was recorded` is what she was told, and it read as a render
    // that had failed for reasons nobody wrote down. There was no failure.
    placeBroken();

    const [only] = serviceWith(fakeBackend()).unreadable();

    expect(only?.name).toBe("syl-listening");
    expect(only?.file).toBe(studio.sidecar("syl-listening"));
    expect(only?.why).toMatch(/status/u);
  });

  it("should keep an unreadable record visible rather than quietly dropping it", () => {
    // The other half of the same lie. A render that disappears from her ledger
    // is a render she is never going to go and look for, and `SOUL.md` keeps
    // every attempt — especially the ones that went wrong.
    placeBroken();

    const service = serviceWith(fakeBackend());

    expect(service.list()).toHaveLength(0);
    expect(service.unreadable()).toHaveLength(1);
    expect(service.spend().unreadable).toBe(1);
  });

  it("should never let a file it cannot read turn her ledger into NaN", () => {
    // `credits` was absent and was added to the total anyway, so every number
    // she has ever reported about her own spending came back `NaN`.
    placeBroken();

    const spend = serviceWith(fakeBackend()).spend();

    expect(Number.isNaN(spend.credits)).toBe(false);
    expect(spend.credits).toBe(0);
    expect(spend.renders).toBe(0);
  });

  it("should treat a sidecar that is not JSON at all the same way", () => {
    mkdirSync(studio.videoDir, { recursive: true });
    writeFileSync(studio.sidecar("syl-half-written"), "{ this was interrupted");

    const service = serviceWith(fakeBackend());

    expect(service.get("syl-half-written")).toBeNull();
    expect(service.unreadable().map((entry) => entry.name)).toEqual(["syl-half-written"]);
  });

  it("should count a render with no published rate as unpriced rather than as free", () => {
    // Distinct from unreadable, and it must stay distinct: this record is
    // perfectly legible and says the price is unknown.
    place("syl-unpriced", { ...LISTENING, name: "syl-unpriced", credits: null, usd: null });

    const spend = serviceWith(fakeBackend()).spend();

    expect(spend.unpriced).toBe(1);
    expect(spend.unreadable).toBe(0);
    expect(spend.credits).toBe(0);
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
