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
 * Usage: `npm run test:gate` (vitest writes JSON, this reads it).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const manifestPath = join(root, "tests", "expected-failures.json");
const resultsPath = join(root, "tests", ".vitest-results.json");

if (!existsSync(resultsPath)) {
  console.error(`[syl] no vitest results at ${resultsPath} — did the test run crash?`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const declared = new Map((manifest.expected ?? []).map((e) => [e.test, e]));

const results = JSON.parse(readFileSync(resultsPath, "utf8"));

/** Every test vitest actually ran, by its full name. */
const seen = new Map();
for (const file of results.testResults ?? []) {
  for (const assertion of file.assertionResults ?? []) {
    // `fullName` is the describe chain plus the test name — the same string a
    // human reads in the reporter, so a manifest entry is copy-pasteable.
    seen.set(assertion.fullName, assertion.status);
  }
}

const failed = [...seen].filter(([, status]) => status === "failed").map(([name]) => name);

const undeclared = failed.filter((name) => !declared.has(name));
const passingButDeclared = [...declared.keys()].filter((name) => seen.get(name) === "passed");
const vanished = [...declared.keys()].filter((name) => !seen.has(name));

const problems = [];

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
