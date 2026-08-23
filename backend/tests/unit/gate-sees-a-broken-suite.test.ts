import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = join(root, "scripts", "check-expected-failures.mjs");

interface FileResult {
  name: string;
  status: string;
  message?: string;
  assertionResults: { fullName: string; status: string }[];
}

/**
 * A SUITE THAT COULD NOT BUILD MUST NOT READ AS A CLEAN RUN — `syl-rz7g`.
 *
 * Observed on 2026-08-23, in a real `npm run verify`:
 *
 *     Test Files  3 failed | 55 passed (58)
 *           Tests  1 failed | 447 passed | 25 skipped
 *     EXIT=0
 *
 * `service-lifecycle` and `launchd-entrypoint` both call `buildBackendOnce()`,
 * the backend build was momentarily broken, and both files died before
 * producing a single assertion. Vitest reports that as a failed FILE with an
 * empty `assertionResults`, and this gate compares ASSERTIONS — so zero
 * assertions compared clean and the gate passed.
 *
 * It is the day's pattern in its purest form: an absence that means "fine" and
 * an absence that means "never ran" look identical. It is also the most
 * expensive instance, because `ops/deploy.ts` runs this gate with no bypass —
 * a build breakage confined to the files that compile the backend would
 * DEPLOY, and those two files are the ones that test whether she starts at all.
 *
 * A file-level failure can never be "declared", because `expected-failures.json`
 * names TESTS. So it is unconditionally fatal.
 */
describe("the gate and a suite that never ran", () => {
  const scratch: string[] = [];

  afterEach(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    scratch.length = 0;
  });

  /** Every `*.test.ts` the gate will demand to see, as it enumerates them. */
  function filesOnDisk(): string[] {
    const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      workspaces?: string[];
    };
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".test.ts")) out.push(full);
      }
    };
    for (const workspace of rootPkg.workspaces ?? []) walk(join(root, workspace, "tests"));
    return out;
  }

  /** A clean run: every file present and passing, every declared failure failing. */
  function cleanResults(): { testResults: FileResult[] } {
    const manifest = JSON.parse(
      readFileSync(join(root, "tests", "expected-failures.json"), "utf8"),
    ) as { expected: { test: string }[] };

    const testResults: FileResult[] = filesOnDisk().map((name) => ({
      name,
      status: "passed",
      assertionResults: [],
    }));
    // The declared failures must appear as failing somewhere, or the "declared
    // test now passes" and "no longer exists" checks trip instead of the one
    // under test.
    const first = testResults[0];
    if (first) {
      first.assertionResults = manifest.expected.map((entry) => ({
        fullName: entry.test,
        status: "failed",
      }));
    }
    return { testResults };
  }

  function runGate(results: unknown): { readonly code: number; readonly output: string } {
    const dir = mkdtempSync(join(tmpdir(), "syl-gate-"));
    scratch.push(dir);
    const file = join(dir, "results.json");
    writeFileSync(file, JSON.stringify(results));
    // RELATIVE, because the script does `join(root, path)` — an absolute path
    // would be appended to the repo root and read as missing.
    const arg = relative(root, file);
    try {
      const output = execFileSync("node", [script, arg, "--newer-than=0"], {
        encoding: "utf8",
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, output };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        code: failure.status ?? 1,
        output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      };
    }
  }

  it("should pass a run where every file ran and only declared tests failed", () => {
    // The control. Without it the test below could pass for an unrelated reason.
    const { code, output } = runGate(cleanResults());

    expect(output).not.toMatch(/the test gate failed/);
    expect(code).toBe(0);
  });

  it("should FAIL when a file failed without producing a single assertion", () => {
    const results = cleanResults();
    const casualty = results.testResults[0];
    expect(casualty).toBeDefined();
    // Exactly the shape vitest emits for a suite that threw while collecting.
    results.testResults.push({
      name: casualty?.name ?? "",
      status: "failed",
      message: "Error: Command failed: npm run build -w backend",
      assertionResults: [],
    });

    const { code, output } = runGate(results);

    expect(code).toBe(1);
    expect(output).toMatch(/the test gate failed/);
  });

  it("should name the file, since the count alone does not say which suite died", () => {
    const results = cleanResults();
    const casualty = results.testResults[0];
    results.testResults.push({
      name: casualty?.name ?? "",
      status: "failed",
      message: "Error: Transform failed",
      assertionResults: [],
    });

    const { output } = runGate(results);

    expect(output).toContain((casualty?.name ?? "").split("/").pop() ?? "");
  });

  it("should not be silenceable by declaring it, because the manifest names tests", () => {
    // A file has no `fullName`, so there is nothing anyone could add to
    // `expected-failures.json` that would match it. Asserted so nobody "fixes"
    // a broken build by declaring it.
    const results = cleanResults();
    results.testResults.push({
      name: join(root, "backend", "tests", "unit", "not-a-real-file.test.ts"),
      status: "failed",
      message: "Error: Command failed",
      assertionResults: [],
    });

    expect(runGate(results).code).toBe(1);
  });
});
