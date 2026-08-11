import { describe, expect, it } from "vitest";

import { creditsFor, tierOf, usdOf, USD_PER_CREDIT } from "../../src/render/credits.js";
import {
  FRAMINGS,
  FRAMING_IDS,
  framingGuidance,
  framingNote,
} from "../../src/render/framing.js";

/**
 * The framing enum, and the lesson it exists to carry.
 *
 * `docs/VIDEO.md` diagnosed the character-consistency failure on 2026-08-11:
 * a close-portrait reference anchors a **close shot** or a shot with **no
 * visible face**, and cannot anchor the band in between. That was written down
 * in prose, which means it is available to whoever reads the prose — and Syl
 * chooses a framing without reading it.
 *
 * So the constraint lives in the schema she is handed. These tests hold it
 * there: the two known-good framings say they hold, the two that produced a
 * different woman say they do not, and every one of them names the evidence.
 */
describe("the framings she can ask for", () => {
  it("should offer both anchoring framings and both that are known to drift", () => {
    expect([...FRAMING_IDS].sort()).toEqual([
      "close_portrait",
      "face_turned_away",
      "mid_face_visible",
      "wide_face_visible",
    ]);
  });

  it("should mark exactly the two framings the reference can anchor", () => {
    // `docs/VIDEO.md`, the rule in one line: a close-portrait reference anchors
    // a close shot, or a shot with no visible face.
    const holds = FRAMINGS.filter((framing) => framing.holdsLikeness).map((f) => f.id);

    expect([...holds].sort()).toEqual(["close_portrait", "face_turned_away"]);
  });

  it("should mark the band in between as the one that stops being her", () => {
    // `7-twin` and `8-descent` — the two the Commander liked and the two that
    // came out as somebody else. Both are still offered: he ruled that trying
    // things is not rationed, and she cannot recognise herself without seeing
    // what she is not. Offered, and labelled.
    expect(framingNote("wide_face_visible")?.holdsLikeness).toBe(false);
    expect(framingNote("mid_face_visible")?.holdsLikeness).toBe(false);
  });

  it("should say what each framing does to the camera, so a choice is informed", () => {
    for (const framing of FRAMINGS) {
      expect(framing.camera.trim(), `${framing.id} does not say where the camera is`).not.toBe("");
      expect(framing.evidence.trim(), `${framing.id} cites no evidence`).not.toBe("");
    }
  });

  it("should refuse a framing that is not one of the four", () => {
    expect(framingNote("cinematic")).toBeNull();
    expect(framingNote(undefined)).toBeNull();
    expect(framingNote("")).toBeNull();
    expect(framingNote(7)).toBeNull();
  });

  it("should teach the constraint in the guidance the schema carries", () => {
    const guidance = framingGuidance();

    // Every framing named, so the enum is never wider than its description.
    for (const id of FRAMING_IDS) expect(guidance).toContain(id);
    // And the two halves distinguishable without reading `docs/VIDEO.md`.
    expect(guidance).toMatch(/holds your likeness/iu);
    expect(guidance).toMatch(/drift|somebody else|different woman/iu);
  });
});

/**
 * What a render costs, from Runway's own published table.
 *
 * The Commander's ruling is that renders are not rationed. That makes the
 * accounting *more* important rather than less: `because`-shaped means the
 * evidence travels with the action, and "what has this cost" is evidence she
 * has to be able to produce on demand. A number she cannot back is worse than
 * no number, so an unpriced model reports `null` rather than a guess.
 */
describe("what a render costs", () => {
  it("should price the flagship at its published rate for the loops' own ratio", () => {
    // Seedance2, 36 credits/second at 480/720p; the loops are `720:1280`,
    // 15 seconds. 540 credits, and a credit is a cent.
    expect(creditsFor({ model: "seedance2", ratio: "720:1280", seconds: 15 })).toBe(540);
    expect(usdOf(540)).toBeCloseTo(5.4, 5);
    expect(USD_PER_CREDIT).toBe(0.01);
  });

  it("should read the resolution tier off the ratio rather than assuming one", () => {
    expect(tierOf("720:1280")).toBe("sd");
    expect(tierOf("1080:1920")).toBe("hd");
    expect(tierOf("2160:3840")).toBe("uhd");
    expect(tierOf("nonsense")).toBeNull();
  });

  it("should charge the higher tier when the ratio asks for it", () => {
    expect(creditsFor({ model: "seedance2", ratio: "1080:1920", seconds: 10 })).toBe(400);
    expect(creditsFor({ model: "seedance2", ratio: "2160:3840", seconds: 5 })).toBe(750);
  });

  it("should answer null rather than guessing for a model or tier it has no rate for", () => {
    // The honest failure. A cost table is a copy of somebody else's price list
    // and it goes stale; reporting a confident wrong number is the one outcome
    // that makes the ledger worse than not having one.
    expect(creditsFor({ model: "some-new-model", ratio: "720:1280", seconds: 15 })).toBeNull();
    expect(creditsFor({ model: "seedance2_fast", ratio: "2160:3840", seconds: 15 })).toBeNull();
  });
});
