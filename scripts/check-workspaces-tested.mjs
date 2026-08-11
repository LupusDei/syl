#!/usr/bin/env node
/**
 * Fail the build if a workspace ships source without tests.
 *
 * The rule is deliberately "source implies tests", not "every directory has
 * tests": `frontend/` and `shared/` are laid-out-but-empty rooms owned by other
 * epics, and red-lighting CI for a room nobody has moved into yet teaches
 * everyone to ignore CI. The moment a workspace grows a `.ts` file under
 * `src/`, it owes at least one test — constitution rule 1.
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} dir @param {RegExp} match @returns {Promise<string[]>} */
async function filesUnder(dir, match) {
  /** @type {string[]} */
  const found = [];
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A missing directory is the normal case for a workspace that has no
    // src/ or tests/ yet. Anything else — a permissions failure, a broken
    // symlink — must not be swallowed: this is a gate, and a gate that
    // fails open is worse than no gate.
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(full, match)));
    else if (match.test(entry.name)) found.push(full);
  }
  return found;
}

const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const workspaces = rootPkg.workspaces ?? [];

if (workspaces.length === 0) {
  console.error("FAIL: the root package.json declares no workspaces.");
  process.exit(1);
}

let failed = false;

for (const workspace of workspaces) {
  const dir = join(repoRoot, workspace);
  const sources = await filesUnder(join(dir, "src"), /\.ts$/);
  const tests = await filesUnder(join(dir, "tests"), /\.test\.ts$/);

  if (sources.length === 0) {
    console.log(`skip  ${workspace}: no source under src/ yet`);
    continue;
  }
  if (tests.length === 0) {
    console.error(
      `FAIL  ${workspace}: ${sources.length} source file(s) under src/ and no *.test.ts under tests/`,
    );
    failed = true;
    continue;
  }
  console.log(`ok    ${workspace}: ${sources.length} source file(s), ${tests.length} test file(s)`);
}

if (failed) {
  console.error("\nEvery workspace with source code must have tests (constitution rule 1).");
  process.exit(1);
}
