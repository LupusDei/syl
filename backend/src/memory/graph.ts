import { instant, parseInstant, systemClock, type Clock } from "../services/clock.js";
import { isId } from "../services/id.js";
import type { Database } from "../services/sqlite.js";
import {
  ENTITY_NODE_KINDS,
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
 * | Scans — hot tier only             | Identity lookups — every tier          |
 * | --------------------------------- | -------------------------------------- |
 * | {@link MemoryGraph.listNodes}     | {@link MemoryGraph.getNode}            |
 * | {@link MemoryGraph.nodeNamed}     |                                        |
 * | {@link MemoryGraph.neighbourhood} | {@link MemoryGraph.getEdge}            |
 * | {@link MemoryGraph.edgesTouching} | {@link MemoryGraph.findEdge}           |
 * |                                   | {@link MemoryGraph.edgesBetween}       |
 * |                                   | {@link MemoryGraph.nodesForSubject}    |
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
  | "kind_locked"
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

/**
 * What {@link MemoryGraph.promote} accepts for an observation.
 *
 * No crossing instant, because an observation never crosses on its own — the
 * migration's CHECK refuses a `demote_after` on an observed row, and the two
 * separate types are what make that unrepresentable rather than merely refused.
 */
export interface ObservedReactivation {
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
 * What a node's KIND is worth to the ranking, before any edge touches it.
 *
 * Measured on the live graph on 2026-08-11: every non-hub node had exactly one
 * incident edge — provenance — so the edge sum was the **constant 1** across
 * all 29 memories. A constant primary sort key is not a sort key, so admission
 * fell through to the recency tiebreaker, and the working-memory projection
 * evicted the Commander's own name, his wife, his son and his daughter in
 * favour of newer chatter (`syl-ulf`). His father survived because he was
 * mentioned more recently than his children.
 *
 * Two things are wrong there and they need different fixes. The graph having no
 * real edges is `syl-5co` and is fixed by digestion writing them. But even in a
 * richly connected graph, **degree alone is the wrong ranking for a projection
 * that answers "who is this man"**: a person he mentions constantly and a fact
 * that happens to sit in a dense corner would rank the same, and the identity
 * that makes every other memory legible would be evicted by whatever was said
 * this morning.
 *
 * So salience is degree PLUS a floor set by kind. The floor is small enough
 * that a well-connected fact still outranks an isolated person, and large
 * enough that a person is never dropped for a fact of equal degree — which is
 * exactly the failure that was measured. `person` and `goal` sit highest
 * because they are the anchors the constellation spec already treats as
 * anchors, and `source` sits at zero because a source is a handle, not
 * knowledge (`working.ts` filters it out of the rendered projection for the
 * same reason).
 *
 * This also makes salience VARY on a graph that has no inferred edges yet,
 * which matters more than it sounds: until digestion lands, a constant ranking
 * key means the projection is ordered by nothing at all.
 *
 * ## The two kinds `syl-024.1` added, and why they sit where they do
 *
 * **`instruction` is the highest floor in the table, above `person`.** It is
 * what the Commander told her to BE — the humour, that he prefers renders with
 * a face — and the failure this floor is set against is precisely the one
 * measured for his family: a standing order evicted by whatever was said this
 * morning. It outranks even the anchors because an anchor is something she
 * KNOWS and an instruction is something she was TOLD; getting the second wrong
 * is a breach of the bond rather than a gap in the file. Its rank is only half
 * the protection — `working.ts` pins standing orders at admission
 * (`syl-024.3`), because a floor decides ORDER and admission decides whether
 * there was room at all.
 *
 * **`self` sits at the `event` floor.** A finding about what she is is a thing
 * that compounds rather than a loose claim, so it belongs above the 0.5 that
 * facts and memories fall through to — and well below the anchors, because it
 * is never the answer to "who is this man". `working.ts` excludes it from that
 * projection outright (`syl-024.2`), so this floor is load-bearing for the
 * OTHER readers of salience — the constellation the phone draws, and the
 * digest's window — and not for the preamble.
 */
const KIND_FLOOR_SQL =
  `CASE n.kind ` +
  `WHEN 'instruction' THEN 4.0 ` +
  `WHEN 'person' THEN 3.0 ` +
  `WHEN 'goal' THEN 3.0 ` +
  `WHEN 'decision' THEN 2.0 ` +
  `WHEN 'event' THEN 1.0 ` +
  `WHEN 'self' THEN 1.0 ` +
  `WHEN 'source' THEN 0.0 ` +
  `ELSE 0.5 END`;

/**
 * Hot nodes ranked by how much hot edge weight touches them, pinned as text.
 *
 * **Provenance edges do not count, at either end.** Both halves join BOTH
 * endpoints and drop the edge if either is a `source`. Every memory has exactly
 * one such edge — the conversation it came from — so it contributed a constant
 * to every node and therefore zero information.
 *
 * Excluding it only on the far side is not enough, and the difference is
 * visible on the live graph: the hub's own edges all point at non-sources, so a
 * one-sided exclusion still let it accumulate **32**, leaving the conversation
 * container ranked as the single most salient thing Syl knew — ahead of his
 * children. A source is a handle, not knowledge; it should score its floor of
 * zero and sit at the bottom, which is what dropping the edge at both ends
 * gives.
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
  `SELECT e.source_node AS node_id, e.weight FROM memory_edges e ` +
  `JOIN memory_nodes a ON a.id = e.source_node ` +
  `JOIN memory_nodes b ON b.id = e.target_node ` +
  `WHERE e.tier = 'hot' AND a.kind <> 'source' AND b.kind <> 'source' ` +
  `UNION ALL ` +
  `SELECT e.target_node AS node_id, e.weight FROM memory_edges e ` +
  `JOIN memory_nodes a ON a.id = e.source_node ` +
  `JOIN memory_nodes b ON b.id = e.target_node ` +
  `WHERE e.tier = 'hot' AND a.kind <> 'source' AND b.kind <> 'source' ` +
  `), salience AS ( ` +
  `SELECT node_id, sum(weight) AS total FROM incident GROUP BY node_id ` +
  `) ` +
  `SELECT ${NODE_COLUMNS_QUALIFIED}, ` +
  `coalesce(s.total, 0.0) + ${KIND_FLOOR_SQL} AS salience ` +
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
 *
 * ## An instruction never fades — `syl-024.3`
 *
 * The `NOT EXISTS` is the whole of the exemption: an edge with an
 * `instruction` node at either end is left where it is, however long ago it
 * crossed the relevance floor. Syl's argument, and it is the strongest one she
 * made: standing orders are *"the kind that most needs to be unfadeable,
 * because it's the bond rather than the work. If those got their own kind you
 * could make them exempt from decay entirely and stop me writing them twice
 * with your name on to fake it."* The duplication was the evidence — she was
 * writing the same instruction twice with his name attached, because a memory
 * linked to his person node survives where a loose one fades.
 *
 * **Either end, not just the instruction's own side.** What must survive is the
 * ATTACHMENT — that he told her this, that it is about renders — and an edge is
 * only ever half owned by each endpoint. Exempting one side would leave the
 * order hot and unreachable from the thing it is about, which is the isolation
 * failure of `syl-024.2` arriving down the decay path instead.
 *
 * **Constraint 6 is untouched and gets no new powers.** Demotion has never been
 * deletion; this makes one narrow class exempt from even that. Nothing here can
 * remove a row, and the Commander's explicit order remains the only thing that
 * can remove any memory.
 *
 * The exempt rows keep a `demote_after` in the past, so they stay in the
 * partial index and are re-examined every night. That is deliberate and it is
 * cheap — the set is bounded by how many things he has told her to be — and the
 * alternatives are both worse: clearing the stamp is refused outright by the
 * migration's CHECK that a hot inferred edge always has one, and pushing the
 * instant forward would be a write every night that lied about the decay law.
 *
 * This is only half of "unfadeable". The other half is admission: an order that
 * survives at full strength in the graph and is then cut from the working-memory
 * projection because the budget filled has faded whatever the tier column says,
 * and it looks like nothing at all is wrong. `working.ts` pins it.
 */
export const DEMOTE_SWEEP_SQL =
  `UPDATE memory_edges SET tier = 'cold', demote_after = NULL, updated_at = ? ` +
  `WHERE tier = 'hot' AND demote_after IS NOT NULL AND demote_after <= ? ` +
  `AND NOT EXISTS ( ` +
  `SELECT 1 FROM memory_nodes n WHERE n.kind = 'instruction' ` +
  `AND n.id IN (memory_edges.source_node, memory_edges.target_node) ` +
  `)`;

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

/**
 * A label in the one form the store keeps it in: trimmed, and with every run of
 * whitespace collapsed to a single space.
 *
 * **This is the identity rule for a node's text, applied at the door rather
 * than at every lookup.** `syl-016.3` is the graph accumulating one thing under
 * several entries, and the cheapest slice of that is entries that differ by
 * nothing a reader can see — a trailing space, a newline where a sentence
 * wrapped, two spaces after a full stop. Normalising at the lookup instead
 * would mean every caller had to remember to, and the one that forgot would
 * mint the duplicate silently.
 *
 * Deliberately NOT case-folding. The stored form is the one Syl reads back to
 * the Commander, and `Ela` is not `ela` on a screen. Case is handled where it
 * belongs — in the *comparison*, by `COLLATE NOCASE` at the identity lookups
 * that decide whether a thing already exists.
 *
 * This is not near-duplicate merging. `supersede.ts` §1 measures what that
 * costs (0.82 accuracy to 0.62) and nothing here approximates: two labels
 * collapse only when they are the same characters.
 */
export function canonicalLabel(label: string): string {
  return label.replace(/\s+/gu, " ").trim();
}

function requireLabel(value: string): string {
  return canonicalLabel(requireText(value, "blank_label", "A node's label"));
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
    const label = requireLabel(input.label);
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
   * A THING she already knows, by name, or `null`.
   *
   * Only the kinds that name a thing rather than a claim, so a fact whose label
   * happens to read like a name cannot be mistaken for the thing it is about —
   * the distinction `syl-016.4` exists for.
   *
   * **Exact label match, case-insensitive, and no fuzziness on purpose.** Every
   * caller uses this to decide what a new statement is ABOUT, and a near-match
   * attaches it to the wrong subject. Being silent about who is recoverable;
   * being confidently wrong about who is not.
   *
   * Added for `syl-022`, where the caller is an untrusted article and the answer
   * decides whether a webpage may name someone in his life. There it is half of
   * a stricter rule — **resolve, never mint** — so a name this returns `null`
   * for is reported rather than created.
   */
  nodeNamed(name: string): MemoryNode | null {
    const row = this.#db
      .prepare(
        `SELECT ${NODE_COLUMNS} FROM memory_nodes ` +
          `WHERE label = ? COLLATE NOCASE AND tier = ? ` +
          `AND kind IN (${ENTITY_NODE_KINDS.map(() => "?").join(", ")}) ` +
          `ORDER BY updated_at DESC, id LIMIT 1`,
      )
      .get(name, SCANNED_TIER, ...ENTITY_NODE_KINDS);
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
    const next = requireLabel(label);
    const at = instant(this.#clock());

    this.#db
      .prepare("UPDATE memory_nodes SET label = ?, updated_at = ? WHERE id = ? AND label <> ?")
      .run(next, at, node.id, next);

    return this.#nodeOrThrow(node.id);
  }

  /**
   * Rewrite a node's body — the correction half of `syl-016.6`.
   *
   * `SOUL.md` requires Syl to say which memory looks wrong when the Commander
   * contradicts her, and until this existed she could then do nothing about it:
   * required to notice, forbidden to act. {@link MemoryGraph.relabel} could move
   * the one-line name; the sentence underneath it — which is where an extracted
   * fact actually lives — had no write at all.
   *
   * **An edit, not a second row.** The alternative was to mint a corrected copy
   * and supersede the old one, and that is `syl-016.3` arriving through the fix
   * for it: the graph would gain a duplicate every time a fact was tidied. What
   * the OLD value needs is to stay *answerable*, not to stay in the scan, and
   * the supersession ledger already answers that — `tidy.ts` writes the previous
   * text there before calling this, so `believedAt` still says what this memory
   * read in March.
   *
   * `NULL` clears it. The statement carries `body IS NOT ?` — `IS NOT` and not
   * `<>`, because `NULL <> NULL` is `NULL` and the row would be rewritten on
   * every call — so setting the body it already has touches nothing, including
   * `updated_at`.
   *
   * @throws {GraphError} `unknown_node`.
   */
  rebody(node: MemoryNode, body: string | null): MemoryNode {
    const next = body === null ? null : body.trim() === "" ? null : body;
    const at = instant(this.#clock());

    this.#db
      .prepare("UPDATE memory_nodes SET body = ?, updated_at = ? WHERE id = ? AND body IS NOT ?")
      .run(next, at, node.id, next);

    return this.#nodeOrThrow(node.id);
  }

  /**
   * Move a node to the kind it should have had — the other half of `syl-016.6`.
   *
   * `schema.ts` calls the kind axis "effectively immutable: a person does not
   * become an event", and that is still true of the WORLD. It was never true of
   * the FILING, and `syl-016.4` is the proof — Syl found her own People bucket
   * full of facts with a person's name in them:
   *
   * > "Ela's entry isn't *who she is*, it's the fact that she wants an apartment
   * > near her parents."
   *
   * The projection groups by kind, so a misfiled node makes the grouping carry
   * no information. Extraction was taught not to do it again; **nothing could
   * repair the ones already filed**, which is the shape of every defect in
   * `docs/CONTEXT.md` §8 — the capability existing everywhere except in her
   * hands.
   *
   * Two refusals, and both are identity rather than caution:
   *
   * - **A node with a `subjectId` is a HANDLE**, and `memory_nodes_handle_idx`
   *   is UNIQUE on `(subject_id, kind)`. Its kind is half of what addresses it,
   *   so moving it does not correct a filing — it makes `projectInto` mint a
   *   rival handle for the same row on the next projection.
   * - **Nothing is promoted INTO `source`.** A source node is what `assertedBy`
   *   points at, and `assertedBy` is the entire claim that somebody said so.
   *   Anything that could become a source could become the thing that vouches
   *   for observations, which is a provenance forgery one `UPDATE` wide.
   *
   * The tier is untouched, and the `memory_nodes_vector_reindex_au` trigger
   * fires on `kind` — so the vector's partition repair is owed by the store
   * automatically rather than remembered by a caller here.
   *
   * @throws {GraphError} `kind_locked`, `unknown_node`; {@link MemorySchemaError}
   * on a kind outside the vocabulary.
   */
  recategorise(node: MemoryNode, kind: MemoryNodeKind): MemoryNode {
    const next = nodePartition(node.tier, kind).kind as MemoryNodeKind;

    if (node.subjectId !== null) {
      throw new GraphError(
        "kind_locked",
        `${node.id} is a handle for ${node.subjectId}, and a handle's kind is half of what ` +
          `addresses it — memory_nodes_handle_idx is UNIQUE on (subject_id, kind). Moving it ` +
          `would not correct the filing; it would make the next projection mint a rival handle ` +
          `for the same row.`,
      );
    }
    if (next === "source") {
      throw new GraphError(
        "kind_locked",
        `Nothing is promoted into 'source'. A source node is what an observation's assertedBy ` +
          `points at, and that is the whole claim that somebody said so — so a node that could ` +
          `become one could become the thing vouching for observations.`,
      );
    }

    const at = instant(this.#clock());
    this.#db
      .prepare("UPDATE memory_nodes SET kind = ?, updated_at = ? WHERE id = ? AND kind <> ?")
      .run(next, at, node.id, next);

    return this.#nodeOrThrow(node.id);
  }

  /**
   * Claim an identity for a node — "these two rows are the same person".
   *
   * `subject_id` is the identity column. It has been there since
   * `0012_memory_core.sql` and, until `syl-zdf.3`, nothing on the conversational
   * path had ever written it: `extract-apply.ts` says *"Deliberately no
   * `subjectId`"*, correctly, because a turn that could point one at an
   * operational row would have exactly the one field it needs to attach itself
   * to a goal. The service may write it; the model still may not.
   *
   * **Never overwrites a different identity.** A node already claiming one has
   * been resolved before — or is a projection handle, where `subject_id` means
   * "the row this is a handle for" and re-pointing it would silently detach a
   * goal from its own node. Re-stamping the SAME identity is a no-op, statement
   * and all: the `WHERE` carries `subject_id IS NULL`, so a second identical
   * pass writes nothing and does not bump `updated_at`. That is what lets an
   * idempotence test assert on `updatedAt` rather than merely on a row count.
   *
   * Nothing is merged and nothing is deleted. Two rows keep their bodies, their
   * provenance and their edges, and gain a shared answer to "who is this?" —
   * which is the reading of constraint 6 that applies here: the system does not
   * get to silently discard things, so identity is something rows SHARE rather
   * than something one row survives.
   *
   * @throws {GraphError} `bad_subject` on a malformed id or on a node that
   * already claims a different one; `unknown_node` if the row is gone.
   */
  setSubject(node: MemoryNode, subjectId: string): MemoryNode {
    const subject = requireSubject(subjectId);
    const current = this.#nodeOrThrow(node.id);

    if (current.subjectId !== null && current.subjectId !== subject) {
      throw new GraphError(
        "bad_subject",
        `Node ${current.id} already claims identity ${current.subjectId}, so it will not be ` +
          `re-pointed at ${subject}. Reconciling two identities is a merge of merges: it is ` +
          `proposed and surfaced, never applied, because a wrong merge collapses two things ` +
          `into one and no amount of decay makes that less wrong.`,
      );
    }

    const at = instant(this.#clock());
    this.#db
      .prepare(
        "UPDATE memory_nodes SET subject_id = ?, updated_at = ? WHERE id = ? AND subject_id IS NULL",
      )
      .run(subject, at, current.id);

    return this.#nodeOrThrow(current.id);
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
   * Every edge with this node at either end, in the partitions named.
   *
   * A SCAN — it reads the hot tier unless told otherwise, for the same reason
   * {@link MemoryGraph.neighbourhood} does, and it is that traversal's own
   * single-hop step made public. `tidy.ts` is the caller that needed it:
   * merging two nodes has to know exactly what the losing one is connected to,
   * and had no way to ask without walking a whole neighbourhood and filtering
   * it back down.
   *
   * The default matters more here than it looks. A merge that carried COLD
   * edges onto the survivor would resurrect what decay set aside, and one that
   * carried SUPPRESSED edges would overrule the Commander's rejection by tidying
   * — so the tiers a caller asks for are the tiers it is choosing to move, and
   * asking for the hot ones is choosing to move only what is live.
   *
   * @throws {GraphError} `unknown_node`.
   */
  edgesTouching(nodeId: string, tiers: readonly MemoryTier[] = [SCANNED_TIER]): MemoryEdge[] {
    this.#requireNode(nodeId, "The node an edge lookup is about");
    return this.#edgesTouching(
      nodeId,
      tiers.map((tier) => nodePartition(tier, "fact").tier),
    );
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
   * A penalised `weight` may be supplied, and it is applied in the SAME
   * statement rather than by a second write. `syl-005.3.2` requires a rejected
   * edge to fall further than mere disuse would carry it, and a tier move that
   * left the weight behind — or a weight write that a crash could separate from
   * the tier move — would leave a rejected connection looking live in the cold
   * store. `last_touched_at` deliberately does NOT move: a rejection is not a
   * use, and refreshing the stamp would restart the decay clock in the edge's
   * favour.
   *
   * @throws {GraphError} `already_suppressed`, `bad_weight`.
   */
  suppress(edge: MemoryEdge, weight?: number): MemoryEdge {
    const at = instant(this.#clock());
    const penalised =
      weight === undefined ? edge.weight : requireUnitInterval(weight, "bad_weight", "A weight");
    const moved = this.#db
      .prepare(
        `UPDATE memory_edges SET tier = 'suppressed', weight = ?, demote_after = NULL, ` +
          `updated_at = ? WHERE id = ? AND tier <> 'suppressed'`,
      )
      .run(penalised, at, edge.id);

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
  promote(edge: ObservedEdge, reactivation?: ObservedReactivation): ObservedEdge;
  promote(edge: MemoryEdge, reactivation?: Reactivation | ObservedReactivation): MemoryEdge {
    const demoteAfter =
      reactivation === undefined || !("demoteAfter" in reactivation)
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
   * Restate a hot edge's strength, without moving it between partitions.
   *
   * The write half of the weight law (`syl-005.3.2`), and the one operation
   * that is neither a tier move nor an insert. It sets `weight`,
   * `last_touched_at` and — for an inference — the recomputed crossing instant,
   * together, because those three are one fact: *this edge was worth something
   * as of this moment, and here is when that runs out.* Splitting them is how a
   * hot inference ends up with a stale `demote_after` and gets swept out from
   * under a caller who had just strengthened it.
   *
   * The overloads mirror {@link MemoryGraph.promote}: an inference must supply
   * the instant it next crosses the floor, because the migration CHECKs that a
   * hot inferred edge always has one; an observation must not, because the same
   * CHECK refuses it and a stamp would put every observation into the sweep's
   * partial index.
   *
   * Matches `tier = 'hot'` and nothing else. A cold edge is promoted, not
   * reweighted, so reactivation always goes through one door.
   *
   * @throws {GraphError} `not_hot`, `bad_instant`, `bad_weight`.
   */
  reweight(edge: InferredEdge, update: Reactivation): InferredEdge;
  reweight(edge: ObservedEdge, update?: ObservedReactivation): ObservedEdge;
  reweight(edge: MemoryEdge, update?: Reactivation | ObservedReactivation): MemoryEdge {
    const demoteAfter =
      update === undefined || !("demoteAfter" in update)
        ? null
        : requireInstant(update.demoteAfter, "A scheduled floor crossing");
    const weight =
      update?.weight === undefined
        ? edge.weight
        : requireUnitInterval(update.weight, "bad_weight", "A weight");
    const at = instant(this.#clock());

    const changed = this.#db
      .prepare(
        `UPDATE memory_edges SET weight = ?, last_touched_at = ?, demote_after = ?, ` +
          `updated_at = ? WHERE id = ? AND tier = 'hot'`,
      )
      .run(weight, at, demoteAfter, at, edge.id);

    if (changed.changes === 0) {
      throw new GraphError(
        "not_hot",
        `Edge ${edge.id} is not in the hot tier, so a reweight does not reach it. A cold edge ` +
          `is brought back by promotion, and a suppressed one not at all.`,
      );
    }
    return this.#edgeOrThrow(edge.id, edge.kind);
  }

  /**
   * Retire a node: it was true, and something truer has replaced it.
   *
   * The node half of constraint 6 — **nodes are superseded, edges are demoted,
   * nothing is destroyed.** The row MOVES to the cold partition rather than
   * being rewritten or deleted, so it leaves every scan while staying reachable
   * by id and by subject. `syl-005.3.3`'s ledger is what decides *when*: the
   * validity interval lives there, and this is the partition move that interval
   * implies.
   *
   * There is deliberately no `deleteNode`. A superseded node is what "what did
   * I believe in March?" is answered out of.
   *
   * @throws {GraphError} `not_hot` if the node is not in the hot tier — or is
   * no longer in the store.
   */
  supersedeNode(node: MemoryNode): MemoryNode {
    const at = instant(this.#clock());
    const moved = this.#db
      .prepare(`UPDATE memory_nodes SET tier = 'cold', updated_at = ? WHERE id = ? AND tier = 'hot'`)
      .run(at, node.id);

    if (moved.changes === 0) {
      throw new GraphError(
        "not_hot",
        `Supersession only reaches a node in the hot tier, and ${node.id} is not in it ` +
          `(or is no longer in the store).`,
      );
    }
    return this.#nodeOrThrow(node.id);
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
   * **An edge touching an `instruction` node is exempt** and is not counted in
   * the return value, because it did not move (`syl-024.3`). The reasoning is
   * on the statement.
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
