#!/usr/bin/env node
/**
 * Copy every non-TypeScript asset from `src/` into `dist/`, and fail the build
 * if there were none.
 *
 * `tsc` emits JavaScript and nothing else. It does not copy `.sql` files, and
 * it does not warn that it hasn't. A build that loses the migrations produces a
 * service that starts cleanly, connects to SQLite cleanly, applies zero
 * migrations, and then fails on the first query against a table that does not
 * exist — which is what took Adjutant's server down.
 *
 * The zero-file check is the part that matters. Copying assets is easy to add
 * and easy to silently break later: rename a directory, change an `outDir`,
 * move a file, and this script keeps exiting 0 while copying nothing. So an
 * empty copy is a build failure, loudly, with the two paths printed.
 *
 * Usage:
 *   node scripts/copy-assets.mjs [--src <dir>] [--out <dir>]
 */

import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDir, "..");

/** Files `tsc` already handles. Everything else is an asset. */
const COMPILED = /\.(ts|tsx|mts|cts)$/;

/**
 * Every asset under `dir`, as paths relative to it.
 *
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function assetsUnder(dir, prefix = "") {
  /** @type {string[]} */
  const found = [];

  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // A missing source directory means the build is already wrong. Say so
    // rather than reporting "zero assets", which reads like a different bug.
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      throw new Error(`Cannot read ${dir}: it does not exist.`);
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...assetsUnder(join(dir, entry.name), rel));
    else if (!COMPILED.test(entry.name)) found.push(rel);
  }

  return found.sort();
}

/**
 * Copy every asset from `srcDir` to `outDir`, preserving layout.
 *
 * @param {{ srcDir: string, outDir: string }} options
 * @returns {string[]} the relative paths copied
 */
export function copyAssets({ srcDir, outDir }) {
  const assets = assetsUnder(srcDir);

  for (const rel of assets) {
    const target = join(outDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(srcDir, rel), target);
  }

  return assets;
}

/** The extension of a path, lowercased, including the dot. `""` if none. */
function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Delete assets in `outDir` that `srcDir` no longer has.
 *
 * Copying without pruning leaves a renamed file behind forever, and the stale
 * copy is what the BUILT service reads while the source tree looks correct.
 * That is how renaming `0014_memory_retrieval.sql` produced "Two migrations
 * claim version 14" naming a file that no longer existed: source right, build
 * wrong, and an error pointing at nothing you can grep for (`syl-oqe`).
 *
 * **Only extensions that appear among the source assets are eligible.** `dist`
 * is mostly tsc's output, which by construction has no counterpart in `src`, so
 * a naive "delete anything not in the copied list" would empty the build. tsc
 * emits `.js`, `.map` and `.d.ts` and never a `.sql`, so keying on the asset
 * extensions makes its output *ineligible* rather than merely unlikely.
 *
 * @param {{ srcDir: string, outDir: string, copied: readonly string[] }} options
 * @returns {string[]} the relative paths removed
 */
export function pruneStaleAssets({ outDir, copied }) {
  const eligible = new Set(copied.map((rel) => extensionOf(rel)).filter((ext) => ext !== ""));
  if (eligible.size === 0) return [];

  const kept = new Set(copied);

  /** @type {string[]} */
  let present;
  try {
    present = assetsUnder(outDir);
  } catch {
    // No build output yet. Nothing to prune, and not an error.
    return [];
  }

  const removed = present
    .filter((rel) => eligible.has(extensionOf(rel)))
    .filter((rel) => !kept.has(rel));

  for (const rel of removed) rmSync(join(outDir, rel), { force: true });

  return removed;
}

/**
 * @param {readonly string[]} argv
 * @returns {{ srcDir: string, outDir: string }}
 */
export function parseArgs(argv) {
  let srcDir = join(workspaceRoot, "src");
  let outDir = join(workspaceRoot, "dist");

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--src" || flag === "--out") {
      if (value === undefined) throw new Error(`${flag} needs a directory.`);
      if (flag === "--src") srcDir = value;
      else outDir = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument ${flag}. Usage: copy-assets.mjs [--src <dir>] [--out <dir>]`);
    }
  }

  return { srcDir, outDir };
}

function main() {
  const { srcDir, outDir } = parseArgs(process.argv.slice(2));
  const copied = copyAssets({ srcDir, outDir });
  const removed = pruneStaleAssets({ srcDir, outDir, copied });

  if (copied.length === 0) {
    console.error(
      [
        "",
        "[syl] BUILD FAILED: no assets were copied into the build output.",
        "",
        `  from: ${srcDir}`,
        `  to:   ${outDir}`,
        "",
        "  tsc emits JavaScript and copies nothing else, so the .sql migrations",
        "  reach dist/ only through this step. A build with no assets produces a",
        "  service that starts, opens SQLite, applies zero migrations, and then",
        "  fails on the first query. That failure appears in production, hours",
        "  later, nowhere near this build.",
        "",
        "  Either the source layout moved, or there is genuinely nothing to copy",
        "  — and if the latter is now true, delete this step deliberately rather",
        "  than letting it pass silently.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `[syl] copied ${copied.length} asset${copied.length === 1 ? "" : "s"} into ${relative(workspaceRoot, outDir) || outDir}:`,
  );
  for (const rel of copied) console.log(`        ${rel}`);

  if (removed.length > 0) {
    // Say it out loud. A file disappearing from the build output is exactly the
    // kind of thing that should never be silent, even when it is correct.
    console.log(
      `[syl] removed ${removed.length} stale asset${removed.length === 1 ? "" : "s"} no longer in ${relative(workspaceRoot, srcDir) || srcDir}:`,
    );
    for (const rel of removed) console.log(`        ${rel}`);
  }
}

// Run only when executed directly, so importing this module copies nothing.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
