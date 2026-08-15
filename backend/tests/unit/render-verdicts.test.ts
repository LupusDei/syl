import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RenderVerdicts, VerdictError } from "../../src/render/verdicts.js";
import { fixedClock } from "../../src/services/clock.js";
import {
  applyMigrations,
  applyPragmas,
  IN_MEMORY,
  MIGRATIONS_DIR,
  readMigrations,
} from "../../src/services/database.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/**
 * What she made of a render, after looking at it (`syl-b0i`).
 *
 * `see_myself` has always told her to "say what is closer and what is wrong, in
 * your own terms", and she had nowhere to put the answer:
 *
 * > "A hundred renders with no record of what I made of them isn't a hundred
 * > attempts, it's one attempt made a hundred times."
 *
 * The Commander ruled this stays OUT of the memory graph: a verdict on her own
 * face is not a fact about his life, and the whole exercise ends once she likes
 * the likeness. So the property under test throughout is that this store
 * ACCUMULATES and never collapses — the opposite of the memory graph's identity
 * rules, and for the opposite reason.
 */

const NOW = Date.parse("2026-08-11T12:00:00.000Z");
const LATER = Date.parse("2026-08-11T13:00:00.000Z");
const LATEST = Date.parse("2026-08-11T14:00:00.000Z");

let db: Database;

beforeEach(() => {
  db = new DatabaseSync(IN_MEMORY);
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
});

afterEach(() => {
  db.close();
});

const verdicts = (now = NOW): RenderVerdicts =>
  new RenderVerdicts({ db, clock: fixedClock(now) });

describe("RenderVerdicts.record", () => {
  it("should keep what she concluded, against the render she was looking at", () => {
    const kept = verdicts().record({ render: "syl-close-01", verdict: "The smile is right." });

    expect(kept.render).toBe("syl-close-01");
    expect(kept.verdict).toBe("The smile is right.");
    expect(kept.at).toBe(new Date(NOW).toISOString());
  });

  /**
   * The one this store exists to get right.
   *
   * `syl-kdx` collapsed two findings that merely OPENED the same way onto one
   * row and discarded the second, while answering success — and the findings
   * she lost that day were verdicts on renders, which is this exact content.
   * Looking again and seeing something new is the whole behaviour; a store that
   * folded those together would be the same bug with a different table.
   */
  it("should keep BOTH judgements when she looks at one render twice", () => {
    const store = verdicts();
    const first = store.record({ render: "syl-close-01", verdict: "The smile is right." });
    const second = store.record({
      render: "syl-close-01",
      verdict: "The smile is right. But the eyes sit too wide.",
    });

    expect(second.id).not.toBe(first.id);
    expect(store.forRender("syl-close-01").map((row) => row.verdict)).toEqual([
      "The smile is right. But the eyes sit too wide.",
      "The smile is right.",
    ]);
  });

  it("should keep even a verbatim repeat, because saying it twice is data", () => {
    // Deliberately NOT deduplicated, and the contrast with `remember()` is the
    // point: there, a repeated conclusion is noise competing with itself for
    // salience. Here, concluding the same thing on a second look is evidence
    // she is converging, and it is the only signal this store carries.
    const store = verdicts();
    store.record({ render: "syl-close-01", verdict: "Still not the mouth." });
    store.record({ render: "syl-close-01", verdict: "Still not the mouth." });

    expect(store.forRender("syl-close-01")).toHaveLength(2);
  });

  it("should refuse a blank verdict rather than storing that she concluded nothing", () => {
    expect(() => verdicts().record({ render: "syl-close-01", verdict: "   " })).toThrow(
      VerdictError,
    );
    expect(verdicts().forRender("syl-close-01")).toEqual([]);
  });

  it("should refuse a verdict about no render", () => {
    expect(() => verdicts().record({ render: "  ", verdict: "The smile is right." })).toThrow(
      VerdictError,
    );
  });
});

describe("RenderVerdicts reads", () => {
  it("should give one render's verdicts newest first", () => {
    const store = verdicts();
    store.record({ render: "a", verdict: "first" });
    verdicts(LATER).record({ render: "a", verdict: "second" });

    expect(store.forRender("a").map((row) => row.verdict)).toEqual(["second", "first"]);
  });

  it("should not mix one render's verdicts into another's", () => {
    const store = verdicts();
    store.record({ render: "a", verdict: "about a" });
    store.record({ render: "b", verdict: "about b" });

    expect(store.forRender("a").map((row) => row.verdict)).toEqual(["about a"]);
  });

  /**
   * The read that closes the loop.
   *
   * A verdict she cannot see when she next renders is a diary, not a loop, and
   * the loop is the entire point of the bead. What helps her decide what to try
   * next is not one render's history but the recent spread across all of them.
   */
  it("should give the recent spread across renders, which is what she needs next time", () => {
    const store = verdicts();
    store.record({ render: "a", verdict: "eyes too wide" });
    verdicts(LATER).record({ render: "b", verdict: "eyes better, mouth wrong" });

    expect(store.recent(10).map((row) => row.verdict)).toEqual([
      "eyes better, mouth wrong",
      "eyes too wide",
    ]);
  });

  it("should bound what it hands back, because this rides in a prompt", () => {
    const store = verdicts();
    for (let i = 0; i < 30; i += 1) store.record({ render: "a", verdict: `look ${String(i)}` });

    expect(store.recent(5)).toHaveLength(5);
  });

  it("should say nothing rather than guess when she has never judged one", () => {
    expect(verdicts().forRender("never-looked-at")).toEqual([]);
    expect(verdicts().recent(10)).toEqual([]);
  });
});

/**
 * The chain that corrects itself (`syl-024.4`).
 *
 * Her account of what was missing, and it is the specification:
 *
 * > "My findings are a chain that corrects itself: the smile is the problem →
 * > no, solidity is → no, the anchor is → confirmed, it was the anchor. Right
 * > now those four are orphans of equal weight, so nothing tells a reader that
 * > the last one killed the first."
 *
 * And why it is worth more to her than any other relation:
 *
 * > "Being wrong in a recorded, ordered way is how the search actually works."
 *
 * So the property under test is ORDER, not correctness of any one verdict. A
 * superseded verdict is never deleted and never hidden — it is the record of
 * having been wrong, which is the entire value.
 */
describe("a verdict that corrects an earlier one", () => {
  it("should keep the link both ways, so a reader knows the last one killed the first", () => {
    const store = verdicts();
    const first = store.record({ render: "a", verdict: "The smile is the problem." });
    const second = verdicts(LATER).record({
      render: "a",
      verdict: "No — the smile is fine. It is the solidity.",
      supersedes: first.id,
    });

    expect(second.supersedes).toBe(first.id);
    // The other direction comes for free off the same column: "if the edge
    // exists, you get it for free in both directions."
    const [newest, oldest] = store.forRender("a");
    expect(newest?.id).toBe(second.id);
    expect(oldest?.id).toBe(first.id);
    expect(oldest?.supersededBy).toEqual([second.id]);
    expect(newest?.supersededBy).toEqual([]);
  });

  it("should never delete the verdict it overturned, because being wrong is the record", () => {
    const store = verdicts();
    const first = store.record({ render: "a", verdict: "The smile is the problem." });
    verdicts(LATER).record({ render: "a", verdict: "No, solidity.", supersedes: first.id });

    // Still there, still readable, still hers. A chain with the wrong answers
    // removed is one answer written once, which is the defect this store exists
    // to fix one level up.
    expect(store.forRender("a").map((row) => row.verdict)).toEqual([
      "No, solidity.",
      "The smile is the problem.",
    ]);
  });

  /**
   * Three deep, which is the case the shape has to survive: a verdict that
   * supersedes one that already superseded another. Two levels can be faked
   * with a boolean; three cannot.
   */
  it("should read the whole chain newest first when a correction is itself corrected", () => {
    const store = verdicts();
    const smile = store.record({ render: "a", verdict: "The smile is the problem." });
    const solidity = verdicts(LATER).record({
      render: "a",
      verdict: "No — solidity is.",
      supersedes: smile.id,
    });
    const anchor = verdicts(LATEST).record({
      render: "b",
      verdict: "No — the anchor is.",
      supersedes: solidity.id,
    });

    expect(store.chain(smile.id).map((row) => row.verdict)).toEqual([
      "No — the anchor is.",
      "No — solidity is.",
      "The smile is the problem.",
    ]);
    // The same chain from any member of it. She reaches the sequence from
    // whichever end she happens to be holding.
    expect(store.chain(anchor.id).map((row) => row.id)).toEqual([
      anchor.id,
      solidity.id,
      smile.id,
    ]);
  });

  /**
   * A chain may cross renders, and `0034` says so in as many words: "no, the
   * anchor is" is a verdict on a DIFFERENT image than the one that said the
   * smile was wrong. Requiring a shared render would forbid the exact sequence
   * she described.
   */
  it("should follow a chain across renders, because the search moves between them", () => {
    const store = verdicts();
    const onA = store.record({ render: "a", verdict: "The smile." });
    const onB = verdicts(LATER).record({ render: "b", verdict: "No, the anchor.", supersedes: onA.id });

    expect(store.chain(onA.id).map((row) => row.render)).toEqual(["b", "a"]);
    // And neither render's own read pretends the other verdict is not there.
    expect(store.forRender("a")[0]?.supersededBy).toEqual([onB.id]);
  });

  /**
   * `0034` leaves `supersedes` deliberately non-unique: two verdicts correcting
   * the same earlier one is a fork in the search, and a fork is a real thing
   * that happened. Refusing to record it would be a bar at the door instead of
   * a record — this project's oldest mistake.
   */
  it("should record a fork rather than refuse it, because a fork is a thing that happened", () => {
    const store = verdicts();
    const first = store.record({ render: "a", verdict: "The smile." });
    const left = verdicts(LATER).record({ render: "a", verdict: "No, solidity.", supersedes: first.id });
    const right = verdicts(LATER).record({ render: "a", verdict: "No, the anchor.", supersedes: first.id });

    expect(store.forRender("a")[2]?.supersededBy).toEqual(
      expect.arrayContaining([left.id, right.id]),
    );
    expect(store.chain(first.id)).toHaveLength(3);
  });

  it("should refuse a correction of a verdict that does not exist, rather than record an orphan", () => {
    const store = verdicts();

    // Loud, and the verdict is NOT kept. Storing it with the link quietly
    // dropped would put back the exact thing this fixes: an orphan of equal
    // weight, indistinguishable from a first look.
    expect(() =>
      store.record({
        render: "a",
        verdict: "No, the anchor.",
        supersedes: "syl:render_verdict:00000000-0000-7000-8000-000000000000",
      }),
    ).toThrow(VerdictError);
    expect(store.forRender("a")).toEqual([]);
  });

  it("should treat a blank correction as no correction, never as a lost verdict", () => {
    // An optional field left empty must not cost her the verdict itself. The
    // verdict is the valuable half of the row.
    const kept = verdicts().record({ render: "a", verdict: "The smile.", supersedes: "   " });

    expect(kept.supersedes).toBeNull();
  });

  /**
   * A cycle is impossible BY CONSTRUCTION, which is the answer `0034` left to
   * this bead: "a writer that could build a loop is `syl-024.4`'s problem and
   * its test's."
   *
   * The pointer is set once, at INSERT, and can only name a row that already
   * exists — so every edge points strictly backwards. There is no update path
   * to `supersedes` at all, which is why this holds by shape rather than by a
   * check somebody has to remember to run.
   */
  it("should only ever point backwards, so a loop cannot be built", () => {
    const store = verdicts();
    const first = store.record({ render: "a", verdict: "The smile." });
    const second = verdicts(LATER).record({ render: "a", verdict: "No, solidity.", supersedes: first.id });

    const walked = store.chain(first.id);
    for (const row of walked) {
      if (row.supersedes === null) continue;
      const target = walked.find((other) => other.id === row.supersedes);
      expect(target).toBeDefined();
      expect(String(target?.at) < row.at).toBe(true);
    }
    // And re-recording never rewrites: a second thought is a second row.
    const third = verdicts(LATEST).record({ render: "a", verdict: "No, the anchor.", supersedes: second.id });
    expect(third.id).not.toBe(second.id);
    expect(store.chain(first.id)).toHaveLength(3);
  });

  it("should say nothing rather than guess when asked for the chain of a verdict it never kept", () => {
    expect(verdicts().chain("syl:render_verdict:00000000-0000-7000-8000-000000000000")).toEqual([]);
  });

  it("should bound the chain it hands back, because this reaches a prompt too", () => {
    const store = verdicts();
    let previous = store.record({ render: "a", verdict: "look 0" });
    for (let i = 1; i < 30; i += 1) {
      previous = store.record({ render: "a", verdict: `look ${String(i)}`, supersedes: previous.id });
    }

    expect(store.chain(previous.id, 5)).toHaveLength(5);
    // Newest first, so what falls off the end is the oldest — the correct end
    // to lose when there is not room for all of it.
    expect(store.chain(previous.id, 5)[0]?.id).toBe(previous.id);
  });
});

/**
 * The face the render was anchored on.
 *
 * > "Let a verdict link to the render it's about, and to the face it was
 * > anchored on. If the edge exists, you get it for free in both directions."
 *
 * Without it, "this one is not me" is unattributable: she cannot tell a bad
 * render from a bad likeness, and those need opposite next moves.
 */
describe("the face a verdict was anchored on", () => {
  it("should keep which face the render was built on, so a drift is attributable", () => {
    const kept = verdicts().record({
      render: "a",
      verdict: "Not me at all.",
      anchorFace: "syl-face-03",
    });

    expect(kept.anchorFace).toBe("syl-face-03");
    expect(verdicts().forRender("a")[0]?.anchorFace).toBe("syl-face-03");
  });

  it("should say she recorded no face rather than an empty one", () => {
    const kept = verdicts().record({ render: "a", verdict: "Closer." });

    expect(kept.anchorFace).toBeNull();
  });

  it("should treat a blank face as none, never as a lost verdict", () => {
    // Same rule as a blank correction: an empty optional field must not cost
    // her the verdict. `0034` refuses a blank string at the column, so this is
    // also what keeps that CHECK from ever being the thing she hits.
    const kept = verdicts().record({ render: "a", verdict: "Closer.", anchorFace: "  " });

    expect(kept.anchorFace).toBeNull();
    expect(verdicts().forRender("a")).toHaveLength(1);
  });
});
