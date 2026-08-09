import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Delivery, Reminder, Run } from "@syl/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineReminderDeliveryJob } from "../../src/jobs/reminder-delivery-job.js";
import { runTurn } from "../../src/harness/session.js";
import { sylLaunchdJobs } from "../../src/ops/launchd.js";
import { DEFAULT_LEASE_MS, JobRunner, type Timers } from "../../src/services/job-runner.js";
import { makeFakeClaude, type FakeClaude } from "../helpers/fake-claude.js";
import { BACKEND_SRC, sourceFiles } from "../helpers/sql-tables.js";
import { expectData, startLiveService } from "../helpers/live-service.js";

/**
 * **US5 — she survives a restart.**
 *
 * > As the Commander, I want Syl to come back on her own after a crash or
 * > reboot, so that she is dependable rather than attended.
 *
 * Four acceptance criteria, and they divide cleanly. Two are properties of the
 * code and hold: state is durable across a real process-level restart, and a
 * turn that hangs is killed rather than blocking forever. The other two were
 * properties of the *deployment* and did not exist: nothing supervised the
 * service and nothing watched for a wedged one. `syl-007.2.1` landed both, so
 * the cases below assert their presence and — more usefully — that they are
 * genuinely two different mechanisms rather than one with two names.
 *
 * The third criterion — "jobs in flight at shutdown are recovered on start
 * rather than lost or double-run" — was half true, and the missing half was
 * `syl-iwb`: recovery worked, releasing the lease on the way down did not,
 * because nothing ran on the way down. `syl-007.2.3` is the other half:
 * `SIGTERM` is trapped and `JobRunner.drain()` waits for the pass in flight.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FROZEN = Date.UTC(2026, 7, 10, 12, 0, 0, 0);
const inertTimers: Timers = { set: () => 0, clear: () => undefined };

const fakes: FakeClaude[] = [];

afterEach(() => {
  for (const fake of fakes.splice(0)) fake.cleanup();
});

function fake(config: Parameters<typeof makeFakeClaude>[0]): FakeClaude {
  const created = makeFakeClaude(config);
  fakes.push(created);
  return created;
}

/**
 * Every file the repository actually ships.
 *
 * `git ls-files` rather than a directory walk. "What Syl ships" is exactly what
 * git tracks, and a walk has to guess at it: the first version of this skipped
 * `node_modules`, `dist` and friends by name and still descended into
 * `.claude/worktrees/`, where every other agent's checkout lives. That is both
 * slow and wrong — `.gitignore` says worktrees are never tracked, so a file
 * found in one is not a file this repository ships.
 */
function trackedFiles(): readonly string[] {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.trim() !== "");
}

describe("US5 — she survives a restart", () => {
  describe("what the Commander asked for is still there when she comes back", () => {
    it("should reopen the same store and find every reminder and delivery intact", async () => {
      const first = await startLiveService({ clock: () => FROZEN });
      const path = first.databasePath;
      const directory = first.directory;

      const reminder = await expectData<Reminder>(
        await first.api("/reminders", {
          method: "POST",
          body: JSON.stringify({
            text: "Call the pharmacy — the refill lapses today.",
            wallTime: "16:00",
            tz: "America/Chicago",
            date: "2026-08-10",
          }),
        }),
      );
      first.deps.outbox.enqueue({
        channel: "apns",
        messageClass: "reminder_delivery",
        reminderId: reminder.id,
        payload: {
          title: "Syl",
          body: "Call the pharmacy — the refill lapses today.",
          interruptionLevel: "time-sensitive",
        },
        idempotencyKey: `us5-${reminder.id}`,
        scheduledFor: new Date(FROZEN).toISOString(),
      });

      // The machine goes down. Not a graceful stop — the socket closes and the
      // file is all that is left.
      await first.close({ keepDatabase: true });

      const second = await startLiveService({ databasePath: path, clock: () => FROZEN });
      try {
        const reminders = await expectData<{ items: Reminder[] }>(await second.api("/reminders"));
        expect(reminders.items.map((item) => item.id)).toContain(reminder.id);

        const deliveries = await expectData<{ items: Delivery[] }>(
          await second.api("/deliveries"),
        );
        expect(deliveries.items[0]?.idempotencyKey).toBe(`us5-${reminder.id}`);
        // Not delivered, not dropped — waiting. That is what the never-drop
        // guarantee looks like across a reboot.
        expect(deliveries.items[0]?.state).toBe("pending");
      } finally {
        await second.close();
        // The directory, not the file: WAL leaves `-wal` and `-shm` beside it.
        rmSync(directory ?? path, { recursive: true, force: true });
      }
    });

    it("should not need a device to re-pair after a restart", async () => {
      const first = await startLiveService();
      const path = first.databasePath;
      const directory = first.directory;
      const token = first.token;
      await first.close({ keepDatabase: true });

      const second = await startLiveService({ databasePath: path, pair: false });
      try {
        const response = await fetch(`${second.baseUrl}/auth/whoami`, {
          headers: { authorization: `Bearer ${token}` },
        });
        // A restart that invalidated every token would need the Commander at
        // the keyboard, which is exactly what "dependable rather than attended"
        // rules out.
        expect(response.status).toBe(200);
      } finally {
        await second.close();
        // The directory, not the file: WAL leaves `-wal` and `-shm` beside it.
        rmSync(directory ?? path, { recursive: true, force: true });
      }
    });
  });

  describe("jobs in flight at shutdown", () => {
    it("should reclaim a job whose runner died, and record the abandoned run", async () => {
      const syl = await startLiveService({ clock: () => FROZEN });
      try {
        const job = defineReminderDeliveryJob(
          syl.deps.jobs,
          new Date(FROZEN - 1_000).toISOString(),
        );

        // A process leases the job and then dies mid-run: no release, no
        // finish, nothing.
        const leased = syl.deps.jobs.lease(job.id, "the-process-that-died", DEFAULT_LEASE_MS);
        expect(leased).not.toBeNull();
        syl.deps.jobs.startRun(leased ?? job, new Date(FROZEN - 1_000).toISOString(), FROZEN);

        // The new process starts. Recovery is not a separate step: the first
        // tick reclaims before it schedules, so the guarantee holds on every
        // tick rather than only on the first.
        const runner = new JobRunner({
          store: syl.deps.jobs,
          handlers: new Map([
            [
              "reminder_delivery",
              async () => ({
                outcome: "success" as const,
                spoke: false,
                turns: 0,
                costUsd: 0,
                summary: null,
                error: null,
                nextRunAt: new Date(FROZEN + 60_000).toISOString(),
              }),
            ],
          ]),
          clock: () => FROZEN,
          timers: inertTimers,
          owner: "the-process-that-came-back",
        });

        const pass = await runner.start();
        runner.stop();

        expect(pass.reclaimed).toContain(job.id);

        const runs = await expectData<{ items: Run[] }>(
          await syl.api(`/jobs/${encodeURIComponent(job.id)}/runs`),
        );
        const abandoned = runs.items.find((run) => run.outcome === "abandoned");
        // Not lost and not silently retried: the interrupted run is closed off
        // truthfully, with a reason.
        expect(abandoned).toBeDefined();
        expect(abandoned?.error).toContain("stopped before this run finished");
      } finally {
        await syl.close();
      }
    });

    it("should not let a second runner steal a lease that is still live", async () => {
      const syl = await startLiveService({ clock: () => FROZEN });
      try {
        const job = defineReminderDeliveryJob(
          syl.deps.jobs,
          new Date(FROZEN - 1_000).toISOString(),
        );
        syl.deps.jobs.lease(job.id, "the-runner-that-is-working", DEFAULT_LEASE_MS);

        // Nothing double-runs while the lease is good.
        expect(syl.deps.jobs.lease(job.id, "an-impatient-second-runner", DEFAULT_LEASE_MS)).toBeNull();
      } finally {
        await syl.close();
      }
    });

    /**
     * `syl-iwb` — nothing runs on the way down, so the lease is not released.
     *
     * `main` registers no `SIGINT`/`SIGTERM` handler; there is no `process.on`
     * anywhere in `backend/src`. `DeliveryRuntime.stop`, `RunningService.close`
     * and `SylDatabase.close` are called only from tests. The delivery job is
     * therefore stranded for the whole lease window after every restart —
     * five minutes by default, on the one job that carries the never-drop
     * guarantee.
     *
     * The contrast is the sharp part: `shared/src/cli/mock.ts`, a development
     * tool, shuts down gracefully. The service that holds the Commander's
     * reminders does not.
     */
    it("should strand a live lease across a restart, because nothing releases it", async () => {
      const syl = await startLiveService({ clock: () => FROZEN });
      const path = syl.databasePath;
      const directory = syl.directory;
      try {
        const job = defineReminderDeliveryJob(
          syl.deps.jobs,
          new Date(FROZEN - 1_000).toISOString(),
        );
        syl.deps.jobs.lease(job.id, "syl-before-the-restart", DEFAULT_LEASE_MS);
        await syl.close({ keepDatabase: true });

        const restarted = await startLiveService({ databasePath: path, clock: () => FROZEN });
        try {
          // The restart's own first pass reclaims it, before the service ever
          // claims to be up: `startSyl` awaits `runner.start()`, and every tick
          // reclaims before it schedules. `recoverLeases` matches on owner as
          // well as expiry, which is what saves this from being a five-minute
          // stall.
          //
          // The finding is that the lease survived at all. A shutdown handler
          // would have released it; the reclaim path is doing the work a
          // missing `process.on` left behind.
          expect(restarted.deps.jobs.get(job.id)?.state).toBe("pending");

          // And the expiry alone would not have helped in time.
          expect(DEFAULT_LEASE_MS).toBe(5 * 60_000);
        } finally {
          await restarted.close();
        }
      } finally {
        rmSync(directory ?? path, { recursive: true, force: true });
      }
    });

    it("should have no signal handler in the service, while the mock server has two", () => {
      const handling = sourceFiles(BACKEND_SRC).filter((file) =>
        /process\.on\(\s*["']SIG/u.test(readFileSync(file, "utf8")),
      );
      expect(handling.map((file) => file.slice(BACKEND_SRC.length))).toEqual([]);

      const mock = readFileSync(join(REPO_ROOT, "shared/src/cli/mock.ts"), "utf8");
      expect(mock).toContain('process.on("SIGTERM"');
    });
  });

  describe("a turn that hangs", () => {
    it("should be killed rather than blocking forever, and leave no orphan behind", async () => {
      const wedged = fake({ hang: true });

      // The turn is started but not awaited yet, so the test can wait for the
      // child to have booted and written its pid *before* the timeout fires.
      // Racing a fixed timeout against node's startup is how this assertion
      // becomes a machine-load test — it passed alone and failed under a full
      // suite at both one and three seconds.
      const turn = runTurn("Are you there?", { claudeBin: wedged.bin, timeoutMs: 10_000 });

      await vi.waitFor(() => {
        expect(wedged.invocation()?.pid).toBeGreaterThan(0);
      }, 15_000);
      const pid = wedged.invocation()?.pid ?? 0;

      await expect(turn).rejects.toThrow(/time|timeout/iu);

      // The child is gone. A timeout that leaves the process running has moved
      // the problem rather than solved it — and on a machine meant to run
      // unattended for weeks, that is a leak with no upper bound.
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow();
      });
    }, 40_000);

    it("should leave a turn that finishes inside its window alone", async () => {
      const prompt = fake({
        after: readFileSync(
          join(REPO_ROOT, "backend/tests/fixtures/turn-pong.jsonl"),
          "utf8",
        )
          .split("\n")
          .filter((line) => line.trim() !== ""),
        exitCode: 0,
      });

      // A generous window, for the reason its sibling above spells out: racing
      // a fixed timeout against node's own startup turns this into a machine-load
      // test. What is asserted is that a healthy turn is *not* disturbed, and
      // the size of the window it finishes inside is not part of the claim.
      // Observed failing at 10s on a saturated machine (`syl-vls`).
      const result = await runTurn("Reply with exactly: PONG", {
        claudeBin: prompt.bin,
        timeoutMs: 60_000,
      });
      expect(result.text).toContain("PONG");
    });
  });

  describe("supervision and the watchdog", () => {
    /**
     * `syl-007.2.1` — both now exist, and this used to assert they did not.
     *
     * The previous version of this case asserted that the repository shipped no
     * launchd plist and no supervision configuration, deliberately, so that
     * landing one would turn it red and force somebody to delete the sentence
     * saying it was missing. This is that deletion.
     *
     * What replaces it is the same shape of claim in the other direction: both
     * halves are present, and they are *different* halves. `KeepAlive` restarts
     * a process that has died; only the watchdog notices one that is wedged.
     * Shipping one and calling the criterion met is the failure this guards.
     */
    it("should ship both a supervised service and a separate wedge detector", () => {
      const tracked = trackedFiles();

      // Rendered from code rather than checked in: every path in a Syl plist is
      // absolute and machine-specific.
      expect(tracked).toContain("backend/src/ops/launchd.ts");
      expect(tracked).toContain("scripts/syl-watchdog.sh");
      expect(tracked).toContain("scripts/syl-service.sh");
    });

    it("should keep the service alive and the watchdog on a timer, which are not the same thing", () => {
      const jobs = sylLaunchdJobs({
        repoRoot: "/repo",
        home: "/home",
        logDirectory: "/logs",
        nodeBin: "/usr/bin/node",
        databasePath: "/db/syl.db",
        port: 4201,
      });

      const core = jobs.find((job) => job.label === "com.jmm.syl.core");
      const watchdog = jobs.find((job) => job.label === "com.jmm.syl.watchdog");

      // The core job restarts a DEAD process...
      expect(core?.plist["KeepAlive"]).toBe(true);
      // ...and nothing in launchd would ever notice a WEDGED one, which is why
      // the second job exists and runs on an interval instead.
      expect(watchdog?.plist["StartInterval"]).toBe(60);
      expect(watchdog?.plist["KeepAlive"]).toBeUndefined();
    });

    it("should expose the health endpoint a watchdog would need, at least", async () => {
      // The one half that is ready: something checking whether Syl is wedged
      // rather than dead has an unauthenticated endpoint to ask.
      const syl = await startLiveService();
      try {
        const response = await fetch(`${syl.baseUrl}/health`);
        const body = (await response.json()) as { data?: { status?: string } };

        expect(response.status).toBe(200);
        expect(["ok", "degraded"]).toContain(body.data?.status);
      } finally {
        await syl.close();
      }
    });
  });
});
