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
import {
  canonicalLabel,
  GraphError,
  type MemoryGraph,
  type MemoryNode,
  type ObservedEdge,
} from "./graph.js";
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
 *
 *
 * ## The provenance the graph could not hold, and the asymmetry that shapes it
 *
 * `syl-016.5`, in Syl's words: *"the reasoning is gone and only the residue is
 * filed."* What used to reach the graph was the fact's sentence with
 * `(said in syl:message:…)` glued onto the end of it — plumbing smeared through
 * the fact's own text, and nothing else. He could tell her a fact was wrong. He
 * could never tell her she had reasoned wrongly from something true.
 *
 * `memory_provenance` (`0025`) holds it, one row per (fact, extraction), and
 * the three columns are split the way `syl-y82` split `origin`:
 *
 * | | |
 * | --- | --- |
 * | `said_in` | **DERIVED.** Read out of the transcript by ordinal, which `asExtraction` has already checked. |
 * | `quote` | **DERIVED.** His own words, copied from that message. Never asked for, so never fabricated. |
 * | `why` | **DECLARED.** The step from those words to this fact. Nothing can check a step of reasoning. |
 *
 * Deriving the quote is the load-bearing half. A quote a model hands back is a
 * claim, and a claim is what the provenance was supposed to let him check; a
 * quote the service copies is evidence, and it sits beside the declared step so
 * the two can be compared. **The body goes back to being just the fact**, which
 * is the other half of what she was complaining about.
 *
 * Not on the edge, and not on the node. `0012`'s CHECK gives `reasoning` to
 * inferred edges alone — that is what makes an edge an inference, and widening
 * it would let the cheap frequent path look like the speculative one. A node
 * column would hold only the first assertion, when a fact stated twice has two.
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

/**
 * The relation a claim hangs off the thing it is about by.
 *
 * Also fixed here, and for a reason `syl-016.4` makes concrete: the turn may
 * say THAT one candidate is about another, never by what relation. "Ela wants
 * an apartment" is a `fact` linked to the `person` — the link is what stops the
 * fact from being filed as the person, and the projection groups by kind, so
 * that is the difference between a People bucket that means people and one that
 * is noise with headings.
 */
export const ABOUT_RELATION = "about";

/** How a conversation's source node is labelled when nobody says otherwise. */
export const DEFAULT_CONVERSATION_LABEL = "Conversation with the Commander";

/**
 * The savepoint this store's all-or-nothing write runs in.
 *
 * Named, exported, and asserted to be distinct from every other writer's —
 * SQLite releases a savepoint BY NAME and `RELEASE` on a name that is open
 * twice releases the innermost, so two writers sharing a name means one commits
 * half of the other's work. There are three writers to this graph now
 * (extraction, digestion, the dream); the name is the only thing keeping their
 * units of work separate.
 */
export const EXTRACTION_SAVEPOINT = "syl_extraction";

/**
 * The most of his own words one provenance row keeps.
 *
 * A quote is evidence, not a second copy of the conversation — and a pasted
 * article is a legitimate message. Beyond this the quote is cut and MARKED with
 * {@link QUOTE_TRUNCATED}, because an unmarked cut reads as a finished sentence
 * and a finished sentence is exactly what somebody would check the reasoning
 * against.
 */
export const MAX_QUOTE_CHARS = 500;

/** What a shortened quote ends with, so the cut is visible. */
export const QUOTE_TRUNCATED = " […]";

/** One filed fact. */
export interface AppliedFact {
  readonly nodeId: string;
  readonly kind: MemoryNodeKind;
  readonly label: string;
  /** `false` when an existing hot node already said this. */
  readonly created: boolean;
  /** The provenance edge, or `null` when this conversation had already asserted it. */
  readonly edgeId: string | null;
  /** The entity this claim was filed as being about, or `null`. */
  readonly aboutNodeId: string | null;
  /** The edge to that entity, or `null` when there was none to draw or it already existed. */
  readonly aboutEdgeId: string | null;
}

/** Where one remembered fact came from. See `0025_memory_provenance.sql`. */
export interface FactProvenance {
  readonly nodeId: string;
  /** The extraction it came out of. */
  readonly digest: string;
  /** DERIVED: the message that asserted it. */
  readonly saidIn: string;
  /** DERIVED: his words in that message. */
  readonly quote: string;
  /** DECLARED: the step from those words to this fact. */
  readonly why: string;
  readonly createdAt: string;
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

const PROVENANCE_COLUMNS = "node_id, digest, said_in, quote, why, created_at";

interface ProvenanceRow {
  readonly node_id: string;
  readonly digest: string;
  readonly said_in: string;
  readonly quote: string;
  readonly why: string;
  readonly created_at: string;
}

/**
 * The identity lookup for a fact, pinned as text.
 *
 * No `tier` predicate in the SQL and a `hot` binding instead, because the
 * restriction is a POLICY — "do not re-attach to something a correction
 * retired" — not a partitioning fact. Written this way so the index it uses
 * (`memory_nodes_label_idx`, `(kind, label)`, tier-free) stays the tier-free
 * identity index `0018` says it is, and so a future policy change is one
 * binding rather than a rewrite.
 *
 * **`COLLATE NOCASE`, and the caller passes a {@link canonicalLabel}.** That
 * pair is the write half of `syl-016.3`, in her words: *"nothing compares a new
 * memory to what's already there."* Byte equality made `Family compound`,
 * `family  compound` and `Family Compound` three nodes, and her digest then
 * carried the same fact three times — crowding out the items she could not see.
 * Whitespace is canonicalised at the door by `MemoryGraph.addNode`, so the
 * stored side needs no folding; case is folded here, because the stored form is
 * what she reads back to him and `Ela` is not `ela` on a screen.
 *
 * **It is exactness, not similarity, and that distinction is load-bearing.**
 * `supersede.ts` §1 measures what near-duplicate merging costs — 0.82 accuracy
 * down to 0.62 — because a contradiction is on average *more* cosine-similar to
 * a fact than a genuine duplicate is:
 *
 * > *He lives in Buda.* / *He moved to Nashville.*
 *
 * Same subject, same frame, most of the same tokens — and the pair it matters
 * most to keep apart, because one is the correction of the other. Loosening
 * this comparison to a distance would eat the corrections first, and leave a
 * node that looks perfectly ordinary. So the automatic path collapses only what
 * is the same characters, and everything that merely looks alike is nominated
 * to Syl by `tidy.ts` and merged by a judgement rather than by a threshold.
 *
 * The cost is that `memory_nodes_label_idx` is a `BINARY` index, so the folded
 * comparison seeks on `kind` and filters the rest. That is one kind's worth of
 * hot nodes; `remember.ts` already made the same trade for the same reason.
 */
export const FACT_IDENTITY_SQL =
  "SELECT id FROM memory_nodes WHERE kind = ? AND label = ? COLLATE NOCASE AND tier = ? " +
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

  /**
   * Where one remembered fact came from, most recent first.
   *
   * The read half of `syl-016.5`: his words, and the step the turn claims took
   * it from those words to this. More than one row when he has said the same
   * thing in more than one exchange, which is why the provenance is per
   * assertion rather than per node.
   */
  provenanceFor(nodeId: string): readonly FactProvenance[] {
    return this.#db
      .prepare(
        `SELECT ${PROVENANCE_COLUMNS} FROM memory_provenance WHERE node_id = ? ` +
          `ORDER BY created_at DESC, digest`,
      )
      .all(nodeId)
      .map((row) => {
        const typed = row as unknown as ProvenanceRow;
        return {
          nodeId: typed.node_id,
          digest: typed.digest,
          saidIn: typed.said_in,
          quote: typed.quote,
          why: typed.why,
          createdAt: typed.created_at,
        };
      });
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
   * All-or-nothing: the ledger row, the source handle, every fact and every
   * provenance row land in one savepoint. A crash halfway would otherwise leave
   * facts in the graph with no ledger row, so the retry would file them a
   * second time — the exact duplication the ledger exists to prevent.
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

    this.#db.exec(`SAVEPOINT ${EXTRACTION_SAVEPOINT}`);
    try {
      const result = this.#write(digest, input);
      this.#db.exec(`RELEASE SAVEPOINT ${EXTRACTION_SAVEPOINT}`);
      return result;
    } catch (error) {
      this.#db.exec(`ROLLBACK TO SAVEPOINT ${EXTRACTION_SAVEPOINT}`);
      this.#db.exec(`RELEASE SAVEPOINT ${EXTRACTION_SAVEPOINT}`);
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

    // Nodes and provenance edges first, so every candidate has an id before
    // anything tries to link one to another.
    const filed = input.extraction.facts.map((fact) => this.#file(fact, sourceNodeId));
    const facts = filed.map((entry, index) =>
      this.#link(entry, index, filed, input.extraction.facts, sourceNodeId),
    );

    const created = facts.filter((fact) => fact.created).length;
    const now = instant(this.#clock());
    this.#db
      .prepare(`INSERT INTO memory_extractions (${LEDGER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(digest, input.conversationId, sourceNodeId, facts.length, created, now);

    // After the ledger row, because `memory_provenance.digest` references it.
    // Same savepoint, so the ordering is an ordering and not a window.
    this.#recordProvenance(digest, input.extraction.facts, facts, input.transcript, now);

    return {
      applied: true,
      sourceNodeId,
      facts,
      created,
      reused: facts.length - created,
      changed:
        source.outcome !== "unchanged" ||
        facts.some(
          (fact) => fact.created || fact.edgeId !== null || fact.aboutEdgeId !== null,
        ),
    };
  }

  /** One fact: find or mint the node, then attach provenance to it. */
  #file(fact: CandidateFact, sourceNodeId: string): AppliedFact {
    const { node, created } = this.#nodeFor(fact);
    const edge = this.#provenance(sourceNodeId, node.id);
    return {
      nodeId: node.id,
      kind: node.kind,
      label: node.label,
      created,
      edgeId: edge?.id ?? null,
      aboutNodeId: null,
      aboutEdgeId: null,
    };
  }

  /**
   * Hang a claim off the thing it is about.
   *
   * The turn named an ordinal into its own reply; the relation, the species and
   * the provenance are all decided here. The conversation vouches for the link
   * exactly as it vouches for the fact, so `assertedBy` is the source node
   * again — a link nobody asserted would be a rumour about a relationship.
   *
   * Two candidates can resolve to ONE node, when the turn listed the same thing
   * twice and `(kind, label)` reuse collapsed them. The graph refuses a
   * self-edge and that refusal would discard the whole apply, so the link is
   * skipped instead: there is nothing to say, and a duplicate entry is not
   * worth losing the exchange over.
   */
  #link(
    filed: AppliedFact,
    index: number,
    all: readonly AppliedFact[],
    candidates: readonly CandidateFact[],
    sourceNodeId: string,
  ): AppliedFact {
    const about = candidates[index]?.about ?? null;
    if (about === null) return filed;

    const target = all[about - 1];
    // Unreachable: `asExtraction` checked the ordinal against this same reply.
    // Present because the alternative is a non-null assertion on model output.
    if (target === undefined || target.nodeId === filed.nodeId) return filed;

    const existing = this.#graph.findEdge(filed.nodeId, target.nodeId, ABOUT_RELATION);
    const edge =
      existing ??
      this.#graph.observe({
        sourceNode: filed.nodeId,
        targetNode: target.nodeId,
        relation: ABOUT_RELATION,
        assertedBy: sourceNodeId,
      });

    return {
      ...filed,
      aboutNodeId: target.nodeId,
      aboutEdgeId: existing === null ? edge.id : null,
    };
  }

  /**
   * His words, and the step from them to the fact, one row per fact.
   *
   * Written for a REUSED node as well as a new one. A fact he states a second
   * time in a different exchange is a second assertion, with its own message,
   * its own words and its own reasoning; keeping only the first would lose the
   * one he most recently stood behind.
   */
  #recordProvenance(
    digest: string,
    candidates: readonly CandidateFact[],
    facts: readonly AppliedFact[],
    transcript: readonly TranscriptMessage[],
    now: string,
  ): void {
    // A plain INSERT, deliberately. `INSERT OR IGNORE` would also cover the one
    // collision this can actually hit — two entries in a reply that
    // `(kind, label)` reuse collapsed onto one node, colliding on the primary
    // key — and it would cover every CHECK in the migration as well, silently.
    // A provenance row dropped without a word is a fact filed with no record of
    // where it came from, which is the exact state this table exists to make
    // impossible. So the collision is handled by name and everything else is
    // left to fail loudly inside the savepoint.
    const insert = this.#db.prepare(
      `INSERT INTO memory_provenance (${PROVENANCE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const written = new Set<string>();
    candidates.forEach((candidate, index) => {
      const filed = facts[index];
      const message = transcript[candidate.saidIn - 1];
      // Both unreachable — `asExtraction` checked the ordinal against this very
      // transcript, and `facts` is a map over `candidates`. A fact with no
      // message would be a fact with no provenance, so it is skipped rather
      // than invented.
      if (filed === undefined || message === undefined) return;
      // The duplicate-entry case. The first assertion stands; the same reply
      // saying it twice is not a second source.
      if (written.has(filed.nodeId)) return;
      written.add(filed.nodeId);

      insert.run(filed.nodeId, digest, message.id, quoteOf(message.text), candidate.why, now);
    });
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
   *
   * The candidate's label is canonicalised before it is compared, because the
   * stored side already is — see {@link FACT_IDENTITY_SQL}. Comparing a raw
   * model-supplied label against a canonicalised store would miss every match
   * whose only difference was a doubled space, which is the duplicate this is
   * here to stop.
   */
  #nodeFor(fact: CandidateFact): { readonly node: MemoryNode; readonly created: boolean } {
    const row = this.#db
      .prepare(FACT_IDENTITY_SQL)
      .get(fact.kind, canonicalLabel(fact.label), SCANNED_TIER);
    if (row !== undefined) {
      const existing = this.#graph.getNode((row as unknown as { id: string }).id);
      if (existing !== null) return { node: existing, created: false };
    }

    return {
      node: this.#graph.addNode({
        kind: fact.kind,
        label: fact.label,
        // Just the fact. Provenance used to be appended here as
        // `(said in syl:message:…)`, which put plumbing inside the sentence
        // she reads back and was still not the reasoning. It lives in
        // `memory_provenance` now — see the module header.
        body: fact.body,
        // Deliberately no `subjectId`. A conversational fact is not a handle
        // for an operational row, and letting the turn point one at a row
        // would be the single field it needs to attach itself to a goal.
      }),
      created: true,
    };
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

/**
 * His words as a provenance row keeps them: verbatim, trimmed, bounded, and
 * marked when they were cut.
 *
 * **Copied, never asked for.** That is the whole difference between this and a
 * quote a model hands back, and it is the same asymmetry `syl-y82` settled: a
 * property that can be DERIVED must not be STATED, because a stated one has a
 * shelf life and nothing announces its expiry. Here the expiry would be silent
 * and specific — a plausible near-miss of what he actually said, filed as the
 * evidence he is supposed to check the reasoning against.
 *
 * `renderTranscript` has already refused a blank message by the time this runs,
 * so there is no empty-quote case to handle: the digest is taken over the
 * rendered transcript and `apply` computes it first.
 */
export function quoteOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_QUOTE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_QUOTE_CHARS).trimEnd()}${QUOTE_TRUNCATED}`;
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
