import { createHash } from "node:crypto";

import { instant, systemClock, type Clock } from "../services/clock.js";
import type { Database } from "../services/sqlite.js";
import type { MemoryGraph, SalientNode } from "./graph.js";
import type { MemoryNodeKind } from "./schema.js";

/**
 * Working memory: a PROJECTION of the graph's hot region.
 *
 *
 * ## It is not a fourth store, and this is the thing to get right
 *
 * The master plan §4 lists working memory alongside the graph, the vector
 * index and the source store, as though it were a peer. **Proposal A §5
 * corrects that**, and the plan was never amended — so a reader of the plan
 * alone builds a fourth store, and it looks entirely reasonable while doing
 * it. There is nothing to notice: a store with the same contents behaves
 * identically on day one.
 *
 * It diverges on day thirty. A store accumulates, so it keeps facts the graph
 * has since demoted, suppressed or renamed. It becomes an authority — the
 * cheapest one to read, so the one everything reads — and it is the only part
 * of the memory system with no path back to what it was derived from. Nothing
 * errors. Syl simply starts being confidently out of date.
 *
 * A projection has one defence and it is total: it is thrown away and rebuilt
 * from the graph. `0019_working_memory.sql` makes that a fact about the schema
 * — the table has `CHECK (id = 1)` and therefore cannot hold a second
 * generation — rather than a discipline someone has to maintain.
 *
 *
 * ## Why it exists: stop gambling on retrieval for the common case
 *
 * Perfect retrieval is unsolved. Every RAG system's failure mode is the same:
 * the answer was in the corpus and the query did not find it, and the model
 * confidently says it does not know. Betting the ordinary case on that is the
 * mistake.
 *
 * So Syl does not retrieve who the Commander is. She arrives already knowing
 * — the hot region of the graph, distilled, in the prompt before the first
 * token of his message. Deep memory is searched only when something specific
 * is needed, which is the case retrieval is actually good at. It is the
 * compaction pattern promoted from emergency measure to primary mechanism.
 *
 *
 * ## The budget, and the cliff underneath it
 *
 * {@link WORKING_MEMORY_MAX_BYTES} is 32,000 bytes — roughly 8,000 tokens —
 * across at most {@link WORKING_MEMORY_MAX_LINES} lines.
 *
 * The number is chosen against what it is spent on: this is prepended to
 * *every* turn on every lane, so it is paid for on the morning agenda, the
 * evening review, every heartbeat and every message. It is the one cost in
 * the system that recurs on literally every turn, which is why it is written
 * down here rather than left to grow.
 *
 * ### Why it was 4,000 and is now 32,000
 *
 * The original argument was sound and its arithmetic was not. It reasoned that
 * 4,000 bytes "still holds on the order of fifty distilled lines" — but
 * {@link WORKING_MEMORY_ENTRY_MAX_CHARS} is 160, so the real ceiling was
 * 4,000/160 ≈ **25 entries**, and {@link WORKING_MEMORY_MAX_LINES} at 60 bound
 * even earlier. Measured against the live graph on 2026-08-11 it admitted 23
 * of 30 nodes and dropped the Commander's own name, his wife, his son and his
 * daughter (`syl-ulf`). A budget that cannot hold thirty memories was sized
 * for a corpus of fifty thousand.
 *
 * The word doing the work in that sentence was **distilled**, and nothing
 * distils: {@link renderEntry} emits the label plus the raw body and truncates
 * mid-sentence. The digest is supposed to be *written* by the nightly
 * consolidation ("consolidation writes a compact digest of the current state
 * of play"), which has never run, so the budget was sized for an artefact that
 * has never been produced.
 *
 * Raised to 32,000 on the Commander's explicit order, 2026-08-11, with the
 * cost accepted: *"I'm fine with it burning extra tokens. I want more context
 * in memory and if it ever gets too expensive, we can start rolling that
 * back."* This is a STOPGAP and is documented as one — it buys room while the
 * two real fixes land (distillation, and a salience signal that is not a
 * constant). A larger budget filled by a broken ranker is more of the wrong
 * things, in recency order.
 *
 * The reason it is enforced rather than aspired to is `syl-03d`: Claude Code's
 * `MEMORY.md` loads its first 200 lines / 25 KB and **silently ignores the
 * rest**, so a memory past the cliff is on disk and unreachable, and the
 * system looks healthy. That failure is not specific to that file — it is what
 * happens to anything that is loaded up to a limit. `index-guarantee.ts`
 * answered it by fitting entries into an explicit budget and NAMING what did
 * not fit inside the text itself. This module copies that answer exactly:
 *
 * - {@link buildWorkingMemory} admits entries in rank order until the next one
 *   would not fit, reserving room for the overflow notice as it goes;
 * - what did not fit is counted in the text (`…and N more`), never dropped
 *   silently;
 * - the store refuses to write anything over budget
 *   ({@link WorkingMemoryOverflowError}), and `0017`'s
 *   `CHECK (bytes <= 4096)` is the backstop under that.
 *
 *
 * ## Regenerated, not accumulated — and why the text carries no timestamp
 *
 * {@link WorkingMemory.regenerate} renders the projection, hashes it, and
 * **writes only when the digest moved**. Run it twice against an unchanged
 * graph and the second run changes nothing at all, including `generated_at` —
 * which therefore means "when the projection last changed", not "when a job
 * last ran".
 *
 * That is why there is no generation timestamp inside {@link WorkingMemoryPlan.text}.
 * A stamp in the rendered text would change the digest on every run, so every
 * run would be a write, and idempotence would be untestable and untrue — with
 * the added cost that the prompt preamble would differ on every turn and
 * defeat prompt caching. The stamp lives in a column, where it belongs.
 *
 *
 * ## Where it is produced: a step the dream CALLS, not a step inside the dream
 *
 * The nightly consolidation produces it, but deliberately not from inside
 * `DreamJudge`:
 *
 * - **It costs no tokens.** Selection is one indexed read and rendering is
 *   deterministic string work. Folding it into the judgment turn would spend
 *   the scarce, subscription-billed resource on something free, and make it
 *   subject to the ten-minute turn kill.
 * - **A dream that fails must still leave working memory correct.** Sessions
 *   end `abandoned`, `ceiling_reached` and `failed` — those are first-class
 *   outcomes in the dream log. Regeneration after a partial night is exactly
 *   as valid as after a complete one, because it reads the graph as it now
 *   stands and does not care how it got there.
 * - **It must be runnable on its own** — after a restore, after a manual
 *   graft, or as a repair when the preamble looks stale. A step inside a
 *   billed turn cannot be.
 * - **Constraint 7**: the dream log is telemetry ABOUT the graph. This is
 *   derived FROM the graph. Keeping the two apart keeps the direction of
 *   dependency legible.
 *
 * Concretely: the nightly job calls `DreamJudge.dream(...)` and then
 * {@link WorkingMemory.regenerate} in a `finally`. `dream()` already returns a
 * `JudgeReport` for every outcome it has and throws for the rest, so the
 * `finally` is what makes "a failed night still leaves working memory correct"
 * true rather than intended.
 *
 * The consolidation lane asserts auto-memory OFF, so what this produces goes
 * to `working_memory` and never to Claude Code's own memory directory.
 */

/** The most bytes the projection may occupy. See the header for the argument. */
export const WORKING_MEMORY_MAX_BYTES = 32_000;

/**
 * The most lines it may occupy.
 *
 * Raised with the byte budget and for the same reason. These two are a PAIR:
 * whichever binds first is the real budget, so raising bytes alone would have
 * moved the ceiling nowhere. At 4,000/60 the line cap bound at 51 entries
 * before a single byte of the byte budget was at risk.
 */
export const WORKING_MEMORY_MAX_LINES = 480;

/**
 * How many hot nodes are considered before the budget is applied.
 *
 * Raised with the budget: this is the candidate pool the ranker sorts, so a
 * pool smaller than the budget can hold is a cap the budget cannot see. At 200
 * against 32,000 bytes the scan would have become the binding constraint.
 */
export const WORKING_MEMORY_SCAN_LIMIT = 1_000;

/** Longest rendered entry, label and detail together. */
export const WORKING_MEMORY_ENTRY_MAX_CHARS = 160;

/** The projection's title line. */
export const WORKING_MEMORY_TITLE = "# Working memory";

/**
 * The note that tells the reader — model or human — what this is.
 *
 * It says "projection" and "regenerated" in the text itself, because the
 * single most likely future mistake is a turn treating it as somewhere to
 * write things down.
 */
export const WORKING_MEMORY_NOTE =
  "<!-- syl:working-memory — a projection of the memory graph's hot region, " +
  "regenerated by the nightly consolidation. Not a store: anything written here " +
  "is overwritten. Search deep memory when you need something specific. -->";

/** What is said when the hot region is empty. Never an empty projection. */
/**
 * What she is handed when there is nothing to hand her.
 *
 * It used to say "Everything Syl knows is in deep memory", which is written for
 * a cold hot region over a POPULATED graph and is false when the graph is
 * empty — it tells her she knows things she does not, and she reads it as
 * memory she simply has not surfaced yet. Same shape as the fabricated `ls`,
 * one layer up: a claim outrunning its evidence, this time made by the memory
 * system about itself.
 *
 * States the fact and stops. What she should DO about knowing nothing is a
 * question about her character, and `SOUL.md` is where her character lives.
 */
export const WORKING_MEMORY_EMPTY =
  "_You do not know anything about him yet — nothing about him has been written down._";

/**
 * Section order, and the order candidates of equal salience are considered in.
 *
 * Who he is comes before what he is doing, which comes before what was
 * decided, which comes before loose facts. Sources come last: a handle to an
 * article is the least useful thing to carry into every turn, and it is the
 * easiest thing to go and look up.
 *
 * Places sit next to people because they are the same sort of thing — a hub
 * several facts hang off rather than a claim. A `place` only ever reaches this
 * list after a second exchange has named it (`syl-017.2`), so a section here is
 * evidence that somewhere recurred, never that somewhere was mentioned.
 */
export const WORKING_MEMORY_SECTIONS: readonly {
  readonly kind: MemoryNodeKind;
  readonly heading: string;
}[] = [
  // What he told her to be, first. `syl-024.1` gave standing orders a kind of
  // their own; they lead because they are the one section she is meant to obey
  // rather than merely know. Whether they SURVIVE to be rendered is `syl-024.3`
  // (nothing automatic may fade one), and where `self` is filtered out is
  // `syl-024.2` — this list is section order and nothing else.
  { kind: "instruction", heading: "## Standing orders" },
  { kind: "person", heading: "## People" },
  { kind: "place", heading: "## Places" },
  { kind: "goal", heading: "## Goals" },
  { kind: "decision", heading: "## Decisions" },
  { kind: "fact", heading: "## Facts" },
  { kind: "event", heading: "## Recently" },
  { kind: "memory", heading: "## Memories" },
  // No `self` section, and the absence is the feature — see
  // {@link WORKING_MEMORY_EXCLUDED_KINDS}. `syl-024.1` gave it one on the
  // general rule that a hot node with nowhere to render is chosen and then
  // invisible, and said in the same breath that `syl-024.2` decides the filter.
  // The filter is here now, so the heading would be a claim this projection
  // never makes good on.
  { kind: "source", heading: "## Sources" },
];

/**
 * Kinds this projection does not answer with, however hot they are.
 *
 * **This document answers one question — *what do I know about him?* — and a
 * finding about what SHE is is not an answer to it.** Syl's own diagnosis of
 * the first attempt: *"what you wanted was NAMESPACING, and what got built was
 * ISOLATION. Separate them at read time with a kind filter, not at write time
 * by cutting the edges. A render note should be absent from 'what do I know
 * about Justin' because the query excludes it, not because it's connected to
 * nothing."*
 *
 * So this is a WHERE clause and not a wall, and the difference is everything a
 * `self` node can still do. It keeps every edge it has — to his person node, to
 * an `instruction`, to a fact about his life — and stays reachable by
 * traversal, by `recall`, by id. The Commander's requirement, in his words:
 * *"her memories about herself still need notes and edges, and even the ability
 * to connect to memories about me and my life and my preferences."* An
 * unconnected node is unreachable to everyone, which is what the isolation
 * version cost.
 *
 * Applied in {@link buildWorkingMemory} rather than in the graph read, so a
 * `self` node is neither admitted nor **counted in the overflow**. The notice
 * is part of this projection's answer: *"…and 2 notes about myself"* would leak
 * back exactly what the filter removed, and hand him a count he cannot open
 * from here.
 *
 * `instruction` is deliberately NOT here. A standing order is something he
 * told her, so it belongs in the answer to what she knows about him — it is
 * pinned rather than filtered (`syl-024.3`).
 *
 * `source` is not here either, and that is not an oversight: a handle renders
 * under `## Sources`, and what it is excluded from is the emptiness test in
 * {@link render} — a projection holding nothing but handles is empty however
 * many rows it has.
 */
export const WORKING_MEMORY_EXCLUDED_KINDS: readonly MemoryNodeKind[] = ["self"];

const EXCLUDED_KINDS = new Set<MemoryNodeKind>(WORKING_MEMORY_EXCLUDED_KINDS);

const SECTION_RANK = new Map<MemoryNodeKind, number>(
  WORKING_MEMORY_SECTIONS.map((section, index) => [section.kind, index]),
);

/**
 * What each kind is called in the overflow notice, singular and plural.
 *
 * Prose rather than the enum values, because the notice is read by Syl and
 * turned into a sentence for him. "3 memories" is a sentence; "3 memory" is a
 * schema leaking into the one document she reads on every turn.
 */
const KIND_NOUNS: Readonly<Record<MemoryNodeKind, readonly [one: string, many: string]>> = {
  instruction: ["standing order", "standing orders"],
  self: ["note about myself", "notes about myself"],
  person: ["person", "people"],
  place: ["place", "places"],
  goal: ["goal", "goals"],
  decision: ["decision", "decisions"],
  fact: ["fact", "facts"],
  event: ["event", "events"],
  memory: ["memory", "memories"],
  source: ["source", "sources"],
};

/** One kind, and how many of it are in the overflow. */
export interface OverflowKindCount {
  readonly kind: MemoryNodeKind;
  readonly count: number;
}

/** Kind counts over a set of candidates, in section order, empties omitted. */
export function countByKind(candidates: readonly WorkingMemoryCandidate[]): OverflowKindCount[] {
  return WORKING_MEMORY_SECTIONS.map((section) => ({
    kind: section.kind,
    count: candidates.filter((candidate) => candidate.kind === section.kind).length,
  })).filter((entry) => entry.count > 0);
}

/** One hot node, reduced to what the projection can use. */
export interface WorkingMemoryCandidate {
  readonly id: string;
  readonly kind: MemoryNodeKind;
  readonly label: string;
  readonly body: string | null;
  /** Ranking only — total hot edge weight touching the node. */
  readonly salience: number;
  readonly updatedAt: string;
}

/** Bounds for one build. Both default to the constants above. */
export interface WorkingMemoryOptions {
  readonly maxBytes?: number;
  readonly maxLines?: number;
}

/** A rendered projection, before anything touches the database. */
export interface WorkingMemoryPlan {
  /** The complete text, exactly as it is prepended to a turn. */
  readonly text: string;
  /** Node ids that made it in, in rendered order. */
  readonly included: readonly string[];
  /** Node ids that did not fit. Counted in the text; never silent. */
  readonly dropped: readonly string[];
  readonly bytes: number;
  readonly lines: number;
}

/** The stored projection. */
export interface WorkingMemoryRow {
  readonly text: string;
  readonly digest: string;
  readonly bytes: number;
  readonly lines: number;
  readonly included: number;
  readonly dropped: number;
  /** When the projection last CHANGED — not when a job last ran. */
  readonly generatedAt: string;
}

/** How many overflow items are returned when nobody says. */
export const DEFAULT_OVERFLOW_LIMIT = 20;

/** Which part of the overflow to open. Both narrow; neither changes the set. */
export interface OverflowQuery {
  /** One kind, as the notice names them. Omit for all of them. */
  readonly kind?: MemoryNodeKind;
  /** How many to return. Defaults to {@link DEFAULT_OVERFLOW_LIMIT}. */
  readonly limit?: number;
}

/** Everything the projection could not fit, and what it is made of. */
export interface WorkingMemoryOverflow {
  /** The items themselves, most salient first. Capped by `limit`. */
  readonly items: readonly WorkingMemoryCandidate[];
  /** The whole overflow, before `kind` and `limit`. */
  readonly total: number;
  /** How many matched `kind`, before `limit`. */
  readonly matched: number;
  /** Kind counts over the whole overflow, in section order. */
  readonly byKind: readonly OverflowKindCount[];
}

/** What one regeneration did. */
export interface WorkingMemoryRegeneration {
  readonly row: WorkingMemoryRow;
  readonly plan: WorkingMemoryPlan;
  /** `false` when the graph had not moved and nothing was written. */
  readonly changed: boolean;
}

/** The projection would not fit the budget it must be loaded within. */
export class WorkingMemoryOverflowError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(
      `Refusing to store a ${String(bytes)}-byte working-memory projection: the budget is ` +
        `${String(maxBytes)} bytes, and this text is prepended to every turn. Past a size ` +
        `limit a preamble stops being loaded and NOTHING SAYS SO — the same silent cliff as ` +
        `the auto-memory index (syl-03d). Failing here is the whole point.`,
    );
    this.name = "WorkingMemoryOverflowError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** One entry line: the label, and the detail if there is room for one. */
export function renderEntry(candidate: WorkingMemoryCandidate): string {
  const label = oneLine(candidate.label);
  const detail = candidate.body === null ? "" : oneLine(candidate.body);
  const full = detail === "" ? label : `${label} — ${detail}`;
  return `- ${truncate(full, WORKING_MEMORY_ENTRY_MAX_CHARS)}`;
}

/**
 * What was left out — how many, **of what**, and the move that opens it.
 *
 * `syl-016.2`. This used to say only *"…and 10 more in the hot region, not
 * shown here. Search deep memory for anything specific."* Two things were wrong
 * with that, and the second is the worse one:
 *
 * 1. **A bare count tells her she is deciding with a known gap and gives her
 *    nothing to weigh.** Ten dropped sources and ten dropped people are very
 *    different situations — the first is a handful of articles she can look up,
 *    the second is people in his life she is about to talk to him without. She
 *    could not tell which, so every count read as the alarming one.
 * 2. **"Search deep memory" was a capability she did not have.** She said so
 *    herself: *"I have no tool in my hands to search, query or traverse any of
 *    it."* An instruction and the capability it assumes are one decision, and
 *    this document had the instruction for months with nothing behind it —
 *    which is the failure mode that makes a model act the instruction out in
 *    prose. `recall` (`syl-016.1`) is what makes the sentence true.
 *
 * It names `recall` rather than describing a search in the abstract, and that
 * is safe in the direction that matters: on a lane with no tools attached,
 * `harness/capability.ts` derives NO_HANDS_YET from the surface itself and
 * tells her plainly she cannot act. A derived sentence outranks a stored one,
 * so this notice cannot become the stale half of that pair.
 */
export function renderOverflow(dropped: readonly WorkingMemoryCandidate[]): string {
  const counted = countByKind(dropped)
    .map((entry) => {
      const [one, many] = KIND_NOUNS[entry.kind];
      return `${String(entry.count)} ${entry.count === 1 ? one : many}`;
    })
    .join(", ");

  return (
    `_…and ${String(dropped.length)} more in the hot region, not shown here: ${counted}. ` +
    `Use recall with no query to open them, or search for anything specific._`
  );
}

/**
 * Rank: salience first, then recency, then id.
 *
 * TOTAL, on purpose. A partial order would let two runs over an unchanged
 * graph render the same facts in a different sequence, which is a different
 * digest, which is a write — and "regenerate only when the graph moved" would
 * silently become "regenerate every night", taking the idempotence guarantee
 * with it.
 */
function rank(a: WorkingMemoryCandidate, b: WorkingMemoryCandidate): number {
  if (a.salience !== b.salience) return b.salience - a.salience;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.kind !== b.kind) return (SECTION_RANK.get(a.kind) ?? 0) - (SECTION_RANK.get(b.kind) ?? 0);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Render a set of admitted candidates, grouped into sections.
 *
 * `remaining` is the dropped candidates themselves rather than a count, because
 * the overflow notice names their kinds. That makes every trial render in
 * {@link buildWorkingMemory} measure the notice it would really carry, which is
 * what keeps the budget arithmetic honest — a notice sized from a count and
 * printed from a list is two answers to one question.
 */
function render(
  admitted: readonly WorkingMemoryCandidate[],
  remaining: readonly WorkingMemoryCandidate[],
): string {
  const lines: string[] = [WORKING_MEMORY_TITLE, "", WORKING_MEMORY_NOTE, ""];

  // A SOURCE IS A HANDLE, NOT A FACT, and a projection holding nothing but
  // handles is empty however many rows it has.
  //
  // The live graph on 2026-08-10 held exactly one node: a `source` labelled
  // "Conversation with the Commander" with a null body, a container for facts
  // that were never written. This rendered as a `## Sources` section, so the
  // document she read every turn asserted that she HAD memory. She had none —
  // and across nineteen messages she never once asked him anything about his
  // life, which is entirely reasonable behaviour for someone who believes she
  // already has a source.
  const knowledge = admitted.filter((candidate) => candidate.kind !== "source");

  if (knowledge.length === 0 && remaining.length === 0) {
    // Nothing is admitted at all in this case: an unearned handle is worse than
    // no handle, because it is read as content.
    return `${[WORKING_MEMORY_TITLE, "", WORKING_MEMORY_NOTE, "", WORKING_MEMORY_EMPTY].join("\n")}\n`;
  }

  for (const section of WORKING_MEMORY_SECTIONS) {
    const members = admitted.filter((candidate) => candidate.kind === section.kind);
    if (members.length === 0) continue;
    lines.push(section.heading, "");
    for (const member of members) lines.push(renderEntry(member));
    lines.push("");
  }

  if (remaining.length > 0) lines.push(renderOverflow(remaining));

  return `${lines.join("\n").replace(/\s+$/u, "")}\n`;
}

/**
 * Distil the hot region into something small enough to load into every turn.
 *
 * Pure — no I/O, no clock, no database — so the budget arithmetic and the
 * wire format are testable without a schema, the same seam the protocol codec
 * keeps. {@link WorkingMemory.regenerate} is the thin shell that reads the
 * graph and persists the result.
 *
 * Admission is greedy in rank order and stops at the first entry that does not
 * fit, so what is dropped is always the least salient contiguous tail. Each
 * trial renders the WHOLE text — including the overflow notice sized for the
 * count it would carry — so the budget check is measured against the real
 * output rather than an estimate that could drift from it.
 *
 * {@link WORKING_MEMORY_EXCLUDED_KINDS} is applied first, before ranking, so an
 * excluded kind is neither admitted nor reported as dropped: it is not part of
 * this question at all.
 */
export function buildWorkingMemory(
  candidates: readonly WorkingMemoryCandidate[],
  options: WorkingMemoryOptions = {},
): WorkingMemoryPlan {
  const maxBytes = options.maxBytes ?? WORKING_MEMORY_MAX_BYTES;
  const maxLines = options.maxLines ?? WORKING_MEMORY_MAX_LINES;

  const asked = candidates.filter((candidate) => !EXCLUDED_KINDS.has(candidate.kind));
  const ordered = [...asked].sort(rank);
  const admitted: WorkingMemoryCandidate[] = [];

  for (const candidate of ordered) {
    const trial = render([...admitted, candidate], ordered.slice(admitted.length + 1));
    if (byteLength(trial) > maxBytes || trial.split("\n").length > maxLines) break;
    admitted.push(candidate);
  }

  const dropped = ordered.slice(admitted.length);
  const text = render(admitted, dropped);

  // Rendered order, not admission order: `included` is what a caller shows
  // next to the text, and the two disagreeing would be its own small lie.
  const included = WORKING_MEMORY_SECTIONS.flatMap((section) =>
    admitted.filter((candidate) => candidate.kind === section.kind).map((candidate) => candidate.id),
  );

  return {
    text,
    included,
    dropped: dropped.map((candidate) => candidate.id),
    bytes: byteLength(text),
    lines: text.split("\n").length,
  };
}

/** A hot node as the builder wants it. */
export function toCandidate(node: SalientNode): WorkingMemoryCandidate {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    body: node.body,
    salience: node.salience,
    updatedAt: node.updatedAt,
  };
}

export interface WorkingMemoryStoreOptions extends WorkingMemoryOptions {
  readonly db: Database;
  readonly graph: MemoryGraph;
  readonly clock?: Clock;
  /** How many hot nodes to consider. Defaults to {@link WORKING_MEMORY_SCAN_LIMIT}. */
  readonly scanLimit?: number;
}

interface StoredRow {
  readonly text: string;
  readonly digest: string;
  readonly bytes: number;
  readonly lines: number;
  readonly included: number;
  readonly dropped: number;
  readonly generated_at: string;
}

const ROW_COLUMNS = "text, digest, bytes, lines, included, dropped, generated_at";

/** The one row's primary key. There is no second row; `0017` CHECKs it. */
const ONLY_ROW = 1;

/** The stored projection, and the one operation that replaces it. */
export class WorkingMemory {
  readonly #db: Database;
  readonly #graph: MemoryGraph;
  readonly #clock: Clock;
  readonly #maxBytes: number;
  readonly #maxLines: number;
  readonly #scanLimit: number;

  constructor(options: WorkingMemoryStoreOptions) {
    this.#db = options.db;
    this.#graph = options.graph;
    this.#clock = options.clock ?? systemClock;
    this.#maxBytes = options.maxBytes ?? WORKING_MEMORY_MAX_BYTES;
    this.#maxLines = options.maxLines ?? WORKING_MEMORY_MAX_LINES;
    this.#scanLimit = options.scanLimit ?? WORKING_MEMORY_SCAN_LIMIT;
  }

  /** The projection as it stands, or `null` if it has never been built. */
  current(): WorkingMemoryRow | null {
    const row = this.#db
      .prepare(`SELECT ${ROW_COLUMNS} FROM working_memory WHERE id = ?`)
      .get(ONLY_ROW);
    if (row === undefined) return null;

    const typed = row as unknown as StoredRow;
    return {
      text: typed.text,
      digest: typed.digest,
      bytes: typed.bytes,
      lines: typed.lines,
      included: typed.included,
      dropped: typed.dropped,
      generatedAt: typed.generated_at,
    };
  }

  /**
   * The text to prepend to a turn, or `""` before the first regeneration.
   *
   * `""` rather than a throw: a projection that has never been built is the
   * ordinary state of a new install, and refusing to take a turn because the
   * graph is empty would be a worse failure than answering without a preamble.
   */
  preamble(): string {
    return this.current()?.text ?? "";
  }

  /**
   * What the projection could not fit — the items the notice counts.
   *
   * `syl-016.2`. The digest says *"and 10 more"* and would not say which, which
   * is worse than a shorter list: it tells her she is deciding with a known gap
   * and hands her no move. This is the move.
   *
   * **Recomputed from the graph through {@link buildWorkingMemory}, on the same
   * bounds, rather than read from a stored list of ids.** Two reasons, and the
   * first is the one that makes it correct rather than merely convenient:
   *
   * - It cannot drift from what the digest actually hid. There is one admission
   *   rule, in one function, and both the text she reads and this list come out
   *   of it. A stored `dropped` column would be a second answer to the same
   *   question, going stale the moment the graph moved — the same second-source
   *   -of-truth failure `projection.ts` exists to prevent.
   * - The stored row keeps only a COUNT (`0017`), so there is no list to read.
   *   Adding one would be a migration in service of the drift above.
   *
   * It is deliberately NOT a search: this reaches the hot region through
   * salience, exactly as the projection does, so it answers "what is being kept
   * from me" rather than "what matches these words". Searching is `Retriever`'s
   * job and there is only one of those.
   *
   * @throws {GraphError} `bad_limit` on a scan limit below 1.
   */
  overflow(options: OverflowQuery = {}): WorkingMemoryOverflow {
    const candidates = this.#graph.listSalientNodes(this.#scanLimit).map(toCandidate);
    const plan = buildWorkingMemory(candidates, {
      maxBytes: this.#maxBytes,
      maxLines: this.#maxLines,
    });

    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const dropped = plan.dropped
      .map((id) => byId.get(id))
      .filter((candidate): candidate is WorkingMemoryCandidate => candidate !== undefined);

    const matching =
      options.kind === undefined
        ? dropped
        : dropped.filter((candidate) => candidate.kind === options.kind);

    // A limit is applied last and reported beside `matched`, so "there are more
    // than I showed you" is a number she can say rather than something she has
    // to infer from a full page. Same rule as the notice it opens.
    const limit = options.limit ?? DEFAULT_OVERFLOW_LIMIT;
    return {
      items: limit >= matching.length ? matching : matching.slice(0, limit),
      total: dropped.length,
      matched: matching.length,
      byKind: countByKind(dropped),
    };
  }

  /**
   * Rebuild the projection from the graph, and store it only if it moved.
   *
   * Idempotent: two runs over an unchanged graph produce one write. The second
   * returns `changed: false` and the row untouched, `generatedAt` included.
   *
   * @throws {WorkingMemoryOverflowError} if the rendered text is over budget,
   * which the builder should have made impossible — it is checked anyway
   * because the failure it guards is silent.
   * @throws {GraphError} `bad_limit` on a scan limit below 1.
   */
  regenerate(): WorkingMemoryRegeneration {
    const plan = buildWorkingMemory(
      this.#graph.listSalientNodes(this.#scanLimit).map(toCandidate),
      { maxBytes: this.#maxBytes, maxLines: this.#maxLines },
    );

    if (plan.bytes > this.#maxBytes) {
      throw new WorkingMemoryOverflowError(plan.bytes, this.#maxBytes);
    }

    const digest = createHash("sha256").update(plan.text, "utf8").digest("hex");
    const existing = this.current();
    if (existing !== null && existing.digest === digest) {
      return { row: existing, plan, changed: false };
    }

    const row: WorkingMemoryRow = {
      text: plan.text,
      digest,
      bytes: plan.bytes,
      lines: plan.lines,
      included: plan.included.length,
      dropped: plan.dropped.length,
      generatedAt: instant(this.#clock()),
    };

    // An UPSERT onto row 1, never an INSERT that could grow the table. The
    // schema would refuse a second row anyway; writing it this way means the
    // code and the CHECK say the same thing.
    this.#db
      .prepare(
        `INSERT INTO working_memory (id, ${ROW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ` +
          `ON CONFLICT (id) DO UPDATE SET text = excluded.text, digest = excluded.digest, ` +
          `bytes = excluded.bytes, lines = excluded.lines, included = excluded.included, ` +
          `dropped = excluded.dropped, generated_at = excluded.generated_at`,
      )
      .run(
        ONLY_ROW,
        row.text,
        row.digest,
        row.bytes,
        row.lines,
        row.included,
        row.dropped,
        row.generatedAt,
      );

    return { row, plan, changed: true };
  }
}
