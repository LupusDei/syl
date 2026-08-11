import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  decideDeploy,
  judgeChecks,
  parseCheckRuns,
  parseRepoSlug,
  shouldClearProbation,
  type ChecksVerdict,
  type GateInputs,
} from "../../src/ops/deploy-gate.js";

/**
 * The gate. This is the whole design of the auto-deploy, and the reason it is
 * allowed to exist at all.
 *
 * "If `origin/main` moved, build and restart" would let a 2am commit with red
 * CI take the Commander's assistant down while he sleeps, and the first symptom
 * would be a 07:00 agenda that never arrives. So the question is never "has
 * HEAD moved" — it is "have this commit's checks PASSED", asked of GitHub, and
 * every answer other than an unambiguous yes means stay where we are.
 *
 * Treat this as a safety boundary rather than a convenience. The Commander's
 * stated direction is that Syl may eventually update herself; the thing that
 * makes that survivable is that **everything which deploys goes through this
 * function, and no option turns the CI requirement off**. There is a test below
 * that asserts exactly that, over every combination of the options that exist.
 *
 * The fixtures are real captured `gh api` output, never hand-written — including
 * one commit whose `verify` genuinely failed, one with no check runs at all, and
 * two check runs genuinely in progress. Our idea of the wire format is what
 * drifts; the API's own bytes are what catch it.
 */

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures", "gh");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

const GREEN_SHA = "825fb604b8c1f1172a1cbd3f74f85f3409331cf3";
const RED_SHA = "49ac2dce862dfca27edaeb6c2e69c157ea434eda";

describe("parseCheckRuns — against real gh output", () => {
  it("should read the two check runs GitHub reported for a green commit", () => {
    const runs = parseCheckRuns(fixture("check-runs-green"));

    expect(runs.map((run) => run.name).sort()).toEqual([
      "SylKit against the real service",
      "verify",
    ]);
    expect(runs.every((run) => run.status === "completed")).toBe(true);
    expect(runs.every((run) => run.conclusion === "success")).toBe(true);
  });

  it("should read a commit whose verify genuinely failed", () => {
    const runs = parseCheckRuns(fixture("check-runs-red"));

    const verify = runs.find((run) => run.name === "verify");
    expect(verify?.conclusion).toBe("failure");
  });

  it("should read a commit that has no check runs at all", () => {
    expect(parseCheckRuns(fixture("check-runs-none"))).toEqual([]);
  });

  it("should read runs that are still in progress, with no conclusion yet", () => {
    const runs = parseCheckRuns(fixture("check-runs-pending"));

    expect(runs).not.toHaveLength(0);
    expect(runs.every((run) => run.status === "in_progress")).toBe(true);
    expect(runs.every((run) => run.conclusion === null)).toBe(true);
  });

  it("should refuse a body that is not a check-runs response rather than reading it as empty", () => {
    // An empty list and an unparseable answer must never be the same thing. One
    // means "nothing ran"; the other means "we do not know", and only one of
    // those is safe to reason about.
    expect(() => parseCheckRuns({ message: "Not Found" })).toThrow(/check_runs/);
    expect(() => parseCheckRuns("nonsense")).toThrow();
  });
});

describe("judgeChecks", () => {
  const required = ["verify"];

  it("should call a real green commit green", () => {
    expect(judgeChecks(parseCheckRuns(fixture("check-runs-green")), { required }).state).toBe("green");
  });

  it("should call a real red commit failed, and name what failed", () => {
    const verdict = judgeChecks(parseCheckRuns(fixture("check-runs-red")), { required });

    expect(verdict.state).toBe("failed");
    if (verdict.state === "failed") expect(verdict.detail).toContain("verify");
  });

  it("should call a commit with no checks 'none', never green", () => {
    // Absence of evidence is not evidence of passing. A commit that no workflow
    // ever ran against has proved nothing, and merge commits produce exactly
    // this — the `check-runs-none` fixture is one.
    expect(judgeChecks(parseCheckRuns(fixture("check-runs-none")), { required }).state).toBe("none");
  });

  it("should call runs that are still going 'pending'", () => {
    expect(judgeChecks(parseCheckRuns(fixture("check-runs-pending")), { required }).state).toBe("pending");
  });

  it("should treat a failure as decisive even while other checks are still running", () => {
    // A red check does not go green by waiting.
    const verdict = judgeChecks(
      [
        { name: "verify", status: "completed", conclusion: "failure", id: 2 },
        { name: "SylKit", status: "in_progress", conclusion: null, id: 3 },
      ],
      { required },
    );

    expect(verdict.state).toBe("failed");
  });

  it("should accept neutral and skipped conclusions, which are how path filters report", () => {
    // The iOS workflow is path-filtered: a backend-only commit legitimately
    // skips it, and treating that as a failure would deadlock every deploy.
    const verdict = judgeChecks(
      [
        { name: "verify", status: "completed", conclusion: "success", id: 1 },
        { name: "SylKit and the app target", status: "completed", conclusion: "skipped", id: 2 },
        { name: "Has the version changed?", status: "completed", conclusion: "neutral", id: 3 },
      ],
      { required },
    );

    expect(verdict.state).toBe("green");
  });

  it.each(["failure", "timed_out", "cancelled", "action_required", "stale", "startup_failure"])(
    "should treat %s as a failure",
    (conclusion) => {
      const verdict = judgeChecks([{ name: "verify", status: "completed", conclusion, id: 1 }], { required });

      expect(verdict.state).toBe("failed");
    },
  );

  it("should treat a conclusion it has never heard of as a failure, not as a pass", () => {
    // Fail closed. A new GitHub conclusion string must not silently become a
    // green light for restarting the Commander's assistant.
    const verdict = judgeChecks([{ name: "verify", status: "completed", conclusion: "quantum", id: 1 }], {
      required,
    });

    expect(verdict.state).toBe("failed");
  });

  it("should refuse a commit where the required check never ran, even if everything else passed", () => {
    const verdict = judgeChecks(
      [{ name: "SylKit and the app target", status: "completed", conclusion: "success", id: 1 }],
      { required },
    );

    expect(verdict.state).toBe("missing");
    if (verdict.state === "missing") expect(verdict.detail).toContain("verify");
  });

  it("should say pending rather than missing while the required check may still be created", () => {
    // Seconds after a push, `verify` may not exist yet while another workflow's
    // runs already do. "Missing" would be a wrong and alarming word for that.
    const verdict = judgeChecks(
      [{ name: "SylKit", status: "queued", conclusion: null, id: 1 }],
      { required },
    );

    expect(verdict.state).toBe("pending");
  });

  it("should let a re-run supersede the run it replaced, rather than remembering the old failure forever", () => {
    const verdict = judgeChecks(
      [
        { name: "verify", status: "completed", conclusion: "failure", id: 100 },
        { name: "verify", status: "completed", conclusion: "success", id: 200 },
      ],
      { required },
    );

    expect(verdict.state).toBe("green");
  });

  it("should not let an older success hide a newer failure", () => {
    const verdict = judgeChecks(
      [
        { name: "verify", status: "completed", conclusion: "success", id: 100 },
        { name: "verify", status: "completed", conclusion: "failure", id: 200 },
      ],
      { required },
    );

    expect(verdict.state).toBe("failed");
  });
});

describe("parseRepoSlug", () => {
  it("should read the slug out of the SSH remote this checkout actually uses", () => {
    expect(parseRepoSlug("git@github.com:LupusDei/syl.git")).toBe("LupusDei/syl");
  });

  it("should read the slug out of an HTTPS remote", () => {
    expect(parseRepoSlug("https://github.com/LupusDei/syl.git")).toBe("LupusDei/syl");
  });

  it("should cope with a remote that has no .git suffix and a trailing newline", () => {
    expect(parseRepoSlug("git@github.com:LupusDei/syl\n")).toBe("LupusDei/syl");
  });

  it("should answer null rather than guessing at something it does not recognise", () => {
    // A wrong slug produces a 404, which is indistinguishable from "this commit
    // has no checks" — the one confusion that must never happen here.
    expect(parseRepoSlug("/Users/Reason/code/ai/syl")).toBeNull();
    expect(parseRepoSlug("")).toBeNull();
  });
});

const GREEN: ChecksVerdict = { state: "green", detail: "2 checks passed" };

function inputs(overrides: Partial<GateInputs> = {}): GateInputs {
  return {
    target: GREEN_SHA,
    running: RED_SHA,
    healthy: true,
    turnsInFlight: 0,
    checks: GREEN,
    now: new Date("2026-08-10T18:00:00.000Z"),
    failedCommits: [],
    probation: null,
    ...overrides,
  };
}

describe("decideDeploy — the CI gate", () => {
  it("should deploy a commit whose checks have passed", () => {
    const decision = decideDeploy(inputs(), {});

    expect(decision.action).toBe("deploy");
    if (decision.action === "deploy") expect(decision.commit).toBe(GREEN_SHA);
  });

  it("should NOT deploy merely because origin/main moved", () => {
    // The sentence this whole module exists to make false.
    const decision = decideDeploy(inputs({ checks: { state: "failed", detail: "verify failed" } }), {});

    expect(decision.action).toBe("wait");
    if (decision.action === "wait") expect(decision.reason).toBe("checks-failed");
  });

  it("should wait while the checks are still running", () => {
    const decision = decideDeploy(inputs({ checks: { state: "pending", detail: "1 in progress" } }), {});

    if (decision.action !== "wait") throw new Error(`expected wait, got ${decision.action}`);
    expect(decision.reason).toBe("checks-pending");
  });

  it("should refuse a commit that no workflow ever ran against", () => {
    const decision = decideDeploy(inputs({ checks: { state: "none", detail: "no check runs" } }), {});

    if (decision.action !== "wait") throw new Error(`expected wait, got ${decision.action}`);
    expect(decision.reason).toBe("checks-none");
  });

  it("should stay on the old build when GitHub cannot be reached at all", () => {
    // Fail CLOSED. "We could not ask" is not "the answer was yes", and the cost
    // of being wrong in the two directions is not remotely symmetrical: waiting
    // costs a few hours of staleness, guessing costs the 07:00 agenda.
    const decision = decideDeploy(
      inputs({ checks: { state: "unknown", detail: "gh: could not resolve host" } }),
      {},
    );

    if (decision.action !== "wait") throw new Error(`expected wait, got ${decision.action}`);
    expect(decision.reason).toBe("checks-unknown");
    expect(decision.detail).toContain("could not resolve host");
  });

  it("should have NO option that lets an ungreen commit through — this is the safety boundary", () => {
    // Every combination of every option that exists, against every verdict that
    // is not green. If a bypass is ever added, this test is where it shows up.
    const ungreen: ChecksVerdict[] = [
      { state: "failed", detail: "verify failed" },
      { state: "pending", detail: "still running" },
      { state: "none", detail: "no check runs" },
      { state: "missing", detail: "verify never ran" },
      { state: "unknown", detail: "gh exited 1" },
    ];
    const options = [
      {},
      { respectQuietHours: true },
      { respectQuietHours: false },
      { allowPreviouslyFailed: true },
      { respectQuietHours: false, allowPreviouslyFailed: true },
    ];

    for (const checks of ungreen) {
      for (const option of options) {
        const decision = decideDeploy(inputs({ checks }), option);
        expect(decision.action, `${checks.state} with ${JSON.stringify(option)}`).not.toBe("deploy");
      }
    }
  });
});

describe("decideDeploy — everything else that must be true first", () => {
  it("should do nothing when the running build is already the target", () => {
    const decision = decideDeploy(inputs({ running: GREEN_SHA }), {});

    if (decision.action !== "wait") throw new Error(`expected wait, got ${decision.action}`);
    expect(decision.reason).toBe("up-to-date");
  });

  it("should still deploy when she is on the target commit but is not healthy", () => {
    // A deploy is also the repair path: if she is down on this commit, doing
    // nothing leaves her down.
    const decision = decideDeploy(inputs({ running: GREEN_SHA, healthy: false }), {});

    expect(decision.action).toBe("deploy");
  });

  it("should not restart her mid-sentence", () => {
    const decision = decideDeploy(inputs({ turnsInFlight: 1 }), {});

    if (decision.action !== "wait") throw new Error(`expected wait, got ${decision.action}`);
    expect(decision.reason).toBe("turn-in-flight");
  });

  it("should not deploy unattended inside quiet hours", () => {
    // 03:00 in the Commander's zone. The failure this guards against is
    // precisely "something restarted her while he was asleep", and a deploy
    // that waits until morning costs nothing.
    const decision = decideDeploy(inputs({ now: new Date("2026-08-10T08:00:00.000Z") }), {
      respectQuietHours: true,
      quietHours: { quiet: { start: "22:00", end: "08:00" }, tz: "America/Chicago" },
    });

    if (decision.action !== "wait") throw new Error(`expected wait, got ${decision.action}`);
    expect(decision.reason).toBe("quiet-hours");
  });

  it("should deploy outside quiet hours", () => {
    // 13:00 in the Commander's zone.
    const decision = decideDeploy(inputs({ now: new Date("2026-08-10T18:00:00.000Z") }), {
      respectQuietHours: true,
      quietHours: { quiet: { start: "22:00", end: "08:00" }, tz: "America/Chicago" },
    });

    expect(decision.action).toBe("deploy");
  });

  it("should let a human deploy inside quiet hours, since a human is present", () => {
    const decision = decideDeploy(inputs({ now: new Date("2026-08-10T08:00:00.000Z") }), {
      respectQuietHours: false,
      quietHours: { quiet: { start: "22:00", end: "08:00" }, tz: "America/Chicago" },
    });

    expect(decision.action).toBe("deploy");
  });

  it("should never retry a commit that already failed to deploy, unattended", () => {
    // Without this the job re-deploys the same bad commit every ten minutes all
    // night, restarting her each time. A rollback that keeps being undone is
    // not a rollback.
    const decision = decideDeploy(inputs({ failedCommits: [GREEN_SHA] }), {});

    if (decision.action !== "wait") throw new Error(`expected wait, got ${decision.action}`);
    expect(decision.reason).toBe("previously-failed");
  });

  it("should let a human retry a commit that failed before", () => {
    const decision = decideDeploy(inputs({ failedCommits: [GREEN_SHA] }), { allowPreviouslyFailed: true });

    expect(decision.action).toBe("deploy");
  });

  it("should wait when there is no target commit to talk about", () => {
    const decision = decideDeploy(inputs({ target: null }), {});

    if (decision.action !== "wait") throw new Error(`expected wait, got ${decision.action}`);
    expect(decision.reason).toBe("unknown-target");
  });
});

describe("decideDeploy — the build that dies after the deploy has gone home", () => {
  const probation = {
    commit: GREEN_SHA,
    previousCommit: RED_SHA,
    expiresAt: "2026-08-10T19:00:00.000Z",
  };

  it("should roll back a freshly deployed build that has stopped answering", () => {
    // The deploy's soak window catches a build that dies in the first ninety
    // seconds. This catches the one that dies five minutes later, once the
    // deploy has exited and KeepAlive is restarting it into the same crash.
    const decision = decideDeploy(inputs({ probation, healthy: false, running: GREEN_SHA }), {});

    expect(decision.action).toBe("rollback");
    if (decision.action === "rollback") expect(decision.to).toBe(RED_SHA);
  });

  it("should roll back even inside quiet hours — she is down, and that is the emergency", () => {
    const decision = decideDeploy(
      inputs({ probation, healthy: false, running: GREEN_SHA, now: new Date("2026-08-10T08:00:00.000Z") }),
      {
        respectQuietHours: true,
        quietHours: { quiet: { start: "22:00", end: "08:00" }, tz: "America/Chicago" },
      },
    );

    expect(decision.action).toBe("rollback");
  });

  it("should not roll back a build that is on probation and perfectly healthy", () => {
    const decision = decideDeploy(inputs({ probation, healthy: true, running: GREEN_SHA }), {});

    expect(decision.action).not.toBe("rollback");
  });

  it("should not roll back once probation has expired, however unhealthy she is", () => {
    // After the window, an unhealthy service is the watchdog's problem, not a
    // deploy's. Rolling back an hour-old build because of an unrelated outage
    // would silently undo work nobody asked to undo.
    const decision = decideDeploy(
      inputs({
        probation,
        healthy: false,
        running: GREEN_SHA,
        now: new Date("2026-08-10T20:00:00.000Z"),
      }),
      {},
    );

    expect(decision.action).not.toBe("rollback");
  });

  it("should not roll back when the probation is for a build that is not the one running", () => {
    // Somebody deployed by hand in between. Undoing to `previousCommit` would
    // be undoing a change nobody here made.
    const decision = decideDeploy(inputs({ probation, healthy: false, running: "0".repeat(40) }), {});

    expect(decision.action).not.toBe("rollback");
  });
});

describe("shouldClearProbation", () => {
  const probation = {
    commit: GREEN_SHA,
    previousCommit: RED_SHA,
    expiresAt: "2026-08-10T19:00:00.000Z",
  };

  it("should clear a probation that has run its course with the build still healthy", () => {
    expect(
      shouldClearProbation(probation, {
        healthy: true,
        running: GREEN_SHA,
        now: new Date("2026-08-10T19:00:01.000Z"),
      }),
    ).toBe(true);
  });

  it("should keep watching while the window is still open", () => {
    expect(
      shouldClearProbation(probation, {
        healthy: true,
        running: GREEN_SHA,
        now: new Date("2026-08-10T18:30:00.000Z"),
      }),
    ).toBe(false);
  });

  it("should clear a probation for a build that is no longer running, since it can no longer be undone", () => {
    expect(
      shouldClearProbation(probation, {
        healthy: true,
        running: "0".repeat(40),
        now: new Date("2026-08-10T18:30:00.000Z"),
      }),
    ).toBe(true);
  });

  it("should have nothing to clear when there is no probation", () => {
    expect(shouldClearProbation(null, { healthy: true, running: GREEN_SHA, now: new Date() })).toBe(false);
  });
});
