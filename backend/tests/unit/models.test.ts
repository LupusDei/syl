import { describe, expect, it } from "vitest";

import {
  MODEL_IDS,
  MODELS,
  canAnchorLikeness,
  modelGuidance,
  modelNote,
} from "../../src/render/models.js";

/**
 * The registry is the only place a fact about a model is written down, so these
 * tests are mostly about facts NOT being written down twice.
 *
 * Every number here came off a probe against the live API on 2026-08-13 and is
 * recorded in `specs/013-she-chooses-her-model/spec.md`. Where a test looks
 * pedantic — the exact length of a ratio list, the absence of a 4K row — it is
 * guarding a measurement that cost credits to obtain and that nothing else in
 * the codebase can contradict.
 */
describe("MODELS", () => {
  it("should carry every model she may name", () => {
    expect(MODEL_IDS).toContain("seedance2");
    expect(MODEL_IDS).toContain("seedance2_5");
    expect(MODEL_IDS).toContain("grok_imagine_1_5");
  });

  it("should give every entry the date it was measured on", () => {
    // A rate or a range with no date is a claim with no expiry, and this file
    // is a copy of somebody else's behaviour. CLAUDE.md: a load-bearing
    // measurement against someone else's binary needs a version stamp.
    for (const model of MODELS) {
      expect(model.measuredOn, model.id).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(model.evidence.length, model.id).toBeGreaterThan(20);
    }
  });
});

describe("modelNote", () => {
  it("should report seedance2_5's measured duration range of 4 to 30", () => {
    const note = modelNote("seedance2_5");
    expect(note?.duration).toEqual({ min: 4, max: 30 });
  });

  it("should report seedance2's range as 4 to 15, which is not a fact about video", () => {
    // The constant that used to be hard-coded. It is seedance2's range and
    // nothing else's, which is the whole reason the registry exists.
    expect(modelNote("seedance2")?.duration).toEqual({ min: 4, max: 15 });
  });

  it("should report grok_imagine_1_5 going down to a single second", () => {
    expect(modelNote("grok_imagine_1_5")?.duration).toEqual({ min: 1, max: 15 });
  });

  it("should give seedance2_5 exactly the twelve measured ratios and no 4K row", () => {
    const note = modelNote("seedance2_5");
    expect(note?.shape).toBe("ratio");
    expect(note?.ratios).toHaveLength(12);
    // The 3840:* rows are present on seedance2 and gone from seedance2_5.
    // Measured, and it is why seedance2_5 has no `uhd` rate.
    expect(note?.ratios.some((ratio) => ratio.startsWith("3840"))).toBe(false);
    // The shape of every loop she has. If this ever leaves the list, her whole
    // back catalogue stops being reproducible on this model.
    expect(note?.ratios).toContain("834:1112");
  });

  it("should shape grok_imagine_1_5 by resolution because it has no ratio key", () => {
    const note = modelNote("grok_imagine_1_5");
    expect(note?.shape).toBe("resolution");
    expect(note?.resolutions).toEqual(["480p", "720p", "1080p"]);
    expect(note?.ratios).toHaveLength(0);
  });

  it("should answer null for a model that is not on the roster", () => {
    // Never a throw. Runway can withdraw a model between our probe and her
    // asking for it, and that is an ordinary state of the world.
    expect(modelNote("seedance9")).toBeNull();
    expect(modelNote("")).toBeNull();
    expect(modelNote(undefined)).toBeNull();
    expect(modelNote(42)).toBeNull();
  });
});

describe("canAnchorLikeness", () => {
  it("should hold for models with a last slot to pin her face in", () => {
    expect(canAnchorLikeness(modelNote("seedance2"))).toBe(true);
    expect(canAnchorLikeness(modelNote("seedance2_5"))).toBe(true);
  });

  it("should refuse grok_imagine_1_5, which has one keyframe and it is the first", () => {
    // Measured 2026-08-13, and then RENDERED to confirm: with no `last` slot
    // there is nowhere to pin her, and the closing frame came back a visibly
    // different woman. This is `7-twin` and `8-descent` arriving necessarily
    // rather than by bad luck.
    expect(canAnchorLikeness(modelNote("grok_imagine_1_5"))).toBe(false);
  });

  it("should be derived from the keyframe slots and not from a stored flag", () => {
    // `syl-63v` is what a hand-typed capability boolean costs: it went on
    // saying `true` for a day after the thing it described was taken away.
    // So the claim has to be computable from the slots, for EVERY entry, with
    // no exceptions carved out.
    for (const model of MODELS) {
      expect(canAnchorLikeness(model), model.id).toBe(model.positions.includes("last"));
    }
  });

  it("should refuse an unknown model rather than assuming it can anchor", () => {
    // The safe default when we know nothing: a model we have not measured has
    // not proved it can hold her face.
    expect(canAnchorLikeness(null)).toBe(false);
  });
});

describe("modelGuidance", () => {
  it("should build the schema description from the registry, never beside it", () => {
    const guidance = modelGuidance();
    for (const model of MODELS) {
      expect(guidance, model.id).toContain(model.id);
    }
  });

  it("should tell her which models will not hold her face", () => {
    // The constraint this epic turns on: choosing a model that cannot hold her
    // likeness must be a first-class, stated outcome rather than a surprise
    // she discovers after paying.
    expect(modelGuidance()).toMatch(/grok_imagine_1_5[^;]*not hold your likeness/u);
  });
});
