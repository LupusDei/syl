import { instant, parseInstant, systemClock, type Clock } from "../services/clock.js";
import { isId } from "../services/id.js";
import type { Database } from "../services/sqlite.js";
import {
  newMemoryEdgeId,
  newMemoryNodeId,
  nodePartition,
  SCANNED_TIER,
  type MemoryNodeKind,
  type MemoryTier,
} from "./schema.js";

/**
 * The read/write layer over `memory_nodes` and `memory_edges`.
 *
 * `0012_memory_core.sql` is the argument; this module is the API that argument
 * implies. Read the migration header before changing anything here — three of
 * its properties are load-bearing and none of them is visible from a row.
 *
 *
 * ## The two species of edge are different things
 *
 * An **observed** edge was asserted by a source. It carries provenance, it is
 * cheap and near-deterministic, and it is what makes the graph NAVIGABLE.
 *
 * An **inferred** edge was discovered by reflection. It carries confidence, a
 * scheduled floor crossing, and — mandatorily — **its reasoning**. It is
 * speculative, and it is what makes the graph INSIGHTFUL.
 *
 * They are separate TypeScript types ({@link ObservedEdge}, {@link
 * InferredEdge}) and separate constructors ({@link MemoryGraph.observe},
 * {@link MemoryGraph.infer}), so a value read out of the store carries exactly
 * what its species means and nothing belonging to the other. `reasoning` is a
 * required, non-optional field of {@link InferInput}: an inference with no
 * argument behind it does not typecheck, let alone reach the CHECK that would
 * refuse it.
 *
 *
 * ## Constraint 6: an inferred edge is never deleted, only demoted
 *
 * There is no `deleteEdge(id)` in this module, and no statement anywhere in it
 * that deletes by id alone. The only delete is {@link MemoryGraph.retract},
 * which takes an {@link ObservedEdge} **value** rather than an id — so
 * `retract(someInferredEdge)` is a compile error, not a runtime refusal. The
 * statement it runs carries `AND kind = 'observed'` as well, so even a cast
 * cannot reach an inferred row: the `BEFORE DELETE` trigger in the migration
 * is a backstop that never has to fire.
 *
 * Demotion is the alternative, and it is a first-class operation:
 * {@link MemoryGraph.demote}, {@link MemoryGraph.suppress},
 * {@link MemoryGraph.promote}, {@link MemoryGraph.demoteDueEdges}.
 *
 *
 * ## A partition key prunes SCANS, never IDENTITY LOOKUPS
 *
 * Every method here is one or the other, deliberately:
 *
 * | Scans — hot tier only          | Identity lookups — every tier             |
 * | ------------------------------ | ----------------------------------------- |
 * | {@link MemoryGraph.listNodes}  | {@link MemoryGraph.getNode}               |
 * | {@link MemoryGraph.neighbourhood} | {@link MemoryGraph.getEdge}            |
 * |                                | {@link MemoryGraph.findEdge}              |
 * |                                | {@link MemoryGraph.edgesBetween}          |
 * |                                | {@link MemoryGraph.nodesForSubject}       |
 *
 * The right-hand column never mentions `tier` in its SQL. That is not an
 * optimisation detail: if a cold edge cannot be found, "demote, never prune"
 * has silently become "prune, slowly, while claiming otherwise", and the row is
 * still on disk with nothing able to reach it — worse than a delete, because it
 * looks fine. {@link EDGE_IDENTITY_SQL} is pinned as an exported constant so a
 * test can assert on the text.
 *
 * The left-hand column defaults to `hot` and takes an explicit tier list for
 * the admin viewer and the cold-store audit, which are the two callers that
 * legitimately want to look at what has been set aside.
 */

/** What went wrong, as a closed set a caller can branch on. */
export type GraphErrorKind =
  | "already_suppressed"
  | "bad_confidence"
  | "bad_depth"
  | "bad_instant"
  | "bad_limit"
  | "bad_subject"
  | "bad_weight"
  | "blank_label"
  | "blank_reasoning"
  | "blank_relation"
  | "corrupt_row"
  | "duplicate_edge"
  | "no_such_observation"
  | "not_cold"
  | "not_hot"
  | "not_suppressed"
  | "self_edge"
  | "unknown_node";

/** Thrown when the graph cannot be read or written as asked. */
export class GraphError extends Error {
  readonly kind: GraphErrorKind;

  constructor(kind: GraphErrorKind, message: string) {
    super(message);
    this.name = "GraphError";
    this.kind = kind;
  }
}

/** A thing the graph knows about. */
export interface MemoryNode {
  readonly id: string;
  readonly tier: MemoryTier;
  readonly kind: MemoryNodeKind;
  readonly label: string;
  readonly body: string | null;
  /** The operational row this node is about — a goal, a to-do — or `null`. */
  readonly subjectId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What both species share. */
interface EdgeCommon {
  readonly id: string;
  readonly tier: MemoryTier;
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly relation: string;
  readonly weight: number;
  readonly lastTouchedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * An edge a source asserted.
 *
 * `assertedBy` is a `string`, not `string | null`: "asserted by a source" is
 * what makes an edge observed, so provenance is not optional on this branch of
 * the union and no caller has to check for it.
 */
export interface ObservedEdge extends EdgeCommon {
  readonly kind: "observed";
  readonly assertedBy: string;
  readonly confidence: null;
  readonly reasoning: null;
  /** Observations do not decay on a timer. Always `null`. */
  readonly demoteAfter: null;
}

/**
 * An edge reflection discovered.
 *
 * `reasoning` is a `string`. If Syl cannot answer *why* two things are
 * connected, the edge cannot be audited, pruned intelligently, or shown to the
 * Commander — and showing him is the whole value.
 */
export interface InferredEdge extends EdgeCommon {
  readonly kind: "inferred";
  readonly assertedBy: null;
  readonly confidence: number;
  readonly reasoning: string;
  /** When this edge next crosses the relevance floor. `null` once it is out of the hot tier. */
  readonly demoteAfter: string | null;
}

/** Either species. Narrow on `kind` to get at what only one of them carries. */
export type MemoryEdge = ObservedEdge | InferredEdge;

/** What {@link MemoryGraph.addNode} needs. A new node is always hot. */
export interface CreateNodeInput {
  readonly kind: MemoryNodeKind;
  readonly label: string;
  readonly body?: string | null;
  readonly subjectId?: string | null;
}

/** What {@link MemoryGraph.observe} needs. */
export interface ObserveInput {
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly relation: string;
  /** The node — usually of kind `source` — that asserted this. Mandatory. */
  readonly assertedBy: string;
  /** Ranking strength, in (0, 1]. Defaults to 1: a source said so. */
  readonly weight?: number;
}

/** What {@link MemoryGraph.infer} needs. */
export interface InferInput {
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly relation: string;
  /**
   * WHY this edge exists. Mandatory, and required by the type rather than
   * merely rejected by the CHECK.
   */
  readonly reasoning: string;
  /** How sure the reflection was, in (0, 1]. */
  readonly confidence: number;
  /**
   * When this edge next crosses the relevance floor.
   *
   * Required, because {@link MemoryGraph.infer} always writes into the hot
   * tier and a hot inference that does not know when it crosses is invisible
   * to the nightly sweep. The decay law that computes this instant belongs to
   * `syl-005.3.2`; this store only insists that it exists.
   */
  readonly demoteAfter: string;
  /** Ranking strength, in (0, 1]. Defaults to 1. */
  readonly weight?: number;
}

/** What {@link MemoryGraph.promote} needs for an inference. */
export interface Reactivation {
  /** The new crossing instant. A hot inference always has one. */
  readonly demoteAfter: string;
  /** The reactivated weight, in (0, 1]. Left alone when omitted. */
  readonly weight?: number;
}

/** What {@link MemoryGraph.listNodes} may narrow by. This is a SCAN. */
export interface NodeFilter {
  /** Defaults to `hot`. Anything else is an explicit look at what was set aside. */
  readonly tier?: MemoryTier;
  readonly kind?: MemoryNodeKind;
  readonly limit?: number;
}

/** What {@link MemoryGraph.neighbourhood} may be shaped by. This is a SCAN. */
export interface NeighbourhoodOptions {
  /** How many hops out. Defaults to 1; 0 returns the origin alone. */
  readonly depth?: number;
  /** Which partitions to walk. Defaults to `hot` alone. */
  readonly tiers?: readonly MemoryTier[];
  /** The most edges to visit. Defaults to {@link DEFAULT_NEIGHBOURHOOD_LIMIT}. */
  readonly limit?: number;
}

/**
 * A hot node with the total weight of the hot edges touching it.
 *
 * `salience` is a RANKING number and nothing else: it is not stored, not
 * decayed here, and not a fact about the node. It exists so the working-memory
 * projection can pick the graph's hot region's most connected corner
 * deterministically. When `weights.ts` lands its decay law, the sum should be
 * over EFFECTIVE weight; the shape of this type does not change.
 */
export interface SalientNode extends MemoryNode {
  readonly salience: number;
}

/** A node and what surrounds it. */
export interface Neighbourhood {
  readonly origin: MemoryNode;
  /** Every node reached, the origin included. Fetched by id, so tier-free. */
  readonly nodes: readonly MemoryNode[];
  /** Every edge walked, in both directions. */
  readonly edges: readonly MemoryEdge[];
}

/** How many nodes a list returns when nobody says. */
export const DEFAULT_NODE_LIMIT = 50;

/** How many edges a traversal walks when nobody says. */
export const DEFAULT_NEIGHBOURHOOD_LIMIT = 200;

const NODE_COLUMNS = "id, tier, kind, label, body, subject_id, created_at, updated_at";

/** {@link NODE_COLUMNS}, qualified, for the one query that joins. */
const NODE_COLUMNS_QUALIFIED = NODE_COLUMNS.split(", ")
  .map((column) => `n.${column}`)
  .join(", ");

/**
 * Hot nodes ranked by how much hot edge weight touches them, pinned as text.
 *
 * Written as a `UNION ALL` over the two endpoint columns and then aggregated,
 * rather than as a correlated `SUM(...) WHERE source = n.id OR target = n.id`.
 * The `OR` form cannot use `memory_edges_rank_idx` or the reverse index — it
 * degrades to a full edge scan per node, so the cost is quadratic in a graph
 * that grows monotonically forever by construction (constraint 6).
 *
 * Both halves carry `tier = 'hot'`: this is a SCAN, and the whole reason
 * dormant edges are MOVED rather than merely ranked down is that a scan must
 * not pay for the graph's accumulated history.
 */
export const SALIENCE_SQL =
  `WITH incident AS ( ` +
  `SELECT source_node AS node_id, weight FROM memory_edges WHERE tier = 'hot' ` +
  `UNION ALL ` +
  `SELECT target_node AS node_id, weight FROM memory_edges WHERE tier = 'hot' ` +
  `), salience AS ( ` +
  `SELECT node_id, sum(weight) AS total FROM incident GROUP BY node_id ` +
  `) ` +
  `SELECT ${NODE_COLUMNS_QUALIFIED}, coalesce(s.total, 0.0) AS salience ` +
  `FROM memory_nodes n LEFT JOIN salience s ON s.node_id = n.id ` +
  `WHERE n.tier = 'hot' ` +
  `ORDER BY salience DESC, n.updated_at DESC, n.id LIMIT ?`;

const EDGE_COLUMNS =
  "id, tier, kind, source_node, target_node, relation, weight, confidence, " +
  "reasoning, asserted_by, last_touched_at, demote_after, created_at, updated_at";

/**
 * The identity lookup, pinned as text.
 *
 * It does not mention `tier`, and a test asserts that it does not. Not leading
 * with the partition key is exactly what lets `memory_edges_identity_idx` span
 * cold and suppressed at O(log n) — see §3 of `0012_memory_core.sql`. A `tier`
 * predicate added here would be invisible at every other layer: every query
 * would still return the right rows, and cold edges would simply stop being
 * found.
 */
export const EDGE_IDENTITY_SQL =
  `SELECT ${EDGE_COLUMNS} FROM memory_edges ` +
  `WHERE source_node = ? AND target_node = ? AND relation = ?`;

/**
 * The nightly demotion sweep, pinned as text.
 *
 * `demote_after = NULL` is not optional and a test asserts on this string.
 * `memory_edges_demote_idx` is PARTIAL on `demote_after IS NOT NULL` and says
 * nothing about tier, so an edge whose tier moved while its stamp stayed behind
 * remains in that index forever — quietly accumulating exactly the history the
 * partitioning exists to keep out of the hot path. The failure is invisible
 * until the index has grown to hold the whole graph.
 */
export const DEMOTE_SWEEP_SQL =
  `UPDATE memory_edges SET tier = 'cold', demote_after = NULL, updated_at = ? ` +
  `WHERE tier = 'hot' AND demote_after IS NOT NULL AND demote_after <= ?`;

interface NodeRow {
  readonly id: string;
  readonly tier: string;
  readonly kind: string;
  readonly label: string;
  readonly body: string | null;
  readonly subject_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface EdgeRow {
  readonly id: string;
  readonly tier: string;
  readonly kind: string;
  readonly source_node: string;
  readonly target_node: string;
  readonly relation: string;
  readonly weight: number;
  readonly confidence: number | null;
  readonly reasoning: string | null;
  readonly asserted_by: string | null;
  readonly last_touched_at: string;
  readonly demote_after: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Whitespace SQLite's `trim` would miss: space, tab, newline, carriage return. */
const BLANK = /^[\s]*$/u;

function toNode(row: NodeRow): MemoryNode {
  // The migration's CHECKs pin both vocabularies, so the row is already known
  // good; `nodePartition` is what turns that into types the compiler agrees to.
  const partition = nodePartition(row.tier, row.kind);
  return {
    id: row.id,
    tier: partition.tier,
    kind: partition.kind as MemoryNodeKind,
    label: row.label,
    body: row.body,
    subjectId: row.subject_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A row, as exactly one species.
 *
 * The refusals below are unreachable while the CHECKs are on. They exist
 * because the alternative — a non-null assertion — would hand out an
 * `InferredEdge` whose `reasoning` is `null` at runtime, and every caller
 * downstream trusts that field to be there.
 */
function toEdge(row: EdgeRow): MemoryEdge {
  const tier = nodePartition(row.tier, "fact").tier;
  const common: EdgeCommon = {
    id: row.id,
    tier,
    sourceNode: row.source_node,
    targetNode: row.target_node,
    relation: row.relation,
    weight: row.weight,
    lastTouchedAt: row.last_touched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.kind === "observed") {
    if (row.asserted_by === null) {
      throw new GraphError(
        "corrupt_row",
        `Edge ${row.id} claims to be observed but carries no provenance. ` +
          `"Asserted by a source" is what makes an edge observed.`,
      );
    }
    return { ...common, kind: "observed", assertedBy: row.asserted_by, confidence: null, reasoning: null, demoteAfter: null };
  }

  if (row.confidence === null || row.reasoning === null) {
    throw new GraphError(
      "corrupt_row",
      `Edge ${row.id} claims to be inferred but carries no reasoning or no confidence. ` +
        `An inference nobody can audit is a rumour.`,
    );
  }
  return {
    ...common,
    kind: "inferred",
    assertedBy: null,
    confidence: row.confidence,
    reasoning: row.reasoning,
    demoteAfter: row.demote_after,
  };
}

function requireText(value: string, kind: GraphErrorKind, what: string): string {
  const trimmed = value.trim();
  if (BLANK.test(value) || trimmed === "") {
    throw new GraphError(kind, `${what} cannot be blank.`);
  }
  return trimmed;
}

function requireUnitInterval(value: number, kind: GraphErrorKind, what: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new GraphError(
      kind,
      `${what} must be a real number in (0, 1], got ${String(value)}. Zero is excluded ` +
        `because decay approaches it asymptotically and never arrives, so a stored zero ` +
        `would be an edge that could never be promoted back.`,
    );
  }
  return value;
}

function requireInstant(value: string, what: string): string {
  if (parseInstant(value) === null) {
    throw new GraphError(
      "bad_instant",
      `${what} must be an RFC 3339 UTC instant with millisecond precision, got ` +
        `${JSON.stringify(value)}. A fixed offset is a property of an instant, not of a ` +
        `place, and one that reaches storage survives exactly one DST boundary.`,
    );
  }
  return value;
}

function requireCount(value: number, kind: GraphErrorKind, what: string, floor: number): number {
  if (!Number.isInteger(value) || value < floor) {
    throw new GraphError(kind, `${what} must be an integer of at least ${String(floor)}, got ${String(value)}.`);
  }
  return value;
}

function requireSubject(value: string): string {
  if (!isId(value)) {
    throw new GraphError(
      "bad_subject",
      `A subject must be a type-prefixed id like syl:goal:<uuid>, got ${JSON.stringify(value)}. ` +
        `A dangling reference is only legible because ids carry their type.`,
    );
  }
  return value;
}

export interface MemoryGraphOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

export class MemoryGraph {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: MemoryGraphOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  // ── Nodes ────────────────────────────────────────────────────────────────

  /**
   * Write a node.
   *
   * Always into the hot tier. There is no `tier` on the input on purpose: a
   * colder partition is only ever reached by a MOVE, which is what makes
   * "demotion and partitioning are the same mechanism" true of the API and not
   * just of the schema.
   *
   * @throws {GraphError} `blank_label`, `bad_subject`.
   */
  addNode(input: CreateNodeInput): MemoryNode {
    const partition = nodePartition(SCANNED_TIER, input.kind);
    const label = requireText(input.label, "blank_label", "A node's label");
    const subjectId = input.subjectId == null ? null : requireSubject(input.subjectId);
    const id = newMemoryNodeId();
    const at = instant(this.#clock());

    this.#db
      .prepare(`INSERT INTO memory_nodes (${NODE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, partition.tier, partition.kind, label, input.body ?? null, subjectId, at, at);

    return this.#nodeOrThrow(id);
  }

  /** One node by id, or `null`. An IDENTITY LOOKUP: it spans every tier. */
  getNode(id: string): MemoryNode | null {
    const row = this.#db.prepare(`SELECT ${NODE_COLUMNS} FROM memory_nodes WHERE id = ?`).get(id);
    return row === undefined ? null : toNode(row as unknown as NodeRow);
  }

  /**
   * A page of nodes from one partition, most recently touched first.
   *
   * A SCAN, so it reads the hot tier unless told otherwise, and it is served by
   * `memory_nodes_scan_idx (tier, kind, updated_at DESC)`.
   *
   * @throws {GraphError} `bad_limit`; {@link MemorySchemaError} on a tier or
   * kind outside the vocabulary.
   */
  listNodes(filter: NodeFilter = {}): MemoryNode[] {
    const tier = nodePartition(filter.tier ?? SCANNED_TIER, filter.kind ?? "fact").tier;
    const limit = requireCount(filter.limit ?? DEFAULT_NODE_LIMIT, "bad_limit", "A limit", 1);

    const conditions = ["tier = ?"];
    const bindings: (string | number)[] = [tier];
    if (filter.kind !== undefined) {
      conditions.push("kind = ?");
      bindings.push(filter.kind);
    }

    return this.#db
      .prepare(
        `SELECT ${NODE_COLUMNS} FROM memory_nodes WHERE ${conditions.join(" AND ")} ` +
          `ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...bindings, limit)
      .map((row) => toNode(row as unknown as NodeRow));
  }

  /**
   * Every node about one operational row — "what does the graph know about this
   * goal?".
   *
   * An IDENTITY LOOKUP on the partial subject index, so it spans every tier: a
   * superseded node is still a thing the graph knows about that goal.
   *
   * @throws {GraphError} `bad_subject`.
   */
  nodesForSubject(subjectId: string): MemoryNode[] {
    return this.#db
      .prepare(`SELECT ${NODE_COLUMNS} FROM memory_nodes WHERE subject_id = ? ORDER BY created_at, id`)
      .all(requireSubject(subjectId))
      .map((row) => toNode(row as unknown as NodeRow));
  }

  /**
   * The hot region, most connected first.
   *
   * A SCAN, and the one query in this module that ranks rather than filters.
   * It exists for the working-memory projection (`syl-005.5.1`): "the graph's
   * hot region" is the hot tier, and "distilled" is this ordering plus a byte
   * budget applied on the way out.
   *
   * The ordering is TOTAL — salience, then recency, then id — so two runs over
   * an unchanged graph produce the same rows in the same order. That is not a
   * nicety: a projection that reorders on every run is regenerated on every
   * run, and "regenerate only when the graph moved" stops being detectable.
   *
   * @throws {GraphError} `bad_limit`.
   */
  listSalientNodes(limit: number = DEFAULT_NODE_LIMIT): SalientNode[] {
    const capped = requireCount(limit, "bad_limit", "A limit", 1);
    return this.#db
      .prepare(SALIENCE_SQL)
      .all(capped)
      .map((row) => {
        const typed = row as unknown as NodeRow & { salience: number };
        return { ...toNode(typed), salience: typed.salience };
      });
  }

  /**
   * Rename a node.
   *
   * The projection contract (`syl-005.1.4`) is `{ id, type, label, ref }`, and
   * `label` is the one of the four that can legitimately move: a goal gets
   * retitled, an article's `<title>` is found on the second fetch. Without
   * this, regeneration could only ever create — so the graph would keep
   * asserting the old name forever, which is precisely the silent drift the
   * four-field contract exists to prevent, just relocated to the one field it
   * did not remove.
   *
   * The statement carries `AND label <> ?`, so **relabelling to the name it
   * already has touches nothing** — no write, no `updated_at` bump. That is
   * what lets an idempotence test assert on `updatedAt` instead of merely on
   * the row count.
   *
   * @throws {GraphError} `blank_label`, `unknown_node`.
   */
  relabel(node: MemoryNode, label: string): MemoryNode {
    const next = requireText(label, "blank_label", "A node's label");
    const at = instant(this.#clock());

    this.#db
      .prepare("UPDATE memory_nodes SET label = ?, updated_at = ? WHERE id = ? AND label <> ?")
      .run(next, at, node.id, next);

    return this.#nodeOrThrow(node.id);
  }

  // ── Edges: the two species ───────────────────────────────────────────────

  /**
   * Assert an edge on a source's authority.
   *
   * Provenance is mandatory and confidence, reasoning and a crossing instant
   * are absent — an observation does not decay on a timer, because it is
   * simply what a source said.
   *
   * @throws {GraphError} `unknown_node`, `self_edge`, `blank_relation`,
   * `bad_weight`, `duplicate_edge`.
   */
  observe(input: ObserveInput): ObservedEdge {
    const relation = this.#validateEndpoints(input.sourceNode, input.targetNode, input.relation);
    this.#requireNode(input.assertedBy, "The node asserting an observation");
    const weight = requireUnitInterval(input.weight ?? 1, "bad_weight", "A weight");
    const at = instant(this.#clock());
    const id = newMemoryEdgeId();

    this.#insertEdge(
      [
        id,
        SCANNED_TIER,
        "observed",
        input.sourceNode,
        input.targetNode,
        relation,
        weight,
        null,
        null,
        input.assertedBy,
        at,
        null,
        at,
        at,
      ],
      input.sourceNode,
      input.targetNode,
      relation,
    );

    return this.#edgeOrThrow(id, "observed") as ObservedEdge;
  }

  /**
   * Record something reflection worked out.
   *
   * Reasoning is mandatory — required by {@link InferInput} rather than merely
   * refused by the CHECK — and so is the crossing instant, because this writes
   * into the hot tier and the nightly sweep is only complete if every hot
   * inference knows when it next crosses the floor.
   *
   * @throws {GraphError} `unknown_node`, `self_edge`, `blank_relation`,
   * `blank_reasoning`, `bad_confidence`, `bad_weight`, `bad_instant`,
   * `duplicate_edge`.
   */
  infer(input: InferInput): InferredEdge {
    const relation = this.#validateEndpoints(input.sourceNode, input.targetNode, input.relation);
    const reasoning = requireText(input.reasoning, "blank_reasoning", "An inference's reasoning");
    const confidence = requireUnitInterval(input.confidence, "bad_confidence", "A confidence");
    const weight = requireUnitInterval(input.weight ?? 1, "bad_weight", "A weight");
    const demoteAfter = requireInstant(input.demoteAfter, "A scheduled floor crossing");
    const at = instant(this.#clock());
    const id = newMemoryEdgeId();

    this.#insertEdge(
      [
        id,
        SCANNED_TIER,
        "inferred",
        input.sourceNode,
        input.targetNode,
        relation,
        weight,
        confidence,
        reasoning,
        null,
        at,
        demoteAfter,
        at,
        at,
      ],
      input.sourceNode,
      input.targetNode,
      relation,
    );

    return this.#edgeOrThrow(id, "inferred") as InferredEdge;
  }

  /** One edge by id, or `null`. An IDENTITY LOOKUP: it spans every tier. */
  getEdge(id: string): MemoryEdge | null {
    const row = this.#db.prepare(`SELECT ${EDGE_COLUMNS} FROM memory_edges WHERE id = ?`).get(id);
    return row === undefined ? null : toEdge(row as unknown as EdgeRow);
  }

  /**
   * The edge relating two nodes that way, or `null`.
   *
   * An edge's identity is `(source, target, relation)` — the species is a
   * property, not part of it — and this lookup **spans every tier**. Finding a
   * suppressed edge here is what stops the next reflection pass recreating one
   * the Commander already rejected. See {@link EDGE_IDENTITY_SQL}.
   */
  findEdge(sourceNode: string, targetNode: string, relation: string): MemoryEdge | null {
    const row = this.#db.prepare(EDGE_IDENTITY_SQL).get(sourceNode, targetNode, relation);
    return row === undefined ? null : toEdge(row as unknown as EdgeRow);
  }

  /**
   * Every edge joining a pair, in either direction and in every tier.
   *
   * An IDENTITY LOOKUP, served by the two tier-free indexes.
   */
  edgesBetween(a: string, b: string): MemoryEdge[] {
    return this.#db
      .prepare(
        `SELECT ${EDGE_COLUMNS} FROM memory_edges ` +
          `WHERE (source_node = ? AND target_node = ?) OR (source_node = ? AND target_node = ?) ` +
          `ORDER BY created_at, id`,
      )
      .all(a, b, b, a)
      .map((row) => toEdge(row as unknown as EdgeRow));
  }

  /**
   * Every observation one node asserted, in every tier.
   *
   * An IDENTITY LOOKUP, served by `memory_edges_asserted_by_idx` — which is
   * partial on `asserted_by IS NOT NULL`, so it holds observations only and an
   * inference cannot be returned here whatever the caller does.
   *
   * This is the graph half of the provenance chain the retention classes exist
   * for: `intake_sources` can hard-delete a source's chunks and extracts
   * through its foreign keys, but a foreign key cannot reach the graph (and
   * deliberately must not — see `0013`'s header on why the graph stays
   * unreferenced). So the reach has to be a query, and this is it. Without it,
   * "the class is assigned at intake so a delete can later follow the chain"
   * is a promise with no mechanism behind it.
   *
   * The return type is `ObservedEdge[]` rather than `MemoryEdge[]` because
   * that is what makes {@link MemoryGraph.retract} callable on the result: a
   * caller forgetting a source can withdraw everything the source asserted
   * without narrowing, and still cannot reach an inference.
   */
  edgesAssertedBy(nodeId: string): ObservedEdge[] {
    return this.#db
      .prepare(`SELECT ${EDGE_COLUMNS} FROM memory_edges WHERE asserted_by = ? ORDER BY created_at, id`)
      .all(nodeId)
      .map((row) => toEdge(row as unknown as EdgeRow))
      .filter((edge): edge is ObservedEdge => edge.kind === "observed");
  }

  /**
   * The graph around a node.
   *
   * A SCAN, so it walks the hot tier unless told otherwise — the whole reason
   * dormant edges are moved rather than merely ranked down is that a traversal
   * must not pay for the graph's accumulated history. The admin viewer and the
   * cold-store audit pass `tiers` explicitly.
   *
   * Nodes reached are fetched by id and are therefore tier-free: a hot edge
   * pointing at a superseded node still yields that node, because the edge is
   * what the traversal is filtering, not the endpoint.
   *
   * @throws {GraphError} `unknown_node`, `bad_depth`, `bad_limit`.
   */
  neighbourhood(nodeId: string, options: NeighbourhoodOptions = {}): Neighbourhood {
    const origin = this.getNode(nodeId);
    if (origin === null) {
      throw new GraphError("unknown_node", `${nodeId} is not a node in the memory graph.`);
    }

    const depth = requireCount(options.depth ?? 1, "bad_depth", "A traversal depth", 0);
    const limit = requireCount(
      options.limit ?? DEFAULT_NEIGHBOURHOOD_LIMIT,
      "bad_limit",
      "A limit",
      1,
    );
    const tiers = (options.tiers ?? [SCANNED_TIER]).map(
      (tier) => nodePartition(tier, "fact").tier,
    );

    const nodes = new Map<string, MemoryNode>([[origin.id, origin]]);
    const edges = new Map<string, MemoryEdge>();
    let frontier: string[] = [origin.id];

    for (let hop = 0; hop < depth && frontier.length > 0 && edges.size < limit; hop += 1) {
      const next: string[] = [];
      for (const from of frontier) {
        for (const edge of this.#edgesTouching(from, tiers)) {
          if (edges.size >= limit) break;
          if (edges.has(edge.id)) continue;
          edges.set(edge.id, edge);

          const other = edge.sourceNode === from ? edge.targetNode : edge.sourceNode;
          if (nodes.has(other)) continue;
          const node = this.getNode(other);
          if (node === null) continue;
          nodes.set(other, node);
          next.push(other);
        }
        if (edges.size >= limit) break;
      }
      frontier = next;
    }

    return { origin, nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  // ── Moving between partitions ────────────────────────────────────────────

  /**
   * Move a hot edge out of the scan.
   *
   * **Always clears `demote_after`.** See {@link DEMOTE_SWEEP_SQL} for why that
   * is not optional.
   *
   * @throws {GraphError} `not_hot` if the edge is not in the hot tier — or is
   * no longer in the store at all. The statement's own `tier = 'hot'`
   * predicate is what decides, so a stale value in the caller's hand cannot
   * move a row that has since been moved by someone else.
   */
  demote(edge: MemoryEdge): MemoryEdge {
    return this.#move(edge, "hot", "cold", "not_hot", "A demotion");
  }

  /**
   * Mark an edge as wrong, because the Commander said so.
   *
   * `suppressed` is not a colder `cold`. It leaves the scan whatever the weight
   * does and is **never promoted back automatically**; only
   * {@link MemoryGraph.unsuppress} brings it back, and even that only as far as
   * `cold`. It stays findable by identity precisely so reflection cannot
   * recreate an edge he already rejected.
   *
   * @throws {GraphError} `already_suppressed`.
   */
  suppress(edge: MemoryEdge): MemoryEdge {
    const at = instant(this.#clock());
    const moved = this.#db
      .prepare(
        `UPDATE memory_edges SET tier = 'suppressed', demote_after = NULL, updated_at = ? ` +
          `WHERE id = ? AND tier <> 'suppressed'`,
      )
      .run(at, edge.id);

    if (moved.changes === 0) {
      throw new GraphError(
        "already_suppressed",
        `Edge ${edge.id} is already suppressed, or is no longer in the store.`,
      );
    }
    return this.#edgeOrThrow(edge.id, edge.kind);
  }

  /**
   * Undo a suppression, as far as the cold tier and no further.
   *
   * Deliberately not straight to hot: withdrawing the Commander's rejection
   * does not re-assert the edge's relevance. It becomes addressable by
   * reactivation again, and reactivation decides.
   *
   * @throws {GraphError} `not_suppressed`.
   */
  unsuppress(edge: MemoryEdge): MemoryEdge {
    return this.#move(edge, "suppressed", "cold", "not_suppressed", "An un-suppression");
  }

  /**
   * Bring a cold edge back into the scan.
   *
   * The statement matches `tier = 'cold'` and nothing else, so a **suppressed
   * edge is not merely refused — it is not addressed.** Reactivation may
   * promote `cold`, never `suppressed`: the Commander's judgement is not
   * something reflection gets to overrule.
   *
   * An inference must supply the instant it next crosses the floor, because a
   * hot inference always has one. An observation takes no second argument at
   * all, because it never crosses on its own — and the two overloads mean
   * neither mistake compiles.
   *
   * @throws {GraphError} `not_cold`, `bad_instant`, `bad_weight`.
   */
  promote(edge: InferredEdge, reactivation: Reactivation): InferredEdge;
  promote(edge: ObservedEdge): ObservedEdge;
  promote(edge: MemoryEdge, reactivation?: Reactivation): MemoryEdge {
    const demoteAfter =
      reactivation === undefined
        ? null
        : requireInstant(reactivation.demoteAfter, "A scheduled floor crossing");
    const weight =
      reactivation?.weight === undefined
        ? edge.weight
        : requireUnitInterval(reactivation.weight, "bad_weight", "A weight");
    const at = instant(this.#clock());

    const moved = this.#db
      .prepare(
        `UPDATE memory_edges SET tier = 'hot', weight = ?, last_touched_at = ?, ` +
          `demote_after = ?, updated_at = ? WHERE id = ? AND tier = 'cold'`,
      )
      .run(weight, at, demoteAfter, at, edge.id);

    if (moved.changes === 0) {
      throw new GraphError(
        "not_cold",
        `Edge ${edge.id} is not in the cold tier, so reactivation does not reach it. ` +
          `A suppressed edge is never promoted back automatically — the Commander said it ` +
          `is wrong, and only an explicit un-suppression undoes that.`,
      );
    }
    return this.#edgeOrThrow(edge.id, edge.kind);
  }

  /**
   * The nightly sweep: move every hot edge past its crossing instant to cold.
   *
   * A range scan over `memory_edges_demote_idx`, touching the rows that
   * actually moved and nothing else — never an `UPDATE` across the graph. The
   * decay law and the relevance floor that produced those instants belong to
   * `syl-005.3.2`; the statement belongs here, in one place, because it is the
   * one that must clear the stamp. See {@link DEMOTE_SWEEP_SQL}.
   *
   * @returns how many edges moved.
   * @throws {GraphError} `bad_instant`.
   */
  demoteDueEdges(now: string): number {
    const at = requireInstant(now, "A sweep instant");
    return this.#db.prepare(DEMOTE_SWEEP_SQL).run(instant(this.#clock()), at).changes as number;
  }

  // ── The only delete in this module ───────────────────────────────────────

  /**
   * Withdraw an observation.
   *
   * An observation can be retracted: the source was wrong, or the Commander
   * asked for something to be forgotten outright. An **inference cannot**,
   * because the next reflection pass would simply rediscover it — suppression
   * is the mechanism for that, and it is a tier.
   *
   * This takes an {@link ObservedEdge} **value**, not an id, which is what
   * makes deleting an inference unrepresentable rather than merely rejected:
   * the only way to hold an `ObservedEdge` is to have narrowed on `kind`, so
   * `retract(anInference)` does not compile. The statement carries
   * `kind = 'observed'` as well, so even a cast cannot reach an inferred row
   * and the migration's `BEFORE DELETE` trigger never has to fire.
   *
   * @throws {GraphError} `no_such_observation`.
   */
  retract(edge: ObservedEdge): void {
    const removed = this.#db
      .prepare(`DELETE FROM memory_edges WHERE id = ? AND kind = 'observed'`)
      .run(edge.id);

    if (removed.changes === 0) {
      throw new GraphError(
        "no_such_observation",
        `${edge.id} is not an observation in the store. An inferred edge is never deleted, ` +
          `only demoted — move it to the cold or suppressed tier instead.`,
      );
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Edges out of and into a node, restricted to the partitions being walked. */
  #edgesTouching(nodeId: string, tiers: readonly MemoryTier[]): MemoryEdge[] {
    const holes = tiers.map(() => "?").join(", ");
    const outgoing = this.#db
      .prepare(
        `SELECT ${EDGE_COLUMNS} FROM memory_edges WHERE tier IN (${holes}) AND source_node = ? ` +
          `ORDER BY weight DESC, last_touched_at DESC, id`,
      )
      .all(...tiers, nodeId);
    const incoming = this.#db
      .prepare(
        `SELECT ${EDGE_COLUMNS} FROM memory_edges WHERE target_node = ? AND tier IN (${holes}) ` +
          `ORDER BY weight DESC, last_touched_at DESC, id`,
      )
      .all(nodeId, ...tiers);

    return [...outgoing, ...incoming].map((row) => toEdge(row as unknown as EdgeRow));
  }

  /** Endpoints exist, are distinct, and the predicate says something. */
  #validateEndpoints(sourceNode: string, targetNode: string, relation: string): string {
    if (sourceNode === targetNode) {
      throw new GraphError(
        "self_edge",
        `A node is not related to itself; an edge saying so is a bug in whatever produced it. ` +
          `Both endpoints were ${sourceNode}.`,
      );
    }
    this.#requireNode(sourceNode, "An edge's source endpoint");
    this.#requireNode(targetNode, "An edge's target endpoint");
    return requireText(relation, "blank_relation", "An edge's relation");
  }

  #requireNode(id: string, what: string): void {
    const row = this.#db.prepare("SELECT 1 AS ok FROM memory_nodes WHERE id = ?").get(id);
    if (row === undefined) {
      throw new GraphError("unknown_node", `${what} must be a node in the graph; ${id} is not.`);
    }
  }

  /**
   * Insert an edge, turning a UNIQUE violation into an explanation.
   *
   * The duplicate check is enforced by the store rather than by a
   * check-then-write in TypeScript that a retry could slip past. Reporting the
   * existing edge's TIER matters: "already there, suppressed" is a different
   * situation from "already there, hot", and it is the one that tells a
   * reflection pass it has rediscovered something the Commander rejected.
   */
  #insertEdge(
    values: readonly (string | number | null)[],
    sourceNode: string,
    targetNode: string,
    relation: string,
  ): void {
    try {
      this.#db
        .prepare(
          `INSERT INTO memory_edges (${EDGE_COLUMNS}) ` +
            `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...values);
    } catch (cause) {
      const existing = this.findEdge(sourceNode, targetNode, relation);
      if (existing === null) throw cause;
      throw new GraphError(
        "duplicate_edge",
        `${sourceNode} —${relation}→ ${targetNode} already exists as ${existing.id}, in the ` +
          `${existing.tier} tier. An edge's identity is (source, target, relation); the ` +
          `species is a property, not part of it.` +
          (existing.tier === "suppressed"
            ? ` This one is suppressed: the Commander said it is wrong, and it stays findable ` +
              `precisely so it is not recreated.`
            : ""),
      );
    }
  }

  /** Move a row between two named tiers, clearing the stamp on the way. */
  #move(
    edge: MemoryEdge,
    from: MemoryTier,
    to: MemoryTier,
    kind: GraphErrorKind,
    what: string,
  ): MemoryEdge {
    const at = instant(this.#clock());
    const moved = this.#db
      .prepare(
        `UPDATE memory_edges SET tier = ?, demote_after = NULL, updated_at = ? ` +
          `WHERE id = ? AND tier = ?`,
      )
      .run(to, at, edge.id, from);

    if (moved.changes === 0) {
      throw new GraphError(
        kind,
        `${what} only reaches an edge in the ${from} tier, and ${edge.id} is not in it ` +
          `(or is no longer in the store).`,
      );
    }
    return this.#edgeOrThrow(edge.id, edge.kind);
  }

  #nodeOrThrow(id: string): MemoryNode {
    const node = this.getNode(id);
    if (node === null) throw new GraphError("unknown_node", `Node ${id} vanished during write.`);
    return node;
  }

  #edgeOrThrow(id: string, species: "observed" | "inferred"): MemoryEdge {
    const edge = this.getEdge(id);
    if (edge === null) {
      throw new GraphError("corrupt_row", `Edge ${id} vanished during write.`);
    }
    if (edge.kind !== species) {
      throw new GraphError(
        "corrupt_row",
        `Edge ${id} came back as ${edge.kind} where ${species} was written.`,
      );
    }
    return edge;
  }
}
