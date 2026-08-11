import { newId, uuidv7 } from "../services/id.js";

/**
 * The memory graph's vocabulary: ids, tiers, kinds, and the PARTITION KEY.
 *
 * This module is the single place the partition key is decided. The migration
 * `0012_memory_core.sql` carries the full argument for it — read that first if
 * you are here to change something. The short version, because it decides
 * everything else:
 *
 * **The partition key is `(tier, kind)`, and `tier` leads.**
 *
 * A partition key is the only filter that actually prunes: measured 31ms
 * against 121ms at 100k rows, where the same predicate as an ordinary metadata
 * column barely helped. In `vec0` it is a keyword (`tier text partition key`);
 * in an ordinary SQLite B-tree the equivalent is exact — the partition key is
 * the LEADING COLUMN of every index a scan uses.
 *
 * `tier` exists because of CLAUDE.md constraint 6: an inferred edge is never
 * deleted, only demoted, so the edge table grows monotonically forever. Decay
 * fixes ranking; it does not fix cost. Dormant edges left in the hot partition
 * make every read pay for the graph's whole history, so **crossing the
 * relevance floor MOVES a row to the cold partition** — demotion and
 * partitioning are the same mechanism. Never forget anything; never pay for
 * what you have forgotten.
 *
 * And the half that is easy to lose: a partition key prunes SCANS, never
 * IDENTITY LOOKUPS. `tierAfter` below can move a row anywhere it likes only
 * because the identity index in the migration does not mention `tier` and so
 * spans every partition. If that ever stops being true, "demote, never prune"
 * becomes "prune, slowly, while claiming otherwise".
 */

/** Thrown when something would enter the graph outside its vocabulary. */
export class MemorySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemorySchemaError";
  }
}

/**
 * The primary partition axis.
 *
 * - `hot` — in the scan. The only tier a candidate query reads.
 * - `cold` — below the relevance floor. Fully addressable, never scanned,
 *   promoted straight back on reactivation.
 * - `suppressed` — the Commander said this is wrong. Excluded from scans
 *   whatever the weight does, and never promoted back automatically. It is a
 *   tier rather than a flag precisely so it stays findable: an identity lookup
 *   still returns it, which is what stops reflection from recreating an edge he
 *   has already rejected.
 */
export const MEMORY_TIERS = ["hot", "cold", "suppressed"] as const;

export type MemoryTier = (typeof MEMORY_TIERS)[number];

/** The one tier a candidate scan reads. */
export const SCANNED_TIER: MemoryTier = "hot";

/**
 * The secondary partition axis for nodes.
 *
 * Effectively immutable per node: a person does not become an event, so a node
 * never changes partition along this axis.
 */
export const MEMORY_NODE_KINDS = [
  "fact",
  "memory",
  "person",
  "source",
  "event",
  "goal",
  "decision",
] as const;

export type MemoryNodeKind = (typeof MEMORY_NODE_KINDS)[number];

/**
 * The kinds that name a THING, as opposed to a claim about one.
 *
 * **A kind is a claim about what a row IS, not about what it is ABOUT.** That
 * sentence is the whole of `syl-016.4`, and it needed a vocabulary before it
 * could be a rule. Syl found the defect herself:
 *
 * > "Ela's entry isn't *who she is*, it's the fact that she wants an apartment
 * > near her parents. So even the People bucket is storing facts with a
 * > person's name in them rather than people."
 *
 * The projection groups by kind. A `person` node whose body is a fact about
 * that person makes the grouping carry no information at all — her digest
 * becomes noise with headings, which is exactly what she reported seeing. The
 * repair is that a person is a person, and what she wants is a `fact` LINKED to
 * her.
 *
 * So the split, and both halves are load-bearing:
 *
 * - **Entity kinds** name something that exists on its own and can be pointed
 *   at: a person, an event, a goal, a decision.
 * - **`fact`** is a claim, and a claim is always about something. It is the one
 *   extractable kind that is not here, deliberately: `extract.ts` lets a
 *   candidate point at an entity in the same extraction, and refuses to let it
 *   point at another claim, because a claim about a claim is not what that
 *   mechanism is for.
 *
 * `source` and `memory` are absent for a different reason — they are
 * provenance and intake plumbing, not things the Commander's world contains,
 * and neither is extractable in the first place.
 */
export const ENTITY_NODE_KINDS = [
  "person",
  "event",
  "goal",
  "decision",
] as const satisfies readonly MemoryNodeKind[];

/** A kind that names a thing rather than a claim. See {@link ENTITY_NODE_KINDS}. */
export type EntityNodeKind = (typeof ENTITY_NODE_KINDS)[number];

/** Whether a value names a thing rather than a claim about one. */
export function isEntityNodeKind(value: unknown): value is EntityNodeKind {
  return typeof value === "string" && (ENTITY_NODE_KINDS as readonly string[]).includes(value);
}

/**
 * The two species of edge, which are also the edge table's secondary partition
 * axis.
 *
 * `observed` was asserted by a source and carries provenance. `inferred` was
 * discovered by reflection and carries confidence, weight, and — mandatorily —
 * its reasoning.
 */
export const MEMORY_EDGE_SPECIES = ["observed", "inferred"] as const;

export type MemoryEdgeSpecies = (typeof MEMORY_EDGE_SPECIES)[number];

/**
 * One relation the dream is allowed to write, and what it means.
 *
 * The source is ALWAYS the grammatical subject, so every gloss reads
 * "A ⟨relation⟩ B". Stated once, here, because the judgment has to get
 * direction right on every edge and a vocabulary where some relations read
 * forwards and some backwards is a vocabulary that will be got wrong.
 */
export interface InferredRelationSpec {
  /** The wire form: lower case, underscores, no spaces. What an index groups by. */
  readonly relation: string;
  /** True when the relation means the same thing read backwards. */
  readonly symmetric: boolean;
  /** Reads as "A ⟨gloss⟩". Shown to the judgment verbatim. */
  readonly gloss: string;
}

/**
 * The closed vocabulary of inferred relations. `syl-017.1`.
 *
 * Syl found the defect herself, and the diagnosis is the specification:
 *
 * > "Ela to Rowan is not resemblance, it's parenthood. The reasoning text is
 * > good, but the relation label is uniform and empty, so nothing can be
 * > traversed by type — **you can't ask 'who are his children.'**"
 *
 *
 * ## Why closed, when free text is obviously more expressive
 *
 * **Free-text relations are as unqueryable as one label.** If every edge
 * invents its own wording, `parent_of`, `is the parent of`, `father to` and
 * `parent` are four relations, no query finds all four, and the graph is back
 * where it started with more words in it. One uniform label and forty unique
 * ones fail the same test: neither GROUPS.
 *
 * A closed set groups, and it will not fit something real. That is the tension,
 * and it is `tidy.ts`'s nominate/act shape again — so the answer is the same
 * one: **a relation outside this list is a NOMINATION, never a write.** The
 * dream files the connection under the kernel's relation, the connection is
 * still made, and the word the judgment wanted is recorded in the dream log.
 * The log is then the evidence for widening this list, which is a decision a
 * person makes from data rather than one every edge makes for itself.
 *
 * Adding an entry here is cheap and reversible. Discovering six months later
 * that thirty edges each invented their own wording is neither.
 *
 *
 * ## {@link FALLBACK_INFERRED_RELATION} is not a failure state
 *
 * `resembles` stays, and stays first. A vocabulary with no honest way to say
 * "these are connected and I cannot name how" forces every connection into the
 * nearest label that fits badly — which is the claim-beyond-evidence failure
 * this project keeps finding, arriving through the schema that was supposed to
 * make claims precise. The judgment is told, in those words, that declining to
 * name is the right answer when nothing fits.
 *
 *
 * ## What is deliberately ABSENT, and it is a boundary rather than an omission
 *
 * Every relation another module owns: `stated` and `about` (`extract-apply.ts`),
 * `concerns` (`remember.ts`), `extracted` (`sources.ts`), `same_as`,
 * `merged_into`, `label`, `body` and `kind` (`tidy.ts`).
 *
 * `stated` is extraction's word for **"HE asserted it"**. An inferred edge
 * carrying it would read as testimony, and the species is exactly what is
 * supposed to make that distinction unmistakable. `same_as` is worse: tidy
 * splits nominating a duplicate from merging it precisely because acting on a
 * similarity threshold is measured to collapse accuracy from 0.82 to 0.62, and
 * a dream that could assert identity would be a route around that split.
 *
 * `backend/tests/unit/memory-relations.test.ts` asserts the disjointness
 * against those modules' own constants, so this stays true by contact rather
 * than by anyone remembering it.
 */
export const INFERRED_RELATIONS = [
  {
    relation: "resembles",
    symmetric: true,
    gloss: "and B are alike, and nothing more precise is warranted",
  },
  {
    relation: "contradicts",
    symmetric: true,
    gloss: "and B cannot both be true",
  },
  {
    relation: "parent_of",
    symmetric: false,
    gloss: "is a parent of B",
  },
  {
    relation: "sibling_of",
    symmetric: true,
    gloss: "and B are siblings",
  },
  {
    relation: "partner_of",
    symmetric: true,
    gloss: "and B are partners or spouses",
  },
  {
    relation: "causes",
    symmetric: false,
    gloss: "brings B about, or B is true because of A",
  },
  {
    relation: "motivates",
    symmetric: false,
    gloss: "is a reason for the goal or decision B",
  },
  {
    relation: "blocks",
    symmetric: false,
    gloss: "stands in the way of B",
  },
  {
    relation: "part_of",
    symmetric: false,
    gloss: "is a component or subdivision of B",
  },
  {
    relation: "located_in",
    symmetric: false,
    gloss: "is situated in the place B",
  },
  {
    relation: "precedes",
    symmetric: false,
    gloss: "happened before B, and the two are one story",
  },
] as const satisfies readonly InferredRelationSpec[];

/** A relation the dream may write. */
export type InferredRelation = (typeof INFERRED_RELATIONS)[number]["relation"];

/**
 * What a connection is filed as when nothing more precise is warranted.
 *
 * The relation every inferred edge carried before `syl-017.1`, kept as the
 * honest answer rather than retired as the wrong one. See the vocabulary's
 * header.
 */
export const FALLBACK_INFERRED_RELATION: InferredRelation = "resembles";

/** Whether a value is a relation the dream may write. */
export function isInferredRelation(value: unknown): value is InferredRelation {
  return INFERRED_RELATIONS.some((spec) => spec.relation === value);
}

/** The spec for a relation, or `null` if the vocabulary does not hold it. */
export function inferredRelation(value: unknown): InferredRelationSpec | null {
  return INFERRED_RELATIONS.find((spec) => spec.relation === value) ?? null;
}

/**
 * A relation in its wire form, or `null` if there is nothing there.
 *
 * Models write `Parent_Of`, `parent of` and `parent-of` for the one relation,
 * and three spellings of one thing is the free-text failure arriving through
 * the back door. Canonicalising is not the same as accepting: what comes out of
 * here is still checked against {@link INFERRED_RELATIONS}, and `employs` stays
 * `employs`.
 */
export function canonicalRelation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const canonical = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return canonical === "" ? null : canonical;
}

/**
 * Id namespaces.
 *
 * `syl:<type>:<uuidv7>`, the project-wide convention from `services/id.ts`.
 * The KIND is deliberately not in the id: `syl:goal:<uuid>` already addresses a
 * row in the operational `goals` table, and a memory node of kind `goal`
 * minting the same prefix would make that prefix mean two different stores. A
 * type prefix exists so a dangling reference is legible in a log line, and one
 * that means two things defeats its own purpose.
 */
export const MEMORY_NODE_ID_PREFIX = "syl:memory_node:";
export const MEMORY_EDGE_ID_PREFIX = "syl:memory_edge:";
export const MEMORY_ASSERTION_ID_PREFIX = "syl:memory_assertion:";

/** The canonical UUID text form, either hex case, as the shared `Id` allows. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Mint a node id.
 *
 * Delegates to `newId` rather than concatenating the prefix itself. These
 * types were absent from the closed `IdType` union when this file was written,
 * so it had to mint its own — which left two minting paths for one id shape,
 * and two paths are how a convention drifts without anything failing. syl-5yt
 * closed the union; this is the other half.
 */
export function newMemoryNodeId(generate: () => string = uuidv7): string {
  return newId("memory_node", generate);
}

/** Mint an edge id. See `newMemoryNodeId` for why this delegates. */
export function newMemoryEdgeId(generate: () => string = uuidv7): string {
  return newId("memory_edge", generate);
}

/**
 * Mint a supersession-ledger assertion id (`0017_supersession_ledger.sql`).
 *
 * Its own namespace rather than reusing `memory_node`, for the same reason the
 * node kind is not in the node id: an assertion is a CLAIM WITH A VALIDITY
 * INTERVAL, not a thing the graph knows about, and one id shape must never
 * address two different stores.
 */
export function newMemoryAssertionId(generate: () => string = uuidv7): string {
  return newId("memory_assertion", generate);
}

/** Whether a string addresses a ledger assertion. */
export function isMemoryAssertionId(value: string): boolean {
  return hasNamespace(value, MEMORY_ASSERTION_ID_PREFIX);
}

/** Whether a string addresses a memory node. */
export function isMemoryNodeId(value: string): boolean {
  return hasNamespace(value, MEMORY_NODE_ID_PREFIX);
}

/** Whether a string addresses a memory edge. */
export function isMemoryEdgeId(value: string): boolean {
  return hasNamespace(value, MEMORY_EDGE_ID_PREFIX);
}

function hasNamespace(value: string, prefix: string): boolean {
  return value.startsWith(prefix) && UUID.test(value.slice(prefix.length));
}

/** Whether a value is one of the three tiers. */
export function isMemoryTier(value: unknown): value is MemoryTier {
  return typeof value === "string" && (MEMORY_TIERS as readonly string[]).includes(value);
}

/** Whether a value is one of the node kinds. */
export function isMemoryNodeKind(value: unknown): value is MemoryNodeKind {
  return typeof value === "string" && (MEMORY_NODE_KINDS as readonly string[]).includes(value);
}

/** Whether a value is one of the two edge species. */
export function isMemoryEdgeSpecies(value: unknown): value is MemoryEdgeSpecies {
  return typeof value === "string" && (MEMORY_EDGE_SPECIES as readonly string[]).includes(value);
}

/** Whether rows in this tier are read by a candidate scan. */
export function isScannedTier(tier: MemoryTier): boolean {
  return tier === SCANNED_TIER;
}

/**
 * A partition key value: the pair a scan constrains, and the pair `vec0`
 * declares as `partition key` columns.
 */
export interface PartitionKey {
  readonly tier: MemoryTier;
  /** A {@link MemoryNodeKind} for a node, a {@link MemoryEdgeSpecies} for an edge. */
  readonly kind: string;
}

/**
 * The partition a node belongs to.
 *
 * Validating here rather than trusting the caller is worth it because the
 * failure it prevents is silent: a row written under a kind nothing queries is
 * not an error, it is a memory that never surfaces again.
 *
 * @throws {MemorySchemaError} if either half is outside the vocabulary.
 */
export function nodePartition(tier: unknown, kind: unknown): PartitionKey {
  if (!isMemoryTier(tier)) throw badTier(tier);
  if (!isMemoryNodeKind(kind)) {
    throw new MemorySchemaError(
      `${describe(kind)} is not a memory node kind. Expected one of ${MEMORY_NODE_KINDS.join(", ")}.`,
    );
  }
  return { tier, kind };
}

/**
 * The partition an edge belongs to.
 *
 * @throws {MemorySchemaError} if either half is outside the vocabulary.
 */
export function edgePartition(tier: unknown, species: unknown): PartitionKey {
  if (!isMemoryTier(tier)) throw badTier(tier);
  if (!isMemoryEdgeSpecies(species)) {
    throw new MemorySchemaError(
      `${describe(species)} is not an edge species. Expected one of ${MEMORY_EDGE_SPECIES.join(", ")}.`,
    );
  }
  return { tier, kind: species };
}

/** A partition, in the form a log line should carry it: `hot/person`. */
export function partitionLabel(key: PartitionKey): string {
  return `${key.tier}/${key.kind}`;
}

/**
 * The tier a row belongs in, given the weight it has decayed to.
 *
 * This is the demote/promote rule in one place, and it is the reason the
 * partition key has a tier in it at all.
 *
 * - Above or at the floor: `hot`. The floor is the lowest weight still worth
 *   scanning, not the first one that is not — stated once here so two call
 *   sites cannot disagree by an epsilon.
 * - Below the floor: `cold`. The row MOVES; it is not merely ranked lower.
 * - `suppressed` is terminal. However strong a suppressed edge becomes, it
 *   stays suppressed; only an explicit un-suppression brings it back, because
 *   the Commander's judgement is not something reflection gets to overrule.
 *
 * The decay law and the value of the floor belong to `syl-005.3.2`; the floor
 * is a parameter here precisely so this module does not own it.
 *
 * @param effectiveWeight the DECAYED weight, in (0, 1].
 * @param floor the relevance floor, in (0, 1].
 * @throws {MemorySchemaError} on an unknown tier or a number outside (0, 1].
 */
export function tierAfter(current: unknown, effectiveWeight: number, floor: number): MemoryTier {
  if (!isMemoryTier(current)) throw badTier(current);
  requireUnitInterval(effectiveWeight, "effectiveWeight");
  requireUnitInterval(floor, "floor");

  if (current === "suppressed") return "suppressed";
  return effectiveWeight >= floor ? "hot" : "cold";
}

/**
 * The `vec0` columns declared `partition key`, in order.
 *
 * Exported so `syl-005.2.1` and `syl-005.2.2` cannot re-decide it. A vector
 * table partitioned differently from the graph would prune a different set of
 * rows from the one the graph considers live, which is a correctness bug
 * wearing a performance bug's clothes.
 */
export const VECTOR_PARTITION_KEY_COLUMNS = ["tier", "kind"] as const;

export interface VectorTableOptions {
  /** The virtual table's name. A bare identifier; it is interpolated. */
  readonly table: string;
  /** The embedding width. Owned by `syl-005.2.1`, which picks the model. */
  readonly dimensions: number;
}

/** A bare SQL identifier. Anything else is refused rather than quoted. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The DDL for the memory graph's vector table, with the partition key baked in.
 *
 * `vec0` cannot be created by `0012_memory_core.sql`, because the sqlite-vec
 * extension is not loaded until `syl-005.2.2` brings it in. That is exactly why
 * this function exists: the partition-key decision has to survive the gap
 * between the bead that makes it and the bead that uses it, and a documented
 * intention would not. This is testable today without the extension.
 *
 * Note the lower-case `partition key` — it is sqlite-vec's own spelling, and
 * the string is asserted against in the tests.
 *
 * @throws {MemorySchemaError} on a table name that is not a bare identifier, or
 * a dimension count that is not a positive integer.
 */
export function vectorTableDdl(options: VectorTableOptions): string {
  const { table, dimensions } = options;

  if (!IDENTIFIER.test(table)) {
    throw new MemorySchemaError(
      `${describe(table)} is not a bare SQL identifier. The table name is interpolated into DDL, ` +
        `so it is refused rather than quoted.`,
    );
  }
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new MemorySchemaError(
      `An embedding width must be a positive integer, got ${describe(dimensions)}.`,
    );
  }

  return [
    `CREATE VIRTUAL TABLE ${table} USING vec0(`,
    `  node_id text primary key,`,
    `  tier text partition key,`,
    `  kind text partition key,`,
    `  embedding float[${dimensions}]`,
    `);`,
  ].join("\n");
}

function badTier(value: unknown): MemorySchemaError {
  return new MemorySchemaError(
    `${describe(value)} is not a memory tier. Expected one of ${MEMORY_TIERS.join(", ")}.`,
  );
}

function requireUnitInterval(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new MemorySchemaError(
      `${name} must be a real number in (0, 1], got ${describe(value)}. ` +
        `Zero is excluded on purpose: decay approaches it asymptotically and never arrives, ` +
        `so a stored zero would be an edge that could never be promoted back.`,
    );
  }
}

/** A value, rendered for an error message without throwing on anything. */
function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
