import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DreamLog, type DreamSession } from "../../src/memory/dream/log.js";
import {
  CONTRADICT_RELATION,
  DreamSweep,
  RELATED_RELATION,
  SweepError,
  resolveRelation,
  type SweepCandidate,
} from "../../src/memory/dream/sweep.js";
import { STATED_RELATION } from "../../src/memory/extract-apply.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { CONCERNS_RELATION } from "../../src/memory/remember.js";
import {
  DECLINED_RELATION,
  INFERRED_RELATION_SPECS,
  canonicalRelation,
  inferredRelation,
  isInferredRelation,
} from "../../src/memory/relations.js";
import { EXTRACTED_RELATION } from "../../src/memory/sources.js";
import {
  BODY_RELATION,
  KIND_RELATION,
  LABEL_RELATION,
  MERGED_INTO_RELATION,
  SAME_AS_RELATION,
} from "../../src/memory/tidy.js";
import { EdgeWeights } from "../../src/memory/weights.js";
import { type Clock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";

/**
 * Typed relations on inferred edges. `syl-017.1`.
 *
 * Syl's own diagnosis is the specification:
 *
 * > "Ela to Rowan is not resemblance, it's parenthood. The reasoning text is
 * > good, but the relation label is uniform and empty, so nothing can be
 * > traversed by type — you can't ask 'who are his children.'"
 *
 * So the question this suite exists to answer is literally that one, and the
 * last block asks it against a real graph. Everything before it is the
 * machinery that makes the answer possible: a CLOSED vocabulary, so relations
 * group; a DIRECTION, so a parent is not a child; and a fallback that is
 * honest rather than a guess, because a vocabulary that cannot say "I don't
 * know" is a vocabulary that lies.
 */

const NOW = Date.UTC(2026, 7, 9, 4, 30, 0, 0);
const CHICAGO = "America/Chicago";
const TONIGHT = "2026-08-08";

function fixedClock(at = NOW): Clock {
  return () => at;
}

let database: SylDatabase;
let graph: MemoryGraph;
let log: DreamLog;
let sweep: DreamSweep;
let opened: DreamSession;

beforeEach(() => {
  database = openDatabase({ path: IN_MEMORY });
  const clock = fixedClock();
  graph = new MemoryGraph({ db: database.handle, clock });
  log = new DreamLog({ db: database.handle, clock });
  sweep = new DreamSweep({
    graph,
    log,
    weights: new EdgeWeights({ graph, clock }),
    clock,
  });
  opened = log.openSession({ tz: CHICAGO, tokenCeiling: 1_000_000, night: TONIGHT });
});

afterEach(() => {
  database.close();
});

function person(label: string): string {
  return graph.addNode({ kind: "person", label }).id;
}

function fact(label: string): string {
  return graph.addNode({ kind: "fact", label }).id;
}

/** A candidate in the order the sweep would normalise it: lowest id first. */
function candidateFor(a: string, b: string, relation: string = RELATED_RELATION): SweepCandidate {
  const [sourceNode, targetNode] = a <= b ? [a, b] : [b, a];
  return { sourceNode, targetNode, relation, kernel: "related", symmetric: true, score: 0.8, existing: null };
}

/** "A" when `subject` is the candidate's source, "B" when it is the target. */
function sideOf(candidate: SweepCandidate, subject: string): "A" | "B" {
  return candidate.sourceNode === subject ? "A" : "B";
}

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

describe("the inferred-relation vocabulary", () => {
  it("should be a closed set whose every entry is distinct and well formed", () => {
    const names = INFERRED_RELATION_SPECS.map((spec) => spec.relation);
    expect(new Set(names).size).toBe(names.length);
    for (const spec of INFERRED_RELATION_SPECS) {
      // The wire form is what an index groups by, so it may not carry casing or
      // whitespace that two writers could disagree about.
      expect(spec.relation).toBe(canonicalRelation(spec.relation));
      expect(spec.gloss.trim()).not.toBe("");
    }
  });

  it("should keep a fallback in the vocabulary, so 'nothing more precise' is sayable", () => {
    // A vocabulary with no honest way to decline forces every connection into
    // the nearest label that fits badly, which is the claim-beyond-evidence
    // failure wearing a schema.
    // DECLINED_RELATION, not ESCAPE_RELATION. Reconciling the two vocabularies
    // surfaced that `about` is directional — a claim is about a person, not the
    // reverse — so it cannot carry "connected, nothing more precise" without
    // asserting a direction nobody claimed. `resembles` is the symmetric one.
    expect(isInferredRelation(DECLINED_RELATION)).toBe(true);
    expect(inferredRelation(DECLINED_RELATION)?.symmetric).toBe(true);
  });

  it("should hold both relations the kernels propose, so a kernel cannot name one it may not write", () => {
    expect(isInferredRelation(RELATED_RELATION)).toBe(true);
    expect(isInferredRelation(CONTRADICT_RELATION)).toBe(true);
  });

  it("should carry at least one directed relation, which is the whole point of typing them", () => {
    expect(INFERRED_RELATION_SPECS.some((spec) => !spec.symmetric)).toBe(true);
  });

  it("should refuse a relation owned by another module, so an inference cannot dress as testimony", () => {
    // `stated` is extraction's word for "HE asserted it"; `same_as` and
    // `merged_into` are tidy's, and tidy deliberately splits nominating from
    // acting. A dream that could write any of them would forge the one thing
    // its species is supposed to make unmistakable.
    // `ABOUT_RELATION` is deliberately NOT reserved, and reconciling the two
    // vocabularies is what settled it. This half assumed extraction owned
    // `about` and an inference writing it would be forging testimony. The
    // shipped module disagrees on purpose: an inference MAY write `about`, and
    // `ABOUT_SHARE_ALARM` meters how often it does — the concern is a dream
    // that reaches for the vague relation too readily, which is an observation
    // to raise rather than a write to forbid.
    const reserved = [
      STATED_RELATION,
      CONCERNS_RELATION,
      EXTRACTED_RELATION,
      SAME_AS_RELATION,
      MERGED_INTO_RELATION,
      LABEL_RELATION,
      BODY_RELATION,
      KIND_RELATION,
    ];
    for (const relation of reserved) {
      expect(isInferredRelation(relation)).toBe(false);
    }
  });

  it("should canonicalise the spellings a model actually emits, and refuse the empty ones", () => {
    expect(canonicalRelation("  Parent_Of ")).toBe("parent_of");
    expect(canonicalRelation("parent of")).toBe("parent_of");
    expect(canonicalRelation("parent-of")).toBe("parent_of");
    expect(canonicalRelation("")).toBeNull();
    expect(canonicalRelation("   ")).toBeNull();
    expect(canonicalRelation(null)).toBeNull();
    expect(canonicalRelation(7)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resolving one verdict's relation
// ---------------------------------------------------------------------------

describe("resolveRelation", () => {
  const candidate = candidateFor("syl:memory_node:a", "syl:memory_node:b");

  it("should keep the kernel's relation when the judgment names none", () => {
    const resolved = resolveRelation(candidate, {});
    expect(resolved.relation).toBe(RELATED_RELATION);
    expect(resolved.declined).toBeNull();
    expect(resolved.sourceNode).toBe(candidate.sourceNode);
  });

  it("should take a symmetric relation the vocabulary holds", () => {
    const resolved = resolveRelation(candidate, { relation: "contradicts" });
    expect(resolved.relation).toBe(CONTRADICT_RELATION);
    expect(resolved.symmetric).toBe(true);
    expect(resolved.declined).toBeNull();
  });

  it("should orient a directed relation on the subject the judgment named", () => {
    const asA = resolveRelation(candidate, { relation: "parent_of", subject: "A" });
    expect(asA.symmetric).toBe(false);
    expect(asA.sourceNode).toBe(candidate.sourceNode);
    expect(asA.targetNode).toBe(candidate.targetNode);

    const asB = resolveRelation(candidate, { relation: "parent_of", subject: "B" });
    expect(asB.sourceNode).toBe(candidate.targetNode);
    expect(asB.targetNode).toBe(candidate.sourceNode);
  });

  it("should decline a directed relation with no subject rather than pick a side", () => {
    // Half the time a coin-flip direction is right, which is exactly what makes
    // it unfalsifiable. Falling back says less and claims nothing false.
    const resolved = resolveRelation(candidate, { relation: "parent_of" });
    expect(resolved.relation).toBe(RELATED_RELATION);
    expect(resolved.declined).toEqual({ requested: "parent_of", why: "no_direction" });
  });

  it("should decline a relation outside the vocabulary and remember what was asked for", () => {
    // NOMINATE, do not act — `tidy.ts`'s split. The nomination is what tells us
    // which relation to add next, and it is unreachable if it is thrown away.
    const resolved = resolveRelation(candidate, { relation: "employs" });
    expect(resolved.relation).toBe(RELATED_RELATION);
    expect(resolved.declined).toEqual({ requested: "employs", why: "unknown_relation" });
  });

  it("should not let a declined relation reorder the endpoints", () => {
    const resolved = resolveRelation(candidate, { relation: "employs", subject: "B" });
    expect(resolved.sourceNode).toBe(candidate.sourceNode);
    expect(resolved.targetNode).toBe(candidate.targetNode);
    expect(resolved.symmetric).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Writing one
// ---------------------------------------------------------------------------

describe("DreamSweep.applyVerdict, with a typed relation", () => {
  it("should write the relation the judgment named", () => {
    const ela = person("Ela");
    const rowan = person("Rowan");
    const candidate = candidateFor(ela, rowan);

    const applied = sweep.applyVerdict({
      sessionId: opened.id,
      candidate,
      verdict: {
        disposition: "created",
        reasoning: "Ela is Rowan's mother; both memories say so in different words",
        relation: "parent_of",
        subject: sideOf(candidate, ela),
      },
    });

    expect(applied.edge?.relation).toBe("parent_of");
    expect(applied.edge?.sourceNode).toBe(ela);
    expect(applied.edge?.targetNode).toBe(rowan);
  });

  it("should leave the reasoning the Commander reads untouched when a relation is declined", () => {
    // The reasoning is the part that was already good. Vocabulary bookkeeping is
    // telemetry ABOUT the judgment, so it belongs in the log and nowhere else.
    const a = fact("the gutter was replaced");
    const b = fact("the roof was inspected");

    const applied = sweep.applyVerdict({
      sessionId: opened.id,
      candidate: candidateFor(a, b),
      verdict: {
        disposition: "created",
        reasoning: "one contractor did both jobs on the same visit",
        relation: "invoiced_together",
      },
    });

    expect(applied.edge?.relation).toBe(RELATED_RELATION);
    expect(applied.edge?.reasoning).toBe("one contractor did both jobs on the same visit");

    const row = log.reasoningOf(opened.id)[0];
    expect(row?.reasoning).toContain("one contractor did both jobs on the same visit");
    expect(row?.reasoning).toContain("invoiced_together");
  });

  it("should refuse to write a relation the vocabulary does not hold, whoever proposed it", () => {
    // The guard is at the door of the graph rather than at the JSON boundary,
    // so a corrupted checkpoint cannot walk a free-text relation in behind the
    // parser's back.
    const a = fact("first");
    const b = fact("second");

    expect(() =>
      sweep.applyVerdict({
        sessionId: opened.id,
        candidate: candidateFor(a, b, "vibes"),
        verdict: { disposition: "created", reasoning: "these two feel connected" },
      }),
    ).toThrow(SweepError);
  });

  it("should treat the two directions of a directed relation as two edges", () => {
    // Identity is (source, target, relation). If the reverse matched, the sweep
    // would reactivate "B parent_of A" when the judgment said "A parent_of B",
    // and the direction would be decided by whichever night ran first.
    const a = person("first");
    const b = person("second");
    const candidate = candidateFor(a, b);

    sweep.applyVerdict({
      sessionId: opened.id,
      candidate,
      verdict: { disposition: "created", reasoning: "forwards", relation: "parent_of", subject: "A" },
    });
    const second = sweep.applyVerdict({
      sessionId: opened.id,
      candidate,
      verdict: { disposition: "created", reasoning: "backwards", relation: "parent_of", subject: "B" },
    });

    expect(second.disposition).toBe("created");
    expect(graph.edgesBetween(a, b)).toHaveLength(2);
  });

  it("should reactivate a directed edge only in the direction it was written", () => {
    const a = person("first");
    const b = person("second");
    const candidate = candidateFor(a, b);
    const written = sweep.applyVerdict({
      sessionId: opened.id,
      candidate,
      verdict: { disposition: "created", reasoning: "forwards", relation: "parent_of", subject: "A" },
    });
    graph.demote(written.edge!);

    const again = sweep.applyVerdict({
      sessionId: opened.id,
      candidate,
      verdict: { disposition: "created", reasoning: "found it again", relation: "parent_of", subject: "A" },
    });

    expect(again.disposition).toBe("reactivated");
    expect(again.edge?.id).toBe(written.edge?.id);
    expect(graph.edgesBetween(a, b)).toHaveLength(1);
  });

  it("should write a more precise relation beside the vague one rather than rewrite it", () => {
    // Constraint 6, one layer in: an edge is never edited into something else.
    // The vague edge keeps its own reasoning and decays on its own terms; the
    // precise one is a separate claim that stands or falls separately.
    const a = person("first");
    const b = person("second");
    const candidate = candidateFor(a, b);
    const vague = sweep.applyVerdict({
      sessionId: opened.id,
      candidate,
      verdict: { disposition: "created", reasoning: "these two keep coming up together" },
    });

    sweep.applyVerdict({
      sessionId: opened.id,
      candidate,
      verdict: { disposition: "created", reasoning: "she is his mother", relation: "parent_of", subject: "A" },
    });

    const still = graph.getEdge(vague.edge?.id ?? "");
    expect(still?.relation).toBe(RELATED_RELATION);
    expect(still?.reasoning).toBe("these two keep coming up together");
    expect(graph.edgesBetween(a, b).map((edge) => edge.relation).sort()).toEqual([
      "parent_of",
      RELATED_RELATION,
    ]);
  });
});

// ---------------------------------------------------------------------------
// "Who are his children"
// ---------------------------------------------------------------------------

describe("traversing by relation", () => {
  /** The question Syl said she could not ask. */
  function childrenOf(parent: string): string[] {
    return graph
      .edgesTouching(parent)
      .filter((edge) => edge.relation === "parent_of" && edge.sourceNode === parent)
      .map((edge) => graph.getNode(edge.targetNode)?.label ?? "")
      .sort();
  }

  it("should answer 'who are his children' once the dream names the relation", () => {
    const commander = person("the Commander");
    const isla = person("Isla");
    const rowan = person("Rowan");

    for (const child of [isla, rowan]) {
      const candidate = candidateFor(commander, child);
      sweep.applyVerdict({
        sessionId: opened.id,
        candidate,
        verdict: {
          disposition: "created",
          reasoning: "both memories describe him as her father",
          relation: "parent_of",
          subject: sideOf(candidate, commander),
        },
      });
    }

    expect(childrenOf(commander)).toEqual(["Isla", "Rowan"]);
  });

  it("should not answer it from untyped edges, which is the defect this bead is", () => {
    const commander = person("the Commander");
    const isla = person("Isla");

    sweep.applyVerdict({
      sessionId: opened.id,
      candidate: candidateFor(commander, isla),
      verdict: { disposition: "created", reasoning: "they come up in the same conversations" },
    });

    expect(graph.edgesBetween(commander, isla)).toHaveLength(1);
    expect(childrenOf(commander)).toEqual([]);
  });

  it("should not count a child as a parent, which is what direction is for", () => {
    const commander = person("the Commander");
    const isla = person("Isla");
    const candidate = candidateFor(commander, isla);

    sweep.applyVerdict({
      sessionId: opened.id,
      candidate,
      verdict: {
        disposition: "created",
        reasoning: "he is her father",
        relation: "parent_of",
        subject: sideOf(candidate, commander),
      },
    });

    expect(childrenOf(commander)).toEqual(["Isla"]);
    expect(childrenOf(isla)).toEqual([]);
  });
});
