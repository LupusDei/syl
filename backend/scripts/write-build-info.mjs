#!/usr/bin/env node
/**
 * Stamp the build with the commit it was made from.
 *
 * ## Why this exists
 *
 * A stale build is invisible by construction. Every health check passes,
 * because the old build is perfectly healthy — it is answering, its database is
 * fine, its certificate is fine, and it is simply not the code anybody thinks
 * is running. That already cost three hours here: the service came up at 19:58,
 * a fix landed at 20:18, and Syl went on answering through a tool surface that
 * had been removed until the Commander noticed something read oddly and asked.
 *
 * ## Why it is baked in at BUILD time and never read at request time
 *
 * The running service must report what it was **built from**, not what the
 * working tree says now. Those two answers differ, and the difference is the
 * entire point — a service that shells out to `git rev-parse HEAD` when asked
 * would have reported the *new* commit throughout that three-hour window and
 * proved nothing at all.
 *
 * A second property falls out of writing the stamp into `dist/`: it travels
 * with the artifact. Restore a previous `dist/` and the health endpoint
 * immediately reports the previous commit, with nothing to keep in sync.
 *
 * Usage:
 *   node scripts/write-build-info.mjs [--repo <dir>] [--out <file>]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDir, "..");

/**
 * Ask git something, or answer `null`.
 *
 * Every call here is read-only and every failure means the same thing: this is
 * not a checkout, or git is not installed. That is a legitimate way to build —
 * from a tarball, inside a container — so it must not fail the build. It must
 * only refuse to invent a commit.
 *
 * @param {string} repo
 * @param {readonly string[]} args
 * @returns {string | null}
 */
export function gitOutput(repo, args) {
  try {
    return execFileSync("git", [...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Read the provenance of `repo` as of right now.
 *
 * `dirty` counts untracked files as well as modified ones (`--porcelain`
 * without `-uno`). A build that picked up a file nobody has committed is not
 * reproducible from `commit`, and it is worth knowing that the "is she running
 * HEAD" question has a more complicated answer than yes.
 *
 * @param {string} repo
 * @param {() => Date} [now]
 * @returns {{ commit: string | null, builtAt: string, dirty: boolean, branch: string | null }}
 */
export function readProvenance(repo, now = () => new Date()) {
  const commit = gitOutput(repo, ["rev-parse", "HEAD"]);
  const branch = commit === null ? null : gitOutput(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const porcelain = commit === null ? null : gitOutput(repo, ["status", "--porcelain"]);

  return {
    commit,
    builtAt: now().toISOString(),
    // Only meaningful next to a commit. With no commit there is nothing for a
    // dirty tree to qualify, and `commit: null` is already the louder signal.
    dirty: porcelain !== null && porcelain !== "",
    branch: branch === "HEAD" ? null : branch,
  };
}

/**
 * @param {readonly string[]} argv
 * @returns {{ repo: string, out: string }}
 */
export function parseArgs(argv) {
  let repo = join(workspaceRoot, "..");
  let out = join(workspaceRoot, "dist", "build-info.json");

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--repo" || flag === "--out") {
      if (value === undefined) throw new Error(`${flag} needs a path.`);
      if (flag === "--repo") repo = value;
      else out = value;
      i += 1;
    } else {
      throw new Error(
        `Unknown argument ${flag}. Usage: write-build-info.mjs [--repo <dir>] [--out <file>]`,
      );
    }
  }

  return { repo, out };
}

function main() {
  const { repo, out } = parseArgs(process.argv.slice(2));
  const info = readProvenance(repo);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`, "utf8");

  if (info.commit === null) {
    console.warn(
      [
        "",
        `[syl] build stamped with NO COMMIT: ${repo} is not a git checkout.`,
        "",
        "  The service will report `build.commit: null` on /health, and",
        "  scripts/syl-verify.sh will be unable to tell you whether it is",
        "  stale. That is the honest answer for a build made outside a",
        "  checkout — but if this ran during a deploy, something is wrong.",
        "",
      ].join("\n"),
    );
    return;
  }

  console.log(
    `[syl] build stamped ${info.commit.slice(0, 7)}${info.dirty ? " (DIRTY)" : ""}` +
      ` on ${info.branch ?? "a detached HEAD"} at ${info.builtAt}`,
  );
}

// Run only when executed directly, so importing this module stamps nothing.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[syl] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(64);
  }
}
