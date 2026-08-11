import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { queryLog } from "../../src/ops/log-query.js";

/**
 * Syl, started and stopped as a **process**.
 *
 * Everything else in this suite calls `startSyl` in-process, which is the right
 * tool for almost everything and is useless for the one question here: what
 * happens when launchd sends `SIGTERM`. A signal handler is process-level by
 * definition. Substituting an emitter for `process` — which `shutdown.test.ts`
 * correctly does for the logic — cannot tell you whether the handler is
 * *installed*, and "the component was never actually executed" is the shape of
 * nearly every serious defect this project has found.
 *
 * So this spawns the real entry point, waits until it answers a real health
 * request on a real port, sends a real signal, and reads the real log file it
 * left behind.
 *
 * Slower than every other file here, and worth it: this is the only test that
 * would have caught a service that traps nothing.
 *
 * IT MUST BE THE SERVICE'S OWN PID, which is why this runs the built
 * `dist/index.js` under node rather than `src/index.ts` under `tsx`. `tsx` is a
 * WRAPPER: `child.kill()` signalled the wrapper and `child.exitCode` reported
 * the wrapper's status, so the assertions were about tsx's signal forwarding
 * and not about Syl at all. It failed as `expected 143 to be +0`,
 * intermittently and only under load — the second `SIGTERM` killing the wrapper
 * while it was still waiting on a child that had not finished shutting down.
 *
 * That is this project's recurring defect in a new costume: a test that looks
 * like it exercises the real thing while measuring something else. Three
 * separate "fixes" went into the service's shutdown path chasing it before the
 * wrapper turned out to be what was dying. (Two of those found genuine bugs,
 * which is luck, not vindication.)
 */

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const entry = join(repoRoot, "backend", "dist", "index.js");

/**
 * Build first, EVERY time, rather than only when `dist` is missing.
 *
 * A conditional build is how a suite ends up validating last week's code: the
 * artifact exists, so the build is skipped, and the test passes against
 * something the source no longer says. Since this file's entire purpose is
 * process-level truth, testing a stale binary would defeat it completely.
 */
beforeAll(() => {
  execFileSync("npm", ["run", "build", "-w", "backend"], { cwd: repoRoot, stdio: "inherit" });
}, 300_000);

/**
 * A port below 49152.
 *
 * The ceiling is the point: macOS hands out EPHEMERAL ports from 49152 up
 * (`sysctl net.inet.ip.portrange.first`). This was `39_000 + random * 20_000`,
 * topping out at 59000, so a third of its range sat inside the pool the OS
 * assigns to every outbound connection on the machine — including this suite's
 * own. Its twin in `launchd-entrypoint.test.ts` failed exactly that way, with
 * `EADDRINUSE 127.0.0.1:50622`.
 */
function freePort(): number {
  return 39_000 + Math.floor(Math.random() * 10_000);
}

interface Spawned {
  readonly child: ChildProcess;
  readonly port: number;
  readonly directory: string;
  readonly logDirectory: string;
  readonly databasePath: string;
  readonly output: () => string;
  exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

const running: Spawned[] = [];

afterEach(async () => {
  for (const spawned of running.splice(0)) {
    if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
      spawned.child.kill("SIGKILL");
      await spawned.exited;
    }
    rmSync(spawned.directory, { recursive: true, force: true });
  }
});

/** Start the real entry point and wait until it answers. */
async function startProcess(
  options: { readonly directory?: string; readonly port?: number } = {},
): Promise<Spawned> {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "syl-proc-"));
  const logDirectory = join(directory, "logs");
  const databasePath = join(directory, "syl.db");
  const port = options.port ?? freePort();

  // Stripped exactly as `scripts/syl-service.sh` strips them, and for the same
  // reason: a set key silently outranks the claude.ai login and reroutes
  // billing. A developer's shell that has one must not be able to make this
  // suite assert the wrong thing about the credential source.
  const inherited = { ...process.env };
  delete inherited["ANTHROPIC_API_KEY"];
  delete inherited["ANTHROPIC_AUTH_TOKEN"];

  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env: {
      ...inherited,
      SYL_PORT: String(port),
      HOST: "127.0.0.1",
      // `development`, so the APNs assertion is not the thing under test here.
      NODE_ENV: "development",
      SYL_DB_PATH: databasePath,
      SYL_LOG_DIR: logDirectory,
      SYL_CERT_STATUS: join(directory, "cert-status.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const spawned: Spawned = {
    child,
    port,
    directory,
    logDirectory,
    databasePath,
    output: () => output,
    exited,
  };
  running.push(spawned);

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the service exited before it answered:\n${output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/health`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`the service never answered:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return spawned;
}

/** Whether anything is still holding the port. */
async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

describe("the service as a process", () => {
  it("should exit zero on SIGTERM, which is what launchd sends", async () => {
    const service = await startProcess();

    service.child.kill("SIGTERM");
    const { code, signal } = await service.exited;

    // Zero, not "killed by SIGTERM". A process that dies from the default
    // signal action reports `signal: SIGTERM` and `code: null`, and that is
    // exactly the ungraceful stop this epic exists to remove.
    expect(signal).toBeNull();
    expect(code).toBe(0);
  }, 60_000);

  it("should record the shutdown in its own log, where a human can find it", async () => {
    const service = await startProcess();

    service.child.kill("SIGTERM");
    await service.exited;

    const records = queryLog(service.logDirectory, { event: "shutdown" });
    expect(records.map((record) => record.event)).toContain("shutdown.begin");
    expect(records.map((record) => record.event)).toContain("shutdown.complete");
  }, 60_000);

  it("should put the credential source in the startup record", async () => {
    // `syl-007.2.2`. The one invariant that costs real money if it quietly
    // stops being true, in the first place anybody looks.
    const service = await startProcess();

    const start = queryLog(service.logDirectory, { event: "service.start" });
    expect(start).toHaveLength(1);
    expect(start[0]?.["credentialSource"]).toBe("none");
    expect(start[0]?.["subscriptionRails"]).toBe(true);

    service.child.kill("SIGTERM");
    await service.exited;
  }, 60_000);

  it("should release its port on a graceful stop", async () => {
    const service = await startProcess();
    expect(await portIsFree(service.port)).toBe(false);

    service.child.kill("SIGTERM");
    await service.exited;

    expect(await portIsFree(service.port)).toBe(true);
  }, 60_000);

  it("should treat SIGINT the same way, so Ctrl-C is not a kill either", async () => {
    const service = await startProcess();

    service.child.kill("SIGINT");
    const { code } = await service.exited;

    expect(code).toBe(0);
  }, 60_000);

  it("should shut down once when SIGTERM arrives twice", async () => {
    const service = await startProcess();

    service.child.kill("SIGTERM");
    service.child.kill("SIGTERM");
    const { code } = await service.exited;

    expect(code).toBe(0);
    const complete = queryLog(service.logDirectory, { event: "shutdown.complete" });
    expect(complete).toHaveLength(1);
  }, 60_000);

  it("should come back after a SIGKILL, against the store it left behind", async () => {
    // `syl-007.4.2`. SIGKILL is what a wedge-killer, a panic, or a power cut
    // looks like from the process's point of view: no handler runs, nothing is
    // flushed. What must be true afterwards is that the next boot works.
    const first = await startProcess();
    first.child.kill("SIGKILL");
    const { signal } = await first.exited;
    expect(signal).toBe("SIGKILL");

    const second = await startProcess({ directory: first.directory, port: first.port });
    const response = await fetch(`http://127.0.0.1:${String(second.port)}/api/v1/health`);
    expect(response.status).toBe(200);

    second.child.kill("SIGTERM");
    await second.exited;
  }, 90_000);

  it("should refuse to start, loudly, when the environment is not a configuration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "syl-proc-"));
    const child = spawn(process.execPath, [entry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SYL_PORT: String(freePort()),
        NODE_ENV: "development",
        SYL_DB_PATH: join(directory, "syl.db"),
        SYL_LOG_DIR: join(directory, "logs"),
        // An offset, not a place. Correct until the next daylight-saving
        // boundary and an hour wrong forever after.
        SYL_TZ: "-06:00",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", (value) => resolve(value));
    });

    // EX_CONFIG. Distinct from a crash, because launchd's KeepAlive will
    // restart this forever and the exit code is what says "stop reading the
    // stack trace and go edit the plist".
    expect(code).toBe(78);
    expect(output).toContain("SYL_TZ");
    rmSync(directory, { recursive: true, force: true });
  }, 60_000);
});
