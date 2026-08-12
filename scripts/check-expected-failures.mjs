#!/usr/bin/env node
/**
 * The test gate: the failure set must EQUAL the declared set.
 *
 * Replaces "zero failures", which forced a false choice. Not everything can be
 * built at once, so an acceptance test for unbuilt behaviour had only two
 * homes: deleted, or softened into asserting what the code currently does. We
 * took the second option and it produced the worst defect in this project — a
 * test named "should leave the Commander talking to himself" passing green
 * while Syl could not reply to anyone.
 *
 * Now such a test stays RED, says what SHOULD happen, and is declared here.
 *
 * Three ways to fail, and the last two are the point:
 *
 *   1. UNDECLARED FAILURE — a real regression. The old gate, preserved.
 *   2. DECLARED TEST THAT PASSES — the feature landed. Promote it out of the
 *      manifest. Without this the list rots: entries outlive the work by
 *      months, and eventually someone deletes a stale line along with real
 *      coverage.
 *   3. DECLARED TEST THAT NO LONGER EXISTS — renamed or deleted. A requirement
 *      must not be retirable by accident.
 *
 * ## A fourth way, added when the suite was split in two
 *
 * The suite now runs as two vitest processes — the cheap majority, and the
 * spawn-heavy files alone on the machine (`scripts/run-tests.mjs`). That is one
 * edit away from a gate that stopped checking: run one pass, read one results
 * file, report green, and the deploy gate goes quiet about exactly the tests
 * that guard the most.
 *
 * So this checker no longer trusts what it is handed. It enumerates every test
 * file on disk, from the workspaces the root `package.json` declares, and fails
 * if any of them is absent from the results it was given. A pass that did not
 * run, a config whose glob stopped matching, a file in neither pass — all of
 * them now say so, on the deploy gate's own path, rather than reading as a
 * clean run.
 *
 * `--newer-than` closes the other half of `syl-b18b`: a results file left by an
 * earlier run in the same worktree is refused rather than graded.
 *
 * Usage: `npm run test:gate`, which is `scripts/run-tests.mjs --gate`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const args = process.argv.slice(2);
const newerThan = Number(
  (args.find((arg) => arg.startsWith("--newer-than=")) ?? "--newer-than=0").slice("--newer-than=".length),
);
const resultsPaths = args.filter((arg) => !arg.startsWith("--"));

if (resultsPaths.length === 0) {
  console.error(
    "[syl] check-expected-failures: give me one or more vitest JSON results files.\n" +
      "      `npm run test:gate` passes both of the suite's passes.",
  );
  process.exit(1);
}

const manifestPath = join(root, "tests", "expected-failures.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const declared = new Map((manifest.expected ?? []).map((e) => [e.test, e]));

/** Every test vitest actually ran, by its full name, across every pass. */
const seen = new Map();
/** Every test FILE a pass reported on, absolute. */
const filesRun = new Set();

for (const path of resultsPaths) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    console.error(`[syl] no vitest results at ${absolute} — did that pass crash?`);
    process.exit(1);
  }
  if (statSync(absolute).mtimeMs < newerThan) {
    console.error(
      `[syl] ${path} predates this run. Refusing to grade one run's failures against another's\n` +
        `      results — two vitest runs in one worktree is exactly how that happens (syl-b18b).`,
    );
    process.exit(1);
  }
  const results = JSON.parse(readFileSync(absolute, "utf8"));
  for (const file of results.testResults ?? []) {
    if (typeof file.name === "string") filesRun.add(file.name);
    for (const assertion of file.assertionResults ?? []) {
      // `fullName` is the describe chain plus the test name — the same string a
      // human reads in the reporter, so a manifest entry is copy-pasteable.
      // A test that passed in one pass and failed in another cannot happen (no
      // file is in both passes), but if it ever did, failure wins.
      const existing = seen.get(assertion.fullName);
      if (existing !== "failed") seen.set(assertion.fullName, assertion.status);
    }
  }
}

/** Every `*.test.ts` under a declared workspace's `tests/`, absolute. */
function testFilesOnDisk() {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      // A workspace with no tests yet is normal. Anything else must not be
      // swallowed: this is a gate, and a gate that fails open is worse than
      // none.
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.ts")) found.push(full);
    }
  };
  for (const workspace of rootPkg.workspaces ?? []) walk(join(root, workspace, "tests"));
  return found;
}

const onDisk = testFilesOnDisk();
const neverRan = onDisk.filter((file) => !filesRun.has(file));

const failed = [...seen].filter(([, status]) => status === "failed").map(([name]) => name);

const undeclared = failed.filter((name) => !declared.has(name));
const passingButDeclared = [...declared.keys()].filter((name) => seen.get(name) === "passed");
const vanished = [...declared.keys()].filter((name) => !seen.has(name));

const problems = [];

if (onDisk.length === 0) {
  problems.push(
    "",
    "  No test files were found on disk at all, so 'every file ran' could not be",
    "  checked. Something is wrong with this checkout, not with the tests.",
  );
}

if (neverRan.length > 0) {
  problems.push(
    "",
    `  ${String(neverRan.length)} test file(s) exist on disk and were run by NO pass:`,
    ...neverRan.map((n) => `    ⃠ ${relative(root, n).split(sep).join("/")}`),
    "",
    "  The suite runs in two passes (scripts/run-tests.mjs). A file matched by",
    "  neither config never runs, and a gate that has stopped covering it says",
    "  nothing — which is this project's signature defect. Fix the include and",
    "  exclude globs in vitest.config.ts / vitest.heavy.config.ts.",
  );
}

if (undeclared.length > 0) {
  problems.push(
    "",
    `  ${String(undeclared.length)} test(s) failed that are NOT declared as expected:`,
    ...undeclared.map((n) => `    ✗ ${n}`),
    "",
    "  If this is a regression, fix it. If it is an acceptance test for work",
    "  that has not been built yet, add it to tests/expected-failures.json WITH",
    "  A BEAD, so it reads as tracked work rather than as something broken.",
  );
}

if (passingButDeclared.length > 0) {
  problems.push(
    "",
    `  ${String(passingButDeclared.length)} declared failure(s) now PASS — promote them:`,
    ...passingButDeclared.map((n) => `    ✓ ${n}`),
    "",
    "  The behaviour got built. Remove these from tests/expected-failures.json",
    "  so they become ordinary gated tests. This check exists because a list",
    "  that only grows is a list nobody trusts.",
  );
}

if (vanished.length > 0) {
  problems.push(
    "",
    `  ${String(vanished.length)} declared failure(s) no longer EXIST:`,
    ...vanished.map((n) => `    ? ${n}`),
    "",
    "  Renamed or deleted. Update the entry, or remove it deliberately — a",
    "  requirement must not be retirable by accident.",
  );
}

if (problems.length > 0) {
  console.error(["", "[syl] the test gate failed.", ...problems, ""].join("\n"));
  process.exit(1);
}

console.error(
  `[syl] ${String(onDisk.length)} test file(s) on disk, all of them run across ` +
    `${String(resultsPaths.length)} pass(es).`,
);

if (declared.size > 0) {
  // Printed every run, on purpose. A number buried in a file is not a
  // conversation; a number that only goes up, in front of you, is.
  console.error(
    [
      "",
      `[syl] ${String(declared.size)} acceptance test(s) failing as expected — behaviour described, not yet built:`,
      ...[...declared.values()].map((e) => `    ${e.bead ?? "NO BEAD"}  ${e.test}`),
      "",
    ].join("\n"),
  );
}
