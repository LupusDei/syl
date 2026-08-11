/**
 * The four holographic query kernels, as pure functions over facts already in
 * memory.
 *
 * ## Provenance and licence
 *
 * The scoring formulas are ported from Nous Research's Hermes:
 *
 *   https://github.com/NousResearch/hermes-agent
 *   plugins/memory/holographic/retrieval.py  (`FactRetriever`)
 *   commit 7a450ca5ce4682a0b20ecc31eca04af6cbd78206
 *   MIT License — Copyright (c) 2025 Nous Research
 *
 * Full licence text at `backend/src/memory/HERMES-LICENSE.txt`.
 *
 * ## Why this is a separate file, and why it takes arrays
 *
 * Upstream's `FactRetriever` reaches into SQLite inside every scoring loop. We
 * take a list instead. That is not tidying — the sweep (syl-005.4.2) owns the
 * graph store and has partition rules this module must not know about: ranking
 * scans read the hot tier only, while the existence check must span every tier
 * through the identity index. A kernel that issued its own queries would either
 * duplicate those rules or quietly violate them.
 *
 * So: the caller selects the facts, this scores them. Zero I/O, no database, no
 * network, no model calls. The whole engine is arithmetic, which is what makes
 * the nightly sweep cost nothing.
 *
 * ## What these are for
 *
 * Something cheap PROPOSES and the model only JUDGES. Fifty thousand memories
 * is 2.5 billion pairs; asking a model to find connections in that produces
 * connections forever, plausibly and inexhaustibly, and the honest name for
 * that is astrology. These kernels produce a small, boring, deterministic
 * candidate set for the expensive half to rule on.
 *
 * ## What they cannot do
 *
 * Everything in `holographic.ts`'s limitations section applies, because it is
 * the same encoder: **bag of words, structure not meaning.** `related("car")`
 * will not surface a fact about an automobile. These kernels find facts joined
 * by shared structure — the same entity in the same role — which is exactly the
 * link an embedding cannot see, and they are blind to the synonym link an
 * embedding finds trivially. Run both.
 */

import {
  DEFAULT_DIM,
  HolographicError,
  ROLE_CONTENT,
  ROLE_ENTITY,
  bind,
  encodeAtom,
  encodeFact,
  encodeText,
  similarity,
  unbind,
} from "./holographic.js";

/** A fact with its phase vector already computed. */
export interface HoloFact {
  readonly id: string;
  readonly content: string;
  /** Entity names as written. Lowercased internally; case never matters. */
  readonly entities: readonly string[];
  /** Confidence weight in [0, 1]. Multiplies every score, as upstream does. */
  readonly trust: number;
  readonly vector: Float64Array;
}

/** A fact and the score a kernel gave it. Sorted descending by score. */
export interface ScoredFact {
  readonly id: string;
  readonly score: number;
}

/** A candidate contradiction: same subjects, divergent claims. */
export interface Contradiction {
  readonly a: string;
  readonly b: string;
  /** Jaccard overlap of the two entity sets, rounded to 3 places. */
  readonly entityOverlap: number;
  /** Phase cosine similarity of the two fact vectors, rounded to 3 places. */
  readonly contentSimilarity: number;
  /** `overlap * (1 - normalisedSimilarity)`, rounded to 3 places. */
  readonly contradictionScore: number;
  /** Lowercased, sorted by code point — the same order Python's `sorted` gives. */
  readonly sharedEntities: string[];
}

export interface QueryOptions {
  /** Must match the length of every fact vector. */
  readonly dim?: number;
  /** Maximum results returned. */
  readonly limit?: number;
}

export interface ContradictOptions extends QueryOptions {
  /** Minimum contradiction score to report. Upstream default 0.3. */
  readonly threshold?: number;
  /**
   * Below this entity-set overlap a pair is not considered at all. Upstream
   * hard-codes 0.3; exposed here because the sweep may want it tighter.
   */
  readonly minEntityOverlap?: number;
  /**
   * Hard cap on facts compared, because this kernel is O(n^2). At 500 that is
   * ~125k similarity calls, which is fine; at 50k it is 1.25 billion, which is
   * the whole reason the sweep seeds from the day instead of the entire past.
   *
   * Truncation keeps the FIRST `maxFacts` entries, so the caller controls which
   * ones survive by the order it passes them in — upstream sorts by recency,
   * but recency is a store concern and this module has no store.
   */
  readonly maxFacts?: number;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_CONTRADICT_THRESHOLD = 0.3;
const DEFAULT_MIN_ENTITY_OVERLAP = 0.3;
const DEFAULT_MAX_CONTRADICT_FACTS = 500;

function resolveDim(facts: readonly HoloFact[], dim: number): number {
  for (const fact of facts) {
    if (fact.vector.length !== dim) {
      throw new HolographicError(
        `fact ${fact.id} has a ${fact.vector.length}-dimensional vector but dim=${dim} was requested`,
      );
    }
  }
  return dim;
}

/**
 * Sort descending by score, stably.
 *
 * Stability is not cosmetic. Ties are common — two facts that share no tokens
 * with the probe both score the noise floor — and an unstable sort would make
 * the sweep's candidate set differ run to run for no reason, which turns "the
 * dream proposed something new tonight" into noise. V8's sort is stable, and so
 * is Python's, so ties keep input order in both.
 */
function rankDescending(scored: ScoredFact[], limit: number): ScoredFact[] {
  return [...scored].sort((x, y) => y.score - x.score).slice(0, limit);
}

/** Compute a fact's phase vector. The one place callers should get `vector`. */
export function encodeHoloFact(
  fact: Omit<HoloFact, "vector">,
  dim: number = DEFAULT_DIM,
): HoloFact {
  return { ...fact, vector: encodeFact(fact.content, fact.entities, dim) };
}

/**
 * Facts structurally connected to an entity — the query vector search cannot do.
 *
 * The entity's bare atom is unbound from each fact vector; if the entity really
 * occupies a slot in that fact, what is left is close to one of the two role
 * atoms. The better of the two role similarities is the score, because an
 * entity may appear either as a linked entity or as a word in the content.
 *
 * This is the kernel the nightly sweep leans on: it scores by shared structure,
 * so it will connect two facts that share NO keyword and no embedding
 * neighbourhood, purely because the same entity plays the same role in both.
 */
export function related(
  facts: readonly HoloFact[],
  entity: string,
  options: QueryOptions = {},
): ScoredFact[] {
  const dim = resolveDim(facts, options.dim ?? DEFAULT_DIM);
  const limit = options.limit ?? DEFAULT_LIMIT;

  // Loop-invariant, and deterministic, so hoisting changes nothing but cost.
  const entityVec = encodeAtom(entity.toLowerCase(), dim);
  const roleEntity = encodeAtom(ROLE_ENTITY, dim);
  const roleContent = encodeAtom(ROLE_CONTENT, dim);

  const scored = facts.map((fact) => {
    const residual = unbind(fact.vector, entityVec);
    const best = Math.max(
      similarity(residual, roleEntity),
      similarity(residual, roleContent),
    );
    return { id: fact.id, score: ((best + 1.0) / 2.0) * fact.trust };
  });

  return rankDescending(scored, limit);
}

/**
 * ⚠️ **BROKEN — DO NOT USE AS A CANDIDATE PROPOSER. `syl-b97`.**
 *
 * The description below is what this kernel was *designed* to do. Measured, it
 * does not discriminate at all: every fact scores 0.489–0.510 — the noise floor
 * — and the ranking is sometimes INVERTED, with a fact lacking the queried
 * entity outscoring one that has it.
 *
 * **This is an inherited defect, not a porting error.** Verified digit-for-digit
 * against the upstream Python on the same corpus. Root cause: `bundle()` is a
 * circular mean, which discards the magnitude classic HRR unbinding needs to
 * recover a composed vector. `related()` survives precisely because it never
 * recovers one — it unbinds a bare atom against a single role atom.
 *
 * Wiring this into a ranker feeds it a uniform score for every fact and calls
 * it evidence. That is the astrology failure the two-tier dream exists to
 * prevent, arriving through the cheap half that was meant to be the safeguard:
 * a filter that passes everything is worse than no filter, because it launders
 * noise as candidates and the expensive tier cannot tell the difference.
 *
 * Three acceptance tests describe the correct behaviour and stay RED against
 * `syl-b97`. Use {@link related} and {@link contradict}, which are measured
 * working (0.30 separation, and 1.000 vs 0.403 respectively).
 */
/**
 * Facts ABOUT an entity, as opposed to `related`'s facts merely connected to it.
 *
 * Unbinds the role-bound entity key and asks how much the residue looks like
 * that fact's own content signal. A fact where the entity genuinely fills an
 * entity slot leaves its content behind; one where it does not leaves noise.
 */
export function probe(
  facts: readonly HoloFact[],
  entity: string,
  options: QueryOptions = {},
): ScoredFact[] {
  const dim = resolveDim(facts, options.dim ?? DEFAULT_DIM);
  const limit = options.limit ?? DEFAULT_LIMIT;

  const roleEntity = encodeAtom(ROLE_ENTITY, dim);
  const roleContent = encodeAtom(ROLE_CONTENT, dim);
  const probeKey = bind(encodeAtom(entity.toLowerCase(), dim), roleEntity);

  const scored = facts.map((fact) => {
    const residual = unbind(fact.vector, probeKey);
    const contentVec = bind(encodeText(fact.content, dim), roleContent);
    const sim = similarity(residual, contentVec);
    return { id: fact.id, score: ((sim + 1.0) / 2.0) * fact.trust };
  });

  return rankDescending(scored, limit);
}

/**
 * ⚠️ **BROKEN — DO NOT USE AS A CANDIDATE PROPOSER. `syl-b97`.**
 *
 * The description below is what this kernel was *designed* to do. Measured, it
 * does not discriminate at all: every fact scores 0.489–0.510 — the noise floor
 * — and the ranking is sometimes INVERTED, with a fact lacking the queried
 * entity outscoring one that has it.
 *
 * **This is an inherited defect, not a porting error.** Verified digit-for-digit
 * against the upstream Python on the same corpus. Root cause: `bundle()` is a
 * circular mean, which discards the magnitude classic HRR unbinding needs to
 * recover a composed vector. `related()` survives precisely because it never
 * recovers one — it unbinds a bare atom against a single role atom.
 *
 * Wiring this into a ranker feeds it a uniform score for every fact and calls
 * it evidence. That is the astrology failure the two-tier dream exists to
 * prevent, arriving through the cheap half that was meant to be the safeguard:
 * a filter that passes everything is worse than no filter, because it launders
 * noise as candidates and the expensive tier cannot tell the difference.
 *
 * Three acceptance tests describe the correct behaviour and stay RED against
 * `syl-b97`. Use {@link related} and {@link contradict}, which are measured
 * working (0.30 separation, and 1.000 vs 0.403 respectively).
 */
/**
 * Conjunctive retrieval: facts where EVERY listed entity plays a structural
 * role. A vector-space JOIN.
 *
 * AND semantics come from taking the MINIMUM across entities, not the mean —
 * a fact that matches four entities perfectly and a fifth not at all is not a
 * four-fifths answer to the conjunction, it is a wrong one. Mean would rank it
 * above a fact that matches all five moderately, which is the failure mode this
 * kernel exists to avoid.
 */
export function reason(
  facts: readonly HoloFact[],
  entities: readonly string[],
  options: QueryOptions = {},
): ScoredFact[] {
  if (entities.length === 0) {
    throw new HolographicError("reason needs at least one entity");
  }
  const dim = resolveDim(facts, options.dim ?? DEFAULT_DIM);
  const limit = options.limit ?? DEFAULT_LIMIT;

  const roleEntity = encodeAtom(ROLE_ENTITY, dim);
  const roleContent = encodeAtom(ROLE_CONTENT, dim);
  const probeKeys = entities.map((e) => bind(encodeAtom(e.toLowerCase(), dim), roleEntity));

  const scored = facts.map((fact) => {
    let minSim = Number.POSITIVE_INFINITY;
    for (const key of probeKeys) {
      minSim = Math.min(minSim, similarity(unbind(fact.vector, key), roleContent));
    }
    return { id: fact.id, score: ((minSim + 1.0) / 2.0) * fact.trust };
  });

  return rankDescending(scored, limit);
}

/**
 * All-pairs scan for facts that talk about the same things and disagree.
 *
 * High entity overlap plus low content similarity is the signature: same
 * subject, different claim. It is a proposal, never a verdict — "the backend
 * restarts cleanly" and "the backend never restarts cleanly" score the same as
 * two unrelated statements about the backend, because a bag-of-words encoder
 * cannot see negation. The model judges; this only nominates.
 */
export function contradict(
  facts: readonly HoloFact[],
  options: ContradictOptions = {},
): Contradiction[] {
  // No probe vector to build here — this kernel compares facts to each other —
  // but the dimensions still have to agree or `similarity` throws mid-scan.
  resolveDim(facts, options.dim ?? DEFAULT_DIM);
  const limit = options.limit ?? DEFAULT_LIMIT;
  const threshold = options.threshold ?? DEFAULT_CONTRADICT_THRESHOLD;
  const minOverlap = options.minEntityOverlap ?? DEFAULT_MIN_ENTITY_OVERLAP;
  const maxFacts = options.maxFacts ?? DEFAULT_MAX_CONTRADICT_FACTS;

  if (facts.length < 2) return [];
  const pool = facts.length > maxFacts ? facts.slice(0, maxFacts) : facts;

  const entitySets = pool.map((f) => new Set(f.entities.map((e) => e.toLowerCase())));

  const found: Contradiction[] = [];
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const a = pool[i]!;
      const b = pool[j]!;
      const ea = entitySets[i]!;
      const eb = entitySets[j]!;
      if (ea.size === 0 || eb.size === 0) continue;

      const shared = [...ea].filter((e) => eb.has(e));
      const unionSize = ea.size + eb.size - shared.length;
      const overlap = unionSize > 0 ? shared.length / unionSize : 0.0;
      if (overlap < minOverlap) continue;

      const contentSim = similarity(a.vector, b.vector);
      const score = overlap * (1.0 - (contentSim + 1.0) / 2.0);
      if (score < threshold) continue;

      found.push({
        a: a.id,
        b: b.id,
        entityOverlap: roundHalfEven(overlap, 3),
        contentSimilarity: roundHalfEven(contentSim, 3),
        contradictionScore: roundHalfEven(score, 3),
        sharedEntities: shared.sort(compareByCodePoint),
      });
    }
  }

  // Upstream ranks by the ROUNDED score, so two pairs differing in the fourth
  // decimal tie and keep scan order. Preserved rather than "fixed": changing it
  // would silently reorder every candidate list against the reference.
  return [...found]
    .sort((x, y) => y.contradictionScore - x.contradictionScore)
    .slice(0, limit);
}

/**
 * Python's `sorted()` order for strings: by Unicode code point.
 *
 * JavaScript's default sort compares UTF-16 code units, which puts every
 * astral-plane character before U+E000..U+FFFF instead of after. Entity names
 * are usually ASCII and it usually does not matter — but `sharedEntities` ends
 * up in the brief the Commander reads, and "usually" is how a list silently
 * stops matching the reference.
 */
function compareByCodePoint(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i += 1) {
    const pa = ca[i]!.codePointAt(0)!;
    const pb = cb[i]!.codePointAt(0)!;
    if (pa !== pb) return pa - pb;
  }
  return ca.length - cb.length;
}

/**
 * Python's `round(x, ndigits)`: round-half-to-EVEN on the exact decimal value.
 *
 * `Number.prototype.toFixed` rounds halves away from zero, and
 * `Math.round(x * 1000) / 1000` compounds two roundings. Both disagree with
 * Python on exact halves — `round(0.0625, 3)` is 0.062 in Python and 0.063
 * under `toFixed`. Rare, but reachable: entity overlap is a ratio of small
 * integers, so exact dyadic halves genuinely occur, and the rounded score is
 * what `contradict` SORTS by. A one-ulp disagreement there swaps two
 * candidates.
 *
 * Exact by construction: a double is `mantissa * 2^exponent` with no error, so
 * scaling by 10^digits as a BigInt fraction gives the true decimal expansion,
 * and the half-even decision is made on an exact remainder.
 */
function roundHalfEven(x: number, digits: number): number {
  if (!Number.isFinite(x) || x === 0) return x;

  const negative = x < 0;
  const magnitude = Math.abs(x);

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, magnitude);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const rawExponent = (hi >>> 20) & 0x7ff;

  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exponent: number;
  if (rawExponent === 0) {
    exponent = -1074; // subnormal
  } else {
    mantissa |= 1n << 52n;
    exponent = rawExponent - 1075;
  }

  // magnitude === mantissa * 2^exponent, exactly.
  const scale = 10n ** BigInt(digits);
  let numerator: bigint;
  let denominator: bigint;
  if (exponent >= 0) {
    numerator = mantissa * scale * (1n << BigInt(exponent));
    denominator = 1n;
  } else {
    numerator = mantissa * scale;
    denominator = 1n << BigInt(-exponent);
  }

  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubled = remainder * 2n;
  if (doubled > denominator || (doubled === denominator && (quotient & 1n) === 1n)) {
    quotient += 1n;
  }

  // Rebuild the decimal and let the parser produce the nearest double, which is
  // what CPython's round does via dtoa/strtod.
  const digitsText = quotient.toString().padStart(digits + 1, "0");
  const whole = digitsText.slice(0, digitsText.length - digits);
  const fraction = digitsText.slice(digitsText.length - digits);
  const result = Number(digits > 0 ? `${whole}.${fraction}` : whole);

  return negative ? -result : result;
}
