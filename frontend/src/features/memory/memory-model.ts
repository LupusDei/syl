/**
 * What the memory viewer decides, as pure functions and hand-written wire types.
 *
 * ## Why the types are here and not in `@syl/shared`
 *
 * `shared/openapi.yaml` has no memory operation yet — the graph landed the same
 * day this viewer did, and `backend/src/routes/memory.ts` serves the store's own
 * shape inside the standard envelope, exactly as `connections/intake-route.ts`
 * does. So these interfaces are the second opinion the contract normally
 * prevents, and they are temporary: **`syl-q9n` adds the operations to the
 * spec, after which these are deleted in favour of the generated types.** They
 * are kept in one file, named identically to the backend's, so the diff when
 * that happens is mechanical.
 *
 * ## The three things this file exists to get right
 *
 * 1. **The two species are never merged.** `observed` was asserted by a source;
 *    `inferred` is Syl's speculation. {@link edgeStyle} gives them different
 *    stroke *shapes* — not merely different colours — because colour alone fails
 *    for a colour-blind reader and fails again in a screenshot, and the whole
 *    value of this surface is the Commander being able to judge the inferred
 *    engine separately from what he was told.
 * 2. **A `null` rate is never rendered as `0%`.** `metrics.ts` makes every ratio
 *    `null` with a sentence when the denominator is zero, precisely so a surface
 *    can say why. "0% rejected" out of nothing surfaced reads as excellent news
 *    and means nothing. {@link describeRate} refuses to produce a percentage
 *    from a null.
 * 3. **`unproven` is not `holds`.** Zero breaches with zero attempts is an
 *    absence of evidence. {@link alarmPresentation} gives it its own tone, and
 *    `rejected_connection_resurrected` — a broken promise rather than a broken
 *    machine — gets its own again, and its own word.
 */

import type { Tone } from "../../ui/Badge";

// ---------------------------------------------------------------------------
// Wire types — mirroring `backend/src/routes/memory.ts`
// ---------------------------------------------------------------------------

export type MemoryTier = "hot" | "cold" | "suppressed";

/** The two species. Not variants of one thing. */
export type EdgeSpecies = "observed" | "inferred";

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

export interface MemoryEdgeView {
  readonly id: string;
  readonly kind: EdgeSpecies;
  readonly tier: MemoryTier;
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly relation: string;
  readonly storedWeight: number;
  /** What it is worth NOW. The number that gets drawn. */
  readonly effectiveWeight: number;
  readonly confidence: number | null;
  /** WHY. Non-null exactly for `inferred`. */
  readonly reasoning: string | null;
  /** WHO said so. Non-null exactly for `observed`. */
  readonly assertedBy: string | null;
  readonly demoteAfter: string | null;
  readonly lastTouchedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly origin: "hot_region" | "dream";
}

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

export interface DreamSurfacedView {
  readonly id: number;
  readonly edgeId: string | null;
  readonly summary: string;
  readonly surfacedAt: string;
  readonly response: string;
  readonly respondedAt: string | null;
}

export interface DreamCountsView {
  readonly candidatesProposed: number;
  readonly candidatesJudged: number;
  readonly edgesCreated: number;
  readonly edgesReactivated: number;
  readonly edgesSuppressed: number;
  readonly nodesSuperseded: number;
  readonly edgesDemoted: number;
}

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
  readonly counts: DreamCountsView;
  readonly dispositions: readonly DreamDispositionView[];
  readonly surfaced: readonly DreamSurfacedView[];
}

export interface MemoryScopeView {
  readonly tier: MemoryTier;
  readonly nodeSeeds: number;
  readonly edgeBudget: number;
  readonly nights: number;
  readonly seedsUsed: number;
  readonly edgesReturned: number;
  readonly edgeBudgetExhausted: boolean;
  readonly nightsReturned: number;
  readonly moreNights: boolean;
  readonly dreamHasEverRun: boolean;
  readonly explanation: string;
}

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
  readonly nights: readonly DreamNightView[];
  readonly superseded: readonly MemoryNodeView[];
}

export type Verdict = "confirm" | "reject";

export interface MemoryFeedbackResult {
  readonly verdict: Verdict;
  readonly edge: MemoryEdgeView;
  readonly weightBefore: number;
  readonly weightAfter: number;
  readonly surfacedRecorded: number;
}

// -- metrics ----------------------------------------------------------------

/** A ratio that knows the difference between zero and no idea. */
export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
  /** `null` exactly when the denominator is zero. NEVER render this as `0`. */
  readonly value: number | null;
  /** Non-null exactly when `value` is null. The sentence to show instead. */
  readonly undefinedBecause: string | null;
}

export type InvariantStatus =
  | "unproven"
  | "holds"
  | "cold_lookup_broken"
  | "rejected_connection_resurrected";

export type InvariantSeverity = "unknown" | "ok" | "critical" | "trust_failure";

export interface InvariantAlarm {
  readonly status: InvariantStatus;
  readonly severity: InvariantSeverity;
  readonly headline: string;
  readonly total: number;
  readonly byExistingTier: {
    readonly hot: number;
    readonly cold: number;
    readonly suppressed: number;
    readonly unrecorded: number;
  };
  readonly insertionsAttempted: number;
}

/** One cold edge, in a form he can actually judge. */
export interface ColdSampleEdge {
  readonly id: string;
  readonly tier: MemoryTier;
  readonly relation: string;
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly weight: number;
  readonly confidence: number | null;
  /** The justification that produced it. The only thing he can judge. */
  readonly reasoning: string;
  readonly enteredColdAt: string;
  readonly ageMs: number;
}

/** A rediscovery, in the model's own words. Evidence for demote-never-prune. */
export interface ReactivationTrigger {
  readonly edgeId: string;
  readonly night: string;
  readonly reasoning: string;
  readonly confidence: number | null;
  readonly at: string;
}

export interface ColdGrowthNight {
  readonly night: string;
  readonly demoted: number;
  readonly reactivated: number;
  readonly net: number;
}

export interface ColdShapeView {
  readonly edges: number;
  readonly inferred: number;
  readonly observed: number;
  readonly oldestEnteredAt: string | null;
  readonly oldestAgeMs: number | null;
  /**
   * `null` when nothing is cold. **Not a zero** — there is no distribution to
   * describe, which is a different statement from "everything has been down
   * there for no time".
   */
  readonly timeInCold: {
    readonly p50Ms: number;
    readonly p90Ms: number;
    readonly maxMs: number;
  } | null;
  readonly enteredBasis: string;
  readonly growthPerNight: readonly ColdGrowthNight[];
  readonly crossingRatePerNight: Rate;
}

export interface WeightBucket {
  readonly from: number;
  readonly to: number;
  readonly count: number;
  readonly hot: number;
  readonly cold: number;
  readonly suppressed: number;
}

export interface ReactivationReportView {
  readonly nights: number;
  readonly reactivated: number;
  readonly demoted: number;
  readonly rate: Rate;
  readonly triggers: readonly ReactivationTrigger[];
  readonly verdict: { readonly kind: string; readonly headline: string };
}

export interface MemoryMetricsView {
  readonly alarm: InvariantAlarm;
  readonly generatedAt: string;
  readonly store: {
    readonly nodes: { readonly total: number };
    readonly edges: {
      readonly total: number;
      readonly observed: number;
      readonly inferred: number;
      readonly active: number;
      readonly dormant: number;
      readonly suppressed: number;
    };
    readonly inferredWeights: {
      readonly buckets: readonly WeightBucket[];
      readonly total: number;
      readonly bottomHeavy: Rate;
      readonly basis: string;
    };
    readonly supersessions: number;
    readonly databaseBytes: number;
  };
  readonly survival: {
    readonly overall: Rate;
    readonly hasEvidence: boolean;
    readonly vanished: number;
  };
  readonly reactivation: ReactivationReportView;
  readonly engagement: {
    readonly surfaced: number;
    readonly answered: number;
    readonly engagedRate: Rate;
    readonly ignoredRate: Rate;
    readonly rejectedRate: Rate;
    readonly hasEvidence: boolean;
  };
  readonly cost: {
    readonly tokensSpent: number;
    readonly costUsd: number;
    readonly edgesKept: number;
    readonly tokensPerKeptEdge: Rate;
    readonly usdPerKeptEdge: Rate;
    readonly keptNothing: boolean;
    readonly understated: boolean;
  };
  /**
   * The cold-store audit: the proof that demoting an edge never became losing
   * it, plus the handful he is meant to eyeball.
   */
  readonly cold: {
    readonly alarm: InvariantAlarm;
    readonly shape: ColdShapeView;
    readonly resurrection: ReactivationReportView;
    readonly sample: readonly ColdSampleEdge[];
  };
}

// ---------------------------------------------------------------------------
// Null versus zero
// ---------------------------------------------------------------------------

export interface RateReading {
  /** False when the denominator was zero. There is no number to show. */
  readonly known: boolean;
  /** A percentage when known; the server's sentence when not. */
  readonly text: string;
  /** `null` when unknown. A bar or a dot must not be drawn from this. */
  readonly fraction: number | null;
  /** `n of m`, always safe to show — counts are real even when the ratio is not. */
  readonly counts: string;
}

/**
 * Read a {@link Rate} without inventing a zero.
 *
 * The whole reason `metrics.ts` uses `null` rather than `0` is that they render
 * identically and mean opposite things. This is the one place that difference is
 * turned into words, so no component has to remember it.
 *
 * The fallback sentence exists only for a malformed payload — the server always
 * sends `undefinedBecause` alongside a null — and says so rather than saying
 * nothing.
 */
export function describeRate(rate: Rate, digits = 0): RateReading {
  const counts = `${String(rate.numerator)} of ${String(rate.denominator)}`;
  if (rate.value === null) {
    return {
      known: false,
      fraction: null,
      counts,
      text:
        rate.undefinedBecause ??
        "there was nothing to divide by, so this is not a rate of zero — it is not a rate at all",
    };
  }
  return {
    known: true,
    fraction: rate.value,
    counts,
    text: `${(rate.value * 100).toFixed(digits)}%`,
  };
}

// ---------------------------------------------------------------------------
// The alarm
// ---------------------------------------------------------------------------

export interface AlarmPresentation {
  readonly tone: Tone;
  /** The short word. Never "OK" for `unproven`. */
  readonly label: string;
  /**
   * True only for `rejected_connection_resurrected`. Its own flag, because that
   * status is not a louder `critical` — it says a promise was broken.
   */
  readonly trustFailure: boolean;
  /** True when something is actually wrong, either bug. */
  readonly broken: boolean;
  /** Whether this may be collapsed away. A trust failure never may. */
  readonly dismissible: boolean;
  /** One line of guidance under the server's headline. */
  readonly guidance: string;
}

/**
 * How the invariant alarm should read.
 *
 * Four states, four presentations, and the mapping is total: a status added
 * later fails typecheck here rather than falling through to a green tick, which
 * is the direction this whole file leans.
 */
export function alarmPresentation(alarm: InvariantAlarm): AlarmPresentation {
  switch (alarm.status) {
    case "rejected_connection_resurrected":
      return {
        tone: "fail",
        label: "TRUST FAILURE",
        trustFailure: true,
        broken: true,
        dismissible: false,
        guidance:
          "Reflection tried to bring back a connection you explicitly rejected. This is not a " +
          "performance bug and it does not belong in an error count with the others — you said " +
          "no once, and the system handed it back.",
      };
    case "cold_lookup_broken":
      return {
        tone: "fail",
        label: "BREACHED",
        trustFailure: false,
        broken: true,
        dismissible: false,
        guidance:
          "An edge already existed for a pair and a second was inserted anyway. Dormant edges " +
          "are being duplicated instead of reactivated, so the originals keep their history " +
          "and stay invisible. Nothing below about reactivation can be trusted until this is fixed.",
      };
    case "unproven":
      return {
        // Deliberately not `ok`. Zero breaches out of zero attempts is an
        // absence of evidence, and a green tick here would be the exact lie
        // `metrics.ts` invented this status to prevent.
        tone: "pending",
        label: "UNPROVEN",
        trustFailure: false,
        broken: false,
        dismissible: false,
        guidance:
          "No dream has ever inserted an edge, so the cold identity lookup has never been " +
          "exercised. This is not a passing check — it is no evidence either way.",
      };
    default:
      return {
        tone: "ok",
        label: "HOLDS",
        trustFailure: false,
        broken: false,
        dismissible: true,
        guidance:
          `${String(alarm.insertionsAttempted)} edge insertion(s) across every dream, and not ` +
          "one pair duplicated. Cold and suppressed edges are being found.",
      };
  }
}

/** Whether the alarm must be shown at the top of the view, above everything. */
export function alarmIsUnmissable(alarm: InvariantAlarm): boolean {
  return !alarmPresentation(alarm).dismissible;
}

// ---------------------------------------------------------------------------
// The two species, made visually unmistakable
// ---------------------------------------------------------------------------

/** Everything a renderer needs to draw one edge. No colours — only tokens. */
export interface EdgeStyle {
  /** `null` for a solid line. A dash pattern otherwise. */
  readonly dash: string | null;
  readonly strokeWidth: number;
  readonly opacity: number;
  /** A semantic token name, resolved by the caller against `theme/tokens`. */
  readonly tone: Tone;
  /** The one-word species label, for the legend and the accessible name. */
  readonly species: EdgeSpecies;
  /** True when this edge is below the relevance floor and on its way out. */
  readonly belowFloor: boolean;
}

/** The thinnest a line may be drawn and still be seen. */
export const MIN_STROKE = 1;
/** The thickest. Beyond this, a strong edge stops reading as a line. */
export const MAX_STROKE = 6;
/** The faintest a line may be drawn and still be noticed. */
export const MIN_OPACITY = 0.18;

/**
 * How one edge should look.
 *
 * **Species decides the stroke SHAPE, weight decides its presence.** That split
 * is the requirement: an observed edge is solid because a source asserted it,
 * an inferred edge is dashed because it is a guess, and no amount of decay ever
 * turns one into the other. Weight then rides on width and opacity together, so
 * the decay curve is something to look at rather than something to query — a
 * near-floor edge is a thin ghost and a confirmed one is a solid rope.
 *
 * A suppressed edge keeps its species and goes muted: he said no, and the record
 * of having said no is worth seeing.
 */
export function edgeStyle(edge: MemoryEdgeView, law: WeightLawView): EdgeStyle {
  const weight = Math.min(1, Math.max(0, edge.effectiveWeight));
  const inferred = edge.kind === "inferred";
  return {
    // Two clearly different dash rhythms would be confusable; solid versus
    // dashed is not.
    dash: inferred ? "6 4" : null,
    strokeWidth: MIN_STROKE + (MAX_STROKE - MIN_STROKE) * weight,
    opacity: MIN_OPACITY + (1 - MIN_OPACITY) * weight,
    tone: edge.tier === "suppressed" ? "muted" : inferred ? "pending" : "accent",
    species: edge.kind,
    belowFloor: weight < law.relevanceFloor,
  };
}

/** The one-line English for a species, used in the legend and in each row. */
export function describeSpecies(species: EdgeSpecies): string {
  return species === "observed"
    ? "Observed — a source asserted this. Solid."
    : "Inferred — Syl's own speculation. Dashed.";
}

/** How a tier reads in a chip. */
export function tierTone(tier: MemoryTier): Tone {
  switch (tier) {
    case "hot":
      return "ok";
    case "cold":
      return "muted";
    default:
      return "fail";
  }
}

/** What a tier means, in words, because "cold" is not self-explanatory. */
export function describeTier(tier: MemoryTier): string {
  switch (tier) {
    case "hot":
      return "live — in the scan, earning its place";
    case "cold":
      return "dormant — below the floor, never deleted, promotable on contact";
    default:
      return "suppressed — you rejected it; nothing brings it back implicitly";
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface LayoutOptions {
  readonly width?: number;
  readonly height?: number;
}

export const DEFAULT_LAYOUT_WIDTH = 1000;
export const DEFAULT_LAYOUT_HEIGHT = 620;

/** How many nodes go on the innermost ring before a second one is started. */
const FIRST_RING = 6;

/**
 * Where each node sits, deterministically.
 *
 * No force simulation, on purpose. A force layout moves every node whenever any
 * node changes, so the same graph looks different on every reload and an edge he
 * was mid-way through judging jumps out from under the cursor. This is a
 * ranked concentric layout instead: **the busiest nodes go in the middle**,
 * ordered by degree and then by id, so the picture is stable across reloads and
 * across a confirm or a reject that changes only one edge.
 *
 * Ties break on id rather than on array order, so the server returning the same
 * nodes in a different order cannot reshuffle the drawing.
 */
export function layoutNodes(
  nodes: readonly MemoryNodeView[],
  edges: readonly MemoryEdgeView[],
  options: LayoutOptions = {},
): ReadonlyMap<string, Point> {
  const width = options.width ?? DEFAULT_LAYOUT_WIDTH;
  const height = options.height ?? DEFAULT_LAYOUT_HEIGHT;
  const centre = { x: width / 2, y: height / 2 };
  const placed = new Map<string, Point>();
  if (nodes.length === 0) return placed;

  const degree = new Map<string, number>();
  for (const node of nodes) degree.set(node.id, 0);
  for (const edge of edges) {
    if (degree.has(edge.sourceNode)) degree.set(edge.sourceNode, (degree.get(edge.sourceNode) ?? 0) + 1);
    if (degree.has(edge.targetNode)) degree.set(edge.targetNode, (degree.get(edge.targetNode) ?? 0) + 1);
  }

  const ranked = [...nodes].sort((left, right) => {
    const byDegree = (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0);
    return byDegree === 0 ? left.id.localeCompare(right.id) : byDegree;
  });

  if (ranked.length === 1) {
    // Safe: length checked.
    placed.set((ranked[0] as MemoryNodeView).id, centre);
    return placed;
  }

  // Rings grow so the outer ones do not crowd: 6, 12, 18, …
  const rings: MemoryNodeView[][] = [];
  let index = 0;
  for (let ring = 0; index < ranked.length; ring += 1) {
    const capacity = FIRST_RING * (ring + 1);
    rings.push(ranked.slice(index, index + capacity));
    index += capacity;
  }

  const margin = 60;
  const maxRadius = Math.min(width, height) / 2 - margin;
  rings.forEach((members, ring) => {
    const radius = rings.length === 1 ? maxRadius * 0.62 : (maxRadius * (ring + 1)) / rings.length;
    members.forEach((node, position) => {
      // Rotated a quarter turn so the first node sits at the top rather than at
      // three o'clock, which reads as the start of a list.
      const angle = (2 * Math.PI * position) / members.length - Math.PI / 2;
      placed.set(node.id, {
        x: centre.x + radius * Math.cos(angle),
        y: centre.y + radius * Math.sin(angle),
      });
    });
  });

  return placed;
}

// ---------------------------------------------------------------------------
// The empty state
// ---------------------------------------------------------------------------

/**
 * Which "nothing here" this is.
 *
 * Nothing has run yet, so this is the state he will actually see first, and
 * **"no data" must not look like "broken"**. The three cases are genuinely
 * different and only one of them is worth worrying about.
 */
export type EmptyReason =
  /** Rows exist. Not empty at all. */
  | "not_empty"
  /** No dream has ever executed. Expected today; nothing is wrong. */
  | "no_dream_yet"
  /** Dreams have run and the hot region is still empty. Worth a look. */
  | "dreams_ran_but_graph_empty"
  /** Nights ran inside the window and produced no edges. */
  | "window_quiet";

export interface EmptyState {
  readonly reason: EmptyReason;
  readonly headline: string;
  readonly body: string;
}

export function emptyStateOf(view: MemoryGraphView): EmptyState {
  if (view.edges.length > 0 || view.nodes.length > 0) {
    return { reason: "not_empty", headline: "", body: "" };
  }
  if (!view.scope.dreamHasEverRun) {
    return {
      reason: "no_dream_yet",
      headline: "Nothing here yet, and nothing is wrong.",
      body:
        "No dream has ever run, so the graph has no inferred edges and the hot region is empty. " +
        "This panel is wired to the real store — it is reporting an empty store, not a failed " +
        "request. The first night of reflection is what fills it.",
    };
  }
  if (view.scope.nightsReturned > 0) {
    return {
      reason: "window_quiet",
      headline: "The last nights ran and left nothing in the hot region.",
      body:
        "Reflection has executed, but nothing it produced is above the relevance floor and no " +
        "node has been touched recently enough to seed the walk. Widen the window, or look at " +
        "the metrics below for whether anything survived at all.",
    };
  }
  return {
    reason: "dreams_ran_but_graph_empty",
    headline: "Reflection has run before, but not inside this window, and the graph is empty.",
    body:
      "The hot region has no nodes. Either everything has decayed below the floor, or writes " +
      "are not reaching the graph. The survival rate in the metrics below tells the two apart.",
  };
}

// ---------------------------------------------------------------------------
// The cold sample
// ---------------------------------------------------------------------------

/**
 * Why the handful of cold edges is empty, when it is.
 *
 * **An empty sample is not the same as "nothing is down there."** Early on there
 * will be no cold edges because nothing has decayed yet, not because the store
 * is clean — and those two read identically as a blank panel. The Commander's
 * worry is specifically that an edge drops below the floor and is then outside
 * the partition key, so it might never again be accessible; a panel that says
 * "no dormant edges" when the real answer is "nothing has had time to decay"
 * answers a question he did not ask.
 */
export type ColdSampleReason =
  /** There are edges to eyeball. */
  | "has_sample"
  /** Nothing has crossed the floor yet. Expected early; says nothing about health. */
  | "nothing_cold_yet"
  /** Cold edges exist, and every one is an observation — nothing to judge. */
  | "only_observed_cold"
  /** Inferred edges are cold and none came back. That is a bug in the audit. */
  | "sample_missing";

export interface ColdSampleState {
  readonly reason: ColdSampleReason;
  readonly headline: string;
  readonly body: string;
}

export function coldSampleStateOf(
  shape: ColdShapeView,
  sample: readonly ColdSampleEdge[],
): ColdSampleState {
  if (sample.length > 0) {
    return { reason: "has_sample", headline: "", body: "" };
  }
  if (shape.edges === 0) {
    return {
      reason: "nothing_cold_yet",
      headline: "Nothing has crossed the relevance floor yet.",
      body:
        "This is not a clean store — it is an early one. No edge has been dormant long enough to " +
        "decay below the floor, so there is nothing down there to look at, and nothing here says " +
        "whether demoting will ever lose anything. Come back once the sweep has run a few times.",
    };
  }
  if (shape.inferred === 0) {
    return {
      reason: "only_observed_cold",
      headline: `${String(shape.edges)} edge(s) are dormant, and every one is an observation.`,
      body:
        "The sample is inferences only, because an observation carries no reasoning and reasoning " +
        "is the thing being judged. There is nothing down there for you to have an opinion about " +
        "yet — but the dormant set is not empty, so the machinery is moving.",
    };
  }
  return {
    reason: "sample_missing",
    headline: `${String(shape.inferred)} inferred edge(s) are dormant and the audit returned none of them.`,
    body:
      "That should not happen: the sample is drawn from exactly this set. Treat it as a fault in " +
      "the audit rather than as evidence that the cold store is empty — the numbers beside it " +
      "say it is not.",
  };
}

// ---------------------------------------------------------------------------
// Small readings
// ---------------------------------------------------------------------------

/** A weight as a two-decimal string. Never rounded to `0`, which reads as gone. */
export function formatWeight(weight: number): string {
  if (weight > 0 && weight < 0.01) return "<0.01";
  return weight.toFixed(2);
}

/** Sort edges so the ones most worth judging come first. */
export function rankEdges(edges: readonly MemoryEdgeView[]): readonly MemoryEdgeView[] {
  return [...edges].sort((left, right) => {
    // Inference first: it is the thing under judgement. Then heaviest first,
    // because a strong wrong guess costs more than a weak one.
    if (left.kind !== right.kind) return left.kind === "inferred" ? -1 : 1;
    const byWeight = right.effectiveWeight - left.effectiveWeight;
    return byWeight === 0 ? left.id.localeCompare(right.id) : byWeight;
  });
}
