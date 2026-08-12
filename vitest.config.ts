import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import {
  HEAVY_TEST_GLOBS,
  PER_PASS_COVERAGE_THRESHOLDS,
  UNIT_TIMEOUT_MS,
  sharedTestConfig,
} from "./vitest.shared.js";

/**
 * The light pass: every workspace's tests EXCEPT the ones that spawn a real
 * process.
 *
 * The suite runs as two vitest invocations, this one first —
 * `scripts/run-tests.mjs` is the only supported way to run it, and there is no
 * flag that runs one pass without the other. See `vitest.heavy.config.ts` for
 * why a pool was not enough.
 *
 * ## `exclude` is the authoritative half of the partition
 *
 * A file matched by both configs runs twice; a file matched by neither never
 * runs and nothing says so, which is this project's signature defect. `exclude`
 * is what decides it, because it is applied after `include` in both configs —
 * so the two lists cannot disagree about a file the way two `include`s could.
 * `check-expected-failures.mjs` then proves the result empirically on every
 * gated run: it enumerates the test files on disk and fails if any of them was
 * run by no pass.
 *
 * `configDefaults.exclude` is spread back in because naming `exclude` REPLACES
 * vitest's own list, and dropping `node_modules` from it would sweep in every
 * test file in every installed package.
 */
export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      include: ["{backend,frontend,shared}/tests/**/*.test.ts"],
      exclude: [...configDefaults.exclude, ...HEAVY_TEST_GLOBS],
      // The only config that may narrow the budget, because it is the only one
      // that knows it holds no spawn-heavy file. See `vitest.shared.ts`.
      testTimeout: UNIT_TIMEOUT_MS,
      hookTimeout: UNIT_TIMEOUT_MS,
      coverage: { thresholds: PER_PASS_COVERAGE_THRESHOLDS },
    },
  }),
);
