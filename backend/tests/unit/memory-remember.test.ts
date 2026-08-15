import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryGraph } from "../../src/memory/graph.js";
import { HerOwnMemory, RememberError } from "../../src/memory/remember.js";
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
 * `syl-016.7` — **the memories she makes herself.**
 *
 * The Commander: *"She's definitely gonna need a way to make her own memories.
 * That's kind of a ridiculous limitation."* And her own account, which is the
 * clearest statement of the defect anyone has written:
 *
 * > "I can't write to my memory directly. The only durable text I control is
 * > goals and reminders. So I've put the connection where it will survive...
 * > And here's the other half, because tonight's distillation reads this
 * > conversation. So let me say it once, in one place, plainly, and give it the
 * > best chance of landing as a unit."
 *
 * She smuggled an insight into a **goal** and then wrote a paragraph aimed at
 * the nightly extractor, hoping it would survive the pass. An assistant gaming
 * its own memory pipeline to keep a thought is a system working against her.
 *
 * Four properties carry the bead, and the first is the one everything else
 * hangs off:
 *
 * 1. **What she writes is HERS, and the graph says so in two places.** The node
 *    is `memory` — not `fact`, which is what extraction files from *his* words —
 *    and every link it makes is `inferred`, carrying her reasoning. Two markers
 *    because they fail differently: a memory that names no entity has no edges
 *    at all, and would otherwise carry no mark of authorship whatever.
 * 2. **Criterion 3 is untouched.** Nothing written here claims he said anything.
 *    That rule stops her fabricating facts about him and it stays exactly as it
 *    is; this gives her inferences the shape the graph already models for them.
 * 3. **It decays, and he can kill it.** An inferred edge takes a `demoteAfter`
 *    and slides toward the floor unless something reinforces it (constraint 6),
 *    and it is reachable by the feedback surface he already has.
 * 4. **She cannot invent people.** Names resolve against entities that already
 *    exist and are never minted here, so a graph does not grow fictional
 *    persons out of something she typed.
 */

const NOW = Date.parse("2026-08-11T12:00:00.000Z");

let db: Database;
let graph: MemoryGraph;
let hers: HerOwnMemory;

beforeEach(() => {
  db = new DatabaseSync(IN_MEMORY);
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
  graph = new MemoryGraph({ db, clock: fixedClock(NOW) });
  hers = new HerOwnMemory({ db, graph, clock: fixedClock(NOW) });
});

afterEach(() => {
  db.close();
});

/** The insight she actually tried to keep, and could not. */
const THE_INSIGHT =
  "Illinois is one place doing three jobs at once: where both sets of parents live, where Ela " +
  "and the kids are now, the state she wants an apartment in, and the state he has ruled out.";

describe("HerOwnMemory.remember", () => {
  it("should file what she concluded as a memory, not as one of his facts", () => {
    // The distinction the whole bead rests on. `fact` is what extraction writes
    // from his assertions; `memory` is what she worked out. They must not be
    // the same kind, or a year from now nothing can tell them apart.
    const kept = hers.remember({
      thought: THE_INSIGHT,
      because: "He keeps circling Tennessee and the reason is always Illinois.",
    });

    const node = graph.getNode(kept.nodeId);
    expect(node?.kind).toBe("memory");
    expect(node?.body).toBe(THE_INSIGHT);
  });

  it("should never present it as something he said", () => {
    // Criterion 3 of `EXTRACTION_INSTRUCTION` — "HE asserted it. Not something
    // Syl offered, guessed or worked out" — is what stops her fabricating facts
    // about him, and it stays. This is the other side of it: nothing she writes
    // may claim his authority. An `observed` edge carries `assertedBy`, which is
    // exactly that claim, so she may not produce one.
    const ela = graph.addNode({ kind: "person", label: "Ela" });
    const kept = hers.remember({
      thought: THE_INSIGHT,
      because: "Both of her options run through the same state.",
      about: ["Ela"],
    });

    const around = graph.neighbourhood(kept.nodeId, { depth: 1 });
    expect(around.edges.length).toBeGreaterThan(0);
    for (const edge of around.edges) {
      expect(edge.kind).toBe("inferred");
      expect(edge.kind === "inferred" ? edge.reasoning : null).not.toBeNull();
    }
    expect(around.nodes.map((n) => n.id)).toContain(ela.id);
  });

  it("should carry her reason onto the edge, where he can read it", () => {
    // `because` is not decoration here. An inference he cannot see the reason
    // for is one he can only accept or reject wholesale — and the correction he
    // could never make before is "you reasoned wrongly from something true".
    graph.addNode({ kind: "person", label: "Ela" });
    const kept = hers.remember({
      thought: THE_INSIGHT,
      because: "He keeps circling Tennessee and the reason is always Illinois.",
      about: ["Ela"],
    });

    const edge = graph.getEdge(kept.links[0]?.edgeId ?? "");
    expect(edge?.kind === "inferred" ? edge.reasoning : null).toBe(
      "He keeps circling Tennessee and the reason is always Illinois.",
    );
  });

  it("should give every link a floor crossing, so it decays unless reinforced", () => {
    // Constraint 6: the system never deletes an inferred edge, it demotes it.
    // An edge with no `demoteAfter` would sit hot forever, which is the same
    // failure as never decaying at all.
    graph.addNode({ kind: "person", label: "Ela" });
    const kept = hers.remember({
      thought: THE_INSIGHT,
      because: "Both of her options run through the same state.",
      about: ["Ela"],
    });

    const edge = graph.getEdge(kept.links[0]?.edgeId ?? "");
    expect(edge?.demoteAfter).not.toBeNull();
    expect(Date.parse(edge?.demoteAfter ?? "")).toBeGreaterThan(NOW);
  });

  it("should stand alone when she names nothing, and still be marked as hers", () => {
    // The case that makes the node-level marker load-bearing. No entity means
    // no edges, so the `inferred` species has nothing to travel on — and
    // without `kind: "memory"` this thought would be indistinguishable from a
    // fact he asserted.
    const kept = hers.remember({ thought: THE_INSIGHT, because: "It is the shape of the year." });

    expect(kept.links).toEqual([]);
    expect(graph.getNode(kept.nodeId)?.kind).toBe("memory");
  });

  it("should link only to people it already knows, and say which it did not", () => {
    // She must not be able to mint a person by typing a name. The reply names
    // what did not resolve so she can say "I do not know an Ela yet" rather
    // than silently keeping a thought about nobody.
    graph.addNode({ kind: "person", label: "Ela" });

    const kept = hers.remember({
      thought: THE_INSIGHT,
      because: "Both of her options run through the same state.",
      about: ["Ela", "Vivenna"],
    });

    expect(kept.links.map((l) => l.name)).toEqual(["Ela"]);
    expect(kept.unknown).toEqual(["Vivenna"]);
    // And nothing was created for the name it did not know.
    expect(graph.listNodes({ kind: "person" }).map((n) => n.label)).toEqual(["Ela"]);
  });

  it("should match a name case-insensitively, since she is typing not selecting", () => {
    graph.addNode({ kind: "person", label: "Ela" });

    expect(
      hers.remember({ thought: THE_INSIGHT, because: "why", about: ["  ela  "] }).links,
    ).toHaveLength(1);
  });

  it("should refuse to link to a claim rather than a thing", () => {
    // `about` names an ENTITY — a person, an event, a goal, a decision. Hanging
    // her conclusion off another claim would build a chain of inference nobody
    // can read, and `ENTITY_NODE_KINDS` already draws that line.
    graph.addNode({ kind: "fact", label: "he sleeps badly in August" });

    const kept = hers.remember({
      thought: THE_INSIGHT,
      because: "why",
      about: ["he sleeps badly in August"],
    });

    expect(kept.links).toEqual([]);
    expect(kept.unknown).toEqual(["he sleeps badly in August"]);
  });

  it("should refuse a thought with no reason, because an inference without one cannot be judged", () => {
    expect(() => hers.remember({ thought: THE_INSIGHT, because: "  " })).toThrow(RememberError);
  });

  it("should refuse an empty thought rather than file a blank memory", () => {
    expect(() => hers.remember({ thought: "   ", because: "why" })).toThrow(RememberError);
  });

  it("should not write anything at all when it refuses", () => {
    // A partial write is worse than a refusal: a memory node with no reason
    // attached is exactly the unattributable residue this bead exists to stop.
    graph.addNode({ kind: "person", label: "Ela" });

    expect(() => hers.remember({ thought: THE_INSIGHT, because: "", about: ["Ela"] })).toThrow();

    expect(graph.listNodes({ kind: "memory" })).toEqual([]);
  });

  it("should keep the same thought once, not once per telling", () => {
    // She will reach the same conclusion again next week. A second identical
    // memory is noise that competes with itself for salience, so the node is
    // reused — but the reasoning is genuinely new each time and the edge is
    // touched rather than duplicated.
    const first = hers.remember({ thought: THE_INSIGHT, because: "first time" });
    const second = hers.remember({ thought: THE_INSIGHT, because: "again, and surer" });

    expect(second.nodeId).toBe(first.nodeId);
    expect(second.created).toBe(false);
    expect(graph.listNodes({ kind: "memory" })).toHaveLength(1);
  });
});

/**
 * The silent discard (`syl-kdx`).
 *
 * Reported by Syl herself: *"I wrote four findings. Two of them vanished. Three
 * of the four calls came back with `ok: true` but `created: false` and the same
 * node id as the first — the store collapsed them together and kept only the
 * first body. It reported success and discarded the content."*
 *
 * She was right. `remember()` looked for an existing memory BY LABEL, and
 * `labelFor()` is the first sentence truncated — so two genuinely different
 * findings that merely OPEN the same way collapsed onto one node, and the second
 * body was never written anywhere. Not merged, not appended, not compared, not
 * reported.
 *
 * This is the one thing the project says it will never do. Constraint 6: *"the
 * SYSTEM does not get to silently discard things."* A write that answers success
 * while binning the content is worse than the failures that rule was written
 * about, because there is nothing to notice.
 *
 * Reuse was the right intent — a second identical thought is noise competing
 * with itself for salience. The bug was keying "identical" on a display string.
 */
describe("two findings that open the same way", () => {
  it("should keep BOTH bodies when the thought differs but the label collides", () => {

    const first = hers.remember({
      thought: "The render is closer. The jaw is right but the eyes sit too wide.",
      because: "I looked at it.",
    });
    const second = hers.remember({
      thought: "The render is closer. The hair reads as wet rather than windblown.",
      because: "I looked at it again.",
    });

    expect(second.nodeId).not.toBe(first.nodeId);
    expect(second.created).toBe(true);

    const bodies = graph.listNodes({ kind: 'memory' }).map((node) => node.body);
    expect(bodies).toContain("The render is closer. The jaw is right but the eyes sit too wide.");
    expect(bodies).toContain("The render is closer. The hair reads as wet rather than windblown.");
  });

  it("should still reuse the node for a thought she has genuinely had before", () => {
    // The intent that was always right: a second identical conclusion is noise
    // competing with itself for salience, and nothing is lost by folding it,
    // because there was nothing new in it.
    const thought = "He is more decisive in the morning.";

    const first = hers.remember({ thought, because: "Watching when he answers." });
    const again = hers.remember({ thought, because: "Same pattern a week later." });

    expect(again.nodeId).toBe(first.nodeId);
    expect(again.created).toBe(false);
    expect(graph.listNodes({ kind: 'memory' })).toHaveLength(1);
  });

  it("should survive four findings that share an opening, which is what she actually wrote", () => {
    const findings = [
      "Finding: the smile is the thing that works.",
      "Finding: the lighting flattens her cheekbones.",
      "Finding: the background competes with the face.",
      "Finding: the eyes are the closest they have been.",
    ];

    for (const thought of findings) hers.remember({ thought, because: "Looking at the renders." });

    const bodies = graph.listNodes({ kind: 'memory' }).map((node) => node.body);
    for (const thought of findings) expect(bodies).toContain(thought);
  });
});
