import { systemClock, type Clock } from "../services/clock.js";
import type { Database } from "../services/sqlite.js";
import type { MemoryGraph, MemoryNode } from "./graph.js";
import { ENTITY_NODE_KINDS, SCANNED_TIER } from "./schema.js";
import { crossingInstant } from "./weights.js";

/**
 * The memories Syl makes herself.
 *
 * `syl-016.7`. The Commander: *"She's definitely gonna need a way to make her
 * own memories. That's kind of a ridiculous limitation."* And her own account
 * of what she was doing without one:
 *
 * > "I can't write to my memory directly. The only durable text I control is
 * > goals and reminders. So I've put the connection where it will survive...
 * > And here's the other half, because tonight's distillation reads this
 * > conversation. So let me say it once, in one place, plainly, and give it the
 * > best chance of landing as a unit."
 *
 * She smuggled an insight into a **goal**, then wrote a paragraph aimed at the
 * nightly extractor hoping it would survive the pass. That is an assistant
 * gaming its own memory pipeline to keep a thought, and the thought she was
 * trying to keep was the most valuable thing she has produced.
 *
 *
 * ## This is NOT "let her write facts about him"
 *
 * `EXTRACTION_INSTRUCTION` criterion 3 — *"HE asserted it. Not something Syl
 * offered, guessed or worked out"* — is what stops her fabricating facts about
 * the Commander, and **it is untouched.** Nothing written here ever claims his
 * authority. What this module does is give her inferences the shape the graph
 * already models for exactly this purpose.
 *
 *
 * ## Authorship is marked in TWO places, because they fail differently
 *
 * | marker | says | fails when |
 * | --- | --- | --- |
 * | `kind: "memory"` on the node | *whose* thought this is | never — it is on the row |
 * | `inferred` edges carrying `reasoning` | *why* she thinks it | there are no edges to carry it |
 *
 * The node kind is the load-bearing half and the less obvious one. A memory
 * that names no entity has **no edges at all**, so the species — which is an
 * edge property, not a node one — has nothing to travel on. Without the kind,
 * that thought would be indistinguishable from a fact he asserted the moment it
 * was written. `fact` is what `extract-apply.ts` files from his words; `memory`
 * is what she concluded, and `working.ts` has rendered a `## Memories` section
 * for it since before anything wrote one.
 *
 * The edges are `inferred` and never `observed`, and that is the same decision
 * stated at the edge: `observed` carries `assertedBy`, which is precisely the
 * claim that somebody said so. She may not produce one.
 *
 *
 * ## Why NOT `memory_provenance`, which looks like where this belongs
 *
 * `0025_memory_provenance.sql` holds `{ said_in, quote, why }` per fact, and
 * `why` is exactly the field this module needs. It cannot be used, and the
 * reason is a good one rather than an inconvenience: the table requires a
 * `digest REFERENCES memory_extractions`, a `said_in GLOB 'syl:message:*'` and
 * a non-blank `quote` **copied from that message**. Her own conclusion has no
 * extraction behind it, no message asserting it, and no words of his to quote.
 *
 * Writing her memories there would mean inventing all three — which is the
 * fabricated provenance that table exists to make impossible. Its `quote` is
 * DERIVED precisely so it is evidence rather than a claim; a derived field with
 * nothing to derive from is a lie with a schema. So her reasoning travels on
 * the edge, where an inference's reasoning already lives, and `memory_
 * provenance` stays what it is: the record of what HE said.
 *
 *
 * ## It decays, and he can kill it — constraint 6
 *
 * Every link takes a `demoteAfter`, so an inference nothing reinforces slides
 * toward the floor on its own. Nothing here deletes: a demoted edge stays
 * addressable and can be promoted straight back if it becomes relevant. And the
 * edges are reachable by `POST /memory/edges/{id}/feedback`, so a wrong
 * connection is one tap for him rather than an argument.
 *
 *
 * ## She cannot invent people
 *
 * `about` resolves against entities that **already exist** and mints nothing.
 * A graph that grows a person because she typed a name is a graph that
 * accumulates fiction, and the failure would be invisible — a `person` node
 * looks the same however it got there. What did not resolve comes back in
 * {@link Remembered.unknown} so she can say "I do not know an Ela yet" rather
 * than quietly keeping a thought about nobody.
 */

/** How sure a memory she states outright is. */
export const REMEMBERED_CONFIDENCE = 0.8;

/**
 * The weight a link starts at.
 *
 * Below 1.0 deliberately. This is her own judgement stated once, not a
 * conclusion the nightly reflection reached over a corpus and not something he
 * confirmed — so it starts a little under full strength and earns the rest
 * through `EdgeWeights.touch`, which is the same shape as `DEFAULT_TRUST` in
 * `retrieve.ts` and for the same reason: certainty has to be reachable, and
 * starting at the ceiling makes reinforcement a no-op.
 */
export const REMEMBERED_WEIGHT = 0.8;

/** The relation a memory bears to the thing it is about. */
export const CONCERNS_RELATION = "concerns";

/** What was wrong with a memory she tried to keep. */
export type RememberErrorKind = "blank_thought" | "blank_reason";

export class RememberError extends Error {
  readonly kind: RememberErrorKind;

  constructor(kind: RememberErrorKind, message: string) {
    super(message);
    this.name = "RememberError";
    this.kind = kind;
  }
}

/** What she is asking to keep. */
export interface RememberInput {
  /** The thought itself, in her own words. */
  readonly thought: string;
  /** Why she believes it. Required — an inference nobody can judge is noise. */
  readonly because: string;
  /** People or things it concerns, by name. Resolved, never minted. */
  readonly about?: readonly string[];
}

/** One link her memory made. */
export interface RememberedLink {
  /** The name she gave, as she gave it. */
  readonly name: string;
  readonly nodeId: string;
  readonly edgeId: string;
}

/** What was kept. */
export interface Remembered {
  readonly nodeId: string;
  /** `false` when she had already reached this conclusion and it was reused. */
  readonly created: boolean;
  readonly links: readonly RememberedLink[];
  /** Names that matched no thing she knows. Never minted, always reported. */
  readonly unknown: readonly string[];
  readonly at: string;
}

export interface HerOwnMemoryOptions {
  readonly db: Database;
  readonly graph: MemoryGraph;
  readonly clock?: Clock;
}

/**
 * One hot entity with this label, or `null`.
 *
 * `COLLATE NOCASE` because she is typing a name rather than selecting one, and
 * `ENTITY_NODE_KINDS` because `about` names a THING — hanging a conclusion off
 * another claim would build a chain of inference nobody can read back.
 */
const ENTITY_SQL =
  `SELECT id FROM memory_nodes WHERE label = ? COLLATE NOCASE AND tier = ? ` +
  `AND kind IN (${ENTITY_NODE_KINDS.map(() => "?").join(", ")}) ` +
  `ORDER BY updated_at DESC, id LIMIT 1`;

/** Her own conclusion, reused rather than duplicated. See {@link HerOwnMemory.remember}. */
const MEMORY_IDENTITY_SQL =
  `SELECT id FROM memory_nodes WHERE kind = 'memory' AND label = ? COLLATE NOCASE ` +
  `AND tier = ? ORDER BY updated_at DESC, id LIMIT 1`;

/** How long a memory's label may be before it is a body with no label. */
const LABEL_MAX_CHARS = 120;

export class HerOwnMemory {
  readonly #db: Database;
  readonly #graph: MemoryGraph;
  readonly #clock: Clock;

  constructor(options: HerOwnMemoryOptions) {
    this.#db = options.db;
    this.#graph = options.graph;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Keep something she worked out.
   *
   * **Validated before anything is written**, and the whole write is one
   * savepoint. A memory node with no reasoning attached to it is precisely the
   * unattributable residue this bead exists to remove, so a partial write here
   * would recreate the defect in a new place.
   *
   * The node is reused when she reaches the same conclusion again — she will,
   * and a second identical memory is noise competing with itself for salience.
   * The *reasoning* is new each time, so the link is written afresh where there
   * was none and left alone where there was: `findEdge` first, exactly as
   * `extract-apply.ts` does, because a duplicate edge is refused by the store
   * and would take the whole write down with it.
   *
   * @throws {RememberError} `blank_thought`, `blank_reason`.
   */
  remember(input: RememberInput): Remembered {
    const thought = input.thought.trim();
    if (thought === "") {
      throw new RememberError(
        "blank_thought",
        "There is nothing here to remember. A blank memory takes up salience and says nothing.",
      );
    }

    const because = input.because.trim();
    if (because === "") {
      throw new RememberError(
        "blank_reason",
        "A memory she made carries why she believes it. Without that he can only accept or " +
          "reject the whole thought, and the correction that matters — that she reasoned " +
          "wrongly from something true — is one he cannot make.",
      );
    }

    const at = this.#clock();
    const label = labelFor(thought);

    // Resolved BEFORE the savepoint opens. Nothing here writes, and knowing
    // what will not resolve is part of deciding what to say back to her.
    const named = (input.about ?? []).map((name) => name.trim()).filter((name) => name !== "");
    const resolved: { name: string; node: MemoryNode }[] = [];
    const unknown: string[] = [];
    for (const name of named) {
      const node = this.#entityNamed(name);
      if (node === null) unknown.push(name);
      else resolved.push({ name, node });
    }

    this.#db.exec("SAVEPOINT syl_remember");
    try {
      const existing = this.#existingMemory(label);
      const node =
        existing ?? this.#graph.addNode({ kind: "memory", label, body: thought });

      const links: RememberedLink[] = [];
      for (const { name, node: about } of resolved) {
        if (about.id === node.id) continue;
        const already = this.#graph.findEdge(node.id, about.id, CONCERNS_RELATION);
        const edge =
          already ??
          this.#graph.infer({
            sourceNode: node.id,
            targetNode: about.id,
            relation: CONCERNS_RELATION,
            // HER reason, on the edge, which is where an inference's reasoning
            // already lives and where the admin view and `recall` both read it.
            reasoning: because,
            confidence: REMEMBERED_CONFIDENCE,
            weight: REMEMBERED_WEIGHT,
            demoteAfter: crossingInstant(REMEMBERED_WEIGHT, at),
          });
        links.push({ name, nodeId: about.id, edgeId: edge.id });
      }

      this.#db.exec("RELEASE syl_remember");
      return {
        nodeId: node.id,
        created: existing === null,
        links,
        unknown,
        at: node.updatedAt,
      };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK TO syl_remember");
        this.#db.exec("RELEASE syl_remember");
      } catch {
        // Already gone; the original failure is the one worth reporting.
      }
      throw error;
    }
  }

  /** A hot entity with this label, or `null`. Never mints one. */
  #entityNamed(name: string): MemoryNode | null {
    const row = this.#db.prepare(ENTITY_SQL).get(name, SCANNED_TIER, ...ENTITY_NODE_KINDS);
    if (row === undefined) return null;
    return this.#graph.getNode((row as unknown as { id: string }).id);
  }

  /** A memory she has already kept under this label, or `null`. */
  #existingMemory(label: string): MemoryNode | null {
    const row = this.#db.prepare(MEMORY_IDENTITY_SQL).get(label, SCANNED_TIER);
    if (row === undefined) return null;
    return this.#graph.getNode((row as unknown as { id: string }).id);
  }
}

/**
 * A label for a thought that is a paragraph.
 *
 * Her memories are prose — the one she tried to keep was three clauses long —
 * and `label` is the field every view shows. So the first sentence becomes the
 * label and the whole thought stays in `body`, which is what `renderEntry` in
 * `working.ts` already expects of a node with both.
 *
 * Identity is keyed on the label, so this doubles as the sameness rule: two
 * tellings of one conclusion collapse when they open the same way, and diverge
 * when they do not. That is the right side to err on — a duplicate is noise,
 * and a wrongly-merged pair would lose one of them.
 */
export function labelFor(thought: string): string {
  const oneLine = thought.replace(/\s+/gu, " ").trim();
  const stop = oneLine.search(/[.:;!?]\s/u);
  const head = stop === -1 ? oneLine : oneLine.slice(0, stop);
  if (head.length <= LABEL_MAX_CHARS) return head;
  const cut = head.slice(0, LABEL_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > LABEL_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
