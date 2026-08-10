import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChunkExtract } from "../../src/connections/extract.js";
import type { GraftSink } from "../../src/connections/intake.js";
import { IntakeStore, type IntakeSource, type StoredExtract } from "../../src/connections/intake-store.js";
import { classifyRetention, RETENTION_CLASSES } from "../../src/connections/retention.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import {
  EXTRACTED_RELATION,
  extractLabel,
  IntakeSourceMissing,
  MemorySources,
  TOMBSTONE_PREFIX,
  type SourceRetention,
  type SourceStore,
} from "../../src/memory/sources.js";
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
 * `syl-005.1.3` — the source store, which already existed.
 *
 * These tests run against `0008_intake.sql`, the migration that shipped under
 * the intake epic, precisely because the verdict on this bead is that
 * `intake_sources` IS the source store and a second one must not be built.
 * What is exercised here is the memory-side wiring: provenance the graph can
 * follow, and a hard delete that reaches into it.
 */

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const LATER = Date.parse("2026-08-09T18:00:00.000Z");
const DEMOTE_AT = "2026-08-11T00:00:00.000Z";

let db: Database;
let graph: MemoryGraph;
let store: IntakeStore;
let sources: MemorySources;

beforeEach(() => {
  db = new DatabaseSync(IN_MEMORY);
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
  graph = new MemoryGraph({ db, clock: fixedClock(NOW) });
  store = new IntakeStore({ db, clock: fixedClock(NOW) });
  sources = new MemorySources({ store, graph });
});

afterEach(() => {
  db.close();
});

function chunkExtract(summary: string): ChunkExtract {
  return {
    summary,
    claims: [],
    entities: [],
    definitions: [],
    passages: [],
    questions: [],
    instructionsFound: [],
  };
}

/** A source at the graft step, with `count` extracts behind it. */
function ingest(
  url: string,
  count: number,
  requested?: "sensitive" | "standard" | "ephemeral",
): { source: IntakeSource; extracts: readonly StoredExtract[] } {
  const decision = classifyRetention(requested === undefined ? { url } : { url, requested });
  const { source } = store.create({
    url,
    channel: "link",
    requestedBy: "syl:principal:01991b2f-0000-7000-8000-0000000000ff",
    retention: decision.retention,
    retentionReason: decision.reason,
  });
  const read = store.update(source.id, { title: "An Article", stage: "graft" });

  const extracts: StoredExtract[] = [];
  for (let index = 0; index < count; index += 1) {
    extracts.push(
      store.putExtract({
        sourceId: source.id,
        chunkIndex: index,
        start: index * 100,
        end: index * 100 + 99,
        retention: decision.retention,
        extract: chunkExtract(`chunk ${String(index)} says something`),
      }),
    );
  }
  return { source: read, extracts };
}

describe("the ports between memory and intake", () => {
  it("should keep the retention vocabulary in step with the one intake owns", () => {
    // `memory/sources.ts` imports nothing from `connections/` — US4's fence
    // says only `index.ts` may — so the three classes are declared twice. This
    // is the assertion that stops the copy drifting, and it lives in a test
    // because a test file is outside the fence.
    const mirrored: readonly SourceRetention[] = ["ephemeral", "standard", "sensitive"];

    expect([...RETENTION_CLASSES].sort()).toEqual([...mirrored].sort());
  });

  it("should satisfy intake's own GraftSink without importing it", () => {
    // Assignability, checked by tsc. If `GraftSink` changes shape, this line
    // stops compiling and the port has to be brought back into line.
    const sink: GraftSink = sources.sink;

    expect(typeof sink.graft).toBe("function");
  });

  it("should accept the real IntakeStore where it asks for a SourceStore", () => {
    const port: SourceStore = store;

    expect(port.get("syl:source:01991b2f-0000-7000-8000-0000000000aa")).toBeNull();
  });
});

describe("MemorySources.graft", () => {
  it("should project the source and each extract as four-field handles", () => {
    const { source, extracts } = ingest("https://example.com/a", 2);

    const report = sources.graft({ source, extracts });

    expect(report.changed).toBe(true);
    expect(report.source.projection).toEqual({
      id: report.source.projection.id,
      type: "source",
      label: "An Article",
      ref: source.id,
    });
    expect(report.extracts.map((node) => node.projection.ref)).toEqual(
      extracts.map((extract) => extract.id),
    );
    expect(report.edgesCreated).toHaveLength(2);
  });

  it("should carry NO mutable intake state into the graph", () => {
    // `stage`, `bytes`, `chunkCount`, `retention` and `expiresAt` all move over
    // a source's life. A node asserting `stage: graft` a year from now would
    // never error and would never be true.
    const { source, extracts } = ingest("https://example.com/a", 1);

    const report = sources.graft({ source, extracts });
    const node = graph.getNode(report.source.projection.id);

    expect(node?.body).toBeNull();
    expect(Object.keys(report.source.projection).sort()).toEqual(["id", "label", "ref", "type"]);
  });

  it("should hang every extract off the source with the source as its ASSERTER", () => {
    const { source, extracts } = ingest("https://example.com/a", 2);

    const report = sources.graft({ source, extracts });
    const asserted = graph.edgesAssertedBy(report.source.projection.id);

    expect(asserted).toHaveLength(2);
    expect(asserted.every((edge) => edge.relation === EXTRACTED_RELATION)).toBe(true);
    expect(asserted.map((edge) => edge.targetNode).sort()).toEqual(
      report.extracts.map((node) => node.projection.id).sort(),
    );
  });

  it("should be IDEMPOTENT — the graft step re-runs after every crash", () => {
    const { source, extracts } = ingest("https://example.com/a", 2);
    sources.graft({ source, extracts });
    const before = graph.listNodes({ limit: 100 });

    const later = new MemorySources({ store, graph: new MemoryGraph({ db, clock: fixedClock(LATER) }) });
    const second = later.graft({ source, extracts });

    expect(second.changed).toBe(false);
    expect(second.edgesCreated).toEqual([]);
    expect(graph.listNodes({ limit: 100 })).toEqual(before);
  });

  it("should rename rather than fork when a re-read changed a summary", () => {
    const { source, extracts } = ingest("https://example.com/a", 1);
    const first = sources.graft({ source, extracts });
    const rewritten = store.putExtract({
      sourceId: source.id,
      chunkIndex: 0,
      start: 0,
      end: 99,
      retention: source.retention,
      extract: chunkExtract("a better summary"),
    });

    const second = sources.graft({ source, extracts: [rewritten] });

    expect(second.extracts[0]?.outcome).toBe("relabelled");
    expect(second.extracts[0]?.projection.id).toBe(first.extracts[0]?.projection.id);
    expect(second.extracts[0]?.projection.label).toBe("a better summary");
  });

  it("should not recreate an edge the Commander suppressed", () => {
    const { source, extracts } = ingest("https://example.com/a", 1);
    const first = sources.graft({ source, extracts });
    const edgeId = first.edgesCreated[0] as string;
    const edge = graph.getEdge(edgeId);
    graph.suppress(edge as never);

    const second = sources.graft({ source, extracts });

    expect(second.edgesCreated).toEqual([]);
    expect(graph.getEdge(edgeId)?.tier).toBe("suppressed");
  });

  it("should take a source with no extracts at all", () => {
    const { source } = ingest("https://example.com/a", 0);

    const report = sources.graft({ source, extracts: [] });

    expect(report.source.outcome).toBe("created");
    expect(report.extracts).toEqual([]);
    expect(report.changed).toBe(true);
  });

  it("should adapt to intake's sink, which wants no report back", () => {
    const { source, extracts } = ingest("https://example.com/a", 1);

    sources.sink.graft({ source, extracts });

    expect(graph.nodesForSubject(source.id)).toHaveLength(1);
  });
});

describe("extractLabel", () => {
  it("should use the extract's own summary", () => {
    const { extracts } = ingest("https://example.com/a", 1);

    expect(extractLabel(extracts[0] as StoredExtract)).toBe("chunk 0 says something");
  });

  it("should fall back positionally rather than fail on an empty summary", () => {
    const { source } = ingest("https://example.com/a", 0);
    const empty = store.putExtract({
      sourceId: source.id,
      chunkIndex: 3,
      start: 0,
      end: 1,
      retention: source.retention,
      extract: chunkExtract("   "),
    });

    expect(extractLabel(empty)).toBe(`extract 3 of ${source.id}`);
  });

  it("should truncate a summary long enough to be a paragraph", () => {
    const { source } = ingest("https://example.com/a", 0);
    const long = store.putExtract({
      sourceId: source.id,
      chunkIndex: 0,
      start: 0,
      end: 1,
      retention: source.retention,
      extract: chunkExtract("word ".repeat(200)),
    });

    expect(extractLabel(long).length).toBeLessThanOrEqual(161);
    expect(extractLabel(long)).toMatch(/…$/u);
  });
});

describe("MemorySources.provenanceOf", () => {
  it("should answer where a derived node came from, and read retention from the ROW", () => {
    const { source, extracts } = ingest("https://mychart.example.com/a", 1);
    const report = sources.graft({ source, extracts });

    const provenance = sources.provenanceOf(report.extracts[0]?.projection.id as string);

    expect(provenance).toHaveLength(1);
    expect(provenance[0]?.source.id).toBe(source.id);
    expect(provenance[0]?.retention).toBe("sensitive");
    expect(provenance[0]?.sourceNodeId).toBe(report.source.projection.id);
  });

  it("should treat a source handle as its own provenance", () => {
    const { source, extracts } = ingest("https://example.com/a", 1);
    const report = sources.graft({ source, extracts });

    expect(sources.provenanceOf(report.source.projection.id)[0]?.source.id).toBe(source.id);
  });

  it("should put the MOST RESTRICTIVE class first when several sources assert one node", () => {
    const bank = ingest("https://chase.com/statement", 0);
    const blog = ingest("https://example.com/a", 0);
    const bankNode = sources.graft({ source: bank.source, extracts: [] }).source.projection.id;
    const blogNode = sources.graft({ source: blog.source, extracts: [] }).source.projection.id;
    const derived = graph.addNode({ kind: "fact", label: "he banks somewhere" });
    graph.observe({
      sourceNode: blogNode,
      targetNode: derived.id,
      relation: "says",
      assertedBy: blogNode,
    });
    graph.observe({
      sourceNode: bankNode,
      targetNode: derived.id,
      relation: "shows",
      assertedBy: bankNode,
    });

    expect(sources.provenanceOf(derived.id).map((entry) => entry.retention)).toEqual([
      "sensitive",
      "standard",
    ]);
  });

  it("should span every tier, so a dormant derivation is not left behind", () => {
    const { source, extracts } = ingest("https://chase.com/statement", 1);
    const report = sources.graft({ source, extracts });
    const edge = graph.getEdge(report.edgesCreated[0] as string);
    graph.demote(edge as never);

    expect(sources.provenanceOf(report.extracts[0]?.projection.id as string)).toHaveLength(1);
  });

  it("should return nothing for a node no source asserted, and for one that is not there", () => {
    const loose = graph.addNode({ kind: "fact", label: "he decided this himself" });

    expect(sources.provenanceOf(loose.id)).toEqual([]);
    expect(sources.provenanceOf("syl:memory_node:01991b2f-0000-7000-8000-0000000000aa")).toEqual([]);
  });
});

describe("MemorySources.forget", () => {
  it("should destroy the content and every label derived from it", () => {
    const { source, extracts } = ingest("https://chase.com/statement", 2);
    const report = sources.graft({ source, extracts });

    const forgotten = sources.forget(source.id);

    expect(forgotten.retention).toBe("sensitive");
    expect(forgotten.extractsPurged).toBe(2);
    expect(store.get(source.id)).toBeNull();
    expect(store.extracts(source.id)).toEqual([]);
    for (const node of report.extracts) {
      expect(graph.getNode(node.projection.id)?.label).toContain(TOMBSTONE_PREFIX);
    }
    expect(graph.getNode(report.source.projection.id)?.label).toContain(TOMBSTONE_PREFIX);
  });

  it("should retract what the source asserted", () => {
    const { source, extracts } = ingest("https://chase.com/statement", 2);
    const report = sources.graft({ source, extracts });

    const forgotten = sources.forget(source.id);

    expect(forgotten.retractedEdges).toHaveLength(2);
    expect(graph.edgesAssertedBy(report.source.projection.id)).toEqual([]);
  });

  it("should SUPPRESS inferences rather than delete them — constraint 6 is not overruled", () => {
    const { source, extracts } = ingest("https://chase.com/statement", 1);
    const report = sources.graft({ source, extracts });
    const other = graph.addNode({ kind: "fact", label: "he is saving for something" });
    const inference = graph.infer({
      sourceNode: report.source.projection.id,
      targetNode: other.id,
      relation: "suggests",
      reasoning: "the balance is climbing",
      confidence: 0.6,
      demoteAfter: DEMOTE_AT,
    });

    const forgotten = sources.forget(source.id);

    expect(forgotten.suppressedEdges).toEqual([inference.id]);
    expect(graph.getEdge(inference.id)?.tier).toBe("suppressed");
  });

  it("should leave both endpoints of a suppressed inference standing", () => {
    // Deleting a node under a live edge is how "demote, never prune" quietly
    // becomes an unreachable row.
    const { source, extracts } = ingest("https://chase.com/statement", 1);
    const report = sources.graft({ source, extracts });
    graph.infer({
      sourceNode: report.source.projection.id,
      targetNode: report.extracts[0]?.projection.id as string,
      relation: "suggests",
      reasoning: "the balance is climbing",
      confidence: 0.6,
      demoteAfter: DEMOTE_AT,
    });

    sources.forget(source.id);

    expect(graph.getNode(report.source.projection.id)).not.toBeNull();
    expect(graph.getNode(report.extracts[0]?.projection.id as string)).not.toBeNull();
  });

  it("should refuse a source it cannot reach rather than report a success", () => {
    expect(() => sources.forget("syl:source:01991b2f-0000-7000-8000-0000000000aa")).toThrow(
      IntakeSourceMissing,
    );
  });

  it("should work on a source that was never grafted", () => {
    const { source } = ingest("https://example.com/a", 1);

    const forgotten = sources.forget(source.id);

    expect(forgotten.tombstonedNodes).toEqual([]);
    expect(forgotten.extractsPurged).toBe(1);
    expect(store.get(source.id)).toBeNull();
  });

  it("should be safe to run twice, because the second run has nothing to reach", () => {
    const { source, extracts } = ingest("https://example.com/a", 1);
    sources.graft({ source, extracts });
    sources.forget(source.id);

    expect(() => sources.forget(source.id)).toThrow(IntakeSourceMissing);
  });
});
