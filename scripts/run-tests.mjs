#!/usr/bin/env node
/**
 * The whole suite, in two passes, in one command.
 *
 * ## Why two passes
 *
 * Six files spawn real processes — a live service, the launchd entry point, an
 * MCP server over stdio, `syl-verify.sh` — and they had been timing out at
 * 20 000ms on a machine running several agents at once, each one passing
 * perfectly in isolation. They were not slow, they were STARVED: vitest runs
 * its pools concurrently, so `poolMatchGlobs` routing them to a `singleFork`
 * pool only stopped them starving each other while they went on racing the
 * three worker threads chewing through five thousand unit tests.
 *
 * So the heavy files get the machine to themselves, in a second vitest process
 * that starts after the first has exited. See `vitest.heavy.config.ts`.
 *
 * ## THE TRAP THIS SCRIPT EXISTS TO SHUT
 *
 * Splitting a suite into two passes is one edit away from a gate that stopped
 * checking. `npm run deploy` runs `npm run verify`, `verify` runs `test:gate`,
 * and `test:gate` is this script — so if this script ever ran one pass and
 * reported success, the deploy gate would go quiet about exactly the tests that
 * guard the most: non-negotiable constraint 3 (metered billing) and the
 * quiet-hours bypass that stops an unattended turn waking the Commander at 3am.
 *
 * Three things make that impossible rather than merely unlikely:
 *
 *   1. **Both passes always run.** There is no flag to run one. A failing first
 *      pass does not skip the second — the gate's question is which tests
 *      failed, and it cannot be answered from half a run.
 *   2. **A pass that produced no results file is a hard failure**, checked by
 *      mtime against this invocation's start, so a stale file left by an
 *      earlier run can never be read as this one's (`syl-b18b`).
 *   3. **The two configs must partition the suite exactly** — no file in both,
 *      no file in neither — which `backend/tests/unit/vitest-partition.test.ts`
 *      asserts against the real filesystem.
 *
 * ## Usage
 *
 *   node scripts/run-tests.mjs              # npm test
 *   node scripts/run-tests.mjs --gate       # npm run test:gate
 *   node scripts/run-tests.mjs --gate --coverage   # npm run test:coverage
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/**
 * The vitest binary, resolved rather than trusted to be on `PATH`.
 *
 * `npm run` puts `node_modules/.bin` on the path and a bare `node
 * scripts/run-tests.mjs` does not, and the difference should not decide whether
 * the suite runs. Same reasoning as `harness/claude-bin.ts`.
 */
const vitestBin = join(root, "node_modules", ".bin", "vitest");

const gate = process.argv.includes("--gate");
const coverage = process.argv.includes("--coverage");

/**
 * The passes, in the order they run.
 *
 * Light first: it is where a typo, an import cycle or a broken mock fails
 * fastest, and there is no point giving the machine over to the heavy pass
 * before the cheap half has had its say.
 */
const PASSES = [
  {
    name: "light",
    config: "vitest.config.ts",
    results: join("tests", ".vitest-results.light.json"),
    coverageDir: join("coverage", ".light"),
  },
  {
    name: "heavy",
    config: "vitest.heavy.config.ts",
    results: join("tests", ".vitest-results.heavy.json"),
    coverageDir: join("coverage", ".heavy"),
  },
];

/** Started before the first pass, so every results file can be dated against it. */
const startedAt = Date.now();

function run(command, args, extraEnv = {}) {
  return spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
}

const exitCodes = [];

for (const pass of PASSES) {
  const resultsPath = join(root, pass.results);
  // Removed rather than overwritten: a pass that dies before vitest writes
  // anything must leave NO file, so the mtime check below cannot be satisfied
  // by yesterday's answer.
  rmSync(resultsPath, { force: true });

  const args = ["run", "--config", pass.config];
  if (gate) {
    args.push("--reporter=default", "--reporter=json", `--outputFile.json=${pass.results}`);
  }
  if (coverage) {
    args.push(
      "--coverage",
      `--coverage.reportsDirectory=${pass.coverageDir}`,
      // One machine-readable report per pass; `scripts/merge-coverage.mjs`
      // turns the two into the text, lcov and json-summary reports that a
      // single run would have produced.
      "--coverage.reporter=json",
    );
    rmSync(join(root, pass.coverageDir), { recursive: true, force: true });
  }

  console.error(`\n[syl] ${pass.name} pass — vitest ${args.join(" ")}\n`);
  const result = run(vitestBin, args);
  exitCodes.push(result.status ?? 1);

  if (gate) {
    if (!existsSync(resultsPath)) {
      console.error(
        [
          "",
          `[syl] the ${pass.name} pass produced no results at ${pass.results}.`,
          "",
          "  That is a FAILURE, not a pass. The gate judges the set of failing",
          "  tests, and a pass that left no record has not been judged at all —",
          "  which is how a split suite quietly stops covering half of itself.",
          "",
        ].join("\n"),
      );
      process.exit(1);
    }
    if (statSync(resultsPath).mtimeMs < startedAt) {
      console.error(
        `\n[syl] ${pass.results} predates this run — refusing to grade one run against another (syl-b18b).\n`,
      );
      process.exit(1);
    }
  }
}

if (!gate) {
  // `npm test` — no manifest, so vitest's own exit code is the answer. Both
  // passes still ran, which is the property that matters.
  process.exit(exitCodes.some((code) => code !== 0) ? 1 : 0);
}

// Deliberately NOT gated on the vitest exit codes. The declared acceptance
// tests are red on purpose, so vitest exits non-zero on every healthy run; the
// question the gate asks is which tests failed, and only the checker can
// answer it.
const checked = run("node", [
  join(here, "check-expected-failures.mjs"),
  `--newer-than=${String(startedAt)}`,
  ...PASSES.map((pass) => pass.results),
]);

if (!coverage) process.exit(checked.status ?? 1);

const merged = run("node", [join(here, "merge-coverage.mjs"), ...PASSES.map((pass) => pass.coverageDir)]);
if ((merged.status ?? 1) !== 0) process.exit(merged.status ?? 1);

const floor = run("node", [join(here, "check-coverage.mjs")]);
process.exit((checked.status ?? 1) !== 0 ? checked.status ?? 1 : floor.status ?? 1);
