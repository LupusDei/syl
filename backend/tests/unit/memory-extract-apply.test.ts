import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ABOUT_RELATION,
  ConversationExtractor,
  DEFAULT_CONVERSATION_LABEL,
  ENTITY_RECURRENCE_THRESHOLD,
  ExtractionApplyError,
  ExtractionStore,
  FACT_IDENTITY_SQL,
  MAX_QUOTE_CHARS,
  quoteOf,
  QUOTE_TRUNCATED,
  RECURRENCE_GATED_KINDS,
  STATED_RELATION,
} from "../../src/memory/extract-apply.js";
import {
  EXTRACTABLE_KINDS,
  ExtractionShapeError,
  transcriptDigest,
  type CandidateFact,
  type Extraction,
  type TranscriptMessage,
} from "../../src/memory/extract.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { ENTITY_NODE_KINDS } from "../../src/memory/schema.js";
import { projectGoal, projectInto } from "../../src/memory/projection.js";
import { fixedClock } from "../../src/services/clock.js";
import {
  applyMigrations,
  applyPragmas,
  IN_MEMORY,
  INTERACTIVE_CONVERSATION_ID,
  MIGRATIONS_DIR,
  readMigrations,
} from "../../src/services/database.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/**
 * The guarantee half: what the service does with a judgment it has been handed.
 *
 * Against the real migrations, because two of the properties under test are
 * facts about the schema rather than about this code — `memory_nodes_handle_idx`
 * is what makes one source node per conversation true, and
 * `memory_extractions.digest` is what makes a replay free.
 *
 * The clock is frozen (`syl-wh6`): a test that compares stored instants against
 * the real clock fails on a calendar boundary and looks exactly like flake.
 */

const NOW = Date.parse("2026-08-10T09:00:00.000Z");
const MESSAGE_A = "syl:message:01991b2f-0000-7000-8000-00000000000a";
const MESSAGE_B = "syl:message:01991b2f-0000-7000-8000-00000000000b";

const HE_SAID = "My daughter is called Vivenna.";

const TRANSCRIPT: readonly TranscriptMessage[] = [
  { id: MESSAGE_A, role: "user", text: HE_SAID },
  { id: MESSAGE_B, role: "assistant", text: "Noted." },
];

const OTHER_TRANSCRIPT: readonly TranscriptMessage[] = [
  { id: MESSAGE_A, role: "user", text: "Vivenna is at Bishop's, by the way." },
  { id: MESSAGE_B, role: "assistant", text: "Understood." },
];

function candidate(over: Partial<CandidateFact> = {}): CandidateFact {
  return {
    kind: "person",
    label: "Vivenna",
    body: "The Commander's daughter.",
    saidIn: 1,
    about: null,
    why: "He called her his daughter outright.",
    ...over,
  };
}

function extraction(over: Partial<Extraction> = {}): Extraction {
  return { facts: [candidate()], instructionsFound: [], ...over };
}

let db: Database;
let graph: MemoryGraph;
let store: ExtractionStore;

beforeEach(() => {
  db = new DatabaseSync(IN_MEMORY);
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
  graph = new MemoryGraph({ db, clock: fixedClock(NOW) });
  store = new ExtractionStore({ db, graph, clock: fixedClock(NOW) });
});

function apply(
  over: {
    readonly conversationId?: string;
    readonly transcript?: readonly TranscriptMessage[];
    readonly extraction?: Extraction;
  } = {},
): ReturnType<ExtractionStore["apply"]> {
  return store.apply({
    conversationId: over.conversationId ?? INTERACTIVE_CONVERSATION_ID,
    transcript: over.transcript ?? TRANSCRIPT,
    extraction: over.extraction ?? extraction(),
  });
}

describe("provenance", () => {
  it("should hang every filed fact off a source node for the conversation", () => {
    const result = apply();

    const source = graph.getNode(result.sourceNodeId);
    expect(source?.kind).toBe("source");
    expect(source?.subjectId).toBe(INTERACTIVE_CONVERSATION_ID);
    expect(source?.label).toBe(DEFAULT_CONVERSATION_LABEL);

    const edges = graph.edgesAssertedBy(result.sourceNodeId);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.relation).toBe(STATED_RELATION);
    expect(edges[0]?.targetNode).toBe(result.facts[0]?.nodeId);
  });

  it("should file OBSERVATIONS, never inferences — extraction may not speculate", () => {
    const result = apply();
    const edge = graph.edgesBetween(result.sourceNodeId, result.facts[0]?.nodeId ?? "")[0];
    expect(edge?.kind).toBe("observed");
    // Narrowing is the point: an observed edge has no confidence to carry.
    if (edge?.kind !== "observed") throw new Error("expected an observation");
    expect(edge.assertedBy).toBe(result.sourceNodeId);
    expect(edge.confidence).toBeNull();
  });

  it("should record which message asserted the fact, so it can be traced to a row", () => {
    const result = apply();
    const nodeId = result.facts[0]?.nodeId ?? "";
    expect(store.provenanceFor(nodeId)[0]?.saidIn).toBe(MESSAGE_A);
  });

  it("should leave the fact's body as JUST the fact", () => {
    // It used to read "The Commander's daughter. (said in syl:message:…)" —
    // plumbing inside the sentence she reads back, and still not the reasoning.
    const result = apply();
    expect(graph.getNode(result.facts[0]?.nodeId ?? "")?.body).toBe("The Commander's daughter.");
  });

  it("should refuse to file anything against something that is not a conversation", () => {
    expect(() => apply({ conversationId: "syl:goal:01991b2f-0000-7000-8000-0000000000cd" })).toThrow(
      ExtractionApplyError,
    );
    expect(() => apply({ conversationId: "not-an-id" })).toThrow(/rumour/);
  });

  it("should reuse the one source node for a second exchange in the same conversation", () => {
    const first = apply();
    const second = apply({ transcript: OTHER_TRANSCRIPT });
    expect(second.sourceNodeId).toBe(first.sourceNodeId);
    expect(graph.listNodes({ kind: "source", limit: 50 })).toHaveLength(1);
  });
});

describe("the fact node", () => {
  it("should carry no subjectId — a conversational fact is not a handle for a row", () => {
    const result = apply();
    expect(graph.getNode(result.facts[0]?.nodeId ?? "")?.subjectId).toBeNull();
  });

  it("should be reused when the same thing is said again, not duplicated", () => {
    const first = apply();
    const second = apply({ transcript: OTHER_TRANSCRIPT });

    expect(second.facts[0]?.nodeId).toBe(first.facts[0]?.nodeId);
    expect(second.created).toBe(0);
    expect(second.reused).toBe(1);
    expect(graph.listNodes({ kind: "person", limit: 50 })).toHaveLength(1);
  });

  it("should not resurrect a superseded node — a correction stays a correction", () => {
    const first = apply();
    const node = graph.getNode(first.facts[0]?.nodeId ?? "");
    if (node === null) throw new Error("expected a node");
    graph.supersedeNode(node);

    const second = apply({ transcript: OTHER_TRANSCRIPT });
    expect(second.facts[0]?.nodeId).not.toBe(first.facts[0]?.nodeId);
    expect(second.created).toBe(1);
  });

  it("should never mutate a node it reuses, so a projected handle stays a handle", () => {
    const goal = projectInto(
      graph,
      projectGoal({ id: "syl:goal:01991b2f-0000-7000-8000-0000000000cd", title: "Ship Syl" }),
    );

    apply({
      extraction: extraction({
        facts: [candidate({ kind: "goal", label: "Ship Syl", body: "He wants Syl shipped." })],
      }),
    });

    const after = graph.getNode(goal.projection.id);
    expect(after?.label).toBe("Ship Syl");
    // The four-field contract has no body. Attaching provenance must not add one.
    expect(after?.body).toBeNull();
    expect(graph.edgesAssertedBy(apply({ transcript: OTHER_TRANSCRIPT }).sourceNodeId).length)
      .toBeGreaterThan(0);
  });

  it("should look a fact up without a tier predicate in the SQL", () => {
    // The tier restriction is a policy binding, not a partitioning fact. A
    // literal `tier = 'hot'` in the text would make the index tier-leading and
    // quietly stop finding anything outside the hot partition.
    expect(FACT_IDENTITY_SQL).not.toMatch(/tier\s*=\s*'/);
    expect(FACT_IDENTITY_SQL).toContain("kind = ?");
    expect(FACT_IDENTITY_SQL).toContain("label = ?");
  });
});

// --------------------------- syl-016.3: nothing compared a candidate to what ---
// --------------------------- was already there                               ---

describe("comparing a candidate against what the graph already holds", () => {
  /**
   * Syl's diagnosis, and the half of it a machine can settle on its own:
   *
   * > "Nothing merged them, because nothing compares a new memory to what's
   * > already there."
   *
   * Only the EXACT cases are automatic. A synonym is a judgement and
   * `supersede.ts` §1 measures what happens when a threshold makes it — 0.82
   * accuracy down to 0.62 — so `tidy.ts` nominates those and Syl merges them.
   */

  it("should reuse a node whose label differs only in case", () => {
    const first = apply({ extraction: extraction({ facts: [candidate({ label: "Vivenna" })] }) });
    const second = apply({
      transcript: OTHER_TRANSCRIPT,
      extraction: extraction({ facts: [candidate({ label: "vivenna" })] }),
    });

    expect(second.facts[0]?.created).toBe(false);
    expect(second.facts[0]?.nodeId).toBe(first.facts[0]?.nodeId);
    expect(graph.listNodes({ kind: "person" })).toHaveLength(1);
  });

  it("should reuse a node whose label differs only in spacing", () => {
    const first = apply({
      extraction: extraction({ facts: [candidate({ label: "Family compound" })] }),
    });
    const second = apply({
      transcript: OTHER_TRANSCRIPT,
      extraction: extraction({ facts: [candidate({ label: " Family   compound\n" })] }),
    });

    expect(second.facts[0]?.created).toBe(false);
    expect(second.facts[0]?.nodeId).toBe(first.facts[0]?.nodeId);
  });

  it("should keep the wording he used, rather than folding the stored label too", () => {
    const result = apply({ extraction: extraction({ facts: [candidate({ label: "Ela" })] }) });
    expect(graph.getNode(result.facts[0]?.nodeId ?? "")?.label).toBe("Ela");
  });

  it("should keep a contradiction as two nodes, which is what a similarity merge would eat first", () => {
    const first = apply({
      extraction: extraction({
        facts: [candidate({ kind: "fact", label: "He lives in Buda", about: null })],
      }),
    });
    const second = apply({
      transcript: OTHER_TRANSCRIPT,
      extraction: extraction({
        facts: [candidate({ kind: "fact", label: "He moved to Nashville", about: null })],
      }),
    });

    // Same subject, same frame, most of the same tokens — near neighbours in
    // any embedding, and the pair it matters most to keep apart, because one is
    // the correction of the other. `supersede.ts` §1 measures what collapsing
    // them costs: 0.82 accuracy down to 0.62. Loosening FACT_IDENTITY_SQL to a
    // distance would eat this pair and leave one confident, ordinary-looking
    // node behind.
    expect(second.facts[0]?.nodeId).not.toBe(first.facts[0]?.nodeId);
    expect(graph.listNodes({ kind: "fact" })).toHaveLength(2);
  });

  it("should still mint a second node for a label that is genuinely different", () => {
    apply({ extraction: extraction({ facts: [candidate({ label: "Tennessee possibility" })] }) });
    const second = apply({
      transcript: OTHER_TRANSCRIPT,
      extraction: extraction({ facts: [candidate({ label: "Building in Tennessee" })] }),
    });

    // Not a regression: this is the case a distance function must not decide.
    // It is `tidy.duplicates()` that nominates it and Syl who merges it.
    expect(second.facts[0]?.created).toBe(true);
    expect(graph.listNodes({ kind: "person" })).toHaveLength(2);
  });

  it("should fold case in the comparison and nowhere else", () => {
    expect(FACT_IDENTITY_SQL).toContain("label = ? COLLATE NOCASE");
  });
});

// ------------------------------------------------- syl-016.4: what a kind is ---

/** Her example, filed correctly: Ela is a person, what she wants is a fact. */
const ELA_AND_HER_SEARCH: readonly CandidateFact[] = [
  candidate({ kind: "person", label: "Ela", body: "The Commander's sister." }),
  candidate({
    kind: "fact",
    label: "Ela's apartment search",
    body: "Ela wants an apartment near her parents.",
    about: 1,
  }),
];

describe("linking a claim to the thing it is about", () => {
  it("should file the person as a person and the claim as a fact beside her", () => {
    const result = apply({ extraction: extraction({ facts: ELA_AND_HER_SEARCH }) });

    const ela = graph.getNode(result.facts[0]?.nodeId ?? "");
    expect(ela?.kind).toBe("person");
    // The defect, stated as an assertion: her entry says who she is and does
    // not say what she wants. That is what makes the People bucket mean people.
    expect(ela?.body).toBe("The Commander's sister.");
    expect(graph.getNode(result.facts[1]?.nodeId ?? "")?.kind).toBe("fact");
  });

  it("should draw the edge from the claim to the entity, by a relation IT did not choose", () => {
    const result = apply({ extraction: extraction({ facts: ELA_AND_HER_SEARCH }) });
    const search = result.facts[1];

    expect(search?.aboutNodeId).toBe(result.facts[0]?.nodeId);
    const edge = graph.edgesBetween(search?.nodeId ?? "", result.facts[0]?.nodeId ?? "")[0];
    expect(edge?.relation).toBe(ABOUT_RELATION);
    expect(edge?.sourceNode).toBe(search?.nodeId);
  });

  it("should make that link an OBSERVATION the conversation vouches for", () => {
    // A link nobody asserted is a rumour about a relationship, and the species
    // is decided here rather than by the turn — same rule as the fact itself.
    const result = apply({ extraction: extraction({ facts: ELA_AND_HER_SEARCH }) });
    const edge = graph.edgesBetween(
      result.facts[1]?.nodeId ?? "",
      result.facts[0]?.nodeId ?? "",
    )[0];

    expect(edge?.kind).toBe("observed");
    if (edge?.kind !== "observed") throw new Error("expected an observation");
    expect(edge.assertedBy).toBe(result.sourceNodeId);
  });

  it("should draw nothing when the candidate stands on its own", () => {
    const result = apply();
    expect(result.facts[0]?.aboutNodeId).toBeNull();
    expect(result.facts[0]?.aboutEdgeId).toBeNull();
  });

  it("should not duplicate the link when the same pair is stated again", () => {
    apply({ extraction: extraction({ facts: ELA_AND_HER_SEARCH }) });
    const again = apply({
      transcript: OTHER_TRANSCRIPT,
      extraction: extraction({ facts: ELA_AND_HER_SEARCH }),
    });

    expect(again.facts[1]?.aboutEdgeId).toBeNull();
    expect(again.facts[1]?.aboutNodeId).toBe(again.facts[0]?.nodeId);
  });

  it("should skip the link rather than lose the exchange when both entries are one node", () => {
    // Two candidates that `(kind, label)` reuse collapses onto a single node
    // would ask the graph for a self-edge, and that refusal would discard the
    // whole apply. A duplicated entry is not worth an exchange.
    const facts = [
      candidate({ kind: "person", label: "Ela", body: "The Commander's sister." }),
      candidate({ kind: "person", label: "Ela", body: "The Commander's sister.", about: 1 }),
    ];
    const result = apply({ extraction: extraction({ facts }) });

    expect(result.facts[1]?.aboutEdgeId).toBeNull();
    expect(result.facts[0]?.nodeId).toBe(result.facts[1]?.nodeId);
  });
});

// --------------------------------------- syl-016.5: the step, not the residue ---

describe("provenance", () => {
  it("should keep HIS WORDS, derived from the transcript rather than asked for", () => {
    const result = apply();
    const provenance = store.provenanceFor(result.facts[0]?.nodeId ?? "")[0];

    expect(provenance?.quote).toBe(HE_SAID);
    expect(provenance?.saidIn).toBe(MESSAGE_A);
    expect(provenance?.digest).toBe(transcriptDigest(TRANSCRIPT));
    expect(provenance?.createdAt).toBe("2026-08-10T09:00:00.000Z");
  });

  it("should keep the step the turn declared, which is what he can argue with", () => {
    // The whole of syl-016.5: "he can only say a fact is wrong, never that she
    // reasoned wrongly from something true".
    const result = apply();
    expect(store.provenanceFor(result.facts[0]?.nodeId ?? "")[0]?.why).toBe(
      "He called her his daughter outright.",
    );
  });

  it("should quote the message the fact was attributed to, not merely the last one", () => {
    const transcript: readonly TranscriptMessage[] = [
      { id: MESSAGE_A, role: "user", text: "Is Vivenna's school sorted?" },
      { id: MESSAGE_B, role: "user", text: "She starts at Bishop's in September." },
    ];
    const result = store.apply({
      conversationId: INTERACTIVE_CONVERSATION_ID,
      transcript,
      extraction: extraction({ facts: [candidate({ saidIn: 2 })] }),
    });

    expect(store.provenanceFor(result.facts[0]?.nodeId ?? "")[0]?.quote).toBe(
      "She starts at Bishop's in September.",
    );
  });

  it("should record a provenance for a REUSED node too, not just a new one", () => {
    // A fact he states twice has two provenances. Keeping only the first would
    // lose the words he most recently stood behind.
    const first = apply();
    apply({ transcript: OTHER_TRANSCRIPT });

    const rows = store.provenanceFor(first.facts[0]?.nodeId ?? "");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.quote)).toContain("Vivenna is at Bishop's, by the way.");
  });

  it("should record one per fact, including the linked claim", () => {
    const result = apply({ extraction: extraction({ facts: ELA_AND_HER_SEARCH }) });
    expect(store.provenanceFor(result.facts[0]?.nodeId ?? "")).toHaveLength(1);
    expect(store.provenanceFor(result.facts[1]?.nodeId ?? "")).toHaveLength(1);
  });

  it("should go when the node goes, so his words leave no residue behind", () => {
    // CLAUDE.md constraint 6's exception warns about exactly this table's
    // shape. `ON DELETE CASCADE` with `PRAGMA foreign_keys` on is what makes
    // it structural rather than something a deletion pass must remember.
    const result = apply();
    const nodeId = result.facts[0]?.nodeId ?? "";
    expect(store.provenanceFor(nodeId)).toHaveLength(1);

    db.prepare("DELETE FROM memory_edges WHERE target_node = ?").run(nodeId);
    db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(nodeId);
    expect(store.provenanceFor(nodeId)).toEqual([]);
  });

  it("should return nothing for a node nobody extracted", () => {
    expect(store.provenanceFor("syl:memory_node:01991b2f-0000-7000-8000-0000000000ff")).toEqual([]);
  });
});

describe("quoteOf", () => {
  it("should copy his words verbatim, trimmed", () => {
    expect(quoteOf("  My daughter is called Vivenna.  ")).toBe("My daughter is called Vivenna.");
  });

  it("should MARK a quote it had to cut, so a truncation never reads as a full stop", () => {
    // A cut that looks like a finished sentence is worse than a long one: the
    // quote is the evidence the reasoning gets checked against.
    const long = `${"a".repeat(MAX_QUOTE_CHARS)} and then the part that matters`;
    const quote = quoteOf(long);

    expect(quote.endsWith(QUOTE_TRUNCATED)).toBe(true);
    expect(quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS + QUOTE_TRUNCATED.length);
  });

  it("should not mark a quote that fitted", () => {
    expect(quoteOf("a".repeat(MAX_QUOTE_CHARS))).not.toContain(QUOTE_TRUNCATED);
  });
});

describe("idempotence", () => {
  it("should write nothing the second time the same exchange is applied", () => {
    const first = apply();
    expect(first.applied).toBe(true);

    const second = apply();
    expect(second.applied).toBe(false);
    expect(second.changed).toBe(false);
    expect(second.facts).toEqual([]);
    expect(graph.listNodes({ kind: "person", limit: 50 })).toHaveLength(1);
    expect(graph.edgesAssertedBy(first.sourceNodeId)).toHaveLength(1);
  });

  it("should record a DECLINED extraction too — 'looked and found nothing' is not 'never looked'", () => {
    const result = apply({ extraction: extraction({ facts: [] }) });
    expect(result.applied).toBe(true);
    expect(result.facts).toEqual([]);

    const record = store.recordsFor(INTERACTIVE_CONVERSATION_ID)[0];
    expect(record?.facts).toBe(0);
    expect(record?.createdNodes).toBe(0);
  });

  it("should count what it filed, so the design's claims can be checked later", () => {
    apply();
    const record = store.recordsFor(INTERACTIVE_CONVERSATION_ID)[0];
    expect(record?.facts).toBe(1);
    expect(record?.createdNodes).toBe(1);
    expect(record?.createdAt).toBe("2026-08-10T09:00:00.000Z");
  });

  it("should not add a second provenance edge when one conversation says it twice", () => {
    const first = apply();
    const again = apply({
      transcript: OTHER_TRANSCRIPT,
      extraction: extraction(),
    });
    expect(again.facts[0]?.edgeId).toBeNull();
    expect(graph.edgesAssertedBy(first.sourceNodeId)).toHaveLength(1);
  });

  it("should leave nothing behind when a write partway through is refused", () => {
    // All-or-nothing. A crash halfway would otherwise leave facts in the graph
    // with no ledger row, so the retry would file them a second time — the
    // exact duplication the ledger exists to prevent.
    const broken = new ExtractionStore({
      db,
      graph: new Proxy(graph, {
        get(target, property) {
          if (property === "observe") {
            return () => {
              throw new ExtractionShapeError("forced failure partway through the write");
            };
          }
          // Bound to the TARGET, not to the proxy: `MemoryGraph` keeps its
          // handle in a `#private` field, and a method invoked with the proxy
          // as `this` throws "cannot read private member" before it reaches
          // anything this test is about.
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as MemoryGraph,
      clock: fixedClock(NOW),
    });

    expect(() =>
      broken.apply({
        conversationId: INTERACTIVE_CONVERSATION_ID,
        transcript: TRANSCRIPT,
        extraction: extraction(),
      }),
    ).toThrow(/forced failure/);

    // The node and the source handle were both written before the refusal, so
    // this is a real rollback assertion and not a vacuous one.
    expect(store.recordFor(transcriptDigest(TRANSCRIPT))).toBeNull();
    expect(store.recordsFor(INTERACTIVE_CONVERSATION_ID)).toEqual([]);
    expect(graph.listNodes({ kind: "person", limit: 50 })).toHaveLength(0);
    expect(graph.listNodes({ kind: "source", limit: 50 })).toHaveLength(0);

    // And the exchange is still extractable afterwards: the failure left no
    // ledger row, so a retry is a first attempt rather than a replay.
    expect(apply().applied).toBe(true);
  });

  it("should roll back the nodes and the ledger when a PROVENANCE row is refused", () => {
    // The savepoint has to cover the last step as well as the first, and this
    // is the one that runs last. `asExtraction` cannot produce a blank `why`,
    // so this reaches the store the only way it can — around the validator —
    // and lands after a good provenance row has already gone in. A quote left
    // behind for a fact the graph never acquired is exactly the half-write the
    // savepoint exists to prevent.
    const facts = [candidate(), candidate({ label: "Nightblood", why: "   " })];

    expect(() => apply({ extraction: extraction({ facts }) })).toThrow();

    expect(db.prepare("SELECT count(*) AS n FROM memory_provenance").get()).toEqual({ n: 0 });
    expect(store.recordFor(transcriptDigest(TRANSCRIPT))).toBeNull();
    expect(graph.listNodes({ kind: "person", limit: 50 })).toHaveLength(0);
  });
});

// ------------------------------------------------------- the orchestrator ---

function extractorWith(
  run: (transcript: readonly TranscriptMessage[]) => Promise<Extraction>,
  over: { readonly onGraphChanged?: () => void } = {},
): { readonly extractor: ConversationExtractor; readonly lines: string[] } {
  const lines: string[] = [];
  const extractor = new ConversationExtractor({
    store,
    run,
    log: (line) => lines.push(line),
    ...(over.onGraphChanged === undefined ? {} : { onGraphChanged: over.onGraphChanged }),
  });
  return { extractor, lines };
}

describe("ConversationExtractor", () => {
  it("should file what the turn returned and report it", async () => {
    const { extractor } = extractorWith(() => Promise.resolve(extraction()));
    const outcome = await extractor.extract({
      conversationId: INTERACTIVE_CONVERSATION_ID,
      transcript: TRANSCRIPT,
    });

    expect(outcome.status).toBe("filed");
    expect(outcome.result?.created).toBe(1);
    expect(graph.listNodes({ kind: "person", limit: 50 })).toHaveLength(1);
  });

  it("should treat declining as a success, because most exchanges contain nothing", async () => {
    const { extractor } = extractorWith(() => Promise.resolve(extraction({ facts: [] })));
    const outcome = await extractor.extract({
      conversationId: INTERACTIVE_CONVERSATION_ID,
      transcript: TRANSCRIPT,
    });

    expect(outcome.status).toBe("declined");
    expect(outcome.error).toBeNull();
  });

  it("should never reject when the turn fails — a miss is logged, not thrown", async () => {
    const { extractor, lines } = extractorWith(() =>
      Promise.reject(new Error("the turn timed out")),
    );
    const outcome = await extractor.extract({
      conversationId: INTERACTIVE_CONVERSATION_ID,
      transcript: TRANSCRIPT,
    });

    expect(outcome.status).toBe("missed");
    expect(outcome.result).toBeNull();
    expect(lines.join("\n")).toContain("extraction missed");
  });

  it("should never reject when the graph refuses the write either", async () => {
    const { extractor } = extractorWith(() => Promise.resolve(extraction()));
    const outcome = await extractor.extract({
      conversationId: "not-a-conversation",
      transcript: TRANSCRIPT,
    });
    expect(outcome.status).toBe("missed");
  });

  it("should not spend a turn re-extracting an exchange it has already filed", async () => {
    const run = vi.fn(() => Promise.resolve(extraction()));
    const { extractor } = extractorWith(run);

    await extractor.extract({ conversationId: INTERACTIVE_CONVERSATION_ID, transcript: TRANSCRIPT });
    const second = await extractor.extract({
      conversationId: INTERACTIVE_CONVERSATION_ID,
      transcript: TRANSCRIPT,
    });

    expect(second.status).toBe("replayed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("should rebuild the projection when the graph moved, and not when it did not", async () => {
    const regenerate = vi.fn();
    const { extractor } = extractorWith(() => Promise.resolve(extraction()), {
      onGraphChanged: regenerate,
    });

    await extractor.extract({ conversationId: INTERACTIVE_CONVERSATION_ID, transcript: TRANSCRIPT });
    expect(regenerate).toHaveBeenCalledTimes(1);

    await extractor.extract({ conversationId: INTERACTIVE_CONVERSATION_ID, transcript: TRANSCRIPT });
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it("should still count the filing a success if the projection cannot be rebuilt", async () => {
    const { extractor, lines } = extractorWith(() => Promise.resolve(extraction()), {
      onGraphChanged: () => {
        throw new Error("over budget");
      },
    });
    const outcome = await extractor.extract({
      conversationId: INTERACTIVE_CONVERSATION_ID,
      transcript: TRANSCRIPT,
    });

    expect(outcome.status).toBe("filed");
    expect(lines.join("\n")).toContain("could not be rebuilt");
  });
});

/**
 * `syl-017.2` — Illinois had a degree of one, and the fix has two halves.
 *
 * The first is that `place` is a kind at all, so a claim is allowed to point at
 * one. The second is the half that could quietly make her memory worse: if
 * every place named becomes a node, the graph fills with entities nobody asked
 * about and they compete for a 4,000-byte digest against the things that
 * matter. So the rule is RECURRENCE, and these tests hold the rule rather than
 * its effects — the count is over exchanges, the deferral loses nothing, and a
 * promotion arrives with every edge that was waiting for it.
 */

const SECOND_MESSAGE_A = "syl:message:01991b2f-0000-7000-8000-00000000001a";
const SECOND_MESSAGE_B = "syl:message:01991b2f-0000-7000-8000-00000000001b";

const ILLINOIS_ONE: readonly TranscriptMessage[] = [
  { id: MESSAGE_A, role: "user", text: "Both sets of parents are still back in Illinois." },
  { id: MESSAGE_B, role: "assistant", text: "Noted." },
];

const ILLINOIS_TWO: readonly TranscriptMessage[] = [
  { id: SECOND_MESSAGE_A, role: "user", text: "I have ruled Illinois out for the move." },
  { id: SECOND_MESSAGE_B, role: "assistant", text: "Understood." },
];

/** The place entry and the claim that hangs off it — the shape the turn is told to produce. */
function aboutIllinois(claim: {
  readonly label: string;
  readonly body: string;
  readonly why?: string;
}): Extraction {
  return {
    facts: [
      {
        kind: "place",
        label: "Illinois",
        body: "The state both sets of parents live in.",
        saidIn: 1,
        about: null,
        why: "He named the state outright.",
      },
      {
        kind: "fact",
        label: claim.label,
        body: claim.body,
        saidIn: 1,
        about: 1,
        why: claim.why ?? "He stated it directly.",
      },
    ],
    instructionsFound: [],
  };
}

function degreeOf(nodeId: string): number {
  return graph.edgesTouching(nodeId).length;
}

describe("a place has to earn a node", () => {
  it("should not mint a place the first time it is named — once is a word, not a hub", () => {
    const result = apply({
      transcript: ILLINOIS_ONE,
      extraction: aboutIllinois({
        label: "His parents' home",
        body: "Both sets of parents live in Illinois.",
      }),
    });

    expect(result.facts.map((fact) => fact.kind)).toEqual(["fact"]);
    expect(graph.listNodes({ kind: "place" })).toEqual([]);
    expect(result.pending).toEqual([
      { kind: "place", label: "Illinois", heardIn: 1, needed: ENTITY_RECURRENCE_THRESHOLD },
    ]);
  });

  it("should record the mention rather than dropping it, so nothing is lost while it waits", () => {
    apply({
      transcript: ILLINOIS_ONE,
      extraction: aboutIllinois({
        label: "His parents' home",
        body: "Both sets of parents live in Illinois.",
      }),
    });

    const mentions = store.mentionsOf("place", "Illinois");
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.quote).toBe("Both sets of parents are still back in Illinois.");
    expect(mentions[0]?.saidIn).toBe(MESSAGE_A);
    expect(mentions[0]?.why).toBe("He stated it directly.");
    expect(mentions[0]?.nodeId).toBeNull();
    expect(store.timesHeard("place", "Illinois")).toBe(1);
  });

  it("should still file the claim itself, which is waiting on a subject and not on a decision", () => {
    const result = apply({
      transcript: ILLINOIS_ONE,
      extraction: aboutIllinois({
        label: "His parents' home",
        body: "Both sets of parents live in Illinois.",
      }),
    });

    const claim = result.facts[0];
    expect(claim?.label).toBe("His parents' home");
    expect(claim?.created).toBe(true);
    // No edge yet, because there is nothing yet to point at.
    expect(claim?.aboutNodeId).toBeNull();
  });

  it("should mint the place when a SECOND exchange names it", () => {
    apply({
      transcript: ILLINOIS_ONE,
      extraction: aboutIllinois({
        label: "His parents' home",
        body: "Both sets of parents live in Illinois.",
      }),
    });
    const second = apply({
      transcript: ILLINOIS_TWO,
      extraction: aboutIllinois({
        label: "Ruling out Illinois",
        body: "He has ruled Illinois out for the move.",
      }),
    });

    expect(second.pending).toEqual([]);
    expect(second.promoted).toHaveLength(1);
    expect(second.promoted[0]?.heardIn).toBe(2);
    expect(graph.listNodes({ kind: "place" }).map((node) => node.label)).toEqual(["Illinois"]);
  });

  it("should give the promoted place EVERY edge that was waiting on it", () => {
    // The test this bead exists for. Illinois's defect was a degree of one; a
    // promotion that drew only the promoting exchange's edge would reproduce it
    // exactly while looking like a fix from every other angle.
    apply({
      transcript: ILLINOIS_ONE,
      extraction: aboutIllinois({
        label: "His parents' home",
        body: "Both sets of parents live in Illinois.",
      }),
    });
    const second = apply({
      transcript: ILLINOIS_TWO,
      extraction: aboutIllinois({
        label: "Ruling out Illinois",
        body: "He has ruled Illinois out for the move.",
      }),
    });

    const illinois = second.promoted[0];
    expect(illinois).toBeDefined();
    const nodeId = illinois?.nodeId ?? "";

    // Both claims, and the conversation that vouched for them.
    expect(illinois?.degree).toBe(3);
    expect(degreeOf(nodeId)).toBe(3);

    const claims = graph
      .edgesTouching(nodeId)
      .filter((edge) => edge.relation === ABOUT_RELATION)
      .map((edge) => graph.getNode(edge.sourceNode)?.label)
      .sort();
    expect(claims).toEqual(["His parents' home", "Ruling out Illinois"]);
  });

  it("should replay the provenance of the exchange that ASSERTED it, not the one that promoted it", () => {
    apply({
      transcript: ILLINOIS_ONE,
      extraction: aboutIllinois({
        label: "His parents' home",
        body: "Both sets of parents live in Illinois.",
        why: "He said both sets of parents are still there.",
      }),
    });
    const second = apply({
      transcript: ILLINOIS_TWO,
      extraction: aboutIllinois({
        label: "Ruling out Illinois",
        body: "He has ruled Illinois out for the move.",
        why: "He ruled the state out in as many words.",
      }),
    });

    const provenance = store.provenanceFor(second.promoted[0]?.nodeId ?? "");
    expect(provenance).toHaveLength(2);
    expect(provenance.map((row) => row.quote).sort()).toEqual([
      "Both sets of parents are still back in Illinois.",
      "I have ruled Illinois out for the move.",
    ]);
    expect(provenance.map((row) => row.why).sort()).toEqual([
      "He ruled the state out in as many words.",
      "He said both sets of parents are still there.",
    ]);
  });

  it("should count EXCHANGES and not claims, so one talkative reply cannot promote on its own", () => {
    // Three claims about Illinois in one message is one telling. Counting rows
    // rather than digests would be minting on mention with extra steps.
    const result = apply({
      transcript: ILLINOIS_ONE,
      extraction: {
        facts: [
          {
            kind: "place",
            label: "Illinois",
            body: "The state his parents live in.",
            saidIn: 1,
            about: null,
            why: "He named it.",
          },
          ...["His parents' home", "Where he grew up", "Where Ela is"].map((label) => ({
            kind: "fact" as const,
            label,
            body: `${label}: Illinois.`,
            saidIn: 1,
            about: 1,
            why: "He stated it directly.",
          })),
        ],
        instructionsFound: [],
      },
    });

    expect(result.promoted).toEqual([]);
    expect(result.pending[0]?.heardIn).toBe(1);
    expect(store.mentionsOf("place", "Illinois")).toHaveLength(3);
    expect(store.timesHeard("place", "Illinois")).toBe(1);
  });

  it("should carry all three of those claims across when the second exchange arrives", () => {
    apply({
      transcript: ILLINOIS_ONE,
      extraction: {
        facts: [
          {
            kind: "place",
            label: "Illinois",
            body: "The state his parents live in.",
            saidIn: 1,
            about: null,
            why: "He named it.",
          },
          ...["His parents' home", "Where he grew up", "Where Ela is"].map((label) => ({
            kind: "fact" as const,
            label,
            body: `${label}: Illinois.`,
            saidIn: 1,
            about: 1,
            why: "He stated it directly.",
          })),
        ],
        instructionsFound: [],
      },
    });
    const second = apply({
      transcript: ILLINOIS_TWO,
      extraction: aboutIllinois({
        label: "Ruling out Illinois",
        body: "He has ruled Illinois out for the move.",
      }),
    });

    // Four claims plus the one conversation that vouched for them all.
    expect(second.promoted[0]?.degree).toBe(5);
  });

  it("should not record a place that no claim in its own reply is about", () => {
    // Somewhere he merely passed through is a word in a sentence. There is
    // nothing to defer, because there is nothing waiting on it.
    const result = apply({
      transcript: ILLINOIS_ONE,
      extraction: {
        facts: [
          {
            kind: "place",
            label: "Illinois",
            body: "A state.",
            saidIn: 1,
            about: null,
            why: "He mentioned it.",
          },
        ],
        instructionsFound: [],
      },
    });

    expect(result.pending).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(store.mentionsOf("place", "Illinois")).toEqual([]);
    expect(graph.listNodes({ kind: "place" })).toEqual([]);
  });

  it("should file a place normally once it exists — recurrence decides EXISTENCE, not use", () => {
    apply({
      transcript: ILLINOIS_ONE,
      extraction: aboutIllinois({
        label: "His parents' home",
        body: "Both sets of parents live in Illinois.",
      }),
    });
    apply({
      transcript: ILLINOIS_TWO,
      extraction: aboutIllinois({
        label: "Ruling out Illinois",
        body: "He has ruled Illinois out for the move.",
      }),
    });

    const third: readonly TranscriptMessage[] = [
      { id: MESSAGE_A, role: "user", text: "Isla's specialist is in Illinois too." },
      { id: MESSAGE_B, role: "assistant", text: "Noted." },
    ];
    const result = apply({
      transcript: third,
      extraction: aboutIllinois({
        label: "Isla's specialist",
        body: "Isla's CF specialist is in Illinois.",
      }),
    });

    expect(result.pending).toEqual([]);
    expect(result.promoted).toEqual([]);
    const place = result.facts.find((fact) => fact.kind === "place");
    expect(place?.created).toBe(false);
    expect(result.facts.find((fact) => fact.kind === "fact")?.aboutNodeId).toBe(place?.nodeId);
    expect(graph.listNodes({ kind: "place" })).toHaveLength(1);
  });

  it("should not gate a PERSON, because the admission tests already make people rare", () => {
    const result = apply();

    expect(result.pending).toEqual([]);
    expect(result.facts[0]?.kind).toBe("person");
    expect(result.facts[0]?.created).toBe(true);
  });

  it("should fold case when it counts a place, exactly as it does for a fact", () => {
    apply({
      transcript: ILLINOIS_ONE,
      extraction: aboutIllinois({
        label: "His parents' home",
        body: "Both sets of parents live in Illinois.",
      }),
    });
    const second = apply({
      transcript: ILLINOIS_TWO,
      extraction: {
        facts: [
          {
            kind: "place",
            label: "ILLINOIS",
            body: "The state.",
            saidIn: 1,
            about: null,
            why: "He named it.",
          },
          {
            kind: "fact",
            label: "Ruling out Illinois",
            body: "He has ruled Illinois out.",
            saidIn: 1,
            about: 1,
            why: "He stated it directly.",
          },
        ],
        instructionsFound: [],
      },
    });

    expect(second.promoted).toHaveLength(1);
    expect(second.promoted[0]?.heardIn).toBe(2);
  });

  it("should leave no mention behind when the apply is refused partway through", () => {
    // Same rule as every other write here: all of it lands or none of it does.
    // A mention row surviving a rolled-back apply would count towards a
    // promotion for an exchange the ledger says never happened.
    expect(() =>
      store.apply({
        conversationId: INTERACTIVE_CONVERSATION_ID,
        transcript: ILLINOIS_ONE,
        extraction: {
          facts: [
            {
              kind: "place",
              label: "Illinois",
              body: "The state.",
              saidIn: 1,
              about: null,
              why: "He named it.",
            },
            {
              kind: "fact",
              label: "His parents' home",
              body: "They live there.",
              saidIn: 1,
              about: 1,
              why: "He stated it directly.",
            },
            // A blank `why`, which `memory_provenance` refuses. `asExtraction`
            // would have caught it long before here; the store is handed an
            // unvalidated extraction on purpose, because the failure has to
            // land AFTER the mention rows are written to prove they roll back.
            {
              kind: "fact",
              label: "Something else",
              body: "Another claim.",
              saidIn: 1,
              about: null,
              why: "   ",
            },
          ],
          instructionsFound: [],
        },
      }),
    ).toThrow();

    expect(store.mentionsOf("place", "Illinois")).toEqual([]);
    expect(store.recordFor(transcriptDigest(ILLINOIS_ONE))).toBeNull();
  });
});

describe("which kinds are gated", () => {
  it("should gate only kinds a claim is allowed to point at", () => {
    // A gated kind exists as a node only after a claim has pointed at it twice,
    // and `about` refuses to point at anything outside `ENTITY_NODE_KINDS`. Gate
    // a kind outside that set and it can never accumulate a mention, so it can
    // never be promoted — a node kind that is unreachable by construction, which
    // nothing else in the system would fail on.
    for (const kind of RECURRENCE_GATED_KINDS) {
      expect(ENTITY_NODE_KINDS as readonly string[]).toContain(kind);
    }
  });

  it("should gate only kinds the extraction turn is allowed to propose", () => {
    for (const kind of RECURRENCE_GATED_KINDS) {
      expect(EXTRACTABLE_KINDS as readonly string[]).toContain(kind);
    }
  });

  it("should need more than one exchange, or the gate is not a gate", () => {
    expect(ENTITY_RECURRENCE_THRESHOLD).toBeGreaterThan(1);
  });
});
