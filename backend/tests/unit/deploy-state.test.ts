import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultDeployStatePath,
  EMPTY_DEPLOY_STATE,
  MAX_REMEMBERED_FAILURES,
  readDeployState,
  rememberFailure,
  writeDeployState,
  type DeployState,
} from "../../src/ops/deploy-state.js";

/**
 * The memo the update job leaves itself.
 *
 * Everything here is about a job that runs forever with nobody watching. The
 * failure list is what stops a bad commit being redeployed every ten minutes
 * all night, and the probation marker is the rollback plan for a build that
 * dies after the deploy process has already exited — so "can this file be read
 * back" is not a formality.
 */

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "syl-deploy-state-"));
  directories.push(directory);
  return directory;
}

const PROBATION = {
  commit: "2".repeat(40),
  previousCommit: "1".repeat(40),
  expiresAt: "2026-08-10T19:00:00.000Z",
};

describe("deploy state — round trip", () => {
  it("should read back everything it wrote", () => {
    const path = join(scratch(), "deploy-state.json");
    const state: DeployState = {
      failedCommits: ["3".repeat(40)],
      probation: PROBATION,
      lastRun: { at: "2026-08-10T18:00:00.000Z", action: "deployed", detail: "ok" },
    };

    writeDeployState(path, state);

    expect(readDeployState(path)).toEqual(state);
  });

  it("should create the directory it is given rather than failing on a missing ~/.syl", () => {
    const path = join(scratch(), "nested", ".syl", "deploy-state.json");

    writeDeployState(path, EMPTY_DEPLOY_STATE);

    expect(existsSync(path)).toBe(true);
  });

  it("should leave no temporary file behind, since the write is a rename", () => {
    const directory = scratch();
    const path = join(directory, "deploy-state.json");

    writeDeployState(path, EMPTY_DEPLOY_STATE);

    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("should write JSON a human can read at 3am", () => {
    const path = join(scratch(), "deploy-state.json");

    writeDeployState(path, { ...EMPTY_DEPLOY_STATE, probation: PROBATION });

    expect(readFileSync(path, "utf8")).toContain("\n  \"probation\"");
  });
});

describe("readDeployState — when the file is not there or not right", () => {
  it("should start from empty on the first ever run", () => {
    expect(readDeployState(join(scratch(), "absent.json"))).toEqual(EMPTY_DEPLOY_STATE);
  });

  it("should start from empty, and say so, when the file is damaged", () => {
    // Refusing to run because the memo is unreadable would turn a cosmetic
    // problem into "Syl is never updated again". Empty is the cautious answer
    // everywhere it is used: no probation to act on, and the CI gate still
    // decides everything else.
    const path = join(scratch(), "deploy-state.json");
    writeFileSync(path, "{ not json");
    const warnings: string[] = [];

    expect(readDeployState(path, (w) => warnings.push(w))).toEqual(EMPTY_DEPLOY_STATE);
    expect(warnings).toHaveLength(1);
  });

  it("should drop a probation that is missing the field a rollback needs", () => {
    const path = join(scratch(), "deploy-state.json");
    writeFileSync(path, JSON.stringify({ probation: { commit: "abc" } }));

    expect(readDeployState(path).probation).toBeNull();
  });

  it("should ignore non-string entries in the failure list rather than carrying them", () => {
    const path = join(scratch(), "deploy-state.json");
    writeFileSync(path, JSON.stringify({ failedCommits: ["abc", 7, null] }));

    expect(readDeployState(path).failedCommits).toEqual(["abc"]);
  });
});

describe("rememberFailure", () => {
  it("should put the newest failure first", () => {
    const state = rememberFailure(rememberFailure(EMPTY_DEPLOY_STATE, "a"), "b");

    expect(state.failedCommits).toEqual(["b", "a"]);
  });

  it("should not list the same commit twice", () => {
    const state = rememberFailure(rememberFailure(EMPTY_DEPLOY_STATE, "a"), "a");

    expect(state.failedCommits).toEqual(["a"]);
  });

  it("should stay bounded, because an unattended job writes this file forever", () => {
    let state = EMPTY_DEPLOY_STATE;
    for (let i = 0; i < MAX_REMEMBERED_FAILURES + 5; i += 1) state = rememberFailure(state, `c${String(i)}`);

    expect(state.failedCommits).toHaveLength(MAX_REMEMBERED_FAILURES);
    expect(state.failedCommits[0]).toBe(`c${String(MAX_REMEMBERED_FAILURES + 4)}`);
  });

  it("should leave the probation alone", () => {
    const state = rememberFailure({ ...EMPTY_DEPLOY_STATE, probation: PROBATION }, "a");

    expect(state.probation).toEqual(PROBATION);
  });
});

describe("defaultDeployStatePath", () => {
  it("should sit beside the rest of the operational state, not inside the database", () => {
    // The database is the thing a bad deploy may have broken. A rollback plan
    // stored inside the casualty is not a plan.
    expect(defaultDeployStatePath("/Users/commander")).toBe(
      "/Users/commander/.syl/deploy-state.json",
    );
  });
});
