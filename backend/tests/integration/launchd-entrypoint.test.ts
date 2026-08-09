import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { queryLog } from "../../src/ops/log-query.js";

/**
 * `scripts/syl-service.sh` — what launchd actually runs.
 *
 * Everything else in this suite starts the service by importing it. launchd
 * does not: it runs `/bin/bash scripts/syl-service.sh` with a four-entry `PATH`
 * and no shell profile, and three things in that script decide whether Syl runs
 * at all. All three have exactly one chance to be right, months from now, at
 * boot, with nobody watching:
 *
 * 1. **Finding node.** launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin` and
 *    nothing else. `claude-bin.ts` already learned this the hard way.
 * 2. **`exec`.** Without it, bash remains the process launchd is tracking, and
 *    launchd's `SIGTERM` goes to *bash* — which dies instantly and takes node
 *    with it, defeating the entire graceful shutdown.
 * 3. **Stripping the credential variables**, so nothing in the process tree
 *    ever had one.
 *
 * The build is run here rather than assumed: the script deliberately refuses to
 * start from `tsx`, so there is nothing to test without `backend/dist`.
 */

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const script = join(repoRoot, "scripts", "syl-service.sh");
const entry = join(repoRoot, "backend", "dist", "index.js");

beforeAll(() => {
  if (existsSync(entry)) return;
  execFileSync("npm", ["run", "build", "-w", "backend"], { cwd: repoRoot, stdio: "inherit" });
}, 300_000);

interface Started {
  readonly child: ChildProcess;
  readonly port: number;
  readonly directory: string;
  readonly logDirectory: string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
}

const running: Started[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const started of running.splice(0)) {
    if (started.child.exitCode === null && started.child.signalCode === null) {
      started.child.kill("SIGKILL");
      await started.exited;
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "syl-entry-"));
  directories.push(directory);
  return directory;
}

async function start(env: Readonly<Record<string, string>> = {}): Promise<Started> {
  const directory = scratch();
  const logDirectory = join(directory, "logs");
  // 43000-49000, and the ceiling matters: macOS hands out EPHEMERAL ports from
  // 49152 upward (`sysctl net.inet.ip.portrange.first`). This was
  // `43_000 + random * 15_000`, topping out at 58000 — so well over half its
  // range sat inside the pool the OS assigns to every outbound connection on
  // the machine, including the ones this very suite makes. It failed exactly
  // that way, with `EADDRINUSE 127.0.0.1:50622` on an unrelated run.
  //
  // Staying strictly below 49152 means the only thing that can hold this port
  // is something that deliberately bound it. Binding port 0 would be stronger
  // still, but the port has to be known before the subprocess is spawned,
  // because it is passed in through the environment.
  const port = 43_000 + Math.floor(Math.random() * 6_000);

  const child = spawn("/bin/bash", [script], {
    cwd: directory,
    env: {
      // Exactly what launchd gives a job, plus what the plist adds. No shell
      // profile, no nvm, no Homebrew on the path by default.
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env["HOME"] ?? "",
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "development",
      SYL_DB_PATH: join(directory, "syl.db"),
      SYL_LOG_DIR: logDirectory,
      SYL_CERT_STATUS: join(directory, "cert-status.json"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const started: Started = { child, port, directory, logDirectory, exited, output: () => output };
  running.push(started);

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the script exited ${String(child.exitCode)}:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/health`);
      if (response.ok) break;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`never answered:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return started;
}

/**
 * Poll the log until an event shows up, rather than reading it once.
 *
 * `start()` proves the service is READY by polling the health endpoint. That
 * says nothing about the LOG, and the two have no happens-before relationship:
 * the service can be answering HTTP while its `service.start` line is still
 * sitting in a buffer. Reading the file once, immediately, therefore passes on
 * an idle machine and fails under load — `expected undefined to be 'none'`,
 * because `queryLog` returned an empty array and `[0]?.[...]` is `undefined`.
 *
 * That is worth more care than a sleep. This is the assertion that enforces
 * non-negotiable constraint 3 at the outermost layer, and a guard that fails
 * intermittently is worse than no guard — a red that moves around teaches
 * everyone to re-run until green, which is exactly how a real credential leak
 * would get waved through.
 */
async function awaitLog(
  logDirectory: string,
  filter: Parameters<typeof queryLog>[1],
  timeoutMs = 10_000,
): Promise<ReturnType<typeof queryLog>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = queryLog(logDirectory, filter);
    if (found.length > 0) return found;
    if (Date.now() > deadline) {
      throw new Error(`no log event matched ${JSON.stringify(filter)} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("scripts/syl-service.sh", () => {
  it("should find a usable node with only launchd's PATH", async () => {
    const started = await start();
    expect(started.output()).toContain("starting");
    started.child.kill("SIGTERM");
    await started.exited;
  }, 90_000);

  it("should exec, so launchd's SIGTERM reaches node rather than bash", async () => {
    // The whole of the graceful shutdown depends on this one keyword. Without
    // `exec`, bash takes the signal, dies on the default action, and node is
    // killed mid-write — and the exit status would be 143 (128 + SIGTERM)
    // rather than the service's own clean zero.
    const started = await start();

    started.child.kill("SIGTERM");
    const { code, signal } = await started.exited;

    expect(signal).toBeNull();
    expect(code).toBe(0);
    // Safer than it looks — the process has exited, so its buffers are flushed
    // — but polled anyway, for the same reason as `awaitLog` itself: nothing in
    // this file should assert on a log it merely hopes has been written.
    expect(await awaitLog(started.logDirectory, { event: "shutdown.complete" })).toHaveLength(1);
  }, 90_000);

  it("should strip a credential variable it was handed", async () => {
    // Non-negotiable constraint 3, at the outermost layer. A set key silently
    // outranks the claude.ai login and reroutes billing to the metered API, and
    // the harness stripping it before spawning `claude` is one layer down —
    // this makes it true of the entire process tree.
    const started = await start({ ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" });

    const start_ = await awaitLog(started.logDirectory, { event: "service.start" });
    expect(start_[0]?.["credentialSource"]).toBe("none");
    expect(start_[0]?.["subscriptionRails"]).toBe(true);
    // And it is nowhere in what the script printed, either.
    expect(started.output()).not.toContain("sk-ant-not-a-real-key");

    started.child.kill("SIGTERM");
    await started.exited;
  }, 90_000);

  it("should write plists only its owner can read", () => {
    // The core job's EnvironmentVariables carries SYL_APNS_PRIVATE_KEY — the
    // contents of the `.p8`. At the default 0644 that puts an Apple signing key
    // where every process on the machine can read it, in a directory nobody
    // thinks of as a secret store.
    const outDir = join(scratch(), "agents");
    const secret = "-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----";

    const install = (): void => {
      execFileSync("npx", ["tsx", join(repoRoot, "backend", "src", "ops", "cli", "launchd.ts"), "--out", outDir], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          SYL_APNS_KEY_ID: "ABCD123456",
          SYL_APNS_TEAM_ID: "TEAM123456",
          SYL_APNS_BUNDLE_ID: "com.jmm.syl",
          SYL_APNS_PRIVATE_KEY: secret,
          SYL_APNS_ENVIRONMENT: "production",
        },
      });
    };

    install();
    const core = join(outDir, "com.jmm.syl.core.plist");

    // It really did carry the key...
    expect(readFileSync(core, "utf8")).toContain("not-a-real-key");
    // ...and nobody but the owner can read it.
    expect(statSync(core).mode & 0o777).toBe(0o600);
    // Every file it wrote is a plist launchd can parse.
    execFileSync("/usr/bin/plutil", ["-lint", core], { encoding: "utf8" });

    // Re-running the installer over an existing file keeps the mode, which
    // `writeFileSync`'s own `mode` option would not: it applies on create only.
    chmodSync(core, 0o644);
    install();
    expect(statSync(core).mode & 0o777).toBe(0o600);
  }, 120_000);

  it("should refuse with EX_CONFIG when the service has not been built", async () => {
    // The script deliberately runs built output rather than tsx, so an
    // unbuilt tree must fail loudly and name the fix — rather than crash-loop
    // under KeepAlive with a module-not-found stack every ten seconds.
    const elsewhere = scratch();
    mkdirSync(join(elsewhere, "scripts"), { recursive: true });
    const copied = join(elsewhere, "scripts", "syl-service.sh");
    copyFileSync(script, copied);

    let output = "";
    let status = 0;
    try {
      output = execFileSync("/bin/bash", [copied], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env["HOME"] ?? "" },
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      status = failure.status ?? -1;
      output = failure.stdout ?? "";
    }

    expect(status).toBe(78);
    expect(output).toContain("npm run build");
  }, 60_000);
});
