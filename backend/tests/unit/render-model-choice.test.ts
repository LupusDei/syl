import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { creditsFor } from "../../src/render/credits.js";
import type { FrameRunner } from "../../src/render/frames.js";
import { canAnchorLikeness, HOUSE_MODEL, MODELS, modelNote } from "../../src/render/models.js";
import { RenderService } from "../../src/render/render-service.js";
import type { RenderBackend, RunwayTask, SubmitSpec } from "../../src/render/runway.js";
import { studioAt, type Studio } from "../../src/render/studio.js";
import { fixedClock } from "../../src/services/clock.js";

/**
 * Which model makes her, now that there is more than one that can.
 *
 * The Commander, 2026-08-13: *"Yes default to 2.5. But keep the options
 * available"* — ruling on the question `specs/013` deliberately left open,
 * where changing the default was listed out of scope pending his word.
 *
 * Everything asserted here is asserted **through the registry**. The one place
 * `"seedance2_5"` appears as a literal is the single test that records his
 * ruling; every other test asks {@link HOUSE_MODEL} what the house model is and
 * checks the service agrees. A default repeated in a test is a second place for
 * it to be written down, which is the `syl-63v` shape one layer out.
 */

const NOW = Date.UTC(2026, 7, 13, 9, 0, 0, 0);

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
const HER_FACE = png(1120, 832, 2);

let root: string;
let studio: Studio;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syl-model-"));
  studio = studioAt(root);
  mkdirSync(dirname(studio.reference()), { recursive: true });
  writeFileSync(studio.reference(), HER_FACE);
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
      ({ ok: true, data: { id: "t", status: "PENDING", output: [], failureCode: null, failure: null, charged: null } satisfies RunwayTask }) as const,
    download: async () => ({ ok: true, data: 0 }),
  };
}

const ffmpeg: FrameRunner = async (_file, args) => {
  const out = args[args.length - 1] ?? "";
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from([0x00]));
  return { ok: true, message: "" };
};

function serviceWith(backend: RenderBackend): RenderService {
  return new RenderService({
    studio,
    backend,
    clock: fixedClock(NOW),
    sleep: async () => undefined,
    giveUpAfterPolls: 1,
    ffmpeg,
  });
}

/** The template shot: no face in it, so one generation and no anchor. */
const TEMPLATE = {
  scene: "she drifts across the starfield with the light running behind her",
  framing: "face_turned_away",
  because: "I want to see whether the new model still moves the way the eight do",
} as const;

/** The shot whose subject is her face, so it needs a picture pinned at the join. */
const PORTRAIT = {
  scene: "she turns once, slowly, and lets the light run down her arm",
  framing: "close_portrait",
  because: "I want to know whether this model holds me at close range",
} as const;

describe("HOUSE_MODEL", () => {
  it("should be a registry entry rather than a name written beside one", () => {
    // The derivation itself. If the roster ever loses the house model this is
    // the assertion that says so, rather than a string comparison that would
    // still pass against an entry that no longer exists.
    expect(MODELS).toContain(HOUSE_MODEL);
    expect(modelNote(HOUSE_MODEL.id)).toBe(HOUSE_MODEL);
  });

  it("should be seedance2_5, which is the Commander's ruling of 2026-08-13", () => {
    // THE ONE PLACE THE NAME IS WRITTEN IN A TEST. His words: "Yes default to
    // 2.5. But keep the options available". Everything else asks the registry.
    expect(HOUSE_MODEL.id).toBe("seedance2_5");
  });

  it("should be able to hold her likeness, or it could not be the house model", () => {
    // Not decoration. The default is what every unattended render uses, and a
    // default that cannot pin her face would make a stranger the house style.
    expect(canAnchorLikeness(HOUSE_MODEL)).toBe(true);
  });
});

describe("RenderService.start", () => {
  it("should render on the house model when she names none", async () => {
    const backend = fakeBackend();
    const started = await serviceWith(backend).start(TEMPLATE);

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(backend.specs[0]?.model).toBe(HOUSE_MODEL.id);
    expect(started.record.model).toBe(HOUSE_MODEL.id);
  });

  it("should still make a fifteen-second clip by default, not the model's longest", async () => {
    // `syl-023.4.3`: 30 seconds is ACCEPTED and NOT PROVEN — one attempt was
    // quoted at 900 credits, ran to 98% and failed. The longer ceiling is
    // available; making it automatic would bet every render on an untested path.
    const backend = fakeBackend();
    const started = await serviceWith(backend).start(TEMPLATE);

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.record.duration).toBe(15);
    expect(backend.specs[0]?.duration).toBe(15);
    expect(HOUSE_MODEL.duration.max).toBeGreaterThan(15);
  });

  it("should price a render at the chosen model's rate, never at a constant", async () => {
    // The signature defect of this project is a hard-coded price that quietly
    // belongs to the model it was measured against. 30 credits a second against
    // seedance2's 36 is a 90-credit difference on one ordinary render.
    const rate = HOUSE_MODEL.creditsPerSecond.sd;
    expect(rate).toBeDefined();

    const started = await serviceWith(fakeBackend()).start(TEMPLATE);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // The ESTIMATE at submission. `credits` is what Runway said it charged,
    // and at this instant nobody has said anything — a record that answered
    // with a charge here would be asserting something never observed.
    expect(started.record.estimated).toBe((rate ?? 0) * 15);
    expect(started.record.credits).toBeNull();
  });

  it("should let her name another model and send that one instead", async () => {
    const backend = fakeBackend();
    const started = await serviceWith(backend).start({ ...TEMPLATE, model: "seedance2" });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(backend.specs[0]?.model).toBe("seedance2");
    expect(started.record.model).toBe("seedance2");
    // And it is priced at seedance2's rate, not at the house model's.
    expect(started.record.estimated).toBe((modelNote("seedance2")?.creditsPerSecond.sd ?? 0) * 15);
  });

  it("should record the model in the sidecar, so the back catalogue stays explicable", async () => {
    const started = await serviceWith(fakeBackend()).start({ ...TEMPLATE, model: "seedance2" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const sidecar = JSON.parse(readFileSync(studio.sidecar(started.record.name), "utf8")) as Record<
      string,
      unknown
    >;
    expect(sidecar["model"]).toBe("seedance2");
  });

  it("should refuse a model that is not on the roster, and name the ones that are", async () => {
    const backend = fakeBackend();
    const started = await serviceWith(backend).start({ ...TEMPLATE, model: "seedance9000" });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.reason).toContain("seedance9000");
    expect(started.reason).toContain(HOUSE_MODEL.id);
    expect(started.retryable).toBe(true);
    expect(backend.specs).toHaveLength(0);
  });

  it("should refuse a model with no closing keyframe for a shot of her face, before spending", async () => {
    // `grok_imagine_1_5` takes ONE picture and its position must be `first`.
    // There is nowhere to pin her, so the closing frame comes back a stranger —
    // rendered on 2026-08-13, not reasoned. The refusal derives from
    // `canAnchorLikeness`, which derives from the keyframe slots, so a model
    // added later is covered without anybody remembering this test exists.
    const stranger = MODELS.find((model) => !canAnchorLikeness(model));
    expect(stranger, "the roster has no un-anchorable model to test with").toBeDefined();
    if (stranger === undefined) return;

    const backend = fakeBackend();
    const started = await serviceWith(backend).start({ ...PORTRAIT, model: stranger.id });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    // NOTHING WAS SPENT. The whole point of refusing here rather than there.
    expect(backend.specs).toHaveLength(0);
    expect(started.reason).toContain(stranger.id);
    // And it says WHY, in a sentence, rather than refusing on a rule number.
    expect(started.reason).toMatch(/keyframe|pin|somebody else|stranger/iu);
    expect(started.retryable).toBe(true);
  });

  it("should let an un-anchorable model render a shot with no face to lose", async () => {
    // Refusing it everywhere would be the wrong lesson. `SOUL.md`: "you cannot
    // recognise yourself without seeing what you are not" — and at 11 credits a
    // second it is the cheapest way to find out whether a movement reads.
    const stranger = MODELS.find((model) => !canAnchorLikeness(model));
    if (stranger === undefined) return;

    const backend = fakeBackend();
    const started = await serviceWith(backend).start({ ...TEMPLATE, model: stranger.id });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(backend.specs[0]?.model).toBe(stranger.id);
  });

  it("should send a model only the keyframe slots it actually has", async () => {
    const stranger = MODELS.find((model) => !canAnchorLikeness(model));
    if (stranger === undefined) return;

    const backend = fakeBackend();
    await serviceWith(backend).start({ ...TEMPLATE, model: stranger.id });

    const sent = backend.specs[0]?.promptImage;
    const positions = typeof sent === "string" ? ["first"] : (sent ?? []).map((one) => one.position);
    expect(positions).toEqual([...stranger.positions]);
  });

  it("should shape the request the way the model is shaped, never with the wrong key", async () => {
    // `ratio` is an *Unrecognized key* on `grok_imagine_1_5` and `resolution` is
    // one on every seedance. Sending the wrong one is a 400 that costs a turn.
    const backend = fakeBackend();
    const byResolution = MODELS.find((model) => model.shape === "resolution");
    if (byResolution === undefined) return;

    await serviceWith(backend).start({ ...TEMPLATE, model: byResolution.id });
    expect(backend.specs[0]?.ratio).toBeUndefined();
    expect(byResolution.resolutions).toContain(backend.specs[0]?.resolution);

    await serviceWith(backend).start({ ...TEMPLATE, model: HOUSE_MODEL.id });
    expect(backend.specs[1]?.resolution).toBeUndefined();
    expect(backend.specs[1]?.ratio).toBe("834:1112");
  });

  it("should take the duration range from the model rather than from a constant", async () => {
    // seedance2 stops at 15 and the house model goes to 30. A single constant
    // is one model's range wearing the name of a fact about video.
    const backend = fakeBackend();
    const tooLongForSeedance2 = 20;
    expect(modelNote("seedance2")?.duration.max).toBeLessThan(tooLongForSeedance2);
    expect(HOUSE_MODEL.duration.max).toBeGreaterThanOrEqual(tooLongForSeedance2);

    const refused = await serviceWith(backend).start({
      ...TEMPLATE,
      model: "seedance2",
      seconds: tooLongForSeedance2,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain("seedance2");
    expect(refused.reason).toContain("15");
    expect(backend.specs).toHaveLength(0);

    const allowed = await serviceWith(backend).start({
      ...TEMPLATE,
      seconds: tooLongForSeedance2,
    });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.record.duration).toBe(tooLongForSeedance2);
  });

  it("should split an anchored render into halves the chosen model will accept", async () => {
    // An anchored render is two generations, so its ceiling is twice the
    // model's — and each half must land inside the model's own range, which is
    // where a hard-coded 4 would refuse a model whose floor is 1.
    const backend = fakeBackend();
    const started = await serviceWith(backend).start({ ...PORTRAIT, seconds: 30 });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.record.parts).toHaveLength(2);
    for (const part of started.record.parts) {
      expect(part.duration).toBeGreaterThanOrEqual(HOUSE_MODEL.duration.min);
      expect(part.duration).toBeLessThanOrEqual(HOUSE_MODEL.duration.max);
    }
    expect(started.record.duration).toBe(30);
  });
});

describe("creditsFor", () => {
  it("should price every model from the registry it was measured into", () => {
    for (const model of MODELS) {
      const rate = model.creditsPerSecond.sd;
      const quoted =
        model.shape === "ratio"
          ? creditsFor({ model: model.id, ratio: "834:1112", seconds: 4 })
          : creditsFor({ model: model.id, resolution: "480p", seconds: 4 });

      expect(quoted, model.id).toBe(rate === undefined ? null : rate * 4);
    }
  });

  it("should report null for a model nobody has measured, never a guess", () => {
    expect(creditsFor({ model: "veo3.1", ratio: "834:1112", seconds: 4 })).toBeNull();
  });
});
