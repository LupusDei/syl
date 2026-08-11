import { instant, systemClock, type Clock } from "../services/clock.js";
import type { Database } from "../services/sqlite.js";
import { nightOf, type MemoryTier } from "./dream/log.js";
import type { MemoryNodeKind } from "./schema.js";

/**
 * The memory system's instrument panel: is any of this working?
 *
 * ## Why this is a DERIVED VIEW and not a set of counters
 *
 * Every number here is computed from rows at read time. Nothing in this file
 * writes anything, and no counter is incremented anywhere on the write path to
 * feed it. That is a deliberate call, on the Commander's instruction:
 *
 *   - A counter drifts. The moment one write path forgets to bump it, the
 *     number is wrong and stays wrong, and it is wrong in the direction of
 *     looking fine.
 *   - A counter cannot be recomputed after a bug. A derived view can — fix the
 *     query, and three months of history answer correctly.
 *   - A counter can only answer the question somebody thought to ask in
 *     advance. The interesting question about a memory system is always the one
 *     nobody had thought of yet.
 *
 * The cost is that a read is a handful of aggregate queries rather than a
 * lookup. This is a panel a human opens, not a hot path.
 *
 * ## THE DREAM LOG IS NOT MEMORY, AND THIS MODULE DOES NOT CHANGE THAT
 *
 * Constraint 7. The log is telemetry *about* the graph, and writing it into the
 * graph would have Syl dreaming about her own dreams. This module reads BOTH
 * stores and joins across them — `dream_edge_reasoning.edge_id` against
 * `memory_edges.id`, which is exactly the "opaque TEXT, no foreign key" seam
 * `0013_dream_log.sql` describes. A read-only join is not a coupling: it
 * creates no reference, no cascade and no write, and the two migrations remain
 * independent files. **There is no method here that writes.** If one is ever
 * added, that is the moment the separation is at risk, and it should be
 * refused rather than reviewed.
 *
 * ## What the Commander asked for
 *
 * Not "how many edges exist" — that is easy and nearly worthless. He asked
 * *how relevant the inferred engine actually is*, which decides what gets
 * measured:
 *
 *   - {@link MemoryMetrics.survival} — of what a night created, what is still
 *     above the floor. Insight versus noise, in one number.
 *   - {@link MemoryMetrics.reactivation} — how often the sweep rediscovers a
 *     dormant edge. The direct evidence for demote-never-prune, and he asked to
 *     be told plainly if it is buying nothing.
 *   - {@link MemoryMetrics.engagement} — what he did about what she showed him.
 *   - {@link MemoryMetrics.costPerKeptEdge} — the honest answer to "is a
 *     six-hour dream worth six hours".
 *   - {@link MemoryMetrics.coldStoreAudit} — the proof that demoting never
 *     became losing.
 *
 * ## NO METRIC HERE IS ALLOWED TO DEGRADE INTO A MEANINGLESS ZERO
 *
 * This is the failure mode a panel like this dies of. "0% of surfaced
 * connections were rejected" is excellent news if a hundred were surfaced and
 * says nothing at all if none were, and the two render identically. Every
 * ratio therefore goes through {@link Rate}, whose value is `null` — never
 * zero — when there is nothing to divide, carrying the reason in words. Every
 * verdict has an explicit "not enough evidence" branch, and the invariant alarm
 * has a status (`unproven`) that exists solely so an untested invariant cannot
 * be read as a proven one.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a metric cannot be computed as asked. */
export class MetricsError extends Error {
  readonly kind: "bad_count" | "bad_window" | "bad_limit";

  constructor(kind: MetricsError["kind"], message: string) {
    super(message);
    this.name = "MetricsError";
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Rate — the one place the meaningless zero is prevented
// ---------------------------------------------------------------------------

/**
 * A ratio that knows the difference between "zero" and "no idea".
 *
 * `value` is `null`, never `0`, when the denominator is zero, and
 * `undefinedBecause` says in words why — so a surface can render the sentence
 * rather than a misleading `0%`.
 */
export interface Rate {
  /** May be an amount (tokens, dollars) as well as a count. */
  readonly numerator: number;
  /** Always a count. */
  readonly denominator: number;
  /** `null` exactly when the denominator is zero. */
  readonly value: number | null;
  /** Non-null exactly when `value` is null. */
  readonly undefinedBecause: string | null;
}

/**
 * Build a {@link Rate}.
 *
 * @param whyUndefined what to say when there is nothing to divide. Required,
 * because the whole point is that the absent case is explained rather than
 * rendered as zero.
 * @throws {MetricsError} on a negative numerator or a denominator that is not a
 * whole count — both of which would publish nonsense as a percentage.
 */
export function rateOf(numerator: number, denominator: number, whyUndefined: string): Rate {
  if (!Number.isFinite(numerator) || numerator < 0) {
    throw new MetricsError(
      "bad_count",
      `A rate's numerator must be a finite, non-negative amount, got ${String(numerator)}.`,
    );
  }
  if (!Number.isInteger(denominator) || denominator < 0) {
    throw new MetricsError(
      "bad_count",
      `A rate's denominator is a count of things, so it must be a non-negative whole number, ` +
        `got ${String(denominator)}.`,
    );
  }
  if (denominator === 0) {
    return { numerator, denominator, value: null, undefinedBecause: whyUndefined };
  }
  return { numerator, denominator, value: numerator / denominator, undefinedBecause: null };
}

// ---------------------------------------------------------------------------
// The store's shape
// ---------------------------------------------------------------------------

/** One tenth of the weight range, and how many inferred edges sit in it. */
export interface WeightBucket {
  /** Inclusive. */
  readonly from: number;
  /** Exclusive, except for the top bucket which includes 1.0. */
  readonly to: number;
  readonly count: number;
  readonly hot: number;
  readonly cold: number;
  readonly suppressed: number;
}

/**
 * The distribution of inferred-edge weight.
 *
 * **The shape of this histogram is the health of the whole engine.** Mass piled
 * in the bottom bucket means the dream is generating connections that nothing
 * ever confirms — noise being manufactured nightly and then quietly demoted.
 */
export interface WeightHistogram {
  readonly buckets: readonly WeightBucket[];
  readonly total: number;
  /**
   * The share sitting in the bottom tenth. `null` when there are no inferred
   * edges at all: an empty store is not a healthy one.
   */
  readonly bottomHeavy: Rate;
  /**
   * `stored` — the weight as last written. The DECAYED value is a pure function
   * of this and `last_touched_at`, and the law that computes it belongs to
   * `syl-005.3.2` (`backend/src/memory/weights.ts`). Once that lands this
   * should become `decayed`, which is a strictly better picture: a graph full
   * of edges written at 0.9 six months ago looks healthy here and is not.
   */
  readonly basis: "stored";
}

export interface NodeKindCount {
  readonly tier: MemoryTier;
  readonly kind: MemoryNodeKind;
  readonly count: number;
}

export interface StoreShape {
  readonly nodes: {
    readonly total: number;
    readonly byTier: Readonly<Record<MemoryTier, number>>;
    readonly byKind: readonly NodeKindCount[];
  };
  readonly edges: {
    readonly total: number;
    readonly observed: number;
    readonly inferred: number;
    readonly byTier: Readonly<Record<MemoryTier, number>>;
    /** Hot inferred: in the scan, earning its place. */
    readonly active: number;
    /** Cold inferred: dormant, addressable, never scanned. */
    readonly dormant: number;
    /** Suppressed inferred: he said no. Never promoted back automatically. */
    readonly suppressed: number;
  };
  readonly inferredWeights: WeightHistogram;
  /** Nodes superseded to date, as the dream itself declared. */
  readonly supersessions: number;
  /**
   * The whole database file, not the memory tables alone — SQLite will not tell
   * us the second without the `dbstat` module, and a figure that is honest
   * about being an over-estimate beats one that quietly is not.
   */
  readonly databaseBytes: number;
}

// ---------------------------------------------------------------------------
// Survival
// ---------------------------------------------------------------------------

/**
 * How "still above the relevance floor" is decided.
 *
 * `scheduled_crossing` reads `tier = 'hot'` **and** a crossing instant that has
 * not passed. The tier stamp alone would be wrong between the moment an edge
 * crosses the floor and the moment the nightly sweep gets round to moving it —
 * a window of up to a day in which a dead edge counts as alive, which flatters
 * exactly the number this metric exists to be honest about.
 */
export type SurvivalBasis = "scheduled_crossing";

export interface SurvivalCohort {
  readonly night: string;
  readonly nightsAgo: number;
  readonly created: number;
  /** Still hot, and not yet due to cross. */
  readonly surviving: number;
  /** Past its crossing instant but still stamped hot: the sweep has not run. */
  readonly crossedUnswept: number;
  readonly demoted: number;
  readonly suppressed: number;
  /** Gone from the graph entirely. For an inference this is a constraint-6 breach. */
  readonly missing: number;
  readonly rate: Rate;
}

export interface SurvivalReport {
  /** Newest night first. */
  readonly cohorts: readonly SurvivalCohort[];
  readonly overall: Rate;
  readonly basis: SurvivalBasis;
  readonly hasEvidence: boolean;
  /**
   * Inferred edges the log says were created and the graph no longer holds.
   * **Must be zero.** Constraint 6 says an inference is never deleted.
   */
  readonly vanished: number;
}

export interface SurvivalOptions {
  /** How many nights back to report. Every night when omitted. */
  readonly nights?: number;
}

// ---------------------------------------------------------------------------
// Reactivation
// ---------------------------------------------------------------------------

export interface ReactivationTrigger {
  readonly edgeId: string;
  readonly night: string;
  readonly reasoning: string;
  readonly confidence: number | null;
  readonly at: string;
}

export interface ReactivationNight {
  readonly night: string;
  readonly reactivated: number;
  readonly demoted: number;
}

/**
 * The plain answer the Commander asked for.
 *
 * He overruled the prune recommendation and chose demote-never-prune. He also
 * asked to be told, plainly, if that turns out to have bought nothing. This is
 * that sentence, and `reactivation_may_be_broken` is why the invariant alarm
 * exists: "nothing deserved reactivation" and "reactivation is broken" produce
 * the same zero, and only the duplicate counter separates them.
 */
export type ReactivationVerdict =
  | { readonly kind: "no_dreams_yet"; readonly headline: string }
  | { readonly kind: "nothing_demoted_yet"; readonly headline: string }
  | {
      readonly kind: "reactivation_may_be_broken";
      readonly breaches: number;
      readonly headline: string;
    }
  | {
      readonly kind: "too_early";
      readonly nights: number;
      readonly needed: number;
      readonly headline: string;
    }
  | {
      readonly kind: "never_reactivated";
      readonly nights: number;
      readonly demoted: number;
      readonly headline: string;
    }
  | { readonly kind: "reactivation_happens"; readonly reactivated: number; readonly headline: string };

export interface ReactivationReport {
  /** Nights that actually ran a session. */
  readonly nights: number;
  readonly reactivated: number;
  readonly demoted: number;
  /** Rediscoveries per demotion. */
  readonly rate: Rate;
  /** Newest night first. */
  readonly perNight: readonly ReactivationNight[];
  /** The most recent rediscoveries, in the model's own words. */
  readonly triggers: readonly ReactivationTrigger[];
  readonly verdict: ReactivationVerdict;
}

/**
 * How many nights of demotions with no rediscovery before the verdict is
 * "never". Two months: long enough that "it just has not happened yet" stops
 * being the likelier explanation.
 */
export const REACTIVATION_VERDICT_NIGHTS = 60;

/** How many triggers to carry back. Enough to read; not a transcript. */
export const DEFAULT_TRIGGER_LIMIT = 20;

// ---------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------

/**
 * How long a surfaced connection may sit unanswered before silence counts as
 * disinterest.
 *
 * Without this, "ignored" is unmeasurable: nothing ever moves a `pending` row,
 * so the master plan's §9 rule — a class of connection he consistently ignores
 * is data saying stop generating it — could never fire. Ageing it out in the
 * derived view rather than by a sweep that rewrites rows is the same principle
 * as the rest of this file: the rows stay as they happened, and the reading of
 * them is a query that can be changed.
 */
export const IGNORED_AFTER_MS = 7 * 24 * 60 * 60_000;

export interface RelationEngagement {
  /** `null` for a synthesis over several edges, which has no single relation. */
  readonly relation: string | null;
  readonly surfaced: number;
  readonly answered: number;
  readonly engaged: number;
  readonly ignored: number;
  readonly rejected: number;
  readonly engagedRate: Rate;
}

export interface EngagementReport {
  readonly surfaced: number;
  readonly engaged: number;
  readonly ignored: number;
  readonly rejected: number;
  readonly pending: number;
  /** Surfaced minus still-pending. The only honest denominator for a rate. */
  readonly answered: number;
  /** How many of `ignored` were inferred from silence rather than stated. */
  readonly agedIntoIgnored: number;
  readonly engagedRate: Rate;
  readonly ignoredRate: Rate;
  readonly rejectedRate: Rate;
  readonly byRelation: readonly RelationEngagement[];
  readonly hasEvidence: boolean;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export interface CostNight {
  readonly night: string;
  readonly tokensSpent: number;
  readonly costUsd: number;
  readonly edgesCreated: number;
  readonly edgesKept: number;
  readonly tokensPerKeptEdge: Rate;
}

export interface CostReport {
  readonly tokensSpent: number;
  readonly costUsd: number;
  readonly edgesCreated: number;
  readonly edgesKept: number;
  readonly tokensPerKeptEdge: Rate;
  readonly usdPerKeptEdge: Rate;
  /** Newest night first. */
  readonly perNight: readonly CostNight[];
  /**
   * True when the dream spent something and kept nothing. The rate is `null`
   * in that case and this flag is what stops that reading as "free".
   */
  readonly keptNothing: boolean;
  /**
   * True when any turn was killed by the ten-minute timeout. Such a turn never
   * produced a result frame, so its usage is unobservable and counts as zero —
   * every figure here is therefore a FLOOR.
   */
  readonly understated: boolean;
  readonly timedOutTurns: number;
}

// ---------------------------------------------------------------------------
// The cold-store audit — syl-005.6.4
// ---------------------------------------------------------------------------

/** One breach of the zero invariant, as the log recorded it. */
export interface InvariantBreach {
  readonly id: number;
  readonly sessionId: string;
  readonly night: string;
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly existingEdgeId: string;
  readonly existingTier: MemoryTier | null;
  readonly insertedEdgeId: string | null;
  readonly detectedAt: string;
  readonly note: string | null;
}

/**
 * What the alarm says, and there is deliberately no single "breached" bucket.
 *
 * The three `existing_tier` values are three different bugs, and a consumer
 * switching on this type cannot collapse them by accident:
 *
 *   - `unproven` — no dream has ever attempted an edge insertion, so zero
 *     breaches proves nothing. This exists because "0" would otherwise be
 *     indistinguishable from a proven-healthy system, which is the exact
 *     failure this whole module is written against.
 *   - `holds` — dreams have run, edges have been inserted, and no pair was ever
 *     duplicated. The invariant is doing its job.
 *   - `cold_lookup_broken` — an edge already existed in the `cold` (or `hot`)
 *     partition and a second one was inserted anyway. Dormant edges are being
 *     silently duplicated instead of reactivated: the original keeps its
 *     accumulated history and its reasoning and stays invisible forever.
 *   - `rejected_connection_resurrected` — **categorically worse, and not a
 *     performance bug.** Reflection tried to bring back a connection the
 *     Commander explicitly REJECTED. He said no once; the system does not get
 *     to quietly hand it back.
 */
export type InvariantStatus =
  | "unproven"
  | "holds"
  | "cold_lookup_broken"
  | "rejected_connection_resurrected";

/**
 * Severity, as a separate word from the status on purpose.
 *
 * `trust_failure` is not a louder `critical`. One says the machinery is wrong;
 * the other says we broke a promise to him.
 */
export type InvariantSeverity = "unknown" | "ok" | "critical" | "trust_failure";

/**
 * THE SINGLE MOST IMPORTANT NUMBER IN THE WHOLE OBSERVABILITY SURFACE.
 *
 * It is the one that distinguishes "nothing deserved reactivation" from
 * "reactivation is broken" — otherwise identical from outside.
 */
export interface InvariantAlarm {
  readonly status: InvariantStatus;
  readonly severity: InvariantSeverity;
  /** One sentence, written to be read aloud. Always names the worst thing found. */
  readonly headline: string;
  readonly total: number;
  readonly byExistingTier: {
    readonly hot: number;
    readonly cold: number;
    readonly suppressed: number;
    readonly unrecorded: number;
  };
  /**
   * Breaches where the existing edge was SUPPRESSED, in their own field rather
   * than as a filter over `all` that a caller has to remember to apply.
   */
  readonly suppressedResurrections: readonly InvariantBreach[];
  /** Breaches where the existing edge was cold: the partition-blind lookup. */
  readonly coldLookupFailures: readonly InvariantBreach[];
  /** Breaches where the existing edge was HOT: the check is broken outright. */
  readonly brokenOutright: readonly InvariantBreach[];
  readonly all: readonly InvariantBreach[];
  /** How many edge insertions the dream has attempted. Zero means `unproven`. */
  readonly insertionsAttempted: number;
  /**
   * `memory_edges_identity_idx` is UNIQUE on `(source_node, target_node,
   * relation)` and does not mention `tier`, so the store itself refuses a
   * duplicate across every partition. A breach therefore cannot appear in the
   * graph — it can only appear here, recorded by the sweep that caught the
   * refusal. **Silence is not proof: a sweep that swallows the constraint
   * violation produces exactly the same zero.**
   */
  readonly storeEnforced: true;
}

/** Whether the invariant is broken at all — either bug. */
export function isInvariantBroken(alarm: InvariantAlarm): boolean {
  return alarm.status === "cold_lookup_broken" || alarm.status === "rejected_connection_resurrected";
}

/**
 * Whether reflection tried to resurrect something he explicitly rejected.
 *
 * Its own predicate, so no call site has to remember that one of the three
 * tiers means something categorically different from the other two.
 */
export function isTrustFailure(alarm: InvariantAlarm): boolean {
  return alarm.status === "rejected_connection_resurrected";
}

/** How the instant an edge entered the cold partition is known. */
export type ColdEntryBasis = "moved_at";

export interface ColdGrowthNight {
  readonly night: string;
  readonly demoted: number;
  readonly reactivated: number;
  /** Demotions minus rediscoveries: how much bigger the cold set got. */
  readonly net: number;
}

export interface ColdShape {
  readonly edges: number;
  readonly inferred: number;
  readonly observed: number;
  readonly oldestEnteredAt: string | null;
  readonly oldestAgeMs: number | null;
  /** `null` when nothing is cold. Not a zero — there is no distribution. */
  readonly timeInCold: { readonly p50Ms: number; readonly p90Ms: number; readonly maxMs: number } | null;
  /**
   * `moved_at` — `memory_edges.updated_at`, which for a cold row is exactly the
   * instant the move wrote it. This is EXACT rather than a proxy only because
   * nothing in `MemoryGraph` updates a cold edge in place: the only writes that
   * reach one are `promote` and `suppress`, and both change the tier. A future
   * writer that touches a cold row without moving it would silently turn this
   * into an under-estimate of time in cold, so the assumption is named here and
   * pinned by a test.
   */
  readonly enteredBasis: ColdEntryBasis;
  /** Newest night first. */
  readonly growthPerNight: readonly ColdGrowthNight[];
  /** Edges crossing the floor per night that ran. */
  readonly crossingRatePerNight: Rate;
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
  readonly reasoning: string;
  readonly enteredColdAt: string;
  readonly ageMs: number;
}

export interface ColdStoreAudit {
  readonly alarm: InvariantAlarm;
  readonly shape: ColdShape;
  /** Cold-to-hot promotions, with what triggered each. Evidence FOR his call. */
  readonly resurrection: ReactivationReport;
  /**
   * A handful he can eyeball. Metrics say whether the machinery works; only he
   * can say whether anything valuable is down there, and no aggregate will
   * reveal a floor set too aggressively.
   */
  readonly sample: readonly ColdSampleEdge[];
}

/** How many cold edges the audit carries by default. A handful, as asked. */
export const DEFAULT_COLD_SAMPLE = 5;

// ---------------------------------------------------------------------------
// The whole panel
// ---------------------------------------------------------------------------

export interface MemoryMetricsReport {
  /**
   * First, because it is the number that matters most and a panel that buries
   * it has failed at the one job it had.
   */
  readonly alarm: InvariantAlarm;
  readonly generatedAt: string;
  readonly store: StoreShape;
  readonly survival: SurvivalReport;
  readonly reactivation: ReactivationReport;
  readonly engagement: EngagementReport;
  readonly cost: CostReport;
  readonly cold: ColdStoreAudit;
}

export interface MemoryMetricsOptions {
  readonly db: Database;
  readonly clock?: Clock;
  /**
   * Where the cold sample's randomness comes from. Injectable so the sample is
   * a testable function rather than a thing you can only squint at.
   */
  readonly random?: () => number;
}

// ---------------------------------------------------------------------------
// Row shapes and small helpers
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60_000;

function zeroTiers(): Record<MemoryTier, number> {
  return { hot: 0, cold: 0, suppressed: 0 };
}

/** `YYYY-MM-DD` to epoch milliseconds at UTC midnight. */
function nightToMs(night: string): number {
  return Date.parse(`${night}T00:00:00.000Z`);
}

function requireWholeCount(value: number, kind: MetricsError["kind"], what: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new MetricsError(kind, `${what} must be a whole number of at least 1, got ${String(value)}.`);
  }
  return value;
}

function percentileAge(nowMs: number, sortedNewestFirst: readonly string[], quantile: number): number {
  // Ages ascending is entry-instants descending, so the q-th percentile age is
  // simply an index into the newest-first list.
  const index = Math.floor(quantile * (sortedNewestFirst.length - 1));
  const at = sortedNewestFirst[Math.max(0, index)];
  return at === undefined ? 0 : nowMs - Date.parse(at);
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/**
 * A read-only derived view over the memory graph and the dream log.
 *
 * Nothing here writes. See the module header for why that is structural rather
 * than incidental.
 */
export class MemoryMetrics {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #random: () => number;

  constructor(options: MemoryMetricsOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
  }

  // -- the state of the store ----------------------------------------------

  /**
   * Node and edge counts, the weight distribution, and the size of it all.
   *
   * The easy half of the mandate, and the least interesting: it says how big
   * the graph is, not whether any of it is worth having. The one number here
   * that carries real signal is {@link WeightHistogram.bottomHeavy}.
   */
  storeShape(): StoreShape {
    const nodeRows = this.#all<{ tier: MemoryTier; kind: MemoryNodeKind; c: number }>(
      "SELECT tier, kind, COUNT(*) AS c FROM memory_nodes GROUP BY tier, kind ORDER BY tier, kind",
    );
    const nodesByTier = zeroTiers();
    let nodeTotal = 0;
    for (const row of nodeRows) {
      nodesByTier[row.tier] += row.c;
      nodeTotal += row.c;
    }

    const edgeRows = this.#all<{ tier: MemoryTier; kind: "observed" | "inferred"; c: number }>(
      "SELECT tier, kind, COUNT(*) AS c FROM memory_edges GROUP BY tier, kind",
    );
    const edgesByTier = zeroTiers();
    const inferredByTier = zeroTiers();
    let observed = 0;
    let inferred = 0;
    for (const row of edgeRows) {
      edgesByTier[row.tier] += row.c;
      if (row.kind === "inferred") {
        inferred += row.c;
        inferredByTier[row.tier] += row.c;
      } else {
        observed += row.c;
      }
    }

    const superseded = this.#one<{ c: number }>(
      "SELECT COALESCE(SUM(nodes_superseded), 0) AS c FROM dream_sessions",
    );
    const pageCount = this.#one<{ page_count: number }>("PRAGMA page_count");
    const pageSize = this.#one<{ page_size: number }>("PRAGMA page_size");

    return {
      nodes: {
        total: nodeTotal,
        byTier: nodesByTier,
        byKind: nodeRows.map((row) => ({ tier: row.tier, kind: row.kind, count: row.c })),
      },
      edges: {
        total: observed + inferred,
        observed,
        inferred,
        byTier: edgesByTier,
        active: inferredByTier.hot,
        dormant: inferredByTier.cold,
        suppressed: inferredByTier.suppressed,
      },
      inferredWeights: this.#inferredWeights(),
      supersessions: superseded?.c ?? 0,
      databaseBytes: (pageCount?.page_count ?? 0) * (pageSize?.page_size ?? 0),
    };
  }

  // -- survival -------------------------------------------------------------

  /**
   * Of the edges a night created, what fraction is still above the floor.
   *
   * The single best measure of insight versus noise, and it is only answerable
   * because the dream log is permanent: a rolling window cannot tell you what
   * happened to March's edges once March has aged out.
   *
   * Derived by joining `dream_edge_reasoning` (disposition `created`) to
   * `dream_sessions` for the night, and left-joining `memory_edges` on the
   * opaque edge id for where each one ended up. The LEFT join is what makes
   * {@link SurvivalReport.vanished} observable — an inner join would have
   * silently dropped exactly the rows that represent a constraint-6 breach.
   *
   * @throws {MetricsError} `bad_window` on a window that is not a positive
   * whole number of nights.
   */
  survival(options: SurvivalOptions = {}): SurvivalReport {
    if (options.nights !== undefined) {
      requireWholeCount(options.nights, "bad_window", "A survival window");
    }

    const now = instant(this.#clock());
    const rows = this.#all<{
      night: string;
      tz: string;
      created: number;
      surviving: number;
      crossed: number;
      demoted: number;
      suppressed: number;
      missing: number;
    }>(
      `SELECT s.night AS night,
              MAX(s.tz) AS tz,
              COUNT(*) AS created,
              SUM(CASE WHEN e.tier = 'hot'
                        AND (e.demote_after IS NULL OR e.demote_after > ?)
                       THEN 1 ELSE 0 END) AS surviving,
              SUM(CASE WHEN e.tier = 'hot'
                        AND e.demote_after IS NOT NULL AND e.demote_after <= ?
                       THEN 1 ELSE 0 END) AS crossed,
              SUM(CASE WHEN e.tier = 'cold' THEN 1 ELSE 0 END) AS demoted,
              SUM(CASE WHEN e.tier = 'suppressed' THEN 1 ELSE 0 END) AS suppressed,
              SUM(CASE WHEN e.id IS NULL THEN 1 ELSE 0 END) AS missing
         FROM dream_edge_reasoning r
         JOIN dream_sessions s ON s.id = r.session_id
         LEFT JOIN memory_edges e ON e.id = r.edge_id
        WHERE r.disposition = 'created'
        GROUP BY s.night
        ORDER BY s.night DESC`,
      now,
      now,
    );

    const limited = options.nights === undefined ? rows : rows.slice(0, options.nights);

    let created = 0;
    let surviving = 0;
    let vanished = 0;
    const cohorts = limited.map((row) => {
      created += row.created;
      surviving += row.surviving;
      vanished += row.missing;
      const today = nightOf(this.#clock(), row.tz);
      return {
        night: row.night,
        nightsAgo: Math.round((nightToMs(today) - nightToMs(row.night)) / DAY_MS),
        created: row.created,
        surviving: row.surviving,
        crossedUnswept: row.crossed,
        demoted: row.demoted,
        suppressed: row.suppressed,
        missing: row.missing,
        rate: rateOf(row.surviving, row.created, "that night created no edges"),
      };
    });

    return {
      cohorts,
      overall: rateOf(
        surviving,
        created,
        "no edges have been created yet, so there is no survival rate — this is not a rate of zero",
      ),
      basis: "scheduled_crossing",
      hasEvidence: created > 0,
      vanished,
    };
  }

  // -- reactivation ---------------------------------------------------------

  /**
   * How often the sweep rediscovers a dormant edge.
   *
   * The direct evidence for the Commander's demote-never-prune call. A
   * rediscovery is a `reactivated` reasoning row whose `tier_before` was
   * `cold` — the tier transition is what makes it a rediscovery rather than a
   * boost to something already live.
   */
  reactivation(): ReactivationReport {
    const perNightRows = this.#all<{ night: string; reactivated: number; demoted: number }>(
      `SELECT s.night AS night,
              COALESCE(SUM(s.edges_demoted), 0) AS demoted,
              (SELECT COUNT(*)
                 FROM dream_edge_reasoning r
                 JOIN dream_sessions rs ON rs.id = r.session_id
                WHERE rs.night = s.night
                  AND r.disposition = 'reactivated'
                  AND r.tier_before = 'cold') AS reactivated
         FROM dream_sessions s
        GROUP BY s.night
        ORDER BY s.night DESC`,
    );

    const perNight = perNightRows.map((row) => ({
      night: row.night,
      reactivated: row.reactivated,
      demoted: row.demoted,
    }));
    const reactivated = perNight.reduce((sum, row) => sum + row.reactivated, 0);
    const demoted = perNight.reduce((sum, row) => sum + row.demoted, 0);
    const nights = perNight.length;

    const triggers = this.#all<{
      edge_id: string;
      night: string;
      reasoning: string;
      confidence: number | null;
      created_at: string;
    }>(
      `SELECT r.edge_id AS edge_id, s.night AS night, r.reasoning AS reasoning,
              r.confidence AS confidence, r.created_at AS created_at
         FROM dream_edge_reasoning r
         JOIN dream_sessions s ON s.id = r.session_id
        WHERE r.disposition = 'reactivated' AND r.tier_before = 'cold'
        ORDER BY r.id DESC
        LIMIT ?`,
      DEFAULT_TRIGGER_LIMIT,
    ).map((row) => ({
      edgeId: row.edge_id,
      night: row.night,
      reasoning: row.reasoning,
      confidence: row.confidence,
      at: row.created_at,
    }));

    const breaches = this.#one<{ c: number }>("SELECT COUNT(*) AS c FROM dream_duplicate_edges");

    return {
      nights,
      reactivated,
      demoted,
      rate: rateOf(reactivated, demoted, "nothing has ever been demoted, so nothing could come back"),
      perNight,
      triggers,
      verdict: this.#reactivationVerdict(nights, demoted, reactivated, breaches?.c ?? 0),
    };
  }

  // -- engagement -----------------------------------------------------------

  /**
   * Of the connections surfaced to him, what he did about them.
   *
   * Silence is counted: a connection that has sat unanswered for longer than
   * {@link IGNORED_AFTER_MS} is read as ignored. Without that the denominator
   * is permanently zero, "ignored" is unmeasurable, and the rule that a class
   * of connection he consistently ignores should stop being generated can never
   * fire.
   *
   * The class of a connection is the edge's `relation`, fetched by a read-only
   * join into the graph — the log does not carry it.
   */
  engagement(): EngagementReport {
    const nowMs = this.#clock();
    const rows = this.#all<{
      response: "pending" | "engaged" | "ignored" | "rejected";
      surfaced_at: string;
      relation: string | null;
    }>(
      `SELECT f.response AS response, f.surfaced_at AS surfaced_at, e.relation AS relation
         FROM dream_surfaced f
         LEFT JOIN memory_edges e ON e.id = f.edge_id`,
    );

    let engaged = 0;
    let ignored = 0;
    let rejected = 0;
    let pending = 0;
    let agedIntoIgnored = 0;
    const byRelation = new Map<string, { relation: string | null; engaged: number; ignored: number; rejected: number; pending: number }>();

    for (const row of rows) {
      let response = row.response;
      if (response === "pending" && nowMs - Date.parse(row.surfaced_at) > IGNORED_AFTER_MS) {
        response = "ignored";
        agedIntoIgnored += 1;
      }
      if (response === "engaged") engaged += 1;
      else if (response === "ignored") ignored += 1;
      else if (response === "rejected") rejected += 1;
      else pending += 1;

      const key = row.relation ?? "\0synthesis";
      const bucket = byRelation.get(key) ?? {
        relation: row.relation,
        engaged: 0,
        ignored: 0,
        rejected: 0,
        pending: 0,
      };
      bucket[response] += 1;
      byRelation.set(key, bucket);
    }

    const surfaced = rows.length;
    const answered = engaged + ignored + rejected;
    const noVerdicts =
      surfaced === 0
        ? "nothing has been surfaced to him yet, so there is no engagement rate"
        : "everything surfaced is still awaiting a verdict";

    return {
      surfaced,
      engaged,
      ignored,
      rejected,
      pending,
      answered,
      agedIntoIgnored,
      engagedRate: rateOf(engaged, answered, noVerdicts),
      ignoredRate: rateOf(ignored, answered, noVerdicts),
      rejectedRate: rateOf(rejected, answered, noVerdicts),
      byRelation: [...byRelation.values()]
        .map((bucket) => {
          const relationAnswered = bucket.engaged + bucket.ignored + bucket.rejected;
          return {
            relation: bucket.relation,
            surfaced: relationAnswered + bucket.pending,
            answered: relationAnswered,
            engaged: bucket.engaged,
            ignored: bucket.ignored,
            rejected: bucket.rejected,
            engagedRate: rateOf(
              bucket.engaged,
              relationAnswered,
              "nothing of this class has been answered yet",
            ),
          };
        })
        .sort((left, right) => right.surfaced - left.surfaced),
      hasEvidence: surfaced > 0,
    };
  }

  // -- cost -----------------------------------------------------------------

  /**
   * Tokens spent per surviving inferred edge, trending.
   *
   * The honest number for whether a six-hour dream is worth six hours. Two
   * things stop it lying:
   *
   *   - a night that spent a fortune and kept nothing reports `null`, not zero,
   *     with {@link CostReport.keptNothing} set. A cost per kept edge of zero
   *     reads as free, which is the exact opposite of what happened.
   *   - {@link CostReport.understated} is set when any turn was killed by the
   *     ten-minute timeout, because a killed turn never reported its usage and
   *     every figure here is therefore a floor.
   */
  costPerKeptEdge(): CostReport {
    const spendRows = this.#all<{ night: string; tokens: number; usd: number }>(
      `SELECT night, COALESCE(SUM(tokens_spent), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS usd
         FROM dream_sessions GROUP BY night ORDER BY night DESC`,
    );
    const cohorts = new Map(this.survival().cohorts.map((cohort) => [cohort.night, cohort]));

    let tokensSpent = 0;
    let costUsd = 0;
    let edgesCreated = 0;
    let edgesKept = 0;
    const perNight = spendRows.map((row) => {
      const cohort = cohorts.get(row.night);
      const created = cohort?.created ?? 0;
      const kept = cohort?.surviving ?? 0;
      tokensSpent += row.tokens;
      costUsd += row.usd;
      edgesCreated += created;
      edgesKept += kept;
      return {
        night: row.night,
        tokensSpent: row.tokens,
        costUsd: row.usd,
        edgesCreated: created,
        edgesKept: kept,
        tokensPerKeptEdge: rateOf(row.tokens, kept, this.#whyNoCost(row.tokens, created)),
      };
    });

    const timedOut = this.#one<{ c: number }>(
      "SELECT COUNT(*) AS c FROM dream_turns WHERE outcome = 'timeout'",
    );
    const why = this.#whyNoCost(tokensSpent, edgesCreated);

    return {
      tokensSpent,
      costUsd,
      edgesCreated,
      edgesKept,
      tokensPerKeptEdge: rateOf(tokensSpent, edgesKept, why),
      usdPerKeptEdge: rateOf(costUsd, edgesKept, why),
      perNight,
      keptNothing: edgesCreated > 0 && edgesKept === 0,
      understated: (timedOut?.c ?? 0) > 0,
      timedOutTurns: timedOut?.c ?? 0,
    };
  }

  // -- the cold-store audit -------------------------------------------------

  /**
   * The proof that demoting an edge never became losing it.
   *
   * The Commander raised this himself: if an edge drops below the floor and is
   * now outside the partition key, it might never again be accessible. The
   * mechanism that prevents it — identity lookups that span every partition
   * while scans read hot only — is built. This is the evidence that it holds.
   */
  coldStoreAudit(sampleSize = DEFAULT_COLD_SAMPLE): ColdStoreAudit {
    return {
      alarm: this.invariantAlarm(),
      shape: this.coldShape(),
      resurrection: this.reactivation(),
      sample: this.coldSample(sampleSize),
    };
  }

  /**
   * The zero invariant, and which of the three bugs it is if it is not zero.
   *
   * See {@link InvariantStatus}. A suppressed breach takes the status and the
   * severity even when cold breaches outnumber it, and keeps its own list, so
   * a trust failure cannot be averaged away by a louder performance bug.
   */
  invariantAlarm(): InvariantAlarm {
    const rows = this.#all<{
      id: number;
      session_id: string;
      night: string;
      source_node: string;
      target_node: string;
      existing_edge_id: string;
      existing_tier: MemoryTier | null;
      inserted_edge_id: string | null;
      detected_at: string;
      note: string | null;
    }>(
      `SELECT d.id AS id, d.session_id AS session_id, s.night AS night,
              d.source_node AS source_node, d.target_node AS target_node,
              d.existing_edge_id AS existing_edge_id, d.existing_tier AS existing_tier,
              d.inserted_edge_id AS inserted_edge_id, d.detected_at AS detected_at,
              d.note AS note
         FROM dream_duplicate_edges d
         JOIN dream_sessions s ON s.id = d.session_id
        ORDER BY d.id`,
    );

    const all: InvariantBreach[] = rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      night: row.night,
      sourceNode: row.source_node,
      targetNode: row.target_node,
      existingEdgeId: row.existing_edge_id,
      existingTier: row.existing_tier,
      insertedEdgeId: row.inserted_edge_id,
      detectedAt: row.detected_at,
      note: row.note,
    }));

    const suppressedResurrections = all.filter((row) => row.existingTier === "suppressed");
    const coldLookupFailures = all.filter((row) => row.existingTier === "cold");
    const brokenOutright = all.filter((row) => row.existingTier === "hot");
    const unrecorded = all.filter((row) => row.existingTier === null);

    const attempts = this.#one<{ c: number }>(
      `SELECT COUNT(*) AS c FROM dream_edge_reasoning
        WHERE disposition IN ('created', 'reactivated', 'suppressed')`,
    );
    const insertionsAttempted = attempts?.c ?? 0;

    const byExistingTier = {
      hot: brokenOutright.length,
      cold: coldLookupFailures.length,
      suppressed: suppressedResurrections.length,
      unrecorded: unrecorded.length,
    };

    const base = {
      total: all.length,
      byExistingTier,
      suppressedResurrections,
      coldLookupFailures,
      brokenOutright,
      all,
      insertionsAttempted,
      storeEnforced: true as const,
    };

    // Ordered worst first. The suppressed case is checked BEFORE the cold one
    // deliberately: a night with two cold breaches and one suppressed one is a
    // trust failure, not a partition bug with a footnote.
    if (suppressedResurrections.length > 0) {
      const others = all.length - suppressedResurrections.length;
      return {
        ...base,
        status: "rejected_connection_resurrected",
        severity: "trust_failure",
        headline:
          `TRUST FAILURE: reflection tried to resurrect ${suppressedResurrections.length} ` +
          `connection(s) the Commander explicitly REJECTED. He said no once; the system does ` +
          `not get to hand them back` +
          (others > 0 ? `. ${others} further breach(es) of the zero invariant alongside it` : "") +
          `.`,
      };
    }

    if (all.length > 0) {
      return {
        ...base,
        status: "cold_lookup_broken",
        severity: "critical",
        headline:
          `The zero invariant is BREACHED ${all.length} time(s): a new edge was inserted where ` +
          `one already existed for that pair (${byExistingTier.cold} cold, ${byExistingTier.hot} ` +
          `hot, ${byExistingTier.unrecorded} unrecorded). Dormant edges are being duplicated ` +
          `instead of reactivated, and the originals keep their history and stay invisible.`,
      };
    }

    if (insertionsAttempted === 0) {
      return {
        ...base,
        status: "unproven",
        severity: "unknown",
        headline:
          "UNPROVEN: no dream has ever inserted an edge, so the cold identity lookup has never " +
          "been exercised. Zero breaches is not evidence of health here — it is an absence of " +
          "evidence either way.",
      };
    }

    return {
      ...base,
      status: "holds",
      severity: "ok",
      headline:
        `The zero invariant holds: ${insertionsAttempted} edge insertion(s) across every dream, ` +
        `and not one pair duplicated. Cold and suppressed edges are being found.`,
    };
  }

  /**
   * How big the cold store is, how old, and how fast it is growing.
   *
   * If the cold set grows monotonically and nothing ever comes back, that is
   * the empirical answer to whether never-prune is buying anything, and the
   * Commander asked to be told either way.
   */
  coldShape(): ColdShape {
    const nowMs = this.#clock();
    const counts = this.#one<{ total: number; inferred: number; oldest: string | null }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN kind = 'inferred' THEN 1 ELSE 0 END), 0) AS inferred,
              MIN(updated_at) AS oldest
         FROM memory_edges WHERE tier = 'cold'`,
    );
    const total = counts?.total ?? 0;
    const oldestEnteredAt = counts?.oldest ?? null;

    let timeInCold: ColdShape["timeInCold"] = null;
    if (total > 0) {
      const entered = this.#all<{ updated_at: string }>(
        `SELECT updated_at FROM memory_edges WHERE tier = 'cold' ORDER BY updated_at DESC`,
      ).map((row) => row.updated_at);
      timeInCold = {
        p50Ms: percentileAge(nowMs, entered, 0.5),
        p90Ms: percentileAge(nowMs, entered, 0.9),
        maxMs: oldestEnteredAt === null ? 0 : nowMs - Date.parse(oldestEnteredAt),
      };
    }

    const reactivation = this.reactivation();
    const growthPerNight = reactivation.perNight.map((row) => ({
      night: row.night,
      demoted: row.demoted,
      reactivated: row.reactivated,
      net: row.demoted - row.reactivated,
    }));

    return {
      edges: total,
      inferred: counts?.inferred ?? 0,
      observed: total - (counts?.inferred ?? 0),
      oldestEnteredAt,
      oldestAgeMs: oldestEnteredAt === null ? null : nowMs - Date.parse(oldestEnteredAt),
      timeInCold,
      enteredBasis: "moved_at",
      growthPerNight,
      crossingRatePerNight: rateOf(
        reactivation.demoted,
        reactivation.nights,
        "no night has run yet, so there is no crossing rate — this is not a rate of zero",
      ),
    };
  }

  /**
   * A random handful of cold inferred edges, with the reasoning that justified
   * them and both endpoint labels.
   *
   * This is the cheap check that catches a floor set too aggressively, which no
   * aggregate number will reveal — only he can say whether what is down there
   * was worth keeping.
   *
   * Inferred only: an observation carries no reasoning, and reasoning is the
   * thing being judged.
   *
   * @throws {MetricsError} `bad_limit` on a size that is not a positive whole
   * number.
   */
  coldSample(limit = DEFAULT_COLD_SAMPLE): readonly ColdSampleEdge[] {
    requireWholeCount(limit, "bad_limit", "A cold sample size");
    const nowMs = this.#clock();

    const counted = this.#one<{ c: number }>(
      "SELECT COUNT(*) AS c FROM memory_edges WHERE tier = 'cold' AND kind = 'inferred'",
    );
    const total = counted?.c ?? 0;
    if (total === 0) return [];

    const select =
      `SELECT e.id AS id, e.tier AS tier, e.relation AS relation, e.source_node AS source_node,
              e.target_node AS target_node, e.weight AS weight, e.confidence AS confidence,
              e.reasoning AS reasoning, e.updated_at AS entered_at,
              src.label AS source_label, tgt.label AS target_label
         FROM memory_edges e
         JOIN memory_nodes src ON src.id = e.source_node
         JOIN memory_nodes tgt ON tgt.id = e.target_node
        WHERE e.tier = 'cold' AND e.kind = 'inferred'
        ORDER BY e.id`;

    interface SampleRow {
      id: string;
      tier: MemoryTier;
      relation: string;
      source_node: string;
      target_node: string;
      weight: number;
      confidence: number | null;
      reasoning: string;
      entered_at: string;
      source_label: string;
      target_label: string;
    }

    const rows: SampleRow[] =
      total <= limit
        ? this.#all<SampleRow>(select)
        : [...this.#offsets(total, limit)].flatMap((offset) =>
            this.#all<SampleRow>(`${select} LIMIT 1 OFFSET ?`, offset),
          );

    return rows.map((row) => ({
      id: row.id,
      tier: row.tier,
      relation: row.relation,
      sourceNode: row.source_node,
      targetNode: row.target_node,
      sourceLabel: row.source_label,
      targetLabel: row.target_label,
      weight: row.weight,
      confidence: row.confidence,
      reasoning: row.reasoning,
      enteredColdAt: row.entered_at,
      ageMs: nowMs - Date.parse(row.entered_at),
    }));
  }

  /** Everything, in one read, with the alarm first. */
  report(): MemoryMetricsReport {
    const cold = this.coldStoreAudit();
    return {
      alarm: cold.alarm,
      generatedAt: instant(this.#clock()),
      store: this.storeShape(),
      survival: this.survival(),
      reactivation: cold.resurrection,
      engagement: this.engagement(),
      cost: this.costPerKeptEdge(),
      cold,
    };
  }

  // -- internals ------------------------------------------------------------

  #inferredWeights(): WeightHistogram {
    const rows = this.#all<{ bucket: number; tier: MemoryTier; c: number }>(
      `SELECT MIN(CAST(weight * 10 AS INTEGER), 9) AS bucket, tier, COUNT(*) AS c
         FROM memory_edges WHERE kind = 'inferred'
        GROUP BY bucket, tier`,
    );

    const buckets = Array.from({ length: 10 }, (_unused, index) => ({
      from: index / 10,
      to: (index + 1) / 10,
      count: 0,
      hot: 0,
      cold: 0,
      suppressed: 0,
    }));

    let total = 0;
    for (const row of rows) {
      const bucket = buckets[row.bucket];
      if (bucket === undefined) continue;
      bucket.count += row.c;
      bucket[row.tier] += row.c;
      total += row.c;
    }

    return {
      buckets,
      total,
      bottomHeavy: rateOf(
        buckets[0]?.count ?? 0,
        total,
        "there are no inferred edges yet, so the histogram has no shape — an empty store is " +
          "not a healthy one",
      ),
      basis: "stored",
    };
  }

  #reactivationVerdict(
    nights: number,
    demoted: number,
    reactivated: number,
    breaches: number,
  ): ReactivationVerdict {
    if (breaches > 0) {
      return {
        kind: "reactivation_may_be_broken",
        breaches,
        headline:
          `${breaches} duplicate edge insertion(s) recorded, so a low reactivation count cannot ` +
          `be read as "nothing deserved reactivation" — the cold identity lookup may simply be ` +
          `broken. Fix the invariant before drawing any conclusion from this number.`,
      };
    }
    if (nights === 0) {
      return {
        kind: "no_dreams_yet",
        headline: "No dream has run yet. There is nothing to say about reactivation either way.",
      };
    }
    if (demoted === 0) {
      return {
        kind: "nothing_demoted_yet",
        headline:
          `${nights} night(s) have run and nothing has crossed the relevance floor yet, so ` +
          `nothing could have been rediscovered. Not evidence about never-prune.`,
      };
    }
    if (reactivated > 0) {
      return {
        kind: "reactivation_happens",
        reactivated,
        headline:
          `The sweep has rediscovered ${reactivated} dormant edge(s) across ${nights} night(s). ` +
          `Each one is evidence for keeping everything: it would have been gone under a prune.`,
      };
    }
    if (nights >= REACTIVATION_VERDICT_NIGHTS) {
      return {
        kind: "never_reactivated",
        nights,
        demoted,
        headline:
          `Across ${nights} nights, ${demoted} edge(s) crossed the floor and NOT ONE was ever ` +
          `rediscovered: reactivation never happens. On this evidence, keeping every edge ` +
          `forever has bought nothing — and the zero invariant holds, so this is a real finding ` +
          `and not a broken lookup.`,
      };
    }
    return {
      kind: "too_early",
      nights,
      needed: REACTIVATION_VERDICT_NIGHTS,
      headline:
        `${demoted} edge(s) demoted over ${nights} night(s) and none rediscovered. Too early to ` +
        `call: ${REACTIVATION_VERDICT_NIGHTS} nights is the bar before "never" beats "not yet".`,
    };
  }

  #whyNoCost(tokens: number, created: number): string {
    if (created === 0) {
      return "no edges have been created yet, so there is no cost per kept edge";
    }
    return (
      `${tokens} token(s) were spent and NOTHING survived: the cost per kept edge is ` +
      `unbounded, not zero`
    );
  }

  /**
   * `count` distinct row offsets, drawn from the injected randomness.
   *
   * Falls back to filling sequentially once the draws stop finding new offsets,
   * so a degenerate source cannot spin here forever and the result stays a set
   * of the size asked for.
   */
  #offsets(total: number, count: number): ReadonlySet<number> {
    const chosen = new Set<number>();
    const attempts = count * 20;
    for (let attempt = 0; attempt < attempts && chosen.size < count; attempt += 1) {
      chosen.add(Math.min(total - 1, Math.max(0, Math.floor(this.#random() * total))));
    }
    for (let offset = 0; offset < total && chosen.size < count; offset += 1) {
      chosen.add(offset);
    }
    return chosen;
  }

  #all<T>(sql: string, ...bindings: (string | number)[]): T[] {
    return this.#db.prepare(sql).all(...bindings) as unknown as T[];
  }

  #one<T>(sql: string, ...bindings: (string | number)[]): T | undefined {
    return this.#db.prepare(sql).get(...bindings) as unknown as T | undefined;
  }
}
