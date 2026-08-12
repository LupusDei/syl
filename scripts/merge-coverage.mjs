#!/usr/bin/env node
/**
 * One coverage report out of the suite's two passes.
 *
 * The suite runs as two vitest processes so the spawn-heavy files are not
 * starved by the unit tests (`scripts/run-tests.mjs`). Each writes its own
 * `coverage-final.json`; vitest 2.1 has no `--merge-reports`, and its v8
 * provider keeps its per-worker coverage in an in-process Map, so the second
 * run cannot pick up the first run's.
 *
 * Summing two `coverage-summary.json` files would be wrong — the two passes
 * cover overlapping lines of the same files, so added totals double-count.
 * Istanbul's coverage map knows how to merge two hit maps for real, and that is
 * all this does: merge, then emit exactly the reporters a single run emitted,
 * into `coverage/`, where `scripts/check-coverage.mjs` looks for the floor.
 *
 * A pass whose report is missing is a hard failure. Coverage that silently
 * measured half the suite and passed is the same defect as a gate that stopped
 * checking, wearing the other hat.
 *
 * Usage: `node scripts/merge-coverage.mjs coverage/.light coverage/.heavy`
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Default imports, not named ones: all three of these are CommonJS, and Node
// refuses `import { createCoverageMap } from "istanbul-lib-coverage"` outright.
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const passDirectories = process.argv.slice(2);
if (passDirectories.length === 0) {
  console.error("[syl] merge-coverage: give me the per-pass report directories.");
  process.exit(1);
}

const map = libCoverage.createCoverageMap({});

for (const directory of passDirectories) {
  const finalPath = resolve(root, directory, "coverage-final.json");
  if (!existsSync(finalPath)) {
    console.error(
      [
        "",
        `[syl] no coverage report at ${finalPath}.`,
        "",
        "  One of the suite's passes produced no coverage, so the merged report",
        "  would describe part of the suite while looking like all of it. A",
        "  missing report and a perfect score must never be the same thing.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  map.merge(JSON.parse(readFileSync(finalPath, "utf8")));
}

const outputDirectory = join(root, "coverage");
// The per-pass directories live under `coverage/`, so they are cleared out
// before the merged report is written rather than after — otherwise `coverage/`
// carries two half-reports beside the whole one, and the next reader picks the
// wrong file.
mkdirSync(outputDirectory, { recursive: true });
const context = libReport.createContext({ dir: outputDirectory, coverageMap: map });

// The same reporters `vitest.shared.ts` asks for. `json-summary` is the one
// `check-coverage.mjs` reads; `text` is the table a human expects to see at the
// end of a run; `lcov` is what an editor and a CI annotator read.
for (const reporter of ["text", "lcov", "json-summary"]) {
  reports.create(reporter).execute(context);
}

for (const directory of passDirectories) rmSync(resolve(root, directory), { recursive: true, force: true });

console.error(`[syl] merged coverage from ${String(passDirectories.length)} pass(es) into coverage/`);
