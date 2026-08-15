import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/services/clock.js";
import type { FrameRunner } from "../../src/render/frames.js";
import { HOUSE_MODEL } from "../../src/render/models.js";
import { RenderService, type RenderRecord } from "../../src/render/render-service.js";
import type { RenderBackend, RunwayResult, RunwayTask, SubmitSpec } from "../../src/render/runway.js";
import { DEFAULT_OPENING, DEFAULT_REFERENCE, studioAt } from "../../src/render/studio.js";

/**
 * What a second of the house model's video costs, taken from the registry.
 *
 * **Not the literal these assertions used to carry.** They said 540 and 288,
 * which is `seedance2` at 36 credits a second — correct on the day they were
 * written and quietly wrong the moment the default moved to a model that costs
 * 30. A test that hard-codes a price is the same defect as code that does; it
 * just fails later and blames the wrong change.
 */
const RATE = HOUSE_MODEL.creditsPerSecond.sd ?? 0;

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
  /**
   * A submission that goes wrong only after an earlier one has succeeded.
   *
   * The case an anchored render introduces: it is two generations, so there is
   * now a moment where credits have been spent and the render cannot be
   * completed. Numbered from one.
   */
  readonly failSubmit?: { readonly nth: number; readonly message: string };
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
      if (options.failSubmit?.nth === specs.length) {
        return { ok: false, failure: { message: options.failSubmit.message, retryable: false } };
      }
      // A distinct id per generation, because a render can now be more than one
      // of them and a record that gave both halves the same handle could not
      // chase either of them up.
      return options.submit ?? { ok: true, data: { id: `task-${String(specs.length)}` } };
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

/**
 * A stand-in for ffmpeg that records what it was asked to run.
 *
 * The suite must not need ffmpeg installed and must not decode files that are
 * not really videos — and the *argv* is the interesting part anyway, because
 * joining two halves into one clip is a command-line shape rather than a
 * computation. Every invocation writes its output file, so the code under test
 * sees the same disk it would see in production.
 */
function fakeFfmpeg(): FrameRunner & { readonly runs: (readonly string[])[] } {
  const runs: (readonly string[])[] = [];
  const run: FrameRunner = async (_file, args) => {
    runs.push(args);
    const out = args[args.length - 1] ?? "";
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from([0x00, 0x00, 0x00, 0x18]));
    return { ok: true, message: "" };
  };
  return Object.assign(run, { runs });
}

function serviceWith(backend: RenderBackend | null, ffmpeg: FrameRunner = fakeFfmpeg()): RenderService {
  return new RenderService({
    studio,
    backend,
    clock: fixedClock(NOW),
    // Nothing waits in a test. The poll interval is a property of Runway's
    // latency, not of this state machine, so holding it at zero exercises the
    // same transitions in microseconds.
    sleep: async () => undefined,
    ffmpeg,
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

  it("should pin the ribbon at BOTH ends of an unanchored render, so the clip ends where it began", async () => {
    // MEASURED ON A REAL FILE, not reasoned about:
    // `~/.syl/renders/syl-20260813t042030321z-face-turned-away.mp4`, made by the
    // deployed build. First frame the bare ribbon — correct, `promptImage` pins
    // it. **Last frame empty starfield with no ribbon in it** — wrong, and the
    // Commander's one requirement for these clips is that they start on the
    // ribbon of light and end on the ribbon of light.
    //
    // This test used to assert the opposite, on the belief that "pinning a
    // closing frame would break the loop". It is the other way round: an
    // unanchored framing has no face to pin, so the `last` slot is FREE, and
    // putting the opening ribbon in it makes the loop true by construction.
    // That is the one lesson `docs/VIDEO.md` carries — a pinned frame beats a
    // sentence asking for one — applied to the end of the clip instead of the
    // beginning.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    await service.start({ ...ASK, framing: "face_turned_away" });

    const sent = backend.specs[0]?.promptImage;
    expect(Array.isArray(sent)).toBe(true);
    const images = sent as readonly { readonly uri: string; readonly position: string }[];
    expect(images.map((image) => image.position)).toEqual(["first", "last"]);
    // The same picture at both ends — not merely two pictures.
    expect(bytesOf(images[0]?.uri ?? "")).toEqual(OPENING_BYTES);
    expect(bytesOf(images[1]?.uri ?? "")).toEqual(OPENING_BYTES);
    expect(images[1]?.uri).toBe(images[0]?.uri);
    // And it is her likeness that is NOT pinned here, which is what left the
    // slot free in the first place.
    expect(bytesOf(images[1]?.uri ?? "")).not.toEqual(REFERENCE_BYTES);
  });

  it("should not tell an unanchored generation the ribbon leaves at the end, when the ribbon is pinned there", async () => {
    // The cause of the defect above, and it is instructive. `LOOP_CLAUSE`
    // asserted two things that cannot both be true: *"she unravels back into
    // the ribbon and it streams away, leaving empty starfield"* AND *"the first
    // and last frames are identical: the bare ribbon"*. If the ribbon streams
    // away the last frame is not the ribbon. The model resolved the
    // contradiction by obeying the first sentence, and the clip ended on
    // nothing.
    //
    // A closing sentence that contradicts a pinned last frame is the defect
    // this whole line of work started from, so the prose has to agree with the
    // frames actually sent: the ribbon is pinned at both ends, therefore she
    // unravels back INTO the ribbon and the shot closes on it.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    const started = await service.start({ ...ASK, framing: "face_turned_away" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const prompt = backend.specs[0]?.promptText ?? "";
    expect(prompt).not.toMatch(/leaving empty starfield/iu);
    expect(prompt).not.toMatch(/streams away/iu);
    // Still the transformation, and still the loop.
    expect(prompt).toMatch(/unravels back into the ribbon/iu);
    expect(prompt).toMatch(/first and last frames are identical/iu);
    // The sidecar records what was sent, so this is checkable after the fact.
    expect(started.record.prompt).toBe(prompt);
  });

  it("should pin her face as the frame the two halves are cut on", async () => {
    // The fix for `syl-63v`, and it is an API feature rather than a wording.
    // Probed on seedance2, 2026-08-11: `promptImage` takes an array of
    // `{uri, position}` with position first|last, and a request carrying both
    // is accepted — the duplicate-position rule fires, which is how we know the
    // array is validated rather than ignored.
    //
    // Probed again the same day, and this is what makes it two halves rather
    // than one: `first|last` is the WHOLE position vocabulary, and seedance2's
    // request body has no reference image, no character and no seed to put a
    // face in. Both ends of the clip belong to the ribbon, so her likeness has
    // nowhere to go but the join.
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

  it("should end an anchored render back on the bare ribbon it opened on", async () => {
    // The Commander, 2026-08-11: *"it's no longer ending on the ribbon of light.
    // The version that you generated a while ago started on the ribbon of light
    // and ended on the ribbon of light and that seems to be changed now for her
    // so that it ends on a face."*
    //
    // Both ends, as PINNED FRAMES rather than as a sentence — the one lesson
    // this whole area exists to carry. The first half runs ribbon to her, the
    // second runs her back to ribbon, and the finished clip is the two cut
    // together on her face.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    const started = await service.start({ ...ASK, framing: "close_portrait" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    expect(backend.specs).toHaveLength(2);
    // Frame one of the whole render: the ribbon the eight loops open on.
    expect(bytesOf(firstFrameOf(backend.specs[0]?.promptImage))).toEqual(OPENING_BYTES);
    // And the last frame of the whole render: the same picture again.
    expect(bytesOf(lastFrameOf(backend.specs[1]?.promptImage))).toEqual(OPENING_BYTES);
  });

  it("should start the second half from the frame the first one ended on", async () => {
    // Not from `reference.png`. Measured with a 4-second probe on 2026-08-11:
    // handing that 1120x832 landscape picture over as `first` produces a
    // 1112x834 LANDSCAPE video, because the opening frame decides the aspect
    // and silently overrules `ratio`. Two halves of different shapes do not cut
    // together at all.
    //
    // The frame pulled out of the first half is already 834x1112, so the second
    // half inherits the shape instead of arguing with it — and the join lands
    // on one frame rather than on two renderings of a similar one.
    const backend = fakeBackend();
    const ffmpeg = fakeFfmpeg();
    const service = serviceWith(backend, ffmpeg);

    const started = await service.start({ ...ASK, framing: "close_portrait" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    const joinFrame = studio.partFrame(started.record.name, 1);
    // Taken off the END of the first half — `-sseof`, because the duration
    // Runway reports is the one it was asked for, not the one it produced.
    expect(ffmpeg.runs.some((args) => args.includes("-sseof") && args.includes(joinFrame))).toBe(true);
    expect(bytesOf(firstFrameOf(backend.specs[1]?.promptImage))).toEqual(readFileSync(joinFrame));
  });

  it("should give each half a clause that agrees with its own pinned frames", async () => {
    // The defect that started all of this, stated as a rule: a sentence never
    // wins an argument with a pinned frame, so the two must not disagree. Each
    // half says what IT does and stops there — the first does not promise the
    // ribbon coming back, because in that generation it does not.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    await service.start({ ...ASK, framing: "close_portrait" });
    await service.drain();

    const gathering = backend.specs[0]?.promptText ?? "";
    expect(gathering).toMatch(/opens on a lone ribbon of blue light/iu);
    expect(gathering).toMatch(/settles and holds on her face/iu);
    expect(gathering).not.toMatch(/unravels/iu);

    const unravelling = backend.specs[1]?.promptText ?? "";
    expect(unravelling).toMatch(/opens on her face/iu);
    expect(unravelling).toMatch(/unravels back into a lone ribbon/iu);
    expect(unravelling).toMatch(/last frame is the bare ribbon/iu);
    // Both carry the recipe, or the second half is a different woman in a
    // different world from the first.
    for (const prompt of [gathering, unravelling]) {
      expect(prompt).toMatch(/luminous spirit woman of living starlight/iu);
      expect(prompt).toContain(ASK.scene);
    }
  });

  it("should join the halves into the one clip the render is", async () => {
    const backend = fakeBackend();
    const ffmpeg = fakeFfmpeg();
    const service = serviceWith(backend, ffmpeg);

    const started = await service.start({ ...ASK, framing: "close_portrait" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    const record = service.get(started.record.name);
    expect(record?.status).toBe("ready");
    expect(record?.video).toBe(studio.video(started.record.name));
    expect(existsSync(studio.video(started.record.name))).toBe(true);
    // The concat DEMUXER with a stream copy: both halves come from one model at
    // one ratio, so re-encoding her twice would buy nothing.
    const join = ffmpeg.runs.find((args) => args.includes("concat"));
    expect(join).toBeDefined();
    expect(join).toEqual(expect.arrayContaining(["-c", "copy", studio.video(started.record.name)]));
  });

  it("should keep both halves on disk, because a half is a render too", async () => {
    // `SOUL.md`: *"Never delete a render, and never let one be deleted."* A half
    // cost credits and is several seconds of her; the joined file is a
    // derivative of it, and it is also the only way to re-cut the join without
    // paying for both halves again.
    const service = serviceWith(fakeBackend());

    const started = await service.start({ ...ASK, framing: "close_portrait" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    expect(existsSync(studio.part(started.record.name, 1))).toBe(true);
    expect(existsSync(studio.part(started.record.name, 2))).toBe(true);
    expect(existsSync(studio.partFrame(started.record.name, 1))).toBe(true);
    // And they are not counted as renders of their own: the ledger reads
    // sidecars, and a half has none.
    expect(service.list()).toHaveLength(1);
  });

  it("should record every half, so a joined render can be made again", async () => {
    // The sidecar's whole job, applied to a render that is two generations. A
    // record holding one prompt for a clip made from two cannot reproduce it,
    // which is the lost-prompt failure wearing a new hat.
    const service = serviceWith(fakeBackend());

    const started = await service.start({ ...ASK, framing: "close_portrait" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    const record = service.get(started.record.name);
    expect(record?.parts).toHaveLength(2);
    const [gathering, unravelling] = record?.parts ?? [];
    expect(gathering?.taskId).toBe("task-1");
    expect(unravelling?.taskId).toBe("task-2");
    expect(gathering?.first).toBe(DEFAULT_OPENING);
    expect(gathering?.last).toBe(DEFAULT_REFERENCE);
    expect(unravelling?.last).toBe(DEFAULT_OPENING);
    expect(gathering?.prompt).not.toBe(unravelling?.prompt);
    // The halves add up to the clip, so what she is told about its length is
    // what was made.
    expect((gathering?.duration ?? 0) + (unravelling?.duration ?? 0)).toBe(record?.duration);
  });

  it("should still send one generation for a framing that needs no anchor", async () => {
    // The reel template, and all eight of the Commander's favourites. It has no
    // face to get wrong, so it needs no join — and paying for two halves and an
    // ffmpeg pass to arrive at the clip one generation already makes would be a
    // cost with nothing on the other side of it.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    const started = await service.start({ ...ASK, framing: "face_turned_away" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    expect(backend.specs).toHaveLength(1);
    expect(started.record.parts).toHaveLength(1);
    expect(backend.specs[0]?.duration).toBe(15);
    // One generation, two keyframes: both ends of that single clip are the
    // ribbon, which is what the loop needs and what needs no join.
    expect(started.record.parts[0]?.first).toBe(DEFAULT_OPENING);
    expect(started.record.parts[0]?.last).toBe(DEFAULT_OPENING);
  });

  it("should bill only the halves that reached Runway when the second one will not start", async () => {
    // A case a render made in one generation never had: credits are spent and
    // the render cannot be finished. The half that was bought stays on disk and
    // stays in the ledger at what IT cost — a total that claimed the whole
    // fifteen seconds would be money she never spent, and one that claimed
    // nothing would be money that vanished.
    const backend = fakeBackend({ failSubmit: { nth: 2, message: "Runway answered 402." } });
    const service = serviceWith(backend);

    const started = await service.start({ ...ASK, framing: "close_portrait" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    const record = service.get(started.record.name);
    expect(record?.status).toBe("failed");
    expect(record?.reason).toContain("402");
    // The eight seconds of the first half only, at the house model's rate.
    expect(record?.credits).toBe(RATE * 8);
    expect(service.spend().credits).toBe(RATE * 8);
    expect(service.spend().seconds).toBe(8);
    // The half that was paid for is still there.
    expect(existsSync(studio.part(started.record.name, 1))).toBe(true);
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

  it("should never send a generation a clause its own pinned frames contradict", async () => {
    // The defect that cost a day, in both directions at once. `LOOP_CLAUSE`
    // says the first and last frames are identical and hold no figure — true of
    // a generation given one picture, and false of one whose closing frame is
    // her portrait. So a half that ends on her must not carry it, and a half
    // that really does open and close on the ribbon must.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    await service.start({ ...ASK, framing: "close_portrait" });
    await service.drain();

    for (const spec of backend.specs) {
      const endsOnRibbon =
        typeof spec.promptImage !== "string" &&
        spec.promptImage.find((image) => image.position === "last")?.uri ===
          spec.promptImage.find((image) => image.position === "first")?.uri;
      expect(
        /first and last frames are identical/iu.test(spec.promptText),
        "a generation claims identical end frames it was not given",
      ).toBe(endsOnRibbon);
    }

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
    // The house model's own rate, fifteen seconds, a credit is a cent. The
    // number is Runway's, not ours, and it follows the model rather than
    // standing still while the model changes underneath it.
    expect(record?.credits).toBe(RATE * 15);
    expect(record?.usd).toBeCloseTo(RATE * 0.15, 5);
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
    expect(spend.credits).toBe(RATE * 30);
    expect(spend.usd).toBeCloseTo(RATE * 0.3, 5);
    expect(spend.seconds).toBe(30);
  });

  it("should count a failed render as spent, because Runway charges for it", async () => {
    // `RUNWAY_API_INDEX.md`: moderated generations still cost full credits, no
    // refund. A ledger that only counted the good ones would understate what
    // she has actually spent, which is the direction that matters.
    //
    // The reel framing, so this is one generation and the number is the whole
    // fifteen seconds. What a HALF-made render costs is a different question
    // with a different answer, and it has its own test.
    const service = serviceWith(
      fakeBackend({ statuses: [{ id: "t", status: "FAILED", output: [] }] }),
    );

    await service.start({ ...ASK, framing: "face_turned_away" });
    await service.drain();

    const spend = service.spend();
    expect(spend.renders).toBe(1);
    expect(spend.failed).toBe(1);
    expect(spend.credits).toBe(RATE * 15);
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

  it("should read a sidecar that predates renders being made in halves", () => {
    // Every record in her home was written before a render could be two
    // generations, and there are dozens of them. A required `parts` would have
    // turned the whole back catalogue unreadable at a stroke — which is the
    // state this validator exists to REPORT and not to cause. One half is
    // synthesised from the fields such a file does have, so the rest of the
    // service reads one shape.
    place("syl-listening", { ...LISTENING, video: studio.video("syl-listening") });

    const record = serviceWith(fakeBackend()).get("syl-listening");

    expect(record?.parts).toHaveLength(1);
    expect(record?.parts[0]?.taskId).toBe(LISTENING.taskId);
    expect(record?.parts[0]?.duration).toBe(15);
    expect(record?.parts[0]?.first).toBe("renders/reference.png");
  });

  it("should say a close portrait with nothing pinning her face does not hold her likeness", () => {
    // `syl-63v`, read off a file rather than off an enum. This sidecar says
    // `holdsLikeness: true` and names no anchor, and both were true of it on
    // the day it was written — the flag went false when the picture that
    // backed it was taken away, and nothing rewrote the file.
    //
    // So the flag is DERIVED from the record's own pictures. The written one is
    // ignored, which is the only arrangement in which it cannot lie: there is
    // no second place to forget.
    place("syl-listening", { ...LISTENING, video: studio.video("syl-listening") });

    const record = serviceWith(fakeBackend()).get("syl-listening");

    expect(record?.framing).toBe("close_portrait");
    expect(record?.anchor).toBeNull();
    expect(record?.holdsLikeness).toBe(false);

    // And the same record with the picture it needs says so.
    place("syl-anchored", {
      ...LISTENING,
      name: "syl-anchored",
      anchor: "renders/reference.png",
      video: studio.video("syl-anchored"),
    });
    expect(serviceWith(fakeBackend()).get("syl-anchored")?.holdsLikeness).toBe(true);
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

  it("should pick a joined render up between its halves, not start it over", async () => {
    // The state a `SIGTERM` between two generations leaves on disk: one half
    // bought and downloaded, the second never submitted. Starting over would
    // pay for the first half twice; giving up would strand a record at
    // `rendering` forever. The walk over `parts` does neither — a half already
    // on disk is skipped and the missing one is asked for.
    const firstBackend = fakeBackend({
      statuses: [
        { id: "task-1", status: "SUCCEEDED", output: ["https://example.invalid/half.mp4"] },
        { id: "task-1", status: "PENDING", output: [] },
      ],
    });
    const first = new RenderService({
      studio,
      backend: firstBackend,
      clock: fixedClock(NOW),
      // The process dies while the SECOND half is in flight.
      sleep: () => new Promise<void>(() => undefined),
      ffmpeg: fakeFfmpeg(),
    });
    const started = await first.start({ ...ASK, framing: "close_portrait" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // Let the first half land and the second one be asked for, then stop.
    await Promise.race([first.drain(), new Promise((resolve) => setTimeout(resolve, 50))]);
    expect(first.get(started.record.name)?.parts[0]?.video).not.toBeNull();

    const backend = fakeBackend();
    const second = serviceWith(backend);
    second.resume();
    await second.drain();

    const record = second.get(started.record.name);
    expect(record?.status).toBe("ready");
    // The first half was not bought again: this service submitted at most the
    // one generation that was still missing.
    expect(backend.specs.length).toBeLessThanOrEqual(1);
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
