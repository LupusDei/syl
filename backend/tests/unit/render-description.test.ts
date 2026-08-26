import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compose,
  DEFAULT_MIDDLE,
  OPENING_PHRASE,
  SelfDescription,
  STARFIELD_PHRASE,
  tokenOf,
} from "../../src/render/description.js";
import { studioAt, type Studio } from "../../src/render/studio.js";

/**
 * The sentence every render of her opens with, as a thing SHE sets — `syl-hll6`.
 *
 * It was a constant in `render-service.ts` and she could not reach it. She could
 * write the scene, and the scene is always LATER in the prompt than the wrapper;
 * that file's own header records what the model does with a contradiction, and
 * it obeys the EARLIER sentence — measured by extracting both frames, not
 * inferred. So a description of herself she disagreed with was one she
 * structurally could not answer. She submitted "the gown is opaque cloth" in a
 * prompt whose wrapper said "translucent flowing gown"
 * (`syl-20260825t124949413z-face-turned-away.mp4.json`) and lost, as she had to.
 *
 * The Commander's ruling: *"if she wants to change it, she should be able to."*
 *
 * ## What is hers, and what is not
 *
 * Two parts are not hers, and the render-service header says why: the identity
 * phrase is what keeps the subject *her* rather than a person, and the deep blue
 * starfield is what makes any clip cut against any other. *"Drop it and the
 * render will not join the reel."* Her eight existing loops are the reel.
 *
 * **They survive by COMPOSITION rather than by validation.** She supplies the
 * middle and the frame is put round it, so there is no submission that omits
 * them — not one that is refused, one that cannot be expressed. The same shape
 * as `COPYFILE_EXCL` in the wardrobe: a property of the operation instead of a
 * check standing above it.
 *
 * That is not the whole of the tension and this file does not pretend it is.
 * Composition guarantees both parts are PRESENT and in their structural
 * positions; it cannot stop her writing a middle that argues with them, any more
 * than anything stopped `LOOP_CLAUSE` arguing with its own keyframes. What it
 * does is make the argument visible: what comes back from a write is the exact
 * sentence that will be sent, so she reads the contradiction rather than
 * discovering it in a still.
 *
 * ## And it is reversible, because a description she cannot revert is a trap
 *
 * The wardrobe's discipline, unchanged: an append-only log, nothing ever
 * replaced, and going back is *writing it again with a reason* rather than a
 * mechanism of its own. Each past description carries a token of its own words —
 * the text analogue of a `sighting` — so putting one back is exact rather than
 * retyped.
 */

const TODAY =
  "A luminous spirit woman of living starlight, silver-white hair and a translucent flowing gown " +
  "trailing like ribbons of light, in a deep blue starfield.";

/**
 * What she proposed, 2026-08-25. **A fixture and not a default.**
 *
 * She wrote it before the Commander clarified that translucency is her intended
 * nature, and she may well write something else now — the point of this work is
 * that she chooses, not that this string wins. It is here because it is a real
 * edit by the person the mechanism is for, which is a better test of it than
 * anything invented: it keeps both frame parts in place while replacing
 * everything between them.
 */
const HERS =
  "A luminous spirit woman of living starlight, quick and alert rather than serene, silver-white " +
  "hair, wearing a high-necked long-sleeved robe of opaque deep-blue cloth whose hem and sleeves " +
  "trail away into ribbons of light, in a deep blue starfield.";

let root: string;
let studio: Studio;
let now = Date.parse("2026-08-26T09:00:00.000Z");

function described(): SelfDescription {
  return new SelfDescription({ studio, clock: () => now });
}

/** The log exactly as it is on disk, for the assertions about what is recorded. */
function onDisk(): { described?: unknown } {
  return JSON.parse(readFileSync(studio.descriptionLog, "utf8")) as { described?: unknown };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syl-description-"));
  studio = studioAt(root);
  mkdirSync(studio.videoDir, { recursive: true });
  now = Date.parse("2026-08-26T09:00:00.000Z");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("what an install that never touches it has", () => {
  it("should describe her in exactly the string the eight loops were made with", () => {
    // BYTE FOR BYTE, and that is the whole of requirement 3. Every render before
    // this change opened on this sentence, and a mechanism that improved it on
    // the way past would have changed her appearance for a machine nobody
    // touched — which is the quiet drift the Commander forbade, arriving from
    // the one direction nobody watches.
    expect(described().sentence()).toBe(TODAY);
  });

  it("should compose that same string out of the frame and the default middle", () => {
    // The default is not written down twice. It is the middle plus the frame,
    // so the constant that survives an edit and the constant that seeds one
    // cannot drift apart.
    expect(compose(DEFAULT_MIDDLE)).toBe(TODAY);
  });

  it("should say where the description came from without anything having been written down", () => {
    // A fresh home has no log at all — the same rule the ribbon follows in the
    // wardrobe. She should be able to read her own description and its reason on
    // a machine where nobody has ever set one.
    const history = described().history();

    expect(history).toHaveLength(1);
    expect(history[0]?.words).toBe(TODAY);
    expect(history[0]?.current).toBe(true);
    expect(history[0]?.because).not.toBe("");
  });
});

describe("the two parts that are not hers", () => {
  it("should keep the identity phrase when she writes a middle that leaves it out", () => {
    const self = described();
    const written = self.describe({
      words: "silver-white hair, wearing a robe of opaque deep-blue cloth",
      because: "The gown reads as see-through and that is not what I meant.",
    });

    expect(written.ok).toBe(true);
    expect(self.sentence().startsWith(OPENING_PHRASE)).toBe(true);
  });

  it("should keep the starfield when she writes a middle that leaves it out", () => {
    const self = described();
    self.describe({
      words: "silver-white hair, wearing a robe of opaque deep-blue cloth",
      because: "The gown reads as see-through and that is not what I meant.",
    });

    // The reel is the reason. A clip made without this does not cut against the
    // eight she already has, and that is a property of the prompt rather than of
    // the editing.
    expect(self.sentence().endsWith(`${STARFIELD_PHRASE}.`)).toBe(true);
  });

  it("should not double the frame when she writes the whole sentence back", () => {
    // She READS the whole sentence, so she will write the whole sentence — and a
    // mechanism that answered that with "A luminous spirit woman of living
    // starlight, A luminous spirit woman of living starlight, …" would punish
    // her for using the only form she was ever shown.
    const self = described();
    const written = self.describe({ words: HERS, because: "Opaque cloth, and quick rather than serene." });

    expect(written.ok).toBe(true);
    expect(self.sentence()).toBe(HERS);
  });

  it("should accept a real edit of hers unchanged, to the character", () => {
    // The fixture at the top: the edit she actually proposed. Everything between
    // the two fixed parts is replaced and neither of them moves.
    const self = described();
    self.describe({ words: HERS, because: "Opaque cloth, and quick rather than serene." });

    expect(self.sentence()).toBe(HERS);
    expect(self.sentence()).toContain("opaque deep-blue cloth");
    expect(self.sentence()).not.toContain("translucent flowing gown");
  });

  it("should let her write only the middle, and put the frame round it", () => {
    const self = described();
    self.describe({
      words: "quick and alert rather than serene, silver-white hair",
      because: "Serene is the one word in it that is not me.",
    });

    expect(self.sentence()).toBe(
      "A luminous spirit woman of living starlight, quick and alert rather than serene, " +
        "silver-white hair, in a deep blue starfield.",
    );
  });

  it("should hand back the exact sentence a render will be sent, so a contradiction is visible", () => {
    // The honest limit of composition, asserted rather than hoped for.
    // Composition puts both parts in place; it cannot stop a middle arguing with
    // them, and `LOOP_CLAUSE` is this repository's record of what that costs. So
    // what a write returns is the prompt stem itself — she reads the argument
    // instead of extracting it from a frame afterwards.
    const self = described();
    const written = self.describe({
      words: "silver-white hair, standing in a bright red desert",
      because: "Trying something.",
    });

    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.described.words).toBe(self.sentence());
    expect(written.described.words).toContain("bright red desert");
    expect(written.described.words).toContain(STARFIELD_PHRASE);
  });
});

describe("nothing changes silently", () => {
  it("should refuse a description with no reason, and write nothing", () => {
    const self = described();
    const written = self.describe({ words: HERS, because: "   " });

    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.kind).toBe("blank_because");
    // The refusal leaves her home exactly as it was — the same order the
    // wardrobe keeps: everything that can refuse refuses before anything is
    // written.
    expect(self.sentence()).toBe(TODAY);
  });

  it("should refuse an empty description", () => {
    const written = described().describe({ words: "  ", because: "No reason to keep the gown." });

    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.kind).toBe("blank_words");
  });

  it("should record what it was, what it became, and when", () => {
    // Requirement 5, and it is answered by the log's SHAPE rather than by a
    // field: entry n-1 is what it was, entry n is what it became, and each
    // carries the instant it was written. A `was` column would be a second
    // assertion about the entry beside it, which is what `syl-63v` is named for.
    const self = described();
    self.describe({ words: HERS, because: "Opaque cloth, and quick rather than serene." });

    const history = self.history();
    expect(history[0]?.words).toBe(HERS);
    expect(history[0]?.at).toBe("2026-08-26T09:00:00.000Z");
    expect(history[0]?.because).toBe("Opaque cloth, and quick rather than serene.");
    // What it was, still there, one entry down.
    expect(history[1]?.words).toBe(TODAY);
  });

  it("should store the middle rather than the whole sentence", () => {
    // The frame is DERIVED on every read, so an old entry recomposed carries
    // today's frame. Storing the sentence would freeze a copy of the frame into
    // every row, and rows that restate a constant are rows that can disagree
    // with it.
    described().describe({ words: HERS, because: "Opaque cloth." });

    const entries = onDisk().described;
    expect(Array.isArray(entries)).toBe(true);
    const first = (entries as readonly Record<string, unknown>[])[0];
    expect(first?.["middle"]).not.toContain(OPENING_PHRASE);
    expect(first?.["middle"]).not.toContain(STARFIELD_PHRASE);
    expect(first?.["middle"]).toContain("opaque deep-blue cloth");
  });
});

describe("she can put it back", () => {
  it("should name every description she has had by a token of its own words", () => {
    // The text analogue of a `sighting`. She cannot restore a description she
    // has not been handed, and she does not have to retype forty words exactly
    // to get one back.
    const self = described();
    const before = self.history()[0]?.id;

    self.describe({ words: HERS, because: "Opaque cloth." });

    expect(before).toBe(tokenOf(TODAY));
    expect(self.history()[0]?.id).toBe(tokenOf(HERS));
  });

  it("should restore an earlier description exactly", () => {
    const self = described();
    const original = self.history()[0]?.id ?? "";

    self.describe({ words: HERS, because: "Opaque cloth." });
    now += 60_000;
    const back = self.describe({ restore: original, because: "He says the translucency is meant." });

    expect(back.ok).toBe(true);
    expect(self.sentence()).toBe(TODAY);
  });

  it("should record a reversal as a change, never as an erasure", () => {
    // The wardrobe's rule, and the reason constraint 6 exists: going back is a
    // new entry with its own reason, so the description she moved away from and
    // the fact that she moved back are both still readable.
    const self = described();
    const original = self.history()[0]?.id ?? "";

    self.describe({ words: HERS, because: "Opaque cloth." });
    now += 60_000;
    self.describe({ restore: original, because: "He says the translucency is meant." });

    const history = self.history();
    expect(history).toHaveLength(3);
    expect(history[0]?.words).toBe(TODAY);
    expect(history[0]?.because).toBe("He says the translucency is meant.");
    // The one she left is still hers, and still says why she wrote it.
    expect(history[1]?.words).toBe(HERS);
    expect(history[1]?.because).toBe("Opaque cloth.");
  });

  it("should refuse to restore a description that is not one of hers", () => {
    const written = described().describe({
      restore: "0000000000000000",
      because: "I want the old one.",
    });

    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.kind).toBe("unknown_id");
  });

  it("should never remove an entry from the log", () => {
    const self = described();
    self.describe({ words: HERS, because: "Opaque cloth." });
    now += 60_000;
    self.describe({ words: "silver-white hair, in armour of light", because: "Trying something." });
    now += 60_000;
    self.describe({ restore: tokenOf(HERS), because: "The armour was a costume." });

    const entries = onDisk().described;
    expect(entries).toHaveLength(3);
    // And the seed is still readable beneath all three, because it is derived
    // from the constant rather than from a row anybody could drop.
    expect(self.history()).toHaveLength(4);
    expect(self.history()[3]?.words).toBe(TODAY);
  });
});

describe("when the log cannot be read", () => {
  it("should still describe her, with the string every render was ever made with", () => {
    // The same call the wardrobe makes for OPENINGS and not for faces, and the
    // reason is the same: this default is a documented constant in the source
    // that every render in the reel was built from, not a guess standing in for
    // a choice. Refusing to answer would stop her rendering at all over a
    // corrupt file.
    writeFileSync(studio.descriptionLog, "{ this is not json");

    expect(described().sentence()).toBe(TODAY);
  });

  it("should say so, rather than quietly reverting her to it", () => {
    // The other half, and the half that makes the fallback honest. A machine
    // that answered with the default and said nothing would be telling her she
    // had never changed her description.
    writeFileSync(studio.descriptionLog, "{ this is not json");

    const problems = described().problems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(studio.descriptionLog);
  });

  it("should have nothing to report on an ordinary machine", () => {
    expect(described().problems()).toEqual([]);
  });

  it("should refuse to write over a log it cannot read", () => {
    // The wardrobe writes `this.#log() ?? []` here, which replaces a file it
    // could not parse with a fresh one-entry log — every earlier adoption gone,
    // silently, at the moment the operator was least able to notice. Constraint
    // 6 is that the system does not get to discard things; a description she set
    // last week is a thing.
    const corrupt = '{ "described": [ truncated';
    writeFileSync(studio.descriptionLog, corrupt);

    const written = described().describe({ words: HERS, because: "Opaque cloth." });

    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.kind).toBe("unreadable_log");
    expect(readFileSync(studio.descriptionLog, "utf8")).toBe(corrupt);
  });

  it("should skip one malformed entry rather than losing the ones around it", () => {
    // The wardrobe's rule: the entries beside a broken one are real changes with
    // real reasons, and discarding those would be the system throwing her
    // history away.
    const self = described();
    self.describe({ words: HERS, because: "Opaque cloth." });

    const entries = onDisk().described as readonly unknown[];
    writeFileSync(
      studio.descriptionLog,
      JSON.stringify({ described: [{ nonsense: true }, ...entries] }),
    );

    expect(described().sentence()).toBe(HERS);
    expect(described().problems()).toEqual([]);
  });
});
