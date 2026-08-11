import { Router, type Request, type RequestHandler } from "express";

import {
  buildConstellation,
  DEFAULT_STARS,
  MAX_STARS,
} from "../memory/constellation.js";
import { DreamLogError, type DeclaredCounts, type DreamLog } from "../memory/dream/log.js";
import { GraphError, type MemoryEdge, type MemoryGraph, type MemoryNode } from "../memory/graph.js";
import type { MemoryMetrics } from "../memory/metrics.js";
import {
  RetrievalError,
  RETRIEVAL_CHANNELS,
  type RetrievalChannel,
  type Retriever,
} from "../memory/retrieve.js";
import {
  isMemoryNodeKind,
  MEMORY_NODE_KINDS,
  type MemoryNodeKind,
  type MemoryTier,
} from "../memory/schema.js";
import { WeightError, type EdgeWeights } from "../memory/weights.js";
import { RememberError, type HerOwnMemory, type Remembered } from "../memory/remember.js";
import type { OverflowKindCount, WorkingMemory } from "../memory/working.js";
import { instant, systemClock, type Clock } from "../services/clock.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { runIdempotent, sendIdempotent } from "./idempotency.js";

/**
 * The memory graph, over HTTP — and the one place the Commander can correct it.
 *
 * ## Why this exists
 *
 * He asked for it by name: *"I would love to see the graph in the admin tool
 * while developing — I want to see how the memory system evolves and what it
 * creates that is relevant, and how relevant the inferred engine is."* That last
 * clause decides the shape of this route. Judging the inferred engine means
 * seeing, per edge, **which species it is, what it is worth today, and why Syl
 * thought so** — so `reasoning` travels on every inferred edge and never on an
 * observed one, and the *decayed* weight travels beside the stored one.
 *
 * ## It WRITES, and that is the point
 *
 * `POST /memory/edges/{id}/feedback` is not a convenience. The most valuable
 * thing that can happen on this surface is not looking, it is him seeing a wrong
 * connection and killing it, or a good one and confirming it. Both feed forces
 * that already exist in `memory/weights.ts` — suppression, and the engagement
 * touch that is the only path an edge has to a weight above Syl's own internal
 * cap. That makes this view a **data source** for the memory system rather than
 * a window onto it, and it is the cheapest high-quality signal the system will
 * ever get.
 *
 * The verdict is written in two places on purpose, because they answer different
 * questions and neither implies the other:
 *
 *   - the **graph**, via `EdgeWeights` — what the edge is now worth, and which
 *     partition it lives in;
 *   - the **dream log**, via `DreamLog.recordEngagement` — what he did about
 *     something she chose to show him. Without this second write the engagement
 *     metric's denominator never moves and the panel reports "everything
 *     surfaced is still awaiting a verdict" forever, which is the meaningless
 *     zero `metrics.ts` is written against.
 *
 * The two stores stay separate (constraint 7): this route writes to each of them
 * directly, and neither writes to the other.
 *
 * ## It is NOT admin-scoped, and this section used to say the opposite
 *
 * It used to argue — at length, and with the `GET /logs` precedent — that a
 * shoulder-surfed pairing code must not reach the graph. **The Commander
 * overruled that on 2026-08-10**: *"Remove the need for another key for the
 * admin panel. Too annoying."* `index.ts` passes `anyAuthenticatedDevice` for
 * {@link MemoryRouterOptions.authorize}, and a paired phone reaches every route
 * in this file.
 *
 * The correction is recorded rather than deleted because the mistake it caused
 * is worth keeping. This comment stayed as it was for the seventy-four minutes
 * between his ruling landing and `specs/009-the-constellation` being planned
 * against it — and the plan opens by naming a `403` that no longer existed. The
 * mount below reads `authenticate, authorize`, the option was called
 * `requireAdmin`, and the value behind it is `(_req, _res, next) => next()`.
 * **Every place a reader would look said "gated"; only the call site said
 * otherwise.** A parameter named for a policy outlives the policy, so it is now
 * named for its position instead.
 *
 * What still does the work, and would whatever the option held: a caller must
 * be **authenticated**. Pairing is over the tailnet behind eight digits, and an
 * unpaired caller gets the same indistinguishable 401 it always did.
 *
 * The seam is deliberately kept. Putting a scope back is one line at the call
 * site — see `middleware/auth.ts`, which keeps `requireScope` and the `scope`
 * column for exactly that reason.
 *
 * ## Scale: what this deliberately does NOT return
 *
 * The graph will outgrow naive rendering long before it outgrows SQLite. This
 * route serves **the hot region plus the last N nights of dream output**, which
 * is what he wants to look at anyway, and it says so in `scope.explanation`
 * rather than letting a slice be read as the whole store. Concretely:
 *
 *   - seeds are the most recently touched **hot** nodes, and each contributes
 *     its one-hop **hot** neighbourhood, up to an edge budget;
 *   - every edge the last N nights' dream sessions touched is added **whatever
 *     tier it is now in** — an edge created last night and already demoted is
 *     precisely the thing he is trying to see, and the hot region alone would
 *     hide it.
 *
 * Everything is read through `MemoryGraph`'s public API. This file owns no SQL:
 * the identity lookups that span the cold partition are subtle enough that a
 * second copy of them behind a route is exactly where they would silently
 * acquire a `tier` predicate.
 *
 * ## The contract has not caught up yet
 *
 * `shared/openapi.yaml` has no memory operation — the graph landed today and the
 * spec is another lane's. As with `connections/intake-route.ts`, this serves the
 * store's own shape inside the **standard envelope**, so a client that meets
 * this route before the spec catches up still gets something it can parse.
 * Adding the operations to the spec is `syl-q9n`, and it is the more urgent
 * kind of debt than intake's: one of these routes is a WRITE, so a second
 * client would have to guess at the body.
 */

/** The read-and-write surfaces this router needs. Injected, never constructed here. */
export interface MemoryViews {
  readonly graph: MemoryGraph;
  /** The weight law applied to the store: the confirm and reject forces. */
  readonly weights: EdgeWeights;
  /** The derived panel. Read-only by construction — see `memory/metrics.ts`. */
  readonly metrics: MemoryMetrics;
  /** Telemetry about the graph, which is a different store and stays one. */
  readonly dreams: DreamLog;
  /**
   * The projection Syl reads on every turn. Here for the one thing it can
   * answer and nothing else can: **what it could not fit**.
   */
  readonly working: WorkingMemory;
  /**
   * Retrieval, or `null` on a machine that has none.
   *
   * A THUNK, and required rather than optional, for two separate reasons:
   *
   * - The retriever lives behind `MemoryRuntime.trySearchable()`, which builds
   *   the store lazily and degrades to `null` when `vec0` is missing. Resolving
   *   it at construction would put a native extension on the boot path, and
   *   `services/memory-runtime.ts` argues at length why nothing about memory may
   *   decide whether this service starts — Syl holds reminder guarantees.
   * - Required, so that wiring it is not something a future bootstrap can
   *   forget. An optional field left unset would make recall answer "there is
   *   nothing here" forever, which is a lie the shape of the defect this whole
   *   epic exists to fix.
   */
  readonly recall: () => Retriever | null;
  /**
   * The one write she has into her own memory — `syl-016.7`.
   *
   * Deliberately a narrow object rather than the graph: `HerOwnMemory` can
   * create a `memory` node and `inferred` links to entities that already
   * exist, and it has no method that deletes, supersedes, relabels, moves a
   * weight or mints a person. That is the whole security argument for putting
   * a write on her credential at all, and it is held by the type rather than
   * by the route remembering to be careful.
   */
  readonly hers: HerOwnMemory;
}

export interface MemoryRouterOptions {
  readonly memory: MemoryViews;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
  /**
   * What this surface requires BEYOND a valid token.
   *
   * Named for its position rather than for a policy, because the policy has
   * already changed once underneath the old name — see this module's header.
   * Today `index.ts` passes `anyAuthenticatedDevice`, which requires nothing
   * further. Separate from `authenticate` so both are visibly mounted at the
   * bootstrap rather than hidden in here.
   */
  readonly authorize: RequestHandler;
  readonly clock?: Clock;
}

// ---------------------------------------------------------------------------
// The wire shapes
// ---------------------------------------------------------------------------

/** A node, as the viewer needs it. */
export interface MemoryNodeView {
  readonly id: string;
  readonly tier: MemoryTier;
  readonly kind: string;
  readonly label: string;
  readonly body: string | null;
  readonly subjectId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * An edge, with the two species kept apart at the wire.
 *
 * `reasoning` is non-null exactly for `inferred`, and `assertedBy` non-null
 * exactly for `observed`. They are separate fields rather than one `provenance`
 * string precisely so a viewer cannot render Syl's speculation and a source's
 * assertion through the same code path by accident.
 */
export interface MemoryEdgeView {
  readonly id: string;
  readonly kind: "observed" | "inferred";
  readonly tier: MemoryTier;
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly relation: string;
  /** The weight as last written. */
  readonly storedWeight: number;
  /** What it is worth NOW, after decay. The number that should be rendered. */
  readonly effectiveWeight: number;
  /** How sure reflection was. `null` on an observation. */
  readonly confidence: number | null;
  /** WHY Syl believes this. `null` on an observation — a source simply said so. */
  readonly reasoning: string | null;
  /** WHO said so. `null` on an inference. */
  readonly assertedBy: string | null;
  readonly demoteAfter: string | null;
  readonly lastTouchedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** How this edge came to be in this view. Not a property of the edge. */
  readonly origin: "hot_region" | "dream";
}

/** One disposition the dream took, in the model's own words. */
export interface DreamDispositionView {
  readonly id: number;
  readonly disposition: string;
  readonly edgeId: string | null;
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly tierBefore: MemoryTier | null;
  readonly tierAfter: MemoryTier | null;
  readonly reasoning: string;
  readonly confidence: number | null;
  readonly createdAt: string;
}

/** One thing she chose to tell him, and what he did about it. */
export interface DreamSurfacedView {
  readonly id: number;
  readonly edgeId: string | null;
  readonly summary: string;
  readonly surfacedAt: string;
  readonly response: string;
  readonly respondedAt: string | null;
}

/** One night of reflection. */
export interface DreamNightView {
  readonly sessionId: string;
  readonly night: string;
  readonly tz: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: string;
  readonly error: string | null;
  readonly tokensSpent: number;
  readonly costUsd: number;
  readonly turns: number;
  readonly counts: DeclaredCounts;
  readonly dispositions: readonly DreamDispositionView[];
  readonly surfaced: readonly DreamSurfacedView[];
}

/** What was left out, in numbers and in words. */
export interface MemoryScopeView {
  /** The partition the seeds come from. Always `hot`: this is the live region. */
  readonly tier: MemoryTier;
  readonly nodeSeeds: number;
  readonly edgeBudget: number;
  readonly nights: number;
  readonly seedsUsed: number;
  readonly edgesReturned: number;
  /** True when the budget stopped the walk before the hot region ran out. */
  readonly edgeBudgetExhausted: boolean;
  readonly nightsReturned: number;
  readonly moreNights: boolean;
  /**
   * Whether a dream has EVER run, independent of the window.
   *
   * Not derivable from an empty `nights`: a store where reflection has never
   * executed and a store whose last week was quiet produce the same empty
   * array, and only the first of those means "nothing is wired up yet".
   */
  readonly dreamHasEverRun: boolean;
  /** What this view is, in words, so a slice is never read as the whole store. */
  readonly explanation: string;
}

/** The decay law in force, so the viewer can draw the floor rather than guess it. */
export interface WeightLawView {
  readonly halfLifeMs: number;
  readonly relevanceFloor: number;
  readonly traversalCap: number;
  readonly engagementCap: number;
}

export interface MemoryGraphView {
  readonly generatedAt: string;
  readonly scope: MemoryScopeView;
  readonly law: WeightLawView;
  readonly nodes: readonly MemoryNodeView[];
  readonly edges: readonly MemoryEdgeView[];
  /** Newest night first. */
  readonly nights: readonly DreamNightView[];
  /** Nodes set aside by supersession, most recently set aside first. */
  readonly superseded: readonly MemoryNodeView[];
}

// ---------------------------------------------------------------------------
// Recall — `syl-016.1`
// ---------------------------------------------------------------------------

/**
 * How a node came to be in a recall answer.
 *
 * Kept on the wire because the three are different kinds of claim and a reader
 * that flattened them would be confidently wrong. `matched` is *this answers
 * your question*; `connected` is *this touches something that does*, which is
 * often the more useful one and is never the same statement; `not_shown` is
 * *nothing matched anything, this is simply what the digest hid from you*.
 */
export type RecallOrigin = "matched" | "connected" | "not_shown";

/** One remembered thing, **with its id**. */
export interface RecalledNodeView {
  /**
   * The handle every other memory verb needs.
   *
   * The reason this route exists. She could read a digest and nothing else, so
   * there was no way for her to obtain an id — which meant no verb that acts on
   * a memory could ever be given one.
   */
  readonly id: string;
  readonly kind: MemoryNodeKind;
  readonly label: string;
  readonly body: string | null;
  readonly updatedAt: string;
  readonly origin: RecallOrigin;
  /** `relevance * trust * decay`. `null` for anything the ranker did not score. */
  readonly score: number | null;
  /** Which channels spoke for it. Empty for anything the ranker did not score. */
  readonly channels: readonly RetrievalChannel[];
}

/**
 * One connection between two remembered things.
 *
 * `reasoning` travels on an inference and never on an observation, the same
 * separation `MemoryEdgeView` keeps and for the same reason: Syl's own
 * speculation and a source's assertion must not be readable through one field.
 */
export interface RecalledEdgeView {
  readonly id: string;
  readonly kind: "observed" | "inferred";
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly relation: string;
  /** WHY she believes this. `null` on an observation — a source simply said so. */
  readonly reasoning: string | null;
}

/** What one recall found, and what it could not speak for. */
export interface MemoryRecallView {
  readonly generatedAt: string;
  /** What was asked, or `null` when the overflow was opened instead. */
  readonly asked: string | null;
  readonly mode: "search" | "not_shown";
  readonly found: readonly RecalledNodeView[];
  /** Every edge the walk crossed. Empty in `not_shown`, which does not walk. */
  readonly connections: readonly RecalledEdgeView[];
  /** Channels that were available for this query at all, in formula order. */
  readonly channels: readonly RetrievalChannel[];
  /**
   * The highest relevance this query could have produced.
   *
   * Read this before comparing a score against a threshold: the fusion weights
   * are never renormalised, so a query with no entity honestly caps at 0.7 and
   * a 0.5 from it is not the same evidence as a 0.5 out of 1.0.
   */
  readonly ceiling: number;
  readonly limit: number;
  /**
   * How many more there are than came back. `null` when it was not counted.
   *
   * Counted in `not_shown`, where the set is finite and known. `null` in
   * `search`, because ranking returns the best `limit` and does not count what
   * it passed over — and a zero there would be a claim that there is nothing
   * else, which is the silent kind of wrong this project keeps finding.
   */
  readonly more: number | null;
  /** What the overflow is made of. Empty in `search`. */
  readonly byKind: readonly OverflowKindCount[];
  /** What this answer is, in words, so a slice is never read as the whole store. */
  readonly explanation: string;
}

/** How many memories one recall returns when nobody says. */
export const DEFAULT_RECALL_LIMIT = 10;
/** The most a single recall will carry. Beyond this it is a data dump. */
export const MAX_RECALL_LIMIT = 50;
/** The longest question this route will take. */
export const MAX_RECALL_QUERY_CHARS = 500;
/** The most entity names the holographic channel is given. */
export const MAX_RECALL_ENTITIES = 8;

/**
 * The longest thought she may keep in one memory.
 *
 * Generous on purpose — the insight this verb exists for is a three-clause
 * paragraph, and a limit that forced her to compress it would recreate the
 * defect: she was already compressing thoughts to smuggle them through a goal.
 */
export const MAX_THOUGHT_CHARS = 2_000;

/** What a recall was asked for, already parsed. */
export interface RecallBounds {
  /** The question, or `null` to open the overflow instead. */
  readonly query: string | null;
  readonly kind: MemoryNodeKind | null;
  /** Entity names for the structural channel. See `RetrievalQuery.entities`. */
  readonly entities: readonly string[];
  readonly limit: number;
}

/** The channels a query could not use, named so an absence is never silent. */
function missingChannels(available: readonly RetrievalChannel[]): readonly RetrievalChannel[] {
  return RETRIEVAL_CHANNELS.filter((channel) => !available.includes(channel));
}

/**
 * Answer one recall.
 *
 * Exported so the judgement can be exercised without a socket, exactly as
 * {@link buildGraphView} is. Two modes, and they are deliberately one verb:
 *
 * - **A question** goes to `Retriever`, the fusion kernels built in
 *   `syl-005.3` and wired to nothing until now. Entry points AND the
 *   neighbourhood they open onto — a caller that read only the ranked list
 *   would have used a search engine and left the graph on the table.
 * - **No question** opens the working-memory overflow (`syl-016.2`): the items
 *   the digest counted and would not name. That is not a search and must not be
 *   answered by one, because "what is being kept from me" is a question about
 *   the projection's own ranking and no query text can reproduce it.
 *
 * @throws {ApiFailure} `UPSTREAM_UNAVAILABLE` when a question is asked on a
 * machine whose searchable half could not be assembled. Deliberately not an
 * empty result: "I found nothing" and "I could not look" are different
 * sentences and she has to be able to say which.
 */
export async function buildRecall(
  memory: MemoryViews,
  bounds: RecallBounds,
  now: number,
): Promise<MemoryRecallView> {
  const generatedAt = instant(now);

  if (bounds.query === null) {
    const overflow = memory.working.overflow({
      limit: bounds.limit,
      ...(bounds.kind === null ? {} : { kind: bounds.kind }),
    });

    return {
      generatedAt,
      asked: null,
      mode: "not_shown",
      found: overflow.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        label: item.label,
        body: item.body,
        updatedAt: item.updatedAt,
        origin: "not_shown",
        score: null,
        channels: [],
      })),
      connections: [],
      channels: [],
      ceiling: 0,
      limit: bounds.limit,
      more: overflow.matched - overflow.items.length,
      byKind: overflow.byKind,
      explanation:
        `Everything in the hot region that the working-memory digest could not fit — ` +
        `${String(overflow.total)} item(s), most salient first. This is NOT a search: it is ` +
        `the same ranking the digest itself uses, so it is exactly what was left out and ` +
        `nothing else. Anything colder than the hot region is found by asking a question.`,
    };
  }

  const retriever = memory.recall();
  if (retriever === null) {
    throw new ApiFailure(
      "UPSTREAM_UNAVAILABLE",
      "Syl's memory cannot be searched on this machine right now — the searchable half did " +
        "not assemble, so keyword and meaning are both unavailable. Nothing has been lost: " +
        "the graph is intact and what the digest could not fit can still be opened without a " +
        "question.",
    );
  }

  let retrieval;
  try {
    retrieval = await retriever.retrieve({
      text: bounds.query,
      limit: bounds.limit,
      ...(bounds.kind === null ? {} : { kind: bounds.kind }),
      ...(bounds.entities.length === 0 ? {} : { entities: bounds.entities }),
    });
  } catch (error) {
    if (error instanceof RetrievalError) {
      throw new ApiFailure("VALIDATION_FAILED", error.message, {
        details: { reason: error.kind },
      });
    }
    throw error;
  }

  const ranked = new Map(retrieval.entries.map((entry) => [entry.node.id, entry]));
  const found: RecalledNodeView[] = retrieval.nodes.map((node) => {
    const entry = ranked.get(node.id);
    return {
      id: node.id,
      kind: node.kind,
      label: node.label,
      body: node.body,
      updatedAt: node.updatedAt,
      origin: entry === undefined ? "connected" : "matched",
      score: entry?.score ?? null,
      channels: entry?.channels ?? [],
    };
  });

  // Ranked first and in rank order, then the neighbourhood. `retrieval.nodes`
  // is walk order, which is an implementation detail of the traversal; what she
  // reads first should be what best answers her.
  found.sort((a, b) => {
    if (a.origin !== b.origin) return a.origin === "matched" ? -1 : 1;
    if (a.score !== b.score) return (b.score ?? 0) - (a.score ?? 0);
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const blind = missingChannels(retrieval.channels);
  return {
    generatedAt,
    asked: bounds.query,
    mode: "search",
    found,
    connections: retrieval.edges.map(toRecalledEdge),
    channels: retrieval.channels,
    ceiling: retrieval.ceiling,
    limit: bounds.limit,
    more: null,
    byKind: [],
    explanation:
      `The best ${String(bounds.limit)} match(es) for that question, plus everything one hop ` +
      `out from them — a connection is often the answer even when the node itself is not. ` +
      (retrieval.channels.length === 0
        ? `Nothing matched on any channel. `
        : `Searched by: ${retrieval.channels.join(", ")}. `) +
      (blind.length === 0
        ? ``
        : `NOT searched by: ${blind.join(", ")}, so a score here is out of ` +
          `${retrieval.ceiling.toFixed(2)} rather than 1.00${
            blind.includes("holographic") ? ` — name the people or things it is about to add ` +
              `the structural channel` : ``
          }. `) +
      `Nothing beyond the best few is counted, so this does not say how much more there is.`,
  };
}

/** One walked edge, with the two species kept apart. See {@link RecalledEdgeView}. */
export function toRecalledEdge(edge: MemoryEdge): RecalledEdgeView {
  return {
    id: edge.id,
    kind: edge.kind,
    sourceNode: edge.sourceNode,
    targetNode: edge.targetNode,
    relation: edge.relation,
    reasoning: edge.kind === "inferred" ? edge.reasoning : null,
  };
}

/** What a verdict did. */
export interface MemoryFeedbackResult {
  readonly verdict: "confirm" | "reject";
  readonly edge: MemoryEdgeView;
  /** The effective weight before the verdict landed. */
  readonly weightBefore: number;
  /** The stored weight after it. */
  readonly weightAfter: number;
  /**
   * How many surfaced rows this answered. Zero is ordinary — he can correct an
   * edge she never showed him — and is not a failure.
   */
  readonly surfacedRecorded: number;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Nights of dream output carried by default. A week is what he looks at. */
export const DEFAULT_DREAM_NIGHTS = 7;
/** The longest window this route will assemble in one response. */
export const MAX_DREAM_NIGHTS = 60;
/** How many hot nodes seed the walk. */
export const DEFAULT_NODE_SEEDS = 40;
export const MAX_NODE_SEEDS = 200;
/** The most edges a single response carries. Beyond this, rendering is the problem. */
export const DEFAULT_EDGE_BUDGET = 200;
export const MAX_EDGE_BUDGET = 800;

const VERDICTS = ["confirm", "reject"] as const;

type Verdict = (typeof VERDICTS)[number];

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export function toNodeView(node: MemoryNode): MemoryNodeView {
  return {
    id: node.id,
    tier: node.tier,
    kind: node.kind,
    label: node.label,
    body: node.body,
    subjectId: node.subjectId,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

/**
 * One edge, with its decayed weight resolved.
 *
 * The union is narrowed on `kind` rather than spread, so a field that belongs to
 * one species cannot travel on the other: `reasoning` and `assertedBy` are set
 * from the narrowed branch and the opposite one is written `null` explicitly.
 */
export function toEdgeView(
  edge: MemoryEdge,
  effectiveWeight: number,
  origin: MemoryEdgeView["origin"],
): MemoryEdgeView {
  const common = {
    id: edge.id,
    tier: edge.tier,
    sourceNode: edge.sourceNode,
    targetNode: edge.targetNode,
    relation: edge.relation,
    storedWeight: edge.weight,
    effectiveWeight,
    demoteAfter: edge.demoteAfter,
    lastTouchedAt: edge.lastTouchedAt,
    createdAt: edge.createdAt,
    updatedAt: edge.updatedAt,
    origin,
  };
  return edge.kind === "inferred"
    ? {
        ...common,
        kind: "inferred",
        confidence: edge.confidence,
        reasoning: edge.reasoning,
        assertedBy: null,
      }
    : {
        ...common,
        kind: "observed",
        confidence: null,
        reasoning: null,
        assertedBy: edge.assertedBy,
      };
}

// ---------------------------------------------------------------------------
// Query parsing — every bound is refused rather than coerced
// ---------------------------------------------------------------------------

/**
 * A positive whole number from the query string, or a refusal.
 *
 * Refused rather than clamped: a `nights=0` quietly read as "the default" hands
 * back a week of nights under a label the caller did not ask for, and the reader
 * concludes that is what the last zero nights held.
 */
export function countParam(request: Request, field: string, fallback: number, max: number): number {
  const raw = request.query[field];
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") {
    throw new ApiFailure("VALIDATION_FAILED", `${field} must appear at most once.`, {
      details: { field, reason: "repeated" },
    });
  }
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ApiFailure("VALIDATION_FAILED", `That is not a usable ${field}.`, {
      details: { field, reason: `must be a whole number between 1 and ${String(max)}` },
    });
  }
  return value;
}

/**
 * The bounds of one recall, off the query string.
 *
 * Every field is refused rather than coerced, on the same argument
 * {@link countParam} makes: a value quietly read as something else hands back
 * an answer to a question nobody asked, under a label that says otherwise.
 *
 * An ABSENT `q` and a BLANK one both mean "open the overflow". They are the
 * same intent — a model that has nothing to search for sends one or the other
 * depending on how it was feeling — and splitting them would make an empty
 * string a validation error she has no way to interpret.
 */
export function recallBounds(request: Request): RecallBounds {
  const asked = request.query["q"];
  if (asked !== undefined && typeof asked !== "string") {
    throw new ApiFailure("VALIDATION_FAILED", "q must appear at most once.", {
      details: { field: "q", reason: "repeated" },
    });
  }
  const query = (asked ?? "").trim();
  if (query.length > MAX_RECALL_QUERY_CHARS) {
    throw new ApiFailure("VALIDATION_FAILED", "That question is too long to search on.", {
      details: { field: "q", reason: `at most ${String(MAX_RECALL_QUERY_CHARS)} characters` },
    });
  }

  const rawKind = request.query["kind"];
  if (rawKind !== undefined && rawKind !== "" && !isMemoryNodeKind(rawKind)) {
    throw new ApiFailure("VALIDATION_FAILED", "That is not a kind of thing Syl remembers.", {
      details: { field: "kind", reason: `must be one of ${MEMORY_NODE_KINDS.join(", ")}` },
    });
  }

  // Repeated or comma-separated, both accepted. The holographic channel takes a
  // list and a caller should not have to know which spelling this route chose.
  const rawAbout = request.query["about"];
  const entities = (Array.isArray(rawAbout) ? rawAbout : [rawAbout])
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .slice(0, MAX_RECALL_ENTITIES);

  return {
    query: query === "" ? null : query,
    kind: isMemoryNodeKind(rawKind) ? rawKind : null,
    entities,
    limit: countParam(request, "limit", DEFAULT_RECALL_LIMIT, MAX_RECALL_LIMIT),
  };
}

/**
 * Read a memory she wants to keep off a JSON body.
 *
 * Refused rather than coerced, the same rule the rest of this file follows. A
 * blank `because` quietly accepted would file an inference nobody can judge,
 * which is the residue `syl-016.7` exists to remove.
 */
export function rememberBody(bodyValue: unknown): {
  readonly thought: string;
  readonly because: string;
  readonly about: readonly string[];
} {
  const body =
    typeof bodyValue === "object" && bodyValue !== null && !Array.isArray(bodyValue)
      ? (bodyValue as Record<string, unknown>)
      : {};

  const thought = typeof body["thought"] === "string" ? body["thought"].trim() : "";
  if (thought === "") {
    throw new ApiFailure("VALIDATION_FAILED", "There is nothing here to remember.", {
      details: { field: "thought", reason: "required" },
    });
  }
  if (thought.length > MAX_THOUGHT_CHARS) {
    throw new ApiFailure("VALIDATION_FAILED", "That is longer than one thought.", {
      details: { field: "thought", reason: `at most ${String(MAX_THOUGHT_CHARS)} characters` },
    });
  }

  const because = typeof body["because"] === "string" ? body["because"].trim() : "";
  if (because === "") {
    throw new ApiFailure("VALIDATION_FAILED", "A memory she made has to say why she believes it.", {
      details: { field: "because", reason: "required" },
    });
  }

  const named = body["about"];
  const about = (Array.isArray(named) ? named : [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .slice(0, MAX_RECALL_ENTITIES);

  return { thought, because, about };
}

/** Read the verdict off a JSON body. */
export function verdictOf(bodyValue: unknown): Verdict {
  const raw =
    typeof bodyValue === "object" && bodyValue !== null
      ? (bodyValue as Record<string, unknown>)["verdict"]
      : undefined;
  const match = VERDICTS.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new ApiFailure("VALIDATION_FAILED", "That is not a verdict.", {
      details: { field: "verdict", reason: `must be one of ${VERDICTS.join(", ")}` },
    });
  }
  return match;
}

/**
 * Turn a store refusal into a contract failure.
 *
 * `already_suppressed` and `suppressed_edge` are `CONFLICT` rather than a
 * validation error on purpose: the request was well-formed and the store's
 * answer is *he already said no about this one*, which is a state, not a typo.
 */
function asFailure(error: unknown): ApiFailure {
  if (error instanceof GraphError) {
    if (error.kind === "already_suppressed") {
      return new ApiFailure("CONFLICT", error.message, {
        details: { reason: error.kind },
      });
    }
    if (error.kind === "unknown_node") {
      return new ApiFailure("NOT_FOUND", error.message);
    }
  }
  if (error instanceof WeightError && error.kind === "suppressed_edge") {
    return new ApiFailure("CONFLICT", error.message, { details: { reason: error.kind } });
  }
  if (error instanceof DreamLogError) {
    return new ApiFailure("CONFLICT", error.message, { details: { reason: error.kind } });
  }
  return new ApiFailure("INTERNAL", "The service failed to handle that request.");
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/**
 * Assemble the hot region and the dream window.
 *
 * Exported so the assembly can be exercised without a socket — it is the part
 * with the judgement in it, and the route around it is a query-string parser.
 */
export function buildGraphView(
  memory: MemoryViews,
  bounds: { readonly nodeSeeds: number; readonly edgeBudget: number; readonly nights: number },
  now: number,
): MemoryGraphView {
  const { graph, weights, dreams } = memory;
  const edges = new Map<string, { edge: MemoryEdge; origin: MemoryEdgeView["origin"] }>();
  const nodes = new Map<string, MemoryNode>();

  const remember = (node: MemoryNode | null): void => {
    if (node !== null && !nodes.has(node.id)) nodes.set(node.id, node);
  };

  // -- the hot region --------------------------------------------------------
  //
  // Seeds are the most recently touched hot nodes; each contributes its one-hop
  // hot neighbourhood. `tiers` is passed explicitly because `neighbourhood`
  // defaults to hot and a future default is not something to depend on.
  const seeds = graph.listNodes({ tier: "hot", limit: bounds.nodeSeeds });
  let seedsUsed = 0;
  for (const seed of seeds) {
    if (edges.size >= bounds.edgeBudget) break;
    seedsUsed += 1;
    remember(seed);
    const around = graph.neighbourhood(seed.id, {
      depth: 1,
      tiers: ["hot"],
      limit: bounds.edgeBudget - edges.size,
    });
    for (const node of around.nodes) remember(node);
    for (const edge of around.edges) {
      if (edges.size >= bounds.edgeBudget) break;
      if (!edges.has(edge.id)) edges.set(edge.id, { edge, origin: "hot_region" });
    }
  }
  const edgeBudgetExhausted = edges.size >= bounds.edgeBudget && seedsUsed < seeds.length;

  // -- the dream window ------------------------------------------------------
  //
  // Everything the last N nights touched, WHATEVER TIER IT IS IN NOW. An edge
  // created last night and demoted by this morning's sweep is exactly what he
  // is trying to look at, and the hot region alone would hide it.
  const sessions = dreams.list({ limit: bounds.nights });
  const nights: DreamNightView[] = sessions.items.map((session) => {
    const dispositions = dreams.reasoningOf(session.id).map((row) => ({
      id: row.id,
      disposition: row.disposition,
      edgeId: row.edgeId,
      sourceNode: row.sourceNode,
      targetNode: row.targetNode,
      tierBefore: row.tierBefore,
      tierAfter: row.tierAfter,
      reasoning: row.reasoning,
      confidence: row.confidence,
      createdAt: row.createdAt,
    }));

    for (const row of dispositions) {
      if (row.edgeId === null) continue;
      if (edges.has(row.edgeId)) continue;
      const edge = graph.getEdge(row.edgeId);
      // A missing edge is not skipped silently anywhere that matters — the
      // survival report counts it as `vanished`, which is a constraint-6
      // breach. Here there is simply nothing to draw.
      if (edge !== null) edges.set(edge.id, { edge, origin: "dream" });
    }

    return {
      sessionId: session.id,
      night: session.night,
      tz: session.tz,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      outcome: session.outcome,
      error: session.error,
      tokensSpent: session.tokensSpent,
      costUsd: session.costUsd,
      turns: session.turns,
      counts: {
        candidatesProposed: session.candidatesProposed,
        candidatesJudged: session.candidatesJudged,
        edgesCreated: session.edgesCreated,
        edgesReactivated: session.edgesReactivated,
        edgesSuppressed: session.edgesSuppressed,
        nodesSuperseded: session.nodesSuperseded,
        edgesDemoted: session.edgesDemoted,
      },
      dispositions,
      surfaced: dreams.surfacedOf(session.id).map((row) => ({
        id: row.id,
        edgeId: row.edgeId,
        summary: row.summary,
        surfacedAt: row.surfacedAt,
        response: row.response,
        respondedAt: row.respondedAt,
      })),
    };
  });

  // Endpoints of everything that made it in, fetched by id — an identity
  // lookup, so a hot edge pointing at a superseded node still yields the node.
  for (const { edge } of edges.values()) {
    if (!nodes.has(edge.sourceNode)) remember(graph.getNode(edge.sourceNode));
    if (!nodes.has(edge.targetNode)) remember(graph.getNode(edge.targetNode));
  }

  const law = weights.law;
  return {
    generatedAt: instant(now),
    scope: {
      tier: "hot",
      nodeSeeds: bounds.nodeSeeds,
      edgeBudget: bounds.edgeBudget,
      nights: bounds.nights,
      seedsUsed,
      edgesReturned: edges.size,
      edgeBudgetExhausted,
      nightsReturned: nights.length,
      moreNights: sessions.hasMore,
      // `list` is newest-first with no date predicate, so an empty page here
      // means there are no sessions at all rather than none in the window.
      dreamHasEverRun: sessions.items.length > 0,
      explanation:
        `The hot region — up to ${String(bounds.nodeSeeds)} of the most recently touched hot ` +
        `nodes and their one-hop hot neighbourhoods, capped at ${String(bounds.edgeBudget)} ` +
        `edges — plus every edge the last ${String(bounds.nights)} night(s) of reflection ` +
        `touched, in whatever tier it now sits. This is NOT the whole store: dormant edges ` +
        `nothing has dreamt about recently are addressable but not drawn here.`,
    },
    law: {
      halfLifeMs: law.halfLifeMs,
      relevanceFloor: law.relevanceFloor,
      traversalCap: law.touch.traversal.cap,
      engagementCap: law.touch.engagement.cap,
    },
    nodes: [...nodes.values()].map(toNodeView),
    edges: [...edges.values()].map(({ edge, origin }) =>
      toEdgeView(edge, weights.effective(edge, now), origin),
    ),
    nights,
    superseded: graph.listNodes({ tier: "cold", limit: bounds.nodeSeeds }).map(toNodeView),
  };
}

/**
 * Write the verdict back to the dream log.
 *
 * Every row she surfaced for this edge that is still awaiting an answer. A row
 * already answered is left alone — `recordEngagement` refuses to un-answer one,
 * and an answer once given is evidence.
 *
 * @returns how many rows were answered.
 */
export function recordVerdictOnSurfaced(
  dreams: DreamLog,
  edgeId: string,
  verdict: Verdict,
): number {
  const pending = dreams.pendingSurfaced().filter((row) => row.edgeId === edgeId);
  for (const row of pending) {
    dreams.recordEngagement(row.id, verdict === "confirm" ? "engaged" : "rejected");
  }
  return pending.length;
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function createMemoryRouter(options: MemoryRouterOptions): Router {
  const { memory, idempotency, authenticate, authorize } = options;
  const clock = options.clock ?? systemClock;
  const router = Router();

  // Order is the security property, exactly as in `routes/logs.ts`: a token
  // first, then what that token is for. Reversed, a caller with no token would
  // learn what this surface requires — a fact about the service they have not
  // earned. That holds even while `authorize` requires nothing.
  router.use("/memory", authenticate, authorize);

  /**
   * The sky. The phone's read, and the only one shaped for it.
   *
   * Deliberately not `graph` with a flag: that one takes seeds, an edge budget
   * and a window of dream nights, which are instrument controls for judging the
   * inferred engine. This one takes a count of stars, because the phone has no
   * controls to turn. See `memory/constellation.ts`.
   */
  router.get("/memory/constellation", (request, response) => {
    const bounds = { stars: countParam(request, "stars", DEFAULT_STARS, MAX_STARS) };
    sendOk(response, buildConstellation(memory, bounds, clock()));
  });

  /**
   * **Her own read.** The one route on this surface Syl's credential reaches.
   *
   * Everything else here is an instrument for the Commander — seeds, edge
   * budgets, dream windows, and a verdict that moves weights inside her own
   * memory. This one is the answer to a question she asked about herself:
   * *"I can't even see the nodes. I see a summary someone else chose for me."*
   *
   * `async` is safe on Express 5, which forwards a rejected handler to
   * `onError` — the retrieval's overlap channel awaits an embedding.
   */
  router.get("/memory/recall", async (request, response) => {
    sendOk(response, await buildRecall(memory, recallBounds(request), clock()));
  });

  /**
   * **Her one write.** `syl-016.7`.
   *
   * She could read her own memory since `syl-016.1` and could not add to it,
   * so the only durable text she controlled was goals and reminders — and she
   * used a goal to smuggle an insight through the night rather than lose it.
   *
   * What this can do is bounded by `HerOwnMemory`, not by this handler being
   * careful: it creates a `memory` node and `inferred` links to entities that
   * already exist, and there is no method on that object which deletes,
   * supersedes, relabels, moves a weight or mints a person. The verdict write
   * one route down stays out of her reach.
   *
   * Idempotent like every other write in the contract. She will retry a turn
   * that timed out, and a retried thought must not become two memories — which
   * the node reuse also guards, one layer down.
   */
  router.post("/memory/remember", (request, response) => {
    // Parsed before the ledger is touched, so a malformed body does not consume
    // a key and strand the corrected retry.
    const kept = rememberBody(request.body);

    const outcome = runIdempotent<Remembered>(idempotency, request, () => {
      try {
        return {
          status: 201,
          data: memory.hers.remember({
            thought: kept.thought,
            because: kept.because,
            ...(kept.about.length === 0 ? {} : { about: kept.about }),
          }),
        };
      } catch (error) {
        if (error instanceof RememberError) {
          throw new ApiFailure("VALIDATION_FAILED", error.message, {
            details: { reason: error.kind },
          });
        }
        throw asFailure(error);
      }
    });

    sendIdempotent(response, outcome);
  });

  router.get("/memory/graph", (request, response) => {
    const bounds = {
      nodeSeeds: countParam(request, "nodes", DEFAULT_NODE_SEEDS, MAX_NODE_SEEDS),
      edgeBudget: countParam(request, "edges", DEFAULT_EDGE_BUDGET, MAX_EDGE_BUDGET),
      nights: countParam(request, "nights", DEFAULT_DREAM_NIGHTS, MAX_DREAM_NIGHTS),
    };
    sendOk(response, buildGraphView(memory, bounds, clock()));
  });

  router.get("/memory/metrics", (_request, response) => {
    sendOk(response, memory.metrics.report());
  });

  router.post("/memory/edges/:edgeId/feedback", (request, response) => {
    // Parsed before the idempotency ledger is touched: a malformed verdict must
    // not consume a key, or the client's corrected retry fails forever.
    const verdict = verdictOf(request.body);
    const edgeId = request.params["edgeId"] ?? "";

    const outcome = runIdempotent<MemoryFeedbackResult>(idempotency, request, () => {
      const edge = memory.graph.getEdge(edgeId);
      if (edge === null) {
        throw new ApiFailure("NOT_FOUND", `${edgeId} is not an edge in the memory graph.`);
      }

      const now = clock();
      const weightBefore = memory.weights.effective(edge, now);
      let updated: MemoryEdge;
      try {
        updated =
          verdict === "confirm"
            ? memory.weights.touch(edge, "engagement")
            : memory.weights.reject(edge);
      } catch (error) {
        throw asFailure(error);
      }

      let surfacedRecorded: number;
      try {
        surfacedRecorded = recordVerdictOnSurfaced(memory.dreams, edge.id, verdict);
      } catch (error) {
        throw asFailure(error);
      }

      return {
        status: 200,
        data: {
          verdict,
          edge: toEdgeView(updated, memory.weights.effective(updated, now), "hot_region"),
          weightBefore,
          weightAfter: updated.weight,
          surfacedRecorded,
        },
      };
    });

    sendIdempotent(response, outcome);
  });

  return router;
}
