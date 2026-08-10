import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  deploy,
  snapshotFromHealth,
  type DeployEffects,
  type DeployEvent,
  type DeployOutcome,
  type HealthSnapshot,
} from "../../src/ops/deploy.js";

/**
 * The deploy, and — the part that matters — the rollback.
 *
 * Syl is a supervised LaunchAgent that wakes the Commander at 07:00. This code
 * replaces her running process unattended while he sleeps, so **a deploy that
 * leaves her down is worse than no deploy at all**. The rollback path is the
 * one that has to work and the one that is hardest to reach, which is why every
 * decision here lives behind injected seams and none of it touches launchd,
 * git, npm or the network.
 *
 * The fake below is not a pile of stubs; it is a small simulation of the
 * machine. It has a checkout, a build directory, a running process and a clock,
 * and the operations move them the way the real ones do:
 *
 *   - `build()` makes `dist` the commit the checkout is on;
 *   - `restart()` makes the running process whatever `dist` holds, and gives it
 *     a NEW `startedAt` — which is how a crash loop becomes visible;
 *   - `probe()` reports what that running process would report, including the
 *     build stamp that travelled with `dist`.
 *
 * Tests are then written as situations ("the new build crashes thirty seconds
 * after it starts") rather than as call sequences, and they fail when the
 * BEHAVIOUR is wrong rather than when the implementation is rearranged.
 */

const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";

interface MachineOptions {
  /** Commits in ancestry order, oldest first. Everything is a descendant of what precedes it. */
  readonly history?: readonly string[];
  readonly head?: string;
  readonly dist?: string | null;
  readonly running?: string | null;
  readonly branch?: string | null;
  readonly dirty?: boolean;
  readonly migrations?: Readonly<Record<string, readonly string[]>>;
  /** Fail `npm run verify` with this message. */
  readonly verifyFails?: string;
  /** Fail `npm run build` with this message. */
  readonly buildFails?: string;
  /** Fail the restore step itself — the disaster case. */
  readonly restoreFails?: string;
  /** Commits whose process dies this many ms after starting. */
  readonly crashAfterMs?: Readonly<Record<string, number>>;
  /** Commits whose process comes up but reports `down`. */
  readonly reportsDown?: readonly string[];
  /** Commits whose process never becomes reachable at all. */
  readonly neverStarts?: readonly string[];
  /** Turns in flight, consumed one poll at a time. */
  readonly busyForPolls?: number;
}

class Machine {
  head: string;
  dist: string | null;
  running: string | null;
  startedAt: number;
  branch: string | null;
  dirty: boolean;
  savedDist: string | null = null;
  clock = 1_000_000;
  busyPolls: number;
  readonly calls: string[] = [];
  readonly events: DeployEvent[] = [];
  readonly options: MachineOptions;

  constructor(options: MachineOptions = {}) {
    this.options = options;
    this.head = options.head ?? OLD;
    this.dist = options.dist === undefined ? OLD : options.dist;
    this.running = options.running === undefined ? OLD : options.running;
    this.branch = options.branch === undefined ? "main" : options.branch;
    this.dirty = options.dirty ?? false;
    this.busyPolls = options.busyForPolls ?? 0;
    this.startedAt = this.clock - 3_600_000;
  }

  get history(): readonly string[] {
    return this.options.history ?? [OLD, NEW];
  }

  /** Whether the running process is alive at the current instant. */
  private alive(): boolean {
    if (this.running === null) return false;
    if ((this.options.neverStarts ?? []).includes(this.running)) return false;
    const crashAfter = this.options.crashAfterMs?.[this.running];
    if (crashAfter === undefined) return true;
    if (this.clock - this.startedAt < crashAfter) return true;
    // KeepAlive: the process died and launchd started it again, from the same
    // dist, which is what a crash loop actually looks like from outside.
    this.startedAt = this.clock;
    return true;
  }

  probe(): HealthSnapshot {
    const alive = this.alive();
    if (!alive || this.running === null) {
      return { reachable: false, status: null, build: null, startedAt: null, turnsInFlight: null };
    }
    const turns = this.busyPolls > 0 ? 1 : 0;
    if (this.busyPolls > 0) this.busyPolls -= 1;
    return {
      reachable: true,
      status: (this.options.reportsDown ?? []).includes(this.running) ? "down" : "ok",
      build: { commit: this.running, builtAt: "2026-08-10T00:00:00.000Z", dirty: false, branch: "main" },
      startedAt: new Date(this.startedAt).toISOString(),
      turnsInFlight: turns,
    };
  }

  effects(): DeployEffects {
    const machine = this;
    return {
      fetch: async () => {
        machine.calls.push("fetch");
      },
      resolve: async (ref) => (machine.history.includes(ref) ? ref : ref === "HEAD" ? machine.head : null),
      isDirty: async () => machine.dirty,
      currentBranch: async () => machine.branch,
      isAncestor: async (ancestor, descendant) => {
        const a = machine.history.indexOf(ancestor);
        const d = machine.history.indexOf(descendant);
        return a !== -1 && d !== -1 && a <= d;
      },
      checkout: async (commit) => {
        machine.calls.push(`checkout:${commit.slice(0, 4)}`);
        machine.head = commit;
      },
      migrationsBetween: async (from, to) => machine.options.migrations?.[`${from}..${to}`] ?? [],
      verify: async () => {
        machine.calls.push("verify");
        if (machine.options.verifyFails !== undefined) throw new Error(machine.options.verifyFails);
      },
      build: async () => {
        machine.calls.push("build");
        if (machine.options.buildFails !== undefined) {
          // A failed build leaves a half-written dist behind, which is exactly
          // why the previous one has to have been saved first.
          machine.dist = "half-written";
          throw new Error(machine.options.buildFails);
        }
        machine.dist = machine.head;
      },
      saveDist: async () => {
        machine.calls.push("saveDist");
        if (machine.dist === null) return false;
        machine.savedDist = machine.dist;
        return true;
      },
      restoreDist: async () => {
        machine.calls.push("restoreDist");
        if (machine.options.restoreFails !== undefined) throw new Error(machine.options.restoreFails);
        machine.dist = machine.savedDist;
      },
      restart: async () => {
        machine.calls.push("restart");
        machine.running = machine.dist;
        machine.startedAt = machine.clock;
      },
      probe: async () => machine.probe(),
      now: () => machine.clock,
      sleep: async (ms) => {
        machine.clock += ms;
      },
      log: (event) => {
        machine.events.push(event);
      },
    };
  }
}

async function run(machine: Machine, options: Partial<Parameters<typeof deploy>[1]> = {}): Promise<DeployOutcome> {
  return deploy(machine.effects(), { commit: NEW, ...options });
}

describe("snapshotFromHealth", () => {
  /**
   * The contract fixture, not a hand-written body. If `/health` changes shape,
   * the deploy's idea of "is she up" must fail here rather than in the field at
   * 3am, and a body invented in this file could never catch that.
   */
  const REAL = JSON.parse(
    readFileSync(
      join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "shared", "fixtures", "http", "health.ok.json"),
      "utf8",
    ),
  ) as unknown;

  it("should read the real contract fixture, envelope and all", () => {
    const snapshot = snapshotFromHealth(REAL);

    expect(snapshot.reachable).toBe(true);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.build?.commit).toBe("49ac2dce862dfca27edaeb6c2e69c157ea434eda");
    expect(snapshot.turnsInFlight).toBe(0);
    expect(snapshot.startedAt).toBe("2026-08-09T05:12:44.001Z");
  });

  it("should read a service that reports no build stamp as reachable but unidentifiable", () => {
    const degraded = JSON.parse(
      readFileSync(
        join(
          fileURLToPath(new URL(".", import.meta.url)),
          "..", "..", "..", "shared", "fixtures", "http", "health.degraded.json",
        ),
        "utf8",
      ),
    ) as unknown;

    const snapshot = snapshotFromHealth(degraded);

    expect(snapshot.reachable).toBe(true);
    expect(snapshot.build).toBeNull();
  });

  it("should treat an unreadable body as unreachable rather than as a partial answer", () => {
    // Believing a build is up on the strength of a body we could not read is
    // worse than not knowing.
    expect(snapshotFromHealth("<html>502 Bad Gateway</html>").reachable).toBe(false);
    expect(snapshotFromHealth({ success: false, error: { code: "X" } }).reachable).toBe(false);
    expect(snapshotFromHealth(null).reachable).toBe(false);
  });
});

describe("deploy — the happy path", () => {
  it("should end with the new build running and say which commit that is", async () => {
    const machine = new Machine();

    const outcome = await run(machine);

    expect(outcome.kind).toBe("deployed");
    expect(machine.running).toBe(NEW);
    if (outcome.kind === "deployed") expect(outcome.commit).toBe(NEW);
  });

  it("should verify BEFORE it saves or builds, so a broken tree never reaches dist", async () => {
    const machine = new Machine();

    await run(machine);

    expect(machine.calls.indexOf("verify")).toBeLessThan(machine.calls.indexOf("saveDist"));
    expect(machine.calls.indexOf("saveDist")).toBeLessThan(machine.calls.indexOf("build"));
    expect(machine.calls.indexOf("build")).toBeLessThan(machine.calls.indexOf("restart"));
  });

  it("should record the commit it can roll back to", async () => {
    const machine = new Machine();

    const outcome = await run(machine);

    if (outcome.kind !== "deployed") throw new Error(`expected deployed, got ${outcome.kind}`);
    expect(outcome.previousCommit).toBe(OLD);
  });

  it("should report the migrations the new commit brings, because those do not roll back", async () => {
    const machine = new Machine({ migrations: { [`${OLD}..${NEW}`]: ["0011_deploy_state.sql"] } });

    const outcome = await run(machine);

    if (outcome.kind !== "deployed") throw new Error(`expected deployed, got ${outcome.kind}`);
    expect(outcome.migrations).toEqual(["0011_deploy_state.sql"]);
  });

  it("should do nothing at all when the running build is already the target", async () => {
    const machine = new Machine({ head: NEW, dist: NEW, running: NEW });

    const outcome = await run(machine);

    expect(outcome.kind).toBe("up-to-date");
    expect(machine.calls).not.toContain("restart");
    expect(machine.calls).not.toContain("build");
  });

  it("should deploy anyway when HEAD is the target but the RUNNING build is not", async () => {
    // The stale-build case with the checkout already moved: somebody pulled and
    // forgot to build. Every health check passes and she is still old code.
    const machine = new Machine({ head: NEW, dist: OLD, running: OLD });

    const outcome = await run(machine);

    expect(outcome.kind).toBe("deployed");
    expect(machine.running).toBe(NEW);
  });
});

describe("deploy — refusing before anything is touched", () => {
  it("should refuse a dirty working tree rather than committing somebody's work by accident", async () => {
    const machine = new Machine({ dirty: true });

    const outcome = await run(machine);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason).toBe("dirty-tree");
    expect(machine.calls).not.toContain("checkout");
  });

  it("should refuse to deploy from a branch that is not the deploy branch", async () => {
    const machine = new Machine({ branch: "agent/artanis" });

    const outcome = await run(machine);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason).toBe("wrong-branch");
  });

  it("should refuse a detached HEAD, which no rollback can put back sensibly", async () => {
    const machine = new Machine({ branch: null });

    const outcome = await run(machine);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason).toBe("wrong-branch");
  });

  it("should refuse a commit that does not exist rather than resolving it to something else", async () => {
    const machine = new Machine();

    const outcome = await run(machine, { commit: "9".repeat(40) });

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason).toBe("unknown-commit");
  });

  it("should refuse to move the checkout BACKWARDS, which is a rollback wearing a deploy's clothes", async () => {
    const machine = new Machine({ head: NEW, dist: NEW, running: NEW });

    const outcome = await run(machine, { commit: OLD });

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason).toBe("not-fast-forward");
    expect(machine.calls).not.toContain("checkout");
  });

  it("should not restart anything when verify fails", async () => {
    const machine = new Machine({ verifyFails: "3 tests failed" });

    const outcome = await run(machine);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.reason).toBe("verify-failed");
      expect(outcome.detail).toContain("3 tests failed");
    }
    expect(machine.calls).not.toContain("restart");
    expect(machine.running).toBe(OLD);
  });

  it("should put the checkout back where it found it when verify fails", async () => {
    // Otherwise the tree sits on a commit whose tests do not pass, and the next
    // thing to restart her — KeepAlive, a reboot — brings up that code.
    const machine = new Machine({ verifyFails: "3 tests failed" });

    await run(machine);

    expect(machine.head).toBe(OLD);
  });
});

describe("deploy — the build itself failing", () => {
  it("should restore the previous dist, because a half-written one is what KeepAlive would start next", async () => {
    const machine = new Machine({ buildFails: "tsc exited 2" });

    const outcome = await run(machine);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason).toBe("build-failed");
    expect(machine.dist).toBe(OLD);
  });

  it("should not restart her over a failed build, since the process she is running is still fine", async () => {
    const machine = new Machine({ buildFails: "tsc exited 2" });

    await run(machine);

    expect(machine.calls).not.toContain("restart");
    expect(machine.running).toBe(OLD);
  });
});

describe("deploy — the health gate", () => {
  it("should not call a deploy successful merely because SOMETHING answers", async () => {
    // The subtle one. If the new dist fails to load, launchd's KeepAlive can
    // leave the OLD process answering, and "does /health respond" says yes.
    // The gate is "does she answer AS THE NEW COMMIT".
    const machine = new Machine();
    const effects = machine.effects();
    const restart = effects.restart;
    const outcome = await deploy(
      {
        ...effects,
        // The restart does not take: the old process keeps answering.
        restart: async () => {
          await restart();
          machine.running = OLD;
        },
      },
      { commit: NEW },
    );

    expect(outcome.kind).toBe("rolled-back");
  });

  it("should roll back to the previous dist when she never comes up", async () => {
    const machine = new Machine({ neverStarts: [NEW] });

    const outcome = await run(machine);

    expect(outcome.kind).toBe("rolled-back");
    expect(machine.calls).toContain("restoreDist");
    expect(machine.running).toBe(OLD);
  });

  it("should leave her ANSWERING after a rollback, not merely leave the old files in place", async () => {
    const machine = new Machine({ neverStarts: [NEW] });

    await run(machine);

    const after = machine.probe();
    expect(after.reachable).toBe(true);
    expect(after.build?.commit).toBe(OLD);
  });

  it("should put the checkout back to the previous commit as well, so HEAD and the running build agree", async () => {
    const machine = new Machine({ neverStarts: [NEW] });

    await run(machine);

    expect(machine.head).toBe(OLD);
  });

  it("should roll back a build that comes up reporting `down`", async () => {
    const machine = new Machine({ reportsDown: [NEW] });

    const outcome = await run(machine);

    expect(outcome.kind).toBe("rolled-back");
    expect(machine.running).toBe(OLD);
  });

  it("should say why it rolled back, in words", async () => {
    const machine = new Machine({ neverStarts: [NEW] });

    const outcome = await run(machine);

    if (outcome.kind !== "rolled-back") throw new Error(`expected rolled-back, got ${outcome.kind}`);
    expect(outcome.failure).toBe("never-healthy");
    expect(outcome.previousCommit).toBe(OLD);
    expect(outcome.commit).toBe(NEW);
  });

  it("should give up inside the deadline rather than polling forever", async () => {
    const machine = new Machine({ neverStarts: [NEW] });
    const started = machine.clock;

    await run(machine, { healthDeadlineMs: 30_000, pollIntervalMs: 1_000 });

    // The rollback poll spends time too; what matters is that the wait for the
    // new build was bounded by the deadline it was given.
    expect(machine.clock - started).toBeLessThan(120_000);
  });
});

describe("deploy — the build that starts and then dies", () => {
  it("should roll back a build that crashes thirty seconds after it starts", async () => {
    // The failure mode that motivates the soak window. She comes up, answers,
    // the deploy would declare success — and then the process dies and
    // KeepAlive restarts it into the same broken build, forever.
    const machine = new Machine({ crashAfterMs: { [NEW]: 30_000 } });

    const outcome = await run(machine, { settleMs: 90_000, pollIntervalMs: 5_000 });

    expect(outcome.kind).toBe("rolled-back");
    if (outcome.kind === "rolled-back") expect(outcome.failure).toBe("crash-loop");
    expect(machine.running).toBe(OLD);
  });

  it("should notice a crash loop by the process's own start time moving, not by guessing", async () => {
    const machine = new Machine({ crashAfterMs: { [NEW]: 20_000 } });

    await run(machine, { settleMs: 90_000, pollIntervalMs: 5_000 });

    const restarts = machine.events.filter((event) => event.event === "deploy.restarted_itself");
    expect(restarts.length).toBeGreaterThan(0);
  });

  it("should accept a build that is still up at the end of the soak window", async () => {
    const machine = new Machine({ crashAfterMs: { [NEW]: 10_000_000 } });

    const outcome = await run(machine, { settleMs: 60_000, pollIntervalMs: 5_000 });

    expect(outcome.kind).toBe("deployed");
  });
});

describe("deploy — when the rollback itself fails", () => {
  it("should report rollback-failed rather than claiming anything worked", async () => {
    const machine = new Machine({ neverStarts: [NEW], restoreFails: "no saved dist" });

    const outcome = await run(machine);

    expect(outcome.kind).toBe("rollback-failed");
  });

  it("should say exactly what a human has to do, because this is the state nobody is awake for", async () => {
    const machine = new Machine({ neverStarts: [NEW], restoreFails: "no saved dist" });

    const outcome = await run(machine);

    if (outcome.kind !== "rollback-failed") throw new Error(`expected rollback-failed, got ${outcome.kind}`);
    expect(outcome.detail).toContain("no saved dist");
    expect(outcome.previousCommit).toBe(OLD);
  });

  it("should report rollback-failed when the restored build does not come up either", async () => {
    // Both builds broken. Nothing here can fix that, and pretending otherwise
    // is worse than saying so.
    const machine = new Machine({ neverStarts: [NEW, OLD] });

    const outcome = await run(machine);

    expect(outcome.kind).toBe("rollback-failed");
  });

  it("should refuse to deploy at all when there is no previous dist to roll back to", async () => {
    // A first deploy onto a machine with nothing built. There is no way back,
    // so the honest move is to say so rather than to take the risk silently.
    const machine = new Machine({ dist: null, running: null });

    const outcome = await run(machine);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason).toBe("no-rollback-target");
  });

  it("should deploy without a rollback target when explicitly told to, for the first install", async () => {
    const machine = new Machine({ dist: null, running: null });

    const outcome = await run(machine, { allowWithoutRollback: true });

    expect(outcome.kind).toBe("deployed");
  });
});

describe("deploy — not mid-sentence", () => {
  it("should wait for a turn in flight to finish before restarting her", async () => {
    const machine = new Machine({ busyForPolls: 3 });

    const outcome = await run(machine, { idleWaitMs: 60_000, pollIntervalMs: 5_000 });

    expect(outcome.kind).toBe("deployed");
    const waited = machine.events.filter((event) => event.event === "deploy.waiting_for_idle");
    expect(waited.length).toBeGreaterThan(0);
  });

  it("should give the new build back rather than restart her mid-turn when the wait runs out", async () => {
    // The alternative — leaving a new dist in place while the old process runs
    // — is the worst of both: KeepAlive would activate an unverified build at
    // the next crash, and nothing would have said so.
    const machine = new Machine({ busyForPolls: 1000 });

    const outcome = await run(machine, { idleWaitMs: 20_000, pollIntervalMs: 5_000 });

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason).toBe("turn-in-flight");
    expect(machine.dist).toBe(OLD);
    expect(machine.running).toBe(OLD);
  });
});

describe("deploy — the record it leaves", () => {
  it("should log every step, because nobody is watching this run", async () => {
    const machine = new Machine();

    await run(machine);

    const events = machine.events.map((event) => event.event);
    expect(events).toContain("deploy.begin");
    expect(events).toContain("deploy.built");
    expect(events).toContain("deploy.restarted");
    expect(events).toContain("deploy.healthy");
    expect(events).toContain("deploy.done");
  });

  it("should log the rollback as an error, not as an ordinary step", async () => {
    const machine = new Machine({ neverStarts: [NEW] });

    await run(machine);

    const rollback = machine.events.find((event) => event.event === "deploy.rolled_back");
    expect(rollback?.level).toBe("error");
  });

  it("should never throw out of an expected failure — an unattended caller has no catch worth writing", async () => {
    const machine = new Machine({ neverStarts: [NEW], restoreFails: "disk full" });

    await expect(run(machine)).resolves.toBeDefined();
  });

  it("should turn an unexpected effect failure into an outcome rather than a stack trace", async () => {
    const machine = new Machine();
    const effects = machine.effects();

    const outcome = await deploy(
      { ...effects, fetch: async () => { throw new Error("network is down"); } },
      { commit: NEW },
    );

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.reason).toBe("effect-failed");
      expect(outcome.detail).toContain("network is down");
    }
  });
});

/**
 * ACCEPTANCE — declared RED in tests/expected-failures.json under `syl-dep1.7`.
 *
 * A rollback restores the CODE and leaves the SCHEMA forward. The restored
 * build then runs against a database it has never seen. Additive migrations
 * usually survive that; a destructive one does not, and nothing today tells the
 * difference. Correct behaviour is that a rollback restores the schema the
 * restored build expects, which needs either down-migrations or a snapshot of
 * the SQLite file taken before the deploy.
 *
 * This test says what SHOULD happen and stays red until it does. It must not be
 * softened into asserting `schemaRestored === false`, which is what the code
 * does today and would lock the gap in.
 */
describe("deploy — a rollback after a migration", () => {
  it("should restore the schema the restored build expects", async () => {
    const machine = new Machine({
      neverStarts: [NEW],
      migrations: { [`${OLD}..${NEW}`]: ["0011_deploy_state.sql"] },
    });

    const outcome = await run(machine);

    if (outcome.kind !== "rolled-back") throw new Error(`expected rolled-back, got ${outcome.kind}`);
    expect(outcome.migrations).toEqual(["0011_deploy_state.sql"]);
    expect(outcome.schemaRestored).toBe(true);
  });
});
