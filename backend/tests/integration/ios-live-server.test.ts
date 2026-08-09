import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
 * `npm test` should do on a machine without Xcode. It is wired into
 * `ios/scripts/test.sh` territory rather than the unit gate, and the report from
 * running it is in the beads.
 *
 * ```sh
 * SYL_IOS_LIVE=1 npx vitest run backend/tests/integration/ios-live-server.test.ts
 * ```
 */

const SYLKIT = fileURLToPath(new URL("../../../ios/SylKit", import.meta.url));
const ENABLED = process.env["SYL_IOS_LIVE"] === "1";

/** The one case that touches `URLSessionWebSocketConnector`. */
const SOCKET_TEST = "testShouldCompleteTheHandshakeAgainstTheRealSocket";
/**
 * Everything that is not the socket case.
 *
 * `--skip` takes a regex, and a negative lookahead is the only way to say "run
 * exactly one of these" without listing the other nine and having the list rot
 * the moment somebody adds a tenth.
 */
const EVERY_HTTP_TEST = `LiveServerTests/(?!${SOCKET_TEST})`;

interface SwiftRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run `swift test` against the package, with the live service's coordinates. */
function runSwiftTests(syl: LiveService, options: { readonly skip?: string } = {}): Promise<SwiftRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "swift",
      [
        "test",
        "--package-path",
        SYLKIT,
        "--filter",
        "LiveServerTests",
        ...(options.skip === undefined ? [] : ["--skip", options.skip]),
      ],
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
    const run = await runSwiftTests(syl, { skip: SOCKET_TEST });
    const output = `${run.stdout}\n${run.stderr}`;

    // A skipped suite is the failure mode that would make this worthless: it
    // means the environment never reached the Swift side and nothing was
    // checked.
    expect(output).not.toContain("was skipped");
    expect(output).toMatch(/Executed [1-9]\d* tests/u);
    expect(run.code, output.slice(-4000)).toBe(0);
  }, 600_000);

  /**
   * `syl-w40` — the socket connector aborts the process.
   *
   * `WebSocketClient` builds its URL by appending `ws` to the base, which keeps
   * the base's `http` scheme; `URLSession.webSocketTask(with:)` raises an
   * Objective-C `NSGenericException` for anything but `ws`/`wss`. An
   * `NSException` is not a Swift `Error`, so the `do/catch` around
   * `connector.connect` does not catch it and the process dies with SIGABRT.
   *
   * Every other socket test in `SylKit` injects a fake `WebSocketConnecting`,
   * so `URLSessionWebSocketConnector` had never run anywhere before this file.
   *
   * Asserted as the specific crash rather than as "it fails", so that fixing
   * the scheme turns this red for the right reason and someone deletes it.
   */
  it("should crash rather than connect, until the scheme is mapped to ws", async () => {
    const run = await runSwiftTests(syl, { skip: EVERY_HTTP_TEST });
    const output = `${run.stdout}\n${run.stderr}`;

    expect(output).toContain("WebSocket tasks can only be created with ws or wss schemes");
    expect(output).toContain("Terminating app due to uncaught exception");
    expect(run.code).not.toBe(0);
  }, 600_000);
});
