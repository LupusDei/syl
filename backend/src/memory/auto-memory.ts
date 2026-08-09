import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";

import type { InitEvent } from "../harness/protocol.js";

/**
 * Claude Code's own auto-memory, pointed at a directory Syl owns.
 *
 * ## Why this instead of a memory system of our own
 *
 * The CLI already ships one: a `MEMORY.md` index plus topic files, written by
 * the model with its ordinary Write tool, loaded at session start, and — this
 * is the part that decides it — **billed on subscription rails**, because it
 * runs inside the binary Syl already drives. A store we built ourselves would
 * need embeddings or a summarisation pass, and every option for those is the
 * metered API. That fails the strongest constraint in the project.
 *
 * So the whole of this module is: work out an absolute directory, hand it to
 * the CLI as a setting, and refuse the turn if the CLI did not take it.
 *
 * ## Verified against Claude Code 2.1.226, not assumed
 *
 * Four live captures, all in `-p --output-format stream-json` headless mode:
 *
 * | capture | shape | outcome |
 * |---|---|---|
 * | write | `--settings '{"autoMemoryDirectory":"<abs>"}'` | wrote `MEMORY.md` + a topic file **into that exact directory** |
 * | recall | fresh session, no `--resume`, same setting | recalled the fact written by the first |
 * | control | same cwd, setting omitted | did not know the fact — the redirect is a real partition |
 * | relative | `'{"autoMemoryDirectory":"relative/mem"}'` | **silently ignored**; fell back to `~/.claude/projects/<slug>/memory/` |
 *
 * The fourth row is why {@link autoMemoryAt} throws rather than passing a value
 * through. The CLI validates the setting with, in effect, "absolute, at least
 * three characters, no NUL, not a UNC root" and on failure returns *undefined*
 * — no warning, no error, no exit code. A typo does not break memory; it moves
 * every memory somewhere else and nothing says so. The whole failure is silent
 * in both directions: writes land in the default directory, and the next
 * session reads from the default directory too, so it even looks like it works.
 *
 * ## And why the init frame is checked afterwards anyway
 *
 * `init.memory_paths.auto` carries the directory the CLI actually resolved.
 * That makes the redirect verifiable rather than hoped for, in the same way
 * `apiKeySource` makes the billing rail verifiable — so {@link assertAutoMemory}
 * runs on every turn and kills the child on a mismatch, before the model has a
 * chance to write the Commander's private memory into a shared default path.
 * Setting `autoMemoryEnabled:false` removes `memory_paths` from the frame
 * entirely, which is how "off" is confirmed as well.
 *
 * ## One directory for every lane
 *
 * Session continuity is per lane — `commander`, `heartbeat`, `agenda`,
 * `consolidation` — but memory deliberately is not. Lanes exist to keep
 * *transcripts* apart, so Syl's inner monologue does not interleave with what
 * the Commander said and no lane pays for another's context. Memory wants the
 * opposite: a fact learned while talking to the Commander is exactly what the
 * morning agenda needs, and a partitioned store would produce four assistants
 * who each know a quarter of him.
 *
 * The consolidation lane settles it. Its job is to compact and cross-link what
 * the others learned; under per-lane directories it could only ever see its
 * own, which is nothing. The index budget points the same way: the CLI loads
 * the first 200 lines / 25 KB of `MEMORY.md` per directory, so sharding would
 * quadruple the total budget while cutting what any single lane can recall to a
 * quarter. The cap is an argument for consolidation, not for sharding.
 *
 * The cost of sharing is real and worth writing down: two lanes running
 * concurrently both write `MEMORY.md` with the ordinary Write tool, so the
 * index is last-write-wins. That is a follow-up, not a reason to shard.
 */

/** The index file the CLI loads at session start. */
export const AUTO_MEMORY_INDEX = "MEMORY.md";

/**
 * How much of the index is loaded automatically: the first 200 lines, or
 * 25,000 bytes, whichever comes first. Read out of the 2.1.226 binary.
 */
export const AUTO_MEMORY_INDEX_MAX_LINES = 200;
/** @see AUTO_MEMORY_INDEX_MAX_LINES */
export const AUTO_MEMORY_INDEX_MAX_BYTES = 25_000;

/**
 * The hard ceiling on the index, at four times the load budget.
 *
 * Compaction is implemented as refusal rather than as a background job: past
 * this the CLI errors on the write and the model has to rewrite the index
 * smaller. Nothing is summarised for it and nothing is deleted behind its back.
 */
export const AUTO_MEMORY_MAX_BYTES = 4 * AUTO_MEMORY_INDEX_MAX_BYTES;

/**
 * Where Syl's memory lives when the environment does not say otherwise.
 *
 * Under `.syl/`, next to the session ids and the operational store: already
 * gitignored, so the Commander's private memory cannot be committed by
 * accident, and already the answer to "where is Syl's state".
 */
export const DEFAULT_AUTO_MEMORY_PATH = ".syl/memory";

/** The environment variable that relocates it. */
export const AUTO_MEMORY_ENV_VAR = "SYL_AUTO_MEMORY_DIR";

/**
 * What a turn does about auto-memory. There is no third state: a turn either
 * names the directory it may use, or has memory switched off.
 */
export type AutoMemory =
  | { readonly mode: "directory"; readonly directory: string }
  | { readonly mode: "off" };

/** The directory could not be used, and was refused rather than passed on. */
export class AutoMemoryPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoMemoryPathError";
  }
}

/** The CLI did not resolve the auto-memory directory the turn asked for. */
export class AutoMemoryMismatchError extends Error {
  /** What the turn asked for, or `undefined` when it asked for memory to be off. */
  readonly expected: string | undefined;
  /** What `init.memory_paths.auto` reported. */
  readonly actual: string | undefined;

  constructor(message: string, expected: string | undefined, actual: string | undefined) {
    super(message);
    this.name = "AutoMemoryMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Turn a configured path into an absolute one the CLI will accept, or throw.
 *
 * Relative paths are resolved here rather than sent as-is, because the CLI
 * discards them without a word (see the module note). A leading `~/` is
 * expanded for the same reason — the CLI does expand it, but only from
 * settings, and doing it here keeps one answer to "which directory is this".
 *
 * @param path Absolute, relative, or `~/`-prefixed.
 * @param cwd Base for a relative path. Defaults to the process cwd.
 * @throws {AutoMemoryPathError} if no absolute directory can be made of it.
 */
export function autoMemoryAt(path: string, cwd: string = process.cwd()): AutoMemory {
  return { mode: "directory", directory: resolveAutoMemoryPath(path, cwd) };
}

/** A turn with no memory at all. See `runReaderTurn` for the case that needs it. */
export function autoMemoryOff(): AutoMemory {
  return { mode: "off" };
}

/**
 * Resolve and check a configured auto-memory path.
 *
 * @throws {AutoMemoryPathError} if the result is not something the CLI honours.
 */
export function resolveAutoMemoryPath(path: string, cwd: string = process.cwd()): string {
  const trimmed = path.trim();
  if (trimmed === "") {
    throw new AutoMemoryPathError(
      `${AUTO_MEMORY_ENV_VAR} was blank. Give it a directory, or leave it unset for ` +
        `"${DEFAULT_AUTO_MEMORY_PATH}".`,
    );
  }
  // Checked before anything else touches it: a NUL byte truncates the path at
  // the syscall boundary, so a value containing one is never what it looks like.
  if (trimmed.includes("\0")) {
    throw new AutoMemoryPathError(
      `An auto-memory directory may not contain a NUL byte, got ${JSON.stringify(path)}.`,
    );
  }

  let expanded = trimmed;
  if (expanded === "~" || expanded.startsWith("~/")) {
    const home = homedir();
    if (home === "" || !isAbsolute(home)) {
      throw new AutoMemoryPathError(
        `Cannot expand "${trimmed}": this process has no usable home directory. ` +
          `Set ${AUTO_MEMORY_ENV_VAR} to an absolute path instead.`,
      );
    }
    expanded = expanded === "~" ? home : resolve(home, expanded.slice(2));
  }

  const absolute = resolve(cwd, expanded);
  // Belt and braces against the CLI's own rule. `resolve` always returns an
  // absolute path on a sane platform, so reaching this means something is very
  // wrong and silently writing to the default directory is the worst answer.
  if (!isAbsolute(absolute) || absolute.length < 3) {
    throw new AutoMemoryPathError(
      `"${path}" resolved to "${absolute}", which Claude Code would silently ignore — ` +
        `it requires an absolute path of at least three characters, and falls back to its ` +
        `own default directory without saying so.`,
    );
  }
  return stripTrailingSep(absolute);
}

/**
 * The directory the environment asks for, resolved and checked.
 *
 * @throws {AutoMemoryPathError} if the configured value is unusable.
 */
export function autoMemoryDirectoryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const raw = env[AUTO_MEMORY_ENV_VAR];
  const configured = raw === undefined || raw.trim() === "" ? DEFAULT_AUTO_MEMORY_PATH : raw;
  return resolveAutoMemoryPath(configured, cwd);
}

/**
 * The settings object handed to the CLI as `--settings`.
 *
 * `autoMemoryEnabled` is stated explicitly in both directions rather than left
 * to the default. The default is "on", but it is also overridable from the
 * user's own `~/.claude/settings.json` — and a turn that quietly stopped
 * recording anything because of a setting on the machine would be indisguishable
 * from an assistant that had simply forgotten.
 */
export function autoMemorySettings(memory: AutoMemory): Record<string, unknown> {
  if (memory.mode === "off") return { autoMemoryEnabled: false };
  return { autoMemoryEnabled: true, autoMemoryDirectory: memory.directory };
}

/** `--settings` takes a path or a JSON string; this is the JSON string. */
export function autoMemorySettingsFlag(memory: AutoMemory): string {
  return JSON.stringify(autoMemorySettings(memory));
}

/**
 * Check the CLI resolved the directory the turn asked for.
 *
 * Cheap, and the only thing standing between a typo and the Commander's memory
 * being written somewhere nobody looks. `memory_paths.auto` arrives with a
 * trailing separator and NFC-normalised, so both sides are put in that form
 * before comparison.
 *
 * @throws {AutoMemoryMismatchError} on any disagreement.
 */
export function assertAutoMemory(init: InitEvent, memory: AutoMemory): void {
  const actual = init.autoMemoryPath;

  if (memory.mode === "off") {
    if (actual === undefined) return;
    throw new AutoMemoryMismatchError(
      `This turn asked for auto-memory to be off, but Claude Code reported a memory ` +
        `directory at "${actual}". Untrusted content must not be able to read or write ` +
        `Syl's memory; refusing the turn.`,
      undefined,
      actual,
    );
  }

  if (actual === undefined) {
    throw new AutoMemoryMismatchError(
      `This turn asked for auto-memory at "${memory.directory}", but Claude Code reported ` +
        `no memory directory at all — nothing would be remembered.`,
      memory.directory,
      undefined,
    );
  }

  if (stripTrailingSep(actual).normalize("NFC") !== memory.directory.normalize("NFC")) {
    throw new AutoMemoryMismatchError(
      `This turn asked for auto-memory at "${memory.directory}" but Claude Code resolved ` +
        `"${actual}". The CLI discards a setting it does not like and falls back to its own ` +
        `default without warning, so this turn would write the Commander's memory somewhere ` +
        `Syl never reads.`,
      memory.directory,
      actual,
    );
  }
}

/** Drop trailing separators, without eating a root like `/`. */
function stripTrailingSep(path: string): string {
  const normalized = normalize(path);
  let end = normalized.length;
  while (end > 1 && (normalized[end - 1] === sep || normalized[end - 1] === "/")) end -= 1;
  return normalized.slice(0, end);
}
