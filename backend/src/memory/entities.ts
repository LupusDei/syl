import { SCANNED_TIER, type MemoryNodeKind } from "./schema.js";

import type { MemoryNode } from "./graph.js";
import type { InferredRelation } from "./relations.js";

/**
 * Who is who, and how they are related, read out of the graph's own labels.
 *
 *
 * ## The two defects this module reads, both measured on the live graph
 *
 * On 2026-08-11 the graph held thirty nodes. Six were people. Five of the six
 * carried the relationship IN THE LABEL TEXT — `"Ela — his wife"`,
 * `"Rowan — his son"`, `"Isla — his daughter"` — and one woman appeared twice,
 * as `"Ela"` and as `"Ela — his wife"`, with nothing anywhere recording that
 * they were the same person. The newer, thinner duplicate then EVICTED the
 * richer one from working memory.
 *
 * Neither defect is missing information. Both are information written into a
 * display string instead of into a column that can be queried, and this module
 * is the reader that moves it: the label's leading NAME answers "who is this",
 * and the label's trailing DESCRIPTOR answers "how is he related to them".
 *
 * One parser serves both, which is why they are one module. `parseLabel` splits
 * `"Ela — his wife"` once; {@link groupIdentities} takes the name and
 * {@link proposeFromProse} takes the descriptor.
 *
 *
 * ## Why this is deterministic and not a model turn
 *
 * It reads what the extractor ALREADY DECIDED. The judgment — "this person is
 * worth remembering, and she is his wife" — was made by the extraction turn,
 * checked against the four admission tests, and attributed to one of the
 * Commander's own messages. Asking a second model to re-derive it would pay a
 * subprocess to re-decide something already decided, and would put an
 * attacker-influenceable turn in the path of a conclusion that no longer needs
 * one.
 *
 * So this half cannot be talked into anything: it matches a CLOSED set of
 * English possessive descriptors, maps them to a CLOSED set of relations, and
 * declines on everything else. `digest.ts` is the model half, for the
 * connections that are not already written down, and it is bounded, sealed and
 * discardable in the way this is not required to be.
 *
 *
 * ## The trap, stated before the code
 *
 * `"Justin Martin"` and `'Robert C. Martin ("Uncle Bob") — his father'` are in
 * the live graph and are DIFFERENT PEOPLE who share a surname. Every cheap
 * identity rule — shared token, substring, longest common suffix, edit distance
 * — merges them. So the rule here is **whole-name equality after normalisation**
 * and nothing weaker: `"robert c martin"` and `"justin martin"` differ, and
 * differ under `includes` in both directions, which the tests assert directly.
 *
 * A wrong merge is not demotable the way an edge is. An edge Syl gets wrong
 * decays, is demoted, and stays addressable; two people collapsed into one is a
 * lost distinction that has to be reconstructed by hand. That asymmetry is why
 * this module PROPOSES far more readily than it applies.
 */

/**
 * The one node kind an identity may be claimed for.
 *
 * Not a stylistic narrowing. `memory_nodes_handle_idx` (`0019_working_memory.
 * sql`) is UNIQUE on `(subject_id, kind)` for `goal` and `source`, so two goals
 * sharing an identity is a constraint violation rather than merely a bad idea —
 * `subject_id` on those kinds means "the operational row this node is a handle
 * for", which is a different claim entirely and one the projection contract
 * owns.
 *
 * `person` is the kind that HAS an identity in the sense meant here: two rows,
 * one human being. Extending this to organisations or places is a real
 * follow-up and needs a look at that index first.
 */
export const RESOLVABLE_KIND: MemoryNodeKind = "person";

/** How sure a relation read out of the extractor's own prose is. */
export const PROSE_CONFIDENCE = 0.7;

/** How sure whole-name equality with agreeing descriptors is. */
export const MERGE_CONFIDENCE = 0.9;

/** How sure a same-name collision with disagreeing evidence is. Deliberately low. */
export const PROPOSAL_CONFIDENCE = 0.35;

/** Shortest normalised name that identifies anybody. One character is an initial. */
const MIN_NAME_CHARS = 2;

/**
 * The separator the extractor puts between a name and its descriptor.
 *
 * Spaces on both sides are required, which is what keeps `"Anne-Marie"` a name
 * rather than a name and a descriptor. All three dash spellings are accepted
 * because the same model emits all three.
 */
const DESCRIPTOR_SEPARATOR = /\s+[—–-]\s+/u;

/** A label, split into the part that identifies and the part that describes. */
export interface ParsedLabel {
  /** What the person is called, with any parenthetical nickname still attached. */
  readonly name: string;
  /** What the extractor appended after the dash, or `null`. */
  readonly descriptor: string | null;
}

/**
 * Split a label into a name and a descriptor.
 *
 * Splits at the FIRST separator only, and the remainder is the descriptor
 * whether or not it contains another dash. A second split point in a label is
 * far more likely to be punctuation inside a description than a third field.
 */
export function parseLabel(label: string): ParsedLabel {
  const match = DESCRIPTOR_SEPARATOR.exec(label);
  if (match === null || match.index === 0) return { name: label.trim(), descriptor: null };

  const name = label.slice(0, match.index).trim();
  const descriptor = label.slice(match.index + match[0].length).trim();
  if (name === "" || descriptor === "") return { name: label.trim(), descriptor: null };
  return { name, descriptor };
}

/**
 * A name reduced to what is worth comparing, or `""` when nothing is left.
 *
 * Everything removed here is a SPELLING rather than an identity: case, accents,
 * punctuation, a parenthetical nickname, repeated whitespace. Everything kept
 * is a whole word of the name, and comparison is equality over the whole
 * result — never over a token, a prefix or a substring. See the module header
 * for the two people that rule exists to keep apart.
 *
 * The empty string means "this cannot identify anybody" and is never grouped:
 * a single initial would put every `"E"` in the graph into one person.
 */
export function normaliseName(name: string): string {
  const folded = name
    // Decompose so the combining marks can be dropped on their own; `Éla` and
    // `Ela` are one name typed two ways.
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    // A parenthetical or quoted nickname is an aside about the name, not part
    // of it: `Robert C. Martin ("Uncle Bob")` and `Robert C. Martin` are one man.
    .replace(/\([^)]*\)/gu, " ")
    .replace(/["'“”‘’]/gu, " ")
    .toLowerCase()
    // Everything that is not a letter, a digit or a space. Keeps `robert c
    // martin` comparable with `robert c. martin`.
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return folded.length < MIN_NAME_CHARS ? "" : folded;
}

/**
 * The closed map from a possessive descriptor to a relation.
 *
 * Keys are the descriptor's SECOND word, after the possessive. Anything not
 * here yields no edge at all — `"his colleague"` is a real relationship with no
 * name in the vocabulary, and an `about` edge for it would be the escape hatch
 * used as a shrug.
 */
const KINSHIP: Readonly<Record<string, InferredRelation>> = {
  wife: "spouse_of",
  husband: "spouse_of",
  spouse: "spouse_of",
  partner: "spouse_of",
  son: "child_of",
  daughter: "child_of",
  child: "child_of",
  father: "parent_of",
  mother: "parent_of",
  dad: "parent_of",
  mum: "parent_of",
  mom: "parent_of",
  parent: "parent_of",
  brother: "sibling_of",
  sister: "sibling_of",
  sibling: "sibling_of",
};

/**
 * A descriptor of exactly the form `his <word>`, mapped to its relation.
 *
 * **The possessive is required, and it is the security-relevant half.** A
 * descriptor is prose the extraction turn wrote after reading a transcript that
 * may contain a pasted article, so `"the wife of the chief executive"` is a
 * claim about somebody in a document and `"her daughter"` is a claim about
 * somebody else again. Only `his` addresses the Commander. Exactly two words,
 * so `"his old friend from school"` — which is not any of these relations —
 * yields nothing rather than matching on its last word.
 */
function relationFromDescriptor(descriptor: string): InferredRelation | null {
  const words = descriptor.toLowerCase().replace(/[^\p{L}\s]/gu, " ").trim().split(/\s+/u);
  if (words.length !== 2 || words[0] !== "his") return null;
  return KINSHIP[words[1] ?? ""] ?? null;
}

/**
 * How the extractor marks the Commander's own node.
 *
 * Its convention, not ours: it writes `body: "The Commander."` for him, which
 * is what the live graph contains. Matched as a whole phrase so a fact
 * mentioning a commander in an article does not qualify.
 */
const COMMANDER_MARKER = /\bthe commander\b/iu;

/** Whether this node is the Commander himself. */
export function isCommanderNode(node: MemoryNode): boolean {
  if (node.kind !== RESOLVABLE_KIND) return false;
  return COMMANDER_MARKER.test(node.label) || COMMANDER_MARKER.test(node.body ?? "");
}

/**
 * The Commander's node, or `null` when the graph cannot say which it is.
 *
 * `null` for none AND for more than one, and both cases are correct. Every
 * kinship descriptor is a claim about him, so picking the wrong node would
 * attach his whole family to a stranger — and unlike a wrong relation, that is
 * a wrong ENDPOINT, which no amount of decay makes less wrong. Declining costs
 * one pass; the edges are read again next time from labels that have not moved.
 */
export function findCommanderNode(nodes: readonly MemoryNode[]): MemoryNode | null {
  const marked = nodes.filter((node) => node.tier === SCANNED_TIER && isCommanderNode(node));
  if (marked.length === 1) return marked[0] ?? null;
  if (marked.length > 1) return null;
  return unmarkedCommander(nodes);
}

/**
 * The anchor when nothing carries the marker, which on the live graph is
 * always (`syl-zdf.15`).
 *
 * **Every relational descriptor is a possessive claim about him.** "his wife",
 * "his son", "his father" — the referent is never named because, to the
 * extractor, he is the one person who does not need introducing. So he is the
 * person nobody is described *relative to*: the identity that carries no
 * relational descriptor while others carry one.
 *
 * Grouping by identity FIRST is what makes this work rather than merely
 * plausible. The live graph holds two nodes for one wife — `"Ela — his wife"`
 * and a bare `"Ela"` — and the bare one is descriptor-less, so a scan over raw
 * nodes finds two candidates and declines. Folding them together first leaves
 * the descriptor attached to her identity, and exactly one candidate standing.
 *
 * **It declines rather than guesses**, and that asymmetry is the whole safety
 * argument. A colleague mentioned by bare name produces a second candidate and
 * this returns `null`, costing one quiet pass in which nothing is connected.
 * Picking one instead would hang his wife, his children and his father off a
 * stranger — and unlike an inferred edge, which decays, a whole family wired to
 * the wrong person is a shape that looks deliberate forever.
 *
 * This is a heuristic standing in for an identity the system should simply be
 * told. It is strictly better than matching a phrase the extractor has never
 * produced, and it is still the most fragile joint in digestion: an explicit
 * configured identity, seeded at bootstrap, is the real answer.
 */
function unmarkedCommander(nodes: readonly MemoryNode[]): MemoryNode | null {
  const byName = new Map<string, { described: boolean; first: MemoryNode }>();

  for (const node of nodes) {
    if (node.tier !== SCANNED_TIER || node.kind !== RESOLVABLE_KIND) continue;
    const { name, descriptor } = parseLabel(node.label);
    const key = normaliseName(name);
    if (key === "") continue;

    const seen = byName.get(key);
    if (seen === undefined) byName.set(key, { described: descriptor !== null, first: node });
    else if (descriptor !== null) seen.described = true;
  }

  const candidates = [...byName.values()].filter((entry) => !entry.described);
  return candidates.length === 1 ? (candidates[0]?.first ?? null) : null;
}

/** What should happen to a set of nodes that look like one person. */
export type IdentityVerdict = "merge" | "propose";

/** One group of nodes that name the same person, and what may be done about it. */
export interface IdentityGroup {
  /** `merge` applies automatically; `propose` is recorded and surfaced. */
  readonly verdict: IdentityVerdict;
  /**
   * The normalised name they share.
   *
   * Empty when the claim did not come from name equality at all — a digestion
   * turn saying "these two are the same person" produces a `propose` group with
   * no shared name, and it is proposed precisely BECAUSE nothing structural
   * backs it up.
   */
  readonly name: string;
  /** The nodes that still need stamping. Never includes one that already agrees. */
  readonly nodeIds: readonly string[];
  /** An identity one of them already carries, or `null` to mint a fresh one. */
  readonly subjectId: string | null;
  readonly confidence: number;
  /** Why, in one sentence, quoting the labels that were compared. */
  readonly reasoning: string;
}

interface Candidate {
  readonly node: MemoryNode;
  readonly name: string;
  readonly descriptor: string | null;
}

/**
 * Which nodes name the same person, and whether we are sure enough to say so.
 *
 * Auto-merge needs BOTH halves and neither is sufficient alone:
 *
 * 1. **Whole-name equality after normalisation.** Not a shared token — see the
 *    module header, and the Commander's father.
 * 2. **At most one distinct descriptor across the group.** `"Ela"` and
 *    `"Ela — his wife"` agree, because one of them says nothing. `"Ela — his
 *    wife"` and `"Ela — his colleague"` DISAGREE, and two people who happen to
 *    share a first name is the exact mirror of the surname trap. That group is
 *    proposed, not applied.
 *
 * A group whose members already claim two different identities is also only
 * proposed: reconciling two existing identities is a merge of merges, and the
 * one thing worse than a wrong merge is a wrong merge that swallowed a right one.
 *
 * Returns nothing at all for a group that already agrees — no verdict, no
 * write. Digestion runs after every turn and re-examines the same
 * neighbourhood constantly, so "nothing to do" has to be free and has to be
 * OBSERVABLE as free.
 */
export function groupIdentities(nodes: readonly MemoryNode[]): readonly IdentityGroup[] {
  const byName = new Map<string, Candidate[]>();

  for (const node of nodes) {
    // The scanned tier only. A superseded or suppressed node was set aside on
    // purpose, and pulling one into a live identity would quietly resurrect
    // what a correction retired.
    if (node.kind !== RESOLVABLE_KIND || node.tier !== SCANNED_TIER) continue;

    const parsed = parseLabel(node.label);
    const name = normaliseName(parsed.name);
    if (name === "") continue;

    const group = byName.get(name) ?? [];
    group.push({ node, name, descriptor: parsed.descriptor });
    byName.set(name, group);
  }

  const groups: IdentityGroup[] = [];

  for (const [name, candidates] of byName) {
    if (candidates.length < 2) continue;

    const labels = candidates.map((candidate) => JSON.stringify(candidate.node.label)).join(" and ");
    const claimed = new Set(
      candidates
        .map((candidate) => candidate.node.subjectId)
        .filter((subjectId): subjectId is string => subjectId !== null),
    );
    const descriptors = new Set(
      candidates
        .map((candidate) => candidate.descriptor?.toLowerCase().trim())
        .filter((descriptor): descriptor is string => descriptor !== undefined && descriptor !== ""),
    );

    if (claimed.size > 1) {
      groups.push({
        verdict: "propose",
        name,
        nodeIds: candidates.map((candidate) => candidate.node.id),
        subjectId: null,
        confidence: PROPOSAL_CONFIDENCE,
        reasoning:
          `${labels} normalise to the same name, but already carry ${String(claimed.size)} ` +
          `different identities. Reconciling two identities is a merge of merges and is not ` +
          `applied automatically.`,
      });
      continue;
    }

    if (descriptors.size > 1) {
      groups.push({
        verdict: "propose",
        name,
        nodeIds: candidates.map((candidate) => candidate.node.id),
        subjectId: claimed.values().next().value ?? null,
        confidence: PROPOSAL_CONFIDENCE,
        reasoning:
          `${labels} share the name ${JSON.stringify(name)} but describe different people ` +
          `(${[...descriptors].map((d) => JSON.stringify(d)).join(", ")}). Two people who share ` +
          `a first name is the mirror image of two people who share a surname; neither is merged ` +
          `on the name alone.`,
      });
      continue;
    }

    const subjectId = claimed.values().next().value ?? null;
    // Only the rows that still need stamping. Re-writing one that already
    // agrees would bump `updated_at` on every pass, which would make a second
    // identical run indistinguishable from a first.
    //
    // When `subjectId` is `null` there is no identity yet, so EVERY row needs
    // one — comparing each row's `null` against the group's `null` would say
    // they all already agree, which is how "resolve these two" became "do
    // nothing" the first time this was written.
    const nodeIds =
      subjectId === null
        ? candidates.map((candidate) => candidate.node.id)
        : candidates
            .filter((candidate) => candidate.node.subjectId !== subjectId)
            .map((candidate) => candidate.node.id);
    if (nodeIds.length === 0) continue;

    groups.push({
      verdict: "merge",
      name,
      nodeIds,
      subjectId,
      confidence: MERGE_CONFIDENCE,
      reasoning:
        `${labels} name the same person: both normalise to ${JSON.stringify(name)}, and ` +
        `nothing in either label describes a different person.`,
    });
  }

  return groups;
}

/** A relation read out of the extractor's own prose. */
export interface ProseEdge {
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly relation: InferredRelation;
  /** The phrase that was read, quoted. This is what makes the edge auditable. */
  readonly reasoning: string;
  readonly confidence: number;
}

/**
 * Move the relationships out of the label text and into the relation column.
 *
 * Every edge points AT the Commander, because every descriptor is a claim about
 * him: `"Ela — his wife"` is `Ela --spouse_of--> him`, `"Rowan — his son"` is
 * `Rowan --child_of--> him`, `'Robert C. Martin — his father'` is
 * `Robert --parent_of--> him`. The direction is read off the descriptor rather
 * than normalised to one canonical direction, so `child_of` and `parent_of`
 * both stay traversable and neither has to be inverted at read time.
 *
 * **Nothing is written when the relation cannot be named** — see
 * `relationFromDescriptor` — and **nothing is written when the Commander cannot
 * be identified**, because an edge with the right relation and the wrong
 * endpoint is worse than no edge at all.
 */
export function proposeFromProse(nodes: readonly MemoryNode[]): readonly ProseEdge[] {
  const commander = findCommanderNode(nodes);
  if (commander === null) return [];

  const edges: ProseEdge[] = [];

  for (const node of nodes) {
    if (node.kind !== RESOLVABLE_KIND || node.tier !== SCANNED_TIER) continue;
    if (node.id === commander.id) continue;
    // A second row for the Commander himself — he is not his own wife's spouse
    // twice over, and `graph.infer` refuses a self edge anyway. Caught here so
    // the refusal is a decision rather than an exception.
    if (isCommanderNode(node)) continue;

    const parsed = parseLabel(node.label);
    if (parsed.descriptor === null) continue;

    const relation = relationFromDescriptor(parsed.descriptor);
    if (relation === null) continue;

    edges.push({
      sourceNode: node.id,
      targetNode: commander.id,
      relation,
      reasoning:
        `Read from the label ${JSON.stringify(node.label)}: the extraction turn recorded ` +
        `${JSON.stringify(parsed.descriptor)} in the label text, which is prose nothing can ` +
        `query. This edge is that same statement in the relation column.`,
      confidence: PROSE_CONFIDENCE,
    });
  }

  return edges;
}
