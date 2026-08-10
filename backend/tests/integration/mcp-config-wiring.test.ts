import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LANES, SylAgent, memorySessionStore } from "../../src/harness/agent.js";
import { runTurn, type TurnOptions } from "../../src/harness/session.js";
import { flagValue, loadFixture, makeFakeClaude, type FakeClaude } from "../helpers/fake-claude.js";
import { silentRunner } from "../helpers/service.js";
import { filesHandingAnMcpConfig, handsAnMcpConfigToATurn } from "../helpers/source-scan.js";
import { BACKEND_SRC } from "../helpers/sql-tables.js";

/**
 * `syl-009.6.2` — **one reference to the MCP config, statically enforced.**
 *
 * `syl-009` gives Syl hands: an MCP server that can write reminders, to-dos and
 * goals on the Commander's machine, attached to a turn that already runs
 * `--permission-mode bypassPermissions`. The whole safety argument for that is
 * *which turns get it* — the commander lane, and nothing else.
 *
 * This is not a hypothetical risk, it is a repeat. `--strict-mcp-config` was
 * off once, every turn inherited the repository's own `.mcp.json`, and the
 * Commander caught Syl answering him through `mcp__adjutant__send_message` on
 * her first live turn: the reply never entered her conversation history, never
 * reached his phone, and cost four turns to not arrive. She reached for it
 * because it was there. The note in `harness/agent.ts` ends "if Syl should ever
 * push to Adjutant deliberately, that is a NARROW, named capability handed to a
 * specific lane — not an ambient surface every turn inherits." `syl-009` is the
 * first narrow, named capability. This file is the thing that keeps it narrow.
 *
 * ## How this guards something that does not exist yet
 *
 * The config is written by `syl-009.3.3`, and today nothing anywhere produces
 * one. A guard written against a module name would therefore be a guard written
 * against a guess, and would sit green forever if the module were called
 * something else — the "passes today, never fails tomorrow" defect this project
 * has already paid for once.
 *
 * So the scan is keyed on **`TurnOptions.mcpConfig`**, which exists now and is
 * the only door into `--mcp-config`. Whatever the new module is called, the
 * line that attaches it to a lane has to spell that property, and the moment it
 * does, the expected set below stops matching and this test goes red — which is
 * the intended way to find out, because widening it must be a deliberate edit
 * with a name on it.
 *
 * And because "zero matches" is exactly what a broken scanner also reports, the
 * first test here plants three files and checks the scanner finds the two that
 * are wiring and not the one that is prose.
 */

/**
 * Files allowed to hand an MCP config to a turn.
 *
 * **`harness/session.ts` is not a lane.** It declares `TurnOptions.mcpConfig`
 * and turns it into `--mcp-config`; it is the door, and the door is not the
 * question.
 *
 * Everything else in this list is a lane that has been given hands. There must
 * never be more than one. If you are here because `syl-009.3.3` landed and this
 * test went red, that is this test working: add the one file, keep the list at
 * one entry, and say in a comment which lane it serves and why that lane and no
 * other.
 */
const MAY_HAND_OUT_THE_TOOLS: readonly string[] = [];

/** The module that declares the option. Excluded from the count, never from the code. */
const DECLARES_THE_OPTION = "harness/session.ts";

const fakes: FakeClaude[] = [];
const temps: string[] = [];

afterEach(() => {
  for (const fake of fakes.splice(0)) fake.cleanup();
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

function replaying(): FakeClaude {
  const fake = makeFakeClaude({ after: loadFixture("turn-pong"), exitCode: 0 });
  fakes.push(fake);
  return fake;
}

/** A little tree of source files, for asking the scanner whether it can see. */
function plantedTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "syl-scan-"));
  temps.push(root);
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, "utf8");
  }
  return root + sep;
}

describe("the scanner that enforces it", () => {
  it("should find wiring, in either spelling, and not find prose about it", () => {
    // The load-bearing test in this file while `MAY_HAND_OUT_THE_TOOLS` is
    // empty. Without it, "no file hands out an MCP config" is indistinguishable
    // from "the scanner reads no files", and the guard would be worth nothing
    // on the day it is finally needed.
    const root = plantedTree({
      "harness/lane.ts": [
        'import { runTurn } from "./session.js";',
        "export const ask = async (prompt: string, path: string) =>",
        "  runTurn(prompt, { mcpConfig: path, strictMcpConfig: true });",
      ].join("\n"),
      "harness/by-hand.ts": [
        "export function argv(path: string): string[] {",
        '  return ["--mcp-config", path];',
        "}",
      ].join("\n"),
      "harness/quarantine.ts": [
        "/**",
        " * Runs `--strict-mcp-config` with no `--mcp-config`: no MCP servers at",
        " * all, not merely ours. An MCP tool is a tool.",
        " */",
        "export const strictMcpConfig = true;",
      ].join("\n"),
    });

    expect(filesHandingAnMcpConfig(root)).toEqual(["harness/by-hand.ts", "harness/lane.ts"]);
  });

  it("should not mistake strictMcpConfig for the opposite instruction it is", () => {
    // `strictMcpConfig: true` means "no ambient MCP servers" — the fix for the
    // Adjutant incident, not an instance of it. A scanner matching it as a
    // substring would report every safe turn in the codebase and be turned off
    // within a week.
    expect(handsAnMcpConfigToATurn("runTurn(p, { strictMcpConfig: true })")).toBe(false);
    expect(handsAnMcpConfigToATurn("runTurn(p, { mcpConfig: p2 })")).toBe(true);
  });
});

describe("who may hand an MCP config to a turn", () => {
  it("should be exactly the lanes declared here, and no more than one of them", () => {
    const found = filesHandingAnMcpConfig(BACKEND_SRC).filter(
      (file) => file !== DECLARES_THE_OPTION,
    );

    expect(found).toEqual(MAY_HAND_OUT_THE_TOOLS);
    // Stated on its own so the failure says what the rule is rather than only
    // that a list changed. Two lanes with hands is two places the containment
    // argument has to be made, and the second one is always the one nobody
    // reviewed.
    expect(found.length).toBeLessThanOrEqual(1);
  });

  it("should still be the only module that spells the flag", () => {
    // A caller that assembled argv by hand would bypass `TurnOptions` entirely
    // and every guard hung off it. `session.ts` is the one place `--mcp-config`
    // is allowed to be a string.
    expect(filesHandingAnMcpConfig(BACKEND_SRC)).toContain(DECLARES_THE_OPTION);
  });
});

describe("what a turn gets when it is given one", () => {
  it("should scope the surface to that config alone, without the caller asking", async () => {
    // `runTurn` adds `--strict-mcp-config` whenever `mcpConfig` is set. That is
    // what makes "she was handed the reminder tools" mean "she was handed the
    // reminder tools AND NOTHING ELSE" — rather than the reminder tools plus
    // whatever `.mcp.json` the working directory happens to contain.
    const fake = replaying();
    await runTurn("Anything.", { claudeBin: fake.bin, mcpConfig: "/tmp/syl-tools.json" });

    const argv = fake.invocation()?.argv ?? [];
    expect(flagValue(argv, "--mcp-config")).toBe("/tmp/syl-tools.json");
    expect(argv).toContain("--strict-mcp-config");
  });

  it("should refuse ambient MCP on every lane that was given no config at all", async () => {
    // The Adjutant regression, as an assertion, and it had none: nothing in the
    // suite asserted `strictMcpConfig` on an agent turn before this. `SylAgent`
    // sets it for every lane it runs, so a lane with no tools has no tools —
    // rather than "whatever this machine happens to be configured with".
    //
    // Through a recording runner rather than a fake binary: this is a question
    // about the options `SylAgent` builds, and answering it with a subprocess
    // would spend a process to learn nothing extra. See the note on
    // `testTimeout` in `vitest.shared.ts` for why that restraint matters here.
    const seen: TurnOptions[] = [];
    const agent = new SylAgent({
      store: memorySessionStore(),
      runner: (_prompt, options) => {
        seen.push(options);
        return silentRunner(_prompt, options);
      },
    });

    for (const lane of [LANES.commander, LANES.heartbeat, LANES.agenda, LANES.consolidation]) {
      await agent.ask("Say hello.", lane);
    }

    expect(seen).toHaveLength(4);
    for (const options of seen) {
      expect(options.strictMcpConfig).toBe(true);
      expect(options.mcpConfig).toBeUndefined();
    }
  });
});
