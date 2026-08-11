import { instant, systemClock, type Clock } from "../services/clock.js";
import { isId } from "../services/id.js";
import type { Database } from "../services/sqlite.js";

import {
  runExtractionTurn,
  transcriptDigest,
  type CandidateFact,
  type Extraction,
  type ExtractionTurnOptions,
  type TranscriptMessage,
} from "./extract.js";
import { GraphError, type MemoryGraph, type MemoryNode, type ObservedEdge } from "./graph.js";
import { handle, projectInto } from "./projection.js";
import { SCANNED_TIER, type MemoryNodeKind } from "./schema.js";

/**
 * The write half: the model judged, and this files it.
 *
 *
 * ## Why the write is service code and not a tool call
 *
 * A model can decline to call a tool. It can call it with the wrong arguments,
 * call it twice, or narrate calling it and not call it at all. That is fine for
 * a capability and fatal for a guarantee — which is exactly why reminder
 * delivery lives in an outbox rather than in a prompt, and why the memory index
 * is maintained by `withMemoryIndex` rather than by asking nicely (`syl-03d`,
 * where a haiku turn lost the Commander's canary).
 *
 * Memory is a guarantee. So the turn returns four short strings per fact and
 * **every structural decision is taken here**: the node ids, the edge species,
 * the relation, the weight, the tier, and — above all — the provenance.
 *
 *
 * ## Provenance on every node, because a fact with no source is a rumour
 *
 * Every fact filed from a conversation hangs off a `source` node for that
 * conversation, by an OBSERVED edge whose `assertedBy` is that same node.
 * Three things follow, and all three are the point:
 *
 * - **Nothing is unattributable.** Ask "where did she get that?" and the answer
 *   is an id, a conversation, and the ordinal of the message inside it. Syl
 *   repeating a rumour to the Commander is worse than her saying nothing.
 * - **A deletion pass can reach it.** `memory_edges_asserted_by_idx` turns
 *   "what did this conversation assert?" into an index seek, which is the same
 *   reach `MemorySources.forget` uses for an ingested article. Provenance is
 *   what makes forgetting possible at all.
 * - **Observations, never inferences.** `observe` carries provenance and no
 *   confidence; `infer` carries reasoning and decays on a timer. Extraction is
 *   cheap and frequent, so it gets the species that cannot speculate. The
 *   dream is the only thing in the system that may draw a conclusion nobody
 *   said, and it has to write down why.
 *
 *
 * ## The conversation's node IS a projection; the facts are NOT
 *
 * This was worth getting right. `projection.ts`'s four-field contract exists so
 * mutable state cannot be duplicated into the graph — a row is the record, a
 * node is the handle.
 *
 * A conversation is a life-model row. Its node is therefore a **handle**:
 * `{ type: "source", label, ref: syl:conversation:<uuid> }`, minted through
 * {@link projectInto} like every other handle, unique by `(subject_id, kind)`
 * under `memory_nodes_handle_idx`, and carrying no `body` because
 * `projectInto` has no way to pass one.
 *
 * A fact is not a handle. "His daughter is Vivenna" is not a projection of a
 * row — there is no row, and the content IS the node. Forcing it through the
 * contract would mean inventing a `ref` that addresses nothing, which is
 * precisely what {@link handle}'s `bad_ref` refusal exists to prevent, or
 * dropping the `body` and losing the fact. So the split is: **the provenance
 * goes through the contract, the content does not**, and the reason the
 * contract does not apply is that nothing here duplicates a row.
 *
 *
 * ## Idempotence, at two levels
 *
 * "Re-running over the same turn writes nothing new" is a promise about the
 * least reliable step in the system — a turn that can time out, be retried by a
 * job runner, or be replayed after a restart.
 *
 * 1. **The exchange.** `memory_extractions` is keyed on the digest of the
 *    transcript the model was actually shown. A second apply of the same
 *    digest returns `applied: false` and does not touch the graph. A DECLINED
 *    extraction writes a row too (`facts = 0`): "we looked and there was
 *    nothing" and "we never looked" are different states.
 * 2. **The fact.** Within the graph a fact is identified by `(kind, label)`
 *    among HOT nodes, so the same thing said in two different exchanges lands
 *    on one node with two provenance edges rather than on two nodes. Cold and
 *    superseded nodes are deliberately NOT reused — a superseded node was
 *    replaced on purpose, and re-attaching to it would resurrect what a
 *    correction retired.
 *
 * The two are complementary: the first makes replay free, the second stops the
 * graph growing a duplicate every time he mentions his daughter.
 */

/** What went wrong when an extraction could not be filed. */
export type ApplyErrorKind = "bad_conversation" | "graph_write";

/** Thrown when an extraction cannot be written. */
export class ExtractionApplyError extends Error {
  readonly kind: ApplyErrorKind;

  constructor(kind: ApplyErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtractionApplyError";
    this.kind = kind;
  }
}

/**
 * The relation a conversation asserts a fact by.
 *
 * Fixed here and never chosen by the turn. A relation is how the graph is
 * traversed, so letting attacker-influenceable text name one would let it
 * decide the shape of the graph as well as its contents.
 */
export const STATED_RELATION = "stated";

/** How a conversation's source node is labelled when nobody says otherwise. */
export const DEFAULT_CONVERSATION_LABEL = "Conversation with the Commander";

/** One filed fact. */
export interface AppliedFact {
  readonly nodeId: string;
  readonly kind: MemoryNodeKind;
  readonly label: string;
  /** `false` when an existing hot node already said this. */
  readonly created: boolean;
  /** The provenance edge, or `null` when this conversation had already asserted it. */
  readonly edgeId: string | null;
}

/** What one apply did. */
export interface ApplyResult {
  /** `false` when this exact transcript had already been extracted from. */
  readonly applied: boolean;
  /** The conversation's `source` node. Present even when nothing was filed. */
  readonly sourceNodeId: string;
  readonly facts: readonly AppliedFact[];
  readonly created: number;
  readonly reused: number;
  /** `true` when the graph moved, which is when the projection needs rebuilding. */
  readonly changed: boolean;
}

/** What {@link applyExtraction} needs. */
export interface ApplyExtractionInput {
  /** `syl:conversation:<uuid>` — the row the source node is a handle for. */
  readonly conversationId: string;
  /** The exchange that was read, in the order it was rendered. */
  readonly transcript: readonly TranscriptMessage[];
  /** What the turn returned, already schema-validated. */
  readonly extraction: Extraction;
  /** Label for the conversation's source node. */
  readonly conversationLabel?: string;
}

export interface ExtractionStoreOptions {
  readonly db: Database;
  readonly graph: MemoryGraph;
  readonly clock?: Clock;
}

interface LedgerRow {
  readonly digest: string;
  readonly conversation_id: string;
  readonly source_node: string;
  readonly facts: number;
  readonly created_nodes: number;
  readonly created_at: string;
}

/** A row of `memory_extractions`, for the audit view and the tests. */
export interface ExtractionRecord {
  readonly digest: string;
  readonly conversationId: string;
  readonly sourceNodeId: string;
  readonly facts: number;
  readonly createdNodes: number;
  readonly createdAt: string;
}

const LEDGER_COLUMNS = "digest, conversation_id, source_node, facts, created_nodes, created_at";

/**
 * The identity lookup for a fact, pinned as text.
 *
 * No `tier` predicate in the SQL and a `hot` binding instead, because the
 * restriction is a POLICY — "do not re-attach to something a correction
 * retired" — not a partitioning fact. Written this way so the index it uses
 * (`memory_nodes_label_idx`, `(kind, label)`, tier-free) stays the tier-free
 * identity index `0018` says it is, and so a future policy change is one
 * binding rather than a rewrite.
 */
export const FACT_IDENTITY_SQL =
  "SELECT id FROM memory_nodes WHERE kind = ? AND label = ? AND tier = ? " +
  "ORDER BY created_at DESC, id DESC LIMIT 1";

/**
 * The service side of extraction: the ledger, and the write into the graph.
 *
 * Holds no opinion about what is worth remembering — that judgment arrived in
 * an {@link Extraction} — and every opinion about how it is recorded.
 */
export class ExtractionStore {
  readonly #db: Database;
  readonly #graph: MemoryGraph;
  readonly #clock: Clock;

  constructor(options: ExtractionStoreOptions) {
    this.#db = options.db;
    this.#graph = options.graph;
    this.#clock = options.clock ?? systemClock;
  }

  /** Whether this exact exchange has already been extracted from. */
  recordFor(digest: string): ExtractionRecord | null {
    const row = this.#db
      .prepare(`SELECT ${LEDGER_COLUMNS} FROM memory_extractions WHERE digest = ?`)
      .get(digest);
    if (row === undefined) return null;

    const typed = row as unknown as LedgerRow;
    return {
      digest: typed.digest,
      conversationId: typed.conversation_id,
      sourceNodeId: typed.source_node,
      facts: typed.facts,
      createdNodes: typed.created_nodes,
      createdAt: typed.created_at,
    };
  }

  /** Everything filed from one conversation, most recent first. */
  recordsFor(conversationId: string): readonly ExtractionRecord[] {
    return this.#db
      .prepare(
        `SELECT ${LEDGER_COLUMNS} FROM memory_extractions WHERE conversation_id = ? ` +
          `ORDER BY created_at DESC, digest`,
      )
      .all(conversationId)
      .map((row) => {
        const typed = row as unknown as LedgerRow;
        return {
          digest: typed.digest,
          conversationId: typed.conversation_id,
          sourceNodeId: typed.source_node,
          facts: typed.facts,
          createdNodes: typed.created_nodes,
          createdAt: typed.created_at,
        };
      });
  }

  /**
   * File a validated extraction, or do nothing because it has been filed before.
   *
   * All-or-nothing: the ledger row, the source handle and every fact land in
   * one savepoint. A crash halfway would otherwise leave facts in the graph
   * with no ledger row, so the retry would file them a second time — the exact
   * duplication the ledger exists to prevent.
   *
   * @throws {ExtractionApplyError} `bad_conversation` if the id does not
   * address a conversation row, `graph_write` if the graph refused a write.
   */
  apply(input: ApplyExtractionInput): ApplyResult {
    if (!isId(input.conversationId, "conversation")) {
      throw new ExtractionApplyError(
        "bad_conversation",
        `Provenance must name the conversation a fact came from, and ` +
          `${JSON.stringify(input.conversationId)} is not a conversation id. A fact with no ` +
          `source is a rumour.`,
      );
    }

    const digest = transcriptDigest(input.transcript);
    const existing = this.recordFor(digest);
    if (existing !== null) {
      return {
        applied: false,
        sourceNodeId: existing.sourceNodeId,
        facts: [],
        created: 0,
        reused: 0,
        changed: false,
      };
    }

    this.#db.exec("SAVEPOINT syl_extraction");
    try {
      const result = this.#write(digest, input);
      this.#db.exec("RELEASE SAVEPOINT syl_extraction");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK TO SAVEPOINT syl_extraction");
      this.#db.exec("RELEASE SAVEPOINT syl_extraction");
      if (error instanceof ExtractionApplyError) throw error;
      if (error instanceof GraphError) {
        throw new ExtractionApplyError(
          "graph_write",
          `The graph refused an extracted fact (${error.kind}): ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  // ------------------------------------------------------------- internals ---

  /** The whole write, inside the caller's savepoint. */
  #write(digest: string, input: ApplyExtractionInput): ApplyResult {
    // The conversation's handle, through the four-field contract like every
    // other projection of a life-model row. `projectInto` is create-or-relabel
    // keyed on `(ref, type)`, so a second exchange in the same conversation
    // finds this node rather than minting a rival.
    const source = projectInto(
      this.#graph,
      handle({
        type: "source",
        label: input.conversationLabel ?? DEFAULT_CONVERSATION_LABEL,
        ref: input.conversationId,
      }),
    );
    const sourceNodeId = source.projection.id;

    const facts = input.extraction.facts.map((fact) =>
      this.#file(fact, sourceNodeId, input.transcript),
    );

    const created = facts.filter((fact) => fact.created).length;
    this.#db
      .prepare(`INSERT INTO memory_extractions (${LEDGER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        digest,
        input.conversationId,
        sourceNodeId,
        facts.length,
        created,
        instant(this.#clock()),
      );

    return {
      applied: true,
      sourceNodeId,
      facts,
      created,
      reused: facts.length - created,
      changed:
        source.outcome !== "unchanged" ||
        facts.some((fact) => fact.created || fact.edgeId !== null),
    };
  }

  /** One fact: find or mint the node, then attach provenance to it. */
  #file(
    fact: CandidateFact,
    sourceNodeId: string,
    transcript: readonly TranscriptMessage[],
  ): AppliedFact {
    const { node, created } = this.#nodeFor(fact, transcript);
    const edge = this.#provenance(sourceNodeId, node.id);
    return {
      nodeId: node.id,
      kind: node.kind,
      label: node.label,
      created,
      edgeId: edge?.id ?? null,
    };
  }

  /**
   * The node this fact belongs on: an existing hot one saying the same thing,
   * or a new one.
   *
   * Reuse is by `(kind, label)` and restricted to the hot tier. A cold or
   * superseded node is not reused: it was retired by a correction or by decay,
   * and re-attaching a fresh assertion to it would quietly resurrect what the
   * graph had decided to stop saying. Minting a new node instead leaves the old
   * one exactly where supersession put it and lets the dream relate the two.
   *
   * The node is never MUTATED — not relabelled, not rebodied. A projected
   * handle that happens to share a kind and a label (a `goal` handle and an
   * extracted goal, say) therefore gains a provenance edge and stays a handle,
   * so nothing here can push mutable state into the four-field contract.
   */
  #nodeFor(
    fact: CandidateFact,
    transcript: readonly TranscriptMessage[],
  ): { readonly node: MemoryNode; readonly created: boolean } {
    const row = this.#db.prepare(FACT_IDENTITY_SQL).get(fact.kind, fact.label, SCANNED_TIER);
    if (row !== undefined) {
      const existing = this.#graph.getNode((row as unknown as { id: string }).id);
      if (existing !== null) return { node: existing, created: false };
    }

    return {
      node: this.#graph.addNode({
        kind: fact.kind,
        label: fact.label,
        body: this.#body(fact, transcript),
        // Deliberately no `subjectId`. A conversational fact is not a handle
        // for an operational row, and letting the turn point one at a row
        // would be the single field it needs to attach itself to a goal.
      }),
      created: true,
    };
  }

  /**
   * The stored body: the fact, and the message that asserted it.
   *
   * The message id rather than the ordinal, because an ordinal is only
   * meaningful against the transcript window it was rendered from, and that
   * window is not stored. This line is what turns "where did she get that?"
   * into a row in `messages`.
   */
  #body(fact: CandidateFact, transcript: readonly TranscriptMessage[]): string {
    const message = transcript[fact.saidIn - 1];
    // `asExtraction` has already checked the ordinal against this very
    // transcript, so the fallback is unreachable; it exists because the
    // alternative is a non-null assertion on a value derived from model output.
    return message === undefined ? fact.body : `${fact.body} (said in ${message.id})`;
  }

  /**
   * The observed edge from the conversation to the fact.
   *
   * `null` when this conversation had already asserted this node — the edge's
   * identity is `(source, target, relation)` and it is already there, so
   * re-asserting is a no-op rather than an error. That is what makes a second
   * mention inside one long conversation cost nothing.
   */
  #provenance(sourceNodeId: string, factNodeId: string): ObservedEdge | null {
    if (this.#graph.findEdge(sourceNodeId, factNodeId, STATED_RELATION) !== null) return null;
    return this.#graph.observe({
      sourceNode: sourceNodeId,
      targetNode: factNodeId,
      relation: STATED_RELATION,
      // The conversation asserted it, so the conversation is what vouches for
      // it. `assertedBy` is a `string` and not `string | null` on this species
      // for exactly this reason: an observation with no source does not typecheck.
      assertedBy: sourceNodeId,
    });
  }
}

/** Where an extraction's outcome is reported. Defaults to stderr in the service. */
export type ExtractionLog = (line: string, detail?: unknown) => void;

export interface ConversationExtractorOptions {
  readonly store: ExtractionStore;
  /**
   * Runs the turn. Defaults to {@link runExtractionTurn}; substituted in tests
   * so a unit test never spawns a subprocess.
   */
  readonly run?: (
    transcript: readonly TranscriptMessage[],
    options?: ExtractionTurnOptions,
  ) => Promise<Extraction>;
  /** Forwarded to the turn — `claudeBin`, `model`, `timeoutMs`, `cwd`. */
  readonly turnOptions?: ExtractionTurnOptions;
  /**
   * Called after the graph moves, to rebuild the working-memory projection.
   *
   * Injected rather than imported so this module does not depend on
   * `working.ts`, and because it is the step that closes the loop: without it a
   * fact filed at ten in the morning does not reach her prompt until the
   * nightly consolidation runs, and "tell her, then ask her an hour later"
   * fails while every part in isolation works. `regenerate` costs no tokens and
   * writes only when the digest moved, so calling it here is free.
   */
  readonly onGraphChanged?: () => void;
  readonly log?: ExtractionLog;
}

/** What one end-to-end extraction did. Never a throw; see {@link ConversationExtractor}. */
export interface ExtractionOutcome {
  readonly status: "filed" | "declined" | "replayed" | "missed";
  readonly result: ApplyResult | null;
  /** Why it was missed. `null` for every other status. */
  readonly error: unknown;
}

/**
 * Turn a settled exchange into graph, off the reply path.
 *
 * **Never throws and never rejects.** A failed extraction is a logged miss, not
 * a failed conversation: the Commander has already had his answer by the time
 * this runs, and there is nothing useful he could do with the news that filing
 * went wrong. Same rule as `ConversationService`'s publish path, one layer
 * further out.
 *
 * **Declining is normal, not an error.** Most exchanges contain nothing worth
 * keeping. `status: "declined"` is a success with an empty `facts` array, and
 * it still writes a ledger row — a system that filed something from every
 * exchange would fill the graph with noise, and the only way to know which is
 * happening is to record both.
 */
export class ConversationExtractor {
  readonly #store: ExtractionStore;
  readonly #run: (
    transcript: readonly TranscriptMessage[],
    options?: ExtractionTurnOptions,
  ) => Promise<Extraction>;
  readonly #turnOptions: ExtractionTurnOptions;
  readonly #onGraphChanged: (() => void) | null;
  readonly #log: ExtractionLog;

  constructor(options: ConversationExtractorOptions) {
    this.#store = options.store;
    this.#run = options.run ?? runExtractionTurn;
    this.#turnOptions = options.turnOptions ?? {};
    this.#onGraphChanged = options.onGraphChanged ?? null;
    this.#log =
      options.log ??
      ((line, detail) => {
        if (detail === undefined) console.error(`[syl] ${line}`);
        else console.error(`[syl] ${line}`, detail);
      });
  }

  /**
   * Extract from one exchange.
   *
   * The ledger is consulted BEFORE the turn, not after: a replay must not cost
   * a subprocess and a minute of the Commander's subscription to discover it
   * had nothing to do.
   */
  async extract(input: {
    readonly conversationId: string;
    readonly transcript: readonly TranscriptMessage[];
    readonly conversationLabel?: string;
  }): Promise<ExtractionOutcome> {
    try {
      const digest = transcriptDigest(input.transcript);
      const already = this.#store.recordFor(digest);
      if (already !== null) {
        return {
          status: "replayed",
          result: {
            applied: false,
            sourceNodeId: already.sourceNodeId,
            facts: [],
            created: 0,
            reused: 0,
            changed: false,
          },
          error: null,
        };
      }

      const extraction = await this.#run(input.transcript, this.#turnOptions);
      const result = this.#store.apply({
        conversationId: input.conversationId,
        transcript: input.transcript,
        extraction,
        ...(input.conversationLabel === undefined
          ? {}
          : { conversationLabel: input.conversationLabel }),
      });

      if (result.changed) {
        // Guarded on its own, because a projection that fails to rebuild must
        // not turn a successful filing into a miss. The facts are in the graph
        // either way; the worst case is that she learns them tonight.
        try {
          this.#onGraphChanged?.();
        } catch (error) {
          this.#log("extraction: the working-memory projection could not be rebuilt", error);
        }
      }

      const status = result.facts.length === 0 ? "declined" : "filed";
      this.#log(
        `extraction ${status}: ${String(result.facts.length)} fact(s), ` +
          `${String(result.created)} new, from ${input.conversationId}`,
      );
      return { status, result, error: null };
    } catch (error) {
      // Every failure lands here on purpose — a schema violation, a refused
      // transcript, a turn timeout, a capability breach, a graph refusal. None
      // of them is worth retrying on the spot and none of them is his problem.
      this.#log(`extraction missed on ${input.conversationId}`, error);
      return { status: "missed", result: null, error };
    }
  }
}
