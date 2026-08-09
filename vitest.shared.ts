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
    /**
     * Longer than vitest's 5s default, because a real subprocess is not a
     * mocked one.
     *
     * `session.test.ts`, `reader.test.ts`, `intake.test.ts`, `us2` and `us4`
     * spawn an actual `node` per turn — see `tests/helpers/fake-claude.ts` for
     * why the fake is an executable rather than a stubbed `spawn`. Each of
     * those tests takes ~300–600ms alone, and vitest runs files in parallel
     * across every core. On a busy machine a spawn is starved long enough to
     * blow a 5s budget, and the suite goes red in a different place each run
     * with nothing wrong in it. Measured: the same commit produced 0, 1, 11 and
     * 24 failures on consecutive runs, every one of them
     * "Test timed out in 5000ms" in a suite that spawns.
     *
     * A timeout is a deadlock breaker, not a latency budget — the same
     * reasoning as `DEFAULT_TURN_TIMEOUT_MS`. A test that genuinely hangs still
     * fails; it takes twenty seconds to say so, which is a fair price for a
     * green run meaning something.
     */
    testTimeout: 20_000,
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
