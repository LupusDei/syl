import { describe, expect, it } from "vitest";

import {
  findCommanderNode,
  groupIdentities,
  isCommanderNode,
  normaliseName,
  parseLabel,
  proposeFromProse,
  PROSE_CONFIDENCE,
  RESOLVABLE_KIND,
} from "../../src/memory/entities.js";
import type { MemoryNode } from "../../src/memory/graph.js";
import {
  isMemoryNodeId,
  isMemorySubjectId,
  newMemoryNodeId,
  newMemorySubjectId,
} from "../../src/memory/schema.js";
import { isId } from "../../src/services/id.js";

/**
 * Who is who, read out of the graph's own labels.
 *
 * Every fixture here is the LIVE GRAPH of 2026-08-11, not invented data. That
 * matters twice: the duplicate wife is the defect being fixed, and the shared
 * surname is the trap that a naive fix walks into.
 */

let counter = 0;

function node(over: Partial<MemoryNode> & { readonly label: string }): MemoryNode {
  counter += 1;
  const suffix = String(counter).padStart(12, "0");
  return {
    id: `syl:memory_node:01991b2f-0000-7000-8000-${suffix}`,
    tier: "hot",
    kind: "person",
    body: null,
    subjectId: null,
    createdAt: "2026-08-10T09:00:00.000Z",
    updatedAt: "2026-08-10T09:00:00.000Z",
    ...over,
  };
}

/** The Commander's own node, as the extractor actually wrote it. */
function commander(): MemoryNode {
  return node({ label: "Justin Martin", body: "The Commander." });
}

describe("the identity namespace", () => {
  it("should mint an id that is an ENTITY and not a node", () => {
    const id = newMemorySubjectId();
    expect(isMemorySubjectId(id)).toBe(true);
    expect(isId(id, "memory_subject")).toBe(true);
    // The distinction the namespace exists to keep: `subject_id` holding a node
    // id would say "this node is a handle for that node", which is a different
    // claim from "these nodes are the same thing" and one `projection.ts` owns.
    expect(isMemoryNodeId(id)).toBe(false);
    expect(isMemorySubjectId(newMemoryNodeId())).toBe(false);
  });

  it("should mint a fresh identity every time", () => {
    expect(newMemorySubjectId()).not.toBe(newMemorySubjectId());
  });

  it("should satisfy the column's own CHECK", () => {
    // `memory_nodes.subject_id` CHECKs `GLOB 'syl:*:*'`, so an id that does not
    // match would be refused by SQLite rather than by anything in TypeScript.
    expect(newMemorySubjectId()).toMatch(/^syl:[a-z_]+:[0-9a-f-]+$/u);
  });
});

describe("reading a label the extractor wrote", () => {
  it("should split the descriptor the extractor appended from the name itself", () => {
    expect(parseLabel("Ela — his wife")).toEqual({ name: "Ela", descriptor: "his wife" });
    expect(parseLabel("Rowan — his son")).toEqual({ name: "Rowan", descriptor: "his son" });
    expect(parseLabel("Isla — his daughter")).toEqual({ name: "Isla", descriptor: "his daughter" });
  });

  it("should read a bare name as a name with no descriptor", () => {
    expect(parseLabel("Ela")).toEqual({ name: "Ela", descriptor: null });
  });

  it("should accept the hyphen and en-dash spellings, which the same model emits", () => {
    expect(parseLabel("Rowan - his son").descriptor).toBe("his son");
    expect(parseLabel("Rowan – his son").descriptor).toBe("his son");
  });

  it("should keep a parenthetical nickname with the NAME, not treat it as a descriptor", () => {
    const parsed = parseLabel('Robert C. Martin ("Uncle Bob") — his father');
    expect(parsed.name).toBe('Robert C. Martin ("Uncle Bob")');
    expect(parsed.descriptor).toBe("his father");
  });

  it("should not mistake a hyphenated name for a name and a descriptor", () => {
    // No spaces around the hyphen, so there is nothing to split on.
    expect(parseLabel("Anne-Marie")).toEqual({ name: "Anne-Marie", descriptor: null });
  });
});

describe("normalising a name for comparison", () => {
  it("should make two spellings of one woman compare equal", () => {
    expect(normaliseName(parseLabel("Ela — his wife").name)).toBe(
      normaliseName(parseLabel("Ela").name),
    );
  });

  it("should NOT merge the Commander with his father, who shares his surname", () => {
    // THE TRAP, live in the data on 2026-08-11. Any rule that matches on a
    // shared token — surname, substring, longest common suffix — collapses
    // these two, and a wrong merge is not demotable the way an edge is.
    const him = normaliseName(parseLabel("Justin Martin").name);
    const father = normaliseName(parseLabel('Robert C. Martin ("Uncle Bob") — his father').name);

    expect(him).not.toBe(father);
    expect(him.includes(father)).toBe(false);
    expect(father.includes(him)).toBe(false);
  });

  it("should fold case, punctuation and accents, which are spellings and not identities", () => {
    expect(normaliseName("ELA")).toBe(normaliseName("Ela"));
    expect(normaliseName("Robert C. Martin")).toBe(normaliseName("Robert C Martin"));
    expect(normaliseName("Éla")).toBe(normaliseName("Ela"));
    expect(normaliseName("  Ela   Marin ")).toBe(normaliseName("Ela Marin"));
  });

  it("should refuse a name too short to identify anybody", () => {
    // A one-character name would group every initial in the graph together.
    expect(normaliseName("E")).toBe("");
    expect(normaliseName("  ")).toBe("");
    expect(normaliseName("—")).toBe("");
  });
});

describe("grouping two mentions into one identity", () => {
  it("should resolve the two Elas to one identity", () => {
    const wife = node({ label: "Ela — his wife", body: "His wife Ela." });
    const bare = node({ label: "Ela", body: "Ela wants an apartment back home." });

    const groups = groupIdentities([commander(), wife, bare]);

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.verdict).toBe("merge");
    expect([...(group?.nodeIds ?? [])].sort()).toEqual([wife.id, bare.id].sort());
    expect(group?.reasoning).toContain("Ela");
  });

  it("should provably NOT propose merging the Commander with his father", () => {
    const groups = groupIdentities([
      commander(),
      node({ label: 'Robert C. Martin ("Uncle Bob") — his father', body: "His father." }),
    ]);

    expect(groups).toEqual([]);
  });

  it("should PROPOSE rather than apply when two mentions describe different people", () => {
    // Two Elas whose descriptors disagree are not evidence of one woman, they
    // are evidence of two. Auto-merging on the name alone is the mirror image
    // of the Uncle Bob trap and it costs the same to unpick.
    const wife = node({ label: "Ela — his wife" });
    const colleague = node({ label: "Ela — his colleague" });

    const groups = groupIdentities([wife, colleague]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.verdict).toBe("propose");
    expect(groups[0]?.confidence).toBeLessThan(0.5);
  });

  it("should adopt an identity a node already carries rather than minting a rival", () => {
    const existing = "syl:memory_subject:01991b2f-0000-7000-8000-0000000000ff";
    const wife = node({ label: "Ela — his wife", subjectId: existing });
    const bare = node({ label: "Ela" });

    const groups = groupIdentities([wife, bare]);

    expect(groups[0]?.verdict).toBe("merge");
    expect(groups[0]?.subjectId).toBe(existing);
    // Only the node that lacks one needs writing; re-stamping the other would
    // bump `updated_at` on every pass and make idempotence unobservable.
    expect(groups[0]?.nodeIds).toEqual([bare.id]);
  });

  it("should PROPOSE when two nodes already claim two different identities", () => {
    const wife = node({
      label: "Ela — his wife",
      subjectId: "syl:memory_subject:01991b2f-0000-7000-8000-0000000000f1",
    });
    const bare = node({
      label: "Ela",
      subjectId: "syl:memory_subject:01991b2f-0000-7000-8000-0000000000f2",
    });

    const groups = groupIdentities([wife, bare]);

    expect(groups[0]?.verdict).toBe("propose");
  });

  it("should say nothing at all about a node that already agrees", () => {
    const shared = "syl:memory_subject:01991b2f-0000-7000-8000-0000000000fa";
    const groups = groupIdentities([
      node({ label: "Ela — his wife", subjectId: shared }),
      node({ label: "Ela", subjectId: shared }),
    ]);

    expect(groups).toEqual([]);
  });

  it("should resolve people and nothing else", () => {
    // `memory_nodes_handle_idx` is UNIQUE on (subject_id, kind) for `goal` and
    // `source`, so two goals sharing an identity is a constraint violation and
    // not merely a bad idea. Identity is a claim about entities; `person` is
    // the kind that has them.
    expect(RESOLVABLE_KIND).toBe("person");

    const groups = groupIdentities([
      node({ kind: "fact", label: "Ela — his wife" }),
      node({ kind: "fact", label: "Ela" }),
      node({ kind: "goal", label: "Ela" }),
    ]);

    expect(groups).toEqual([]);
  });

  it("should ignore anything outside the scanned tier", () => {
    // A superseded or suppressed node was set aside on purpose. Pulling it into
    // a live identity would quietly resurrect what a correction retired.
    const groups = groupIdentities([
      node({ label: "Ela — his wife" }),
      node({ label: "Ela", tier: "suppressed" }),
    ]);

    expect(groups).toEqual([]);
  });
});

describe("finding the Commander in his own graph", () => {
  it("should recognise the node the extractor marked as him", () => {
    expect(isCommanderNode(commander())).toBe(true);
    expect(isCommanderNode(node({ label: "Ela — his wife", body: "His wife Ela." }))).toBe(false);
  });

  it("should decline rather than guess when nobody is marked", () => {
    expect(findCommanderNode([node({ label: "Ela — his wife" })])).toBeNull();
  });

  it("should decline rather than guess when two nodes claim to be him", () => {
    expect(findCommanderNode([commander(), commander()])).toBeNull();
  });
});

describe("moving a relationship out of the label and into the column", () => {
  it("should read `his wife` as a spouse edge to the Commander", () => {
    const him = commander();
    const wife = node({ label: "Ela — his wife", body: "His wife Ela." });

    const edges = proposeFromProse([him, wife]);

    expect(edges).toHaveLength(1);
    expect(edges[0]?.sourceNode).toBe(wife.id);
    expect(edges[0]?.targetNode).toBe(him.id);
    expect(edges[0]?.relation).toBe("spouse_of");
    expect(edges[0]?.confidence).toBe(PROSE_CONFIDENCE);
  });

  it("should quote the phrase it read, so the edge can be audited", () => {
    const edges = proposeFromProse([commander(), node({ label: "Ela — his wife" })]);
    expect(edges[0]?.reasoning).toContain("Ela — his wife");
    expect(edges[0]?.reasoning).toContain("his wife");
  });

  it("should read the children and the father in the directions they actually go", () => {
    const him = commander();
    const son = node({ label: "Rowan — his son" });
    const daughter = node({ label: "Isla — his daughter" });
    const father = node({ label: 'Robert C. Martin ("Uncle Bob") — his father' });

    const edges = proposeFromProse([him, son, daughter, father]);
    const by = (id: string) => edges.find((edge) => edge.sourceNode === id);

    expect(by(son.id)?.relation).toBe("child_of");
    expect(by(daughter.id)?.relation).toBe("child_of");
    expect(by(father.id)?.relation).toBe("parent_of");
    for (const edge of edges) expect(edge.targetNode).toBe(him.id);
  });

  it("should write NOTHING when it cannot name the relation", () => {
    // The whole discipline in one test. "his colleague", "his old friend from
    // school" — real relationships with no name in the closed vocabulary. An
    // `about` edge here would be the escape hatch used as a shrug.
    const edges = proposeFromProse([
      commander(),
      node({ label: "Ela — his colleague" }),
      node({ label: "Sam — his old friend from school" }),
      node({ label: "Kit — someone he mentioned" }),
    ]);

    expect(edges).toEqual([]);
  });

  it("should refuse a descriptor that is not about HIM", () => {
    // "the wife of the chief executive" inside a pasted article is not his
    // wife. The possessive is what makes the descriptor a claim about the
    // Commander, so it is required rather than inferred.
    const edges = proposeFromProse([
      commander(),
      node({ label: "Marta — the wife of the chief executive" }),
      node({ label: "Nia — her daughter" }),
    ]);

    expect(edges).toEqual([]);
  });

  it("should write nothing at all when it cannot tell which node is the Commander", () => {
    const edges = proposeFromProse([node({ label: "Ela — his wife" }), node({ label: "Rowan — his son" })]);
    expect(edges).toEqual([]);
  });

  it("should never propose an edge from the Commander to himself", () => {
    const him = commander();
    const alsoHim = node({ label: "Justin Martin — his own name", body: "The Commander." });

    for (const edge of proposeFromProse([him, alsoHim])) {
      expect(edge.sourceNode).not.toBe(edge.targetNode);
    }
  });
});
