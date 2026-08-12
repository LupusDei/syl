#!/usr/bin/env node
/**
 * Enforce the coverage thresholds SEPARATELY from whether tests passed.
 *
 * `vitest run --coverage` exits 1 for a failed test and for a missed threshold
 * INDISTINGUISHABLY. That was harmless while the gate was "zero failures", and
 * became a real problem the moment the gate became "failures == declared": the
 * declared acceptance tests are red on purpose, so vitest exits 1 on every run,
 * and there is no way to tell that apart from coverage falling through the
 * floor.
 *
 * The tempting fixes are both wrong. Ignoring vitest's exit code swallows a
 * coverage regression — and `ci.yml` says in as many words not to reintroduce
 * `continue-on-error`. Dropping the declared failures would undo the whole
 * point of the manifest.
 *
 * So the two signals get separated instead of silenced. Coverage is read from
 * the `json-summary` report — the numbers vitest itself computed — and checked
 * here, while `check-expected-failures.mjs` judges the tests. Two questions,
 * two answers, both blocking.
 *
 * The thresholds are constitution rule 1 and live in `vitest.shared.ts` so no
 * workspace can quietly lower its own bar. They are read from there rather than
 * duplicated, because a second copy is a second thing to drift.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const summaryPath = join(root, "coverage", "coverage-summary.json");
if (!existsSync(summaryPath)) {
  console.error(
    [
      "",
      `[syl] no coverage summary at ${summaryPath}.`,
      "",
      "  The run produced no json-summary report, so coverage was NOT checked.",
      "  That is a failure, not a pass: a missing report and a perfect score",
      "  must never look the same.",
      "",
      "  Ensure `json-summary` is in the coverage reporters in vitest.shared.ts.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// Read the thresholds from the one place that defines them.
//
// Anchored on `thresholds: {` — the config KEY followed by an inline object —
// and not on the bare word. This scrape used to start at the first "thresholds"
// anywhere in the file, and the day `PER_PASS_COVERAGE_THRESHOLDS` was added
// above it (with the word in its docblock) the floor silently became
// `lines: 0`. It printed `coverage ok — lines 89.22% (>=0%)`, which is a pass
// notice for a check that was no longer checking: precisely the failure this
// script exists to prevent, in the script itself.
const shared = readFileSync(join(root, "vitest.shared.ts"), "utf8");
const anchor = shared.indexOf("thresholds: {");
if (anchor < 0) {
  console.error(
    [
      "",
      "[syl] could not find `thresholds: {` in vitest.shared.ts.",
      "",
      "  That block is the single definition of the coverage floor (constitution",
      "  rule 1). Refusing to run rather than guessing a floor.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
const block = shared.slice(anchor);
const threshold = (name) => {
  const match = new RegExp(`${name}:\\s*(\\d+)`).exec(block);
  if (match === null) throw new Error(`could not read the ${name} threshold from vitest.shared.ts`);
  return Number(match[1]);
};

const required = {
  lines: threshold("lines"),
  branches: threshold("branches"),
  functions: threshold("functions"),
};

// A ZERO FLOOR IS NOT A FLOOR, and a scrape is exactly the kind of mechanism
// that fails by finding the wrong number rather than by finding none. Every
// value here must be a real bar, so a misread announces itself instead of
// congratulating everybody.
const notAFloor = Object.entries(required).filter(([, floor]) => floor <= 0);
if (notAFloor.length > 0) {
  console.error(
    [
      "",
      "[syl] the coverage floor read as zero, which is not a floor.",
      "",
      ...notAFloor.map(([metric, floor]) => `    ${metric}: ${String(floor)}`),
      "",
      "  This script reads vitest.shared.ts. Either the thresholds really were",
      "  lowered — constitution rule 1 says raise the coverage, not the file —",
      "  or the scrape matched the wrong block.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const total = summary.total;

const short = Object.entries(required)
  .map(([metric, floor]) => ({ metric, floor, actual: total[metric]?.pct ?? 0 }))
  .filter(({ actual, floor }) => actual < floor);

if (short.length > 0) {
  console.error(
    [
      "",
      "[syl] coverage is below the floor.",
      "",
      ...short.map(({ metric, actual, floor }) => `    ${metric}: ${actual}% < ${floor}%`),
      "",
      "  Constitution rule 1. Thresholds live in vitest.shared.ts so no workspace",
      "  can quietly lower its own bar — raise the coverage, not the file.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.error(
  `[syl] coverage ok — ` +
    Object.entries(required)
      .map(([metric, floor]) => `${metric} ${total[metric]?.pct ?? 0}% (>=${floor}%)`)
      .join(", "),
);
