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
import {
  isEntityNodeKind,
  SCANNED_TIER,
  type EntityNodeKind,
  type MemoryNodeKind,
} from "./schema.js";

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
 *
 *
 * ## A place has to EARN a node, and the earning is a count of exchanges
 *
 * `syl-017.2`. Illinois — "one place doing three jobs at once", the
 * contradiction every Tennessee conversation is downstream of — appeared in his
 * live graph as two `fact` nodes with the word inside their labels, each with a
 * degree of ONE. `place` being a kind (`0029_memory_places.sql`) is what lets a
 * claim point at it. It is not what stops the graph filling with everywhere he
 * has ever driven past, and that second problem is this module's.
 *
 * **Over-minting is a cleanup that looks like enrichment.** It is the same
 * family as the measurement in `supersede.ts` §1 — near-duplicate merging taking
 * accuracy from 0.82 to 0.62 — and it lands in the same place: the working-
 * memory projection has a 4,000-byte budget and the least salient entries fall
 * off the end, so a node nobody asked for does not sit harmlessly beside a good
 * one. It evicts it.
 *
 * So two gates, and neither of them is a threshold anybody has to tune:
 *
 * 1. **A place nothing is about is not recorded at all.** The turn is told to
 *    name a place only when a fact in the same reply is about it; here that
 *    becomes structural, because the mention row's `from_node` is `NOT NULL` and
 *    a mention with nothing pointing at it has nothing to write.
 * 2. **A place is not minted the first time it is named.** The mention is
 *    recorded in `memory_entity_mentions` — his words, the step, the claim that
 *    was waiting on it — and the node arrives when a SECOND, DIFFERENT exchange
 *    names it. On arrival every recorded mention is replayed, so it comes in
 *    with the degree it earned rather than the degree of the exchange that
 *    happened to promote it.
 *
 * **The unit is the exchange and not the fact**, and that is a deliberate
 * departure from "a place three facts point at is a hub". Three facts can all
 * come out of one telling, and then the number measures how the extraction turn
 * chose to phrase itself rather than anything about his life. A second separate
 * exchange is the first evidence that came from the world instead of from one
 * sentence. {@link ENTITY_RECURRENCE_THRESHOLD} says so in one number, and
 * {@link RECURRENCE_GATED_KINDS} says which kinds it applies to.
 *
 * Only `place` is gated, and the asymmetry is the argument rather than an
 * oversight: a person, a goal, a decision and an event are named because he is
 * DOING something about them, and the four admission tests already make them
 * rare. A place is named incidentally — every fact has a where — so for places
 * alone, being mentioned is not evidence of mattering.
 *
 * Nothing is discarded to make this work, which is what lets the threshold be
 * as low as two. A place heard once keeps its row, his words and the claim that
 * pointed at it; if it never returns it has cost one row and never a byte of
 * the digest. That is CLAUDE.md constraint 6's instinct one table over: **the
 * deferral is a demotion, not a refusal.**
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

/**
 * The entity kinds whose MINTING waits for a second exchange.
 *
 * One member, and the module header carries the argument for why it is one:
 * a person, a goal, a decision and an event are named because he is doing
 * something about them. A place is named incidentally, because every fact has a
 * where — so `place` is the one kind where being mentioned is not evidence of
 * mattering.
 *
 * `satisfies readonly EntityNodeKind[]` is the half that cannot drift: a kind
 * cannot be gated here unless something is allowed to point at it, and a gated
 * kind nothing can point at would be a node that never arrives.
 */
export const RECURRENCE_GATED_KINDS = ["place"] as const satisfies readonly EntityNodeKind[];

/** A kind whose minting waits for recurrence. See {@link RECURRENCE_GATED_KINDS}. */
export type RecurrenceGatedKind = (typeof RECURRENCE_GATED_KINDS)[number];

/** Whether a kind has to be named twice before it becomes a node. */
export function isRecurrenceGated(kind: unknown): kind is RecurrenceGatedKind {
  return typeof kind === "string" && (RECURRENCE_GATED_KINDS as readonly string[]).includes(kind);
}

/**
 * How many DISTINCT EXCHANGES must name a gated entity before it becomes a node.
 *
 * Two, and the number is small because nothing is lost while it waits. A place
 * heard once keeps its row, his words and the claim that was pointing at it, so
 * the cost of being wrong in the strict direction is one deferred node and the
 * cost of being wrong in the loose direction is a permanent competitor for a
 * 4,000-byte budget. Those are not comparable, which is what decides the
 * direction; the size of the number then only has to be the smallest one that
 * means "it came back".
 *
 * The unit is exchanges rather than facts on purpose — see the module header.
 */
export const ENTITY_RECURRENCE_THRESHOLD = 2;

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

/**
 * One mention of a gated entity, waiting to become a node — or the record of
 * one that already did. See `0029_memory_places.sql` §2.
 */
export interface EntityMention {
  readonly kind: EntityNodeKind;
  /** Canonicalised, and compared `COLLATE NOCASE`, like a fact's identity. */
  readonly label: string;
  /** The exchange that named it. The recurrence unit. */
  readonly digest: string;
  /** The claim that was waiting on it — the `fact` node whose `about` pointed here. */
  readonly fromNode: string;
  /** DERIVED: the message that named it. */
  readonly saidIn: string;
  /** DERIVED: his words in that message. */
  readonly quote: string;
  /** DECLARED: the step from those words to this. */
  readonly why: string;
  /** What the entity's node body should say when it earns one. */
  readonly body: string;
  /** The node this became, or `null` while it is still waiting. */
  readonly nodeId: string | null;
  readonly promotedAt: string | null;
  readonly createdAt: string;
}

/** A gated entity that has been named but has not yet earned a node. */
export interface PendingEntity {
  readonly kind: EntityNodeKind;
  readonly label: string;
  /** Distinct exchanges that have named it, this one included. */
  readonly heardIn: number;
  /** How many it needs. {@link ENTITY_RECURRENCE_THRESHOLD}. */
  readonly needed: number;
}

/** A gated entity that crossed the threshold during this apply. */
export interface PromotedEntity {
  readonly nodeId: string;
  readonly kind: EntityNodeKind;
  readonly label: string;
  /** Distinct exchanges that had named it by the time it arrived. */
  readonly heardIn: number;
  /**
   * Edges drawn as it arrived: every claim that ever pointed at it, plus every
   * conversation that named it.
   *
   * The number that says the replay worked. A promotion that drew one edge
   * would mean the deferral had thrown away everything it deferred, which is
   * the exact failure this design exists to avoid — and it would look like
   * success from every other angle.
   */
  readonly degree: number;
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
  /**
   * Gated entities this exchange named that did not earn a node. Not an error
   * and not a loss — the mention is on record and the next exchange that names
   * one of these mints it with everything it deferred.
   */
  readonly pending: readonly PendingEntity[];
  /** Gated entities that earned a node during this apply, and the degree they arrived with. */
  readonly promoted: readonly PromotedEntity[];
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

interface MentionRow {
  readonly kind: string;
  readonly label: string;
  readonly digest: string;
  readonly from_node: string;
  readonly said_in: string;
  readonly quote: string;
  readonly why: string;
  readonly body: string;
  readonly node_id: string | null;
  readonly promoted_at: string | null;
  readonly created_at: string;
}

function toMention(row: MentionRow): EntityMention {
  // The CHECK on `memory_entity_mentions.kind` is the narrower of the two and
  // it is the one that wrote the row, so a value here that is not an entity
  // kind means the migration and this module have parted company.
  if (!isEntityNodeKind(row.kind)) {
    throw new ExtractionApplyError(
      "graph_write",
      `memory_entity_mentions holds a row of kind ${JSON.stringify(row.kind)}, which is not an ` +
        `entity kind. The table's CHECK and ENTITY_NODE_KINDS have drifted apart.`,
    );
  }
  return {
    kind: row.kind,
    label: row.label,
    digest: row.digest,
    fromNode: row.from_node,
    saidIn: row.said_in,
    quote: row.quote,
    why: row.why,
    body: row.body,
    nodeId: row.node_id,
    promotedAt: row.promoted_at,
    createdAt: row.created_at,
  };
}

/**
 * What one candidate turned into: a node, or a mention still waiting for one.
 *
 * The two passes over an extraction — file, then link — used to be able to
 * assume every candidate had a node by the end of the first. A gated entity
 * breaks that, so the passes carry this instead of an {@link AppliedFact} and
 * the difference is checked rather than assumed.
 */
type Slot =
  | { readonly state: "filed"; readonly fact: AppliedFact }
  | { readonly state: "pending"; readonly kind: EntityNodeKind; readonly label: string };

/** A mention this reply wants to record, once the ledger row exists to hang it on. */
interface DeferredMention {
  readonly kind: EntityNodeKind;
  readonly label: string;
  readonly body: string;
  readonly fromNode: string;
  readonly saidIn: string;
  readonly quote: string;
  readonly why: string;
}

/**
 * One pending entity, weighed.
 *
 * A union rather than a record with nullable fields, so "this verdict minted a
 * node" is checked by the compiler at every use instead of asserted at one.
 * `key` is the kind and the folded label — the identity the count is taken over.
 */
type PendingVerdict =
  | { readonly state: "waiting"; readonly key: string; readonly pending: PendingEntity }
  | {
      readonly state: "minted";
      readonly key: string;
      readonly pending: PendingEntity;
      readonly node: MemoryNode;
      readonly fact: AppliedFact;
    };

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

const MENTION_COLUMNS =
  "kind, label, digest, from_node, said_in, quote, why, body, node_id, promoted_at, created_at";

/**
 * "How many exchanges have named this place?" — the promotion decision, once
 * per gated candidate.
 *
 * `count(DISTINCT digest)` and not `count(*)`, and that IS the rule rather than
 * an optimisation: one exchange in which three claims point at Illinois writes
 * three rows and is still one telling. Counting rows would let a single
 * talkative reply promote whatever it liked, which is minting on mention with
 * extra steps.
 *
 * The same folded comparison as {@link FACT_IDENTITY_SQL}, for the same reason
 * and at the same cost: `memory_entity_mentions_label_idx` is a `BINARY` index,
 * so this seeks on `kind` and filters the rest.
 */
export const ENTITY_RECURRENCE_SQL =
  "SELECT count(DISTINCT digest) AS heard FROM memory_entity_mentions " +
  "WHERE kind = ? AND label = ? COLLATE NOCASE";

const MENTIONS_FOR_ENTITY_SQL =
  `SELECT ${MENTION_COLUMNS} FROM memory_entity_mentions ` +
  "WHERE kind = ? AND label = ? COLLATE NOCASE ORDER BY created_at, digest, from_node";

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

  /**
   * Every time a gated entity has been named, oldest first — pending and
   * promoted alike.
   *
   * The rule made inspectable. "Which places has she heard once?" is the
   * question this design has to be able to answer out loud, because a deferral
   * nobody can see is indistinguishable from a drop, and CLAUDE.md constraint 6
   * turns on exactly that difference.
   */
  mentionsOf(kind: EntityNodeKind, label: string): readonly EntityMention[] {
    return this.#db
      .prepare(MENTIONS_FOR_ENTITY_SQL)
      .all(kind, canonicalLabel(label))
      .map((row) => toMention(row as unknown as MentionRow));
  }

  /**
   * How many DISTINCT exchanges have named a gated entity. The promotion
   * decision, exposed so a test can hold the rule rather than its effects.
   */
  timesHeard(kind: EntityNodeKind, label: string): number {
    const row = this.#db.prepare(ENTITY_RECURRENCE_SQL).get(kind, canonicalLabel(label));
    return Number((row as unknown as { heard: number } | undefined)?.heard ?? 0);
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
        pending: [],
        promoted: [],
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

    const candidates = input.extraction.facts;

    // Pass 1. Nodes and provenance edges, so every candidate that gets one has
    // an id before anything tries to link to it. A gated entity nothing has
    // named twice yet gets no node and no edge — only a slot saying so.
    const slots = candidates.map((fact) => this.#file(fact, sourceNodeId));

    // Pass 2. The links. A claim whose subject is still pending has nowhere to
    // point, so instead of an edge it produces a mention: the same claim, the
    // same words, held until the subject earns a node.
    const deferred: DeferredMention[] = [];
    const linked = slots.map((slot, index) =>
      this.#link(slot, index, slots, candidates, input.transcript, sourceNodeId, deferred),
    );

    // Pass 3. Which of those pending entities just crossed the line. Decided
    // BEFORE this exchange's mentions are written, because the count is over
    // distinct digests and this exchange contributes exactly one however many
    // claims in it point at the same place.
    const verdicts = this.#weighPending(deferred);
    const promotions = verdicts.flatMap((verdict) =>
      verdict.state === "minted" ? [verdict] : [],
    );

    const facts = [
      ...linked.flatMap((slot) => (slot.state === "filed" ? [slot.fact] : [])),
      ...promotions.map((verdict) => verdict.fact),
    ];
    const created = facts.filter((fact) => fact.created).length;

    // The ledger row, and everything that references it comes after. `facts`
    // counts what reached the graph: a promoted place is in it, a deferred
    // mention is not, because a mention is evidence and not yet a memory.
    const now = instant(this.#clock());
    this.#db
      .prepare(`INSERT INTO memory_extractions (${LEDGER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(digest, input.conversationId, sourceNodeId, facts.length, created, now);

    // After the ledger row, because `memory_entity_mentions.digest` and
    // `memory_provenance.digest` both reference it. Same savepoint, so the
    // ordering is an ordering and not a window.
    this.#recordMentions(digest, deferred, verdicts, now);
    const promoted = promotions.map((verdict) => this.#promote(verdict, now));
    this.#recordProvenance(digest, candidates, linked, input.transcript, now);

    return {
      applied: true,
      sourceNodeId,
      facts,
      created,
      reused: facts.length - created,
      pending: verdicts.flatMap((verdict) =>
        verdict.state === "waiting" ? [verdict.pending] : [],
      ),
      promoted,
      changed:
        source.outcome !== "unchanged" ||
        deferred.length > 0 ||
        facts.some((fact) => fact.created || fact.edgeId !== null || fact.aboutEdgeId !== null),
    };
  }

  /**
   * One candidate: find or mint the node, then attach provenance to it — unless
   * it is a gated entity that has not earned one.
   *
   * The gate is only reached when NO hot node already carries this `(kind,
   * label)`. A place that was promoted last week is found by
   * {@link FACT_IDENTITY_SQL} like anything else and files normally; recurrence
   * decides whether a node EXISTS, never how an existing one is used.
   */
  #file(fact: CandidateFact, sourceNodeId: string): Slot {
    if (isRecurrenceGated(fact.kind) && this.#existingNode(fact) === null) {
      return { state: "pending", kind: fact.kind, label: canonicalLabel(fact.label) };
    }

    const { node, created } = this.#nodeFor(fact);
    const edge = this.#provenance(sourceNodeId, node.id);
    return {
      state: "filed",
      fact: {
        nodeId: node.id,
        kind: node.kind,
        label: node.label,
        created,
        edgeId: edge?.id ?? null,
        aboutNodeId: null,
        aboutEdgeId: null,
      },
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
   *
   * **When the subject is still pending there is no edge to draw, and the claim
   * is not thrown away — it is DEFERRED.** That is the whole of the recurrence
   * gate seen from this side: the claim reaches the graph now, and the edge to
   * its subject is written down and drawn the moment the subject earns a node.
   * A gate that discarded the link would mean a promoted place arriving with a
   * degree of one, which is the defect this bead exists to fix.
   */
  #link(
    slot: Slot,
    index: number,
    all: readonly Slot[],
    candidates: readonly CandidateFact[],
    transcript: readonly TranscriptMessage[],
    sourceNodeId: string,
    deferred: DeferredMention[],
  ): Slot {
    const candidate = candidates[index];
    const about = candidate?.about ?? null;
    if (candidate === undefined || about === null) return slot;

    const target = all[about - 1];
    // Unreachable: `asExtraction` checked the ordinal against this same reply.
    // Present because the alternative is a non-null assertion on model output.
    if (target === undefined) return slot;

    if (target.state === "pending") {
      // A pending entity can only be the SUBJECT of a claim, never the claimant:
      // it has no node, so there is nothing for an edge to leave from. That is
      // also why the target candidate's own `about` is dropped rather than
      // deferred — `about` on a `place` is legal and vanishingly rare, and a
      // second deferral mechanism for it would be machinery with no defect
      // behind it.
      if (slot.state !== "filed") return slot;
      const message = transcript[candidate.saidIn - 1];
      // Unreachable — `asExtraction` checked the ordinal against this very
      // transcript. A mention with no message would be one with no provenance
      // to replay, so it is skipped rather than invented.
      if (message === undefined) return slot;

      const subject = candidates[about - 1];
      if (subject === undefined) return slot;

      deferred.push({
        kind: target.kind,
        label: target.label,
        body: subject.body,
        fromNode: slot.fact.nodeId,
        saidIn: message.id,
        quote: quoteOf(message.text),
        why: candidate.why,
      });
      return slot;
    }

    if (slot.state !== "filed" || target.fact.nodeId === slot.fact.nodeId) return slot;
    const filed = slot.fact;

    const existing = this.#graph.findEdge(filed.nodeId, target.fact.nodeId, ABOUT_RELATION);
    const edge =
      existing ??
      this.#graph.observe({
        sourceNode: filed.nodeId,
        targetNode: target.fact.nodeId,
        relation: ABOUT_RELATION,
        assertedBy: sourceNodeId,
      });

    return {
      state: "filed",
      fact: {
        ...filed,
        aboutNodeId: target.fact.nodeId,
        aboutEdgeId: existing === null ? edge.id : null,
      },
    };
  }

  /**
   * For each gated entity this reply named: has it now been named often enough?
   *
   * Counted BEFORE this exchange's mentions are written, and this exchange adds
   * exactly one to the count however many claims in it point at the same place.
   * That is the rule the module header argues for, and it is one line of
   * arithmetic rather than a policy anybody has to remember: `heardIn` is
   * `count(DISTINCT digest)` over what is already recorded, plus this one.
   *
   * The node is minted here rather than at promotion time so that the ledger
   * row written next can count it, and so that a graph refusal happens before
   * anything referencing the node is written.
   */
  #weighPending(deferred: readonly DeferredMention[]): readonly PendingVerdict[] {
    const recurrence = this.#db.prepare(ENTITY_RECURRENCE_SQL);
    const verdicts = new Map<string, PendingVerdict>();

    for (const mention of deferred) {
      const key = `${mention.kind}\u0000${mention.label.toLowerCase()}`;
      if (verdicts.has(key)) continue;

      const row = recurrence.get(mention.kind, mention.label);
      const heard = Number((row as unknown as { heard: number } | undefined)?.heard ?? 0) + 1;
      const pending: PendingEntity = {
        kind: mention.kind,
        label: mention.label,
        heardIn: heard,
        needed: ENTITY_RECURRENCE_THRESHOLD,
      };

      if (heard < ENTITY_RECURRENCE_THRESHOLD) {
        verdicts.set(key, { state: "waiting", key, pending });
        continue;
      }

      const node = this.#graph.addNode({
        kind: mention.kind,
        label: mention.label,
        body: mention.body,
        // Deliberately no `subjectId`, for the same reason a conversational
        // fact carries none: a place is not a handle for an operational row.
      });
      verdicts.set(key, {
        state: "minted",
        key,
        pending,
        node,
        fact: {
          nodeId: node.id,
          kind: node.kind,
          label: node.label,
          created: true,
          edgeId: null,
          aboutNodeId: null,
          aboutEdgeId: null,
        },
      });
    }

    return [...verdicts.values()];
  }

  /**
   * Write this exchange's mentions, stamped with the node if one was minted.
   *
   * After the ledger row: `memory_entity_mentions.digest` references it, which
   * is what makes "this mention came out of that exchange" a fact the schema
   * holds rather than a convention this module follows.
   */
  #recordMentions(
    digest: string,
    deferred: readonly DeferredMention[],
    verdicts: readonly PendingVerdict[],
    now: string,
  ): void {
    const nodeFor = new Map(
      verdicts.map(
        (verdict) => [verdict.key, verdict.state === "minted" ? verdict.node.id : null] as const,
      ),
    );
    const insert = this.#db.prepare(
      `INSERT INTO memory_entity_mentions (${MENTION_COLUMNS}) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Deduplicated on the primary key's own terms. One claim cannot name one
    // place twice in one exchange, and a repeated candidate that collapses onto
    // the same `(kind, label, from_node)` is the same statement said twice.
    const written = new Set<string>();
    for (const mention of deferred) {
      const key = `${mention.kind}\u0000${mention.label.toLowerCase()}`;
      const row = `${key}\u0000${mention.fromNode}`;
      if (written.has(row)) continue;
      written.add(row);

      const nodeId = nodeFor.get(key) ?? null;
      insert.run(
        mention.kind,
        mention.label,
        digest,
        mention.fromNode,
        mention.saidIn,
        mention.quote,
        mention.why,
        mention.body,
        nodeId,
        nodeId === null ? null : now,
        now,
      );
    }
  }

  /**
   * A place has earned a node. Give it everything that was waiting for it.
   *
   * Every mention ever recorded — this exchange's and every earlier one's — is
   * replayed into the shape a normally-filed node would have had:
   *
   * - one `memory_provenance` row per EXCHANGE, so his words and the step from
   *   them are attached to the assertion that carried them rather than to the
   *   moment the threshold happened to be crossed;
   * - one `stated` edge from each exchange's own source node, so the place is
   *   attributable to every conversation that named it;
   * - one `about` edge from every claim that ever pointed at it.
   *
   * The last is the one that matters. Illinois's defect was a degree of one; a
   * promotion that drew a single edge would reproduce it exactly, while looking
   * like a fix from every other angle. {@link PromotedEntity.degree} is
   * therefore returned rather than merely achieved, so a test can hold the
   * number.
   */
  #promote(verdict: PendingVerdict & { readonly state: "minted" }, now: string): PromotedEntity {
    const node = verdict.node;

    this.#db
      .prepare(
        "UPDATE memory_entity_mentions SET node_id = ?, promoted_at = ? " +
          "WHERE kind = ? AND label = ? COLLATE NOCASE AND node_id IS NULL",
      )
      .run(node.id, now, verdict.pending.kind, verdict.pending.label);

    const mentions = this.#db
      .prepare(MENTIONS_FOR_ENTITY_SQL)
      .all(verdict.pending.kind, verdict.pending.label)
      .map((row) => toMention(row as unknown as MentionRow));

    const provenance = this.#db.prepare(
      `INSERT INTO memory_provenance (${PROVENANCE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const exchanges = new Set<string>();
    let degree = 0;
    for (const mention of mentions) {
      // The exchange that made the claim is what vouches for it, exactly as it
      // would have at the time. Looked up per mention rather than taken from
      // the promoting exchange: a link the wrong conversation vouches for is a
      // rumour about a relationship.
      const assertedBy = this.#sourceNodeFor(mention.digest);

      if (!exchanges.has(mention.digest)) {
        exchanges.add(mention.digest);
        provenance.run(node.id, mention.digest, mention.saidIn, mention.quote, mention.why, now);
        // `assertedBy` is unreachably null — `memory_entity_mentions.digest` is
        // a foreign key into `memory_extractions`. Skipped rather than
        // asserted, because a missing source costs one attribution and never
        // the exchange.
        if (assertedBy !== null && this.#provenance(assertedBy, node.id) !== null) degree += 1;
      }

      if (mention.fromNode === node.id || assertedBy === null) continue;
      if (this.#graph.findEdge(mention.fromNode, node.id, ABOUT_RELATION) !== null) continue;
      this.#graph.observe({
        sourceNode: mention.fromNode,
        targetNode: node.id,
        relation: ABOUT_RELATION,
        assertedBy,
      });
      degree += 1;
    }

    return {
      nodeId: node.id,
      kind: verdict.pending.kind,
      label: node.label,
      heardIn: exchanges.size,
      degree,
    };
  }

  #sourceNodeFor(digest: string): string | null {
    const row = this.#db
      .prepare("SELECT source_node FROM memory_extractions WHERE digest = ?")
      .get(digest) as unknown as { source_node: string } | undefined;
    return row?.source_node ?? null;
  }

  /**
   * His words, and the step from them to the fact, one row per fact.
   *
   * Written for a REUSED node as well as a new one. A fact he states a second
   * time in a different exchange is a second assertion, with its own message,
   * its own words and its own reasoning; keeping only the first would lose the
   * one he most recently stood behind.
   *
   * A pending entity is skipped, and so is one promoted during this apply: the
   * first has no node to attach a row to, and the second had its provenance
   * written by {@link #promote} from the mention ledger — which holds the
   * exchange that actually asserted it, not the one that happened to promote
   * it. Writing it here as well would collide on `(node_id, digest)` and, if it
   * did not, would file the right words against the wrong assertion.
   */
  #recordProvenance(
    digest: string,
    candidates: readonly CandidateFact[],
    slots: readonly Slot[],
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
      const slot = slots[index];
      if (slot === undefined || slot.state !== "filed") return;
      const filed = slot.fact;
      const message = transcript[candidate.saidIn - 1];
      // Unreachable — `asExtraction` checked the ordinal against this very
      // transcript. A fact with no message would be a fact with no provenance,
      // so it is skipped rather than invented.
      if (message === undefined) return;
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
    const existing = this.#existingNode(fact);
    if (existing !== null) return { node: existing, created: false };

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
   * The hot node already saying this, or `null`.
   *
   * Its own method because the recurrence gate has to ask the question WITHOUT
   * minting: "is there already a place called Illinois?" decides whether this
   * candidate is filed or deferred, and a lookup that mints on a miss cannot
   * answer it.
   */
  #existingNode(fact: CandidateFact): MemoryNode | null {
    const row = this.#db
      .prepare(FACT_IDENTITY_SQL)
      .get(fact.kind, canonicalLabel(fact.label), SCANNED_TIER);
    if (row === undefined) return null;
    return this.#graph.getNode((row as unknown as { id: string }).id);
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
            pending: [],
            promoted: [],
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
      // Pending and promoted are logged even at zero. A deferral that is
      // invisible in the log is indistinguishable from a drop, and the whole
      // claim of the recurrence gate is that it is the first and not the second.
      this.#log(
        `extraction ${status}: ${String(result.facts.length)} fact(s), ` +
          `${String(result.created)} new, ${String(result.pending.length)} entity mention(s) ` +
          `held, ${String(result.promoted.length)} promoted, from ${input.conversationId}`,
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
