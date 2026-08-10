import type { MemoryGraph, MemoryNode } from "./graph.js";
import { handle, projectInto, projectSource, type ProjectedNode } from "./projection.js";
import { MEMORY_TIERS } from "./schema.js";

/**
 * The memory side of the source store.
 *
 *
 * ## VERDICT: the source store already exists, under another name
 *
 * `syl-005.1.3` asks for "articles, threads and books: immutable originals
 * plus derived summaries, with mandatory provenance and a retention class
 * assigned at intake". `0008_intake.sql` shipped that under the intake epic:
 *
 * | What the bead asks for | Where it already is |
 * | --- | --- |
 * | Immutable originals | `intake_chunks` — the parsed text, replaced wholesale on re-parse, never edited |
 * | Derived summaries | `intake_extracts` — one validated `ChunkExtract` per chunk |
 * | Provenance, mandatory | `source_id` foreign keys `ON DELETE CASCADE`, with `PRAGMA foreign_keys` on |
 * | Retention class at intake | `retention_class` + `retention_reason` + `expires_at`, decided by `classifyRetention` before the first fetch |
 * | Hard delete follows the chain | `IntakeStore.purge` — one `DELETE`, and the foreign keys reach everything descended from it |
 *
 * That is the same store. Building `backend/src/memory/sources.ts` as a second
 * table would give one concept two homes, two retention columns that can
 * disagree, and two ids for one article — which is exactly the drift this
 * project keeps paying for. **So this module is not a store.** It is the
 * memory-side wiring: it teaches the graph to reference `intake_sources`, and
 * it gives a hard delete the reach into the graph that a foreign key cannot
 * have.
 *
 * (The one thing the bead named that did not exist is that reach. A foreign
 * key from `memory_nodes` into `intake_sources` is not an option — `0013`'s
 * header sets out why the graph stays unreferenced — so it has to be a query,
 * and {@link MemorySources.forget} is it.)
 *
 *
 * ## What a source becomes in the graph: handles, not content
 *
 * Every node this module writes carries the four-field projection contract
 * (`projection.ts`): `{ id, type, label, ref }`. Nothing else.
 *
 * That matters most here, because an intake source is the single most
 * mutable-looking thing that could be copied into the graph — it has a
 * `stage` that walks a ladder, a `bytes` count, a `chunk_count`, a `failure`,
 * an `expires_at`. Copy any of it and the graph starts asserting that an
 * article is still being fetched a year after it was read, and nothing errors.
 * `intake_sources` stays the authority on all of it, including the retention
 * class, which is why {@link MemorySources.provenanceOf} reads the class from
 * the row rather than from the node.
 *
 * So a graft produces:
 *
 * - one `source` node whose `ref` is the intake source id;
 * - one `memory` node per extract, whose `ref` is the extract id and whose
 *   label is the extract's own summary line;
 * - one observed edge per extract, from the source handle to the extract
 *   handle, `assertedBy` the source handle.
 *
 * The `assertedBy` column is the whole point: `memory_edges_asserted_by_idx`
 * turns "what did this source assert?" into an index seek, and that is what
 * makes a later forget possible.
 *
 *
 * ## Forgetting, and the collision with constraint 6
 *
 * Constraint 6 says an inferred edge is never deleted, only demoted. The
 * retention design says a `sensitive` source's delete must reach everything
 * derived from it. Those meet head-on for an inference drawn over a sensitive
 * source, and the resolution is not a compromise:
 *
 * - **The content is destroyed.** `IntakeStore.purge` removes the source, its
 *   chunks and its extracts through the cascade.
 * - **Derived text in the graph is destroyed.** Every extract handle's label
 *   is a summary of the purged content, so each is relabelled to a tombstone.
 * - **Observations are retracted.** They were assertions on the source's
 *   authority, and the source is gone.
 * - **Inferences are SUPPRESSED, not deleted.** Constraint 6 is not overruled.
 *   Suppression is also what stops the next reflection pass rediscovering
 *   them, which a delete would not.
 * - **The handles survive as tombstones.** They must: a suppressed inference
 *   still has two endpoints, and deleting a node under a live edge is how
 *   "demote, never prune" quietly becomes an unreachable row.
 *
 * What survives is therefore the SHAPE — that something was here, that
 * something was inferred from it — and none of the content. An inference's
 * own `reasoning` string is the residue: it was written by the judgment turn,
 * it can quote what it reasoned over, and suppression does not erase it.
 * {@link ForgetReport.suppressedEdges} names every one so the Commander can be
 * shown exactly what is left rather than being told it is all gone.
 */

/**
 * ## Why this module imports NOTHING from `connections/`
 *
 * US4's acceptance test holds a structural fence: nothing outside
 * `connections/` may import it except `index.ts`, the composition root.
 * "Exactly one door in, and the reader has exactly one caller." That fence is
 * a security boundary and it is not something to widen for convenience — so
 * the dependency is inverted instead. Everything this module needs from intake
 * is declared below as a narrow PORT, and the real `IntakeStore` satisfies
 * every one of them structurally, with no import in either direction.
 *
 * That leaves one duplicated vocabulary — {@link SourceRetention}, the three
 * retention classes — which is exactly the kind of copy that drifts. It is
 * pinned by a test that imports both this file and `connections/retention.ts`
 * and asserts they still agree; a test file is outside the fence, so the
 * assertion costs nothing and the drift cannot happen quietly.
 */

/**
 * How long a source lives and how carefully it is deleted.
 *
 * Mirrors `RetentionClass` in `connections/retention.ts`. See above for why it
 * is a copy and what stops it drifting.
 */
export type SourceRetention = "ephemeral" | "standard" | "sensitive";

/** The slice of an intake source row this module reads. */
export interface SourceRow {
  readonly id: string;
  readonly title: string | null;
  readonly canonicalUrl: string;
  readonly retention: SourceRetention;
}

/** The slice of a stored extract this module reads. */
export interface SourceExtractRow {
  readonly id: string;
  readonly sourceId: string;
  readonly chunkIndex: number;
  readonly extract: { readonly summary: string };
}

/**
 * The slice of `IntakeStore` this module calls.
 *
 * Three methods. `purge` is the one that matters: it is a real hard delete
 * through the foreign-key cascade, and this module's job is to give it the
 * reach into the graph that a foreign key cannot have.
 */
export interface SourceStore {
  get(id: string): SourceRow | null;
  extracts(sourceId: string): readonly SourceExtractRow[];
  purge(sourceId: string): { readonly chunks: number; readonly extracts: number };
}

/**
 * What intake's `graft` option wants.
 *
 * Structurally identical to `GraftSink` in `connections/intake.ts`, declared
 * here so the fence stays intact. A test pins that {@link MemorySources.sink}
 * is assignable to the real one.
 */
export interface SourceGraftSink {
  graft(input: {
    readonly source: SourceRow;
    readonly extracts: readonly SourceExtractRow[];
  }): void | Promise<void>;
}

/** The relation an extract handle hangs off its source by. */
export const EXTRACTED_RELATION = "extracted";

/** Prefix every tombstone label carries, so one is recognisable on sight. */
export const TOMBSTONE_PREFIX = "forgotten:";

/** Longest label minted from an extract's summary. */
export const SOURCE_LABEL_MAX_CHARS = 160;

/** How restrictive each class is. Higher governs when several apply. */
const RETENTION_SEVERITY: Readonly<Record<SourceRetention, number>> = {
  ephemeral: 0,
  standard: 1,
  sensitive: 2,
};

/** Where a node came from, and how carefully it must be deleted. */
export interface SourceProvenance {
  /** The node whose provenance this is. */
  readonly nodeId: string;
  /** The `source` handle that asserted it — possibly the node itself. */
  readonly sourceNodeId: string;
  /** The intake row. The authority on retention, stage and expiry. */
  readonly source: SourceRow;
  /** Read from the row, never from the node. */
  readonly retention: SourceRetention;
}

/** What one graft wrote. */
export interface GraftReport {
  readonly source: ProjectedNode;
  readonly extracts: readonly ProjectedNode[];
  /** Observed edges created this time. Empty on a re-graft that changed nothing. */
  readonly edgesCreated: readonly string[];
  /** `false` when the graph already said exactly this. */
  readonly changed: boolean;
}

/** What one forget destroyed, and — as importantly — what it did not. */
export interface ForgetReport {
  readonly sourceId: string;
  readonly retention: SourceRetention;
  readonly chunksPurged: number;
  readonly extractsPurged: number;
  /** Observed edges withdrawn. */
  readonly retractedEdges: readonly string[];
  /** Inferred edges suppressed. Never deleted — constraint 6. */
  readonly suppressedEdges: readonly string[];
  /** Nodes whose labels were derived text and are now tombstones. */
  readonly tombstonedNodes: readonly string[];
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The label an extract handle carries.
 *
 * The extract's own summary, which is the model's considered one-line account
 * of the chunk. The fallback is positional rather than empty, because
 * `memory_nodes` refuses a blank label and a graft must not fail because a
 * reader turn returned an empty summary for one chunk of thirty.
 */
export function extractLabel(extract: SourceExtractRow): string {
  const summary = oneLine(extract.extract.summary);
  if (summary !== "") return truncate(summary, SOURCE_LABEL_MAX_CHARS);
  return `extract ${String(extract.chunkIndex)} of ${extract.sourceId}`;
}

export interface MemorySourcesOptions {
  readonly store: SourceStore;
  readonly graph: MemoryGraph;
}

/**
 * The graph's view of what the Commander has read.
 *
 * {@link MemorySources.sink} adapts it to {@link SourceGraftSink} — structurally `GraftSink`, the seam
 * intake left open for "the memory graph does not exist yet". The adapter is a
 * one-liner rather than an `implements` clause because `GraftSink.graft`
 * returns nothing: intake does not want the report, and a method typed to
 * satisfy intake would have to throw {@link GraftReport} away for every other
 * caller too.
 */
export class MemorySources {
  readonly #store: SourceStore;
  readonly #graph: MemoryGraph;

  constructor(options: MemorySourcesOptions) {
    this.#store = options.store;
    this.#graph = options.graph;
  }

  /** This module as the `graft` option `ArticleIntake` takes. */
  get sink(): SourceGraftSink {
    return {
      graft: (input) => {
        this.graft(input);
      },
    };
  }

  /**
   * Project a read source and its extracts into the graph.
   *
   * Idempotent, which the intake ladder requires rather than merely prefers:
   * the graft step re-runs after any crash, and it re-runs after a re-read
   * that replaced the extracts. Every write here is keyed on `ref` — the
   * intake ids — so a second graft creates nothing and renames only what the
   * re-read actually changed.
   *
   * @throws {ProjectionError} if a handle ever stops satisfying the four-field
   * contract.
   */
  graft(input: {
    readonly source: SourceRow;
    readonly extracts: readonly SourceExtractRow[];
  }): GraftReport {
    const source = projectInto(this.#graph, projectSource(input.source));
    const extracts: ProjectedNode[] = [];
    const edgesCreated: string[] = [];

    for (const extract of input.extracts) {
      const node = projectInto(
        this.#graph,
        handle({ type: "memory", label: extractLabel(extract), ref: extract.id }),
      );
      extracts.push(node);

      // `findEdge` spans every tier on purpose: an edge the Commander
      // suppressed must not be recreated by a routine re-graft.
      const existing = this.#graph.findEdge(
        source.projection.id,
        node.projection.id,
        EXTRACTED_RELATION,
      );
      if (existing !== null) continue;

      const edge = this.#graph.observe({
        sourceNode: source.projection.id,
        targetNode: node.projection.id,
        relation: EXTRACTED_RELATION,
        assertedBy: source.projection.id,
      });
      edgesCreated.push(edge.id);
    }

    const touched = [source, ...extracts].some((node) => node.outcome !== "unchanged");
    return { source, extracts, edgesCreated, changed: touched || edgesCreated.length > 0 };
  }

  /**
   * Every source that asserted a node, most restrictive retention first.
   *
   * This is the query a hard delete needs and a foreign key cannot provide.
   * The first element is the one that GOVERNS: a node asserted by both a
   * public article and the Commander's bank statement is a sensitive node, and
   * the strictest class is the only safe answer.
   *
   * Retention comes off the `intake_sources` row every time. It is never read
   * from the node, because the node does not carry it — the four-field
   * contract is what makes that a compile-time fact rather than a habit.
   *
   * @returns an empty array for a node no source asserted — an inference, a
   * hand-written fact, a life-model handle.
   */
  provenanceOf(nodeId: string): readonly SourceProvenance[] {
    const node = this.#graph.getNode(nodeId);
    if (node === null) return [];

    const found = new Map<string, SourceProvenance>();
    const consider = (sourceNode: MemoryNode): void => {
      if (sourceNode.kind !== "source" || sourceNode.subjectId === null) return;
      if (found.has(sourceNode.id)) return;
      const source = this.#store.get(sourceNode.subjectId);
      if (source === null) return;
      found.set(sourceNode.id, {
        nodeId,
        sourceNodeId: sourceNode.id,
        source,
        retention: source.retention,
      });
    };

    consider(node);
    // Every tier: a demoted or suppressed edge is still how this node got
    // here, and a forget that skipped cold provenance would leave the most
    // dormant derivations of a sensitive source in place forever.
    for (const edge of this.#graph.neighbourhood(nodeId, { depth: 1, tiers: MEMORY_TIERS }).edges) {
      if (edge.kind !== "observed") continue;
      const asserter = this.#graph.getNode(edge.assertedBy);
      if (asserter !== null) consider(asserter);
    }

    return [...found.values()].sort(
      (a, b) =>
        RETENTION_SEVERITY[b.retention] - RETENTION_SEVERITY[a.retention] ||
        (a.sourceNodeId < b.sourceNodeId ? -1 : 1),
    );
  }

  /**
   * Destroy a source and everything derived from it that can be destroyed.
   *
   * See the module header for the constraint-6 collision and how it resolves.
   * Order matters and is not arbitrary:
   *
   * 1. read the extracts, **before** the purge takes them;
   * 2. suppress inferences over the handles — while both endpoints still have
   *    the labels that make the report legible;
   * 3. retract the observations the source asserted;
   * 4. tombstone every handle whose label was derived from the content;
   * 5. purge the intake rows, which cascades to chunks and extracts.
   *
   * @throws {IntakeStoreError} `unknown_source`.
   */
  forget(sourceId: string): ForgetReport {
    const source = this.#store.get(sourceId);
    if (source === null) {
      throw new IntakeSourceMissing(sourceId);
    }

    const extracts = this.#store.extracts(sourceId);
    const sourceNode = this.#handleFor(sourceId, "source");
    const extractNodes = extracts
      .map((extract) => this.#handleFor(extract.id, "memory"))
      .filter((node): node is MemoryNode => node !== null);

    const suppressedEdges: string[] = [];
    const retractedEdges: string[] = [];
    const tombstonedNodes: string[] = [];

    const handles = sourceNode === null ? extractNodes : [sourceNode, ...extractNodes];

    for (const node of handles) {
      for (const edge of this.#graph.neighbourhood(node.id, { depth: 1, tiers: MEMORY_TIERS })
        .edges) {
        if (edge.kind !== "inferred" || edge.tier === "suppressed") continue;
        if (suppressedEdges.includes(edge.id)) continue;
        this.#graph.suppress(edge);
        suppressedEdges.push(edge.id);
      }
    }

    if (sourceNode !== null) {
      for (const edge of this.#graph.edgesAssertedBy(sourceNode.id)) {
        this.#graph.retract(edge);
        retractedEdges.push(edge.id);
      }
    }

    for (const node of extractNodes) {
      this.#graph.relabel(node, `${TOMBSTONE_PREFIX} an extract of a purged source`);
      tombstonedNodes.push(node.id);
    }
    if (sourceNode !== null) {
      this.#graph.relabel(sourceNode, `${TOMBSTONE_PREFIX} a purged ${source.retention} source`);
      tombstonedNodes.push(sourceNode.id);
    }

    const purged = this.#store.purge(sourceId);
    return {
      sourceId,
      retention: source.retention,
      chunksPurged: purged.chunks,
      extractsPurged: purged.extracts,
      retractedEdges,
      suppressedEdges,
      tombstonedNodes,
    };
  }

  /** The one handle for a row, or `null`. `(ref, kind)` is unique by index. */
  #handleFor(ref: string, kind: "source" | "memory"): MemoryNode | null {
    return this.#graph.nodesForSubject(ref).find((node) => node.kind === kind) ?? null;
  }
}

/** Thrown when a forget names a source that is not in the store. */
export class IntakeSourceMissing extends Error {
  readonly sourceId: string;

  constructor(sourceId: string) {
    super(
      `There is no intake source ${sourceId} to forget. A forget is refused rather than ` +
        `reported as a success, because "it was already gone" and "it was never reached" look ` +
        `identical to the caller and only one of them is safe.`,
    );
    this.name = "IntakeSourceMissing";
    this.sourceId = sourceId;
  }
}
