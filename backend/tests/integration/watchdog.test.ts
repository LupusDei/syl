import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { queryLog } from "../../src/ops/log-query.js";

/**
 * The watchdog, run as the real script against a genuinely wedged process.
 *
 * This is the bead's whole claim and it is the one worth being sceptical about:
 * `KeepAlive` restarts a process that has **died**, and nothing in launchd
 * notices one that is **wedged** — running, holding its port, answering
 * nothing. So the wedge here is real rather than described: a TCP server that
 * completes the handshake, accepts the request bytes, and never writes a
 * response. That is exactly what a Node process with a blocked event loop looks
 * like from outside, because the *kernel* completes the handshake out of the
 * listen backlog without the process's help. A test that stubbed the health
 * probe would prove nothing about the only case that matters.
 *
 * What is substituted is `launchctl`, and only `launchctl` — a stub on the path
 * the script resolves, which records its arguments. Running the real one would
 * restart the Commander's actual service from a test suite.
 */

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const watchdog = join(repoRoot, "scripts", "syl-watchdog.sh");

interface Harness {
  readonly directory: string;
  readonly logDirectory: string;
  readonly launchctlLog: string;
  /** Run the real script once. Returns its exit status and stdout. */
  run(url: string, overrides?: Readonly<Record<string, string>>): { status: number; output: string };
  /** Every argument list the stub `launchctl` was called with. */
  kickstarts(): readonly string[];
}

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const teardown of cleanup.splice(0)) teardown();
});

function harness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), "syl-watchdog-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));

  const logDirectory = join(directory, "logs");
  const launchctlLog = join(directory, "launchctl.calls");
  const stub = join(directory, "launchctl");
  writeFileSync(stub, `#!/bin/bash\nprintf '%s\\n' "$*" >> "${launchctlLog}"\nexit 0\n`, { mode: 0o755 });

  return {
    directory,
    logDirectory,
    launchctlLog,
    run: (url, overrides = {}) => {
      try {
        const output = execFileSync("/bin/bash", [watchdog], {
          encoding: "utf8",
          env: {
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            HOME: directory,
            SYL_HEALTH_URL: url,
            SYL_LOG_DIR: logDirectory,
            SYL_LAUNCHCTL: stub,
            SYL_WATCHDOG_THRESHOLD: "3",
            // One second. A loopback answer is sub-millisecond, so this is not
            // a flakiness risk — and the production value is ten.
            SYL_WATCHDOG_TIMEOUT: "1",
            ...overrides,
          },
        });
        return { status: 0, output };
      } catch (error) {
        // Safe assertion: `execFileSync` attaches these on a non-zero exit.
        const failure = error as { status?: number; stdout?: string };
        return { status: failure.status ?? -1, output: failure.stdout ?? "" };
      }
    },
    kickstarts: () =>
      existsSync(launchctlLog)
        ? readFileSync(launchctlLog, "utf8").split("\n").filter((line) => line !== "")
        : [],
  };
}

/**
 * Both servers are separate **processes**, and that is not fastidiousness.
 *
 * The first draft ran them in-process, and every case passed for the wrong
 * reason: `execFileSync` blocks this process's event loop for the whole of the
 * script's run, so the "healthy" server could not answer either and the suite
 * was measuring one timeout against another. A watchdog test in which nothing
 * is ever healthy proves nothing at all.
 */
async function spawnServer(body: string): Promise<string> {
  // The port is written with `process.stdout.write`, not `console.log`: vitest
  // exports `FORCE_COLOR`, the child inherits it, and `console.log(number)`
  // then wraps the port in ANSI escapes — which curl reports as "bad range in
  // URL". Twenty minutes, that one.
  const child = spawn(process.execPath, ["-e", body], { stdio: ["ignore", "pipe", "inherit"] });
  cleanup.push(() => child.kill("SIGKILL"));

  const port = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const line = buffered.split("\n")[0];
      if (buffered.includes("\n") && line !== undefined) resolve(line.trim());
    });
    child.once("exit", () => reject(new Error("the helper server exited before it listened")));
    setTimeout(() => reject(new Error("the helper server never reported a port")), 10_000);
  });

  return `http://127.0.0.1:${port}/api/v1/health`;
}

/** A server that answers, the way a healthy Syl does. */
function healthy(): Promise<string> {
  return spawnServer(`
    const http = require("node:http");
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, data: { status: "ok" } }));
    });
    server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));
  `);
}

/**
 * A process that is **wedged**, in the exact shape of the 3am failure.
 *
 * It binds the port, announces it, and then blocks its own event loop forever.
 * The listening socket stays open and the *kernel* completes every handshake
 * out of the listen backlog without the process's help — so it accepts
 * connections, holds the port, and answers nothing. `launchctl list` reports it
 * as perfectly healthy and `KeepAlive` has nothing to restart.
 *
 * `Atomics.wait` rather than a spin loop: the same blockage, without burning a
 * core for the length of the suite.
 */
function wedged(): Promise<string> {
  return spawnServer(`
    const http = require("node:http");
    const server = http.createServer((_request, response) => response.end("never reached"));
    server.listen(0, "127.0.0.1", () => {
      // writeSync, then block on the very next statement. An asynchronous
      // write followed by a delayed block leaves a window in which the process
      // is briefly healthy, and the first probe lands inside it.
      require("node:fs").writeSync(1, server.address().port + "\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
  `);
}

/** A port nothing is listening on: the case KeepAlive would already handle. */
function dead(): string {
  return "http://127.0.0.1:1/api/v1/health";
}

describe("the watchdog", () => {
  it("should leave a healthy service alone", async () => {
    const harnessed = harness();
    const url = await healthy();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(harnessed.run(url).status).toBe(0);
    }

    expect(harnessed.kickstarts()).toEqual([]);
  }, 60_000);

  it("should restart a WEDGED process, which KeepAlive never would", async () => {
    // The bead's claim, proved rather than asserted. The server below is
    // running and holding its port; launchd would report it perfectly healthy.
    const harnessed = harness();
    const url = await wedged();

    expect(harnessed.run(url).status).toBe(1);
    expect(harnessed.kickstarts()).toEqual([]);
    expect(harnessed.run(url).status).toBe(1);
    expect(harnessed.kickstarts()).toEqual([]);

    const third = harnessed.run(url);
    expect(third.status).toBe(2);
    expect(harnessed.kickstarts()).toHaveLength(1);
    expect(harnessed.kickstarts()[0]).toContain("kickstart -k");
    expect(harnessed.kickstarts()[0]).toContain("com.jmm.syl.core");
  }, 60_000);

  it("should not restart on one slow answer", async () => {
    // A research brief that takes twelve seconds is not a wedge, and a watchdog
    // that restarts the service every time one happens is worse than none.
    const harnessed = harness();
    const url = await wedged();

    expect(harnessed.run(url).status).toBe(1);

    expect(harnessed.kickstarts()).toEqual([]);
  }, 60_000);

  it("should forget the misses once the service answers again", async () => {
    const harnessed = harness();
    const wedgedUrl = await wedged();
    const healthyUrl = await healthy();

    expect(harnessed.run(wedgedUrl).status).toBe(1);
    expect(harnessed.run(wedgedUrl).status).toBe(1);
    // Recovered. The counter must reset, or the next single miss — hours later
    // and unrelated — would trip the threshold on its own.
    expect(harnessed.run(healthyUrl).status).toBe(0);
    expect(harnessed.run(wedgedUrl).status).toBe(1);

    expect(harnessed.kickstarts()).toEqual([]);
  }, 60_000);

  it("should also catch a service that is simply not there", async () => {
    const harnessed = harness();

    harnessed.run(dead());
    harnessed.run(dead());
    expect(harnessed.run(dead()).status).toBe(2);
    expect(harnessed.kickstarts()).toHaveLength(1);
  }, 60_000);

  it("should write what it did, as records the log reader can find", async () => {
    const harnessed = harness();
    const url = await wedged();

    harnessed.run(url);
    harnessed.run(url);
    harnessed.run(url);

    const records = queryLog(harnessed.logDirectory, { filename: "watchdog.log", minLevel: "warn" });
    expect(records.map((record) => record.event)).toContain("watchdog.unhealthy");
    expect(records.map((record) => record.event)).toContain("watchdog.wedged");
  }, 60_000);

  it("should report a recovery, so a run of misses is not silent", async () => {
    const harnessed = harness();
    const wedgedUrl = await wedged();
    const healthyUrl = await healthy();

    harnessed.run(wedgedUrl);
    harnessed.run(healthyUrl);

    const records = queryLog(harnessed.logDirectory, { filename: "watchdog.log" });
    expect(records.map((record) => record.event)).toContain("watchdog.recovered");
  }, 60_000);

  it("should truncate launchd's capture files in place rather than rotate them", async () => {
    // launchd holds these open. Renaming one leaves launchd writing to the
    // renamed inode and the "current" file empty forever, which is why the
    // service's own log is the rotated one and these are only truncated.
    const harnessed = harness();
    const url = await healthy();
    harnessed.run(url);

    const capture = join(harnessed.logDirectory, "launchd-core.log");
    writeFileSync(capture, "x".repeat(5_000));
    harnessed.run(url, { SYL_WATCHDOG_MAX_CAPTURE_BYTES: "1000" });

    expect(statSync(capture).size).toBe(0);
  }, 60_000);

  it("should leave a capture file that is still small alone", async () => {
    const harnessed = harness();
    const url = await healthy();
    harnessed.run(url);

    const capture = join(harnessed.logDirectory, "launchd-core.log");
    writeFileSync(capture, "x".repeat(100));
    harnessed.run(url, { SYL_WATCHDOG_MAX_CAPTURE_BYTES: "1000" });

    expect(statSync(capture).size).toBe(100);
  }, 60_000);
});
