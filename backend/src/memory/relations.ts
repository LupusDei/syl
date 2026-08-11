/**
 * What an edge is allowed to MEAN.
 *
 *
 * ## The measured problem
 *
 * `memory_edges.relation` is `NOT NULL`, is populated on every row, and on the
 * live graph on 2026-08-11 had only ever held one value: `'stated'`. Thirty
 * nodes, twenty-nine edges, every one of them provenance from a single hub, and
 * zero edges between any two real memories. The column existed. The vocabulary
 * never did.
 *
 * Meanwhile five of six `person` nodes carried the relationship IN THE LABEL
 * TEXT — `"Ela — his wife"`, `"Isla — his daughter"`, `"Rowan — his son"`. The
 * information was not missing. It was written into a display string instead of
 * a queryable column, which is a defect you can only see by looking at the data.
 *
 *
 * ## Why the vocabulary is CLOSED, and this is the whole argument
 *
 * Digestion's own failure mode is not that it will connect too little. It is
 * that **everything in one conversation is trivially "related"**, so a turn
 * asked to connect recent things will connect all of them — and a graph where
 * everything touches everything ranks nothing, which is indistinguishable from
 * a graph with no edges at all, except that it costs more to read.
 *
 * The defence is to demand a SPECIFIC NAMED RELATION. `spouse_of` is a claim
 * that can be wrong, shown to the Commander, and corrected. "related to" is not
 * a claim at all. So the vocabulary is a closed set, it is validated at the
 * write seam, and — the part that matters — **if the turn cannot name the
 * relation, it writes nothing.** Declining is the expected outcome for most
 * pairs, exactly as declining is the expected outcome for most extractions.
 *
 *
 * ## The two halves, and why they are one vocabulary
 *
 * `relation` is one column, so it gets one vocabulary, split by which species
 * of edge may use each name:
 *
 * - {@link OBSERVED_RELATIONS} — what a SOURCE asserted. `stated` and nothing
 *   else, minted only by `extract-apply.ts` for provenance.
 * - {@link INFERRED_RELATIONS} — what reflection WORKED OUT. Everything
 *   digestion and the dream may write.
 *
 * The two sets are disjoint and {@link assertInferredRelation} enforces the
 * boundary in the direction that matters: an inference may never claim
 * `stated`, because an edge Syl concluded must never become indistinguishable
 * from something he said. That is the same reason `kind` is `inferred` and not
 * `observed`, stated once more in the neighbouring column.
 *
 *
 * ## `about` is the escape hatch, and it is metered
 *
 * A closed vocabulary with no escape hatch gets one of two things wrong: it
 * either refuses real connections that have no name yet, or it grows a new name
 * every time someone meets one. `about` is the pressure valve — "this memory is
 * about that thing" — and it is deliberately the weakest claim in the set.
 *
 * A valve nobody watches is a leak. {@link meterAbout} makes its use countable,
 * so "we reached for the escape hatch on a quarter of everything we wrote" is a
 * number in the run ledger rather than a suspicion. If that number is
 * persistently loud the vocabulary is wrong and should be extended on purpose,
 * which is a decision someone makes rather than one that happens.
 */

/**
 * Relations an OBSERVED edge may carry.
 *
 * One entry, and it is not expected to grow: an observation says "a source
 * asserted this", and the interesting structure lives on the inferred side. It
 * is a list rather than a constant so {@link MEMORY_RELATIONS} can be the union
 * rather than a hand-maintained third copy.
 */
export const OBSERVED_RELATIONS = ["stated"] as const;

/**
 * Relations an INFERRED edge may carry. The closed set.
 *
 * Grouped by what they are for, and the grouping is not decoration — it is the
 * argument for each one being here rather than being `about`:
 *
 * - **Kinship** (`spouse_of`, `child_of`, `parent_of`, `sibling_of`) — the
 *   relations already sitting in the label text of the live graph, waiting for
 *   a column to move into.
 * - **Work** (`employed_by`, `works_on`) — a person to an organisation, a
 *   person to a project. The two that make "what is he actually doing" a
 *   traversal.
 * - **Argument** (`evidence_for`, `blocks`, `contradicts`) — the relations the
 *   dream needs. `contradicts` in particular is what the nightly sweep already
 *   proposes and has never had a name for.
 * - **Place** (`located_in`) — a thing to where it is.
 * - **The escape hatch** (`about`) — see the module header, and see
 *   {@link meterAbout}.
 *
 * Order is asserted in the tests, so an addition is a deliberate edit rather
 * than something that slides in beside a similar-looking name.
 */
export const INFERRED_RELATIONS = [
  "spouse_of",
  "child_of",
  "parent_of",
  "sibling_of",
  "employed_by",
  "works_on",
  "evidence_for",
  "blocks",
  "contradicts",
  "located_in",
  "about",
] as const;

/** A relation an inferred edge may carry. */
export type InferredRelation = (typeof INFERRED_RELATIONS)[number];

/** A relation an observed edge may carry. */
export type ObservedRelation = (typeof OBSERVED_RELATIONS)[number];

/** Every value `memory_edges.relation` may legitimately hold. */
export const MEMORY_RELATIONS = [...OBSERVED_RELATIONS, ...INFERRED_RELATIONS] as const;

/** Anything the `relation` column may hold. */
export type MemoryRelation = (typeof MEMORY_RELATIONS)[number];

/**
 * The weakest claim in the vocabulary, and the one to watch.
 *
 * Named as a constant rather than spelled `"about"` at each call site so the
 * meter, the store and the prompt cannot disagree about which relation is the
 * one being rationed.
 */
export const ESCAPE_RELATION: InferredRelation = "about";

/**
 * The share of `about` above which the meter goes loud.
 *
 * A quarter. Not tuned against data — there is none yet, because nothing has
 * ever written a typed relation — and stated here so the first real number can
 * be compared against something. It is an alarm, not a limit: nothing is
 * refused for crossing it, because refusing writes on a ratio would make the
 * last edge of a batch depend on the first, which is not a property anyone
 * wants to debug.
 */
export const ABOUT_SHARE_ALARM = 0.25;

/** Whether a value is a relation an inference may write. */
export function isInferredRelation(value: unknown): value is InferredRelation {
  return typeof value === "string" && (INFERRED_RELATIONS as readonly string[]).includes(value);
}

/** Whether a value is any relation the `relation` column may hold. */
export function isMemoryRelation(value: unknown): value is MemoryRelation {
  return typeof value === "string" && (MEMORY_RELATIONS as readonly string[]).includes(value);
}

/** Thrown when something outside the vocabulary tried to enter the graph. */
export class RelationError extends Error {
  /** What was rejected, rendered as text so a log line can carry it. */
  readonly relation: string;

  constructor(message: string, relation: string) {
    super(message);
    this.name = "RelationError";
    this.relation = relation;
  }
}

/**
 * The write seam: a relation an inference may carry, or a loud refusal.
 *
 * **Nothing is repaired.** Not trimmed, not case-folded, not singularised. A
 * relation that arrives as `"SPOUSE_OF"` or `" spouse_of"` is a contract
 * violation, and repairing one is precisely how the second spelling of a
 * relation enters a graph that is supposed to have one. The graph's own
 * `requireText` trims a relation before storing it, so a tolerant check here
 * would let `" spouse_of"` land as `spouse_of` and quietly teach every caller
 * that whitespace is fine.
 *
 * `where` is the field being validated — `"edges[2].relation"` — because a
 * refusal that does not say which of twelve proposals was wrong sends the
 * reader to a stack trace to find out.
 *
 * @throws {RelationError} always, when `value` is not in the vocabulary.
 */
export function assertInferredRelation(value: unknown, where: string): InferredRelation {
  if (isInferredRelation(value)) return value;

  const rendered = typeof value === "string" ? JSON.stringify(value) : String(value);
  const wasObserved = (OBSERVED_RELATIONS as readonly string[]).includes(String(value));

  throw new RelationError(
    `${where}: ${rendered} is not a relation an inference may carry. ` +
      (wasObserved
        ? `It is the PROVENANCE relation, which only a source may assert — an edge Syl ` +
          `concluded must never be indistinguishable from something he said. `
        : "") +
      `The vocabulary is closed: ${INFERRED_RELATIONS.join(", ")}. ` +
      `If the connection cannot be given one of these names, write nothing — everything in ` +
      `one conversation is trivially "related", and a graph where everything touches ` +
      `everything ranks nothing.`,
    String(value),
  );
}

/** How much of what was written reached for the escape hatch. */
export interface AboutMeter {
  /** Relations counted — that is, those actually in the vocabulary. */
  readonly total: number;
  /** How many of them were {@link ESCAPE_RELATION}. */
  readonly about: number;
  /** How many named something specific. */
  readonly typed: number;
  /** `about / total`, or 0 when nothing was written. */
  readonly share: number;
  /** Whether the share crossed {@link ABOUT_SHARE_ALARM}. */
  readonly loud: boolean;
}

/**
 * Count how often the escape hatch was reached for.
 *
 * Pure, and over a list of relations rather than over the database, so it can
 * be asserted exactly and so a caller can meter a batch BEFORE writing it as
 * well as the graph after.
 *
 * Values outside the vocabulary are not counted at all. They cannot reach the
 * graph — {@link assertInferredRelation} is the seam — so one here is a
 * caller's bug, and counting it as a typed relation would make the meter report
 * the vocabulary as healthier than it is.
 */
export function meterAbout(relations: readonly string[]): AboutMeter {
  const known = relations.filter((relation) => isInferredRelation(relation));
  const about = known.filter((relation) => relation === ESCAPE_RELATION).length;
  const total = known.length;
  const share = total === 0 ? 0 : about / total;

  return { total, about, typed: total - about, share, loud: share > ABOUT_SHARE_ALARM };
}
