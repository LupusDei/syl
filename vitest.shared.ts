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
     * why the fake is an executable rather than a stubbed `spawn`. Each takes
     * ~300-600ms alone, and vitest runs files in parallel across every core. On
     * a busy machine a spawn is starved long enough to blow a 5s budget, and
     * the suite goes red in a DIFFERENT PLACE each run with nothing wrong in it.
     *
     * Measured twice, independently, by two people who each arrived at 20s: the
     * same commit produced 0, 1, 11 and 24 failures on consecutive runs; and a
     * separate pass saw five failures on one run and a different five on the
     * next — including the `ANTHROPIC_API_KEY` stripping test. A flaky guard on
     * the billing constraint is worse than no guard, because a red that moves
     * around teaches everyone to re-run until green.
     *
     * A timeout is a deadlock breaker, not a latency budget — the same
     * reasoning as `DEFAULT_TURN_TIMEOUT_MS`. A test that genuinely hangs still
     * fails; it takes twenty seconds to say so, which is a fair price for a
     * green run meaning something. Tests needing longer still pass their own
     * value (the launchd entrypoint asks for 90s).
     *
     * `hookTimeout` matches, because a `beforeAll` that builds the backend is
     * subject to exactly the same starvation as the tests it prepares.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      // `json-summary` is what `scripts/check-coverage.mjs` reads. Coverage has to
      // be judged SEPARATELY from whether tests passed, because `vitest run
      // --coverage` exits 1 for a failed test and a missed threshold
      // indistinguishably — harmless under "zero failures", useless under
      // "failures == declared".
      reporter: ["text", "lcov", "json-summary"],
      // Report coverage even when tests FAIL, which is now the normal state.
      //
      // vitest writes no coverage report at all on a failed run — no table, no
      // summary file. That was harmless while the gate was "zero failures":
      // a red run had a bigger problem than its coverage. Under "failures ==
      // declared" it is a hole, because a declared acceptance test is red on
      // PURPOSE and permanently, so the coverage floor would quietly stop being
      // enforced and nothing would say so.
      //
      // Found by building the split check and discovering there was no summary
      // to read. The floor is constitution rule 1; it must not lapse because a
      // test is red for a reason we chose.
      reportOnFailure: true,
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
        // AGENT WORKTREES, which are full copies of this repository living
        // inside it. v8 coverage runs with `all: true`, so every file in every
        // worktree was counted as uncovered source: 3,427 of the 3,698 files
        // measured, against roughly 135 real ones. Coverage read 3.6% lines
        // with 3,039 tests passing.
        //
        // It was invisible because vitest writes NO coverage report when a run
        // fails, and something was usually failing. Two faults hiding each
        // other: the gate was not running, and when it did it was measuring the
        // wrong thing.
        "**/.claude/**",
        "**/worktrees/**",
      ],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 60,
      },
    },
  },
} as const satisfies UserConfig;
