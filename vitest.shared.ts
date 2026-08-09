import type { UserConfig } from "vitest/config";

/**
 * The one vitest configuration every workspace merges. Coverage thresholds are
 * constitution rule 1 and are deliberately expressed here rather than per
 * workspace, so no workspace can quietly lower its own bar.
 */
export const sharedTestConfig = {
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Thin argv/stdout entry points. They are exercised by `npm run ping`,
      // not by unit tests, and counting them only dilutes the signal from the
      // logic that does have tests.
      exclude: ["**/cli/**", "**/tests/**", "**/*.config.ts", "**/vitest.shared.ts"],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 60,
      },
    },
  },
} as const satisfies UserConfig;
