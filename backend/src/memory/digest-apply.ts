import { instant, systemClock, type Clock } from "../services/clock.js";
import type { Database } from "../services/sqlite.js";

import {
  runDigestionTurn,
  type Digestion,
  type DigestibleNode,
  type DigestionTurnOptions,
} from "./digest.js";
import {
  groupIdentities,
  PROPOSAL_CONFIDENCE,
  proposeFromProse,
  type IdentityGroup,
} from "./entities.js";
import { GraphError, type MemoryGraph, type MemoryNode } from "./graph.js";
import { assertInferredRelation, meterAbout } from "./relations.js";
import { newMemorySubjectId } from "./schema.js";
import { crossingInstant, DEFAULT_WEIGHT_LAW, type WeightLaw } from "./weights.js";

import type { InferredRelation } from "./relations.js";

/**
 * The write half of digestion: the model judged, the labels were read, and this
 * files what came out of both.
 *
 *
 * ## Every edge is INFERRED, and this is the whole point of the module
 *
 * `memory_edges.kind` has held `'observed'` on every row the graph has ever
 * contained, because the only thing that has ever written an edge is
 * provenance. Digestion writes the other species and never this one.
 *
 * The distinction is not bookkeeping. An `observed` edge means **a source
 * asserted this** — it carries `assertedBy`, it has no confidence, and it does
 * not decay, because "he said so" does not become less true with time. An
 * `inferred` edge means **Syl worked this out**: it carries mandatory
 * `reasoning`, a `confidence`, and a `demote_after` that schedules its own
 * fading. If digestion could write the first species, then within a week Syl
 * would be unable to distinguish what the Commander told her from what she
 * concluded — and she would repeat both back to him with the same authority.
 * That is the failure that makes an assistant untrustworthy rather than merely
 * wrong.
 *
 * There is no path through this module to `MemoryGraph.observe`, and a test
 * asserts on the species of every row it writes.
 *
 *
 * ## Two proposers, one writer
 *
 * - `entities.ts` reads the relationships the extractor ALREADY WROTE into the
 *   label text (`"Ela — his wife"`). Deterministic, free, and incapable of
 *   being talked into anything. **This is the floor**: it runs whether or not
 *   the model turn succeeds, which is why a wedged CLI costs a logged miss and
 *   the family still gets connected.
 * - `digest.ts` is the bounded model turn, for the connections no label carries
 *   — a goal that blocks another, a decision that contradicts an earlier one.
 *   **This is the ceiling**, and it is discardable.
 *
 * Neither proposer decides anything structural. The species, the weight, the
 * confidence, the crossing instant, the tier, the identity namespace and the
 * dedup are all decided here, exactly as `extract-apply.ts` takes every
 * structural decision away from the extraction turn.
 *
 *
 * ## Idempotence, and why it needs no ledger
 *
 * Digestion runs after EVERY exchange and re-examines the same neighbourhood
 * constantly. Extraction earned a ledger table because its unit of work is a
 * transcript, which leaves no trace in the graph — "have I already read this
 * exchange?" is unanswerable without one.
 *
 * Digestion's units of work leave their own traces:
 *
 * - An edge's identity is `(source, target, relation)`, already UNIQUE in
 *   `memory_edges_identity_idx`. {@link MemoryGraph.findEdge} is the dedup, and
 *   it **spans every tier on purpose** — so an edge the Commander suppressed is
 *   found and skipped rather than resurrected on the next pass. That single
 *   property is worth more than any ledger: it makes "do not recreate what he
 *   rejected" true by construction.
 * - An identity's trace is `subject_id` itself. `setSubject` carries
 *   `subject_id IS NULL` in its `WHERE`, so re-stamping is not merely
 *   idempotent in effect, it is a statement that writes nothing — no row
 *   touched, no `updated_at` bumped, so a second pass cannot even reorder the
 *   working-memory projection.
 *
 * What the tables in `0025_digestion.sql` are for is OBSERVABILITY and the
 * proposals that were deliberately not applied. See that migration's header.
 *
 *
 * ## A third writer, and the discipline that keeps it safe
 *
 * Extraction, the dream, and now this. `node:sqlite` is synchronous and the
 * service is one process, so two writers cannot interleave inside a statement —
 * they interleave at an `await`, between whole units of work. What that makes
 * possible is one writer's apply running INSIDE another's open savepoint, and
 * the hazard there is the NAME: SQLite releases a savepoint by name, so two
 * writers sharing one means the inner `RELEASE` commits half of the outer's
 * work. {@link DIGESTION_SAVEPOINT} is its own name, distinct from
 * {@link EXTRACTION_SAVEPOINT}, and a test asserts they differ.
 *
 * The savepoint (rather than a transaction) is the other half: this write
 * releases into whatever transaction encloses it and never commits one, so a
 * caller that wraps digestion in its own unit of work still owns the outcome.
 */

/** The savepoint this store's all-or-nothing write runs in. See the module header. */
export const DIGESTION_SAVEPOINT = "syl_digestion";

/**
 * The weight every inferred edge digestion writes is born with.
 *
 * Below 1 deliberately. An observation is born at 1 because a source said so;
 * a conclusion is not evidence of the same quality, and starting it lower means
 * it crosses the relevance floor sooner if nothing ever touches it. Above the
 * floor (0.05) by a wide margin, so a real connection survives months of not
 * being needed rather than being demoted before anyone sees it.
 */
export const DIGESTION_EDGE_WEIGHT = 0.6;

/**
 * How sure a connection the model turn proposed is.
 *
 * Below `PROSE_CONFIDENCE`, and the ordering is the argument: prose is the
 * extraction turn's own judgment, already checked against four admission tests
 * and attributed to one of the Commander's own messages, merely being moved
 * from a display string into a column. A digestion turn's edge is a FRESH
 * conclusion drawn by a turn reading attacker-influenceable text. Those are not
 * equally good evidence and the graph should not pretend they are.
 */
export const TURN_CONFIDENCE = 0.5;

/** How many nodes one digestion looks at. */
export const DEFAULT_WINDOW_NODES = 24;

/** What went wrong when a digestion could not be filed. */
export type DigestionApplyErrorKind = "graph_write";

/** Thrown when a digestion cannot be written. */
export class DigestionApplyError extends Error {
  readonly kind: DigestionApplyErrorKind;

  constructor(kind: DigestionApplyErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DigestionApplyError";
    this.kind = kind;
  }
}

/** One connection to write, with every structural field already decided. */
export interface PlannedEdge {
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly relation: InferredRelation;
  /** Why. Mandatory by the type, as `InferredEdge.reasoning` is. */
  readonly reasoning: string;
  readonly confidence: number;
}

/** What {@link DigestionStore.apply} needs. */
export interface ApplyDigestionInput {
  /** The window that was looked at. Prose relations are read from these. */
  readonly nodes: readonly MemoryNode[];
  /** Connections the model turn proposed, already mapped to node ids. */
  readonly edges?: readonly PlannedEdge[];
  /** Identity claims the model turn proposed. Surfaced, never auto-applied. */
  readonly identities?: readonly IdentityGroup[];
  /** The conversation this window followed, for the run ledger. */
  readonly conversationId?: string;
  /** What became of the model turn, for the run ledger. */
  readonly turnOutcome?: DigestionTurnOutcome;
  /** Why the turn failed, when it did. */
  readonly turnError?: string;
}

/** What became of the model turn, as the ledger records it. */
export type DigestionTurnOutcome = "ok" | "skipped" | "refused" | "error";

/** What one apply did. */
export interface DigestionResult {
  readonly edgesWritten: number;
  /** Proposals that were already in the graph. The idempotence signal. */
  readonly edgesSkipped: number;
  readonly identitiesApplied: number;
  readonly nodesResolved: number;
  readonly proposalsRecorded: number;
  /** How many written edges reached for the `about` escape hatch. */
  readonly about: number;
  /** `true` when the graph moved, which is when the projection needs rebuilding. */
  readonly changed: boolean;
}

/** A conclusion recorded rather than applied. */
export interface DigestionProposal {
  readonly id: number;
  readonly runId: number;
  readonly kind: "identity" | "edge";
  readonly nodeIds: readonly string[];
  readonly relation: string | null;
  readonly confidence: number;
  readonly reasoning: string;
  readonly status: "open" | "accepted" | "rejected";
  readonly createdAt: string;
}

/** One row of the run ledger. */
export interface DigestionRun {
  readonly id: number;
  readonly conversationId: string | null;
  readonly windowNodes: number;
  readonly proseEdges: number;
  readonly turnEdges: number;
  readonly edgesWritten: number;
  readonly edgesSkipped: number;
  readonly identitiesApplied: number;
  readonly nodesResolved: number;
  readonly proposals: number;
  readonly aboutEdges: number;
  readonly aboutShare: number;
  readonly turnOutcome: DigestionTurnOutcome;
  readonly turnError: string | null;
  readonly createdAt: string;
}

export interface DigestionStoreOptions {
  readonly db: Database;
  readonly graph: MemoryGraph;
  readonly clock?: Clock;
  /** Owns the crossing instant every inferred edge is born with. */
  readonly law?: WeightLaw;
}

const RUN_COLUMNS =
  "conversation_id, window_nodes, prose_edges, turn_edges, edges_written, edges_skipped, " +
  "identities_applied, nodes_resolved, proposals, about_edges, about_share, turn_outcome, " +
  "turn_error, created_at";

const PROPOSAL_COLUMNS =
  "run_id, kind, node_ids, relation, confidence, reasoning, status, created_at";

interface RunRow {
  readonly id: number;
  readonly conversation_id: string | null;
  readonly window_nodes: number;
  readonly prose_edges: number;
  readonly turn_edges: number;
  readonly edges_written: number;
  readonly edges_skipped: number;
  readonly identities_applied: number;
  readonly nodes_resolved: number;
  readonly proposals: number;
  readonly about_edges: number;
  readonly about_share: number;
  readonly turn_outcome: string;
  readonly turn_error: string | null;
  readonly created_at: string;
}

interface ProposalRow {
  readonly id: number;
  readonly run_id: number;
  readonly kind: string;
  readonly node_ids: string;
  readonly relation: string | null;
  readonly confidence: number;
  readonly reasoning: string;
  readonly status: string;
  readonly created_at: string;
}

/**
 * The service side of digestion: the graph write, the proposals, the ledger.
 *
 * Holds no opinion about what is connected — that judgment arrived as a
 * {@link PlannedEdge} or was read out of a label — and every opinion about how
 * it is recorded.
 */
export class DigestionStore {
  readonly #db: Database;
  readonly #graph: MemoryGraph;
  readonly #clock: Clock;
  readonly #law: WeightLaw;

  constructor(options: DigestionStoreOptions) {
    this.#db = options.db;
    this.#graph = options.graph;
    this.#clock = options.clock ?? systemClock;
    this.#law = options.law ?? DEFAULT_WEIGHT_LAW;
  }

  /**
   * Write everything digestion concluded, or nothing at all.
   *
   * All-or-nothing in one savepoint: the identities, the edges, the proposals
   * and the ledger row land together. A partial digestion would leave edges the
   * caller was never told about, and — worse — a ledger row that under-reports
   * what is actually in the graph, which is precisely the telemetry that would
   * be consulted to find out.
   *
   * @throws {RelationError} on a relation outside the closed vocabulary. Loud,
   * and it takes the whole apply with it: an unknown relation means a caller
   * inside the service got it wrong, and the graph is not the place to find out.
   * @throws {DigestionApplyError} `graph_write` if the graph refused a write.
   */
  apply(input: ApplyDigestionInput): DigestionResult {
    this.#db.exec(`SAVEPOINT ${DIGESTION_SAVEPOINT}`);
    try {
      const result = this.#write(input);
      this.#db.exec(`RELEASE SAVEPOINT ${DIGESTION_SAVEPOINT}`);
      return result;
    } catch (error) {
      this.#db.exec(`ROLLBACK TO SAVEPOINT ${DIGESTION_SAVEPOINT}`);
      this.#db.exec(`RELEASE SAVEPOINT ${DIGESTION_SAVEPOINT}`);
      if (error instanceof DigestionApplyError) throw error;
      if (error instanceof GraphError) {
        throw new DigestionApplyError(
          "graph_write",
          `The graph refused a digested connection (${error.kind}): ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** Conclusions waiting for somebody to look at them, newest first. */
  openProposals(limit = 50): readonly DigestionProposal[] {
    return this.#db
      .prepare(
        `SELECT id, ${PROPOSAL_COLUMNS} FROM digestion_proposals WHERE status = 'open' ` +
          `ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => toProposal(row as unknown as ProposalRow));
  }

  /** What digestion has been doing, newest first. */
  recentRuns(limit = 20): readonly DigestionRun[] {
    return this.#db
      .prepare(
        `SELECT id, ${RUN_COLUMNS} FROM digestion_runs ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => toRun(row as unknown as RunRow));
  }

  // ------------------------------------------------------------- internals ---

  /** The whole write, inside the caller's savepoint. */
  #write(input: ApplyDigestionInput): DigestionResult {
    const at = instant(this.#clock());
    const window = input.nodes;

    // The deterministic floor. Read first, so that a run whose model turn
    // failed still reports what the labels said.
    const prose = proposeFromProse(window).map((edge) => ({
      sourceNode: edge.sourceNode,
      targetNode: edge.targetNode,
      relation: edge.relation,
      reasoning: edge.reasoning,
      confidence: edge.confidence,
    }));
    const fromTurn = input.edges ?? [];

    // Validated BEFORE anything is written, and over both proposers together:
    // an unknown relation anywhere in the batch takes the whole batch with it,
    // for the same reason `asDigestion` discards a whole reply.
    const planned = [...prose, ...fromTurn].map((edge, index) => ({
      ...edge,
      relation: assertInferredRelation(edge.relation, `edges[${String(index)}].relation`),
    }));

    const groups = [...groupIdentities(window), ...(input.identities ?? [])];

    const runId = this.#openRun(input, window.length, prose.length, fromTurn.length, at);

    let identitiesApplied = 0;
    let nodesResolved = 0;
    let proposalsRecorded = 0;

    for (const group of groups) {
      if (group.verdict === "propose") {
        if (this.#recordProposal(runId, group, at)) proposalsRecorded += 1;
        continue;
      }

      // A fresh identity in its own namespace, or the one a member already
      // carries. `setSubject` refuses to re-point a node that claims a
      // different one, so a group that reached here without being proposed
      // cannot silently overwrite anything.
      const subjectId = group.subjectId ?? newMemorySubjectId();
      let stamped = 0;
      for (const nodeId of group.nodeIds) {
        const node = this.#graph.getNode(nodeId);
        if (node === null || node.subjectId === subjectId) continue;
        this.#graph.setSubject(node, subjectId);
        stamped += 1;
      }
      if (stamped > 0) {
        identitiesApplied += 1;
        nodesResolved += stamped;
      }
    }

    let edgesWritten = 0;
    let edgesSkipped = 0;
    const written: string[] = [];

    for (const edge of planned) {
      // The dedup, and it spans every tier. A suppressed edge is FOUND here and
      // skipped, which is what stops each pass resurrecting a connection the
      // Commander has already rejected.
      if (this.#graph.findEdge(edge.sourceNode, edge.targetNode, edge.relation) !== null) {
        edgesSkipped += 1;
        continue;
      }

      this.#graph.infer({
        sourceNode: edge.sourceNode,
        targetNode: edge.targetNode,
        relation: edge.relation,
        reasoning: edge.reasoning,
        confidence: edge.confidence,
        weight: DIGESTION_EDGE_WEIGHT,
        // Every hot inference must say when it next crosses the floor, or the
        // nightly sweep is incomplete and the edge is immortal by accident.
        demoteAfter: crossingInstant(DIGESTION_EDGE_WEIGHT, this.#clock(), this.#law),
      });
      written.push(edge.relation);
      edgesWritten += 1;
    }

    const meter = meterAbout(written);
    this.#closeRun(runId, {
      edgesWritten,
      edgesSkipped,
      identitiesApplied,
      nodesResolved,
      proposals: proposalsRecorded,
      aboutEdges: meter.about,
      aboutShare: meter.share,
    });

    return {
      edgesWritten,
      edgesSkipped,
      identitiesApplied,
      nodesResolved,
      proposalsRecorded,
      about: meter.about,
      changed: edgesWritten > 0 || nodesResolved > 0,
    };
  }

  /**
   * Record a conclusion that was not applied.
   *
   * Deduplicated on `(kind, node_ids)` among OPEN rows, because digestion sees
   * the same unresolved pair on every single exchange and a proposal list that
   * grows by one per turn is a list nobody reads. Returns whether a row was
   * actually written.
   */
  #recordProposal(runId: number, group: IdentityGroup, at: string): boolean {
    // Sorted, so the same pair proposed in a different order is the same
    // proposal. Without this the dedup would depend on `listNodes` ordering.
    const nodeIds = JSON.stringify([...group.nodeIds].sort());

    const existing = this.#db
      .prepare(
        "SELECT id FROM digestion_proposals WHERE status = 'open' AND kind = ? AND node_ids = ?",
      )
      .get("identity", nodeIds);
    if (existing !== undefined) return false;

    this.#db
      .prepare(`INSERT INTO digestion_proposals (${PROPOSAL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, "identity", nodeIds, null, group.confidence, group.reasoning, "open", at);
    return true;
  }

  /**
   * Open the ledger row before the write, and finish it after.
   *
   * Two statements rather than one because the proposals reference `run_id`,
   * and the counts are not known until the write is done. Both are inside the
   * same savepoint, so a failure leaves neither.
   */
  #openRun(
    input: ApplyDigestionInput,
    windowNodes: number,
    proseEdges: number,
    turnEdges: number,
    at: string,
  ): number {
    const outcome = input.turnOutcome ?? "ok";
    this.#db
      .prepare(`INSERT INTO digestion_runs (${RUN_COLUMNS}) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0.0, ?, ?, ?)`)
      .run(
        input.conversationId ?? null,
        windowNodes,
        proseEdges,
        turnEdges,
        outcome,
        outcome === "ok" || outcome === "skipped" ? null : (input.turnError ?? "unspecified"),
        at,
      );

    const row = this.#db.prepare("SELECT last_insert_rowid() AS id").get();
    return (row as unknown as { id: number }).id;
  }

  #closeRun(
    runId: number,
    counts: {
      readonly edgesWritten: number;
      readonly edgesSkipped: number;
      readonly identitiesApplied: number;
      readonly nodesResolved: number;
      readonly proposals: number;
      readonly aboutEdges: number;
      readonly aboutShare: number;
    },
  ): void {
    this.#db
      .prepare(
        "UPDATE digestion_runs SET edges_written = ?, edges_skipped = ?, " +
          "identities_applied = ?, nodes_resolved = ?, proposals = ?, about_edges = ?, " +
          "about_share = ? WHERE id = ?",
      )
      .run(
        counts.edgesWritten,
        counts.edgesSkipped,
        counts.identitiesApplied,
        counts.nodesResolved,
        counts.proposals,
        counts.aboutEdges,
        counts.aboutShare,
        runId,
      );
  }
}

function toProposal(row: ProposalRow): DigestionProposal {
  const parsed: unknown = JSON.parse(row.node_ids);
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind === "edge" ? "edge" : "identity",
    nodeIds: Array.isArray(parsed) ? parsed.map((value) => String(value)) : [],
    relation: row.relation,
    confidence: row.confidence,
    reasoning: row.reasoning,
    status:
      row.status === "accepted" ? "accepted" : row.status === "rejected" ? "rejected" : "open",
    createdAt: row.created_at,
  };
}

function toRun(row: RunRow): DigestionRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    windowNodes: row.window_nodes,
    proseEdges: row.prose_edges,
    turnEdges: row.turn_edges,
    edgesWritten: row.edges_written,
    edgesSkipped: row.edges_skipped,
    identitiesApplied: row.identities_applied,
    nodesResolved: row.nodes_resolved,
    proposals: row.proposals,
    aboutEdges: row.about_edges,
    aboutShare: row.about_share,
    turnOutcome: asTurnOutcome(row.turn_outcome),
    turnError: row.turn_error,
    createdAt: row.created_at,
  };
}

function asTurnOutcome(value: string): DigestionTurnOutcome {
  return value === "skipped" || value === "refused" || value === "error" ? value : "ok";
}

/** Where a digestion's outcome is reported. Defaults to stderr in the service. */
export type DigestionLog = (line: string, detail?: unknown) => void;

export interface ConversationDigesterOptions {
  readonly store: DigestionStore;
  readonly graph: MemoryGraph;
  /** Runs the turn. Defaults to {@link runDigestionTurn}; substituted in tests. */
  readonly run?: (
    window: readonly DigestibleNode[],
    options?: DigestionTurnOptions,
  ) => Promise<Digestion>;
  /** Forwarded to the turn — `claudeBin`, `model`, `timeoutMs`. */
  readonly turnOptions?: DigestionTurnOptions;
  /** How many nodes to look at. Defaults to {@link DEFAULT_WINDOW_NODES}. */
  readonly windowNodes?: number;
  /** Called after the graph moves, to rebuild the working-memory projection. */
  readonly onGraphChanged?: () => void;
  readonly log?: DigestionLog;
}

/** What one end-to-end digestion did. Never a throw; see {@link ConversationDigester}. */
export interface DigestionOutcome {
  /**
   * `digested` — something landed. `declined` — nothing to do, the normal case.
   * `missed` — the model turn failed, and whatever the labels said still landed.
   */
  readonly status: "digested" | "declined" | "missed";
  readonly result: DigestionResult | null;
  /** Why the turn was missed. `null` otherwise. */
  readonly error: unknown;
}

/**
 * Turn a settled neighbourhood into connections, off the reply path.
 *
 * **Never throws and never rejects.** A failed digestion is a logged miss, not
 * a failed conversation — the Commander has had his answer long before this
 * runs, and there is nothing useful he could do with the news that connecting
 * went wrong. Same rule as `ConversationExtractor`, one module over.
 *
 * **A failed TURN is not a failed digestion.** The deterministic reader runs
 * either way, so a wedged CLI still leaves his wife connected to him. That is
 * the whole reason the two proposers are separate.
 */
export class ConversationDigester {
  readonly #store: DigestionStore;
  readonly #graph: MemoryGraph;
  readonly #run: (
    window: readonly DigestibleNode[],
    options?: DigestionTurnOptions,
  ) => Promise<Digestion>;
  readonly #turnOptions: DigestionTurnOptions;
  readonly #windowNodes: number;
  readonly #onGraphChanged: (() => void) | null;
  readonly #log: DigestionLog;

  constructor(options: ConversationDigesterOptions) {
    this.#store = options.store;
    this.#graph = options.graph;
    this.#run = options.run ?? runDigestionTurn;
    this.#turnOptions = options.turnOptions ?? {};
    this.#windowNodes = options.windowNodes ?? DEFAULT_WINDOW_NODES;
    this.#onGraphChanged = options.onGraphChanged ?? null;
    this.#log =
      options.log ??
      ((line, detail) => {
        if (detail === undefined) console.error(`[syl] ${line}`);
        else console.error(`[syl] ${line}`, detail);
      });
  }

  /** Look at the recent neighbourhood and connect what can be named. */
  async digest(input: { readonly conversationId?: string } = {}): Promise<DigestionOutcome> {
    try {
      // The graph's own hot region, most connected first, minus provenance
      // handles. `source` nodes are excluded because they are not knowledge —
      // `working.ts` filters them out of the projection for the same reason,
      // and an edge from a conversation to a person is already the `stated`
      // edge that exists.
      const nodes: readonly MemoryNode[] = this.#graph
        .listSalientNodes(this.#windowNodes)
        .filter((node) => node.kind !== "source");

      // The same nodes as the turn is allowed to see them: no ids, no
      // salience, no tier. The ORDER is shared with `nodes`, because that
      // ordering is the addressing scheme the reply is checked against.
      const window: readonly DigestibleNode[] = nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        label: node.label,
        body: node.body,
      }));

      // Too small to connect anything, so the turn is skipped rather than
      // spent. The deterministic reader still runs — it costs nothing — and the
      // ledger records that we looked.
      if (window.length < 2) {
        const result = this.#store.apply({
          nodes,
          turnOutcome: "skipped",
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        });
        this.#settle(result);
        return { status: result.changed ? "digested" : "declined", result, error: null };
      }

      let digestion: Digestion | null = null;
      let turnError: unknown = null;
      try {
        digestion = await this.#run(window, this.#turnOptions);
      } catch (error) {
        turnError = error;
      }

      const result = this.#store.apply({
        nodes,
        edges: digestion === null ? [] : this.#plan(digestion, window),
        identities: digestion === null ? [] : this.#planIdentities(digestion, window),
        turnOutcome: turnError === null ? "ok" : "error",
        ...(turnError === null
          ? {}
          : { turnError: turnError instanceof Error ? turnError.message : String(turnError) }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      });
      this.#settle(result);

      if (turnError !== null) {
        this.#log("digestion: the model turn failed; what the labels said still landed", turnError);
        return { status: "missed", result, error: turnError };
      }

      this.#log(
        `digestion ${result.changed ? "digested" : "declined"}: ` +
          `${String(result.edgesWritten)} edge(s), ${String(result.nodesResolved)} node(s) ` +
          `resolved, ${String(result.edgesSkipped)} already known`,
      );
      return { status: result.changed ? "digested" : "declined", result, error: null };
    } catch (error) {
      // Every failure lands here on purpose — a graph refusal, an unknown
      // relation from inside the service, a database error. None of them is
      // worth retrying on the spot and none of them is his problem.
      this.#log("digestion missed", error);
      return { status: "missed", result: null, error };
    }
  }

  // ------------------------------------------------------------- internals ---

  /**
   * Turn the turn's ordinals into node ids.
   *
   * The ordinals were already checked against this exact window by
   * `asDigestion`, so a miss here is impossible; it is handled rather than
   * asserted because the alternative is a non-null assertion on a value derived
   * from model output.
   *
   * See `#planIdentities` for the other half, which is deliberately not
   * symmetric with this one: edges are applied, identities only proposed.
   */
  #plan(digestion: Digestion, window: readonly DigestibleNode[]): readonly PlannedEdge[] {
    const planned: PlannedEdge[] = [];

    for (const edge of digestion.edges) {
      const from = window[edge.from - 1];
      const to = window[edge.to - 1];
      if (from === undefined || to === undefined || from.id === to.id) continue;

      planned.push({
        sourceNode: from.id,
        targetNode: to.id,
        relation: edge.relation,
        reasoning: `${edge.why} (digestion turn)`,
        // The service's number, never the model's. The contract has no
        // confidence field precisely so this cannot be argued with.
        confidence: TURN_CONFIDENCE,
      });
    }

    return planned;
  }

  /**
   * Turn the turn's identity claims into PROPOSALS, never into merges.
   *
   * The asymmetry with `#plan` is the point, and it is the same asymmetry
   * `entities.ts` draws between merging and proposing. An edge the turn gets
   * wrong is survivable by construction: it carries its reasoning, it decays on
   * a timer, it is demoted rather than deleted, and it stays addressable
   * forever. A wrong MERGE collapses two things into one, and there is no
   * demotion for a lost distinction — it has to be reconstructed by hand.
   *
   * So the model's "these two are the same person" is recorded, attributed, and
   * surfaced for someone to look at. It never touches `subject_id`. The one
   * rule that DOES apply automatically is whole-name equality with agreeing
   * evidence, which is structural and checkable, and which a model is not
   * needed for.
   *
   * Dropping these silently would have been the worse failure of the two: the
   * turn was paid for, it noticed something, and nothing anywhere would record
   * that it had.
   */
  #planIdentities(
    digestion: Digestion,
    window: readonly DigestibleNode[],
  ): readonly IdentityGroup[] {
    const groups: IdentityGroup[] = [];

    for (const claim of digestion.same) {
      const nodeIds = claim.nodes
        .map((ordinal) => window[ordinal - 1]?.id)
        .filter((id): id is string => id !== undefined);
      if (new Set(nodeIds).size < 2) continue;

      groups.push({
        verdict: "propose",
        // No shared name: this claim did not come from name equality, which is
        // exactly why it is proposed rather than applied.
        name: "",
        nodeIds,
        subjectId: null,
        confidence: PROPOSAL_CONFIDENCE,
        reasoning: `${claim.why} (digestion turn)`,
      });
    }

    return groups;
  }

  /** Rebuild the projection, guarded, when the graph actually moved. */
  #settle(result: DigestionResult): void {
    if (!result.changed) return;
    try {
      this.#onGraphChanged?.();
    } catch (error) {
      this.#log("digestion: the working-memory projection could not be rebuilt", error);
    }
  }
}
