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
    // Vitest's default is 5s, and that is not a valid assumption for this
    // suite. A large share of these tests spawn a REAL subprocess — the fake
    // `claude` executable, the launchd entrypoint — because that is the only
    // way to test a harness whose entire job is spawning one.
    //
    // In isolation each takes 300-400ms and 5s looks generous. Under the full
    // suite, with vitest running files in parallel and each spawning node,
    // they intermittently blew past 5s: five failures on one run, a DIFFERENT
    // five on the next, including the `ANTHROPIC_API_KEY` stripping test.
    // A flaky guard on the billing constraint is worse than no guard, because
    // a red that moves around teaches everyone to re-run until green.
    //
    // The cost of 20s is that a genuinely hung fast test takes 20s to report
    // instead of 5s. That is a far better trade than a suite whose result
    // depends on machine load. Tests needing longer still pass their own value
    // (the launchd entrypoint asks for 90s).
    testTimeout: 20_000,
    hookTimeout: 20_000,
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
