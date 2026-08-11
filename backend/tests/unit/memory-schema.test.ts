import { describe, expect, it } from "vitest";

import {
  edgePartition,
  isMemoryEdgeId,
  isMemoryEdgeSpecies,
  isMemoryNodeId,
  isMemoryNodeKind,
  isMemoryTier,
  isScannedTier,
  MEMORY_EDGE_ID_PREFIX,
  MEMORY_EDGE_SPECIES,
  MEMORY_NODE_ID_PREFIX,
  MEMORY_NODE_KINDS,
  MEMORY_TIERS,
  MemorySchemaError,
  newMemoryEdgeId,
  newMemoryNodeId,
  nodePartition,
  partitionLabel,
  SCANNED_TIER,
  tierAfter,
  VECTOR_PARTITION_KEY_COLUMNS,
  vectorTableDdl,
} from "../../src/memory/schema.js";
import { isId, idType } from "../../src/services/id.js";

/** A fixed UUIDv7, so an id is assertable rather than "shaped roughly right". */
const UUID = "01991b2f-0000-7000-8000-0000000000ab";
const fixedUuid = (): string => UUID;

describe("memory node and edge ids", () => {
  it("should mint a node id under the memory_node namespace", () => {
    expect(newMemoryNodeId(fixedUuid)).toBe(`${MEMORY_NODE_ID_PREFIX}${UUID}`);
  });

  it("should mint an edge id under the memory_edge namespace", () => {
    expect(newMemoryEdgeId(fixedUuid)).toBe(`${MEMORY_EDGE_ID_PREFIX}${UUID}`);
  });

  it("should mint ids the shared id convention already accepts", () => {
    // `syl:<type>:<uuidv7>` is the project-wide contract. A memory id that the
    // shared validator rejects would be a second, incompatible convention.
    expect(isId(newMemoryNodeId(fixedUuid))).toBe(true);
    expect(isId(newMemoryEdgeId(fixedUuid))).toBe(true);
    expect(idType(newMemoryNodeId(fixedUuid))).toBe("memory_node");
    expect(idType(newMemoryEdgeId(fixedUuid))).toBe("memory_edge");
  });

  it("should mint distinct ids on consecutive calls", () => {
    expect(newMemoryNodeId()).not.toBe(newMemoryNodeId());
    expect(newMemoryEdgeId()).not.toBe(newMemoryEdgeId());
  });

  it("should not collide with the operational goals table's namespace", () => {
    // A memory node of kind `goal` must not mint `syl:goal:<uuid>`, which
    // already addresses a row in `goals`. The kind lives in a column.
    expect(newMemoryNodeId(fixedUuid).startsWith("syl:goal:")).toBe(false);
  });

  it("should recognise its own ids and refuse the other kind", () => {
    expect(isMemoryNodeId(newMemoryNodeId(fixedUuid))).toBe(true);
    expect(isMemoryEdgeId(newMemoryEdgeId(fixedUuid))).toBe(true);
    expect(isMemoryNodeId(newMemoryEdgeId(fixedUuid))).toBe(false);
    expect(isMemoryEdgeId(newMemoryNodeId(fixedUuid))).toBe(false);
  });

  it("should refuse ids that are the right shape but not a memory id", () => {
    expect(isMemoryNodeId(`syl:todo:${UUID}`)).toBe(false);
    expect(isMemoryNodeId(UUID)).toBe(false);
    expect(isMemoryNodeId("")).toBe(false);
  });

  it("should refuse an id whose uuid is malformed", () => {
    expect(isMemoryNodeId(`${MEMORY_NODE_ID_PREFIX}not-a-uuid`)).toBe(false);
    expect(isMemoryEdgeId(`${MEMORY_EDGE_ID_PREFIX}${UUID}extra`)).toBe(false);
  });

  it("should mint ids of the length the tables CHECK", () => {
    // The migration pins `length(id) = 52`. If the minted length ever drifts,
    // every insert fails against a real database and passes against a mock.
    expect(newMemoryNodeId(fixedUuid)).toHaveLength(52);
    expect(newMemoryEdgeId(fixedUuid)).toHaveLength(52);
  });
});

describe("the partition vocabulary", () => {
  it("should offer exactly three tiers, hot first", () => {
    expect([...MEMORY_TIERS]).toEqual(["hot", "cold", "suppressed"]);
    expect(SCANNED_TIER).toBe("hot");
  });

  it("should cover every node kind the memory graph holds", () => {
    expect([...MEMORY_NODE_KINDS]).toEqual([
      "fact",
      "memory",
      "person",
      "source",
      "event",
      "goal",
      "decision",
      // `syl-017.2`. The most connective entity in his life was a word inside a
      // fact's label, and it had a degree of one because `about` may not point
      // at a `fact`. See `0029_memory_places.sql`.
      "place",
    ]);
  });

  it("should carry exactly two species of edge", () => {
    expect([...MEMORY_EDGE_SPECIES]).toEqual(["observed", "inferred"]);
  });

  it("should recognise its own vocabulary and refuse anything else", () => {
    expect(isMemoryTier("cold")).toBe(true);
    expect(isMemoryTier("warm")).toBe(false);
    expect(isMemoryTier(undefined)).toBe(false);
    expect(isMemoryNodeKind("person")).toBe(true);
    expect(isMemoryNodeKind("observed")).toBe(false);
    expect(isMemoryEdgeSpecies("inferred")).toBe(true);
    expect(isMemoryEdgeSpecies("fact")).toBe(false);
  });

  it("should scan the hot tier and nothing else", () => {
    expect(isScannedTier("hot")).toBe(true);
    expect(isScannedTier("cold")).toBe(false);
    // Suppressed is not merely stale: it is an edge the Commander said is
    // wrong. It must never re-enter a scan, whatever its weight does.
    expect(isScannedTier("suppressed")).toBe(false);
  });
});

describe("partition keys", () => {
  it("should build a node partition from a tier and a kind", () => {
    expect(nodePartition("hot", "person")).toEqual({ tier: "hot", kind: "person" });
  });

  it("should build an edge partition from a tier and a species", () => {
    expect(edgePartition("cold", "inferred")).toEqual({ tier: "cold", kind: "inferred" });
  });

  it("should refuse a tier that is not in the vocabulary", () => {
    expect(() => nodePartition("warm", "person")).toThrow(MemorySchemaError);
    expect(() => edgePartition("warm", "observed")).toThrow(MemorySchemaError);
  });

  it("should refuse a node kind that is really an edge species, and vice versa", () => {
    // The two vocabularies are both `kind` columns. Crossing them would write
    // a row into a partition nothing ever queries.
    expect(() => nodePartition("hot", "observed")).toThrow(MemorySchemaError);
    expect(() => edgePartition("hot", "person")).toThrow(MemorySchemaError);
  });

  it("should name the reason in the message, not merely fail", () => {
    expect(() => nodePartition("hot", "nonsense")).toThrow(/nonsense/u);
    expect(() => nodePartition("nonsense", "fact")).toThrow(/nonsense/u);
  });

  it("should label a partition legibly for a log line", () => {
    expect(partitionLabel(nodePartition("cold", "fact"))).toBe("cold/fact");
    expect(partitionLabel(edgePartition("suppressed", "inferred"))).toBe("suppressed/inferred");
  });
});

describe("tierAfter — demotion and partitioning are the same mechanism", () => {
  it("should keep an edge hot while it is above the relevance floor", () => {
    expect(tierAfter("hot", 0.4, 0.1)).toBe("hot");
  });

  it("should move an edge to cold when it crosses the floor", () => {
    // The whole point: crossing the floor MOVES the row out of the hot
    // partition. Ranking alone would leave it in the scan forever.
    expect(tierAfter("hot", 0.05, 0.1)).toBe("cold");
  });

  it("should promote a cold edge back the moment it is reactivated", () => {
    // "Demote, never prune" is only true if the way back exists.
    expect(tierAfter("cold", 0.6, 0.1)).toBe("hot");
  });

  it("should never promote a suppressed edge, however strong it becomes", () => {
    expect(tierAfter("suppressed", 1, 0.1)).toBe("suppressed");
    expect(tierAfter("suppressed", 0.001, 0.1)).toBe("suppressed");
  });

  it("should treat a weight exactly at the floor as still hot", () => {
    // The floor is the lowest weight worth scanning, not the first one that is
    // not. Stated once, here, so two call sites cannot disagree by an epsilon.
    expect(tierAfter("hot", 0.1, 0.1)).toBe("hot");
    expect(tierAfter("cold", 0.1, 0.1)).toBe("hot");
  });

  it("should refuse a weight that is not a real number in (0, 1]", () => {
    expect(() => tierAfter("hot", 0, 0.1)).toThrow(MemorySchemaError);
    expect(() => tierAfter("hot", 1.5, 0.1)).toThrow(MemorySchemaError);
    expect(() => tierAfter("hot", Number.NaN, 0.1)).toThrow(MemorySchemaError);
  });

  it("should refuse a floor that is not a real number in (0, 1]", () => {
    // A floor of zero would mean nothing ever demotes, which is the unbounded
    // hot partition this whole design exists to prevent.
    expect(() => tierAfter("hot", 0.5, 0)).toThrow(MemorySchemaError);
    expect(() => tierAfter("hot", 0.5, Number.NaN)).toThrow(MemorySchemaError);
  });

  it("should refuse a tier it does not know", () => {
    expect(() => tierAfter("warm", 0.5, 0.1)).toThrow(MemorySchemaError);
  });
});

describe("vectorTableDdl — the partition key, made binding on the vector table", () => {
  it("should declare tier and kind as partition keys", () => {
    const ddl = vectorTableDdl({ table: "memory_node_vectors", dimensions: 384 });

    expect([...VECTOR_PARTITION_KEY_COLUMNS]).toEqual(["tier", "kind"]);
    for (const column of VECTOR_PARTITION_KEY_COLUMNS) {
      expect(ddl).toContain(`${column} text partition key`);
    }
  });

  it("should carry the table name and the embedding width it was given", () => {
    const ddl = vectorTableDdl({ table: "memory_node_vectors", dimensions: 768 });

    expect(ddl).toContain("CREATE VIRTUAL TABLE memory_node_vectors USING vec0");
    expect(ddl).toContain("float[768]");
  });

  it("should key each vector by the node it belongs to", () => {
    // Without this the vector table cannot be joined back to the graph, and a
    // partition-spanning identity lookup has nothing to land on.
    expect(vectorTableDdl({ table: "memory_node_vectors", dimensions: 384 })).toContain(
      "node_id text primary key",
    );
  });

  it("should refuse a table name that is not a bare identifier", () => {
    // The name is interpolated, so this is the injection boundary.
    expect(() => vectorTableDdl({ table: "vectors; DROP TABLE memory_edges", dimensions: 384 })).toThrow(
      MemorySchemaError,
    );
    expect(() => vectorTableDdl({ table: "", dimensions: 384 })).toThrow(MemorySchemaError);
  });

  it("should refuse a dimension count that is not a positive integer", () => {
    expect(() => vectorTableDdl({ table: "v", dimensions: 0 })).toThrow(MemorySchemaError);
    expect(() => vectorTableDdl({ table: "v", dimensions: 3.5 })).toThrow(MemorySchemaError);
    expect(() => vectorTableDdl({ table: "v", dimensions: -8 })).toThrow(MemorySchemaError);
  });
});
