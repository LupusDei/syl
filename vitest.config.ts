import { defineConfig, mergeConfig } from "vitest/config";

import { sharedTestConfig } from "./vitest.shared.js";

/**
 * Root runner: every workspace's tests in one pass, so `npm test` from the repo
 * root is the single command that has to be green. Each workspace also keeps
 * its own config for focused runs (`npm test -w backend`).
 */
export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      include: ["{backend,frontend,shared}/tests/**/*.test.ts"],
    },
  }),
);
