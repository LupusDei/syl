import { instant } from "../services/clock.js";
import type { MemoryEdge, MemoryGraph, MemoryNode } from "./graph.js";
import type { MemoryEdgeSpecies, MemoryNodeKind, MemoryTier } from "./schema.js";
import type { EdgeWeights } from "./weights.js";

/**
 * The graph shaped for a sky, rather than for an instrument.
 *
 * ## Why this is not `buildGraphView`
 *
 * `routes/memory.ts` already assembles the graph, and it assembles it for the
 * admin: node seeds, an edge budget, a window of dream nights, the decay law's
 * parameters, the superseded pile. Those are **instrument controls**. They exist
 * so the Commander can judge whether the inferred engine is any good, and every
 * one of them is a knob he turns while looking.
 *
 * The phone wants none of them. It asks one question — *what do you know about
 * me?* — and it wants an answer it can draw: a few dozen things, each with a
 * brightness, a depth and a story about where it came from. A second, smaller
 * read is honest rather than duplicative: widening the admin's view with a
 * `?forThePhone=true` would leave one function serving two audiences whose
 * requirements differ in every row of the table in `specs/009-the-constellation/
 * spec.md`.
 *
 * ## The vocabulary, and the one word that had to be pinned down
 *
 * The spec says *"nodes are stars, edges are filaments, confidence is the
 * brightness, tiers the depth"*. Two of those are stored and two are derived,
 * and conflating them is the way this payload would go wrong:
 *
 * | drawn as | is | stored? |
 * | --- | --- | --- |
 * | position | the node's id, hashed on the device | — |
 * | depth | `tier` | stored |
 * | brightness | `confidence` | **derived** |
 * | filament | an edge | stored |
 *
 * **`confidence` here is the DECAYED weight**, and that is deliberate. The
 * project's own vocabulary uses the word that way — CLAUDE.md constraint 6 says
 * *"confidence decays toward zero asymptotically and never arrives"*, which is a
 * description of {@link EdgeWeights.effective} and of nothing else. It is also
 * the only number defined for **both** species: an observed edge has no stored
 * `confidence` at all, so a payload keyed on the stored column would hand the
 * sky a `null` for every fact the Commander stated himself, and the brightest
 * things he knows would be the ones that failed to render.
 *
 * What reflection *declared* when it drew an inference is a different number
 * that does not decay, and it is carried separately as
 * {@link FilamentView.inferredConfidence} rather than folded into the same
 * field. Two near-synonyms is a readability hazard; two numbers silently
 * averaged into one is a correctness one.
 *
 * ## A star's brightness is the strongest live thing touching it
 *
 * Nodes carry no weight of their own — only edges decay. So a star's confidence
 * is the **maximum** confidence over the filaments drawn to it. Maximum rather
 * than sum or mean, because the question a brightness answers is *how sure is
 * she about this?*, and one strong live connection is exactly that however many
 * dead ones sit beside it. A mean would let history dim a fact she is certain
 * of, which is the opposite of what decay is for.
 *
 * A star with no filaments in this view — an anchor nothing is connected to
 * yet — gets the law's `minWeight`, the same clamp that stops the asymptote
 * underflowing. It is the faintest a thing can be without being absent, which is
 * an honest rendering of "she knows this exists and nothing else about it".
 *
 * ## It is a REGION, and it says so
 *
 * The sky is bounded by a count of stars and nothing else — one knob, because
 * the phone has no controls to turn. {@link ConstellationBound} carries whether
 * the walk stopped early, so the client can never imply it holds everything.
 *
 * **There is deliberately no total.** The spec forbids a node count on the
 * screen — *"it is a dashboard statistic about the machine, and the orbs are
 * already documented as doors, not statistics"* — and a total in the payload is
 * an invitation to render one. `mayHaveMore` is the whole of what a viewer
 * needs: it answers "is this all of it?" without answering "how much is there?",
 * which is the question nobody asked.
 *
 * This file owns no SQL. Every read goes through `MemoryGraph`'s public API, for
 * the reason `routes/memory.ts` gives: a second copy of the tier-spanning
 * identity lookups is exactly where one would silently acquire a `tier`
 * predicate and start hiding the cold half of the graph.
 */

// ---------------------------------------------------------------------------
// The wire shapes
// ---------------------------------------------------------------------------

/** Where a star came from. The answer to the only question that matters. */
export interface StarProvenance {
  /**
   * How this came to be known, taken from the strongest filament touching it.
   *
   * `unattested` is not a third species of edge. It is what a star with no
   * filaments in this view is: something the graph holds and has not connected
   * to anything, so there is nothing to say about where it came from.
   */
  readonly species: MemoryEdgeSpecies | "unattested";
  /** WHO said so — the asserting node's label. `null` unless `observed`. */
  readonly assertedBy: string | null;
  /** WHY she believes it, in her words. `null` unless `inferred`. */
  readonly reasoning: string | null;
  /** When the belief behind it was last touched. `null` when `unattested`. */
  readonly learnedAt: string | null;
}

/** One thing she knows, as the sky needs it. */
export interface StarView {
  readonly id: string;
  readonly kind: MemoryNodeKind;
  /** Depth. `cold` and `suppressed` are further back, never absent. */
  readonly tier: MemoryTier;
  readonly label: string;
  /** Her own longer words about it, when there are any. */
  readonly body: string | null;
  /**
   * Brightness, in (0, 1]. The strongest live filament touching this star —
   * see this module's header for why it is a maximum and why it is decayed.
   */
  readonly confidence: number;
  readonly provenance: StarProvenance;
  /**
   * Whether the sky is built around this one.
   *
   * People and goals are the few things the Commander actually thinks in terms
   * of, so they are what the region is grown from and what the layout hangs
   * off. A flag rather than a separate array: the client draws one field of
   * stars, and a second collection would make it draw two.
   */
  readonly anchor: boolean;
  /**
   * The anchor this star orbits — a {@link StarView.id} whose `anchor` is true.
   *
   * `null` on an anchor itself, and on a star connected to no anchor at all.
   *
   * **Computed here rather than on the device**, because the honest rule needs
   * the decayed weights and the client does not have them: it is the anchor at
   * the far end of this star's *strongest live filament to an anchor*, which is
   * the same "which of these does it most belong to" question brightness
   * already answers. A client deriving it would either re-implement the decay
   * law or fall back to "the first anchor I happen to see", and the second one
   * moves a star between launches — which is the one thing the layout may never
   * do.
   *
   * Ties are broken by id, so a star equidistant between two anchors lands in
   * the same place every time rather than wherever the row order put it.
   */
  readonly anchorId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One connection, as the sky needs it. Both endpoints are always drawn. */
export interface FilamentView {
  readonly id: string;
  /** A {@link StarView.id}. Guaranteed present in `stars` — see `buildConstellation`. */
  readonly from: string;
  /** A {@link StarView.id}. Guaranteed present in `stars`. */
  readonly to: string;
  readonly relation: string;
  /** `observed` is solid, `inferred` is gossamer. Never rendered the same way. */
  readonly species: MemoryEdgeSpecies;
  readonly tier: MemoryTier;
  /** What this connection is worth NOW, in (0, 1]. Brightness. */
  readonly confidence: number;
  /**
   * How sure reflection was when it drew this, in (0, 1]. `null` on an
   * observation — a source simply said so, and that is not a degree of
   * certainty. **This does not decay**, which is what makes it a different
   * number from `confidence` rather than a copy of it.
   */
  readonly inferredConfidence: number | null;
  /** WHY. `null` on an observation. */
  readonly reasoning: string | null;
  /** WHO. `null` on an inference. */
  readonly assertedBy: string | null;
  readonly lastTouchedAt: string;
}

/** What this response is not, in numbers and in words. */
export interface ConstellationBound {
  /** The most stars this response would carry. */
  readonly stars: number;
  readonly starsReturned: number;
  readonly filamentsReturned: number;
  /**
   * Whether the walk stopped with candidates still waiting.
   *
   * Exact, not a guess: it is set at the moment a star is refused for want of
   * budget, never inferred from `starsReturned === stars`. Those differ exactly
   * when the region is a whole multiple of the budget — a view claiming to hold
   * everything at the one moment it does not, which is the small lie
   * `mayHaveEarlier` was written to refuse.
   */
  readonly mayHaveMore: boolean;
  /** What this view is, in words, so a region is never read as the whole sky. */
  readonly explanation: string;
}

/** The sky, bounded, at one instant. */
export interface ConstellationView {
  readonly generatedAt: string;
  readonly bound: ConstellationBound;
  readonly stars: readonly StarView[];
  readonly filaments: readonly FilamentView[];
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Stars in a sky nobody asked a number for.
 *
 * The spec's own ceiling: *"if more than a few dozen stars are on screen, the
 * view has failed and should be showing a region instead."* Sixty is a few
 * dozen.
 */
export const DEFAULT_STARS = 60;

/**
 * The most stars one response carries.
 *
 * Five hundred, which is `T024`'s stated performance target — *"five hundred
 * nodes without dropped frames"* — rather than a round number chosen here. A
 * bound the renderer is separately tested against is a bound that means
 * something.
 */
export const MAX_STARS = 500;

/** The kinds the sky is grown from. See {@link StarView.anchor}. */
export const ANCHOR_KINDS: readonly MemoryNodeKind[] = ["person", "goal"];

/** What `buildConstellation` reads. Injected, never constructed here. */
export interface ConstellationSources {
  readonly graph: MemoryGraph;
  /** The decay law applied to the store. Where brightness comes from. */
  readonly weights: EdgeWeights;
}

export interface ConstellationBounds {
  readonly stars: number;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * A star set, and whether anything was left out of it.
 *
 * Growing the region and reporting the bound are the same walk — the only
 * moment it is knowable that something was refused is the moment it is refused —
 * so they are returned together rather than recomputed.
 */
interface Region {
  readonly nodes: Map<string, MemoryNode>;
  readonly anchors: ReadonlySet<string>;
  readonly mayHaveMore: boolean;
}

/**
 * Grow the region: anchors first, then what orbits them, then the most
 * connected of whatever is left.
 *
 * The third step matters more than it looks. A graph with no people and no goals
 * in it yet — which is every graph on its first day — would otherwise produce an
 * empty sky while holding plenty to draw, and an empty sky is indistinguishable
 * from a broken one.
 */
function growRegion(graph: MemoryGraph, budget: number): Region {
  const nodes = new Map<string, MemoryNode>();
  const anchors = new Set<string>();
  let mayHaveMore = false;

  /** Add one node if there is room; otherwise record that there was not. */
  const admit = (node: MemoryNode): boolean => {
    if (nodes.has(node.id)) return true;
    if (nodes.size >= budget) {
      mayHaveMore = true;
      return false;
    }
    nodes.set(node.id, node);
    return true;
  };

  // -- the anchors, each with its orbit ---------------------------------------
  //
  // People and goals, most recently touched first within each kind. Listed per
  // kind rather than filtered out of one big scan: `memory_nodes_scan_idx` is
  // `(tier, kind, updated_at DESC)`, so a kind-narrowed scan is served by the
  // index, and a scan of everything followed by a filter would read the whole
  // hot partition to find two people.
  //
  // **An anchor is admitted together with what orbits it, not before every
  // other anchor.** Taking all the anchors first and their neighbours afterwards
  // spends the whole budget on a list of people and returns a sky with no
  // filaments in it at all — which is not a constellation, it is a contact list
  // rendered as dots. Growing one cluster at a time means the budget buys
  // connected regions, and running out costs a whole anchor rather than every
  // anchor's edges.
  //
  // One hop, hot only. `neighbourhood` fetches endpoints BY ID, so a hot edge
  // reaching a cold or superseded node still yields that node — which is the
  // point: a memory set aside is dimmer and further back, never absent. That is
  // constraint 6 drawn, and filtering it out here would quietly undo it.
  const anchorNodes: MemoryNode[] = [];
  for (const kind of ANCHOR_KINDS) {
    anchorNodes.push(...graph.listNodes({ tier: "hot", kind, limit: budget + 1 }));
  }
  for (const anchor of anchorNodes) {
    // `admit` has already recorded the refusal; there is no room for this
    // anchor's orbit either, so there is nothing left to walk.
    if (!admit(anchor)) break;
    anchors.add(anchor.id);
    const around = graph.neighbourhood(anchor.id, { depth: 1, tiers: ["hot"], limit: budget });
    for (const node of around.nodes) {
      if (!admit(node)) break;
    }
  }

  // -- the rest of the live region ------------------------------------------
  //
  // Ranked by how much hot edge weight touches them, so what fills the sky is
  // what she is most connected to rather than whatever was written last.
  //
  // **Run even when the region is already full**, which looks like a wasted
  // query and is the only way `mayHaveMore` can be exact. Skipping it when full
  // would leave the flag reading `false` for a graph holding plenty this sky
  // does not show — a view claiming to be everything at the one moment it is
  // not. One indexed scan is the price of not telling that lie.
  for (const node of graph.listSalientNodes(budget + 1)) {
    if (!admit(node)) break;
  }

  return { nodes, anchors, mayHaveMore };
}

/**
 * Every hot filament with BOTH ends in the region.
 *
 * Both ends, always. A filament to a star that is not drawn is a line into
 * nothing — the client would either drop it silently or draw an edge off the
 * side of the sky, and neither is a thing anyone asked for. The edge is not
 * lost: it reappears the moment its other end is in the region.
 */
function filamentsWithin(graph: MemoryGraph, nodes: ReadonlyMap<string, MemoryNode>): MemoryEdge[] {
  const found = new Map<string, MemoryEdge>();
  for (const id of nodes.keys()) {
    const around = graph.neighbourhood(id, { depth: 1, tiers: ["hot"] });
    for (const edge of around.edges) {
      if (found.has(edge.id)) continue;
      if (!nodes.has(edge.sourceNode) || !nodes.has(edge.targetNode)) continue;
      found.set(edge.id, edge);
    }
  }
  return [...found.values()];
}

/**
 * One filament, with its decayed weight resolved.
 *
 * Narrowed on `kind` rather than spread, exactly as `toEdgeView` is, so a field
 * belonging to one species cannot travel on the other by accident.
 */
function toFilament(edge: MemoryEdge, confidence: number): FilamentView {
  const common = {
    id: edge.id,
    from: edge.sourceNode,
    to: edge.targetNode,
    relation: edge.relation,
    tier: edge.tier,
    confidence,
    lastTouchedAt: edge.lastTouchedAt,
  };
  return edge.kind === "inferred"
    ? {
        ...common,
        species: "inferred",
        inferredConfidence: edge.confidence,
        reasoning: edge.reasoning,
        assertedBy: null,
      }
    : {
        ...common,
        species: "observed",
        inferredConfidence: null,
        reasoning: null,
        assertedBy: edge.assertedBy,
      };
}

/**
 * Assemble a sky.
 *
 * Pure over its injected sources and the instant it is given, so the whole of
 * the judgement in this feature is testable without a socket.
 */
export function buildConstellation(
  sources: ConstellationSources,
  bounds: ConstellationBounds,
  now: number,
): ConstellationView {
  const { graph, weights } = sources;
  const region = growRegion(graph, bounds.stars);

  const filaments = filamentsWithin(graph, region.nodes).map((edge) =>
    toFilament(edge, weights.effective(edge, now)),
  );

  // The strongest live filament touching each star, and the story that comes
  // with it. One pass: brightness and provenance are the same answer read twice.
  const strongest = new Map<string, FilamentView>();
  for (const filament of filaments) {
    for (const end of [filament.from, filament.to]) {
      const held = strongest.get(end);
      if (held === undefined || filament.confidence > held.confidence) {
        strongest.set(end, filament);
      }
    }
  }

  // Labels, so provenance reads as "settings.json" rather than as an id. An id
  // is not something anyone can have an opinion about — `memory/metrics.ts`
  // reached the same conclusion for the cold sample.
  const labelOf = (id: string): string | null => {
    const known = region.nodes.get(id);
    return (known ?? graph.getNode(id))?.label ?? null;
  };

  // Which anchor each star orbits. The strongest filament whose FAR end is an
  // anchor — see `StarView.anchorId` for why this is decided here and not on
  // the device. Ties broken by id so the answer is stable across launches.
  const orbits = new Map<string, FilamentView>();
  for (const filament of filaments) {
    for (const [near, far] of [
      [filament.from, filament.to],
      [filament.to, filament.from],
    ] as const) {
      if (!region.anchors.has(far) || region.anchors.has(near)) continue;
      const held = orbits.get(near);
      const better =
        held === undefined ||
        filament.confidence > held.confidence ||
        (filament.confidence === held.confidence && filament.id < held.id);
      if (better) orbits.set(near, filament);
    }
  }
  const anchorOf = (id: string): string | null => {
    const filament = orbits.get(id);
    if (filament === undefined) return null;
    return region.anchors.has(filament.from) ? filament.from : filament.to;
  };

  const floor = weights.law.minWeight;
  const stars: StarView[] = [...region.nodes.values()].map((node) => {
    const brightest = strongest.get(node.id);
    return {
      id: node.id,
      kind: node.kind,
      tier: node.tier,
      label: node.label,
      body: node.body,
      confidence: brightest?.confidence ?? floor,
      provenance:
        brightest === undefined
          ? { species: "unattested", assertedBy: null, reasoning: null, learnedAt: null }
          : {
              species: brightest.species,
              assertedBy:
                brightest.assertedBy === null ? null : labelOf(brightest.assertedBy),
              reasoning: brightest.reasoning,
              learnedAt: brightest.lastTouchedAt,
            },
      anchor: region.anchors.has(node.id),
      anchorId: region.anchors.has(node.id) ? null : anchorOf(node.id),
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  });

  return {
    generatedAt: instant(now),
    bound: {
      stars: bounds.stars,
      starsReturned: stars.length,
      filamentsReturned: filaments.length,
      mayHaveMore: region.mayHaveMore,
      explanation:
        `A region of the live graph: the people and goals she knows, what connects to them, ` +
        `and the most connected of what is left, up to ${String(bounds.stars)} stars. Every ` +
        `filament drawn has both ends in this region. This is NOT everything she remembers — ` +
        `memories nothing has touched recently are still held, and still addressable, and are ` +
        `simply not in this sky.`,
    },
    stars,
    filaments,
  };
}
