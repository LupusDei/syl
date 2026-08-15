import { defineConfig } from "vitest/config";

import {
  HEAVY_HOOK_TIMEOUT_MS,
  HEAVY_TEST_GLOBS,
  HEAVY_TIMEOUT_MS,
  PER_PASS_COVERAGE_THRESHOLDS,
  sharedTestConfig,
} from "./vitest.shared.js";

/**
 * The heavy pass: every file that spawns a real process, alone on the machine.
 *
 * ## Why this is a separate vitest INVOCATION and not a separate pool
 *
 * `vitest.shared.ts` routes these files to the `forks` pool with `singleFork`,
 * which reads like isolation and is not. Vitest dispatches its pools with
 * `Promise.all` — `runFiles` maps over `filesByPool` and awaits them together —
 * so the forks pool and the threads pool start at the same instant and run side
 * by side to the end. All `singleFork` ever bought was that the heavy files did
 * not starve *each other*; they went on racing three worker threads chewing
 * through five thousand unit tests for the same cores, which is the contention
 * that was actually killing them.
 *
 * A second process is the only arrangement vitest 2.1 offers in which one set
 * of files provably has the machine to itself. `scripts/run-tests.mjs` runs the
 * two passes one after the other and is the only supported way to run the
 * suite, precisely so that neither pass can be run without the other.
 *
 * ## The membership rule is a directory, not a list
 *
 * `HEAVY_TEST_GLOBS` says "acceptance and integration", which is the boundary
 * this repository had already drawn. A hand-maintained list of the six files
 * that happened to time out this week would rot the moment a seventh was
 * written, and the seventh is exactly the one nobody would think to add.
 *
 * ## Built by spread rather than `mergeConfig`
 *
 * `mergeConfig` CONCATENATES arrays, so merging an `include` on top of the
 * shared one would give this pass both — and the partition with the light pass
 * has to be exact, because a file in both passes runs twice and a file in
 * neither never runs at all.
 */
export default defineConfig({
  ...sharedTestConfig,
  test: {
    ...sharedTestConfig.test,
    include: [...HEAVY_TEST_GLOBS],
    // One file at a time, in one process. `singleFork` is what serialises them;
    // `fileParallelism: false` says so where a reader looks first, and the
    // worker caps stop the pool sizing itself off a machine this pass is
    // deliberately not sharing.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    // The budget for a class of test, set once for the class, so a new heavy
    // file gets the right cap without its author having to know the number.
    testTimeout: HEAVY_TIMEOUT_MS,
    hookTimeout: HEAVY_HOOK_TIMEOUT_MS,
    coverage: { ...sharedTestConfig.test.coverage, thresholds: PER_PASS_COVERAGE_THRESHOLDS },
  },
});
