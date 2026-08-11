import { Router, type Request, type RequestHandler } from "express";

import {
  buildConstellation,
  DEFAULT_STARS,
  MAX_STARS,
} from "../memory/constellation.js";
import { DreamLogError, type DeclaredCounts, type DreamLog } from "../memory/dream/log.js";
import { GraphError, type MemoryEdge, type MemoryGraph, type MemoryNode } from "../memory/graph.js";
import type { MemoryMetrics } from "../memory/metrics.js";
import type { MemoryTier } from "../memory/schema.js";
import { WeightError, type EdgeWeights } from "../memory/weights.js";
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
