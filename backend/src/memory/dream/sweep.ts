import { instant, systemClock, type Clock } from "../../services/clock.js";
import {
  GraphError,
  MemoryGraph,
  type InferredEdge,
  type MemoryEdge,
  type MemoryNode,
} from "../graph.js";
import { encodeHoloFact, contradict, related, type HoloFact } from "../holographic-queries.js";
import {
  canonicalRelation,
  inferredRelation,
  isInferredRelation,
  DECLINED_RELATION,
  INFERRED_RELATION_SPECS,
  type InferredRelation,
} from "../relations.js";
import { crossingInstant, EdgeWeights } from "../weights.js";

import { DreamLog, type DreamDisposition, type MemoryTier } from "./log.js";

/**
 * Tier 1 of the dream: the nightly sweep. `syl-005.4.2`.
 *
 * ## Cheap candidates, expensive judgment
 *
 * The holographic kernels and the embedding index **propose**; the model only
 * **judges**. That split is the whole design, and it exists because asking a
 * model to find connections produces connections forever, plausibly and
 * inexhaustibly. The honest name for that is astrology, and a cheap
 * deterministic filter in front of it is what keeps the expensive half honest.
 *
 * Nothing in this module spawns a process or costs a token.
 *
 *
 * ## It seeds from the DAY, not from the whole past
 *
 * Consolidating new experience against existing memory bounds the work to
 * (today's memories × a few candidates each). Fifty thousand memories is 2.5
 * billion pairs; an exhaustive pass is not on the table and never will be. The
 * seed set is the nodes created since the start of the night's local day, and
 * it is bounded again by {@link SweepLimits.seedLimit} — "the day" is a
 * description of what happened, not a promise about how much of it there was.
 *
 *
 * ## Only `related()` and `contradict()` may propose
 *
 * `reason()` and `probe()` DO NOT DISCRIMINATE. Every fact scores 0.489–0.510
 * — the noise floor — and the ranking is sometimes inverted, with a fact that
 * does NOT contain the queried entity outscoring one that does. Verified
 * digit-for-digit against the upstream Python on the same corpus, so it is an
 * inherited defect rather than a porting error; tracked as `syl-b97`, with
 * three acceptance tests that stay RED.
 *
 * Wiring them in anyway would hand Tier 2 an undifferentiated set and let the
 * model find connections in noise, confidently, forever — which is exactly the
 * astrology failure the two-tier split exists to prevent, arriving through the
 * half that was supposed to be the safeguard. A filter that passes everything
 * is worse than no filter, because it launders noise as candidates.
 *
 * {@link CANDIDATE_KERNELS} is the closed list, and a test asserts the two
 * broken kernels are never called.
 *
 *
 * ## Re-proposing a dormant connection is a REACTIVATION, not a duplicate
 *
 * The dream rediscovering a forgotten connection is itself evidence it
 * mattered, so the existing edge is boosted rather than a second one written.
 * That is only true if the existence check finds the old edge, which is why
 * {@link DreamSweep.identityOf} never mentions `tier`: a partition key prunes
 * SCANS, never IDENTITY LOOKUPS. A hot-only check does not error — it inserts a
 * duplicate, the original keeps its history and stays invisible forever, and
 * "reactivations: 0" becomes indistinguishable from "nothing deserved
 * reactivation".
 *
 *
 * ## Silence is not proof
 *
 * `memory_edges_identity_idx` is UNIQUE across all partitions, so a duplicate
 * cannot enter the graph. It can only ever appear in the dream log, put there
 * by this module. A sweep that swallows the constraint violation therefore
 * produces exactly the same zero as a sweep that never hit one, which is why
 * every refused insert calls {@link DreamLog.recordDuplicateEdgeInsert} with
 * the clashing edge's tier. An `existing_tier` of `suppressed` is categorically
 * different from `cold`: cold means the lookup is broken, suppressed means
 * reflection tried to resurrect a connection the **Commander explicitly
 * rejected**, which is a trust failure and must be loud.
 *
 *
 * ## The kernel proposes a SHAPE; the judgment names the RELATION
 *
 * Tier 1 knows only that two memories are structurally alike or structurally
 * at odds, so it can only ever say `resembles` or `contradicts`. Until
 * `syl-017.1` that was also all any edge ever said, and Syl found the defect
 * herself: *"Ela to Rowan is not resemblance, it's parenthood ... you can't
 * ask 'who are his children.'"*
 *
 * So the judgment may name a relation, from the closed vocabulary in
 * `schema.ts`, and may say which memory is the SUBJECT — because a directed
 * relation pointing the wrong way is not a vaguer answer than `resembles`, it
 * is a false one that looks exactly like a true one. {@link resolveRelation}
 * is the whole of it, and it declines rather than guesses.
 *
 * **A relation is never edited onto an existing edge.** An edge's identity is
 * `(source, target, relation)`, so a night that names a pair more precisely
 * writes a NEW edge beside the vague one; the vague one keeps its own
 * reasoning and decays on its own terms. That is constraint 6 one layer in —
 * nothing is rewritten, nothing is destroyed — and it is why this bead needs no
 * backfill and no supersession ledger.
 *
 *
 * ## Constraint 7: the log is telemetry ABOUT the graph
 *
 * This module writes to both stores and neither store writes to the other. No
 * dream id ever reaches `memory_nodes` or `memory_edges`; get that wrong and
 * the next night consolidates Syl's own dreams as experience.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The kernels allowed to nominate a candidate.
 *
 * `reason` and `probe` are deliberately absent. See this module's header and
 * `syl-b97`.
 */
export const CANDIDATE_KERNELS = ["related", "contradict", "embedding"] as const;

export type CandidateKernel = (typeof CANDIDATE_KERNELS)[number];

/**
 * The relation a structural proposal takes when the judgment accepts it.
 *
 * Typed as an {@link InferredRelation} rather than a bare string, so a kernel
 * cannot propose a relation the write path would refuse: dropping it from
 * {@link INFERRED_RELATIONS} is a compile error here rather than a night of
 * `unusable_candidate`.
 */
// `about`, not `resembles`. Two epics independently built a relation
// vocabulary; `relations.ts` is the home and its escape relation is `about`.
// Keeping `resembles` here would have been a twelfth name that only this file
// knew — the defect this consolidation exists to close.
export const RELATED_RELATION: InferredRelation = DECLINED_RELATION;

/** The relation a contradiction proposal takes when the judgment accepts it. */
export const CONTRADICT_RELATION: InferredRelation = "contradicts";

/** What went wrong, as a closed set a caller can branch on. */
export type SweepErrorKind =
  | "bad_night"
  | "bad_reasoning"
  | "bad_timezone"
  | "nothing_to_suppress"
  | "unusable_candidate";

/** Thrown when a candidate cannot be judged or applied as asked. */
export class SweepError extends Error {
  readonly kind: SweepErrorKind;

  constructor(kind: SweepErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SweepError";
    this.kind = kind;
  }
}

/**
 * One pair the cheap half thinks is worth a token.
 *
 * `existing` is the edge that already joins this pair that way, in ANY
 * partition, found through the identity index. It is what tells the judgment
 * that a "new" connection is actually a rediscovery — and what stops the write
 * path inserting a second edge beside a dormant one.
 */
export interface SweepCandidate {
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly relation: string;
  readonly kernel: CandidateKernel;
  /**
   * Whether the relation means the same thing read backwards. Both relations
   * this module proposes are, so the identity check looks in both directions;
   * a directed relation from a future kernel must not.
   */
  readonly symmetric: boolean;
  /** The kernel's own score. Comparable within a kernel, not across them. */
  readonly score: number;
  readonly existing: MemoryEdge | null;
}

/** What one night's cheap half produced. */
export interface SweepReport {
  /** Hot edges that crossed the relevance floor into `cold`. */
  readonly demoted: number;
  /** The day's memories, which is what everything was consolidated against. */
  readonly seeds: readonly MemoryNode[];
  readonly candidates: readonly SweepCandidate[];
}

/** Nodes an embedding index thinks are near one of the day's memories. */
export interface SemanticNeighbour {
  readonly nodeId: string;
  readonly similarity: number;
}

/**
 * The embedding half of "cheap things propose".
 *
 * An interface rather than a `MemoryStore` because the real one needs a 300M
 * parameter model loaded and this module must stay unit-testable. See
 * `storeSemanticProposer` in the retrieval layer for the production wiring.
 */
export interface SemanticProposer {
  near(node: MemoryNode, limit: number): Promise<readonly SemanticNeighbour[]>;
}

/** Everything that bounds one night's work. */
export interface SweepLimits {
  /** The day's memories to consolidate against. */
  readonly seedLimit: number;
  /** Hot nodes scored against each seed. `contradict` is O(n²) in this. */
  readonly poolLimit: number;
  /** Candidates each kernel may nominate per seed. */
  readonly perSeed: number;
  /**
   * Entities of one seed used as `related` probes.
   *
   * `related` takes an ENTITY, not a sentence: it unbinds that entity's atom
   * from each fact vector and asks whether what is left looks like a role. A
   * whole label ("the gutter was replaced") encodes as one atom nothing shares,
   * so probing with it scores every fact at the noise floor — the same failure
   * `syl-b97` describes, self-inflicted. The seed's entities are what it
   * actually shares with the rest of the graph.
   */
  readonly entitiesPerSeed: number;
  /** Candidates handed to Tier 2 in total. */
  readonly maxCandidates: number;
  /**
   * Below this, `related` is not saying anything.
   *
   * `related` scores into [0, 1] with the noise floor near 0.5 and a real
   * structural match separating by ~0.30 on the reference corpus, so this sits
   * above the floor by a margin rather than at it.
   */
  readonly minRelatedScore: number;
  /** Below this, `contradict` is not saying anything. Upstream's default. */
  readonly minContradictionScore: number;
}

export const DEFAULT_SWEEP_LIMITS: SweepLimits = {
  seedLimit: 200,
  poolLimit: 500,
  perSeed: 5,
  entitiesPerSeed: 8,
  maxCandidates: 200,
  minRelatedScore: 0.55,
  minContradictionScore: 0.3,
};

export interface DreamSweepOptions {
  readonly graph: MemoryGraph;
  readonly log: DreamLog;
  /** Defaults to a fresh {@link EdgeWeights} over the same graph. */
  readonly weights?: EdgeWeights;
  readonly clock?: Clock;
  readonly semantic?: SemanticProposer;
  readonly limits?: Partial<SweepLimits>;
}

export interface RunSweep {
  readonly sessionId: string;
  /** The local calendar date the night belongs to. */
  readonly night: string;
  /** IANA, never a fixed offset. */
  readonly tz: string;
  readonly now?: number;
}

/**
 * Which endpoint of a candidate the judgment meant as the subject.
 *
 * `A` is the candidate's source and `B` its target, which is exactly how
 * `buildJudgePrompt` labels them — one naming, so the model's answer and the
 * write path cannot disagree about which memory is which.
 */
export type RelationSubject = "A" | "B";

/** What Tier 2 decided about one candidate. */
export interface Verdict {
  readonly disposition: DreamDisposition;
  /** WHY. Mandatory: an inference nobody can audit is a rumour. */
  readonly reasoning: string;
  readonly confidence?: number;
  /**
   * The judgment may name the relation more precisely than the kernel did.
   *
   * Checked against {@link INFERRED_RELATIONS}; anything outside it is a
   * nomination rather than a write. See {@link resolveRelation}.
   */
  readonly relation?: string;
  /**
   * Which memory is the subject, for a directed relation.
   *
   * Required for a directed relation and ignored for a symmetric one. A
   * directed relation arriving without it is declined rather than guessed:
   * half the time a coin flip is right, which is what makes it unfalsifiable.
   */
  readonly subject?: RelationSubject;
}

/** Why the judgment's chosen relation was not the one written. */
export interface DeclinedRelation {
  /** What the judgment asked for, canonicalised. The evidence for widening. */
  readonly requested: string;
  readonly why: "unknown_relation" | "no_direction";
}

/** A candidate's endpoints and relation, after the judgment has had its say. */
export interface ResolvedRelation {
  readonly relation: string;
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly symmetric: boolean;
  /** Set when the judgment named a relation that was not written. */
  readonly declined: DeclinedRelation | null;
}

/**
 * What relation this verdict actually writes, and which way round.
 *
 * The whole of `syl-017.1`'s tension lives in this function, and it resolves it
 * the way `tidy.ts` resolves the same one: **the vocabulary is closed, and
 * anything outside it is a NOMINATION.** A relation the vocabulary does not
 * hold does not kill the candidate and does not enter the graph — the
 * connection is filed under the kernel's relation, which is what the dream did
 * for every edge before this bead, and the word that was wanted is carried out
 * on {@link ResolvedRelation.declined} for the log.
 *
 * A directed relation with no subject is declined for the same reason: the
 * direction is the claim. `parent_of` pointing the wrong way is not a vaguer
 * answer than `resembles`, it is a false one, and it looks exactly like a true
 * one.
 */
export function resolveRelation(
  candidate: {
    readonly sourceNode: string;
    readonly targetNode: string;
    readonly relation: string;
  },
  verdict: Pick<Verdict, "relation" | "subject">,
): ResolvedRelation {
  const fallback: ResolvedRelation = {
    relation: candidate.relation,
    sourceNode: candidate.sourceNode,
    targetNode: candidate.targetNode,
    symmetric: inferredRelation(candidate.relation)?.symmetric ?? true,
    declined: null,
  };

  const requested = canonicalRelation(verdict.relation);
  if (requested === null) return fallback;

  const spec = inferredRelation(requested);
  if (spec === null) {
    return { ...fallback, declined: { requested, why: "unknown_relation" } };
  }
  if (spec.symmetric) {
    return { ...fallback, relation: spec.relation, symmetric: true };
  }
  if (verdict.subject !== "A" && verdict.subject !== "B") {
    return { ...fallback, declined: { requested, why: "no_direction" } };
  }

  const forwards = verdict.subject === "A";
  return {
    relation: spec.relation,
    sourceNode: forwards ? candidate.sourceNode : candidate.targetNode,
    targetNode: forwards ? candidate.targetNode : candidate.sourceNode,
    symmetric: false,
    declined: null,
  };
}

/**
 * The sentence a declined relation leaves in the dream log.
 *
 * In the LOG and never on the edge. The reasoning the Commander reads is the
 * part that was already good, and vocabulary bookkeeping is telemetry about the
 * judgment rather than part of the inference — constraint 7's line, one layer
 * in. It is also the only place the nomination survives, so it is the evidence
 * behind any future widening of {@link INFERRED_RELATIONS}.
 */
function declinedNote(declined: DeclinedRelation, written: string): string {
  const why =
    declined.why === "unknown_relation"
      ? `is not in the inferred-relation vocabulary`
      : `is directed and the judgment did not say which memory is the subject`;
  return (
    `[relation] The judgment asked for "${declined.requested}", which ${why}, so the ` +
    `connection was filed as "${written}".`
  );
}

/** What actually happened to the graph, which is not always what was asked. */
export interface AppliedVerdict {
  /** What was DONE, which differs from the verdict when a rediscovery is found. */
  readonly disposition: DreamDisposition;
  readonly edge: MemoryEdge | null;
  readonly reasoningId: number;
  /** True when the store refused a duplicate and the breach was logged. */
  readonly duplicateRecorded: boolean;
}

export interface ApplyVerdict {
  readonly sessionId: string;
  readonly turnIndex?: number | null;
  readonly candidate: SweepCandidate;
  readonly verdict: Verdict;
  readonly now?: number;
}

// ---------------------------------------------------------------------------
// The local day
// ---------------------------------------------------------------------------

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Reject anything that is not an IANA zone name.
 *
 * `Intl` alone is not enough: modern Node accepts `"+05:00"` as a `timeZone`,
 * so a fixed offset sails through the obvious check and then drifts an hour at
 * the next DST boundary. Constraint 5.
 */
function assertIanaZone(tz: string): void {
  if (tz !== "UTC" && !tz.includes("/")) {
    throw new SweepError(
      "bad_timezone",
      `"${tz}" is not an IANA timezone. Store a place (America/Chicago), never an offset: ` +
        `an offset is a property of an instant, not of a place.`,
    );
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    throw new SweepError("bad_timezone", `"${tz}" is not a timezone this runtime knows.`);
  }
}

/** How far the zone is ahead of UTC at an instant, to the minute. */
function zoneOffsetMs(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(at));

  const read = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? 0 : Number(value);
  };
  const asIfUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"));
  return asIfUtc - Math.floor(at / 60_000) * 60_000;
}

/**
 * The instant a local calendar day began in a zone.
 *
 * Two passes, because the offset depends on the instant being solved for: guess
 * with the offset at the naive timestamp, then correct with the offset at the
 * guess. That converges everywhere outside a DST gap, and midnight is inside
 * one only in zones that spring forward at midnight — where the correct answer
 * is the instant the day actually started, which is what the second pass gives.
 *
 * @throws {SweepError} `bad_night`, `bad_timezone`.
 */
export function startOfLocalDay(date: string, tz: string): number {
  assertIanaZone(tz);
  const match = CALENDAR_DATE.exec(date);
  if (match === null) {
    throw new SweepError("bad_night", `"${date}" is not a calendar date (YYYY-MM-DD).`);
  }

  const naive = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const guess = naive - zoneOffsetMs(naive, tz);
  return naive - zoneOffsetMs(guess, tz);
}

// ---------------------------------------------------------------------------
// Projecting graph nodes into the holographic engine
// ---------------------------------------------------------------------------

/** A node's text, as the encoder should see it. */
function contentOf(node: MemoryNode): string {
  return node.body === null || node.body.trim() === "" ? node.label : `${node.label}. ${node.body}`;
}

/**
 * The entities a node participates with: the labels of everything an edge joins
 * it to, in the hot tier.
 *
 * This is what makes `related` and `contradict` see STRUCTURE rather than
 * words. Two facts that share no keyword and no embedding neighbourhood still
 * score together when the same person, goal or source plays the same role in
 * both — which is exactly the link an embedding cannot find.
 */
function entitiesOf(graph: MemoryGraph, node: MemoryNode): readonly string[] {
  const around = graph.neighbourhood(node.id, { depth: 1, limit: 32 });
  const labels = new Set<string>();
  for (const other of around.nodes) {
    if (other.id === node.id) continue;
    labels.add(other.label.toLowerCase());
  }
  return [...labels];
}

function holoFactOf(node: MemoryNode, entities: readonly string[]): HoloFact {
  return encodeHoloFact({
    id: node.id,
    content: contentOf(node),
    entities,
    // Trust is a column of `memory_nodes` that `MemoryGraph` does not expose,
    // so every fact is weighted equally here. Threading it through would change
    // ranking, and ranking is the thing this tier is for — a follow-up, not a
    // silent default.
    trust: 1,
  });
}

/** The identity of a proposal, so two kernels cannot nominate it twice. */
function keyOf(candidate: {
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly relation: string;
}): string {
  return `${candidate.sourceNode}|${candidate.targetNode}|${candidate.relation}`;
}

/**
 * Put a symmetric pair in a fixed order.
 *
 * Without this "a resembles b" and "b resembles a" are two different edge
 * identities, so a night could write both and the second would never be seen as
 * a rediscovery of the first.
 */
function orderPair(a: string, b: string): readonly [string, string] {
  return a <= b ? [a, b] : [b, a];
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export class DreamSweep {
  readonly #graph: MemoryGraph;
  readonly #log: DreamLog;
  readonly #weights: EdgeWeights;
  readonly #clock: Clock;
  readonly #semantic: SemanticProposer | null;
  readonly #limits: SweepLimits;

  constructor(options: DreamSweepOptions) {
    this.#graph = options.graph;
    this.#log = options.log;
    this.#clock = options.clock ?? systemClock;
    this.#weights =
      options.weights ??
      new EdgeWeights({ graph: options.graph, ...(options.clock ? { clock: options.clock } : {}) });
    this.#semantic = options.semantic ?? null;
    this.#limits = { ...DEFAULT_SWEEP_LIMITS, ...options.limits };
  }

  /** The bounds this instance is running under. */
  get limits(): SweepLimits {
    return this.#limits;
  }

  /**
   * The store this sweep writes through.
   *
   * Exposed so Tier 2 can resolve a candidate's endpoints for the prompt
   * without being handed a second graph that might not be the same one.
   */
  get graph(): MemoryGraph {
    return this.#graph;
  }

  /**
   * The whole of Tier 1: cross the floor, then propose.
   *
   * Demotion goes first so the candidate scan reads a hot partition that has
   * already shed what no longer belongs in it — and so a night that proposes
   * nothing still records the crossings it made.
   */
  async run(options: RunSweep): Promise<SweepReport> {
    const now = options.now ?? this.#clock();
    const demoted = this.demote(options.sessionId, now);
    const seeds = this.seedsOf(options.night, options.tz, now);
    const candidates = await this.propose(seeds);

    this.#log.recordCounts(options.sessionId, { candidatesProposed: candidates.length });

    return { demoted, seeds, candidates };
  }

  /**
   * Move every hot edge past its crossing instant into the cold partition, and
   * **tell the log how many moved**.
   *
   * The count is free — it is the `changes` the statement already returns — and
   * without it the growth of the cold set is invisible however fast it grows.
   * "reactivated 0, demoted 900" and "reactivated 0, demoted 0" are very
   * different nights and read identically otherwise.
   *
   * The demotion statement itself lives in `graph.ts`, in exactly one copy,
   * because it must clear `demote_after` as it moves a row: the demote index is
   * PARTIAL on `demote_after IS NOT NULL` and says nothing about tier, so an
   * edge whose tier moved while its stamp stayed behind sits in that index
   * forever. Re-implementing it here is the way that goes wrong.
   */
  demote(sessionId: string, now: number = this.#clock()): number {
    const moved = this.#weights.sweep(now);
    this.#log.recordCounts(sessionId, { edgesDemoted: moved });
    return moved;
  }

  /**
   * The day's memories, newest first and bounded.
   *
   * A SCAN, so it reads the hot partition. Nodes are filtered by `created_at`
   * rather than `updated_at`: the sweep consolidates NEW experience, and a node
   * touched today that was formed in March is not new experience.
   */
  seedsOf(night: string, tz: string, now: number = this.#clock()): MemoryNode[] {
    const since = instant(startOfLocalDay(night, tz));
    const until = instant(now);
    return this.#graph
      .listNodes({ limit: Math.max(this.#limits.seedLimit * 4, this.#limits.seedLimit) })
      .filter((node) => node.createdAt >= since && node.createdAt <= until)
      .slice(0, this.#limits.seedLimit);
  }

  /**
   * Score the day against existing memory and nominate pairs.
   *
   * Every proposal is annotated with the edge that already joins the pair, in
   * any partition, so the judgment knows whether it is looking at something new
   * or at something it has forgotten.
   */
  async propose(seeds: readonly MemoryNode[]): Promise<SweepCandidate[]> {
    if (seeds.length === 0) return [];

    const seedIds = new Set(seeds.map((seed) => seed.id));
    const pool = this.#pool(seeds);
    const byId = new Map(pool.map((node) => [node.id, node]));

    const entitiesByNode = new Map<string, readonly string[]>();
    const facts = pool.map((node) => {
      const entities = entitiesOf(this.#graph, node);
      entitiesByNode.set(node.id, entities);
      return holoFactOf(node, entities);
    });

    const found = new Map<string, SweepCandidate>();
    const add = (
      a: string,
      b: string,
      relation: string,
      kernel: CandidateKernel,
      score: number,
    ): void => {
      if (a === b) return;
      if (found.size >= this.#limits.maxCandidates) return;
      const [sourceNode, targetNode] = orderPair(a, b);
      const key = keyOf({ sourceNode, targetNode, relation });
      if (found.has(key)) return;
      found.set(key, {
        sourceNode,
        targetNode,
        relation,
        kernel,
        symmetric: true,
        score,
        existing: null,
      });
    };

    // related(): the kernel that finds a link with no keyword and no embedding
    // overlap. This is the real value of the holographic half — two facts joined
    // because the same entity plays the same role in both.
    //
    // The probe is an ENTITY the seed participates with, never the seed's own
    // label. See `SweepLimits.entitiesPerSeed`.
    for (const seed of seeds) {
      const entities = (entitiesByNode.get(seed.id) ?? []).slice(0, this.#limits.entitiesPerSeed);
      let taken = 0;
      for (const entity of entities) {
        if (taken >= this.#limits.perSeed) break;
        for (const hit of related(facts, entity, { limit: this.#limits.perSeed + 1 })) {
          if (taken >= this.#limits.perSeed) break;
          if (hit.id === seed.id) continue;
          if (hit.score < this.#limits.minRelatedScore) continue;
          add(seed.id, hit.id, RELATED_RELATION, "related", hit.score);
          taken += 1;
        }
      }
    }

    // contradict(): same subjects, divergent claims. A proposal, never a
    // verdict — a bag-of-words encoder cannot see negation, so "the backend
    // restarts cleanly" and "the backend never restarts" look like two
    // unrelated statements about the backend. The model rules on it.
    const clashes = contradict(facts, {
      limit: this.#limits.maxCandidates,
      threshold: this.#limits.minContradictionScore,
      maxFacts: this.#limits.poolLimit,
    });
    for (const clash of clashes) {
      if (!seedIds.has(clash.a) && !seedIds.has(clash.b)) continue;
      add(clash.a, clash.b, CONTRADICT_RELATION, "contradict", clash.contradictionScore);
    }

    // The embedding half, which finds the synonym link the structural kernels
    // are blind to. Run both: they fail in opposite directions.
    if (this.#semantic !== null) {
      for (const seed of seeds) {
        const near = await this.#semantic.near(seed, this.#limits.perSeed);
        for (const hit of near) {
          if (hit.nodeId === seed.id) continue;
          add(seed.id, hit.nodeId, RELATED_RELATION, "embedding", hit.similarity);
        }
      }
    }

    return [...found.values()]
      .filter((candidate) => byId.has(candidate.sourceNode) || byId.has(candidate.targetNode))
      .map((candidate) => ({ ...candidate, existing: this.identityOf(candidate) }));
  }

  /**
   * The edge already joining a candidate's pair, in ANY partition.
   *
   * **Never mentions `tier`.** A partition key prunes scans, not identity
   * lookups: `memory_edges_identity_idx` is UNIQUE on
   * `(source_node, target_node, relation)` and deliberately does not lead with
   * the partition key, which is what lets this span cold and suppressed at
   * O(log n). A hot-only check here does not error — it silently inserts a
   * duplicate beside a dormant edge that keeps its history and stays invisible
   * forever.
   */
  identityOf(candidate: {
    readonly sourceNode: string;
    readonly targetNode: string;
    readonly relation: string;
    readonly symmetric?: boolean;
  }): MemoryEdge | null {
    if (candidate.symmetric === false) {
      return this.#graph.findEdge(candidate.sourceNode, candidate.targetNode, candidate.relation);
    }
    // `edgesBetween` is the same tier-free lookup in both directions, which is
    // what a symmetric relation's identity actually is.
    return (
      this.#graph
        .edgesBetween(candidate.sourceNode, candidate.targetNode)
        .find((edge) => edge.relation === candidate.relation) ?? null
    );
  }

  /**
   * Carry out what the judgment decided, and record why — in both stores.
   *
   * The disposition RETURNED is what actually happened, which is not always
   * what was asked: a `created` verdict on a pair that turns out to already
   * have a dormant edge is a **reactivation**, because the dream rediscovering
   * a forgotten connection is itself the evidence it mattered.
   *
   * @throws {SweepError} `bad_reasoning`, `nothing_to_suppress`,
   * `unusable_candidate`.
   */
  applyVerdict(input: ApplyVerdict): AppliedVerdict {
    const { sessionId, candidate, verdict } = input;
    const turnIndex = input.turnIndex ?? null;
    const now = input.now ?? this.#clock();

    const reasoning = verdict.reasoning.trim();
    if (reasoning === "") {
      throw new SweepError(
        "bad_reasoning",
        `A ${verdict.disposition} verdict with no reasoning cannot be audited, pruned ` +
          `intelligently, or shown to the Commander — and showing him is the entire value. ` +
          `Reasoning is mandatory, never optional.`,
      );
    }

    // The relation, the direction, and whether the judgment asked for something
    // the vocabulary does not hold. `symmetric` is carried onto the target
    // because `identityOf` reads it: a directed relation must NOT match its own
    // reverse, or the direction would be decided by whichever night ran first.
    const resolved = resolveRelation(candidate, verdict);
    const relation = resolved.relation;
    const target: SweepCandidate = {
      ...candidate,
      sourceNode: resolved.sourceNode,
      targetNode: resolved.targetNode,
      relation,
      symmetric: resolved.symmetric,
    };
    // The log's copy, never the edge's. See `declinedNote`.
    const logged =
      resolved.declined === null
        ? reasoning
        : `${reasoning} ${declinedNote(resolved.declined, relation)}`;

    if (verdict.disposition === "rejected") {
      return this.#justRecord(sessionId, turnIndex, target, "rejected", logged, verdict.confidence, {
        tierBefore: candidate.existing?.tier ?? null,
        tierAfter: candidate.existing?.tier ?? null,
      });
    }

    // A fresh lookup rather than the annotation the candidate arrived with:
    // hours of judgment turns may have passed since the sweep proposed it, and
    // this is the check that stops a duplicate.
    const existing = this.identityOf(target);

    if (verdict.disposition === "suppressed") {
      if (existing === null) {
        throw new SweepError(
          "nothing_to_suppress",
          `Suppression is a move, not a write: there is no edge ${target.sourceNode} ` +
            `—${relation}→ ${target.targetNode} to move. A connection that was never made ` +
            `is rejected, not suppressed.`,
        );
      }
      const moved = existing.tier === "suppressed" ? existing : this.#weights.reject(existing);
      const row = this.#log.recordReasoning({
        sessionId,
        turnIndex,
        disposition: "suppressed",
        edgeId: moved.id,
        sourceNode: target.sourceNode,
        targetNode: target.targetNode,
        tierBefore: existing.tier as MemoryTier,
        tierAfter: moved.tier as MemoryTier,
        reasoning: logged,
        confidence: verdict.confidence ?? null,
      });
      this.#log.recordCounts(sessionId, { candidatesJudged: 1, edgesSuppressed: 1 });
      return { disposition: "suppressed", edge: moved, reasoningId: row.id, duplicateRecorded: false };
    }

    if (existing !== null) {
      return this.#reactivateOrRefuse(sessionId, turnIndex, target, existing, logged, verdict, false);
    }

    // Nothing found, so write one. If the store refuses it, the identity lookup
    // is broken and the breach has to be recorded — silence here produces the
    // same zero as a night that never hit one.
    let created: InferredEdge;
    try {
      created = this.#write(target, reasoning, verdict.confidence ?? 0.5, now);
    } catch (cause) {
      if (cause instanceof GraphError && cause.kind === "duplicate_edge") {
        return this.#recordBreach(sessionId, turnIndex, target, logged, verdict, cause);
      }
      throw new SweepError(
        "unusable_candidate",
        `${target.sourceNode} —${relation}→ ${target.targetNode} could not be written: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    const row = this.#log.recordReasoning({
      sessionId,
      turnIndex,
      disposition: "created",
      edgeId: created.id,
      sourceNode: target.sourceNode,
      targetNode: target.targetNode,
      tierBefore: null,
      tierAfter: created.tier as MemoryTier,
      reasoning: logged,
      confidence: verdict.confidence ?? null,
    });
    this.#log.recordCounts(sessionId, { candidatesJudged: 1, edgesCreated: 1 });
    return { disposition: "created", edge: created, reasoningId: row.id, duplicateRecorded: false };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** The hot nodes scored against the day, with the day itself at the front. */
  #pool(seeds: readonly MemoryNode[]): MemoryNode[] {
    const seedIds = new Set(seeds.map((seed) => seed.id));
    const rest = this.#graph
      .listNodes({ limit: this.#limits.poolLimit })
      .filter((node) => !seedIds.has(node.id));
    // Seeds first, because `contradict` truncates to `maxFacts` by keeping the
    // FIRST entries — so the order this list is built in decides what survives.
    return [...seeds, ...rest].slice(0, this.#limits.poolLimit);
  }

  /**
   * The one place an inferred edge enters the graph, and therefore the one
   * place the vocabulary has to hold.
   *
   * {@link resolveRelation} already refuses anything outside
   * {@link INFERRED_RELATIONS} that came from the JUDGMENT. This guards the
   * other half — a candidate whose own relation is not in the vocabulary,
   * which is what a corrupted checkpoint or a future kernel would look like.
   * Guarding at the door rather than at the parser is the difference between a
   * loud failure and a free-text relation walking in behind the parser's back.
   */
  #write(
    target: { readonly sourceNode: string; readonly targetNode: string; readonly relation: string },
    reasoning: string,
    confidence: number,
    now: number,
  ): InferredEdge {
    if (!isInferredRelation(target.relation)) {
      throw new SweepError(
        "unusable_candidate",
        `"${target.relation}" is not an inferred relation. The vocabulary is closed so that ` +
          `edges GROUP — forty relations each invented once are as untraversable as one label ` +
          `used everywhere. Expected one of ${INFERRED_RELATION_SPECS.map((spec) => spec.relation).join(", ")}.`,
      );
    }
    // The weight a fresh inference starts at, and the instant it will cross the
    // floor, both come from the weight law rather than from a literal here.
    const weight = Math.min(1, Math.max(this.#weights.law.relevanceFloor * 2, confidence));
    return this.#graph.infer({
      sourceNode: target.sourceNode,
      targetNode: target.targetNode,
      relation: target.relation,
      reasoning,
      confidence,
      weight,
      demoteAfter: crossingInstant(weight, now, this.#weights.law),
    });
  }

  /**
   * Boost what was already there — unless the Commander rejected it.
   *
   * Reactivation is `EdgeWeights.touch(edge, "traversal")`: a JUMP to the law's
   * floor rather than a multiplication, because `0.0001 × 2` is still
   * invisible. Syl's own rediscovery is the *internal* touch source and is
   * capped strictly below what the Commander's engagement can reach — a closed
   * loop with no external term converges on whatever it started believing.
   */
  #reactivateOrRefuse(
    sessionId: string,
    turnIndex: number | null,
    target: SweepCandidate,
    existing: MemoryEdge,
    reasoning: string,
    verdict: Verdict,
    duplicateRecorded: boolean,
  ): AppliedVerdict {
    if (existing.tier === "suppressed") {
      const row = this.#log.recordReasoning({
        sessionId,
        turnIndex,
        disposition: "rejected",
        edgeId: null,
        sourceNode: target.sourceNode,
        targetNode: target.targetNode,
        tierBefore: "suppressed",
        tierAfter: "suppressed",
        reasoning:
          `Refused: this connection is suppressed — the Commander said it is wrong, and ` +
          `reflection does not get to overrule that. The dream's reasoning was: ${reasoning}`,
        confidence: verdict.confidence ?? null,
      });
      this.#log.recordCounts(sessionId, { candidatesJudged: 1 });
      return { disposition: "rejected", edge: existing, reasoningId: row.id, duplicateRecorded };
    }

    const before = existing.tier as MemoryTier;
    const touched = this.#weights.touch(existing, "traversal");
    const row = this.#log.recordReasoning({
      sessionId,
      turnIndex,
      disposition: "reactivated",
      edgeId: touched.id,
      sourceNode: target.sourceNode,
      targetNode: target.targetNode,
      tierBefore: before,
      tierAfter: touched.tier as MemoryTier,
      reasoning,
      confidence: verdict.confidence ?? null,
    });
    this.#log.recordCounts(sessionId, { candidatesJudged: 1, edgesReactivated: 1 });
    return { disposition: "reactivated", edge: touched, reasoningId: row.id, duplicateRecorded };
  }

  /**
   * The store refused a duplicate, so the identity lookup missed something.
   *
   * Recorded with the clashing edge's TIER, because the three values are three
   * different bugs: `hot` is a lookup broken outright, `cold` is one that
   * skipped the dormant partition, and `suppressed` is reflection trying to
   * resurrect something the Commander explicitly rejected — a trust failure
   * rather than a performance bug, and it must be loud.
   */
  #recordBreach(
    sessionId: string,
    turnIndex: number | null,
    target: SweepCandidate,
    reasoning: string,
    verdict: Verdict,
    cause: GraphError,
  ): AppliedVerdict {
    // Deliberately NOT `identityOf` first: that is the check which just missed
    // it, and asking a broken lookup to diagnose itself produces "existing_tier:
    // null", which is the one value that says nothing. Both exact identities
    // are tried explicitly before falling back.
    //
    // The REVERSED lookup only for a symmetric relation. `B parent_of A` is not
    // a clashing spelling of `A parent_of B`, it is a different claim about a
    // different pair of roles — and treating it as the clash would hand
    // `#reactivateOrRefuse` an unrelated edge to boost.
    const reversed = target.symmetric
      ? this.#graph.findEdge(target.targetNode, target.sourceNode, target.relation)
      : null;
    const clash =
      this.#graph.findEdge(target.sourceNode, target.targetNode, target.relation) ??
      reversed ??
      this.identityOf(target);

    const suppressed = clash?.tier === "suppressed";
    this.#log.recordDuplicateEdgeInsert({
      sessionId,
      turnIndex,
      sourceNode: target.sourceNode,
      targetNode: target.targetNode,
      existingEdgeId: clash?.id ?? "unknown",
      existingTier: (clash?.tier ?? null) as MemoryTier | null,
      // Nothing was inserted: the UNIQUE index refused it. The breach is that
      // the check missed it, not that the graph now holds two edges.
      insertedEdgeId: null,
      note: suppressed
        ? `The identity check missed a SUPPRESSED edge and the sweep tried to write over a ` +
          `connection the Commander explicitly rejected. This is a trust failure, not a ` +
          `performance bug. (${cause.message})`
        : `The identity check missed an existing ${clash?.tier ?? "unknown"} edge; the UNIQUE ` +
          `index refused the insert. Dormant connections are being re-proposed instead of ` +
          `reactivated. (${cause.message})`,
    });

    if (clash === null) {
      throw new SweepError("unusable_candidate", cause.message, { cause });
    }
    return this.#reactivateOrRefuse(sessionId, turnIndex, target, clash, reasoning, verdict, true);
  }

  /** A disposition that touches the log and nothing else. */
  #justRecord(
    sessionId: string,
    turnIndex: number | null,
    target: SweepCandidate,
    disposition: DreamDisposition,
    reasoning: string,
    confidence: number | undefined,
    tiers: { readonly tierBefore: string | null; readonly tierAfter: string | null },
  ): AppliedVerdict {
    const row = this.#log.recordReasoning({
      sessionId,
      turnIndex,
      disposition,
      edgeId: null,
      sourceNode: target.sourceNode,
      targetNode: target.targetNode,
      tierBefore: tiers.tierBefore as MemoryTier | null,
      tierAfter: tiers.tierAfter as MemoryTier | null,
      reasoning,
      confidence: confidence ?? null,
    });
    this.#log.recordCounts(sessionId, { candidatesJudged: 1 });
    return { disposition, edge: null, reasoningId: row.id, duplicateRecorded: false };
  }
}
