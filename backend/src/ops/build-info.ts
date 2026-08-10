import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BuildInfo } from "@syl/shared";

/**
 * What this process was built from.
 *
 * ## The failure this exists for
 *
 * A stale build is invisible by construction. Every health check passes,
 * because the old build is perfectly healthy — it answers, its store is fine,
 * its certificate is fine, and it is simply not the code anybody believes is
 * running. It cost three hours here: the service came up at 19:58, a fix landed
 * at 20:18, and Syl went on answering through a tool surface that had been
 * removed until the Commander noticed something read oddly and asked.
 *
 * ## The rule, which is negative and easy to lose
 *
 * **Nothing in this module asks git anything.** The stamp is written by
 * `backend/scripts/write-build-info.mjs` when the artifact is built, and read
 * back here. A version that fell back to `git rev-parse HEAD` would behave
 * identically in every test that runs inside a checkout, and would report the
 * wrong answer in precisely the situation the stamp exists for: old code
 * running inside a tree that has moved on. The running service reports what it
 * was BUILT FROM. The working tree is a different question, asked by
 * `scripts/syl-verify.sh`, and the whole value is in comparing the two.
 *
 * ## Why the stamp lives inside `dist/`
 *
 * So it travels with the artifact. `npm run deploy` rolls back by restoring the
 * previous `dist/`, and the restored build reports the previous commit the
 * moment it starts — nothing to keep in sync, nothing to remember to update,
 * and no way for the provenance to disagree with the code it describes.
 */

/** The stamp's filename inside a build directory. */
export const BUILD_STAMP_FILENAME = "build-info.json";

/** Where the stamp sits for a given build directory. */
export function buildStampPath(distDirectory: string): string {
  return join(distDirectory, BUILD_STAMP_FILENAME);
}

/**
 * The stamp for *this* running code, found relative to this module.
 *
 * Compiled, this file is `dist/ops/build-info.js`, so one directory up is
 * `dist/` and the stamp is there. Run from source under `tsx` it resolves to
 * `src/build-info.json`, which does not exist — and "no stamp" is exactly the
 * right answer for a process that was never built.
 */
export function selfBuildStampPath(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), BUILD_STAMP_FILENAME);
}

export interface ReadBuildInfoOptions {
  /** Told when a stamp exists but cannot be believed. */
  readonly onWarn?: (message: string) => void;
}

/** The shortest prefix that is evidence of anything. Git's own default. */
const MIN_ABBREVIATION = 7;

/**
 * Read the stamp, or answer `null`.
 *
 * `null` means "this process cannot tell you what it was built from", which
 * covers both running from source and a stamp that has been damaged. Those are
 * different situations and the second one warns — but neither may be allowed to
 * stop the service, because a health endpoint that throws while reporting its
 * own provenance has turned a cosmetic problem into an outage.
 */
export function readBuildInfo(path: string, options: ReadBuildInfoOptions = {}): BuildInfo | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // No stamp. Running from source, and not worth a warning — `npm run dev`
    // and every test in this suite take this path.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    options.onWarn?.(
      `${path} is not valid JSON (${error instanceof Error ? error.message : "unparseable"}). ` +
        `This build cannot say what it was made from.`,
    );
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    options.onWarn?.(`${path} does not contain an object. This build cannot say what it was made from.`);
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const { commit, builtAt, dirty, branch } = record;

  if (typeof builtAt !== "string") {
    options.onWarn?.(`${path} has no usable \`builtAt\`. This build cannot say when it was made.`);
    return null;
  }
  if (commit !== null && typeof commit !== "string") {
    options.onWarn?.(`${path} has no usable \`commit\`. This build cannot say what it was made from.`);
    return null;
  }

  return {
    commit,
    builtAt,
    dirty: dirty === true,
    branch: typeof branch === "string" ? branch : null,
  };
}

/**
 * Whether a stamp names the given commit.
 *
 * Abbreviations are accepted on either side, because the two strings being
 * compared come from different places — one from a stamp, one from a human, a
 * log line or `git rev-parse --short`. A prefix shorter than seven characters
 * is refused: it is not evidence, and the answer this function gives is used to
 * decide whether a deploy succeeded.
 *
 * Unknown is never a match. A service that cannot say what it is running has
 * not proved it is running the new build, and treating that as success is how a
 * deploy reports green while the old process is still answering.
 */
export function isRunningCommit(info: BuildInfo | null, commit: string | null): boolean {
  if (info === null || info.commit === null || commit === null) return false;
  const running = info.commit.toLowerCase();
  const wanted = commit.toLowerCase();
  const shorter = running.length <= wanted.length ? running : wanted;
  const longer = running.length <= wanted.length ? wanted : running;
  if (shorter.length < MIN_ABBREVIATION) return false;
  return longer.startsWith(shorter);
}

/** One line a human can read in a log or a health dump. */
export function describeBuild(info: BuildInfo | null): string {
  if (info === null) return "no build stamp — this process is running from source";
  const commit = info.commit === null ? "an untraceable build" : info.commit.slice(0, 7);
  const dirty = info.dirty ? " (DIRTY working tree)" : "";
  const branch = info.branch === null || info.branch === undefined ? "" : ` on ${info.branch}`;
  return `${commit}${dirty}${branch}, built ${info.builtAt}`;
}
