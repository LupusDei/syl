import { closeSync, openSync, readSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TurnOptions, TurnResult, TurnRunner } from "../harness/session.js";

import {
  AUTO_MEMORY_INDEX,
  AUTO_MEMORY_INDEX_MAX_BYTES,
  AUTO_MEMORY_INDEX_MAX_LINES,
  AUTO_MEMORY_MAX_BYTES,
} from "./auto-memory.js";

/**
 * The service holds the guarantee that a memory can be found again.
 *
 * ## The bug this exists for (`syl-03d`)
 *
 * Claude Code's auto-memory is two things: topic files, and a `MEMORY.md`
 * index that links to them. Only the index is loaded at session start — the
 * first 200 lines or 25 KB of it — so a topic file with no entry in the index
 * is on disk and *unreachable*. Recall over the whole directory exists but is
 * behind a server-side flag (`tengu_moth_copse` / `CLAUDE_MEMORY_STORES`) and
 * cannot be relied on.
 *
 * Writing the index is left to the model, and captured live on 2.1.226 a haiku
 * turn told to remember a canary wrote `syl_production_canary.md` and no index
 * entry; the next session answered "NONE". An opus turn in the same shape wrote
 * both files. So the failure is *model-dependent*, which is the worst shape a
 * bug can take: it passes every test run by hand on the good model and loses
 * the Commander's memories in production on the cheap one.
 *
 * ## Why this is not a prompt
 *
 * The project's governing rule is that **the service holds the guarantees and
 * the model holds the judgment**. Whether a memory is reachable is a guarantee.
 * It is the identical call already made for notification delivery: a model can
 * simply decline to call a tool, so delivery is persisted and retried instead
 * of trusted to a turn. Instructing index maintenance in `SOUL.md` was rejected
 * explicitly — it is a behavioural instruction, behaviour drifts, and it would
 * have worked perfectly in testing, which is exactly what makes it dangerous.
 *
 * The model still decides what is worth remembering and what a topic file
 * means. It does not get a vote on whether what it wrote can be found again.
 *
 * ## Reconcile, never clobber
 *
 * A model that *does* maintain the index (opus does) writes better summaries
 * than anything generated from a directory listing, because it knows what the
 * memory is for. So this module never rewrites the index. It owns exactly one
 * delimited block and touches nothing outside it:
 *
 * - a topic file named **anywhere** in the rest of the file — as a link, in
 *   backticks, in a sentence — is already reachable and is left alone;
 * - a line already inside the block is reused **verbatim**, so a summary the
 *   model improved in place survives;
 * - moving a line out of the block into a section of the model's own retires
 *   it from the block permanently, because the filename now appears outside it.
 *
 * The block is therefore self-liquidating: it holds only what the model failed
 * to index, and shrinks to nothing when the model does its job.
 *
 * ## Why the block sits directly under the title
 *
 * Because "indexed" has to mean "loaded". Appending to the end of a long
 * hand-written index puts the entry past the 200-line cliff, where it is
 * exactly as unreachable as no entry at all — the same silent failure, one
 * level up. The block goes immediately after the H1 and is bounded
 * ({@link AUTO_INDEX_MAX_LINES} / {@link AUTO_INDEX_MAX_BYTES}), so it is
 * always inside the loaded window and can displace at most a known, small
 * slice of what the model wrote. A real hand-maintained index measures 47 lines
 * and 6.5 KB, so the default bound leaves the model roughly triple what it
 * currently uses.
 *
 * ## Concurrency
 *
 * Two lanes writing `MEMORY.md` at once is last-write-wins, filed as `syl-ugs`.
 * This makes it better rather than worse: the rebuild is synchronous (so two
 * lanes in one process cannot interleave), it replaces the file by atomic
 * rename, and — the part that matters — it is **idempotent and runs after every
 * turn**, so an entry lost to a race with the model's own write is restored by
 * the next turn instead of being lost forever.
 */

/** Opening marker. Doubles as the note telling the model how to opt a line out. */
export const AUTO_INDEX_BEGIN =
  "<!-- syl:auto-index:begin — Syl maintains the list below from the memory " +
  "directory, so nothing she wrote is unreachable. Move a line into a section " +
  "of your own to keep your wording; she will stop regenerating it. -->";

/** Closing marker. */
export const AUTO_INDEX_END = "<!-- syl:auto-index:end -->";

/** Heading for the generated block. */
export const AUTO_INDEX_HEADING = "## Unfiled memories";

/** Title used when there is no `MEMORY.md` to add to yet. */
export const AUTO_INDEX_DEFAULT_TITLE = "# Memory";

/**
 * How much of the load budget Syl's block may take.
 *
 * 60 of the 200 loaded lines and 8 KB of the 25 KB, which leaves the model
 * ~140 lines and ~17 KB — about triple what a real hand-maintained index uses.
 */
export const AUTO_INDEX_MAX_LINES = 60;
/** @see AUTO_INDEX_MAX_LINES */
export const AUTO_INDEX_MAX_BYTES = 8_000;

/** Longest generated summary. Long enough to be useful, short enough to fit. */
export const AUTO_INDEX_SUMMARY_MAX_CHARS = 200;

/** Only the head of a topic file is read: frontmatter and the first heading. */
const TOPIC_HEAD_BYTES = 4_096;

/** A topic file in the memory directory, reduced to what the index needs. */
export interface MemoryTopic {
  /** Base name, e.g. `syl_production_canary.md`. */
  readonly file: string;
  /** One line describing it, or `undefined` if the file said nothing useful. */
  readonly summary: string | undefined;
  /** `mtimeMs`. Decides who keeps an entry when the block is full. */
  readonly modifiedMs: number;
}

/** The outcome of planning an index, before any of it touches disk. */
export interface MemoryIndexPlan {
  /** The complete `MEMORY.md` text. */
  readonly text: string;
  /** Whether it differs from what was passed in. */
  readonly changed: boolean;
  /** Files the model had already made reachable. Untouched. */
  readonly referenced: readonly string[];
  /** Files Syl's block now indexes, newest first. */
  readonly indexed: readonly string[];
  /** Files with no index entry, oldest last. Named in the block, never silent. */
  readonly dropped: readonly string[];
}

/** The outcome of a rebuild against a real directory. */
export interface MemoryIndexResult extends MemoryIndexPlan {
  readonly directory: string;
  /** Topic files found, excluding the index itself. */
  readonly topics: number;
}

/** Writing the index would push it past the size the CLI hard-errors on. */
export class MemoryIndexOverflowError extends Error {
  readonly directory: string;
  readonly bytes: number;

  constructor(directory: string, bytes: number) {
    super(
      `Refusing to write ${join(directory, AUTO_MEMORY_INDEX)}: it would be ${bytes} bytes, past ` +
        `the ${AUTO_MEMORY_MAX_BYTES}-byte ceiling at which Claude Code rejects the write ` +
        `outright. The index needs compacting before anything more can be indexed.`,
    );
    this.name = "MemoryIndexOverflowError";
    this.directory = directory;
    this.bytes = bytes;
  }
}

/** Bounds for the generated block. Both default to the constants above. */
export interface MemoryIndexOptions {
  readonly maxLines?: number;
  readonly maxBytes?: number;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The top-level scalars of a `---` frontmatter block.
 *
 * Deliberately shallow: the CLI nests `node_type`, `type` and `originSessionId`
 * under `metadata:`, and a naive line scan would happily report
 * `type: reference` as the file's description. Indented lines are skipped.
 */
function frontMatter(text: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!/^---\r?\n/.test(text)) return found;

  for (const line of text.slice(text.indexOf("\n") + 1).split("\n")) {
    const trimmedEnd = line.replace(/\r$/, "");
    if (trimmedEnd === "---" || trimmedEnd === "...") break;
    if (/^\s/.test(trimmedEnd)) continue; // nested — belongs to the key above
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(trimmedEnd);
    if (!match) continue;
    found.set(match[1] as string, unquote((match[2] as string).trim()));
  }
  return found;
}

function unquote(value: string): string {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match ? (match[2] as string) : value;
}

/** Everything after the frontmatter, or the whole text if there is none. */
function body(text: string): string {
  if (!/^---\r?\n/.test(text)) return text;
  const rest = text.slice(text.indexOf("\n") + 1);
  const close = /^(---|\.\.\.)\s*$/m.exec(rest);
  return close?.index === undefined ? rest : rest.slice(close.index + (close[0] as string).length);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string): string {
  if (value.length <= AUTO_INDEX_SUMMARY_MAX_CHARS) return value;
  const cut = value.slice(0, AUTO_INDEX_SUMMARY_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > AUTO_INDEX_SUMMARY_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * One line saying what a topic file is about, drawn from what the model wrote.
 *
 * The order is "most deliberate first": the CLI's own frontmatter `description`
 * is the model's considered summary, so it wins; then `name`; then the first
 * heading; then the first line of prose. Anything generated here is a fallback
 * for a file that said nothing about itself.
 *
 * @param text The file's contents, or its first few KB.
 * @returns A single line, capped at {@link AUTO_INDEX_SUMMARY_MAX_CHARS}.
 */
export function summariseMemoryFile(text: string): string | undefined {
  const meta = frontMatter(text);
  const declared = meta.get("description") ?? meta.get("name");
  if (declared !== undefined && declared.trim() !== "") return truncate(oneLine(declared));

  for (const raw of body(text).split("\n")) {
    const line = raw.trim();
    if (line === "" || line === "---") continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const candidate = oneLine(
      (heading?.[1] ?? line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, ""))
        .replace(/^\*\*(.*)\*\*:?\s*/, "$1: ")
        .replace(/[*_`]/g, ""),
    );
    if (candidate !== "") return truncate(candidate);
  }
  return undefined;
}

/**
 * Whether an index already makes a topic file reachable.
 *
 * A bare mention counts, not only a markdown link. A real hand-maintained
 * index names four topic files in backticks inside a paragraph; the model can
 * read what it can see, so those are reachable and adding a second entry for
 * them would be noise. The match is bounded on both sides so `notes.md` is not
 * found inside `my_notes.md` or `notes.md.bak`.
 */
export function isReferencedIn(indexText: string, file: string): boolean {
  const boundary = /[A-Za-z0-9_.-]/;
  for (let from = 0; ; ) {
    const at = indexText.indexOf(file, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : (indexText[at - 1] as string);
    const after = indexText[at + file.length] ?? "";
    if (!boundary.test(before) && !boundary.test(after)) return true;
    from = at + 1;
  }
}

interface Split {
  readonly before: string;
  readonly block: string | undefined;
  readonly after: string;
}

/** Cut the existing generated block out, keeping everything around it exactly. */
function splitBlock(text: string): Split {
  const begin = text.indexOf("<!-- syl:auto-index:begin");
  const end = begin < 0 ? -1 : text.indexOf(AUTO_INDEX_END, begin);
  if (begin < 0 || end < 0) return { before: text, block: undefined, after: "" };

  const stop = end + AUTO_INDEX_END.length;
  return {
    before: text.slice(0, begin),
    block: text.slice(begin, stop),
    after: text.slice(stop),
  };
}

/** Lines the previous block held, by file, so the model's edits survive. */
function previousEntries(block: string | undefined, files: readonly string[]): Map<string, string> {
  const kept = new Map<string, string>();
  if (block === undefined) return kept;
  for (const line of block.split("\n")) {
    if (!line.startsWith("- ")) continue;
    for (const file of files) {
      if (!kept.has(file) && isReferencedIn(line, file)) kept.set(file, line);
    }
  }
  return kept;
}

function renderEntry(topic: MemoryTopic): string {
  const link = `- [${topic.file}](${topic.file})`;
  return topic.summary === undefined || topic.summary === "" ? link : `${link} — ${topic.summary}`;
}

function renderOverflow(count: number): string {
  return (
    `- …and ${count} older memor${count === 1 ? "y" : "ies"} in this directory with no index ` +
    `entry. List the memory directory to find them; they are on disk, not lost.`
  );
}

/**
 * Plan a `MEMORY.md`, purely — no I/O, so the wire-format decisions in here are
 * testable without touching a filesystem, the same seam the codec layer keeps.
 *
 * @param indexText The current index, or `""` if there is none.
 * @param topics Every topic file in the directory.
 */
export function buildMemoryIndex(
  indexText: string,
  topics: readonly MemoryTopic[],
  options: MemoryIndexOptions = {},
): MemoryIndexPlan {
  const maxLines = options.maxLines ?? AUTO_INDEX_MAX_LINES;
  const maxBytes = options.maxBytes ?? AUTO_INDEX_MAX_BYTES;

  const split = splitBlock(indexText);
  const outside = split.before + split.after;

  const referenced: MemoryTopic[] = [];
  const orphans: MemoryTopic[] = [];
  for (const topic of topics) {
    (isReferencedIn(outside, topic.file) ? referenced : orphans).push(topic);
  }
  // Newest first: the failure being fixed is "just written, cannot be recalled",
  // so recency is exactly the axis that matters when not everything fits. Ties
  // break on name so the file is stable rather than dependent on readdir order.
  orphans.sort((a, b) => b.modifiedMs - a.modifiedMs || a.file.localeCompare(b.file));

  const previous = previousEntries(
    split.block,
    orphans.map((t) => t.file),
  );
  const lines = orphans.map((t) => previous.get(t.file) ?? renderEntry(t));

  const overheadLines = 5; // begin, heading, blank, blank, end
  const overheadBytes =
    bytes(AUTO_INDEX_BEGIN) + bytes(AUTO_INDEX_HEADING) + bytes(AUTO_INDEX_END) + overheadLines;

  let fitted = fit(lines, maxLines - overheadLines, maxBytes - overheadBytes);
  if (fitted < lines.length) {
    // Reserve room for the overflow notice, sized for the largest count it
    // could carry so the reservation cannot itself change the answer.
    const reserve = bytes(renderOverflow(lines.length)) + 1;
    fitted = fit(lines, maxLines - overheadLines - 1, maxBytes - overheadBytes - reserve);
  }

  const indexed = orphans.slice(0, fitted).map((t) => t.file);
  const dropped = orphans.slice(fitted).map((t) => t.file);

  const text =
    indexed.length === 0 && dropped.length === 0
      ? withoutBlock(split)
      : withBlock(split, [
          ...lines.slice(0, fitted),
          ...(dropped.length > 0 ? [renderOverflow(dropped.length)] : []),
        ]);

  return {
    text,
    changed: text !== indexText,
    referenced: referenced.map((t) => t.file),
    indexed,
    dropped,
  };
}

/** How many lines fit in both budgets, in order. */
function fit(lines: readonly string[], maxLines: number, maxBytes: number): number {
  let used = 0;
  let count = 0;
  for (const line of lines) {
    const cost = bytes(line) + 1;
    if (count + 1 > maxLines || used + cost > maxBytes) break;
    used += cost;
    count += 1;
  }
  return count;
}

function withoutBlock(split: Split): string {
  if (split.block === undefined) return split.before;
  return normalise(`${split.before.replace(/\n{2,}$/, "\n")}${split.after.replace(/^\n+/, "")}`);
}

function withBlock(split: Split, entries: readonly string[]): string {
  const block = [AUTO_INDEX_BEGIN, "", AUTO_INDEX_HEADING, "", ...entries, AUTO_INDEX_END].join(
    "\n",
  );

  // Replaced where it already is, so a block the model relocated stays put.
  if (split.block !== undefined) return normalise(split.before + block + split.after);

  const lines = split.before.split("\n");
  const title = lines.findIndex((line) => line.startsWith("# "));
  if (title < 0) {
    const rest = split.before.trim();
    return normalise(
      `${AUTO_INDEX_DEFAULT_TITLE}\n\n${block}\n${rest === "" ? "" : `\n${rest}\n`}`,
    );
  }

  const head = lines.slice(0, title + 1).join("\n");
  const tail = lines.slice(title + 1).join("\n").replace(/^\n+/, "");
  return normalise(`${head}\n\n${block}\n${tail === "" ? "" : `\n${tail}`}`);
}

/** Exactly one trailing newline, so idempotence is not defeated by whitespace. */
function normalise(text: string): string {
  return `${text.replace(/\s+$/, "")}\n`;
}

/** Read a topic file's head only — enough for frontmatter and a first heading. */
function readHead(path: string): string {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(TOPIC_HEAD_BYTES);
    return buffer.subarray(0, readSync(handle, buffer, 0, TOPIC_HEAD_BYTES, 0)).toString("utf8");
  } finally {
    closeSync(handle);
  }
}

/** Every topic file in a memory directory, summarised. Index file excluded. */
function readTopics(directory: string): MemoryTopic[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    // No directory means nothing has ever been remembered. Not an error, and
    // deliberately not a reason to create one: an empty index is noise.
    return [];
  }

  const topics: MemoryTopic[] = [];
  for (const name of names) {
    if (name === AUTO_MEMORY_INDEX || name.startsWith(".") || !name.endsWith(".md")) continue;
    const path = join(directory, name);
    try {
      const stats = statSync(path);
      if (!stats.isFile()) continue;
      topics.push({ file: name, summary: summariseMemoryFile(readHead(path)), modifiedMs: stats.mtimeMs });
    } catch {
      // Vanished or unreadable between the listing and now. Skipping it is
      // right: there is nothing to make reachable.
      continue;
    }
  }
  return topics;
}

/**
 * Bring `MEMORY.md` into line with what is actually on disk.
 *
 * Idempotent, and writes nothing when nothing is missing — which is the steady
 * state, so the ordinary cost of running this after every turn is one
 * `readdir` and a 4 KB read per topic file. No tokens, no subprocess.
 *
 * @throws {MemoryIndexOverflowError} if the result would pass the size at which
 * the CLI rejects the write outright.
 */
export function rebuildMemoryIndex(
  directory: string,
  options: MemoryIndexOptions = {},
): MemoryIndexResult {
  const topics = readTopics(directory);
  const path = join(directory, AUTO_MEMORY_INDEX);

  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = "";
  }

  if (topics.length === 0 && current === "") {
    return {
      directory,
      topics: 0,
      text: current,
      changed: false,
      referenced: [],
      indexed: [],
      dropped: [],
    };
  }

  const plan = buildMemoryIndex(current, topics, options);
  if (plan.changed) {
    const size = bytes(plan.text);
    if (size > AUTO_MEMORY_MAX_BYTES) throw new MemoryIndexOverflowError(directory, size);
    writeAtomically(path, plan.text);
  }

  return { ...plan, directory, topics: topics.length };
}

/**
 * Replace the index in one step.
 *
 * A partially written `MEMORY.md` is the one thing worse than a missing entry:
 * a concurrent session would load half an index and treat it as the whole
 * truth. `rename` within a directory is atomic, so a reader sees the old file
 * or the new one and never something in between.
 */
function writeAtomically(path: string, text: string): void {
  const temp = `${path}.syl-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(temp, text, "utf8");
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Hooks for the wrapper, so a caller can log what happened without I/O here. */
export interface MemoryIndexTurnOptions extends MemoryIndexOptions {
  /** Called with every rebuild, changed or not. */
  readonly onRebuild?: (result: MemoryIndexResult) => void;
  /** Called when a rebuild throws. Defaults to one loud line on stderr. */
  readonly onError?: (error: unknown) => void;
  /** Seam for tests. */
  readonly rebuild?: (directory: string, options?: MemoryIndexOptions) => MemoryIndexResult;
}

function reportToStderr(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `syl: could not maintain the auto-memory index — a memory may be unreachable: ${message}\n`,
  );
}

/**
 * Wrap a turn runner so the index is rebuilt after every turn it takes.
 *
 * *After every turn*, not after turns that look like they wrote something:
 * deciding that from the transcript would be a guess about the model's
 * behaviour, which is the class of reasoning that produced this bug. The
 * rebuild is idempotent and free of tokens, and the directory comes from the
 * turn's own `autoMemory` option — the same value that told the CLI where to
 * write — so there is nothing to configure and nothing to keep in step.
 *
 * It runs in a `finally`: a turn that timed out or died may already have
 * written a topic file, and that memory has to be reachable too. A rebuild
 * failure is reported, never rethrown, because replacing a turn's real result
 * or its real error with a bookkeeping failure would lose the more important
 * of the two.
 */
export function withMemoryIndex(
  runner: TurnRunner,
  options: MemoryIndexTurnOptions = {},
): TurnRunner {
  const rebuild = options.rebuild ?? rebuildMemoryIndex;
  const onError = options.onError ?? reportToStderr;

  return async (prompt: string, turnOptions: TurnOptions = {}): Promise<TurnResult> => {
    try {
      return await runner(prompt, turnOptions);
    } finally {
      const memory = turnOptions.autoMemory;
      if (memory?.mode === "directory") {
        try {
          // Not `onRebuild?.(rebuild(...))`: optional chaining short-circuits
          // its own arguments, so with no observer attached the rebuild would
          // never run — the guarantee would quietly depend on being watched.
          const result = rebuild(memory.directory, options);
          options.onRebuild?.(result);
        } catch (error) {
          onError(error);
        }
      }
    }
  };
}

/** Re-exported so a caller can check a plan against the budget it must fit. */
export { AUTO_MEMORY_INDEX_MAX_BYTES, AUTO_MEMORY_INDEX_MAX_LINES };
