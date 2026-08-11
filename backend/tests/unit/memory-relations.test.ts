import { describe, expect, it } from "vitest";

import { STATED_RELATION } from "../../src/memory/extract-apply.js";
import {
  ABOUT_SHARE_ALARM,
  assertInferredRelation,
  ESCAPE_RELATION,
  INFERRED_RELATIONS,
  isInferredRelation,
  meterAbout,
  MEMORY_RELATIONS,
  OBSERVED_RELATIONS,
  RelationError,
} from "../../src/memory/relations.js";

/**
 * The relation vocabulary: what an edge is allowed to MEAN.
 *
 * `memory_edges.relation` is populated on every row and has only ever held
 * `'stated'`. The column exists; the vocabulary never did. These tests are
 * about the vocabulary being CLOSED, because that is the defence against
 * digestion's own failure mode — everything in one conversation is trivially
 * "related", so a turn asked to connect recent things will connect all of them.
 */

describe("the relation vocabulary", () => {
  it("should name every relation the epic asked for and nothing invented beside them", () => {
    expect([...INFERRED_RELATIONS]).toEqual([
      "spouse_of",
      "child_of",
      "parent_of",
      "sibling_of",
      "employed_by",
      "works_on",
      "evidence_for",
      "blocks",
      "contradicts",
      "located_in",
      "about",
    ]);
  });

  it("should keep the provenance relation OUT of what an inference may write", () => {
    // `stated` means "a source said so". An inference that could claim it would
    // become indistinguishable from something the Commander actually said.
    expect(OBSERVED_RELATIONS as readonly string[]).toContain(STATED_RELATION);
    expect(INFERRED_RELATIONS as readonly string[]).not.toContain(STATED_RELATION);
    expect(isInferredRelation(STATED_RELATION)).toBe(false);
  });

  it("should be the union of both halves, so the column has exactly one vocabulary", () => {
    expect([...MEMORY_RELATIONS].sort()).toEqual(
      [...OBSERVED_RELATIONS, ...INFERRED_RELATIONS].sort(),
    );
    expect(new Set(MEMORY_RELATIONS).size).toBe(MEMORY_RELATIONS.length);
  });

  it("should accept every relation in the vocabulary", () => {
    for (const relation of INFERRED_RELATIONS) {
      expect(assertInferredRelation(relation, "test")).toBe(relation);
    }
  });

  it("should reject an unknown relation LOUDLY, naming it and listing the vocabulary", () => {
    let thrown: unknown;
    try {
      assertInferredRelation("reminds_him_of", "edges[0].relation");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RelationError);
    const error = thrown as RelationError;
    // Naming the offender is the whole point: a rejection that does not say
    // WHAT was rejected sends the reader to a stack trace to find out.
    expect(error.message).toContain("reminds_him_of");
    expect(error.message).toContain("edges[0].relation");
    // And listing the vocabulary is what makes the error actionable rather
    // than merely correct.
    for (const relation of INFERRED_RELATIONS) {
      expect(error.message).toContain(relation);
    }
    expect(error.relation).toBe("reminds_him_of");
  });

  it("should reject a relation that is not a string at all", () => {
    for (const value of [null, undefined, 7, {}, ["spouse_of"]]) {
      expect(() => assertInferredRelation(value, "test")).toThrow(RelationError);
    }
  });

  it("should reject a near miss rather than repairing it", () => {
    // No trimming, no case folding, no singularising. A relation that arrives
    // wrong is a contract violation, and repairing one is how the second
    // spelling enters the graph.
    for (const value of [" spouse_of", "spouse_of ", "SPOUSE_OF", "spouseof", "spouse-of"]) {
      expect(() => assertInferredRelation(value, "test")).toThrow(RelationError);
    }
  });
});

describe("the `about` meter", () => {
  it("should name `about` as the escape hatch", () => {
    expect(ESCAPE_RELATION).toBe("about");
    expect(isInferredRelation(ESCAPE_RELATION)).toBe(true);
  });

  it("should report no share at all when nothing has been written", () => {
    const meter = meterAbout([]);
    expect(meter.total).toBe(0);
    expect(meter.about).toBe(0);
    expect(meter.share).toBe(0);
    expect(meter.loud).toBe(false);
  });

  it("should count the escape hatch against everything else", () => {
    const meter = meterAbout(["spouse_of", "child_of", "about", "works_on"]);
    expect(meter.about).toBe(1);
    expect(meter.typed).toBe(3);
    expect(meter.total).toBe(4);
    expect(meter.share).toBeCloseTo(0.25, 10);
  });

  it("should go loud once the escape hatch stops being rare", () => {
    // The threshold is the point of the meter: `about` is what a turn reaches
    // for when it cannot name the relation, so a graph full of it is a graph
    // full of "these things are somehow connected", which is what the closed
    // vocabulary exists to prevent.
    expect(meterAbout(["about", "about", "spouse_of"]).loud).toBe(true);
    expect(meterAbout(["about", "spouse_of", "child_of", "works_on", "blocks"]).loud).toBe(false);
    expect(ABOUT_SHARE_ALARM).toBeGreaterThan(0);
    expect(ABOUT_SHARE_ALARM).toBeLessThan(1);
  });

  it("should ignore relations outside the vocabulary rather than counting them as typed", () => {
    // Nothing outside the vocabulary can reach the graph, so a value here is a
    // caller's bug. Counting it as a typed relation would make the meter
    // report the vocabulary as healthier than it is.
    const meter = meterAbout(["about", "reminds_him_of"]);
    expect(meter.total).toBe(1);
    expect(meter.about).toBe(1);
    expect(meter.share).toBe(1);
  });
});
