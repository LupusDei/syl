import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildStampPath,
  describeBuild,
  isRunningCommit,
  readBuildInfo,
} from "../../src/ops/build-info.js";

/**
 * Reading the stamp the build wrote.
 *
 * The rule this module exists to enforce is negative and easy to lose: **it
 * never asks git anything.** It reads one file that was written when the
 * artifact was built. A version of this that fell back to `git rev-parse HEAD`
 * would look identical in every test that runs inside a checkout and would
 * report the wrong answer in the exact situation the stamp exists for — a
 * service running old code inside a tree that has moved on.
 */

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "syl-stamp-"));
  directories.push(directory);
  return directory;
}

function stampFile(contents: string): string {
  const path = join(scratch(), "build-info.json");
  writeFileSync(path, contents, "utf8");
  return path;
}

const GOOD = {
  commit: "49ac2dce862dfca27edaeb6c2e69c157ea434eda",
  builtAt: "2026-08-10T00:18:00.000Z",
  dirty: false,
  branch: "main",
};

describe("readBuildInfo", () => {
  it("should read the stamp the build wrote", () => {
    const info = readBuildInfo(stampFile(JSON.stringify(GOOD)));

    expect(info).toEqual(GOOD);
  });

  it("should answer null when there is no stamp, which is what running from source looks like", () => {
    expect(readBuildInfo(join(scratch(), "absent.json"))).toBeNull();
  });

  it("should answer null rather than throwing on a truncated stamp", () => {
    const warnings: string[] = [];

    const info = readBuildInfo(stampFile('{"commit":"abc'), { onWarn: (w) => warnings.push(w) });

    expect(info).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("should reject a stamp missing the fields it is supposed to carry, rather than reporting half of one", () => {
    const warnings: string[] = [];

    const info = readBuildInfo(stampFile('{"commit":"abc"}'), { onWarn: (w) => warnings.push(w) });

    expect(info).toBeNull();
    expect(warnings.join(" ")).toMatch(/builtAt/);
  });

  it("should keep a stamp that names no commit, because 'built outside a checkout' is a real answer", () => {
    const info = readBuildInfo(
      stampFile(JSON.stringify({ commit: null, builtAt: GOOD.builtAt, dirty: false })),
    );

    expect(info).not.toBeNull();
    expect(info?.commit).toBeNull();
  });

  it("should not invent a branch when the stamp omits one", () => {
    const info = readBuildInfo(
      stampFile(JSON.stringify({ commit: GOOD.commit, builtAt: GOOD.builtAt, dirty: true })),
    );

    expect(info?.branch ?? null).toBeNull();
    expect(info?.dirty).toBe(true);
  });
});

describe("buildStampPath", () => {
  it("should sit beside the built entry point, so a restored dist brings its own provenance", () => {
    // The stamp lives INSIDE dist/. That is the property that makes rollback
    // honest: restore the previous dist and /health reports the previous
    // commit, with nothing to keep in sync and nothing to remember to update.
    expect(buildStampPath("/srv/syl/backend/dist")).toBe("/srv/syl/backend/dist/build-info.json");
  });
});

describe("isRunningCommit", () => {
  it("should say yes when the stamp names the commit asked about", () => {
    expect(isRunningCommit(GOOD, GOOD.commit)).toBe(true);
  });

  it("should say no when the stamp names a different commit", () => {
    expect(isRunningCommit(GOOD, "0".repeat(40))).toBe(false);
  });

  it("should say no when there is no stamp at all — unknown is never a match", () => {
    expect(isRunningCommit(null, GOOD.commit)).toBe(false);
  });

  it("should say no when the stamp names no commit", () => {
    expect(isRunningCommit({ ...GOOD, commit: null }, GOOD.commit)).toBe(false);
  });

  it("should accept an abbreviated sha on either side, since that is what a human types", () => {
    expect(isRunningCommit(GOOD, "49ac2dc")).toBe(true);
    expect(isRunningCommit({ ...GOOD, commit: "49ac2dc" }, GOOD.commit)).toBe(true);
  });

  it("should not match on a prefix shorter than seven characters, which is not evidence of anything", () => {
    expect(isRunningCommit(GOOD, "49a")).toBe(false);
  });
});

describe("describeBuild", () => {
  it("should name the commit and the build time in one line", () => {
    expect(describeBuild(GOOD)).toContain("49ac2dc");
    expect(describeBuild(GOOD)).toContain("2026-08-10T00:18:00.000Z");
  });

  it("should say so loudly when the build was made from a dirty tree", () => {
    expect(describeBuild({ ...GOOD, dirty: true })).toMatch(/dirty/i);
  });

  it("should say 'not a build' rather than 'unknown' when running from source", () => {
    expect(describeBuild(null)).toMatch(/source/i);
  });
});
