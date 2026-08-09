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
      //
      // `dist/` and `coverage/` are excluded because v8 coverage runs with
      // `all: true`: a local build before a coverage run otherwise counts the
      // emitted artifacts as uncovered source and tanks the gate. Measured at
      // 92.7% -> 73.9% lines from build output alone (syl-3bi). CI never builds
      // before the coverage step, so it was safe by accident rather than by
      // design — and a frontend workspace makes local builds routine.
      exclude: [
        "**/cli/**",
        "**/tests/**",
        "**/*.config.ts",
        "**/vitest.shared.ts",
        "**/dist/**",
        "**/coverage/**",
      ],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 60,
      },
    },
  },
} as const satisfies UserConfig;
