import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { bootstrap } from "../../src/index.js";
import type { LogLevel, Logger } from "../../src/ops/logging.js";
import { testConfig } from "../helpers/service.js";

/**
 * **Her face writes to the log everyone else reads.**
 *
 * ## The failure, which was not a missing line but a missing subsystem
 *
 * On 2026-08-23 two face sessions billed ninety cents on the Commander's phone
 * and neither he nor anyone else could say why. The cause turned out to be on
 * the device — iOS terminated the app four seconds in over an undeclared
 * camera usage — but the reason it took two sessions and a crash report to
 * find is here: **every component of the face defaults its `log` to
 * `console.info`, and `index.ts` passed none of them a logger.**
 *
 * So `face.session.opened`, `face.session.reaped`, `face.rpc.attached`,
 * `face.lane.warmed` and every refusal went to stdout, which launchd captures
 * into `launchd-core.log` — while `syl.log`, and therefore `GET /logs`, the
 * surface an operator and an agent actually read, had nothing about her face in
 * it at all.
 *
 * ## Why this is a boot test and not a unit test
 *
 * Because the defect was never in a component. Every one of them takes a `log`,
 * documents it, and uses it correctly. The defect was that the call site did
 * not pass one — the third instance in this epic of *a complete, unit-tested
 * component whose only fault is its wiring*, which no unit suite can see. The
 * only check that can fail for the right reason is one that boots the real
 * `bootstrap` and asks the object it produced where its lines go.
 */

interface Line {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A logger that keeps its lines instead of writing them. */
function recordingLogger(): { readonly logger: Logger; readonly lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: LogLevel) =>
    (event: string, fields?: Readonly<Record<string, unknown>>): void => {
      lines.push({ level, event, fields });
    };
  return {
    lines,
    logger: {
      log: (level, event, fields) => lines.push({ level, event, fields }),
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      path: "/dev/null",
      close: () => undefined,
    },
  };
}

function boot(): { readonly lines: Line[]; readonly built: ReturnType<typeof bootstrap> } {
  const dir = mkdtempSync(join(tmpdir(), "syl-facelog-"));
  dirs.push(dir);
  const { logger, lines } = recordingLogger();
  const built = bootstrap(testConfig({ databasePath: join(dir, "syl.db") }), {
    logger,
    // A runner, so nothing tries to spawn the real CLI. It also routes past the
    // warm lane, which is irrelevant here and stated so nobody reads the
    // absence of `face.lane.warmed` below as a finding.
    runner: () => {
      throw new Error("no turn is taken in this test");
    },
  });
  closers.push(() => built.database.close());
  return { lines, built };
}

describe("the face's lines reach the structured log", () => {
  it("should send what her face says to the logger, not to stdout", () => {
    const { lines, built } = boot();

    built.deps.face.log("face.probe", { sessionId: "rts_probe" });

    // If `index.ts` stops handing the runtime a logger, every component falls
    // back to `console.info` and this line goes nowhere a person can query.
    const line = lines.find((entry) => entry.event === "face.probe");
    expect(line?.level).toBe("info");
    expect(line?.fields).toMatchObject({ sessionId: "rts_probe" });
  });

  it("should send the loud ones at error, so a stuck reap is findable", () => {
    const { lines, built } = boot();

    built.deps.face.logError("face.probe.failed", { sessionId: "rts_probe" });

    // `face.session.reap_failed` is the line that means a session is STILL
    // BILLING and could not be cut. At `info` among a day of ordinary traffic
    // it is a line nobody sees.
    expect(lines.find((entry) => entry.event === "face.probe.failed")?.level).toBe("error");
  });
});
