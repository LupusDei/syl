import { defineConfig, mergeConfig } from "vitest/config";

import { sharedTestConfig } from "../vitest.shared.js";

/**
 * Focused runs: `npm test -w frontend`. The root config runs every workspace,
 * and it is the one CI gates on — so this file must not diverge from it in any
 * way that could let a test pass here and fail there. It merges the shared
 * config unchanged and adds nothing but the include path.
 *
 * Note what is deliberately absent: a jsdom `environment`. The root runner
 * pins `environment: "node"` for the whole repo, so every DOM test declares
 * `// @vitest-environment jsdom` in its own docblock. Setting it here instead
 * would work locally and silently do nothing in CI.
 */
export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      include: ["tests/**/*.test.ts"],
    },
  }),
);
