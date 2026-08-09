import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  EXIT_SHUTDOWN_FAILED,
  EXIT_SHUTDOWN_TIMEOUT,
  installShutdownHandlers,
  SHUTDOWN_SIGNALS,
  type DeadlineTimers,
} from "../../src/ops/shutdown.js";

/**
 * The signal handler, driven through a real `EventEmitter`.
 *
 * Not a mock of the listener registration: the handler under test calls
 * `source.on("SIGTERM", ...)` and this suite emits `"SIGTERM"` on that emitter,
 * so the wiring being asserted is the wiring that runs. What is substituted is
 * `exit` — because a test that really called `process.exit` would take the
 * runner with it — and the deadline timer, so no case spends fifteen seconds.
 */

/** A timer pair the test fires by hand. */
function manualTimers(): DeadlineTimers & { fire(): void; readonly pending: number } {
  let callback: (() => void) | null = null;
  let pending = 0;
  return {
    set: (fn) => {
      callback = fn;
      pending += 1;
      return Symbol("handle");
    },
    clear: () => {
      callback = null;
      pending -= 1;
    },
    fire: () => callback?.(),
    get pending() {
      return pending;
    },
  };
}

describe("installShutdownHandlers", () => {
  it("should close and exit zero when SIGTERM arrives", async () => {
    const source = new EventEmitter();
    const exit = vi.fn();
    const close = vi.fn(async () => undefined);
    const timers = manualTimers();

    const handle = installShutdownHandlers({ close, exit, timers, source });
    source.emit("SIGTERM");
    await handle.requestShutdown("SIGTERM");

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("should honour SIGINT as well, so Ctrl-C is not a kill", async () => {
    const source = new EventEmitter();
    const exit = vi.fn();
    const close = vi.fn(async () => undefined);

    const handle = installShutdownHandlers({ close, exit, timers: manualTimers(), source });
    source.emit("SIGINT");
    await handle.requestShutdown("SIGINT");

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("should close exactly once when the signal arrives twice", async () => {
    // launchd re-sends SIGTERM to a job it is stopping, and an impatient
    // operator presses Ctrl-C twice. A second teardown of a service that is
    // already half torn down is how a shutdown turns into a crash.
    const source = new EventEmitter();
    const exit = vi.fn();
    let releaseClose = (): void => undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    );

    const handle = installShutdownHandlers({ close, exit, timers: manualTimers(), source });
    const first = handle.requestShutdown("SIGTERM");
    const second = handle.requestShutdown("SIGTERM");
    expect(first).toBe(second);

    releaseClose();
    await first;

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("should exit non-zero and say why when the close throws", async () => {
    const exit = vi.fn();
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const handle = installShutdownHandlers({
      close: () => Promise.reject(new Error("the database was already gone")),
      exit,
      timers: manualTimers(),
      source: new EventEmitter(),
      log: (event, fields) => lines.push({ event, fields: { ...fields } }),
    });

    await handle.requestShutdown("SIGTERM");

    expect(exit).toHaveBeenCalledWith(EXIT_SHUTDOWN_FAILED);
    const failure = lines.find((line) => line.event === "shutdown.failed");
    expect(failure?.fields["error"]).toContain("already gone");
  });

  it("should give up on a close that hangs, before launchd would SIGKILL it", async () => {
    // The whole point of the deadline: being killed leaves no record at all,
    // and "it vanished at 3am" is the hardest failure there is to diagnose.
    const exit = vi.fn();
    const timers = manualTimers();
    const lines: string[] = [];
    const handle = installShutdownHandlers({
      close: () => new Promise<void>(() => undefined),
      exit,
      timers,
      source: new EventEmitter(),
      log: (event) => lines.push(event),
    });

    const shutdown = handle.requestShutdown("SIGTERM");
    timers.fire();
    await shutdown;

    expect(exit).toHaveBeenCalledWith(EXIT_SHUTDOWN_TIMEOUT);
    expect(lines).toContain("shutdown.timeout");
  });

  it("should fit inside launchd's twenty-second grace", () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeLessThan(20_000);
  });

  it("should clear the deadline once the close has finished", async () => {
    // A pending timer is a handle the event loop counts. Leaving one armed
    // after a clean close is how a process that has "shut down" keeps running.
    const timers = manualTimers();
    const handle = installShutdownHandlers({
      close: async () => undefined,
      exit: () => undefined,
      timers,
      source: new EventEmitter(),
    });

    await handle.requestShutdown("SIGTERM");

    expect(timers.pending).toBe(0);
  });

  it("should keep listening while the close is in flight", async () => {
    // launchd re-sends SIGTERM to a job it is stopping. If the listener came
    // off at the start of the teardown, that second signal would take Node's
    // default action and kill the process mid-write — the exact failure this
    // module exists to prevent, one signal later.
    const source = new EventEmitter();
    let release = (): void => undefined;
    const handle = installShutdownHandlers({
      close: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      exit: () => undefined,
      timers: manualTimers(),
      source,
    });

    const shutdown = handle.requestShutdown("SIGTERM");
    expect(source.listenerCount("SIGTERM")).toBe(1);

    release();
    await shutdown;
    expect(source.listenerCount("SIGTERM")).toBe(0);
  });

  it("should remove its listeners on dispose", () => {
    const source = new EventEmitter();
    const handle = installShutdownHandlers({
      close: async () => undefined,
      exit: () => undefined,
      source,
    });

    for (const signal of SHUTDOWN_SIGNALS) expect(source.listenerCount(signal)).toBe(1);
    handle.dispose();
    for (const signal of SHUTDOWN_SIGNALS) expect(source.listenerCount(signal)).toBe(0);
    expect(handle.stopping).toBe(false);
  });
});
