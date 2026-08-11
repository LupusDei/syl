import { instant, parseInstant, systemClock, type Clock } from "../services/clock.js";
import type { InferredEdge, MemoryEdge, ObservedEdge } from "./graph.js";
import { MemoryGraph } from "./graph.js";

/**
 * The weight law: how an edge's relevance changes over time. `syl-005.3.2`.
 *
 * CLAUDE.md constraint 6 is what this module exists to make true: **an inferred
 * edge is never deleted, only demoted.** Relevance decays asymptotically toward
 * zero and never arrives, so a dormant edge stays addressable and can be
 * promoted straight back.
 *
 * Four forces act on a weight. Three of them are easy to implement in a way
 * that looks right and silently is not, so each is stated here at the point
 * somebody would otherwise change it.
 *
 *
 * ## 1. Reactivation JUMPS TO A FLOOR. It does not multiply
 *
 * This is the one that silently breaks constraint 6, and it is the natural
 * thing to write. A multiplicative boost on a decayed weight does nothing:
 * `0.0001 * 2` is `0.0002`, still far below the relevance floor, still
 * unreachable, and demoted again on the very next sweep. Touch it a hundred
 * times and it is at `0.0001 * 2^100`, which is only "back" by accident of how
 * many times you happened to touch it.
 *
 * Without a floor, the asymptote is a **one-way trip**: "promote it straight
 * back" never actually happens, and the Commander's rule quietly becomes the
 * pruning he rejected — the edge is still on disk and nothing can reach it,
 * which is worse than a delete because it looks fine.
 *
 * So {@link reactivatedWeight} takes `max(current, floor)` and adds from there.
 * The jump is what escapes the asymptote; the increment is what makes repeated
 * use mean something once you are above it.
 *
 * The mirror image is worth noticing, because it explains why the two halves of
 * this module use different arithmetic on purpose:
 *
 *     Multiply to FALL — it can never reach zero.
 *     Jump to RISE     — nothing else can escape the asymptote.
 *
 *
 * ## 2. Decay is COMPUTED, never written
 *
 * Nothing here issues an `UPDATE` that recomputes a weight. The stored pair is
 * `(weight, last_touched_at)` and {@link effectiveWeight} derives the rest,
 * because a nightly sweep across every edge would be enormous write
 * amplification to recompute a pure function of two columns already on the row.
 *
 * The only scheduled write is the TIER move, and it is found rather than
 * computed: the crossing instant is known in closed form the moment a weight is
 * written ({@link crossingInstant}), so `0012_memory_core.sql` stores it in
 * `demote_after` and the sweep is a range scan over a partial index. See §4 of
 * that migration.
 *
 *
 * ## 3. Not all traversals are equal, and that is a SAFETY property
 *
 * If Syl's own retrieval boosts an edge as much as the Commander's engagement
 * does, she reinforces her own beliefs with no contact with reality: the edges
 * she happens to walk get stronger, so she walks them more, so they get
 * stronger. A closed loop with no external term converges on whatever it
 * started believing.
 *
 * So a touch carries its {@link TouchSource}, and the two are asymmetric in all
 * three parameters — floor, increment, and **cap**. The cap is the part that
 * matters: purely internal use can lift an edge to
 * `touch.traversal.cap` and no further, ever, however many times Syl walks it.
 * Getting an edge above that requires the Commander. {@link validateWeightLaw}
 * refuses a law in which those two caps are equal, so the asymmetry cannot be
 * tuned away by accident.
 *
 *
 * ## 4. Suppression falls faster than disuse
 *
 * A connection the Commander was shown and rejected must not linger *because*
 * it was shown once. Mere disuse takes {@link dwellMs}`(1)` — about a quarter —
 * to carry a full-strength edge to the floor. One rejection applies more ageing
 * than that at a stroke ({@link suppressedWeight}), which is asserted rather
 * than merely intended: `suppressionPenalty` must be below `relevanceFloor`, so
 * a rejected edge is under the floor immediately from ANY starting weight.
 *
 * Suppression is also a tier, not a weight — `MemoryGraph.suppress` moves the
 * row out of every scan whatever its weight does, and reactivation cannot
 * address it. The weight penalty is what makes the edge *stay* uninteresting if
 * the Commander ever withdraws the rejection, since `unsuppress` returns it to
 * `cold` rather than to `hot`.
 *
 *
 * ## Where the numbers come from
 *
 * | | value | why |
 * |---|---|---|
 * | half-life | 21 days | Three weeks. An edge touched weekly stays near full strength; one touched seasonally does not. |
 * | relevance floor | 0.05 | With the half-life above, a full-strength edge that nobody touches leaves the hot scan after **~91 days** — one quarter. |
 * | traversal floor / increment / cap | 0.20 / 0.05 / 0.50 | A revived edge is comfortably above the floor and dwells ~49 days. The cap is half strength: Syl's own use can make an edge worth looking at and can never make it certain. |
 * | engagement floor / increment / cap | 0.60 / 0.20 / 1.00 | One engagement buys ~84 days; three carry the edge to full strength. Only this path reaches above 0.5. |
 * | suppression penalty | 0.02 | Below the relevance floor, so one rejection drops any edge under it — worth ~118 days of disuse, more than the whole demotion horizon. |
 * | minimum weight | 1e-9 | NOT a rounding convenience. IEEE 754 underflow would eventually produce exactly `0.0`, and the store's `CHECK (weight > 0.0)` refuses that for a reason: a zero weight is an edge that can never be promoted back. The asymptote is preserved by clamping, which keeps every edge addressable forever. |
 */

/** Milliseconds in a day. */
export const DAY_MS = 86_400_000;

/** The two ways an edge gets touched, and they are deliberately not equal. */
export const TOUCH_SOURCES = ["traversal", "engagement"] as const;

/**
 * Who touched an edge.
 *
 * - `traversal` — Syl's own retrieval walked it. A small, **capped** lift.
 * - `engagement` — the Commander read, acted on, or affirmed it. A large lift,
 *   and the only one that reaches above the internal cap.
 */
export type TouchSource = (typeof TOUCH_SOURCES)[number];

/** What one kind of touch does to a weight. */
export interface TouchLaw {
  /** The weight a touch JUMPS to when the edge is below it. Never a multiplier. */
  readonly floor: number;
  /** Added on top of the jump, so repeated use means something above the floor. */
  readonly increment: number;
  /** The highest weight this kind of touch can ever produce. */
  readonly cap: number;
}

/** Every parameter of the law, in one value so a test can vary one of them. */
export interface WeightLaw {
  /** How long an untouched weight takes to halve. */
  readonly halfLifeMs: number;
  /** The lowest weight still worth scanning. Below it, an edge moves to `cold`. */
  readonly relevanceFloor: number;
  /** The clamp that keeps the asymptote from underflowing to a literal zero. */
  readonly minWeight: number;
  /** What one rejection multiplies a weight by. Must be below the relevance floor. */
  readonly suppressionPenalty: number;
  readonly touch: Readonly<Record<TouchSource, TouchLaw>>;
}

/** The law in force. See the table in this module's header for the reasoning. */
export const DEFAULT_WEIGHT_LAW: WeightLaw = {
  halfLifeMs: 21 * DAY_MS,
  relevanceFloor: 0.05,
  minWeight: 1e-9,
  suppressionPenalty: 0.02,
  touch: {
    traversal: { floor: 0.2, increment: 0.05, cap: 0.5 },
    engagement: { floor: 0.6, increment: 0.2, cap: 1 },
  },
};

/** What went wrong, as a closed set a caller can branch on. */
export type WeightErrorKind =
  | "bad_instant"
  | "bad_law"
  | "bad_source"
  | "bad_weight"
  | "suppressed_edge";

/** Thrown when the weight law cannot be applied as asked. */
export class WeightError extends Error {
  readonly kind: WeightErrorKind;

  constructor(kind: WeightErrorKind, message: string) {
    super(message);
    this.name = "WeightError";
    this.kind = kind;
  }
}

function requireWeight(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new WeightError(
      "bad_weight",
      `${what} must be a real number in (0, 1], got ${String(value)}. Zero is excluded ` +
        `because decay approaches it asymptotically and never arrives, so a stored zero ` +
        `would be an edge that could never be promoted back.`,
    );
  }
  return value;
}

function requireSource(value: TouchSource): TouchSource {
  if (!(TOUCH_SOURCES as readonly string[]).includes(value)) {
    throw new WeightError(
      "bad_source",
      `${JSON.stringify(String(value))} is not a touch source. Expected one of ` +
        `${TOUCH_SOURCES.join(", ")}. The source is not decoration: Syl's own traversal and ` +
        `the Commander's engagement must not lift an edge by the same amount, or she ` +
        `reinforces her own beliefs with no contact with reality.`,
    );
  }
  return value;
}

function requireEpoch(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw new WeightError(
      "bad_instant",
      `${what} must be a finite epoch-millisecond value, got ${String(value)}.`,
    );
  }
  return value;
}

function requireStamp(value: string, what: string): number {
  const parsed = parseInstant(value);
  if (parsed === null) {
    throw new WeightError(
      "bad_instant",
      `${what} must be an RFC 3339 UTC instant with millisecond precision, got ` +
        `${JSON.stringify(value)}. A fixed offset is a property of an instant, not of a ` +
        `place, and one that reaches storage survives exactly one DST boundary.`,
    );
  }
  return parsed;
}

/**
 * Refuse a law that cannot do its job.
 *
 * Every clause here is a way the law can be edited so that it still typechecks,
 * still runs, and no longer holds. The two that matter most:
 *
 *  - `traversal.floor <= relevanceFloor` — reactivation would land BELOW the
 *    floor, so the next sweep demotes it again. That is the one-way trip
 *    wearing a floor's clothes.
 *  - `traversal.cap >= engagement.cap` — Syl's own retrieval could reach
 *    wherever the Commander's engagement can, which is the self-reinforcement
 *    the asymmetry exists to prevent.
 *
 * @throws {WeightError} `bad_law`.
 */
export function validateWeightLaw(law: WeightLaw): WeightLaw {
  const refuse = (why: string): never => {
    throw new WeightError("bad_law", `The weight law is not self-consistent: ${why}`);
  };

  if (!Number.isFinite(law.halfLifeMs) || law.halfLifeMs <= 0) {
    refuse(`a half-life must be a positive number of milliseconds, got ${String(law.halfLifeMs)}.`);
  }
  requireWeight(law.relevanceFloor, "A relevance floor");
  requireWeight(law.minWeight, "A minimum weight");
  requireWeight(law.suppressionPenalty, "A suppression penalty");

  if (law.minWeight >= law.relevanceFloor) {
    refuse(
      `the minimum weight (${String(law.minWeight)}) must be far below the relevance floor ` +
        `(${String(law.relevanceFloor)}); it exists only to stop the asymptote underflowing ` +
        `to a literal zero.`,
    );
  }
  if (law.suppressionPenalty >= law.relevanceFloor) {
    refuse(
      `a suppression penalty of ${String(law.suppressionPenalty)} leaves a full-strength edge ` +
        `at or above the relevance floor (${String(law.relevanceFloor)}). A rejected connection ` +
        `must fall faster than mere disuse, or a wrong-but-surfaced edge lingers precisely ` +
        `because it was shown once.`,
    );
  }

  for (const source of TOUCH_SOURCES) {
    const touch = law.touch[source];
    requireWeight(touch.floor, `The ${source} reactivation floor`);
    requireWeight(touch.cap, `The ${source} cap`);
    if (!Number.isFinite(touch.increment) || touch.increment <= 0) {
      refuse(`the ${source} increment must be positive, got ${String(touch.increment)}.`);
    }
    if (touch.floor <= law.relevanceFloor) {
      refuse(
        `the ${source} reactivation floor (${String(touch.floor)}) is at or below the relevance ` +
          `floor (${String(law.relevanceFloor)}), so a reactivated edge would be demoted again ` +
          `by the very next sweep. Reactivation must land somewhere worth scanning.`,
      );
    }
    if (touch.cap < touch.floor) {
      refuse(`the ${source} cap (${String(touch.cap)}) is below its own floor.`);
    }
  }

  const internal = law.touch.traversal;
  const commander = law.touch.engagement;
  if (internal.cap >= commander.cap) {
    refuse(
      `internal traversal may reach ${String(internal.cap)} and the Commander's engagement ` +
        `${String(commander.cap)}. Purely internal use must be capped strictly below what his ` +
        `engagement can reach, or Syl reinforces her own beliefs with no contact with reality.`,
    );
  }
  if (internal.floor >= commander.floor || internal.increment >= commander.increment) {
    refuse(
      `internal traversal must lift an edge strictly less than the Commander's engagement does, ` +
        `in both the floor it jumps to and the increment it adds.`,
    );
  }
  return law;
}

/**
 * The weight an edge actually has now, derived rather than stored.
 *
 * Exponential decay on the law's half-life. It approaches zero and never
 * arrives — clamped at `law.minWeight` so IEEE 754 underflow cannot turn "never
 * arrives" into a literal `0.0` after a few thousand days.
 *
 * A `now` earlier than `lastTouchedAt` yields the stored weight unchanged.
 * Clock skew must not be a reinforcement mechanism.
 *
 * @throws {WeightError} `bad_weight`, `bad_instant`.
 */
export function effectiveWeight(
  weight: number,
  lastTouchedAt: string,
  now: number,
  law: WeightLaw = DEFAULT_WEIGHT_LAW,
): number {
  requireWeight(weight, "A stored weight");
  const touchedMs = requireStamp(lastTouchedAt, "A last-touched stamp");
  requireEpoch(now, "A reading instant");

  const elapsed = Math.max(0, now - touchedMs);
  const decayed = weight * Math.pow(2, -elapsed / law.halfLifeMs);
  return Math.min(1, Math.max(law.minWeight, decayed));
}

/**
 * How long a weight has before it crosses the relevance floor.
 *
 * Closed form, which is the whole reason the sweep can be a range scan instead
 * of a full-table `UPDATE`:
 *
 *     w · 2^(−Δ/H) = f   ⟹   Δ = H · log₂(w / f)
 *
 * Zero for a weight already at or below the floor, so such an edge is swept on
 * the next pass rather than being scheduled into the past.
 *
 * @throws {WeightError} `bad_weight`.
 */
export function dwellMs(weight: number, law: WeightLaw = DEFAULT_WEIGHT_LAW): number {
  requireWeight(weight, "A weight");
  if (weight <= law.relevanceFloor) return 0;
  return Math.round(law.halfLifeMs * Math.log2(weight / law.relevanceFloor));
}

/**
 * The instant a weight written at `from` next crosses the floor.
 *
 * This is what goes in `memory_edges.demote_after`. Every hot inferred edge
 * must have one — the migration CHECKs it — because the nightly sweep is
 * complete only if every edge that can cross has said when.
 *
 * @throws {WeightError} `bad_weight`, `bad_instant`.
 */
export function crossingInstant(
  weight: number,
  from: number,
  law: WeightLaw = DEFAULT_WEIGHT_LAW,
): string {
  requireEpoch(from, "A crossing origin");
  return instant(from + dwellMs(weight, law));
}

/**
 * The weight an edge takes on when it is touched.
 *
 * **A jump, not a multiplication** — see §1 of this module's header, which is
 * the whole point of the bead. And asymmetric in the source: internal traversal
 * lifts less and, more importantly, is CAPPED.
 *
 * A touch never lowers a weight. An internal traversal of an edge the Commander
 * has already strengthened past the internal cap leaves it exactly where it is,
 * rather than dragging it down to the cap.
 *
 * @throws {WeightError} `bad_weight`, `bad_source`.
 */
export function reactivatedWeight(
  current: number,
  source: TouchSource,
  law: WeightLaw = DEFAULT_WEIGHT_LAW,
): number {
  requireWeight(current, "A current weight");
  const touch = law.touch[requireSource(source)];

  // The jump is `max(current, floor)`. Replacing it with `current` — or with
  // any multiple of `current` — is the mistake that makes a decayed edge
  // permanently unreachable however often it is touched.
  const lifted = Math.min(Math.max(current, touch.floor) + touch.increment, touch.cap);
  return Math.min(1, Math.max(current, lifted));
}

/**
 * The weight an edge takes on when the Commander rejects it.
 *
 * Multiplicative, and deliberately so: it can fall arbitrarily far without ever
 * reaching zero, which is the same asymptote constraint 6 asks for from the
 * other direction. `suppressionPenalty` is below `relevanceFloor`, so ONE
 * rejection puts any edge under the floor — worth more ageing than the entire
 * demotion horizon of simply not being used.
 *
 * @throws {WeightError} `bad_weight`.
 */
export function suppressedWeight(
  current: number,
  law: WeightLaw = DEFAULT_WEIGHT_LAW,
): number {
  requireWeight(current, "A current weight");
  return Math.max(law.minWeight, current * law.suppressionPenalty);
}

export interface EdgeWeightsOptions {
  readonly graph: MemoryGraph;
  readonly clock?: Clock;
  /** Defaults to {@link DEFAULT_WEIGHT_LAW}. Validated on the way in. */
  readonly law?: WeightLaw;
}

/**
 * The weight law applied to the store.
 *
 * Every write here goes through {@link MemoryGraph}. This module owns no SQL,
 * and that is not tidiness: the demotion statement in particular must clear
 * `demote_after` as it moves a row, or demoted edges stay in the partial demote
 * index forever and the hot path slowly grows to hold the whole graph. There is
 * exactly one copy of that statement and it lives in `graph.ts`.
 */
export class EdgeWeights {
  readonly #graph: MemoryGraph;
  readonly #clock: Clock;
  readonly #law: WeightLaw;

  constructor(options: EdgeWeightsOptions) {
    this.#graph = options.graph;
    this.#clock = options.clock ?? systemClock;
    this.#law = validateWeightLaw(options.law ?? DEFAULT_WEIGHT_LAW);
  }

  /** The law this instance applies. */
  get law(): WeightLaw {
    return this.#law;
  }

  /**
   * What an edge is worth right now. Reads only — decay is never written back.
   *
   * @throws {WeightError} `bad_weight`, `bad_instant`.
   */
  effective(edge: MemoryEdge, now: number = this.#clock()): number {
    return effectiveWeight(edge.weight, edge.lastTouchedAt, now, this.#law);
  }

  /**
   * Record that an edge was used, and by whom.
   *
   * A cold edge is promoted straight back into the scan; a hot one has its
   * weight raised and its crossing instant pushed out. A **suppressed edge is
   * refused**: the Commander said it is wrong, and neither Syl's retrieval nor
   * his own later engagement gets to overrule that implicitly. Only an explicit
   * `MemoryGraph.unsuppress` — which returns it to `cold`, not to `hot` —
   * makes it touchable again.
   *
   * @throws {WeightError} `suppressed_edge`, `bad_source`, `bad_weight`;
   * {@link GraphError} if the row moved underneath the caller.
   */
  touch(edge: MemoryEdge, source: TouchSource): MemoryEdge {
    requireSource(source);
    if (edge.tier === "suppressed") {
      throw new WeightError(
        "suppressed_edge",
        `Edge ${edge.id} is suppressed: the Commander said it is wrong, so no amount of use ` +
          `brings it back. Un-suppress it explicitly — which returns it to the cold tier, ` +
          `because withdrawing a rejection does not re-assert relevance.`,
      );
    }

    const now = this.#clock();
    const weight = reactivatedWeight(this.effective(edge, now), source, this.#law);

    if (edge.kind === "inferred") {
      const demoteAfter = crossingInstant(weight, now, this.#law);
      return edge.tier === "cold"
        ? this.#graph.promote(edge, { demoteAfter, weight })
        : this.#graph.reweight(edge, { demoteAfter, weight });
    }

    // An observation never crosses on its own, so it never gets a stamp. Giving
    // it one would put every observed edge into the sweep's partial index.
    return edge.tier === "cold"
      ? this.#graph.promote(edge, { weight })
      : this.#graph.reweight(edge, { weight });
  }

  /**
   * The Commander says this connection is wrong.
   *
   * One move: the edge leaves every scan (the `suppressed` tier), its stamp is
   * cleared so it leaves the sweep's index, and its weight is penalised below
   * the relevance floor in the same statement — so a later un-suppression
   * returns something dormant rather than something live.
   *
   * @throws {WeightError} `bad_weight`; {@link GraphError} `already_suppressed`.
   */
  reject(edge: MemoryEdge): MemoryEdge {
    const weight = suppressedWeight(this.effective(edge), this.#law);
    return this.#graph.suppress(edge, weight);
  }

  /**
   * The nightly demotion pass.
   *
   * Delegates to `MemoryGraph.demoteDueEdges`, which is a range scan over the
   * partial demote index and touches only the rows that actually crossed. There
   * is no weight `UPDATE` anywhere in this pass, by design — see §2 of this
   * module's header.
   *
   * @returns how many edges moved to `cold`.
   * @throws {WeightError} `bad_instant`.
   */
  sweep(now: number = this.#clock()): number {
    return this.#graph.demoteDueEdges(instant(requireEpoch(now, "A sweep instant")));
  }
}

export type { InferredEdge, ObservedEdge };
