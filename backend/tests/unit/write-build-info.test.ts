import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { BuildInfo } from "@syl/shared";

/**
 * The build stamp, driven as the real script against real git repositories.
 *
 * This is the step that makes a stale build visible, so the thing worth testing
 * is not "does it produce JSON" but **which commit it names**. Every case below
 * builds an actual repository with `git`, moves it to a known state, and checks
 * the stamp against the SHA git itself reports — because the failure this
 * guards against is precisely a stamp that is confidently wrong.
 *
 * Driven as a subprocess rather than imported for the same reason
 * `copy-assets.test.ts` is: it is a build step, and its exit code is part of
 * what it does.
 */

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "write-build-info.mjs",
);

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `spawnSync` rather than `execFileSync`, because the interesting warning —
 * "this build names no commit" — goes to stderr on a SUCCESSFUL run, and
 * `execFileSync` hands back stderr only when the process failed.
 */
function run(args: readonly string[]): RunResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();
}

/** A real one-commit repository, on a branch with a known name. */
function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "syl-build-info-"));
  directories.push(directory);
  git(directory, "init", "--initial-branch=main", "--quiet");
  writeFileSync(join(directory, "a.txt"), "one\n");
  git(directory, "add", "a.txt");
  git(directory, "commit", "--quiet", "-m", "one");
  return directory;
}

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "syl-build-out-"));
  directories.push(directory);
  return directory;
}

function stamp(file: string): BuildInfo {
  return JSON.parse(readFileSync(file, "utf8")) as BuildInfo;
}

describe("scripts/write-build-info.mjs", () => {
  it("should stamp the commit the build was made from, in full", () => {
    const repo = repository();
    const out = join(scratch(), "build-info.json");

    const result = run(["--repo", repo, "--out", out]);

    expect(result.status).toBe(0);
    expect(stamp(out).commit).toBe(git(repo, "rev-parse", "HEAD"));
    expect(stamp(out).commit).toHaveLength(40);
  });

  it("should stamp the branch and a build time that is a real instant", () => {
    const repo = repository();
    const out = join(scratch(), "build-info.json");
    const before = Date.now();

    run(["--repo", repo, "--out", out]);

    const info = stamp(out);
    expect(info.branch).toBe("main");
    expect(Date.parse(info.builtAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(info.builtAt).toMatch(/Z$/);
  });

  it("should report a clean tree as not dirty", () => {
    const repo = repository();
    const out = join(scratch(), "build-info.json");

    run(["--repo", repo, "--out", out]);

    expect(stamp(out).dirty).toBe(false);
  });

  it("should report an uncommitted change as dirty, because that build is not reproducible from the commit", () => {
    const repo = repository();
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const out = join(scratch(), "build-info.json");

    run(["--repo", repo, "--out", out]);

    const info = stamp(out);
    expect(info.dirty).toBe(true);
    // The commit is still named. "dirty" qualifies it; it does not replace it.
    expect(info.commit).toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("should report an untracked file as dirty as well", () => {
    const repo = repository();
    writeFileSync(join(repo, "b.txt"), "new\n");
    const out = join(scratch(), "build-info.json");

    run(["--repo", repo, "--out", out]);

    expect(stamp(out).dirty).toBe(true);
  });

  it("should still write a stamp outside a git checkout, naming no commit rather than guessing one", () => {
    const notARepo = scratch();
    const out = join(scratch(), "build-info.json");

    const result = run(["--repo", notARepo, "--out", out]);

    expect(result.status).toBe(0);
    const info = stamp(out);
    expect(info.commit).toBeNull();
    expect(typeof info.builtAt).toBe("string");
    // Loud, because a build nobody can trace to a commit is one nobody can
    // reason about — but not fatal, because a tarball build is a real thing.
    expect(`${result.stdout}${result.stderr}`).toMatch(/no commit/i);
  });

  it("should create the output directory rather than failing when dist does not exist yet", () => {
    const repo = repository();
    const out = join(scratch(), "nested", "deeper", "build-info.json");

    const result = run(["--repo", repo, "--out", out]);

    expect(result.status).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it("should print the commit it stamped, so the build log carries the provenance too", () => {
    const repo = repository();
    const out = join(scratch(), "build-info.json");

    const result = run(["--repo", repo, "--out", out]);

    expect(result.stdout).toContain(git(repo, "rev-parse", "--short", "HEAD"));
  });

  it("should refuse an unknown argument rather than silently stamping the default location", () => {
    const out = join(scratch(), "build-info.json");

    const result = run(["--nonsense", out]);

    expect(result.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it("should overwrite a stamp left by a previous build", () => {
    const repo = repository();
    const outDir = scratch();
    const out = join(outDir, "build-info.json");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(out, JSON.stringify({ commit: "0".repeat(40), builtAt: "1970-01-01T00:00:00.000Z", dirty: false }));

    run(["--repo", repo, "--out", out]);

    expect(stamp(out).commit).toBe(git(repo, "rev-parse", "HEAD"));
  });
});
