import { cpus } from "node:os";

import type { UserConfig } from "vitest/config";

/**
 * THE FILES THAT SPAWN A REAL PROCESS, AND THEREFORE RUN ALONE.
 *
 * `scripts/run-tests.mjs` runs the suite as two vitest processes: everything
 * else first, then these, with the machine to themselves. The membership rule
 * is a DIRECTORY and not a list of filenames — acceptance and integration are
 * the boundary this repository already drew, and a hand-maintained list of the
 * six files that happened to time out this week would rot the moment a seventh
 * was written. The seventh is exactly the one nobody would think to add.
 *
 * Anchored at the workspace names on purpose. The same glob without that
 * prefix — a leading double-star instead — also matches
 * `.claude/worktrees/<agent>/backend/tests/acceptance/`, and this repository
 * keeps full copies of itself in there. That is the trap that once made
 * coverage read 3.6%; here it would run another agent's tests as if they were
 * ours.
 */
export const HEAVY_TEST_GLOBS = [
  "{backend,frontend,shared}/tests/acceptance/**/*.test.ts",
  "{backend,frontend,shared}/tests/integration/**/*.test.ts",
] as const;

/**
 * The budget for a test that only computes, and the budget for one that spawns.
 *
 * Longer than vitest's 5s default, because a real subprocess is not a mocked
 * one. `session.test.ts`, `reader.test.ts`, `intake.test.ts`, `us2` and `us4`
 * spawn an actual `node` per turn — see `tests/helpers/fake-claude.ts` for why
 * the fake is an executable rather than a stubbed `spawn`. Each takes
 * ~300-600ms alone, and on a busy machine a spawn is starved long enough to
 * blow a 5s budget, with the suite going red in a DIFFERENT PLACE each run and
 * nothing wrong in it.
 *
 * Measured twice, independently, by two people who each arrived at 20s: the
 * same commit produced 0, 1, 11 and 24 failures on consecutive runs; and a
 * separate pass saw five failures on one run and a different five on the next
 * — including the `ANTHROPIC_API_KEY` stripping test. A flaky guard on the
 * billing constraint is worse than no guard, because a red that moves around
 * teaches everyone to re-run until green.
 *
 * A timeout is a DEADLOCK BREAKER, not a latency budget — the same reasoning as
 * `DEFAULT_TURN_TIMEOUT_MS`. A test that genuinely hangs still fails; it takes
 * longer to say so, which is a fair price for a green run meaning something.
 *
 * ## Why the heavy number is derived rather than chosen again
 *
 * Six files had a cap of their own written beside them — 60 000, 90 000,
 * 120 000, each measured once on an idle laptop and then restated. That is the
 * constant-restated defect: the numbers could not move together, so raising the
 * class budget left them behind, and a machine running five agents made every
 * one of them wrong at once. There is one number for the class now and the
 * files inherit it from `vitest.heavy.config.ts`.
 *
 * Six times the unit budget. The stretch actually measured between an idle
 * machine and a loaded one was about 4x — `an-unattended-turn-cannot-wake-him`
 * takes ~10s alone against a 20s cap — so six leaves real headroom above the
 * worst observed case while still breaking a genuine deadlock in two minutes.
 * `HEAVY_HOOK_TIMEOUT_MS` is larger again because two of these files build the
 * backend in `beforeAll`, and a compile is not a test.
 */
export const UNIT_TIMEOUT_MS = 20_000;
export const HEAVY_TIMEOUT_MS = UNIT_TIMEOUT_MS * 6;
export const HEAVY_HOOK_TIMEOUT_MS = UNIT_TIMEOUT_MS * 15;

/**
 * Coverage thresholds for ONE PASS of a two-pass run: none.
 *
 * Neither half of a split suite can meet a whole-suite floor, so vitest's own
 * threshold check would fail every pass and say nothing true. The floor is
 * constitution rule 1 and it is enforced exactly once, by
 * `scripts/check-coverage.mjs`, on the report `scripts/merge-coverage.mjs`
 * builds from both passes — which is the only number that is about this
 * repository. The real thresholds stay below, where `check-coverage.mjs` reads
 * them, so there is still one place a workspace cannot quietly lower its bar.
 */
export const PER_PASS_COVERAGE_THRESHOLDS = { lines: 0, branches: 0, functions: 0 } as const;

/**
 * The one vitest configuration every workspace merges. Coverage thresholds are
 * constitution rule 1 and are deliberately expressed here rather than per
 * workspace, so no workspace can quietly lower its own bar.
 */
export const sharedTestConfig = {
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // THE SUITE COMPETES WITH ITSELF BEFORE THE MACHINE IS EVEN BUSY.
    //
    // vitest forks one worker per core, and this suite's heaviest files then
    // fork a REAL node each — the fake `claude` binary, the launchd entrypoint,
    // a live service. So the spawn-heavy tests are racing the rest of the suite
    // for the same cores before anything else on the machine is counted.
    //
    // Measured: on a full run the failures moved every time — us5 + Devices,
    // then session twice, then us2 + us5, then fourteen at once, all "Test timed
    // out in 20000ms" — while the same files passed 66/66 in isolation. Capped
    // at three workers the whole suite went green twice consecutively, 3129
    // passed, at the same fleet load.
    //
    // That is why raising the timeout was not enough on its own: the tests were
    // not slow, they were starved. A timeout treats the symptom; this removes
    // the contention.
    //
    // `maxWorkers` alone throws "minThreads and maxThreads must not conflict",
    // so both are set.
    minWorkers: 1,
    // THREE WAS MEASURED ON A 20-CORE DEV MACHINE AND CI HAS TWO. `syl-g4u`.
    //
    // The cap fixed the pathological local case and CI went on failing on a
    // different test every run — service-lifecycle's SIGKILL, then us2's
    // resume, then verify-script — each passing in isolation. The number was
    // right for where it was measured and was never true anywhere else:
    // `ubuntu-latest` is a 2-4 vCPU runner, so three workers is oversubscribed
    // BEFORE the heavy files fork a real node each on top.
    //
    // Same shape as every other defect this week: a measurement taken in one
    // context, hard-coded, and applied in another where it means something
    // different. The fix is to state the INTENT — leave the machine a core to
    // breathe with, and never take more than three — and let the number follow
    // from the machine it is actually running on.
    maxWorkers: Math.max(1, Math.min(3, cpus().length - 1)),
    /**
     * The spawn-heavy files run one at a time WITHIN THIS CONFIG. `syl-6yl`.
     *
     * This is what a FOCUSED run gets — `npm test -w backend`, or the macOS-only
     * files `ios.yml` runs by name — where every test file is in one process and
     * the pools are all there is to separate them with.
     *
     * **It is not isolation, and it was read as isolation for two days.** Vitest
     * dispatches its pools with `Promise.all`: the forks pool and the threads
     * pool start at the same instant and run side by side to the end. So
     * `singleFork` stops the heavy files starving EACH OTHER, and does nothing
     * at all about the three worker threads chewing through five thousand unit
     * tests beside them — which is the contention that was actually timing them
     * out. `vitest.heavy.config.ts` and `scripts/run-tests.mjs` are the fix; this
     * is the residual mitigation for the runs that cannot use them.
     *
     * DELIBERATELY NOT A RETRY. Four "flaky" tests in this project turned out to
     * be real races, and the whole value of the cap is that a red run means
     * something. A suite that goes green on the second attempt teaches everyone
     * to press the button twice, and then it is not a gate.
     */
    poolMatchGlobs: [
      ["**/tests/acceptance/**", "forks"],
      ["**/tests/integration/**", "forks"],
    ],
    poolOptions: {
      forks: { singleFork: true },
    },
    // THE GENEROUS BUDGET IS THE DEFAULT, AND THE LIGHT PASS NARROWS IT.
    //
    // Every config that merges this one can include a spawn-heavy file:
    // `backend/vitest.config.ts` runs the whole workspace, and `ios.yml` runs
    // `launchd-entrypoint.test.ts` by name through it. Only
    // `vitest.config.ts` — the light pass, which EXCLUDES those files — knows
    // it has none, so only it may tighten to `UNIT_TIMEOUT_MS`.
    //
    // The safe direction matters more than the tidy one. A config that forgets
    // to say which class it is running gets the cap that lets a real test
    // finish, not the one that kills it.
    testTimeout: HEAVY_TIMEOUT_MS,
    hookTimeout: HEAVY_HOOK_TIMEOUT_MS,
    coverage: {
      provider: "v8",
      // `json-summary` is what `scripts/check-coverage.mjs` reads. Coverage has to
      // be judged SEPARATELY from whether tests passed, because `vitest run
      // --coverage` exits 1 for a failed test and a missed threshold
      // indistinguishably — harmless under "zero failures", useless under
      // "failures == declared".
      //
      // The gate's own coverage run goes through `scripts/merge-coverage.mjs`
      // instead, because the suite runs in two passes and each writes only
      // `json`; these reporters are what a single-config run still produces.
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
