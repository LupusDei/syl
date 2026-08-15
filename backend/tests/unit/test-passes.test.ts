import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HELPER_DEADLINE_MS } from "../helpers/budget.js";
import {
  HEAVY_HOOK_TIMEOUT_MS,
  HEAVY_TEST_GLOBS,
  HEAVY_TIMEOUT_MS,
  UNIT_TIMEOUT_MS,
} from "../../../vitest.shared.js";

/**
 * The suite runs in two passes, and this is what keeps the seam honest.
 *
 * `scripts/run-tests.mjs` runs the cheap majority first and the spawn-heavy
 * files afterwards, alone. That arrangement has one failure mode worth more
 * than all the others: a file that quietly stops being in either pass, or a
 * heavy file that drifts back into the light one and starts being starved
 * again. The first is caught empirically on every gated run —
 * `check-expected-failures.mjs` enumerates the test files on disk and fails if
 * any of them was run by no pass. The second cannot be caught that way, because
 * a starved test still runs; it just fails at random, months later, in
 * somebody else's subsystem.
 *
 * So this asserts membership and budget directly.
 */

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/**
 * Whether a repo-relative path is matched by one of {@link HEAVY_TEST_GLOBS}.
 *
 * The globs are deliberately simple — a braced workspace list, a fixed
 * directory, then `**` and `*.test.ts` — so this expands the brace and checks
 * the prefix rather than pulling in a matcher. If a glob ever grows a wildcard
 * in the middle, this throws instead of quietly answering "no": a matcher that
 * silently stops understanding its input is how the partition would rot.
 */
function matchesAHeavyGlob(relativePath: string): boolean {
  return HEAVY_TEST_GLOBS.some((glob) => {
    const [prefix, rest] = glob.split("/tests/");
    if (prefix === undefined || rest === undefined) throw new Error(`unparseable glob: ${glob}`);
    if (rest !== `acceptance/**/*.test.ts` && rest !== `integration/**/*.test.ts`) {
      throw new Error(
        `${glob} is no longer a plain "<workspaces>/tests/<dir>/**/*.test.ts" glob. ` +
          `Teach this test the new shape rather than letting it answer no.`,
      );
    }
    const workspaces = prefix.replace(/^\{|\}$/g, "").split(",");
    const directory = rest.split("/")[0];
    return (
      workspaces.some((workspace) => relativePath.startsWith(`${workspace}/tests/${String(directory)}/`)) &&
      relativePath.endsWith(".test.ts")
    );
  });
}

/** Every `*.test.ts` under a workspace's `tests/`, repo-relative, forward slashes. */
function testFiles(): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.ts")) found.push(relative(repoRoot, full).split(sep).join("/"));
    }
  };
  walk(join(repoRoot, "backend", "tests"));
  return found;
}

/**
 * The files the flakiness was measured on, by name.
 *
 * Named here and nowhere else in the configuration: the RULE is a directory,
 * because a list of six rots the moment a seventh heavy file is written. This
 * is the other half of that trade — the evidence that the rule covers the cases
 * it was derived from, so moving one of them into `tests/unit/` fails here
 * rather than in a timeout three weeks later. `syl-g4u`, `syl-6yl`.
 */
const MEASURED_FLAKY = [
  "backend/tests/acceptance/an-unattended-turn-cannot-wake-him.test.ts",
  "backend/tests/acceptance/urgency-is-evidence.test.ts",
  "backend/tests/acceptance/us6-she-can-act.test.ts",
  "backend/tests/integration/launchd-entrypoint.test.ts",
  "backend/tests/integration/service-lifecycle.test.ts",
  "backend/tests/integration/verify-script.test.ts",
] as const;

describe("the two test passes", () => {
  it("should put every measured-flaky file in the heavy pass, by name", () => {
    const files = testFiles();
    for (const file of MEASURED_FLAKY) {
      expect(files, `${file} has been renamed or removed`).toContain(file);
      expect(matchesAHeavyGlob(file), `${file} would run in the light pass and be starved again`).toBe(
        true,
      );
    }
  });

  it("should claim every acceptance and integration file, and no unit file", () => {
    for (const file of testFiles()) {
      const spawns = file.includes("/tests/acceptance/") || file.includes("/tests/integration/");
      expect(matchesAHeavyGlob(file), `${file}: heavy glob and directory disagree`).toBe(spawns);
    }
  });

  it("should anchor its globs at the workspaces, so an agent worktree cannot be swept in", () => {
    // This repository keeps full copies of itself under `.claude/worktrees/`.
    // An unanchored glob matches those, and the heavy pass would run another
    // agent's half-finished tests as if they were ours — the same trap that
    // once made coverage read 3.6%.
    for (const glob of HEAVY_TEST_GLOBS) {
      expect(glob.startsWith("**"), `${glob} is unanchored`).toBe(false);
      expect(glob.startsWith("{backend,frontend,shared}/tests/")).toBe(true);
    }
  });

  it("should give the spawning class a budget that is generous, derived, and beaten by its helpers", () => {
    // Derived from one constant rather than chosen again: the six files used to
    // carry 60 000, 90 000 and 120 000 beside them, none of which could move
    // when the class budget did.
    expect(HEAVY_TIMEOUT_MS).toBeGreaterThan(UNIT_TIMEOUT_MS);
    expect(HEAVY_HOOK_TIMEOUT_MS).toBeGreaterThan(HEAVY_TIMEOUT_MS);
    expect(HEAVY_TIMEOUT_MS % UNIT_TIMEOUT_MS).toBe(0);

    // A helper has to give up FIRST, or vitest's "Test timed out" wins the
    // report and the useful message — which service, which port, what stderr —
    // is never printed.
    expect(HELPER_DEADLINE_MS).toBeLessThan(HEAVY_TIMEOUT_MS);
  });
});
