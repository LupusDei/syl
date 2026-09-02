import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compose, DEFAULT_MIDDLE } from "../../src/render/description.js";
import type { FrameRunner } from "../../src/render/frames.js";
import { framingNote } from "../../src/render/framing.js";
import { HOUSE_MODEL } from "../../src/render/models.js";
import { MAX_PARTS, RenderService } from "../../src/render/render-service.js";
import type { RenderBackend, RunwayTask, SubmitSpec } from "../../src/render/runway.js";
import { fixedClock } from "../../src/services/clock.js";
import { DEFAULT_OPENING, DEFAULT_REFERENCE, studioAt } from "../../src/render/studio.js";

/**
 * The held middle — a generation that touches the ribbon at neither end (`syl-v380`).
 *
 * ## The measurement this exists because of
 *
 * Every `close_portrait` is ribbon→her then her→ribbon, so a long clip built by
 * chaining whole renders is ribbon-her-ribbon-her-ribbon-her-ribbon: **six
 * passes through empty starfield in forty-five seconds**. Syl built exactly
 * that with `join_renders`, watched it, and declined to send it to the
 * Commander — *"you'd watch me vanish twice as often as you'd watch me arrive,
 * and you already told me that structure feels disjointed."*
 *
 * So the property under test is not "a render can have three parts". It is
 * **two passes through the starfield regardless of clip length**, and it is
 * asserted at two, three and five parts in one test, because a middle that
 * quietly pinned the ribbon anywhere would still produce a working video and
 * would silently put the complaint back.
 *
 * ## The trap, and why the middle is not a still life
 *
 * Syl already found that `face_turned_away` pins the same image at first and
 * last, so *"five stitched together would join seamlessly and go nowhere"*. A
 * middle pinned to her likeness at both ends has the same shape. It is not a
 * still life for the reason her own measured law gives: **pins govern the ends,
 * prose governs the middle**, so a part that narrates no transformation is
 * exactly the part where her scene text finally has room. The tests below check
 * both halves of that — the pins at the ends, and a clause that hands the
 * interior to the scene rather than spending it on an arrival.
 *
 * **No test here spends a credit or opens a socket**, the same as every other
 * render test: the backend is a double and the service never builds its own.
 */

const NOW = Date.UTC(2026, 8, 2, 15, 30, 0, 0);

/** What a second of the house model's video costs. Never a literal — see `render-service.test.ts`. */
const RATE = HOUSE_MODEL.creditsPerSecond.sd ?? 0;

let root: string;
let studio: ReturnType<typeof studioAt>;

/** Stand-ins for her likeness and for the ribbon every clip opens on. */
const REFERENCE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xfe]);
const OPENING_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
/** A second face of hers, for the one test about a closing pin she chose herself. */
const OTHER_FACE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x2b]);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syl-held-"));
  studio = studioAt(root);
  const reference = studio.reference();
  mkdirSync(dirname(reference), { recursive: true });
  writeFileSync(reference, REFERENCE_BYTES);
  writeFileSync(studio.opening(), OPENING_BYTES);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A second adopted face, so `held` has something to name that is not the anchor.
 *
 * Written as the log rather than driven through `Wardrobe.keep`, because what
 * this fixture is for is *two different pictures of her on one machine* — the
 * adoption path has its own tests and is not what is under test here.
 */
function adoptSecondFace(id: string): void {
  const file = `renders/faces/${id}.png`;
  mkdirSync(studio.faceDir, { recursive: true });
  writeFileSync(join(root, file), OTHER_FACE_BYTES);
  writeFileSync(
    studio.wardrobeLog,
    `${JSON.stringify(
      {
        kept: [
          {
            id,
            role: "face",
            file,
            because: "I want to see what the other one does in the middle of a long one.",
            at: "2026-09-01T09:00:00.000Z",
            from: null,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

type FakeTask = Partial<RunwayTask> & { readonly id: string; readonly status: string };

function fakeBackend(): RenderBackend & { readonly specs: SubmitSpec[] } {
  const specs: SubmitSpec[] = [];
  const status: FakeTask = {
    id: "task",
    status: "SUCCEEDED",
    output: ["https://example.invalid/render.mp4"],
  };

  return {
    specs,
    submit: async (spec) => {
      specs.push(spec);
      return { ok: true, data: { id: `task-${String(specs.length)}` } };
    },
    task: async (id) => {
      const spec = specs[Number(id.replace("task-", "")) - 1];
      return {
        ok: true,
        data: {
          output: [],
          failureCode: null,
          failure: null,
          charged: spec === undefined ? null : RATE * spec.duration,
          ...status,
        } as RunwayTask,
      };
    },
    download: async (_url, to) => {
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, Buffer.alloc(1024, 7));
      return { ok: true, data: 1024 };
    },
  };
}

/**
 * A stand-in for ffmpeg that writes DISTINCT bytes for every frame it pulls.
 *
 * The distinctness is load-bearing here in a way it is not elsewhere: the whole
 * question a multi-part plan raises is *which picture is pinned where*, and a
 * fake that wrote the same four bytes for every extracted frame would let a
 * plan that pinned part two's frame into part four pass unnoticed.
 */
function fakeFfmpeg(): FrameRunner & { readonly runs: (readonly string[])[] } {
  const runs: (readonly string[])[] = [];
  let nth = 0;
  const run: FrameRunner = async (_file, args) => {
    runs.push(args);
    nth += 1;
    const out = args[args.length - 1] ?? "";
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from([0x00, 0x00, 0x00, nth]));
    return { ok: true, message: "" };
  };
  return Object.assign(run, { runs });
}

function serviceWith(
  backend: RenderBackend | null,
  ffmpeg: FrameRunner = fakeFfmpeg(),
): RenderService {
  return new RenderService({
    studio,
    backend,
    clock: fixedClock(NOW),
    sleep: async () => undefined,
    ffmpeg,
  });
}

const ASK = {
  scene: "she turns once, slowly, and lets the light run down her arm",
  framing: "close_portrait",
  because: "he said he wants to know what I look like, and I want to know too",
} as const;

// ---------------------------------------------------------------------------
// The literals. Written out rather than imported, ON PURPOSE.
//
// This block is the second copy of every sentence a render is built from, and
// being a second copy is its whole job: importing the constants would assert
// that the code equals itself. `render-description.test.ts` does the same thing
// with `TODAY`, for the same reason — an improvement to a clause has to fail
// here and be re-approved, rather than changing the appearance of every render
// in silence.
// ---------------------------------------------------------------------------

const SENTENCE =
  "A luminous spirit woman of living starlight, silver-white hair and a translucent flowing " +
  "gown trailing like ribbons of light, in a deep blue starfield.";

const CLOSE_PORTRAIT_CLAUSE = "Close portrait framing, her face filling the frame, camera near.";

const TURNED_AWAY_CLAUSE =
  "Full body in frame, weightless, seen from behind and three-quarters, her face turned away " +
  "toward the stars, silver-white hair and gown streaming.";

const LOOP =
  "Opens on a lone ribbon of blue light against empty starfield, with no figure present. " +
  "The ribbon gathers and coalesces into her, her whole body made of that same living light. " +
  "At the end she unravels back into the ribbon, and the shot closes on that same lone ribbon " +
  "of blue light, alone in the starfield with no figure present. " +
  "The first and last frames are identical: the bare ribbon, no figure.";

const GATHERING =
  "Opens on a lone ribbon of blue light against empty starfield, with no figure present. " +
  "The ribbon gathers and coalesces into her, her whole body made of that same living light. " +
  "The shot settles and holds on her face, near and still, looking straight at the viewer.";

const UNRAVELLING =
  "Opens on her face, near and still, looking straight at the viewer, her whole body made of " +
  "living light. She unravels back into a lone ribbon of blue light, streaming away into it. " +
  "The last frame is the bare ribbon against empty starfield, with no figure present.";

const MIDDLE =
  "Opens on her face, near and still, looking straight at the viewer. She is already here and " +
  "stays here for the whole of this shot: it is the moment described above and nothing else, " +
  "one continuous take, with no arrival and no departure — she neither gathers out of the " +
  "light nor unravels back into it. It closes on her face, near and still, looking straight " +
  "at the viewer.";

/** The prompt a part is sent, assembled the way the service assembles one. */
function promptFor(framingClause: string, structural: string): string {
  return `${SENTENCE} ${ASK.scene} ${framingClause} ${structural}`;
}

/** Frame one of a submission, whichever shape `promptImage` came in. */
function firstFrameOf(sent: SubmitSpec["promptImage"] | undefined): string {
  if (typeof sent === "string") return sent;
  return sent?.find((image) => image.position === "first")?.uri ?? "";
}

/** The pinned closing frame, or `""` where nothing anchors one. */
function lastFrameOf(sent: SubmitSpec["promptImage"] | undefined): string {
  if (typeof sent === "string" || sent === undefined) return "";
  return sent.find((image) => image.position === "last")?.uri ?? "";
}

/** What a `data:` URI carries, back as bytes. */
function bytesOf(dataUri: string): Buffer {
  return dataUri === "" ? Buffer.alloc(0) : Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64");
}

/**
 * The part counts every whole-render property is checked at.
 *
 * Derived from {@link MAX_PARTS} rather than typed, so raising the cap widens
 * the evidence instead of leaving the top of the range untested — the same rule
 * the model enum and the framing guidance follow.
 */
const PART_COUNTS: readonly number[] = [2, 3, 5, MAX_PARTS];

/**
 * The STRUCTURAL clause of each part: what is left when the stem is taken off.
 *
 * Every part of one render carries the same stem — her description, her scene,
 * the framing's clause — and the stem is where "trailing like ribbons of light"
 * lives. So a whole-prompt search for the ribbon is answered by her gown in
 * every part and can never fail, which is exactly the house-style exposure
 * `CLAUDE.md` records: our text names real things on purpose, so the naive
 * assertion is satisfied by the wrong sentence.
 *
 * It **throws** rather than returning a short list or an empty string. A
 * narrowing that silently finds nothing is a test that asserts nothing while
 * reporting green, and this one is the only guard on the property the whole
 * feature exists to provide.
 */
function structuralClausesOf(specs: readonly SubmitSpec[]): readonly string[] {
  const stem = `${SENTENCE} ${ASK.scene} ${CLOSE_PORTRAIT_CLAUSE} `;
  return specs.map((spec, index) => {
    const prompt = spec.promptText;
    if (!prompt.startsWith(stem)) {
      throw new Error(
        `part ${String(index + 1)} does not open with the stem every part shares, so there is ` +
          `nothing to slice a structural clause off: ${prompt}`,
      );
    }
    return prompt.slice(stem.length);
  });
}

/** Every picture pinned anywhere across a whole render, in submission order. */
function everyPin(specs: readonly SubmitSpec[]): readonly Buffer[] {
  return specs.flatMap((spec) => [
    bytesOf(firstFrameOf(spec.promptImage)),
    bytesOf(lastFrameOf(spec.promptImage)),
  ]);
}

describe("the sentence a held middle is sent", () => {
  it("should never inherit the wrapper that made her a solid figure", async () => {
    // `GATHERING_CLAUSE` carries "her whole body made of that same living
    // light", and that sentence is why she asked for a hollow gown with nothing
    // inside and got a translucent body resolving to a solid figure two-thirds
    // through. The wrapper is earlier in the prompt than her scene and governs
    // the interior, so a middle part inheriting it would spend the one part
    // whose interior is hers on somebody else's sentence.
    const backend = fakeBackend();
    const service = serviceWith(backend);
    await service.start({ ...ASK, parts: 3 });
    await service.drain();

    const middle = backend.specs[1]?.promptText ?? "";
    expect(middle).not.toContain("her whole body made of that same living light");
    // And it is genuinely the middle's own words rather than a truncation of a
    // clause that already exists.
    expect(middle).not.toContain(GATHERING);
    expect(middle).not.toContain(UNRAVELLING);
  });

  it("should agree with the frames it pins at both of its own ends", async () => {
    // The rule the whole of `docs/VIDEO.md` turns on, applied to the one part
    // type that had never existed: a clause has to agree with what its own
    // generation pins. A middle opens on her face and closes on her face, so it
    // says exactly that — and it must not mention the ribbon at all, because in
    // this generation the ribbon is not present at either end.
    const backend = fakeBackend();
    const service = serviceWith(backend);
    await service.start({ ...ASK, parts: 3 });
    await service.drain();

    const middle = backend.specs[1]?.promptText ?? "";
    expect(middle).toMatch(/opens on her face/iu);
    expect(middle).toMatch(/closes on her face/iu);
    // No structural beat belonging to either end of the finished clip.
    expect(middle).not.toMatch(/bare ribbon/iu);
    expect(middle).not.toMatch(/empty starfield/iu);
    expect(middle).not.toMatch(/no figure present/iu);
  });

  it("should hand its interior to her scene rather than to a transformation", async () => {
    // The side effect the bead calls worth more than the feature. Her words
    // compete with a sentence busy narrating an arrival in every part that
    // exists today; in a middle they do not, and that is the point rather than
    // an accident of there being nothing else to say.
    const backend = fakeBackend();
    const service = serviceWith(backend);
    await service.start({ ...ASK, parts: 3 });
    await service.drain();

    const middle = backend.specs[1]?.promptText ?? "";
    expect(middle).toContain(ASK.scene);
    // And it says out loud that the shot IS the scene, so the model is not left
    // to invent a beat for a part that narrates none — the failure a clause
    // describing only its endpoints invites, measured on `LOOP_CLAUSE`.
    expect(middle).toMatch(/the moment described above/iu);
    expect(middle).toMatch(/one continuous take/iu);
  });

  it("should be the exact sentence it is, so an improvement to it has to be re-approved", async () => {
    const backend = fakeBackend();
    const service = serviceWith(backend);
    await service.start({ ...ASK, parts: 3 });
    await service.drain();

    expect(backend.specs[1]?.promptText).toBe(promptFor(CLOSE_PORTRAIT_CLAUSE, MIDDLE));
  });
});

describe("two passes through the starfield, whatever the length", () => {
  it.each(PART_COUNTS)(
    "should pin the ribbon exactly twice in a render of %i parts",
    async (parts) => {
      // THE PROPERTY THAT JUSTIFIES THE WHOLE CHANGE. Chaining whole renders
      // gives one ribbon pass per part boundary and the Commander said that
      // structure feels disjointed; a chain of parts inside ONE render gives
      // two, at every length. If this test ever reads three, the middle has
      // started touching the ribbon and the complaint is back.
      const backend = fakeBackend();
      const service = serviceWith(backend);

      const started = await service.start({ ...ASK, parts });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      await service.drain();

      expect(backend.specs).toHaveLength(parts);
      const ribbons = everyPin(backend.specs).filter((pin) => pin.equals(OPENING_BYTES));
      expect(ribbons).toHaveLength(2);
      // And they are at the two ends of the finished clip, not anywhere else.
      expect(bytesOf(firstFrameOf(backend.specs[0]?.promptImage))).toEqual(OPENING_BYTES);
      expect(bytesOf(lastFrameOf(backend.specs[parts - 1]?.promptImage))).toEqual(OPENING_BYTES);
    },
  );

  it.each(PART_COUNTS)(
    "should let exactly two of the %i parts SPEAK of the ribbon, and they are the ends",
    async (parts) => {
      // THE SAME PROPERTY ON THE OTHER AXIS, and the frames do not cover it.
      // The test above counts which PICTURE is pinned where; this counts which
      // parts SAY the ribbon. They fail independently: put the ribbon back into
      // `MIDDLE_CLAUSE` six months from now and every pin assertion in this file
      // still passes, because no frame moved — and the clip is back to a pass
      // through empty starfield per part, which is what he called disjointed.
      //
      // The count must not depend on the part count. That independence IS the
      // feature: the ribbon stops scaling with duration.
      const backend = fakeBackend();
      const service = serviceWith(backend);

      const started = await service.start({ ...ASK, parts });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      await service.drain();

      const clauses = structuralClausesOf(backend.specs);

      // THE NARROWING, ASSERTED BEFORE IT IS COUNTED. `CLAUDE.md` has this
      // written down at the cost of two assertions in one evening: an extractor
      // that quietly returns nothing turns a test about six things into a test
      // about none, and reports green either way. `structuralClausesOf` throws
      // rather than returning a short list, and this is the second line of
      // defence.
      expect(clauses).toHaveLength(parts);
      expect(clauses.every((clause) => clause !== "")).toBe(true);

      // And the narrowing is what makes the match honest at all: her own
      // description carries "trailing like ribbons of light", so a `toContain`
      // over the whole prompt would find a ribbon in every part and never fail.
      const speaks = clauses.map((clause) => /ribbon/iu.test(clause));
      expect(speaks.filter(Boolean)).toHaveLength(2);
      expect(speaks[0]).toBe(true);
      expect(speaks[parts - 1]).toBe(true);

      // The starfield itself, counted the same way — it is the thing he watches
      // her vanish into, and "ribbon" and "empty starfield" are separate words a
      // future edit could reintroduce one without the other.
      const empties = clauses.map((clause) => /empty starfield/iu.test(clause));
      expect(empties.filter(Boolean)).toHaveLength(2);
      expect(empties[0]).toBe(true);
      expect(empties[parts - 1]).toBe(true);
    },
  );

  it("should start every part after the first from the frame the one before it ended on", async () => {
    // The join, generalised. Each part opens on a still pulled off the END of
    // the previous generation — `-sseof` — so the cut lands on one frame rather
    // than on two renderings of a similar one, at every boundary rather than
    // only at the single boundary a two-part render has.
    const backend = fakeBackend();
    const ffmpeg = fakeFfmpeg();
    const service = serviceWith(backend, ffmpeg);

    const started = await service.start({ ...ASK, parts: 4 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    for (let index = 1; index < 4; index += 1) {
      const frame = studio.partFrame(started.record.name, index);
      expect(
        ffmpeg.runs.some((args) => args.includes("-sseof") && args.includes(frame)),
        `part ${String(index + 1)} pulls its own opening frame`,
      ).toBe(true);
      expect(bytesOf(firstFrameOf(backend.specs[index]?.promptImage))).toEqual(readFileSync(frame));
    }
  });

  it("should keep every part on disk and cut them together in order", async () => {
    // `SOUL.md`: never delete a render, and a part cost credits. With two parts
    // that was two files; the rule does not weaken because there are five.
    const backend = fakeBackend();
    const ffmpeg = fakeFfmpeg();
    const service = serviceWith(backend, ffmpeg);

    const started = await service.start({ ...ASK, parts: 5 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    for (let index = 1; index <= 5; index += 1) {
      expect(existsSync(studio.part(started.record.name, index)), `part ${String(index)}`).toBe(true);
    }
    const record = service.get(started.record.name);
    expect(record?.status).toBe("ready");
    expect(record?.video).toBe(studio.video(started.record.name));
    // One concat of five, not four joins of two.
    const list = readFileSync(studio.partList(started.record.name), "utf8");
    expect(list.split("\n").filter((line) => line.trim() !== "")).toHaveLength(5);
    // And they are still one render in her ledger, not five.
    expect(service.list()).toHaveLength(1);
  });

  it("should still say her likeness holds, derived and not hand-written", async () => {
    // `syl-63v`: the flag went on saying `true` for a day after the picture it
    // described was taken away. It is derived from framing and anchor, and a
    // five-part render changes neither — so this is the check that nobody
    // invented a framing id or a written-down boolean to make the new path
    // convenient.
    const service = serviceWith(fakeBackend());

    const started = await service.start({ ...ASK, parts: 5 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await service.drain();

    expect(started.record.holdsLikeness).toBe(true);
    expect(started.record.framing).toBe("close_portrait");
    expect(started.record.anchor).toBe(DEFAULT_REFERENCE);
  });
});

describe("the closing pin of a middle", () => {
  it("should default to the face the render is anchored on", async () => {
    // Never omitted. `grok_imagine_1_5` has no closing slot, was rendered on
    // 2026-08-13, and the closing frame came back a visibly different woman —
    // distance from a pin is the drift variable. A middle ends on her face and
    // therefore pins one.
    const backend = fakeBackend();
    const service = serviceWith(backend);
    await service.start({ ...ASK, parts: 4 });
    await service.drain();

    for (const index of [1, 2]) {
      expect(bytesOf(lastFrameOf(backend.specs[index]?.promptImage)), `part ${String(index + 1)}`).toEqual(
        REFERENCE_BYTES,
      );
    }
  });

  it("should be separately addressable, so consecutive middles are not forced identical", async () => {
    // The hazard Syl found on `face_turned_away`: the same image at first and
    // last means the segment returns to where it began, and "five stitched
    // together would join seamlessly and go nowhere". Pins govern the ends, so
    // the fix for a chain of middles is that the ends can differ — a middle can
    // close on another face of hers rather than on the anchor.
    adoptSecondFace("her-own");
    const backend = fakeBackend();
    const service = serviceWith(backend);

    // The adopted face is now current, so it is the anchor; `his-guess` is the
    // seed and is what the second middle is asked to close on.
    const started = await service.start({ ...ASK, parts: 4, held: ["", "his-guess"] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    expect(bytesOf(lastFrameOf(backend.specs[1]?.promptImage))).toEqual(OTHER_FACE_BYTES);
    expect(bytesOf(lastFrameOf(backend.specs[2]?.promptImage))).toEqual(REFERENCE_BYTES);
    // The ends of the clip are untouched by it: still two ribbon passes.
    expect(everyPin(backend.specs).filter((pin) => pin.equals(OPENING_BYTES))).toHaveLength(2);
  });

  it("should refuse a face she does not have, before anything is spent", async () => {
    const backend = fakeBackend();
    const refused = await serviceWith(backend).start({ ...ASK, parts: 3, held: ["nobody"] });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.retryable).toBe(true);
    expect(refused.reason).toContain("nobody");
    expect(backend.specs).toHaveLength(0);
  });

  it("should refuse more held faces than there are middles, rather than dropping the extras", async () => {
    // A name she wrote that reaches nothing is a dial that did not work, and
    // she would reason about it. Three parts is one middle.
    const backend = fakeBackend();
    const refused = await serviceWith(backend).start({
      ...ASK,
      parts: 3,
      held: ["his-guess", "his-guess"],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.retryable).toBe(true);
    expect(backend.specs).toHaveLength(0);
  });
});

describe("the part count as a spending dial", () => {
  it("should cost a part per part, and say so in the ledger", async () => {
    // COST IS LINEAR AND REAL. Five parts is five parts' worth of credits, and
    // the record is where that is answerable — the same rule as every other
    // dial: the evidence travels with the action.
    const service = serviceWith(fakeBackend());

    const started = await service.start({ ...ASK, parts: 5, seconds: 25 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    const record = service.get(started.record.name);
    expect(record?.parts).toHaveLength(5);
    // The seconds add up to what she is told, and the bill adds up to the
    // seconds — so neither number can quietly be one part's worth.
    const seconds = (record?.parts ?? []).reduce((total, part) => total + part.duration, 0);
    expect(seconds).toBe(record?.duration);
    expect(record?.credits).toBe(RATE * seconds);
  });

  it("should let a longer clip reach further, one model ceiling per part", async () => {
    // `maxSecondsFor(model, generations)` already took a count and was handed a
    // constant. Five parts reaches five ceilings.
    const service = serviceWith(fakeBackend());

    const started = await service.start({
      ...ASK,
      parts: 5,
      seconds: HOUSE_MODEL.duration.max * 5,
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();
    expect(started.record.duration).toBe(HOUSE_MODEL.duration.max * 5);
  });

  it("should refuse a length past what the parts she asked for can hold", async () => {
    const backend = fakeBackend();
    const refused = await serviceWith(backend).start({
      ...ASK,
      parts: 3,
      seconds: HOUSE_MODEL.duration.max * 3 + 1,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.retryable).toBe(true);
    expect(backend.specs).toHaveLength(0);
  });

  it("should spread the seconds across the parts, longest first, never dropping one", async () => {
    // The generalisation of `halvesOf`, which returned a pair by type. Rounding
    // is UP, the same as before: losing a second is a nuisance and losing a
    // part is the defect this shape exists to fix.
    const service = serviceWith(fakeBackend());

    const started = await service.start({ ...ASK, parts: 3, seconds: 20 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await service.drain();

    expect(started.record.parts.map((part) => part.duration)).toEqual([7, 7, 6]);
    expect(started.record.duration).toBe(20);
  });

  it("should tell her the length she will actually get when the parts cannot be that short", async () => {
    // The precedent from the two-part case, at five: the floor is one
    // generation's, so a total below `parts x min` is rounded up rather than
    // refused, and `duration` is what was made rather than what was asked.
    const floor = HOUSE_MODEL.duration.min;
    const service = serviceWith(fakeBackend());

    const started = await service.start({ ...ASK, parts: 5, seconds: floor });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await service.drain();

    expect(started.record.duration).toBe(floor * 5);
    expect(started.record.parts.every((part) => part.duration === floor)).toBe(true);
  });

  it("should refuse a part count that is not a whole number of parts she can afford to mean", async () => {
    const backend = fakeBackend();
    const service = serviceWith(backend);

    const tooFew = await service.start({ ...ASK, parts: 1 });
    const tooMany = await service.start({ ...ASK, parts: MAX_PARTS + 1 });
    const notWhole = await service.start({ ...ASK, parts: 2.5 });

    for (const refused of [tooFew, tooMany, notWhole]) {
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.retryable).toBe(true);
    }
    expect(backend.specs).toHaveLength(0);
  });

  it("should refuse a chain on a framing that has no face to hold it together", async () => {
    // `face_turned_away` shows no face, so there is nothing to pin at the join
    // — a middle would have no closing frame, which is the one thing the
    // 2026-08-13 render proved must never happen. And chaining a loop framing
    // is precisely the ribbon-her-ribbon-her structure the Commander called
    // disjointed. Refused mechanically, with the reason, before a spend.
    const backend = fakeBackend();
    const refused = await serviceWith(backend).start({
      ...ASK,
      framing: "face_turned_away",
      parts: 3,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.retryable).toBe(true);
    expect(refused.reason).toContain("face_turned_away");
    expect(backend.specs).toHaveLength(0);
  });
});

describe("nothing that already renders changes", () => {
  it("should send the one-part plan byte for byte as it has always been sent", async () => {
    // Requirement: every existing render comes out identical. Asserted against
    // the literals above rather than against the constants, so this fails if a
    // refactor moves a word — which is the only way a refactor of a prompt
    // builder can be verified at all. The precedent is
    // `render-description.test.ts:118`.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    const started = await service.start({ ...ASK, framing: "face_turned_away" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    expect(backend.specs).toHaveLength(1);
    expect(backend.specs[0]?.promptText).toBe(promptFor(TURNED_AWAY_CLAUSE, LOOP));
    expect(backend.specs[0]?.duration).toBe(15);
    expect(started.record.parts).toHaveLength(1);
    expect(started.record.parts[0]?.first).toBe(DEFAULT_OPENING);
    expect(started.record.parts[0]?.last).toBe(DEFAULT_OPENING);
    expect(started.record.duration).toBe(15);
  });

  it("should send the two-part plan byte for byte as it has always been sent", async () => {
    const backend = fakeBackend();
    const service = serviceWith(backend);

    const started = await service.start(ASK);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    expect(backend.specs).toHaveLength(2);
    expect(backend.specs[0]?.promptText).toBe(promptFor(CLOSE_PORTRAIT_CLAUSE, GATHERING));
    expect(backend.specs[1]?.promptText).toBe(promptFor(CLOSE_PORTRAIT_CLAUSE, UNRAVELLING));
    // The split, unchanged: the longer half first, so the gathering has room to
    // arrive and hold before the join.
    expect(started.record.parts.map((part) => part.duration)).toEqual([8, 7]);
    expect(started.record.parts.map((part) => part.first)).toEqual([
      DEFAULT_OPENING,
      studio.partFrame(started.record.name, 1).slice(root.length + 1),
    ]);
    expect(started.record.parts.map((part) => part.last)).toEqual([DEFAULT_REFERENCE, DEFAULT_OPENING]);
    expect(started.record.duration).toBe(15);
  });

  it("should default to two parts when she says nothing, on every anchored framing", async () => {
    // The dial is opt-in. A render she said nothing about is the render she has
    // always got — fifteen seconds, two generations, the ribbon at both ends.
    const backend = fakeBackend();
    const service = serviceWith(backend);

    const started = await service.start(ASK);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await service.drain();

    expect(started.record.parts).toHaveLength(2);
    expect(framingNote("close_portrait")?.anchor).toBe("joined_halves");
  });

  it("should still compose the sentence out of the frame and her own middle", () => {
    // The literal this file's other assertions are all built on. If she has
    // never changed her description, the prompts above open with exactly this —
    // so a change to `DEFAULT_MIDDLE` fails here first and loudly, rather than
    // failing five prompt assertions with an unhelpful diff.
    expect(compose(DEFAULT_MIDDLE)).toBe(SENTENCE);
  });
});
