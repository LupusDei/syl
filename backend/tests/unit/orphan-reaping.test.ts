import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  killEveryLiveChild,
  liveChildCount,
  trackChild,
} from "../../src/harness/session.js";

/**
 * NO TURN OUTLIVES THE PROCESS THAT STARTED IT — `syl-2vml`.
 *
 * `runTurn` bounds a wedged CLI with SIGTERM and then SIGKILL two seconds
 * later, and that ladder is correct. **It is also unreachable in the case that
 * actually bit us**, because `timer` lives in the parent: when the parent dies
 * the timeout dies with it, and the child is reparented to `ppid 1` with no
 * bound of any kind.
 *
 * Measured on 2026-08-23: twenty orphaned `claude` processes, all `ppid 1`,
 * minutes old, none of them going to be killed by anything. An orphan is not a
 * child that outlived its timeout — it is a child whose timeout was cremated
 * with its parent.
 *
 * SIGKILL rather than SIGTERM, measured on those same orphans:
 *
 *     kill -TERM 86637   exit 0, process still alive, state S
 *     kill -KILL 86637   gone
 *
 * The CLI ignores SIGTERM. A polite signal that is ignored is not a teardown,
 * and `process.on("exit")` can only run synchronous work anyway — there is no
 * grace period available in which to be polite.
 */
describe("no turn outlives the process that started it", () => {
  const strays: ReturnType<typeof spawn>[] = [];

  /** A child that ignores SIGTERM, exactly as the real CLI does. */
  function stubbornChild(): ReturnType<typeof spawn> {
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    ]);
    strays.push(child);
    return child;
  }

  // The registry is module-level, so a stray from an earlier test would still
  // be in it and its late `close` would move the count under a later
  // assertion. Start every test from empty.
  beforeEach(() => {
    killEveryLiveChild();
  });

  afterEach(() => {
    for (const child of strays) child.kill("SIGKILL");
    strays.length = 0;
    killEveryLiveChild();
  });

  it("should track a child while it runs", () => {
    const child = stubbornChild();

    trackChild(child);

    expect(liveChildCount()).toBe(1);
  });

  it("should forget a child that exited, so the registry cannot grow forever", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    strays.push(child);

    trackChild(child);
    expect(liveChildCount()).toBe(1);
    await new Promise((resolve) => child.once("close", resolve));

    expect(liveChildCount()).toBe(0);
  });

  it("should SIGKILL a child that ignores SIGTERM", async () => {
    const child = stubbornChild();
    trackChild(child);

    killEveryLiveChild();
    const [, signal] = (await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.once("close", (code, sig) => {
        resolve([code, sig]);
      }),
    )) as [number | null, NodeJS.Signals | null];

    // Not SIGTERM. The real CLI ignores it, and `process.on("exit")` has no
    // asynchronous grace period in which to escalate.
    expect(signal).toBe("SIGKILL");
  });

  it("should empty the registry when it kills, so a second call is not a double kill", () => {
    trackChild(stubbornChild());
    trackChild(stubbornChild());

    killEveryLiveChild();

    expect(liveChildCount()).toBe(0);
    expect(() => {
      killEveryLiveChild();
    }).not.toThrow();
  });

  it("should survive a child that is already dead", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    strays.push(child);
    trackChild(child);
    await new Promise((resolve) => child.once("close", resolve));

    // A kill against a reaped pid throws ESRCH if it is not guarded, and this
    // runs from `process.on("exit")` where a throw takes the exit path with it.
    expect(() => {
      killEveryLiveChild();
    }).not.toThrow();
  });
});
