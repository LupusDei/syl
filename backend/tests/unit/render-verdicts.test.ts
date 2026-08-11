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
