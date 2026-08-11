import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The asset copy step is driven as a subprocess rather than imported.
 *
 * What is being tested is a *build gate*, and the whole point of a gate is its
 * exit code. Importing the functions would test the copying and skip the one
 * behaviour that actually stops a broken build from shipping.
 */
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "copy-assets.mjs",
);

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(srcDir: string, outDir: string): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT, "--src", srcDir, "--out", outDir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    // Safe assertion: execFileSync throws this shape on a non-zero exit, and
    // every field is re-tested by the callers below.
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

let scratch: string;
let srcDir: string;
let outDir: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "syl-assets-"));
  srcDir = join(scratch, "src");
  outDir = join(scratch, "dist");
  mkdirSync(srcDir, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("copy-assets", () => {
  it("should copy a .sql file into the build output, preserving its directory", () => {
    mkdirSync(join(srcDir, "migrations"));
    writeFileSync(join(srcDir, "migrations", "0001_baseline.sql"), "create table a (x int);");

    const result = run(srcDir, outDir);

    expect(result.status).toBe(0);
    expect(readFileSync(join(outDir, "migrations", "0001_baseline.sql"), "utf8")).toBe(
      "create table a (x int);",
    );
  });

  it("should report what it copied, so a build log shows the migrations arriving", () => {
    mkdirSync(join(srcDir, "migrations"));
    writeFileSync(join(srcDir, "migrations", "0001_baseline.sql"), "select 1;");

    const result = run(srcDir, outDir);

    expect(result.stdout).toContain("migrations/0001_baseline.sql");
    expect(result.stdout).toContain("copied 1 asset");
  });

  it("should remove an asset that is no longer in the source", () => {
    // syl-oqe. A migration renamed in src left its old copy in dist forever,
    // because this step copies and never prunes. The BUILT service then read
    // both and died at startup on "Two migrations claim version 14" — naming a
    // file the source tree no longer contains, so the error points at nothing
    // you can find. Source correct, build broken, message misleading.
    mkdirSync(join(srcDir, "migrations"));
    writeFileSync(join(srcDir, "migrations", "0014_old_name.sql"), "select 1;");
    expect(run(srcDir, outDir).status).toBe(0);
    expect(existsSync(join(outDir, "migrations", "0014_old_name.sql"))).toBe(true);

    rmSync(join(srcDir, "migrations", "0014_old_name.sql"));
    writeFileSync(join(srcDir, "migrations", "0016_new_name.sql"), "select 1;");

    const result = run(srcDir, outDir);

    expect(result.status).toBe(0);
    expect(existsSync(join(outDir, "migrations", "0016_new_name.sql"))).toBe(true);
    expect(existsSync(join(outDir, "migrations", "0014_old_name.sql"))).toBe(false);
  });

  it("should never prune the JavaScript tsc emitted alongside the assets", () => {
    // The dangerous half of pruning. `dist` holds tsc's output, which has no
    // counterpart in `src` by construction — deleting "anything not in src"
    // would empty the build. Only extensions that actually appear among the
    // source assets are eligible, and tsc emits none of them.
    mkdirSync(join(srcDir, "migrations"));
    writeFileSync(join(srcDir, "migrations", "0001_baseline.sql"), "select 1;");
    mkdirSync(join(outDir, "migrations"), { recursive: true });
    writeFileSync(join(outDir, "index.js"), "export const x = 1;");
    writeFileSync(join(outDir, "index.js.map"), "{}");
    writeFileSync(join(outDir, "index.d.ts"), "export declare const x: number;");

    const result = run(srcDir, outDir);

    expect(result.status).toBe(0);
    expect(existsSync(join(outDir, "index.js"))).toBe(true);
    expect(existsSync(join(outDir, "index.js.map"))).toBe(true);
    expect(existsSync(join(outDir, "index.d.ts"))).toBe(true);
  });

  it("should say what it removed, so a build log explains a vanished file", () => {
    mkdirSync(join(srcDir, "migrations"));
    writeFileSync(join(srcDir, "migrations", "0014_old_name.sql"), "select 1;");
    run(srcDir, outDir);
    rmSync(join(srcDir, "migrations", "0014_old_name.sql"));
    writeFileSync(join(srcDir, "migrations", "0016_new_name.sql"), "select 1;");

    const result = run(srcDir, outDir);

    expect(result.stdout).toContain("0014_old_name.sql");
    expect(result.stdout.toLowerCase()).toContain("removed");
  });

  it("should leave TypeScript alone, since tsc already emits it", () => {
    writeFileSync(join(srcDir, "index.ts"), "export const x = 1;");
    writeFileSync(join(srcDir, "notes.sql"), "select 1;");

    run(srcDir, outDir);

    expect(existsSync(join(outDir, "index.ts"))).toBe(false);
    expect(existsSync(join(outDir, "notes.sql"))).toBe(true);
  });

  it("should FAIL THE BUILD when there is nothing to copy", () => {
    // This is the whole reason the script exists. tsc emits JavaScript and
    // copies nothing else, so a source tree with no assets means the .sql
    // migrations will not reach dist/ and the service will come up against an
    // empty database.
    writeFileSync(join(srcDir, "index.ts"), "export const x = 1;");

    const result = run(srcDir, outDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BUILD FAILED");
    expect(result.stderr).toContain("no assets were copied");
  });

  it("should name both directories when it fails, so the fix is obvious", () => {
    const result = run(srcDir, outDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(srcDir);
    expect(result.stderr).toContain(outDir);
  });

  it("should fail rather than report an empty copy when the source directory is missing", () => {
    const result = run(join(scratch, "absent"), outDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not exist");
  });

  it("should reject an unknown argument rather than silently using the defaults", () => {
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [SCRIPT, "--destination", outDir], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      status = failure.status ?? -1;
      stderr = failure.stderr ?? "";
    }

    expect(status).not.toBe(0);
    expect(stderr).toContain("Unknown argument");
  });

  it("should copy the real migrations when run with its own defaults", () => {
    // The defaults are what the build actually uses, and a script that works
    // only when handed explicit paths is a script that fails in the one
    // invocation that matters.
    const stdout = execFileSync(process.execPath, [SCRIPT, "--out", outDir], {
      encoding: "utf8",
    });

    expect(stdout).toContain("migrations/0001_baseline.sql");
    expect(existsSync(join(outDir, "migrations", "0001_baseline.sql"))).toBe(true);
  });
});
