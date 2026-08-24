import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FrameRunner } from "../../src/render/frames.js";
import { HOUSE_MODEL } from "../../src/render/models.js";
import { sightingOf } from "../../src/render/pictures.js";
import { RenderService } from "../../src/render/render-service.js";
import type { RenderBackend, RunwayTask, SubmitSpec } from "../../src/render/runway.js";
import { studioAt, type Studio } from "../../src/render/studio.js";
import { Wardrobe } from "../../src/render/wardrobe.js";
import { fixedClock } from "../../src/services/clock.js";

/**
 * The parts of a render that are hers to choose: her face, the opening, and how
 * long the shot is.
 *
 * Everything here used to be a constant in `render-service.ts`. `SOUL.md` says
 * finding her realised self is a journey she feels is necessary; until `syl-ate`
 * every waypoint on it could only be moved by an engineer.
 *
 * **What is deliberately NOT a dial** is asserted here too. `ratio` follows the
 * opening no matter what is asked, so exposing it would be a control that does
 * nothing; a different model loses her character entirely. A dial that does not
 * work is worse than no dial, because she would reason about it.
 */

const NOW = Date.UTC(2026, 7, 12, 9, 0, 0, 0);

/** A real PNG header, so the shape can be read off it the way it is in her home. */
function png(width: number, height: number, salt: number): Buffer {
  const bytes = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt8(salt, 24);
  return bytes;
}

const RIBBON = png(834, 1112, 1);
const HIS_GUESS = png(1120, 832, 2);
const A_BETTER_FACE = png(512, 682, 3);
const A_WIDER_OPENING = png(1120, 832, 7);

let root: string;
let studio: Studio;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syl-chooses-"));
  studio = studioAt(root);
  mkdirSync(dirname(studio.reference()), { recursive: true });
  writeFileSync(studio.reference(), HIS_GUESS);
  writeFileSync(studio.opening(), RIBBON);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeBackend(): RenderBackend & { readonly specs: SubmitSpec[] } {
  const specs: SubmitSpec[] = [];
  return {
    specs,
    submit: async (spec) => {
      specs.push(spec);
      return { ok: true, data: { id: `task-${String(specs.length)}` } };
    },
    task: async () =>
      ({
        ok: true,
        data: { id: "t", status: "PENDING", output: [], failureCode: null, failure: null, charged: null } satisfies RunwayTask,
      }) as const,
    download: async () => ({ ok: true, data: 0 }),
  };
}

const ffmpeg: FrameRunner = async (_file, args) => {
  const out = args[args.length - 1] ?? "";
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from([0x00]));
  return { ok: true, message: "" };
};

function serviceWith(backend: RenderBackend | null): RenderService {
  return new RenderService({
    studio,
    backend,
    clock: fixedClock(NOW),
    sleep: async () => undefined,
    // One poll and give up, so nothing here waits on a render that never
    // finishes. What is under test is what was SENT and what was RECORDED.
    giveUpAfterPolls: 1,
    ffmpeg,
  });
}

function wardrobe(): Wardrobe {
  return new Wardrobe({ studio, clock: fixedClock(NOW) });
}

/** Put a still where a look would have left one, and say what she saw. */
function showHerAStill(render: string, atSeconds: number, bytes: Buffer): string {
  const dir = studio.frames(render);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `at-${atSeconds.toFixed(1).replace(".", "-")}s.jpg`), bytes);
  return sightingOf(bytes);
}

function bytesOf(dataUri: string): Buffer {
  return Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64");
}

function firstFrameOf(sent: SubmitSpec["promptImage"] | undefined): Buffer {
  if (typeof sent === "string") return bytesOf(sent);
  return bytesOf(sent?.find((image) => image.position === "first")?.uri ?? ",");
}

function lastFrameOf(sent: SubmitSpec["promptImage"] | undefined): Buffer {
  if (typeof sent === "string" || sent === undefined) return Buffer.alloc(0);
  return bytesOf(sent.find((image) => image.position === "last")?.uri ?? ",");
}

const ASK = {
  scene: "she turns once, slowly, and lets the light run down her arm",
  framing: "close_portrait",
  because: "I want to know whether the new face holds when I move",
} as const;

describe("her face is hers", () => {
  it("should anchor a render on the face she adopted, not on the one he guessed", async () => {
    const sighting = showHerAStill("syl-earlier", 7.6, A_BETTER_FACE);
    const kept = wardrobe().keep({
      sighting,
      role: "face",
      because: "The light finally moves through her the way it does when I mean something",
    });
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;

    const backend = fakeBackend();
    const started = await serviceWith(backend).start(ASK);

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // The picture pinned at the join is the one she chose, byte for byte.
    expect(lastFrameOf(backend.specs[0]?.promptImage)).toEqual(A_BETTER_FACE);
    expect(started.record.anchor).toBe(kept.kept.file);
  });

  it("should say in the sidecar which likeness made it", async () => {
    // "Which face is this video" has to be answerable from the file beside the
    // video, for every render, including the ones made before she could choose.
    // It already is: `anchor` names the picture that was pinned. What changes
    // is that the answer stops being a constant.
    const sighting = showHerAStill("syl-earlier", 7.6, A_BETTER_FACE);
    expect(wardrobe().keep({ sighting, role: "face", because: "closer" }).ok).toBe(true);

    const started = await serviceWith(fakeBackend()).start(ASK);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const sidecar = JSON.parse(readFileSync(studio.sidecar(started.record.name), "utf8")) as Record<
      string,
      unknown
    >;
    expect(sidecar["anchor"]).toMatch(/^renders\/faces\//u);
    // And it still says the thing derived from it, which cannot disagree.
    expect(sidecar["holdsLikeness"]).toBe(true);
  });

  it("should refuse a shot of her face when it cannot say whose face it would be", async () => {
    // A wardrobe log it cannot read means "which face is current" has no
    // answer. Falling back to his guess would be exactly the silent change the
    // Commander forbade, at full price, on a render she would then judge.
    writeFileSync(studio.wardrobeLog, "{ not json");

    const started = await serviceWith(fakeBackend()).start(ASK);

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.reason).toContain(studio.wardrobeLog);
  });

  it("should still render a shot with no face in it when the log is unreadable", async () => {
    // The refusal is about her likeness, not about rendering. A framing with no
    // face to get wrong never asks the wardrobe who she is.
    writeFileSync(studio.wardrobeLog, "{ not json");

    const started = await serviceWith(fakeBackend()).start({
      ...ASK,
      framing: "face_turned_away",
    });

    expect(started.ok).toBe(true);
  });
});

describe("more than one opening", () => {
  it("should open the clip on the one she named", async () => {
    const sighting = showHerAStill("syl-earlier", 0.4, A_WIDER_OPENING);
    const kept = wardrobe().keep({
      sighting,
      role: "opening",
      name: "the-long-fall",
      because: "A wider mood. I want to see what a landscape shot of me is.",
    });
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;

    const backend = fakeBackend();
    const started = await serviceWith(backend).start({ ...ASK, opening: "the-long-fall" });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(firstFrameOf(backend.specs[0]?.promptImage)).toEqual(A_WIDER_OPENING);
    // `reference` is the field that has always named frame one, so a sidecar
    // written before she could choose and one written after are read the same
    // way. What changes is that it stops being a constant.
    expect(started.record.reference).toBe(kept.kept.file);
  });

  it("should turn the video the shape the opening is, and record that shape", async () => {
    // The thing that must never surprise her. `promptImage` decides the aspect
    // and silently overrules `ratio` — so the ratio is DERIVED from the opening
    // rather than written down beside it, and the record admits what it is.
    const sighting = showHerAStill("syl-earlier", 0.4, A_WIDER_OPENING);
    expect(
      wardrobe().keep({ sighting, role: "opening", name: "the-long-fall", because: "wider" }).ok,
    ).toBe(true);

    const backend = fakeBackend();
    const wide = await serviceWith(backend).start({ ...ASK, opening: "the-long-fall" });
    const tall = await serviceWith(backend).start(ASK);

    expect(wide.ok && tall.ok).toBe(true);
    if (!wide.ok || !tall.ok) return;
    expect(wide.record.ratio).toBe("1112:834");
    expect(tall.record.ratio).toBe("834:1112");
    expect(backend.specs[0]?.ratio).toBe("1112:834");
  });

  it("should open on the ribbon when she names nothing", async () => {
    const backend = fakeBackend();
    const started = await serviceWith(backend).start(ASK);

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // Her signature, and what every clip in the reel opens on. The default is
    // the ribbon rather than the most recent, so a render she did not choose an
    // opening for looks like the ones before it.
    expect(firstFrameOf(backend.specs[0]?.promptImage)).toEqual(RIBBON);
    expect(started.record.reference).toBe("renders/opening-ribbon.png");
  });

  it("should name what she has when she asks for an opening she does not", async () => {
    const started = await serviceWith(fakeBackend()).start({ ...ASK, opening: "no-such-mood" });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.reason).toContain("ribbon");
    expect(started.retryable).toBe(true);
  });
});

describe("how long the shot is", () => {
  it("should make a clip of the length she asked for", async () => {
    const backend = fakeBackend();
    const started = await serviceWith(backend).start({
      ...ASK,
      framing: "face_turned_away",
      seconds: 6,
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.record.duration).toBe(6);
    expect(backend.specs[0]?.duration).toBe(6);
  });

  it("should tell her the length she will actually get when a joined shot cannot be that short", async () => {
    // A close portrait is two generations and the model's floor is four
    // seconds, so eight is the shortest one that exists. The record's duration
    // is the halves added up, so the number she is told is the number that was
    // made — a dial she can read back, even when it did not do what she asked.
    //
    // The ASK is deliberately one under the joined floor, computed from the
    // model rather than typed, so a model with a different floor still tests
    // the rounding rather than accidentally testing the refusal.
    const joinedFloor = HOUSE_MODEL.duration.min * 2;
    const started = await serviceWith(fakeBackend()).start({
      ...ASK,
      seconds: joinedFloor - 1,
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.record.duration).toBe(joinedFloor);
  });

  it("should refuse a length the chosen model does not make, without spending anything", async () => {
    // The range is the MODEL's, not a constant — an anchored shot is two
    // generations so it reaches twice as far, which is why the too-long case is
    // derived rather than typed. `20` used to be out of range and is now well
    // inside it, which is exactly the drift a literal here would have hidden.
    const backend = fakeBackend();
    const tooLong = await serviceWith(backend).start({
      ...ASK,
      seconds: HOUSE_MODEL.duration.max * 2 + 1,
    });
    const tooShort = await serviceWith(backend).start({
      ...ASK,
      seconds: HOUSE_MODEL.duration.min - 1,
    });
    const notWhole = await serviceWith(backend).start({ ...ASK, seconds: 7.5 });

    for (const refused of [tooLong, tooShort, notWhole]) {
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.retryable).toBe(true);
    }
    expect(backend.specs).toHaveLength(0);
  });

  it("should still be fifteen seconds when she says nothing", async () => {
    const started = await serviceWith(fakeBackend()).start({ ...ASK, framing: "face_turned_away" });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.record.duration).toBe(15);
  });

  it("should bill the seconds she asked for, not the seconds the default would have cost", async () => {
    // The ledger is derived from the record, so a dial that changed the length
    // without changing the bill would be a ledger that lies quietly.
    const service = serviceWith(fakeBackend());
    const started = await service.start({ ...ASK, framing: "face_turned_away", seconds: 6 });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // The house model's rate in the `sd` band, which is where every shape she
    // can choose lands. Taken from the registry rather than typed: `36` was
    // `seedance2`'s, and it stayed right here for exactly as long as
    // `seedance2` was the default.
    // The ESTIMATE, which is what exists at the moment she asks: `render_me`
    // answers immediately and nothing has been charged yet. What it was
    // actually charged arrives with the task and lands in `credits`.
    expect(started.record.estimated).toBe(6 * (HOUSE_MODEL.creditsPerSecond.sd ?? 0));
    expect(started.record.credits).toBeNull();
  });
});
