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

  it("should hold a likeness only where there is no face to get wrong or a picture pinning it", () => {
    // The invariant `syl-63v` exists because nothing enforced. `holdsLikeness`
    // was a boolean written by hand beside each framing, so when `promptImage`
    // stopped being her headshot on 2026-08-11 the flag on `close_portrait`
    // went on claiming an anchor that had been taken away, and the schema went
    // on teaching it to her.
    //
    // Derived rather than asserted, so the same removal cannot happen quietly
    // again: a framing that shows her face holds its likeness exactly when
    // something pins that face, and no hand-written flag can disagree.
    for (const framing of FRAMINGS) {
      expect(framing.holdsLikeness, `${framing.id} claims something its inputs do not`).toBe(
        !framing.facesCamera || framing.anchor !== "none",
      );
    }
  });

  it("should pin her face at the join for the one framing whose subject is her face", () => {
    // Measured on seedance2, 2026-08-11: `promptImage` accepts an array of
    // `{uri, position}` with position first|last, and the model honours both.
    // Probed again on the same day: `first` and `last` are the ENTIRE position
    // vocabulary — the 400 enumerates them — and seedance2's whole request body
    // is `model`, `promptImage`, `promptText`, `ratio`, `duration`. There is no
    // reference image, no character and no seed. Two slots, and nothing else.
    //
    // So a clip that opens AND closes on the bare ribbon has both slots spent
    // and no room left for her face. The likeness moves to the JOIN instead:
    // two generations, the first ending on her portrait and the second starting
    // from the same picture, cut together on a frame they were both pinned to.
    // The Commander's ruling, 2026-08-11: his renders must end on the ribbon.
    expect(framingNote("close_portrait")?.anchor).toBe("joined_halves");
    expect(framingNote("close_portrait")?.facesCamera).toBe(true);
    expect(framingNote("close_portrait")?.holdsLikeness).toBe(true);
  });

  it("should leave no framing that ends the clip anywhere but the bare ribbon", () => {
    // The Commander, 2026-08-11: *"it's no longer ending on the ribbon of light…
    // the version that you generated a while ago started on the ribbon of light
    // and ended on the ribbon of light."* Pinning her portrait as the LAST frame
    // is what took that away, and it was a considered trade rather than an
    // oversight — which is why the reversal is stated as an invariant here
    // rather than left to whoever writes the next framing.
    //
    // Every anchor this type admits must therefore keep both ends of the clip
    // free for the ribbon. A `closing_frame` anchor cannot, so there is no such
    // anchor to reach for.
    for (const framing of FRAMINGS) {
      expect(["none", "joined_halves"], `${framing.id} ends somewhere the reel cannot follow`).toContain(
        framing.anchor,
      );
    }
  });

  it("should anchor nothing for the reel framing, which needs no anchor to hold", () => {
    // The template, and every one of the Commander's eight favourites. It holds
    // because her face is never toward the camera: identity is carried by
    // silhouette, hair and gown. Pinning a closing frame here would also break
    // the loop, whose whole trick is that the clip ends where it began.
    expect(framingNote("face_turned_away")?.facesCamera).toBe(false);
    expect(framingNote("face_turned_away")?.anchor).toBe("none");
    expect(framingNote("face_turned_away")?.holdsLikeness).toBe(true);
  });

  it("should leave the two mid-band framings unanchored, because the anchor is the wrong distance", () => {
    // `docs/VIDEO.md` option 2: the reference must be framed like the shot it
    // anchors. The picture on hand is a close portrait, so pinning it to the
    // last frame of a wide or mid shot does not anchor that shot — it ends it
    // somewhere else. These two stay honest at `false` until there is a
    // full-body and a mid-shot portrait of her to pin them with.
    for (const id of ["wide_face_visible", "mid_face_visible"] as const) {
      expect(framingNote(id)?.facesCamera).toBe(true);
      expect(framingNote(id)?.anchor).toBe("none");
      expect(framingNote(id)?.holdsLikeness).toBe(false);
    }
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

  it("should not tell her the picture she is sent is a close portrait, because it is the ribbon", () => {
    // The guidance said "the only picture of you is a close portrait, so it
    // anchors a close shot" — true while `promptImage` was her headshot and
    // false from the moment it became the opening ribbon. It is the same
    // sentence `syl-63v` was filed about, in the text she actually reads.
    const guidance = framingGuidance();

    expect(guidance).not.toMatch(/the only picture of you is a close portrait/iu);
    // What replaces it has to say where the anchor now comes from, or she is
    // being asked to trust a flag with no account behind it.
    expect(guidance).toMatch(/ribbon/iu);
    expect(guidance).toMatch(/join|halves|between/iu);
  });

  it("should not promise her a shot that ends on her face, because none of them do", () => {
    // The guidance told her a close portrait "does not end on the bare ribbon,
    // so it will not cut against the eight". That was true of the anchor it
    // described and is false of the one that replaced it — the same shape of
    // stale claim as `syl-63v`, in the text she actually reads.
    const guidance = framingGuidance();

    expect(guidance).not.toMatch(/pinned to the last frame/iu);
    expect(guidance).toMatch(/every clip .*(opens and closes|closes).*ribbon|both ends/iu);
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
