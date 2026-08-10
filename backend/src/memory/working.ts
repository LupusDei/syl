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
 * {@link WORKING_MEMORY_MAX_BYTES} is 4,000 bytes — roughly 1,000 tokens —
 * across at most {@link WORKING_MEMORY_MAX_LINES} lines.
 *
 * The number is chosen against what it is spent on: this is prepended to
 * *every* turn on every lane, so it is paid for on the morning agenda, the
 * evening review, every heartbeat and every message. At ~1k tokens it is a
 * rounding error against a turn's context and still holds on the order of
 * fifty distilled lines, which is more than a person could recite about
 * their own week. Doubling it would buy little and cost it every single turn.
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
export const WORKING_MEMORY_MAX_BYTES = 4_000;

/** The most lines it may occupy. */
export const WORKING_MEMORY_MAX_LINES = 60;

/** How many hot nodes are considered before the budget is applied. */
export const WORKING_MEMORY_SCAN_LIMIT = 200;

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
 */
export const WORKING_MEMORY_SECTIONS: readonly {
  readonly kind: MemoryNodeKind;
  readonly heading: string;
}[] = [
  { kind: "person", heading: "## People" },
  { kind: "goal", heading: "## Goals" },
  { kind: "decision", heading: "## Decisions" },
  { kind: "fact", heading: "## Facts" },
  { kind: "event", heading: "## Recently" },
  { kind: "memory", heading: "## Memories" },
  { kind: "source", heading: "## Sources" },
];

const SECTION_RANK = new Map<MemoryNodeKind, number>(
  WORKING_MEMORY_SECTIONS.map((section, index) => [section.kind, index]),
);

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

function renderOverflow(count: number): string {
  return (
    `_…and ${String(count)} more in the hot region, not shown here. ` +
    `Search deep memory for anything specific._`
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

/** Render a set of admitted candidates, grouped into sections. */
function render(admitted: readonly WorkingMemoryCandidate[], remaining: number): string {
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

  if (knowledge.length === 0 && remaining === 0) {
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

  if (remaining > 0) lines.push(renderOverflow(remaining));

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
 */
export function buildWorkingMemory(
  candidates: readonly WorkingMemoryCandidate[],
  options: WorkingMemoryOptions = {},
): WorkingMemoryPlan {
  const maxBytes = options.maxBytes ?? WORKING_MEMORY_MAX_BYTES;
  const maxLines = options.maxLines ?? WORKING_MEMORY_MAX_LINES;

  const ordered = [...candidates].sort(rank);
  const admitted: WorkingMemoryCandidate[] = [];

  for (const candidate of ordered) {
    const trial = render([...admitted, candidate], ordered.length - admitted.length - 1);
    if (byteLength(trial) > maxBytes || trial.split("\n").length > maxLines) break;
    admitted.push(candidate);
  }

  const dropped = ordered.slice(admitted.length);
  const text = render(admitted, dropped.length);

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
