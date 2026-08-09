import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * The iOS client against the real backend.
 *
 * This is the seam the whole verification pass exists for. `SylKit` was built
 * against `npm run mock`; the backend was built against its own tests. Both are
 * measured against `shared/openapi.yaml`, which is why both are green, and until
 * this file existed the two had never exchanged a byte.
 *
 * What it does: boot a throwaway Syl on a free port with a real on-disk store,
 * pair a device over HTTP, and hand the resulting bearer token to
 * `swift test --filter LiveServerTests`. The Swift side then drives its own
 * `APIClient` and `WebSocketClient` — the code the app ships — at Syl.
 *
 * **Opt-in, behind `SYL_IOS_LIVE=1`.** It needs a Swift toolchain and it builds
 * a package, which is minutes rather than milliseconds and is not something
 * `npm test` should do on a machine without Xcode — the flag exists so the Linux
 * gate can skip it, and for no other reason.
 *
 * ```sh
 * SYL_IOS_LIVE=1 npx vitest run backend/tests/integration/ios-live-server.test.ts
 * ```
 *
 * **Where it actually runs** (`syl-e4f`; for a year it ran nowhere at all, and
 * three of the four open iOS P0s came out of its first execution):
 *
 * - `ios/scripts/test.sh`, so a human running the iOS suite runs this too;
 * - `.github/workflows/ios.yml`, which runs that script, for changes under `ios/`;
 * - `.github/workflows/ios-live.yml`, for changes under `backend/` and `shared/` —
 *   the side `ios.yml` does not watch, and the side that drifts.
 *
 * The first case in this file is the guard on all of that. A gate that can be
 * disconnected by deleting one line from one script is not a gate, so the
 * connection is asserted from inside the ordinary unit run, where it holds even
 * on a machine that cannot execute anything below it.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const SYLKIT = fileURLToPath(new URL("../../../ios/SylKit", import.meta.url));
const ENABLED = process.env["SYL_IOS_LIVE"] === "1";

/** The files that are supposed to run this suite, and what makes them count. */
const WIRING: readonly { readonly path: string; readonly why: string }[] = [
  {
    path: "ios/scripts/test.sh",
    why: "the script a human runs, and the one ios.yml runs",
  },
  {
    path: ".github/workflows/ios-live.yml",
    why: "the automated run for backend and shared changes, which ios.yml does not watch",
  },
];

/**
 * A file's executable text: every line with the comments taken off.
 *
 * Both file types here comment with `#`, and both of them **talk about**
 * `SYL_IOS_LIVE` at length in those comments. Searching the raw text would pass
 * on the prose alone — the check would survive the very edit it exists to catch,
 * which is its own entry in the list of tests that cannot fail. Verified by
 * deleting the variable from the command and watching this go red.
 */
function executableText(path: string): string {
  return readFileSync(`${REPO}${path}`, "utf8")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/u, ""))
    .join("\n");
}

describe("the wiring that makes this file run at all", () => {
  // Deliberately outside the `skipIf`. This is the check that would have caught
  // `syl-e4f`, and a check that only runs when the thing it guards is already
  // running is not a check.
  it.each(WIRING)("should be run by $path — $why", ({ path }) => {
    const runnable = executableText(path);

    expect(
      runnable,
      `${path} no longer sets SYL_IOS_LIVE=1 on a command. This file is the only
place shipping Swift meets a real backend, and without that variable it skips
itself and reports success having checked nothing.`,
    ).toContain("SYL_IOS_LIVE=1");
    expect(runnable, `${path} no longer names this suite`).toContain(
      "ios-live-server.test.ts",
    );
  });

  it("should be reachable from a workflow that watches the backend", () => {
    // The drift this suite exists to catch is mostly the service moving under a
    // client that was written from the same document. A gate that only fires on
    // `ios/**` cannot see it.
    const workflow = executableText(".github/workflows/ios-live.yml");

    expect(workflow).toContain("backend/**");
    expect(workflow).toContain("shared/**");
  });
});

/**
 * The two Swift suites, run as two `swift test` invocations.
 *
 * They are separate classes rather than one filtered by a negative lookahead —
 * and separate runs rather than one — because of what a socket failure used to
 * be. `syl-w40` was not a failing connection: `URLSession` raises an
 * Objective-C `NSException` for an `http` socket URL, no Swift `catch` can see
 * it, and the process aborts. An abort takes every other case in the same
 * process with it, so a socket bug would erase the HTTP results too. That is
 * fixed, and the isolation still costs about a second.
 */
const HTTP_SUITE = "LiveServerTests";
/** The only place `URLSessionWebSocketConnector` runs anywhere. */
const SOCKET_SUITE = "LiveSocketTests";

interface SwiftRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run one Swift suite against the package, with the live service's coordinates. */
function runSwiftTests(syl: LiveService, suite: string): Promise<SwiftRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "swift",
      ["test", "--package-path", SYLKIT, "--filter", suite],
      {
        env: {
          ...process.env,
          SYL_LIVE_URL: syl.baseUrl,
          SYL_LIVE_TOKEN: syl.token,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!ENABLED)("the iOS client against the real backend", () => {
  let syl: LiveService;

  beforeAll(async () => {
    syl = await startLiveService({ deviceName: "SylKit live check" });
  }, 30_000);

  afterAll(async () => {
    await syl.close();
  });

  it("should have a SylKit package to drive", () => {
    expect(existsSync(SYLKIT)).toBe(true);
  });

  it("should serve the app's whole HTTP surface, decoded by the app's own models", async () => {
    const run = await runSwiftTests(syl, HTTP_SUITE);
    const output = `${run.stdout}\n${run.stderr}`;

    // A skipped suite is the failure mode that would make this worthless: it
    // means the environment never reached the Swift side and nothing was
    // checked.
    expect(output).not.toContain("was skipped");
    expect(output).toMatch(/Executed [1-9]\d* tests/u);
    expect(run.code, output.slice(-4000)).toBe(0);
  }, 600_000);

  /**
   * `syl-w40` — the socket, over the real transport.
   *
   * This ran nowhere at all until the crash it found was fixed: the connector
   * aborted the process, so the case that proves a socket works could not be
   * written. It opens a real `URLSessionWebSocketTask` against the service
   * booted above, completes the handshake, exchanges frames, and loses and
   * regains the transport.
   *
   * The assertions are here rather than only inside Swift because a Swift
   * suite that skips itself exits 0 and looks exactly like one that passed —
   * which is `syl-e4f`, and is why "was skipped" is a failure below.
   */
  it("should open a real socket, complete the handshake and carry frames", async () => {
    const run = await runSwiftTests(syl, SOCKET_SUITE);
    const output = `${run.stdout}\n${run.stderr}`;

    expect(output).not.toContain("was skipped");
    expect(output).toMatch(/Executed [1-9]\d* tests/u);
    // The old failure mode, named so it can never come back quietly: an
    // `NSException` is not a test failure, it is a dead process, and a suite
    // that dies mid-run reports nothing about the cases it never reached.
    expect(output, "the socket connector aborted the process again").not.toContain(
      "Terminating app due to uncaught exception",
    );
    expect(run.code, output.slice(-4000)).toBe(0);
  }, 600_000);
});
