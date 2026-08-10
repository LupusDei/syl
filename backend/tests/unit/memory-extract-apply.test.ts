import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationExtractor,
  DEFAULT_CONVERSATION_LABEL,
  ExtractionApplyError,
  ExtractionStore,
  FACT_IDENTITY_SQL,
  STATED_RELATION,
} from "../../src/memory/extract-apply.js";
import {
  ExtractionShapeError,
  transcriptDigest,
  type Extraction,
  type TranscriptMessage,
} from "../../src/memory/extract.js";
import { MemoryGraph } from "../../src/memory/graph.js";
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

const TRANSCRIPT: readonly TranscriptMessage[] = [
  { id: MESSAGE_A, role: "user", text: "My daughter is called Vivenna." },
  { id: MESSAGE_B, role: "assistant", text: "Noted." },
];

const OTHER_TRANSCRIPT: readonly TranscriptMessage[] = [
  { id: MESSAGE_A, role: "user", text: "Vivenna is at Bishop's, by the way." },
  { id: MESSAGE_B, role: "assistant", text: "Understood." },
];

function extraction(over: Partial<Extraction> = {}): Extraction {
  return {
    facts: [
      { kind: "person", label: "Vivenna", body: "The Commander's daughter.", saidIn: 1 },
    ],
    instructionsFound: [],
    ...over,
  };
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
    expect(graph.getNode(result.facts[0]?.nodeId ?? "")?.body).toContain(MESSAGE_A);
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
        facts: [{ kind: "goal", label: "Ship Syl", body: "He wants Syl shipped.", saidIn: 1 }],
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
