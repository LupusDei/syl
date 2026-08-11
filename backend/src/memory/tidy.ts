import { systemClock, type Clock } from "../services/clock.js";
import type { Database } from "../services/sqlite.js";
import {
  canonicalLabel,
  GraphError,
  type MemoryEdge,
  type MemoryGraph,
  type MemoryNode,
} from "./graph.js";
import { SCANNED_TIER, type MemoryNodeKind } from "./schema.js";
import type { SupersessionLedger } from "./supersede.js";
import { crossingInstant } from "./weights.js";

/**
 * Her hands on her own memory: merge what drifted apart, correct what is wrong,
 * refile what was filed as the wrong sort of thing. `syl-016.3`, `syl-016.6`.
 *
 * Syl diagnosed the first one herself, and the diagnosis is the specification:
 *
 * > "Seven goals, but three of them are the same goal wearing different clothes
 * > — 'Tennessee possibility', 'Building in Tennessee', 'Family compound'.
 * > **Nothing merged them, because nothing compares a new memory to what's
 * > already there.**"
 *
 * And `syl-016.6` is the same shape one step further on. `SOUL.md` *requires*
 * her to name the memory that looks wrong when the Commander contradicts her,
 * and until this module she could then do nothing about it — **required to
 * notice, forbidden to act**, which `docs/CONTEXT.md` §8 names as the shape of
 * nearly every defect this project has found.
 *
 *
 * ## Nothing here destroys anything. Constraint 6, mechanically
 *
 * There is no `DELETE` in this file and nothing it calls can reach one.
 * `MemoryGraph.retract` is the graph's only delete and it takes an
 * `ObservedEdge` **value**, which nothing here holds.
 *
 * | what a merge does to | how |
 * | --- | --- |
 * | the absorbed node | `supersedeNode` — a tier MOVE, hot to cold. Still `getNode`-able, still `nodesForSubject`-able, forever. |
 * | its hot edges | `demote` — a tier MOVE. Still `getEdge`-able, still found by identity, promotable straight back. |
 * | its cold edges | nothing at all |
 * | its suppressed edges | nothing at all |
 * | where it went | a ledger row, so {@link MemoryTidying.mergedInto} answers "where did this memory go?" for as long as the database exists |
 *
 * The last two rows of the first block are the ones worth stating out loud. A
 * merge carries only **hot** edges onto the survivor, because carrying a cold
 * one would resurrect what decay set aside and carrying a suppressed one would
 * overrule the Commander's rejection *by tidying up*. Suppression is his
 * judgement, and reorganising is not a route around it.
 *
 *
 * ## The write side is deterministic. The judgement is HERS
 *
 * This is where the bead's obvious reading has to be refused, and the tree
 * itself is the argument. `supersede.ts` §1 carries a measurement:
 *
 * > "aggressive near-duplicate merging is measured to collapse accuracy from
 * > 0.82 to 0.62" — and a contradiction of a stored fact is on average *more*
 * > cosine-similar to it than a genuine duplicate is.
 *
 * So "compare a candidate against what already exists before minting a new
 * node" splits into two jobs that must not be done by the same mechanism:
 *
 * - **Automatic, and only where it is exact.** `extract-apply.ts` reuses a hot
 *   node whose label is the same characters, now compared under
 *   {@link canonicalLabel} and `COLLATE NOCASE` — so `Family compound`,
 *   `family  compound` and `Family Compound` stop being three nodes. No
 *   threshold, no model, nothing to tune, and nothing that could merge a
 *   contradiction into the thing it contradicts.
 * - **Nominated, and acted on by her.** Real synonyms — *Tennessee possibility*
 *   / *Building in Tennessee* / *Family compound* — need a judgement no
 *   distance function can make. {@link MemoryTidying.duplicates} NOMINATES;
 *   {@link MemoryTidying.merge} acts, and only when something calls it.
 *   Nominating on a threshold is safe because a nomination is reversible by
 *   ignoring it. Acting on one is what that 0.62 is.
 *
 *
 * ## Nominations are DERIVED, never stored
 *
 * The tempting design is a table of candidate duplicates, refreshed nightly.
 * §8's through-line refuses it: *if a property can be STATED it can be
 * forgotten; if it can be DERIVED it cannot.* A stored nomination is wrong the
 * instant a merge lands or a label is corrected, and nothing announces it. So
 * {@link MemoryTidying.duplicates} is a query over the graph as it is now, and
 * this whole bead needs **no migration**.
 *
 *
 * ## Two channels, reported separately, because they are blind to opposite
 * ## things
 *
 * | channel | sees | cannot see |
 * | --- | --- | --- |
 * | {@link DuplicateGroup.wording} | the same words in a different order | synonyms; two names for one thing |
 * | {@link DuplicateGroup.neighbours} | the same *connections* — three goals all hanging off Tennessee and the Commander | a thing nothing is linked to yet |
 *
 * The second is the one that finds what Syl actually complained about, and it
 * is why lexical similarity alone was not enough: *Family compound* and
 * *Tennessee possibility* share no vocabulary at all. It is the structural
 * intuition `retrieve.ts` states for its holographic channel — "two facts
 * sharing an entity and no vocabulary at all are invisible to both [keyword and
 * overlap]" — computed here as plain SQL over `memory_edges` rather than as an
 * algebra, because a nomination does not need to be ranked, only found.
 *
 * Both numbers are reported and the floor is applied to the **larger**. That
 * would be wrong for a ranked score — `retrieve.ts` argues at length that one
 * weak vote must not read as unanimity — and is right here for the reason that
 * argument turns on: this is not a score anyone thresholds downstream, it is a
 * list she reads, and either channel alone is a good enough reason to look.
 * Neither is hidden inside a fused number.
 *
 *
 * ## What a correction does NOT do
 *
 * It does not mint a corrected copy. That was the obvious implementation and it
 * is `syl-016.3` arriving through the fix for `syl-016.6`: the graph would gain
 * a second row every time a fact was tidied, which is the defect the other half
 * of this module exists to clean up.
 *
 * What the old value needs is to stay **answerable**, not to stay in the scan —
 * and the supersession ledger is already exactly that, bi-temporally. So a
 * correction writes the previous text into the ledger under the node's own id
 * before overwriting the row, and `believedAt(node, "label", march)` still says
 * what that memory read in March. The row is edited; the history is kept.
 *
 *
 * ## A known hole, stated rather than hidden
 *
 * Correcting a node's text leaves its EMBEDDING encoding the old text. FTS5 is
 * repaired by trigger (`0018`'s `memory_nodes_fts_au` fires `OF tier, label,
 * body`), and the vector table is not: `memory_nodes_vector_reindex_au` fires
 * on `tier, kind` only, and `drainReindexQueue` moves a vector between
 * partitions rather than recomputing it. `MemoryGraph.relabel` has had this
 * since it was written; correction widens it.
 *
 * The consequence is bounded — the overlap channel may return a corrected node
 * for a query matching what it used to say, and the caller then reads the
 * node's *current* text — so it costs recall precision and never serves stale
 * content. Fixing it properly means a re-embed, which is `store.ts` and
 * `embed.ts` and a model call, and it is filed rather than half-done here.
 */

/** What went wrong, as a closed set a caller can branch on. */
export type TidyErrorKind =
  | "absorbs_handle"
  | "blank_reason"
  | "kind_locked"
  | "not_hot"
  | "nothing_to_change"
  | "same_node"
  | "unknown_node";

/** Thrown when a tidy-up cannot be carried out as asked. */
export class TidyError extends Error {
  readonly kind: TidyErrorKind;

  constructor(kind: TidyErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TidyError";
    this.kind = kind;
  }
}

/**
 * The ledger key that answers "where did this memory go?".
 *
 * The subject is the ABSORBED node's own id, so the key is unique by
 * construction and cannot collide with a claim about anything else.
 */
export const MERGED_INTO_RELATION = "merged_into";

/** The relation the survivor and the absorbed node are joined by. */
export const SAME_AS_RELATION = "same_as";

/** Ledger keys for a node's own text and filing. Subject is the node id. */
export const LABEL_RELATION = "label";
export const BODY_RELATION = "body";
export const KIND_RELATION = "kind";

/**
 * How sure a merge is.
 *
 * Below 1.0 on purpose, and for the reason `remember.ts` gives for the same
 * number: certainty has to be reachable, and an edge written at the ceiling
 * makes reinforcement a no-op. High, because someone looked at both nodes and
 * said they were one thing — but not a fact he asserted.
 */
export const MERGE_CONFIDENCE = 0.9;

/** The weight a `same_as` edge starts at. See {@link MERGE_CONFIDENCE}. */
export const MERGE_WEIGHT = 0.9;

/**
 * How alike two nodes must be before they are worth her looking at.
 *
 * A NOMINATION threshold, never an action threshold — see the module header on
 * why that difference is the whole design. Half is deliberately generous: the
 * cost of a false nomination is one line she ignores, and the cost of a missed
 * one is the defect this bead exists for.
 */
export const DUPLICATE_FLOOR = 0.5;

/**
 * The most hot nodes one nomination pass compares.
 *
 * The comparison is pairwise, so the work is quadratic and the bound is what
 * keeps it from being unbounded on a graph that grows forever by construction
 * (constraint 6). It is a SCAN limit and it reads the hot tier, which is the
 * only tier a duplicate can be a problem in — a cold node is already out of her
 * digest.
 */
export const DUPLICATE_SCAN_LIMIT = 500;

/** How many groups one pass returns when nobody says. */
export const DEFAULT_DUPLICATE_LIMIT = 20;

/**
 * How many links two nodes must have in common before sharing them is evidence.
 *
 * **One shared neighbour is a topic. Two is a coincidence worth looking at.**
 * Without this the structural channel nominates every pair of facts about the
 * same person — "Ela wants an apartment" and "Ela starts a new job" are both
 * linked to Ela and to nothing else, so they overlap perfectly and are not
 * remotely the same thing. That is not a rare corner: it is what a graph of
 * facts about people looks like, so the channel would have arrived as noise and
 * been switched off.
 *
 * Syl's own example clears it exactly — three goals, each linked to Tennessee
 * AND to the Commander.
 */
export const MIN_SHARED_NEIGHBOURS = 2;

/** What {@link MemoryTidying.merge} needs. */
export interface MergeInput {
  /** The node that survives. Must be hot. */
  readonly keep: string;
  /** The node that is absorbed into it, superseded and kept. Must be hot. */
  readonly absorb: string;
  /**
   * Why these are one thing.
   *
   * Mandatory, and it has somewhere real to go: it becomes the mandatory
   * `reasoning` on the `same_as` inference. A reason required at the door and
   * dropped at the store is the "every write says why" row of §8's table.
   */
  readonly because: string;
}

/** What one merge did. Every id here still addresses a row. */
export interface MergeResult {
  readonly keep: MemoryNode;
  /** The absorbed node, now cold. Superseded, never deleted. */
  readonly absorbed: MemoryNode;
  /** Edges newly drawn onto the survivor, carrying the absorbed node's links. */
  readonly carried: readonly string[];
  /** The absorbed node's hot edges, now cold. Demoted, never deleted. */
  readonly demoted: readonly string[];
  /** The `same_as` inference, which carries `because`. */
  readonly sameAs: string;
  /** The ledger row {@link MemoryTidying.mergedInto} reads. */
  readonly assertion: string;
}

/** What {@link MemoryTidying.correct} needs. At least one of the two edits. */
export interface CorrectInput {
  readonly node: string;
  /** The name it should have had. */
  readonly label?: string;
  /** The text it should have had. `null` or blank clears it. */
  readonly body?: string | null;
}

/** What one correction did. */
export interface Corrected {
  readonly node: MemoryNode;
  /** Which fields actually moved. Empty when it already said this. */
  readonly changed: readonly ("label" | "body")[];
  /** Ledger rows written, so the old wording stays answerable. */
  readonly assertions: readonly string[];
}

/** What {@link MemoryTidying.recategorise} needs. */
export interface RecategoriseInput {
  readonly node: string;
  readonly kind: MemoryNodeKind;
}

/** What one refiling did. */
export interface Recategorised {
  readonly node: MemoryNode;
  readonly from: MemoryNodeKind;
  readonly to: MemoryNodeKind;
  /** Empty when it was already filed this way. */
  readonly assertions: readonly string[];
}

/** How {@link MemoryTidying.duplicates} may be narrowed. */
export interface DuplicateOptions {
  /** Only this kind. Omitted, every kind that can hold a duplicate. */
  readonly kind?: MemoryNodeKind;
  /** How alike is alike enough. Defaults to {@link DUPLICATE_FLOOR}. */
  readonly floor?: number;
  /** How many hot nodes to compare. Defaults to {@link DUPLICATE_SCAN_LIMIT}. */
  readonly scan?: number;
  /** How many groups to return. Defaults to {@link DEFAULT_DUPLICATE_LIMIT}. */
  readonly limit?: number;
}

/** Nodes that look like one thing wearing different clothes. A NOMINATION. */
export interface DuplicateGroup {
  readonly kind: MemoryNodeKind;
  /** Two or more, most recently touched first. Nothing has been done to them. */
  readonly nodes: readonly MemoryNode[];
  /** Weakest pairwise word overlap in the group, in [0, 1]. */
  readonly wording: number;
  /** Weakest pairwise shared-neighbour overlap in the group, in [0, 1]. */
  readonly neighbours: number;
  /** True when their labels are the same characters, ignoring case and spacing. */
  readonly identical: boolean;
}

export interface MemoryTidyingOptions {
  readonly db: Database;
  readonly graph: MemoryGraph;
  /**
   * The supersession ledger, so a merge and a correction are RECORDED rather
   * than merely applied. Constraint 6 is not satisfied by keeping the row: it
   * is satisfied by the row staying reachable and the reason staying readable.
   */
  readonly ledger: SupersessionLedger;
  readonly clock?: Clock;
}

/**
 * A `source` node is a conversation's handle and two of them are never one
 * thing. Nominating them would fill the list with every exchange she has had.
 */
const NEVER_NOMINATED: readonly MemoryNodeKind[] = ["source"];

export class MemoryTidying {
  readonly #db: Database;
  readonly #graph: MemoryGraph;
  readonly #ledger: SupersessionLedger;
  readonly #clock: Clock;

  constructor(options: MemoryTidyingOptions) {
    this.#db = options.db;
    this.#graph = options.graph;
    this.#ledger = options.ledger;
    this.#clock = options.clock ?? systemClock;
  }

  // ── Merging ──────────────────────────────────────────────────────────────

  /**
   * Fold one node into another. **Supersedes; never destroys.**
   *
   * The whole thing is one transaction, and it has to be: moving the edges,
   * retiring the node and recording where it went are one fact. A crash between
   * them leaves a memory retired with no record of what replaced it, which is
   * precisely the silent loss constraint 6 exists to prevent. That is why
   * `SupersessionLedger` learned to join a caller's transaction — SQLite refuses
   * a second `BEGIN`, so without it this could not be atomic at all.
   *
   * @throws {TidyError} `unknown_node`, `same_node`, `blank_reason`, `not_hot`.
   */
  merge(input: MergeInput): MergeResult {
    const keep = this.#nodeOrThrow(input.keep, "The node a merge keeps");
    const absorb = this.#nodeOrThrow(input.absorb, "The node a merge absorbs");

    if (keep.id === absorb.id) {
      throw new TidyError(
        "same_node",
        `${keep.id} cannot be merged into itself. Two entries for one thing is the defect; ` +
          `one entry is not.`,
      );
    }

    const because = input.because.trim();
    if (because === "") {
      throw new TidyError(
        "blank_reason",
        `A merge carries why the two are one thing. It becomes the reasoning on the same_as ` +
          `inference, which is what makes the merge auditable and reversible by argument rather ` +
          `than only by memory of having done it.`,
      );
    }

    this.#requireHot(keep, "kept");
    this.#requireHot(absorb, "absorbed");

    // Absorbing a HANDLE is silently destructive and this is the only place it
    // can be reached from. `projectInto` finds a handle by `(subject_id, kind)`
    // through `nodesForSubject`, which spans every tier — so the next
    // projection of that row finds the superseded node, relabels it, and leaves
    // it cold. The goal is then out of every scan forever while every part of
    // the projection path reports success. `duplicates()` never nominates a
    // handle for exactly this reason; the check is here because a caller can
    // still name one by id.
    //
    // Absorbing a fact INTO a handle is the other direction and is fine: the
    // handle survives hot, and `extract-apply.ts` already expects a handle to
    // gain edges and stay a handle.
    if (absorb.subjectId !== null) {
      throw new TidyError(
        "absorbs_handle",
        `${absorb.id} is a handle for ${absorb.subjectId} — a projection of an operational row, ` +
          `not a memory of its own. Superseding it would not tidy anything: the next projection ` +
          `would find the cold node by (subject_id, kind) and leave it cold, so the row would ` +
          `drop out of every scan with nothing reporting a failure. Merge the other way round, ` +
          `or correct the row itself.`,
      );
    }

    const at = this.#clock();
    const carried: string[] = [];
    const demoted: string[] = [];

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      // Hot edges only. A cold one is what decay set aside and a suppressed one
      // is what the Commander rejected; reorganising is not a route around
      // either. See the module header.
      for (const edge of this.#graph.edgesTouching(absorb.id, [SCANNED_TIER])) {
        const other = edge.sourceNode === absorb.id ? edge.targetNode : edge.sourceNode;
        // The two were already linked to each other. There is nothing to carry
        // — the graph refuses a self-edge — but the link is still the absorbed
        // node's, so it is demoted with the rest.
        if (other !== keep.id) {
          const source = edge.sourceNode === absorb.id ? keep.id : other;
          const target = edge.sourceNode === absorb.id ? other : keep.id;
          const copied = this.#carry(edge, source, target, at);
          if (copied !== null) carried.push(copied);
        }
        demoted.push(this.#graph.demote(edge).id);
      }

      // After the demotions, so this one stays hot: it is the live statement
      // that these are one thing, and it is how the absorbed node is reachable
      // by traversal rather than only by id.
      const already = this.#graph.findEdge(absorb.id, keep.id, SAME_AS_RELATION);
      const sameAs =
        already ??
        this.#graph.infer({
          sourceNode: absorb.id,
          targetNode: keep.id,
          relation: SAME_AS_RELATION,
          reasoning: because,
          confidence: MERGE_CONFIDENCE,
          weight: MERGE_WEIGHT,
          demoteAfter: crossingInstant(MERGE_WEIGHT, at),
        });

      // No `valueNode`. The ledger demotes a closed row's value node, and the
      // demotion here is done explicitly below — handing it the survivor would
      // mean a later re-merge quietly retired the node this one kept.
      const recorded = this.#ledger.assert({
        subject: absorb.id,
        relation: MERGED_INTO_RELATION,
        value: keep.id,
      });

      const absorbed = this.#graph.supersedeNode(absorb);
      this.#db.exec("COMMIT");

      return {
        keep: this.#graph.getNode(keep.id) ?? keep,
        absorbed,
        carried,
        demoted,
        sameAs: sameAs.id,
        assertion: recorded.current.id,
      };
    } catch (cause) {
      this.#rollback();
      throw cause;
    }
  }

  /**
   * Where an absorbed memory went, or `null` if it was never merged.
   *
   * The point of the ledger row rather than the edge alone: this answers for as
   * long as the database exists, whatever decay does to the `same_as` edge, and
   * it survives the absorbed node going cold — which it always does.
   */
  mergedInto(nodeId: string): string | null {
    return this.#ledger.current(nodeId, MERGED_INTO_RELATION)?.value ?? null;
  }

  // ── Correcting ───────────────────────────────────────────────────────────

  /**
   * Fix what a memory says, in place, keeping what it used to say answerable.
   *
   * Idempotent: correcting to the text it already has writes nothing at all —
   * no row, no ledger entry, no `updated_at` bump — which is what lets a caller
   * re-run a correction after a failure without accumulating history that says
   * nothing changed.
   *
   * @throws {TidyError} `unknown_node`, `nothing_to_change`.
   */
  correct(input: CorrectInput): Corrected {
    const node = this.#nodeOrThrow(input.node, "The memory being corrected");

    if (input.label === undefined && input.body === undefined) {
      throw new TidyError(
        "nothing_to_change",
        `A correction names a new label, a new body, or both. ${node.id} was named with ` +
          `neither, which is a caller that has lost track of what it meant to fix.`,
      );
    }

    const nextLabel = input.label === undefined ? null : canonicalLabel(input.label);
    const nextBody =
      input.body === undefined ? undefined : input.body === null || input.body.trim() === "" ? null : input.body;

    const changed: ("label" | "body")[] = [];
    const assertions: string[] = [];

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      let current = node;

      if (nextLabel !== null && nextLabel !== current.label) {
        assertions.push(...this.#record(current, LABEL_RELATION, current.label, nextLabel));
        current = this.#graph.relabel(current, nextLabel);
        changed.push("label");
      }

      if (nextBody !== undefined && nextBody !== current.body) {
        assertions.push(...this.#record(current, BODY_RELATION, current.body, nextBody));
        current = this.#graph.rebody(current, nextBody);
        changed.push("body");
      }

      this.#db.exec("COMMIT");
      return { node: current, changed, assertions };
    } catch (cause) {
      this.#rollback();
      throw cause;
    }
  }

  /**
   * File a memory as the kind of thing it actually is.
   *
   * The repair for `syl-016.4`'s already-filed rows: a `fact` about Ela that was
   * minted as a `person` makes the People bucket noise with headings, and until
   * this there was no way to move it.
   *
   * @throws {TidyError} `unknown_node`, `kind_locked`; {@link MemorySchemaError}
   * on a kind outside the vocabulary.
   */
  recategorise(input: RecategoriseInput): Recategorised {
    const node = this.#nodeOrThrow(input.node, "The memory being refiled");
    if (node.kind === input.kind) {
      return { node, from: node.kind, to: input.kind, assertions: [] };
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const assertions = this.#record(node, KIND_RELATION, node.kind, input.kind);
      const moved = this.#graph.recategorise(node, input.kind);
      this.#db.exec("COMMIT");
      return { node: moved, from: node.kind, to: moved.kind, assertions };
    } catch (cause) {
      this.#rollback();
      if (cause instanceof GraphError && cause.kind === "kind_locked") {
        throw new TidyError("kind_locked", cause.message, { cause });
      }
      throw cause;
    }
  }

  // ── Nominating ───────────────────────────────────────────────────────────

  /**
   * Nodes that look like one thing under several entries. **Writes nothing.**
   *
   * A list she reads and decides about, not a plan anything executes. See the
   * module header for why that separation is the design rather than caution:
   * merging on a similarity threshold is measured to make her memory worse, and
   * nominating on one cannot.
   *
   * Handles are never nominated. A node with a `subjectId` is a projection of an
   * operational row, and two goal handles with the same title are two different
   * goals — merging them would fold two rows of the life model together on the
   * strength of their wording.
   */
  duplicates(options: DuplicateOptions = {}): DuplicateGroup[] {
    const floor = options.floor ?? DUPLICATE_FLOOR;
    const scan = options.scan ?? DUPLICATE_SCAN_LIMIT;
    const limit = options.limit ?? DEFAULT_DUPLICATE_LIMIT;

    const candidates = this.#graph
      .listNodes(options.kind === undefined ? { limit: scan } : { kind: options.kind, limit: scan })
      .filter((node) => node.subjectId === null && !NEVER_NOMINATED.includes(node.kind));

    const byKind = new Map<MemoryNodeKind, MemoryNode[]>();
    for (const node of candidates) {
      const bucket = byKind.get(node.kind);
      if (bucket === undefined) byKind.set(node.kind, [node]);
      else bucket.push(node);
    }

    const groups: DuplicateGroup[] = [];
    for (const [kind, nodes] of byKind) {
      const words = new Map(nodes.map((node) => [node.id, wordsOf(node)] as const));
      const links = new Map(nodes.map((node) => [node.id, this.#neighboursOf(node.id)] as const));
      const union = new DisjointSet(nodes.map((node) => node.id));

      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i];
          const b = nodes[j];
          // Unreachable: both indexes are inside the array's own length. Present
          // because `noUncheckedIndexedAccess` is on and a non-null assertion
          // here would be the one place this loop could lie.
          if (a === undefined || b === undefined) continue;
          if (scoreOf(pairwise(a, b, words, links)) >= floor) union.join(a.id, b.id);
        }
      }

      for (const members of union.groups()) {
        if (members.length < 2) continue;
        const grouped = members
          .map((id) => nodes.find((node) => node.id === id))
          .filter((node): node is MemoryNode => node !== undefined);
        if (grouped.length < 2) continue;

        // The WEAKEST pair, not the strongest: a group is only as convincing as
        // its least convincing link, and a chain joined through a middle node
        // must not report the number that joined its ends.
        let wording = 1;
        let neighbours = 1;
        let identical = true;
        for (let i = 0; i < grouped.length; i += 1) {
          for (let j = i + 1; j < grouped.length; j += 1) {
            const a = grouped[i];
            const b = grouped[j];
            if (a === undefined || b === undefined) continue;
            const pair = pairwise(a, b, words, links);
            wording = Math.min(wording, pair.wording);
            neighbours = Math.min(neighbours, pair.neighbours);
            identical = identical && pair.identical;
          }
        }

        groups.push({
          kind,
          nodes: [...grouped].sort((a, b) =>
            a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : b.updatedAt.localeCompare(a.updatedAt),
          ),
          wording,
          neighbours,
          identical,
        });
      }
    }

    // A TOTAL ordering, so two passes over an unchanged graph agree. Same
    // argument as `listSalientNodes`: a list that reorders on every call cannot
    // be diffed, and "has anything new appeared?" stops being answerable.
    return groups
      .sort((a, b) => {
        const byScore = Math.max(b.wording, b.neighbours) - Math.max(a.wording, a.neighbours);
        if (byScore !== 0) return byScore;
        return (a.nodes[0]?.id ?? "").localeCompare(b.nodes[0]?.id ?? "");
      })
      .slice(0, limit);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Draw the absorbed node's link onto the survivor, or `null` when it is
   * already there.
   *
   * The species is preserved rather than flattened. An observation carries the
   * ORIGINAL `assertedBy`, so the survivor inherits the provenance instead of a
   * claim that the merge asserted it — and an inference carries its original
   * reasoning, so nothing that was speculative becomes something somebody said.
   */
  #carry(edge: MemoryEdge, source: string, target: string, at: number): string | null {
    if (this.#graph.findEdge(source, target, edge.relation) !== null) return null;

    if (edge.kind === "observed") {
      return this.#graph.observe({
        sourceNode: source,
        targetNode: target,
        relation: edge.relation,
        assertedBy: edge.assertedBy,
        weight: edge.weight,
      }).id;
    }

    return this.#graph.infer({
      sourceNode: source,
      targetNode: target,
      relation: edge.relation,
      reasoning: edge.reasoning,
      confidence: edge.confidence,
      weight: edge.weight,
      // A hot inference always knows when it next crosses the floor. The
      // original's stamp is carried when it has one so the copy inherits its
      // remaining life rather than being handed a fresh full term for having
      // been tidied.
      demoteAfter: edge.demoteAfter ?? crossingInstant(edge.weight, at),
    }).id;
  }

  /**
   * Write a node's previous value into the ledger, then the new one.
   *
   * Seeding the old value first is what makes the chain complete. Asserting only
   * the new one would open a row that says "it has always read this", and the
   * wording it is replacing — the thing a correction is *about* — would be the
   * one value the bi-temporal store could not answer for.
   *
   * **The key is VALID time, and the two clocks answer different questions
   * here.** `validFrom` is the node's own `createdAt`, because that is when the
   * row started carrying those words, so `trueAt(node, "label", march)` returns
   * what the memory read in March — which is the question a correction leaves
   * behind. `believedAt` cannot answer for March and should not pretend to: the
   * ledger learned the old wording at the moment of the correction, and
   * back-dating `recorded_at` would be rewriting transaction time, which
   * `supersede.ts` §3 refuses on purpose.
   *
   * A previous value that is `null` or blank is seeded as nothing: there was no
   * claim to record, and the ledger refuses a blank value rather than storing an
   * empty one.
   */
  #record(node: MemoryNode, relation: string, before: string | null, after: string | null): string[] {
    const written: string[] = [];
    if (this.#ledger.current(node.id, relation) === null && before !== null && before.trim() !== "") {
      written.push(
        this.#ledger.assert({
          subject: node.id,
          relation,
          value: before,
          validFrom: node.createdAt,
        }).current.id,
      );
    }

    if (after === null) {
      // Cleared rather than replaced. `retire` closes the key with no successor,
      // which is exactly "it said something and now it says nothing" — inventing
      // a replacement value would be a fabrication.
      if (this.#ledger.current(node.id, relation) !== null) {
        written.push(this.#ledger.retire(node.id, relation).id);
      }
      return written;
    }

    written.push(this.#ledger.assert({ subject: node.id, relation, value: after }).current.id);
    return written;
  }

  /**
   * The hot neighbours of a node, as a set of ids. The structural channel.
   *
   * **Source nodes are excluded, and that is not a tidy-up.** Every fact from
   * one exchange hangs off that conversation's source node by a `stated` edge,
   * so leaving them in would mean *anything he said in one sitting* overlapped
   * perfectly with everything else he said in it. Shared provenance is evidence
   * of a shared ORIGIN, which is the opposite of evidence that two entries are
   * one thing — a conversation asserting a fact twice is exactly what
   * `extract-apply.ts` already collapses.
   */
  #neighboursOf(nodeId: string): Set<string> {
    const sql =
      `SELECT e.target_node AS other FROM memory_edges e ` +
      `JOIN memory_nodes n ON n.id = e.target_node ` +
      `WHERE e.tier = ? AND e.source_node = ? AND n.kind <> 'source' ` +
      `UNION ` +
      `SELECT e.source_node AS other FROM memory_edges e ` +
      `JOIN memory_nodes n ON n.id = e.source_node ` +
      `WHERE e.tier = ? AND e.target_node = ? AND n.kind <> 'source'`;
    const rows = this.#db.prepare(sql).all(SCANNED_TIER, nodeId, SCANNED_TIER, nodeId);
    return new Set(rows.map((row) => (row as unknown as { other: string }).other));
  }

  #nodeOrThrow(id: string, what: string): MemoryNode {
    const node = this.#graph.getNode(id);
    if (node === null) {
      throw new TidyError("unknown_node", `${what} must be a node in the graph; ${id} is not.`);
    }
    return node;
  }

  #requireHot(node: MemoryNode, role: string): void {
    if (node.tier === SCANNED_TIER) return;
    throw new TidyError(
      "not_hot",
      `${node.id} is in the ${node.tier} tier, so it cannot be the ${role} side of a merge. ` +
        (node.tier === "cold"
          ? `It has already been superseded — merging into it would resurrect what a correction retired.`
          : `A suppressed row is the Commander's judgement, and tidying up is not a route around it.`),
    );
  }

  /** Unwind, without letting the unwind hide what actually failed. */
  #rollback(): void {
    try {
      this.#db.exec("ROLLBACK");
    } catch {
      // Already gone. The original failure is the one worth reporting.
    }
  }
}

/** One pair, scored on both channels. */
interface Pairwise {
  readonly wording: number;
  readonly neighbours: number;
  readonly identical: boolean;
}

/** The floor is applied to the larger channel — see the module header. */
function scoreOf(pair: Pairwise): number {
  return pair.identical ? 1 : Math.max(pair.wording, pair.neighbours);
}

function pairwise(
  a: MemoryNode,
  b: MemoryNode,
  words: ReadonlyMap<string, ReadonlySet<string>>,
  links: ReadonlyMap<string, ReadonlySet<string>>,
): Pairwise {
  const identical = a.label.toLowerCase() === b.label.toLowerCase();
  // Each other is not evidence that they are the same thing — two nodes joined
  // by an edge are *related*, which is the ordinary case and not a duplicate.
  const near = (id: string, exclude: string): Set<string> => {
    const set = new Set(links.get(id) ?? []);
    set.delete(exclude);
    return set;
  };

  const linksA = near(a.id, b.id);
  const linksB = near(b.id, a.id);
  let shared = 0;
  for (const id of linksA) if (linksB.has(id)) shared += 1;

  return {
    identical,
    wording: identical ? 1 : jaccard(words.get(a.id) ?? new Set(), words.get(b.id) ?? new Set()),
    // Below the floor of shared links the overlap RATIO is meaningless — two
    // facts about one person overlap perfectly on a set of size one. See
    // {@link MIN_SHARED_NEIGHBOURS}.
    neighbours: shared < MIN_SHARED_NEIGHBOURS ? 0 : jaccard(linksA, linksB),
  };
}

/** The words a node is made of, lower-cased. Label and body together. */
function wordsOf(node: MemoryNode): Set<string> {
  const text = `${node.label} ${node.body ?? ""}`.toLowerCase();
  return new Set(text.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== ""));
}

/**
 * Overlap of two sets, in [0, 1].
 *
 * Two EMPTY sets score 0 rather than 1. The identity is arguable and the
 * consequence is not: scoring them 1 would nominate every pair of nodes that
 * happens to be connected to nothing yet, which on a young graph is most of it.
 */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Union-find, so a chain of pairwise matches becomes one group. */
class DisjointSet {
  readonly #parent = new Map<string, string>();

  constructor(ids: readonly string[]) {
    for (const id of ids) this.#parent.set(id, id);
  }

  find(id: string): string {
    let root = id;
    for (;;) {
      const parent = this.#parent.get(root);
      if (parent === undefined || parent === root) break;
      root = parent;
    }
    return root;
  }

  join(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    // Lowest id wins, so the grouping is deterministic rather than dependent on
    // the order the pairs happened to be compared in.
    if (rootA < rootB) this.#parent.set(rootB, rootA);
    else this.#parent.set(rootA, rootB);
  }

  groups(): string[][] {
    const byRoot = new Map<string, string[]>();
    for (const id of this.#parent.keys()) {
      const root = this.find(id);
      const bucket = byRoot.get(root);
      if (bucket === undefined) byRoot.set(root, [id]);
      else bucket.push(id);
    }
    return [...byRoot.values()];
  }
}
