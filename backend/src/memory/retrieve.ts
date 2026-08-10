import { instant, systemClock, parseInstant, type Clock } from "../services/clock.js";
import type { Database } from "../services/sqlite.js";
import type { Embedder } from "./embed.js";
import { MemoryGraph, type MemoryEdge, type MemoryNode } from "./graph.js";
import { DEFAULT_DIM } from "./holographic.js";
import { encodeHoloFact, related, type HoloFact } from "./holographic-queries.js";
import type { MemoryNodeKind } from "./schema.js";
import { MemoryStore, type KeywordHit, type VectorHit } from "./store.js";

/**
 * Ranking over the hybrid store, and the trust the Commander moves by using it.
 *
 *     relevance = 0.4*keyword + 0.3*overlap + 0.3*holographic
 *     final     = relevance * trust * decay(age)
 *
 *
 * ## Retrieval is TRAVERSAL, not lookup
 *
 * The question is never "find me this fact". It is "what do I know about this,
 * and what does it touch". Keyword and vector search find ENTRY POINTS; the
 * graph walk gathers the neighbourhood, and the neighbourhood is the answer.
 * {@link Retriever.retrieve} returns both, and a caller that reads only
 * `entries` has used a search engine and left the graph on the table.
 *
 *
 * ## The three channels, and what each is blind to
 *
 * | channel        | finds                          | cannot see                    |
 * | -------------- | ------------------------------ | ----------------------------- |
 * | `keyword`      | the words he actually used     | synonyms, paraphrase          |
 * | `overlap`      | meaning, paraphrase, synonyms  | structure; anything unstated  |
 * | `holographic`  | shared structural role         | meaning — it is bag-of-words  |
 *
 * They are fused rather than chained because each one's blind spot is another's
 * strength. `car`/`automobile` is invisible to keyword and trivial to overlap;
 * two facts sharing an entity and no vocabulary at all are invisible to both
 * and are exactly what the holographic algebra sees.
 *
 *
 * ## The weights sum to 1.0 and a channel is often unavailable. It is NOT
 * ## renormalised, and that is the decision, not an oversight
 *
 * A query with no searchable token has no keyword channel. A retriever built
 * without an embedder has no overlap channel. A query that names no entity has
 * no holographic channel — and it is the common case, because the holographic
 * kernels take an ENTITY and a person asks a question.
 *
 * The obvious move is to renormalise: drop the missing weight and scale the
 * rest back up to 1.0. It is wrong, and quietly:
 *
 * - **It changes what a score means between queries.** 0.7 from two channels
 *   and 0.7 from three would be the same number describing different amounts of
 *   evidence. Any absolute threshold — "surface this unprompted", "worth waking
 *   him for" — is then calibrated against a moving target.
 * - **It manufactures confidence.** A single channel scoring 0.6 renormalises
 *   to 0.6 out of 1.0, indistinguishable from three channels agreeing at 0.6.
 *   One weak vote should not read as unanimity.
 * - **It cannot be detected downstream.** A renormalised score carries no trace
 *   of what was missing.
 *
 * So: **an absent channel contributes exactly zero and the weights are never
 * touched.** Within one query every candidate loses the same weight, so the
 * ORDERING — the thing retrieval is actually for — is unaffected. Across
 * queries, a two-channel result honestly caps at 0.7, and every result carries
 * {@link FusedRelevance.channels} and {@link FusedRelevance.ceiling} so a
 * caller that genuinely needs a normalised value computes it explicitly instead
 * of having it happen behind its back.
 *
 *
 * ## Which holographic kernels may be used, and which may not
 *
 * `related()` and `contradict()` work. `reason()` and `probe()` **do not** —
 * they score every fact between 0.489 and 0.510, the noise floor, and rank
 * inverted often enough that `reason(['Grace'])` puts the fact WITHOUT Grace
 * first. Verified digit-for-digit against the Python original, so it is an
 * inherited upstream defect and not a porting error; tracked as `syl-b97` with
 * three RED acceptance tests already declared.
 *
 * Only `related()` is wired in here. Feeding a ranker a channel that is pure
 * noise dressed as signal is worse than having no third channel at all, because
 * the fused score would still look like three-channel evidence.
 *
 *
 * ## Trust is asymmetric, and the asymmetry is the point
 *
 * Helpful nudges up; unhelpful pushes down TWICE AS HARD. A wrong memory
 * surfaced confidently costs far more than a right one ranked slightly low — he
 * acts on the first and merely scrolls past the second — so the default has to
 * punish the expensive error. See {@link trustAfterFeedback}.
 */

/** The three channels, and the weights the bead fixes. They sum to 1.0. */
export const FUSION_WEIGHTS = Object.freeze({
  keyword: 0.4,
  overlap: 0.3,
  holographic: 0.3,
});

/** One of the three fused channels. */
export type RetrievalChannel = keyof typeof FUSION_WEIGHTS;

/** Every channel, in the order the formula states them. */
export const RETRIEVAL_CHANNELS: readonly RetrievalChannel[] = Object.freeze([
  "keyword",
  "overlap",
  "holographic",
]);

/** The Commander's verdict on a memory Syl surfaced. */
export type FeedbackVerdict = "helpful" | "unhelpful";

/**
 * A brand-new memory's trust: not certain, merely unjudged.
 *
 * Deliberately below the ceiling. Starting at 1.0 would make "this helped" a
 * no-op for every memory that had never been marked wrong, which is most of
 * them — the reward would be unreachable and only the punishment would work.
 *
 * Must match the DEFAULT in `0015_memory_retrieval.sql`; a test asserts it does.
 */
export const DEFAULT_TRUST = 0.8;

/** The ceiling. Trust is a multiplier and must never inflate a relevance. */
export const MAX_TRUST = 1;

/**
 * The floor.
 *
 * Never zero, and for the same reason `weight` and `confidence` are never zero
 * in `0012`: a memory whose trust reached zero would score zero forever and
 * could not be re-earned, which is pruning with extra steps. At 0.05 a
 * thoroughly distrusted memory still surfaces when nothing else matches, which
 * is what "demote, never prune" means for ranking.
 */
export const MIN_TRUST = 0.05;

/**
 * How far one piece of feedback moves trust, as a multiplier.
 *
 * Helpful multiplies by this; unhelpful divides by its SQUARE. Expressed
 * geometrically rather than as `t + s(1-t)` / `t - 2s*t` because the
 * multiplicative form is **exactly twice as far in both directions at every
 * trust level**. The linear-asymptotic form is only 2:1 at t = 0.5 and drifts
 * everywhere else, so "twice as hard" would be true of the constant and not of
 * the behaviour.
 *
 * At 1.1 it takes 15 unhelpful verdicts to drive a fresh memory to the floor
 * and 32 helpful ones to bring it back — a 2.1:1 round trip, which is the
 * asymmetry doing exactly what it was asked to.
 */
export const TRUST_STEP = 1.1;

/**
 * How long a memory takes to lose half its ranking weight to age.
 *
 * 90 days. Long enough that a project running for a quarter is still current at
 * the end of it, short enough that last year's priorities do not outrank this
 * week's. This is retrieval's decay over a node's age and is deliberately NOT
 * the inferred-edge weight law, which is `syl-005.3.2`'s and operates on a
 * different quantity — an edge's confidence, with a scheduled floor crossing
 * that moves the row between partitions. Nothing here writes a tier.
 */
export const DEFAULT_HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

/** How many memories a retrieval returns when nobody says. */
export const DEFAULT_RETRIEVAL_LIMIT = 10;

/** How many candidates each channel proposes before fusion. */
export const DEFAULT_CANDIDATE_LIMIT = 50;

/** How many hops the traversal walks out from each entry point. */
export const DEFAULT_TRAVERSAL_DEPTH = 1;

/** How many entry points the traversal walks from. */
export const DEFAULT_TRAVERSAL_ENTRIES = 5;

/** Thrown when a retrieval or a feedback write cannot be performed as asked. */
export class RetrievalError extends Error {
  readonly kind: "bad_limit" | "bad_trust" | "bad_verdict" | "unknown_node";

  constructor(kind: RetrievalError["kind"], message: string) {
    super(message);
    this.name = "RetrievalError";
    this.kind = kind;
  }
}

/** A fused relevance, with what went into it. */
export interface FusedRelevance {
  /** The weighted sum. In [0, {@link FusedRelevance.ceiling}]. */
  readonly relevance: number;
  /** Channels that actually contributed, in formula order. */
  readonly channels: readonly RetrievalChannel[];
  /**
   * The largest `relevance` this combination of channels could produce — the
   * weights of the contributing channels, summed. 1.0 with all three.
   *
   * Read this before comparing a relevance against a fixed threshold.
   */
  readonly ceiling: number;
}

/**
 * A per-channel score in [0, 1]. An absent key means the channel had nothing to
 * say about this candidate; a present zero means it looked and found nothing.
 */
export type Contributions = Readonly<Partial<Record<RetrievalChannel, number>>>;

/**
 * Fuse the channels.
 *
 * Weights are never renormalised — see the module header. A contribution
 * outside [0, 1] is clamped rather than refused: every producer already clamps,
 * and a ranking that throws mid-scan because one similarity came back at
 * 1.0000000001 would be worse than one that is right to fifteen places.
 */
export function fuse(
  contributions: Contributions,
  weights: Readonly<Record<RetrievalChannel, number>> = FUSION_WEIGHTS,
): FusedRelevance {
  let relevance = 0;
  let ceiling = 0;
  const channels: RetrievalChannel[] = [];

  for (const channel of RETRIEVAL_CHANNELS) {
    const value = contributions[channel];
    if (value === undefined) continue;
    const weight = weights[channel];
    channels.push(channel);
    ceiling += weight;
    relevance += weight * clamp01(value);
  }

  return { relevance, channels, ceiling };
}

/**
 * FTS5's BM25 as a [0, 1] score.
 *
 * BM25 out of FTS5 is NEGATED — more negative is better — and unbounded, so it
 * cannot be used as a weighted term directly. It is normalised against the best
 * score in the same result set, which makes the top hit 1.0 and everything else
 * a fraction of it.
 *
 * That is a within-query normalisation and it is the honest one available:
 * BM25 has no absolute scale, because it depends on the corpus statistics of
 * the moment. It means the keyword channel measures "how much better is the
 * best match than this one", which is what ranking needs, and it means a
 * one-hit result set always scores 1.0 on this channel — correct, since there
 * is nothing it could be worse than.
 *
 * @param best the most negative BM25 in the set. Zero or positive yields zero
 * for everything, which is the degenerate case where FTS5 found no signal.
 */
export function normaliseKeyword(bm25: number, best: number): number {
  if (!Number.isFinite(bm25) || !Number.isFinite(best) || best >= 0) return 0;
  return clamp01(bm25 / best);
}

/**
 * How much of its ranking weight a memory has lost to age.
 *
 * Exponential half-life: `2^(-age / halfLife)`. Asymptotic to zero and never
 * arriving, the same shape and the same reason as the edge weight law — a
 * memory that decayed to exactly zero could never be brought back by anything.
 *
 * A negative age (a stamp in the future, which a clock skew produces) yields 1
 * rather than a number above it. Decay is allowed to reduce a score and never
 * to inflate one.
 */
export function decay(ageMs: number, halfLifeMs: number = DEFAULT_HALF_LIFE_MS): number {
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {
    throw new RetrievalError(
      "bad_limit",
      `A half-life must be a positive number of milliseconds, got ${String(halfLifeMs)}.`,
    );
  }
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  return 2 ** (-ageMs / halfLifeMs);
}

/**
 * Trust after one verdict. **Unhelpful moves twice as far as helpful.**
 *
 *     helpful    t -> min(MAX_TRUST, t * TRUST_STEP)
 *     unhelpful  t -> max(MIN_TRUST, t / TRUST_STEP^2)
 *
 * The asymmetry is the correct default for an assistant and not a preference: a
 * wrong memory surfaced confidently costs far more than a right one ranked
 * slightly low. He acts on the first; he scrolls past the second. So the cheap
 * error is punished cheaply and the expensive one is punished twice as hard.
 *
 * Geometric rather than linear, and it is worth being exact about in what sense
 * "twice" holds. In LOG space the two steps are precisely `ln(TRUST_STEP)` and
 * `-2 ln(TRUST_STEP)` at every trust level. In absolute terms the ratio is the
 * constant `(1 - 1/s^2)/(s - 1)` = 1.7355 for s = 1.1 — also independent of the
 * trust it is applied to.
 *
 * The tempting alternative, `t + s(1-t)` up and `t - 2s*t` down, is 2:1 only at
 * t = 0.5, and it does not merely drift away from that — it REVERSES. At
 * t = 0.9 it punishes eighteen times harder than it rewards; at t = 0.1 it
 * rewards more than it punishes, which is the opposite of the requirement, at
 * exactly the trust level where getting it wrong matters most. Both numbers are
 * computed in `memory-retrieve.test.ts` rather than asserted from memory.
 *
 * Bounded on both sides, and both bounds matter. {@link MAX_TRUST} stops trust
 * from inflating a relevance; {@link MIN_TRUST} stops a memory from being
 * argued down to a score it can never climb back from.
 *
 * @throws {RetrievalError} on a trust outside (0, 1] or an unknown verdict.
 */
export function trustAfterFeedback(trust: number, verdict: FeedbackVerdict): number {
  if (!Number.isFinite(trust) || trust <= 0 || trust > MAX_TRUST) {
    throw new RetrievalError(
      "bad_trust",
      `A trust must be a real number in (0, ${MAX_TRUST}], got ${String(trust)}. Zero is ` +
        `excluded because a memory at zero trust scores zero forever and could never be ` +
        `re-earned, which is pruning with extra steps.`,
    );
  }

  if (verdict === "helpful") return Math.min(MAX_TRUST, trust * TRUST_STEP);
  if (verdict === "unhelpful") return Math.max(MIN_TRUST, trust / (TRUST_STEP * TRUST_STEP));

  throw new RetrievalError(
    "bad_verdict",
    `${JSON.stringify(String(verdict))} is not a verdict. Expected "helpful" or "unhelpful" — ` +
      `two values, because a scale would invite a model to invent gradations he did not express.`,
  );
}

/** `relevance * trust * decay`, the whole of the second line of the formula. */
export function finalScore(relevance: number, trust: number, decayed: number): number {
  return relevance * trust * decayed;
}

/** One memory, ranked. */
export interface RetrievedMemory {
  readonly node: MemoryNode;
  /** The fused, un-renormalised relevance. */
  readonly relevance: number;
  /** The channels that contributed to THIS candidate. */
  readonly channels: readonly RetrievalChannel[];
  /** What each channel said, so a ranking can be explained rather than trusted. */
  readonly contributions: Contributions;
  readonly trust: number;
  /** The age multiplier, in (0, 1]. */
  readonly decay: number;
  /** `relevance * trust * decay`. What the list is sorted by. */
  readonly score: number;
}

/** What a retrieval was asked for. */
export interface RetrievalQuery {
  /** What the Commander typed. Drives keyword and, with an embedder, overlap. */
  readonly text: string;
  /**
   * Entity names for the holographic channel.
   *
   * Without them that channel is UNAVAILABLE and contributes zero — it is not
   * renormalised away. `related()` takes an entity, and a question is not an
   * entity; extracting one from free text is a judgement, and judgement belongs
   * to the model, which can pass what it decided here.
   */
  readonly entities?: readonly string[];
  /** Narrow to one node kind, on the secondary partition axis. */
  readonly kind?: MemoryNodeKind;
  /** How many memories to return. Defaults to {@link DEFAULT_RETRIEVAL_LIMIT}. */
  readonly limit?: number;
  /** How many candidates each channel proposes. */
  readonly candidates?: number;
  /** Hops to walk from each entry point. 0 returns entries with no traversal. */
  readonly depth?: number;
  /** How many top entries to walk out from. */
  readonly entryPoints?: number;
}

/** Entry points, and the neighbourhood they opened onto. */
export interface Retrieval {
  /** The ranked memories, best first. The ENTRY POINTS, not the answer. */
  readonly entries: readonly RetrievedMemory[];
  /** Every node the walk reached, entries included. Fetched by id, so tier-free. */
  readonly nodes: readonly MemoryNode[];
  /** Every edge walked. */
  readonly edges: readonly MemoryEdge[];
  /** Channels that were available for this query at all, in formula order. */
  readonly channels: readonly RetrievalChannel[];
  /** The highest relevance this query could have produced. See {@link FusedRelevance.ceiling}. */
  readonly ceiling: number;
}

/** What one piece of feedback did. */
export interface FeedbackResult {
  readonly nodeId: string;
  readonly verdict: FeedbackVerdict;
  readonly trustBefore: number;
  readonly trustAfter: number;
  readonly at: string;
}

export interface RetrieverOptions {
  readonly db: Database;
  readonly store: MemoryStore;
  readonly graph: MemoryGraph;
  /**
   * The overlap channel. Optional, and its absence is a channel that
   * contributes zero rather than a failure — a retriever with no embedder is
   * exactly the offline configuration every unit test wants.
   */
  readonly embedder?: Embedder;
  readonly clock?: Clock;
  /** Age half-life. Defaults to {@link DEFAULT_HALF_LIFE_MS}. */
  readonly halfLifeMs?: number;
  /** Fusion weights. Defaults to {@link FUSION_WEIGHTS}. */
  readonly weights?: Readonly<Record<RetrievalChannel, number>>;
  /** Holographic dimension. Defaults to `DEFAULT_DIM`. */
  readonly holographicDim?: number;
}

interface Candidate {
  keyword?: number;
  overlap?: number;
  holographic?: number;
}

export class Retriever {
  readonly #db: Database;
  readonly #store: MemoryStore;
  readonly #graph: MemoryGraph;
  readonly #embedder: Embedder | undefined;
  readonly #clock: Clock;
  readonly #halfLifeMs: number;
  readonly #weights: Readonly<Record<RetrievalChannel, number>>;
  readonly #dim: number;

  constructor(options: RetrieverOptions) {
    this.#db = options.db;
    this.#store = options.store;
    this.#graph = options.graph;
    this.#embedder = options.embedder;
    this.#clock = options.clock ?? systemClock;
    this.#halfLifeMs = options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
    this.#weights = options.weights ?? FUSION_WEIGHTS;
    this.#dim = options.holographicDim ?? DEFAULT_DIM;
  }

  /**
   * Find entry points, then walk out from them.
   *
   * The two halves are separate on purpose. Ranking decides where to START; the
   * traversal decides what the answer IS. A caller that wants only the ranked
   * list passes `depth: 0` and gets exactly the search engine — which is a
   * legitimate thing to want and is not what retrieval means here.
   *
   * @throws {RetrievalError} `bad_limit`.
   */
  async retrieve(query: RetrievalQuery): Promise<Retrieval> {
    const limit = requireCount(query.limit ?? DEFAULT_RETRIEVAL_LIMIT, "A limit", 1);
    const candidateLimit = requireCount(
      query.candidates ?? DEFAULT_CANDIDATE_LIMIT,
      "A candidate limit",
      1,
    );
    const depth = requireCount(query.depth ?? DEFAULT_TRAVERSAL_DEPTH, "A traversal depth", 0);
    const entryPoints = requireCount(
      query.entryPoints ?? DEFAULT_TRAVERSAL_ENTRIES,
      "An entry point count",
      1,
    );

    const candidates = new Map<string, Candidate>();
    const available = new Set<RetrievalChannel>();

    const search: { kind?: MemoryNodeKind; limit: number } = { limit: candidateLimit };
    if (query.kind !== undefined) search.kind = query.kind;

    // ── keyword ──────────────────────────────────────────────────────────
    const keywordHits = this.#store.searchKeyword(query.text, search);
    if (keywordHits.length > 0) {
      available.add("keyword");
      const best = bestBm25(keywordHits);
      for (const hit of keywordHits) {
        entry(candidates, hit.nodeId).keyword = normaliseKeyword(hit.bm25, best);
      }
    }

    // ── overlap ──────────────────────────────────────────────────────────
    const vectorHits = await this.#vectorHits(query.text, search);
    if (vectorHits !== null) {
      available.add("overlap");
      for (const hit of vectorHits) entry(candidates, hit.nodeId).overlap = hit.similarity;
    }

    // ── nodes, once, by identity ─────────────────────────────────────────
    const nodes = new Map<string, MemoryNode>();
    for (const id of candidates.keys()) {
      const node = this.#graph.getNode(id);
      if (node !== null) nodes.set(id, node);
    }

    // ── holographic ──────────────────────────────────────────────────────
    if (this.#scoreHolographic(query.entities, nodes, candidates)) available.add("holographic");

    // ── fuse, then rank ──────────────────────────────────────────────────
    const now = this.#clock();
    const ranked: RetrievedMemory[] = [];
    let ceiling = 0;

    for (const [id, contributions] of candidates) {
      const node = nodes.get(id);
      if (node === undefined) continue;

      const fused = fuse(contributions, this.#weights);
      ceiling = Math.max(ceiling, fused.ceiling);

      const trust = this.trustFor(id) ?? DEFAULT_TRUST;
      const decayed = decay(now - stampMs(node.updatedAt, now), this.#halfLifeMs);

      ranked.push({
        node,
        relevance: fused.relevance,
        channels: fused.channels,
        contributions: { ...contributions },
        trust,
        decay: decayed,
        score: finalScore(fused.relevance, trust, decayed),
      });
    }

    // Ties break on id, so a ranking is reproducible rather than dependent on
    // the order two channels happened to propose their candidates in.
    ranked.sort((a, b) => b.score - a.score || (a.node.id < b.node.id ? -1 : 1));
    const entries = ranked.slice(0, limit);

    const walked = this.#walk(entries, depth, entryPoints);

    return {
      entries,
      nodes: walked.nodes,
      edges: walked.edges,
      channels: RETRIEVAL_CHANNELS.filter((channel) => available.has(channel)),
      ceiling,
    };
  }

  /**
   * One node's trust, or `null` if there is no such node.
   *
   * An IDENTITY LOOKUP: no tier predicate. A memory the Commander marked wrong
   * and which has since gone cold still has a trust score, and reading it is
   * how "why is this ranked last" stays answerable.
   */
  trustFor(nodeId: string): number | null {
    const row = this.#db.prepare("SELECT trust FROM memory_nodes WHERE id = ?").get(nodeId);
    return row === undefined ? null : (row as unknown as { trust: number }).trust;
  }

  /** Every verdict on a memory, oldest first. */
  feedbackFor(nodeId: string): readonly FeedbackResult[] {
    return this.#db
      .prepare(
        "SELECT node_id, verdict, trust_before, trust_after, created_at FROM memory_feedback " +
          "WHERE node_id = ? ORDER BY created_at, id",
      )
      .all(nodeId)
      .map((row) => {
        const typed = row as unknown as {
          node_id: string;
          verdict: FeedbackVerdict;
          trust_before: number;
          trust_after: number;
          created_at: string;
        };
        return {
          nodeId: typed.node_id,
          verdict: typed.verdict,
          trustBefore: typed.trust_before,
          trustAfter: typed.trust_after,
          at: typed.created_at,
        };
      });
  }

  /**
   * Record what the Commander thought of a memory Syl surfaced.
   *
   * The trust move and the ledger row are ONE transaction. A trust score that
   * moved with no row to explain it is the audit failure `0012` refuses for
   * inferred edges, one layer up: "why is this memory ranked last" has to be
   * answerable, and the answer is a list of rows.
   *
   * An IDENTITY path, so it reaches a cold or suppressed memory. Being told a
   * memory is wrong is a very common reason for it to have left the hot tier,
   * and refusing the feedback that explains the demotion would be backwards.
   *
   * @throws {RetrievalError} `unknown_node`, `bad_verdict`, `bad_trust`.
   */
  recordFeedback(nodeId: string, verdict: FeedbackVerdict, note?: string): FeedbackResult {
    const before = this.trustFor(nodeId);
    if (before === null) {
      throw new RetrievalError(
        "unknown_node",
        `${nodeId} is not a node in the memory graph, so there is nothing to trust or distrust.`,
      );
    }

    const after = trustAfterFeedback(before, verdict);
    const at = instant(this.#clock());

    this.#db.exec("SAVEPOINT syl_feedback");
    try {
      this.#db
        .prepare(
          "INSERT INTO memory_feedback (node_id, verdict, trust_before, trust_after, note, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(nodeId, verdict, before, after, note ?? null, at);
      // `updated_at` is deliberately NOT touched. Trust is a judgement about a
      // memory, not a change to it, and bumping the stamp would hand a memory
      // he called WRONG a fresh decay multiplier for saying so.
      this.#db.prepare("UPDATE memory_nodes SET trust = ? WHERE id = ?").run(after, nodeId);
      this.#db.exec("RELEASE syl_feedback");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK TO syl_feedback");
        this.#db.exec("RELEASE syl_feedback");
      } catch {
        // Already gone; the original failure is the one worth reporting.
      }
      throw error;
    }

    return { nodeId, verdict, trustBefore: before, trustAfter: after, at };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Vector candidates, or `null` when there is no embedder to produce them. */
  async #vectorHits(
    text: string,
    search: { kind?: MemoryNodeKind; limit: number },
  ): Promise<VectorHit[] | null> {
    if (this.#embedder === undefined) return null;
    const embedding = await this.#embedder.embedQuery(text);
    return this.#store.searchVector(embedding, search);
  }

  /**
   * Score the candidate set by shared structural role.
   *
   * Only `related()` — see the module header for why `reason()` and `probe()`
   * are not here and must not be added.
   *
   * **What this is and is not.** The kernel is used as a RE-RANKER over the
   * candidates the other two channels proposed, not as a proposer of its own.
   * Proposing would mean encoding a phase vector for every hot node on every
   * query, and that is an O(n) pass per keystroke; it is affordable exactly
   * once a night, which is why candidate PROPOSAL by holographic algebra
   * belongs to the nightly sweep (`syl-005.4.2`) and not to an interactive
   * retrieval. The consequence is honest and worth stating: this channel
   * sharpens a ranking, and the links with no keyword and no semantic overlap
   * at all — the thing the algebra is uniquely good at — are found by the
   * sweep, not here.
   *
   * `trust: 1` on every fact is not a placeholder. `related()` multiplies its
   * score by `fact.trust`, and trust is already the second term of
   * `final = relevance * trust * decay`. Passing the real value would apply it
   * twice, squaring a penalty the Commander expressed once.
   *
   * @returns whether the channel had anything to say.
   */
  #scoreHolographic(
    entities: readonly string[] | undefined,
    nodes: ReadonlyMap<string, MemoryNode>,
    candidates: Map<string, Candidate>,
  ): boolean {
    const named = (entities ?? []).map((entity) => entity.trim()).filter((e) => e.length > 0);
    if (named.length === 0 || nodes.size === 0) return false;

    const facts: HoloFact[] = [...nodes.values()].map((node) =>
      encodeHoloFact(
        {
          id: node.id,
          content: node.body === null ? node.label : `${node.label} ${node.body}`,
          entities: [node.label],
          trust: 1,
        },
        this.#dim,
      ),
    );

    // The best score across the named entities, not the mean. A memory that
    // matches one of three entities strongly IS about that entity, and
    // averaging would bury it under one that matches all three weakly. AND
    // semantics across entities is `reason()`'s job, and `reason()` does not
    // work — see the header.
    const best = new Map<string, number>();
    for (const entity of named) {
      for (const scored of related(facts, entity, { dim: this.#dim, limit: facts.length })) {
        const current = best.get(scored.id);
        if (current === undefined || scored.score > current) best.set(scored.id, scored.score);
      }
    }

    let scored = false;
    for (const [id, score] of best) {
      const candidate = candidates.get(id);
      if (candidate === undefined) continue;
      candidate.holographic = clamp01(score);
      scored = true;
    }
    return scored;
  }

  /**
   * Walk out from the top entries.
   *
   * `graph.neighbourhood` is a SCAN and reads the hot tier, which is what keeps
   * a traversal from paying for the graph's accumulated history. The nodes it
   * reaches are fetched by id and are therefore tier-free — a hot edge pointing
   * at a superseded node still yields that node, because the edge is what the
   * traversal filters on.
   */
  #walk(
    entries: readonly RetrievedMemory[],
    depth: number,
    entryPoints: number,
  ): { nodes: MemoryNode[]; edges: MemoryEdge[] } {
    const nodes = new Map<string, MemoryNode>();
    const edges = new Map<string, MemoryEdge>();

    for (const entry_ of entries) nodes.set(entry_.node.id, entry_.node);
    if (depth === 0) return { nodes: [...nodes.values()], edges: [] };

    for (const entry_ of entries.slice(0, entryPoints)) {
      const around = this.#graph.neighbourhood(entry_.node.id, { depth });
      for (const node of around.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
      for (const edge of around.edges) if (!edges.has(edge.id)) edges.set(edge.id, edge);
    }

    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }
}

function entry(candidates: Map<string, Candidate>, nodeId: string): Candidate {
  const existing = candidates.get(nodeId);
  if (existing !== undefined) return existing;
  const fresh: Candidate = {};
  candidates.set(nodeId, fresh);
  return fresh;
}

/** The most negative BM25 in a set — FTS5 negates, so this is the best match. */
function bestBm25(hits: readonly KeywordHit[]): number {
  let best = 0;
  for (const hit of hits) if (hit.bm25 < best) best = hit.bm25;
  return best;
}

/** An instant as epoch milliseconds, or `now` if it is not one we can read. */
function stampMs(value: string, now: number): number {
  return parseInstant(value) ?? now;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function requireCount(value: number, what: string, floor: number): number {
  if (!Number.isInteger(value) || value < floor) {
    throw new RetrievalError(
      "bad_limit",
      `${what} must be an integer of at least ${String(floor)}, got ${String(value)}.`,
    );
  }
  return value;
}
