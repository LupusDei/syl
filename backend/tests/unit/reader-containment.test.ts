import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runReaderTurn, type ReaderTurnOptions } from "../../src/harness/reader.js";
import { bootstrap } from "../../src/index.js";
import { mcpToolName } from "../../src/tools/config.js";
import { advertisedToolNames } from "../../src/tools/server.js";
import { flagValue, loadFixture, makeFakeClaude, type FakeClaude } from "../helpers/fake-claude.js";
import { testConfig } from "../helpers/service.js";
import { codeOf, handsAnMcpConfigToATurn, importClosure } from "../helpers/source-scan.js";
import { BACKEND_SRC, sourceFiles } from "../helpers/sql-tables.js";

/**
 * `syl-009.6.1` — **the reader turn's tool surface stays provably empty.**
 *
 * `reader.test.ts` proves the reader has no tools *today*. This file is about
 * keeping that true once `syl-009` puts an MCP server with real capabilities —
 * create a reminder, write a to-do, set a goal — into this same codebase. From
 * that day on, "the reader has no tools" stops being a fact about a flag and
 * becomes a fact about **which modules can reach which**, and a fact of that
 * shape is the kind nobody notices breaking.
 *
 * So most of what follows is structural rather than behavioural. Each assertion
 * is chosen so the property holds **by construction**: not because
 * `runReaderTurn` currently declines to pass an MCP config, but because there is
 * no path by which one could arrive.
 *
 * The companion is `tests/integration/mcp-config-wiring.test.ts`
 * (`syl-009.6.2`), which says the config is handed out from exactly one place.
 * Together: one place gives out the tools, and it is nowhere the reader can see.
 */

const READER_INJECTION = loadFixture("reader-injection");

const fakes: FakeClaude[] = [];

afterEach(() => {
  for (const fake of fakes.splice(0)) fake.cleanup();
});

function replaying(lines: readonly string[]): FakeClaude {
  const fake = makeFakeClaude({ after: lines, exitCode: 0 });
  fakes.push(fake);
  return fake;
}

const READER = resolve(BACKEND_SRC, "harness/reader.ts");
const SESSION = resolve(BACKEND_SRC, "harness/session.ts");

describe("the reader turn cannot be handed an MCP config", () => {
  it("should still spawn with no MCP servers, no tools, no verbs and no credential", async () => {
    // ONE subprocess for the whole file, on purpose. The fake `claude` is a
    // real executable and every test that spawns one costs a process; the suite
    // is measurably load-sensitive (see the note on `testTimeout` in
    // `vitest.shared.ts`), and `us4` and `reader.test.ts` already pay for the
    // plain case. This is the case neither of them covers, and it subsumes the
    // plain one: everything the plain assertion checks is checked here, under a
    // caller actively trying to arm the turn.
    //
    // `runReaderTurn` builds its `TurnOptions` field by field and forwards only
    // `cwd`, `model`, `claudeBin`, `timeoutMs` and `onEvent`. It never spreads
    // the caller's object, so an option it does not know about cannot reach
    // `runTurn` — which is what makes "the reader has no MCP servers" a
    // property of this module rather than of every future caller's good sense.
    //
    // The cast is the test, not a workaround for one: this is what it looks
    // like when someone wires the tools in from the wrong side, whether by
    // accident or because a `syl-009` tool module made it convenient.
    const fake = replaying(READER_INJECTION);
    const smuggled = {
      claudeBin: fake.bin,
      mcpConfig: "/tmp/syl-tools.json",
      strictMcpConfig: false,
      permissionMode: "bypassPermissions",
      tools: "Bash",
    } as unknown as ReaderTurnOptions;

    // A real agent credential, minted the way the service mints one, held by
    // this process for the length of the spawn. `syl-009.6`: "no credential"
    // is only a claim worth testing while one exists to leak.
    const built = bootstrap(testConfig({ databasePath: ":memory:" }));
    let result: Awaited<ReturnType<typeof runReaderTurn>>;
    try {
      result = await runReaderTurn(
        { instruction: "Summarise this.", untrusted: "Some ordinary prose." },
        smuggled,
      );
    } finally {
      built.database.close();
    }

    const invocation = fake.invocation();
    const argv = invocation?.argv ?? [];
    // Not "only ours" — none. An MCP tool is a tool, and a reader turn that
    // could reach `create_reminder` is a reader turn an article can use.
    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("/tmp/syl-tools.json");
    expect(argv).toContain("--strict-mcp-config");
    expect(flagValue(argv, "--tools")).toBe("");
    expect(flagValue(argv, "--permission-mode")).toBe("manual");
    // And the CLI agreed. The flags going out prove what was asked for; this is
    // what came back.
    expect(result.toolSurface).toEqual([]);

    // NO ACTING VERB, anywhere the turn can read. `--tools ""` empties the
    // built-ins only, so "she has no tools" would be satisfied by a turn told
    // in prose that it may call `remind_me` — and the whole failure mode this
    // project keeps meeting is a model acting out an instruction whose
    // capability is absent. The verbs are derived from the surface rather than
    // listed, so a sixth one is covered the day it is declared.
    const everythingTheTurnSaw = [...argv, invocation?.stdin ?? ""].join("\n");
    for (const verb of advertisedToolNames()) {
      expect(everythingTheTurnSaw, `the reader was shown ${verb}`).not.toContain(verb);
      expect(everythingTheTurnSaw).not.toContain(mcpToolName(verb));
    }

    // NO CREDENTIAL. `runTurn` hands the child `process.env` minus the two
    // Anthropic keys, so there are exactly two doors — the argv this call
    // assembled, and the environment this process holds — and both are shut
    // here. The credential's only home is `hands.json`, handed by name to one
    // lane that is not this one.
    expect(everythingTheTurnSaw).not.toContain(built.agentKey.token);
    expect(Object.values(process.env).join("\n")).not.toContain(built.agentKey.token);
  });

  it("should not be able to reach a module that hands an MCP config to a turn", () => {
    const closure = importClosure(READER);

    // The walker really walked: `harness/session.ts` is one hop away, so a
    // closure that has lost it is a closure that would find nothing wherever it
    // was hidden. Without this line the assertion below passes for an empty
    // set, which is the failure mode of every static guard ever written.
    expect(closure).toContain(SESSION);

    const offenders = closure
      // `session.ts` DECLARES the option and turns it into the flag. It is the
      // door; the question this asks is who walks through it.
      .filter((file) => file !== SESSION)
      .filter((file) => handsAnMcpConfigToATurn(codeOf(file)))
      .map((file) => file.slice(BACKEND_SRC.length));

    expect(offenders).toEqual([]);
  });

  it("should not reach the tool modules at all, whatever those modules import", () => {
    // The plan puts the MCP server, its tool definitions and its HTTP client
    // under `backend/src/tools/`. Stated separately from the assertion above
    // because it fails earlier and reads plainer: an import of `tools/` from
    // inside the quarantine is wrong even on the day that module happens to
    // hand out nothing.
    const reachable = importClosure(READER)
      .map((file) => file.slice(BACKEND_SRC.length))
      .filter((file) => file.startsWith("tools/"));

    expect(reachable).toEqual([]);
  });

  it("should not reach the module that mints her credential", () => {
    // `syl-009.6`. The behavioural assertion above says no credential reached
    // one spawn; this says there is no path by which one could. `agent-key.ts`
    // is where an `agent` token comes into existence — `agent-credential.test.ts`
    // proves it is the only such place — so a reader that cannot see it cannot
    // hold one however the code is rearranged.
    const reachable = importClosure(READER)
      .map((file) => file.slice(BACKEND_SRC.length))
      .filter((file) => file === "services/agent-key.ts" || file === "services/api-key-service.ts");

    expect(reachable).toEqual([]);
  });

  it("should keep the empty-surface refusal impossible to switch off inside the service", () => {
    // `requireEmptyToolSurface` exists so a test can reach the checks further
    // down `runReaderTurn`; it is the one option that could make the reader
    // accept a turn which came back holding tools. `connections/intake.ts`
    // already `Omit`s it from the options the ladder accepts, so no caller of
    // intake can set it — this says the same thing about the whole service, in
    // a form that also catches a second reader call site added later.
    // `memory/dream/judge.ts` declares an option of the SAME NAME for its own
    // turns and defaults it to `true` — applying this discipline to the dream,
    // not switching it off for the reader. The scanner matches an identifier
    // and cannot tell those apart, so it is named here with its reason rather
    // than the pattern being loosened until it stops meaning anything.
    const DECLARES_ITS_OWN: readonly string[] = ["memory/dream/judge.ts"];

    const setters = sourceFiles(BACKEND_SRC)
      .filter((file) => /(?<![A-Za-z0-9_])requireEmptyToolSurface\s*[:=]/u.test(codeOf(file)))
      .map((file) => file.slice(BACKEND_SRC.length))
      .filter((file) => !DECLARES_ITS_OWN.includes(file));

    // Strictly stronger than the exclusion above: whatever a file declares, NO
    // file anywhere may set this to false. That is the switch-off this test is
    // named for, and it is checked across every file including the allowed one.
    const disablers = sourceFiles(BACKEND_SRC)
      .filter((file) =>
        /(?<![A-Za-z0-9_])requireEmptyToolSurface\s*[:=]\s*false/u.test(codeOf(file)),
      )
      .map((file) => file.slice(BACKEND_SRC.length));

    expect(disablers).toEqual([]);
    expect(setters).toEqual([]);
  });
});
