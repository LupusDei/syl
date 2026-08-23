import { createServer, type Server } from "node:net";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * **The operator sweep refuses to run into a live service, and that is a
 * mechanism rather than advice.**
 *
 * `syl-chzl.4.4`. The scheduled sweep is gated on quiet hours because
 * compaction measured 104,504ms, so a thread found too big at midday stays too
 * big until 23:00 — and `npm run compact` exists for the day that is not good
 * enough.
 *
 * It has exactly one way to make his conversation worse: a `--resume` against a
 * session the running service is already holding a warm `claude` on. `SylAgent`
 * serialises turns per lane precisely so two processes never append to one
 * transcript, and a hand-run turn is outside that queue with no way into it.
 *
 * So the command probes the port and exits rather than trusting the operator to
 * remember. These tests are the correspondence check on that: a real listener
 * on a real port, and the assertion that **no turn was attempted** — not merely
 * that a warning was printed.
 */

let listener: Server | undefined;
let home: string;

/** A real socket on a real port. The guard probes by connecting, so a fake
 *  would test nothing — this is the thing it actually looks for. */
async function listenOn(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

/** A free port below 49152 — macOS hands out ephemeral ports from there up,
 *  and two helpers in this repo have already collided with that pool. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (port >= 49_152 || port === 0) return 40_000 + Math.floor(Math.random() * 5_000);
  return port;
}

async function compact(args: readonly string[], env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run("npx", ["tsx", "backend/src/harness/cli/compact.ts", ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "syl-compact-"));
  mkdirSync(join(home, "sessions"), { recursive: true });
});

afterEach(async () => {
  if (listener) {
    await new Promise<void>((resolve) => listener?.close(() => resolve()));
    listener = undefined;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("npm run compact — the operator sweep", () => {
  it("should REFUSE while the service is listening, rather than warn and proceed", async () => {
    writeFileSync(join(home, "sessions", "commander"), "382a8e0d-faae-4713-ad7e-bd45aa671467", "utf8");
    const port = await freePort();
    listener = await listenOn(port);

    const result = await compact([], { SYL_PORT: String(port), SYL_DB_PATH: join(home, "syl.db") });

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/REFUSED/);
    // The reason, not just the refusal — an operator who is told "no" without
    // being told what to do instead improvises, which is the thing this prevents.
    expect(result.stderr).toMatch(/one transcript/i);
    expect(result.stderr).toMatch(/launchctl bootout/);
  });

  it("should send NO TURN when it refuses", async () => {
    // The assertion that matters. A guard that prints a warning and compacts
    // anyway would pass a test looking only for the word REFUSED.
    writeFileSync(join(home, "sessions", "commander"), "382a8e0d-faae-4713-ad7e-bd45aa671467", "utf8");
    const port = await freePort();
    listener = await listenOn(port);

    const result = await compact([], { SYL_PORT: String(port), SYL_DB_PATH: join(home, "syl.db") });

    expect(result.stdout).not.toMatch(/Compacting\./);
    expect(result.stdout).not.toMatch(/took .*ms/);
  });

  it("should say plainly that there is nothing to compact when the lane has no session", async () => {
    const port = await freePort();
    const result = await compact([], { SYL_PORT: String(port), SYL_DB_PATH: join(home, "syl.db") });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no stored session/i);
  });

  it("should refuse an empty session file rather than resuming nothing", async () => {
    writeFileSync(join(home, "sessions", "commander"), "   ", "utf8");
    const port = await freePort();

    const result = await compact([], { SYL_PORT: String(port), SYL_DB_PATH: join(home, "syl.db") });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no stored session/i);
  });

  it("should let --dry-run work WITH the service up, since it touches nothing", async () => {
    // Deliberate: the operator wants to see what it would do before stopping
    // her, and a dry run that required downtime would not be consulted.
    writeFileSync(join(home, "sessions", "commander"), "382a8e0d-faae-4713-ad7e-bd45aa671467", "utf8");
    const port = await freePort();
    listener = await listenOn(port);

    const result = await compact(["--dry-run"], { SYL_PORT: String(port), SYL_DB_PATH: join(home, "syl.db") });

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/nothing was sent/i);
    expect(result.stdout).toMatch(/382a8e0d-faae-4713-ad7e-bd45aa671467/);
    expect(result.stdout).not.toMatch(/Compacting\./);
  });

  it("should name the database it resolved, and where that answer came from", async () => {
    // The trap this closes, found by running the dry run for real: `config.ts`
    // defaults SYL_DB_PATH to the RELATIVE `.syl/syl.db`, so an operator running
    // from the repo silently targets `<repo>/.syl/syl.db`. The first dry run
    // reported "no stored session" for a lane holding 861,739 tokens. Safe
    // direction — and had a `.syl` existed in the repo it would have been the
    // dangerous one: a --resume aimed at somebody else's conversation.
    //
    // So the command prints the path AND its provenance. A path with no source
    // is the confident-and-wrong shape this repo keeps rediscovering.
    writeFileSync(join(home, "sessions", "commander"), "382a8e0d-faae-4713-ad7e-bd45aa671467", "utf8");
    const port = await freePort();

    const result = await compact(["--dry-run"], { SYL_PORT: String(port), SYL_DB_PATH: join(home, "syl.db") });

    expect(result.stdout).toMatch(/database\s+\S/);
    expect(result.stdout).toMatch(/\(from .+\)/);
  });

  it("should let an explicit SYL_DB_PATH OVERRIDE the deployment, never the reverse", async () => {
    // THE REGRESSION, and it cost something real. The first version consulted
    // the launchd plist AFTER reading config, so the plist silently overrode an
    // explicit SYL_DB_PATH. These very tests, pointed at a temp directory,
    // therefore resolved to the REAL database and ran three `/compact` turns
    // against the Commander's live thread. Nothing was lost — the transcript is
    // append-only — but it was an unauthorised rewrite of his conversation
    // performed by a test suite.
    //
    // The invariant: the plist is a FALLBACK for an unset variable, never an
    // override for a set one. Anything that reaches past an explicit
    // instruction is aiming at whichever conversation the machine happens to
    // be running.
    writeFileSync(join(home, "sessions", "commander"), "aaaaaaaa-0000-0000-0000-000000000000", "utf8");
    const port = await freePort();

    const result = await compact(["--dry-run"], { SYL_PORT: String(port), SYL_DB_PATH: join(home, "syl.db") });

    expect(result.stdout).toContain(join(home, "syl.db"));
    expect(result.stdout).not.toContain("com.jmm.syl.core.plist");
    // And it must be pointed at the temp lane, never the real one.
    expect(result.stdout).toContain("aaaaaaaa-0000-0000-0000-000000000000");
    expect(result.stdout).not.toContain("382a8e0d");
  });

  it("should state the append-only guarantee where the operator will read it", async () => {
    writeFileSync(join(home, "sessions", "commander"), "382a8e0d-faae-4713-ad7e-bd45aa671467", "utf8");
    const port = await freePort();

    const result = await compact(["--dry-run"], { SYL_PORT: String(port), SYL_DB_PATH: join(home, "syl.db") });

    expect(result.stdout).toMatch(/append-only/i);
    expect(result.stdout).toMatch(/session id does not change/i);
  });
});
