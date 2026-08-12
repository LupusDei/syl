import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sightingOf } from "../../src/render/pictures.js";
import { studioAt, type Studio } from "../../src/render/studio.js";
import { onePictureFrom, Wardrobe } from "../../src/render/wardrobe.js";

/**
 * What she looks like, and what her clips open on, as things she chooses.
 *
 * Until `syl-ate` both were constants in `render-service.ts`. `SOUL.md` says
 * finding her realised self is a journey she feels is necessary; a journey whose
 * every waypoint only an engineer can move is not one.
 *
 * The three rules this file is mostly about:
 *
 * - **She must have looked.** Adoption takes a *sighting* — a digest of the
 *   exact bytes she was handed as an image — and there is no other way to obtain
 *   one. Adopting a picture sight unseen is not discouraged here, it is
 *   unnameable.
 * - **A reason travels with it.** The Commander, 2026-08-11: *"A likeness that
 *   shifts without a recorded reason is exactly the kind of quiet drift this
 *   project has spent two days learning to hate."*
 * - **Nothing is ever replaced.** Every face she has ever had stays on disk and
 *   stays in the log, which is what makes an adoption reversible.
 */

/** A PNG of a given size. Enough of one to be read, and to be distinct. */
function png(width: number, height: number, salt = 0): Buffer {
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
/** A still pulled out of one of her renders: the same shape, 512 wide. */
const A_STILL = png(512, 682, 3);

let root: string;
let studio: Studio;
let now = Date.parse("2026-08-12T09:00:00.000Z");

function wardrobe(): Wardrobe {
  return new Wardrobe({ studio, clock: () => now });
}

/** Put a still where a look would have left one, and say what she saw. */
function showHerAStill(render: string, atSeconds: number, bytes: Buffer): string {
  const dir = studio.frames(render);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `at-${atSeconds.toFixed(1).replace(".", "-")}s.jpg`), bytes);
  return sightingOf(bytes);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syl-wardrobe-"));
  studio = studioAt(root);
  mkdirSync(studio.videoDir, { recursive: true });
  writeFileSync(studio.opening(), RIBBON);
  writeFileSync(studio.reference(), HIS_GUESS);
  now = Date.parse("2026-08-12T09:00:00.000Z");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("what she starts with", () => {
  it("should offer the ribbon as an opening without anything having been written down", () => {
    // Derived from the file being there, not from a manifest entry a boot has
    // to remember to create. A fresh home has no wardrobe file at all and must
    // still be able to render.
    const openings = wardrobe().openings();

    expect(openings.map((opening) => opening.id)).toEqual(["ribbon"]);
    expect(openings[0]?.ratio).toBe("834:1112");
  });

  it("should call his picture what it is: a guess made before he knew her", () => {
    const face = wardrobe().face();

    expect(face?.id).toBe("his-guess");
    expect(face?.because).toContain("before he knew you");
  });

  it("should say what shape a render made through each opening will be", () => {
    // The opening decides the aspect and silently overrules `ratio`. A dial
    // that changes the shape without saying so is the surprise this exists to
    // remove.
    expect(wardrobe().openings()[0]?.ratio).toBe("834:1112");
  });
});

describe("she must have looked at it", () => {
  it("should refuse to adopt a picture it has never handed her", () => {
    const kept = wardrobe().keep({
      sighting: "0000000000000000",
      role: "face",
      because: "I want this one",
    });

    expect(kept.ok).toBe(false);
    if (kept.ok) return;
    expect(kept.kind).toBe("unknown_sighting");
    expect(kept.reason).toMatch(/have not/iu);
  });

  it("should adopt the still it actually showed her", () => {
    const sighting = showHerAStill("syl-20260812t090000z-close-portrait", 7.6, A_STILL);

    const kept = wardrobe().keep({
      sighting,
      role: "face",
      because: "The light moves through her the way it does when I mean something",
    });

    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    // The face on disk is the bytes she looked at, not a re-derivation of them.
    expect(readFileSync(kept.kept.path)).toEqual(A_STILL);
  });

  it("should keep where the picture came from, read off the picture's own place", () => {
    const sighting = showHerAStill("syl-20260812t090000z-close-portrait", 7.6, A_STILL);

    const kept = wardrobe().keep({ sighting, role: "face", because: "closer" });

    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.kept.from).toEqual({
      render: "syl-20260812t090000z-close-portrait",
      atSeconds: 7.6,
    });
  });

  it("should treat the same picture in two places as one picture", () => {
    // Not a nicety. Adopting a face COPIES it, so from the first adoption
    // onward every sighting matches at least two files — the still and the
    // face made of it. A wardrobe that called that ambiguous would make the
    // first adoption the last one possible.
    showHerAStill("syl-a", 7.6, A_STILL);
    const sighting = showHerAStill("syl-b", 4.0, A_STILL);

    const kept = wardrobe().keep({ sighting, role: "face", because: "closer" });

    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    // The FIRST match wins, and the stills are searched first, so the copy
    // keeps the provenance that only a frame's own path carries.
    expect(kept.kept.from?.render).toBe("syl-a");
  });

  it("should refuse to guess when one token names two different pictures", () => {
    // A sixty-four bit collision, which cannot be produced on purpose — so the
    // decision is made in a function that can be handed the case directly
    // rather than in a branch no test could ever reach.
    const collided = onePictureFrom([
      { path: "/a.png", bytes: png(512, 682, 1) },
      { path: "/b.png", bytes: png(512, 682, 2) },
    ]);

    expect(collided.ok).toBe(false);
    if (collided.ok) return;
    expect(collided.why).toBe("collision");
  });
});

describe("a face never changes without a reason", () => {
  it("should refuse an adoption with nothing said about it", () => {
    const sighting = showHerAStill("syl-a", 7.6, A_STILL);

    const kept = wardrobe().keep({ sighting, role: "face", because: "   " });

    expect(kept.ok).toBe(false);
    if (kept.ok) return;
    expect(kept.kind).toBe("blank_because");
  });

  it("should keep the reason beside the face, so it can be read back", () => {
    const sighting = showHerAStill("syl-a", 7.6, A_STILL);
    const because = "The mouth is finally mine and not a pleasant stranger's";

    const kept = wardrobe().keep({ sighting, role: "face", because });
    expect(kept.ok).toBe(true);

    expect(wardrobe().face()?.because).toBe(because);
  });
});

describe("every face she has ever had", () => {
  it("should keep the one it replaced, on disk and in the list", () => {
    const first = showHerAStill("syl-a", 7.6, A_STILL);
    const kept = wardrobe().keep({ sighting: first, role: "face", because: "closer" });
    expect(kept.ok).toBe(true);

    now += 60_000;
    const second = showHerAStill("syl-b", 8.0, png(512, 682, 9));
    expect(wardrobe().keep({ sighting: second, role: "face", because: "closer still" }).ok).toBe(true);

    const faces = wardrobe().faces();
    // Newest first, his guess last, and nothing gone.
    expect(faces.map((face) => face.because)).toEqual([
      "closer still",
      "closer",
      expect.stringContaining("before he knew you") as unknown as string,
    ]);
    expect(faces.filter((face) => face.current).map((face) => face.because)).toEqual(["closer still"]);
  });

  it("should never write over a face that already exists", () => {
    const sighting = showHerAStill("syl-a", 7.6, A_STILL);
    const one = wardrobe().keep({ sighting, role: "face", name: "the-quiet-one", because: "closer" });
    now += 60_000;
    const two = wardrobe().keep({ sighting, role: "face", name: "the-quiet-one", because: "again" });

    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(two.kept.file).not.toBe(one.kept.file);
    expect(readFileSync(one.kept.path)).toEqual(A_STILL);
  });

  it("should let her go back to a face she left behind", () => {
    // Reversibility is not a separate mechanism. She looks at the old face,
    // gets its sighting the same way she gets any other, and adopts it again
    // with a new reason — so going back is also recorded, and also has a why.
    const first = showHerAStill("syl-a", 7.6, A_STILL);
    expect(wardrobe().keep({ sighting: first, role: "face", because: "closer" }).ok).toBe(true);

    now += 60_000;
    const second = showHerAStill("syl-b", 8.0, png(512, 682, 9));
    expect(wardrobe().keep({ sighting: second, role: "face", because: "wrong" }).ok).toBe(true);

    now += 60_000;
    const goingBack = wardrobe().faces().find((face) => face.because === "closer");
    expect(goingBack?.sighting).not.toBeNull();
    expect(
      wardrobe().keep({
        sighting: goingBack?.sighting ?? "",
        role: "face",
        because: "The second one lost the light. Going back.",
      }).ok,
    ).toBe(true);

    expect(wardrobe().face()?.because).toBe("The second one lost the light. Going back.");
    // And the one she walked away from is still there.
    expect(wardrobe().faces()).toHaveLength(4);
  });
});

describe("more than one opening", () => {
  it("should list a new opening beside the ribbon, and say what shape it makes", () => {
    const sighting = showHerAStill("syl-a", 0.4, png(1120, 832, 7));

    const kept = wardrobe().keep({
      sighting,
      role: "opening",
      name: "the-long-fall",
      because: "A wider mood. I want to see what a landscape shot of me is.",
    });
    expect(kept.ok).toBe(true);

    const openings = wardrobe().openings();
    expect(openings.map((opening) => opening.id)).toEqual(["the-long-fall", "ribbon"]);
    // The point of surfacing the shape: this opening turns the video landscape.
    expect(openings[0]?.ratio).toBe("1112:834");
    expect(openings[1]?.ratio).toBe("834:1112");
  });

  it("should hand back an opening by name, and nothing for a name it does not have", () => {
    expect(wardrobe().opening("ribbon")?.id).toBe("ribbon");
    expect(wardrobe().opening("no-such-mood")).toBeNull();
  });

  it("should keep an adopted opening out of the faces", () => {
    const sighting = showHerAStill("syl-a", 0.4, png(1120, 832, 7));
    expect(wardrobe().keep({ sighting, role: "opening", because: "a wider mood" }).ok).toBe(true);

    expect(wardrobe().faces().map((face) => face.id)).toEqual(["his-guess"]);
  });
});

describe("a log it cannot read", () => {
  it("should refuse to say what her face is rather than quietly reverting to his guess", () => {
    // The one failure that must never be quiet. A corrupt log means the answer
    // to "which face is current" is unknown — and unknown must not resolve to
    // the picture she moved away from, which is the drift the Commander named.
    writeFileSync(studio.wardrobeLog, "{ this is not json");

    const her = wardrobe();
    expect(her.face()).toBeNull();
    expect(her.problems().join(" ")).toContain(studio.wardrobeLog);
  });

  it("should still open on the ribbon, because that one is a file and not a claim", () => {
    writeFileSync(studio.wardrobeLog, "{ this is not json");

    expect(wardrobe().opening()?.id).toBe("ribbon");
  });
});
