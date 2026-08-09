/**
 * Stopping on purpose.
 *
 * launchd does not ask; it sends `SIGTERM` and starts a twenty-second clock,
 * after which it sends `SIGKILL`. A Node process that installs no handler for
 * `SIGTERM` takes the default action, which is to die immediately — mid-tick,
 * mid-write, mid-push. Nothing is corrupted (SQLite is transactional), but a
 * job whose lease was taken and never released is indistinguishable from a job
 * whose process crashed, so the runner's recovery pass has to reclaim it on
 * every single restart rather than only after a genuine crash. That is the
 * difference between "we recover" and "we can tell whether anything went
 * wrong".
 *
 * Three properties are load-bearing:
 *
 * 1. **Idempotent.** A second signal while the first is being honoured must not
 *    start a second close. Impatient operators press Ctrl-C twice, and launchd
 *    itself will re-send `SIGTERM` to a job it is stopping.
 * 2. **Bounded.** If the close hangs, we exit *ourselves* before launchd's
 *    grace expires, with a line saying so. Being SIGKILLed leaves no record at
 *    all, and "it just vanished at 3am" is the hardest failure to diagnose.
 * 3. **Never a reason to stay alive.** The deadline timer is unreffed, so
 *    installing shutdown handling cannot be what keeps an otherwise-finished
 *    process running.
 */

/** The signals launchd and a terminal use to ask for a stop. */
export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * How long the close gets before we stop waiting for it.
 *
 * Under launchd's default `ExitTimeOut` of 20 seconds. The margin is what buys
 * us the chance to say why we are going.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

/** Exit status when the close never finished. `EX_TEMPFAIL`, from sysexits. */
export const EXIT_SHUTDOWN_TIMEOUT = 75;

/** Exit status when the close threw. `EX_SOFTWARE`, from sysexits. */
export const EXIT_SHUTDOWN_FAILED = 70;

/** Exit status when a human insisted: 128 + SIGINT, the shell's convention. */
export const EXIT_FORCED = 130;

/**
 * Signals whose REPEAT means "I meant it" rather than "the supervisor is
 * retrying".
 *
 * Only `SIGINT`, and the asymmetry with `SIGTERM` is the whole point.
 *
 * The obvious design — a second signal of any kind forces the exit, the way
 * Ctrl-C twice works in an interactive program — is wrong for a service under
 * launchd, because **launchd re-sends `SIGTERM` to a job it is stopping as a
 * matter of course**. A repeated `SIGTERM` therefore carries no intent at all,
 * and treating it as intent means dying mid-write during an ordinary stop:
 * every reboot, every reload. That is precisely the ungraceful kill this
 * module exists to prevent, and a job lease abandoned that way is
 * indistinguishable from one abandoned by a crash.
 *
 * `SIGINT` is different in kind. Nothing auto-repeats it — it comes from a
 * terminal, so a second one is unambiguously a person who has decided not to
 * wait. Honouring it there gives the familiar escape hatch exactly where the
 * intent is real. `SIGKILL` remains the guaranteed answer for everything else,
 * and the deadline above bounds a close that will not finish.
 */
export const FORCE_ON_REPEAT = ["SIGINT"] as const;

/**
 * The part of `process` this module touches.
 *
 * Structural rather than `typeof process`, so a test drives the real handler
 * through a real `EventEmitter` without installing anything on the global
 * process — a suite that leaks a `SIGTERM` listener into the runner is a suite
 * that stops being able to be interrupted.
 */
export interface SignalSource {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

/** The timer pair, so a test never spends a wall-clock second on a deadline. */
export interface DeadlineTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/**
 * The real timers, used when a caller supplies none.
 *
 * Exported so a test can execute these two functions rather than always
 * substituting a hand-driven pair. They were uncovered in the first draft of
 * this module — the default closure that a production shutdown would use had
 * never run — which is the same shape as the defects `syl-w40` found in the
 * socket connector and the default reconnect closure.
 */
export const systemDeadlineTimers: DeadlineTimers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    // A shutdown deadline must never be the reason a process is still running.
    handle.unref?.();
    return handle;
  },
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface ShutdownOptions {
  /** Stop everything. Must resolve when in-flight work is finished or abandoned. */
  readonly close: () => Promise<void>;
  /** Which signals to honour. Defaults to {@link SHUTDOWN_SIGNALS}. */
  readonly signals?: readonly string[];
  /** Whose repeat forces an immediate exit. Defaults to {@link FORCE_ON_REPEAT}. */
  readonly forceOnRepeat?: readonly string[];
  /** Where signals come from. Defaults to `process`. */
  readonly source?: SignalSource;
  /** How the process ends. Defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  /** Where the two lines a shutdown produces go. */
  readonly log?: (event: string, fields: Readonly<Record<string, unknown>>) => void;
  readonly timeoutMs?: number;
  readonly timers?: DeadlineTimers;
}

export interface ShutdownHandle {
  /**
   * Run the shutdown as though `signal` had arrived.
   *
   * Returns the *same* promise for every call after the first, which is what
   * makes a second `SIGTERM` a no-op rather than a second teardown of a service
   * that is already half torn down.
   */
  requestShutdown(signal: string): Promise<void>;
  /** Whether a shutdown has been asked for. */
  readonly stopping: boolean;
  /** Remove the listeners. For a service that is stopping some other way. */
  dispose(): void;
}

/**
 * Honour `SIGTERM` and `SIGINT` by closing, then exiting.
 *
 * The handlers are installed with `on` rather than `once` and removed by
 * `dispose`, because a `once` handler that has already fired leaves the *next*
 * signal taking Node's default action — which is exactly the ungraceful kill
 * this exists to prevent, arriving at the worst possible moment.
 */
export function installShutdownHandlers(options: ShutdownOptions): ShutdownHandle {
  const signals = options.signals ?? SHUTDOWN_SIGNALS;
  const source: SignalSource = options.source ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const timers = options.timers ?? systemDeadlineTimers;
  const forceOnRepeat = options.forceOnRepeat ?? FORCE_ON_REPEAT;

  let inFlight: Promise<void> | null = null;
  const listeners = new Map<string, () => void>();

  const dispose = (): void => {
    for (const [signal, listener] of listeners) source.removeListener(signal, listener);
    listeners.clear();
  };

  /**
   * Stop shutting down twice, without ever leaving the process unguarded.
   *
   * `dispose` used to be called here, at the end of the teardown, on the
   * reasoning that there was nothing left to protect. There was: the process's
   * own exit path. Between removing the handlers and `exit` actually taking
   * effect the service still has to write `shutdown.complete` to a log file,
   * and in that window a `SIGTERM` had no listener and therefore took Node's
   * default action — death by signal, status 143, mid-write.
   *
   * launchd RE-SENDS `SIGTERM` to a job it is stopping, so this is the normal
   * case rather than an exotic one, and the failure is exactly the ungraceful
   * kill this module exists to prevent, arriving one signal later.
   *
   * It surfaced as `expected 143 to be +0`, intermittently and only under load
   * — because an idle machine finishes the log write before the second signal
   * is delivered, and a busy one does not. Widening the window is all that
   * "load" ever meant here.
   *
   * Swapping in no-ops rather than removing keeps the process covered until it
   * is genuinely gone, while still making a repeat signal do nothing. `dispose`
   * stays as the caller-facing cleanup and removes whichever of the two is
   * currently installed.
   */
  const ignore = (): void => {
    for (const [signal, listener] of [...listeners]) {
      source.removeListener(signal, listener);
      const swallow = (): void => undefined;
      listeners.set(signal, swallow);
      source.on(signal, swallow);
    }
  };

  const run = async (signal: string): Promise<void> => {
    log("shutdown.begin", { signal, timeoutMs });

    // The listeners deliberately stay installed for the whole teardown.
    //
    // The tempting alternative — remove them here, so a second Ctrl-C takes
    // Node's default action and kills the process outright — is wrong for a
    // service. launchd re-sends `SIGTERM` to a job it is stopping, and a
    // process that dies from the second one is exactly the mid-write kill this
    // module exists to prevent, arriving one signal later. `inFlight` makes
    // every repeat a no-op instead, and the deadline below is what bounds a
    // close that will not finish.

    let timedOut = false;
    let handle: unknown = null;
    const deadline = new Promise<void>((resolve) => {
      handle = timers.set(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    });

    try {
      await Promise.race([options.close(), deadline]);
    } catch (error) {
      timers.clear(handle);
      ignore();
      log("shutdown.failed", {
        signal,
        error: error instanceof Error ? error.message : String(error),
      });
      exit(EXIT_SHUTDOWN_FAILED);
      return;
    }
    timers.clear(handle);
    // Not `dispose`: there IS something left to protect — the log write below
    // and the exit itself. See `ignore`.
    ignore();

    if (timedOut) {
      log("shutdown.timeout", { signal, timeoutMs });
      exit(EXIT_SHUTDOWN_TIMEOUT);
      return;
    }

    log("shutdown.complete", { signal });
    exit(0);
  };

  const requestShutdown = (signal: string): Promise<void> => {
    inFlight ??= run(signal);
    return inFlight;
  };

  for (const signal of signals) {
    const listener = (): void => {
      // A repeat of a forceable signal abandons the close rather than waiting
      // it out. Only reachable once a shutdown is already under way, so the
      // first Ctrl-C is still graceful and only the second is impatient.
      if (inFlight !== null && forceOnRepeat.includes(signal)) {
        log("shutdown.forced", { signal });
        exit(EXIT_FORCED);
        return;
      }
      void requestShutdown(signal);
    };
    listeners.set(signal, listener);
    source.on(signal, listener);
  }

  return {
    requestShutdown,
    get stopping() {
      return inFlight !== null;
    },
    dispose,
  };
}
