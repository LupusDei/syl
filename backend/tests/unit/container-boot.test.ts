import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LANES, LANES_WITH_HANDS } from "../../src/harness/agent.js";
import type { TurnOptions, TurnRunner } from "../../src/harness/session.js";
import { bootstrap, sylHome } from "../../src/index.js";
import { ContainerViolationError, describeContainer } from "../../src/ops/container.js";
import { toolConfigPath } from "../../src/tools/config.js";
import { silentRunner, testConfig } from "../helpers/service.js";

const dirs: string[] = [];
const closers: Array<() => void> = [];

/** A temp directory standing in for `~/.syl`, with a database path inside it. */
function home(): { readonly dir: string; readonly databasePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "syl-boot-"));
  dirs.push(dir);
  return { dir, databasePath: join(dir, "syl.db") };
}

/** A runner that records the options each turn was given, and answers nothing. */
function recordingRunner(): { readonly runner: TurnRunner; readonly seen: TurnOptions[] } {
  const seen: TurnOptions[] = [];
  const runner = vi.fn<TurnRunner>((prompt, options) => {
    seen.push(options);
    return silentRunner(prompt, options);
  });
  return { runner, seen };
}

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The MCP surface each lane is **meant** to reach, stated rather than inferred.
 *
 * `Record` over the lane names on purpose: adding a lane to `LANES` does not
 * compile until it has an entry here, so a new place Syl thinks from cannot
 * inherit a decision nobody made. That is exactly how the heartbeat and the
 * agenda ended up waking her in the source repository.
 *
 * Every lane was `undefined` and two of them no longer are. `syl-009.3.3` gives
 * her hands as a **narrow, named** MCP surface (`remind_me`, not `Bash`): she
 * loses the engineer's built-ins and gains an assistant's verbs. Each lane that
 * gets it changed its entry here, in one visible line with a reason attached,
 * and every other lane still fails if a surface appears.
 *
 * A function of her home rather than a literal path, because the whole claim is
 * that the declaration lives **under her home** — a constant would have to be
 * either a path in the source tree, which is the thing this is defending
 * against, or a value copied from the implementation, which asserts that the
 * implementation equals itself. The config path is also checked by
 * `assertContainer` at boot; this is the same rule at the lane.
 */
const INTENDED_MCP: Readonly<
  Record<(typeof LANES)[keyof typeof LANES], ((home: string) => string) | undefined>
> = {
  // HER HANDS. The Commander's own conversation.
  commander: toolConfigPath,
  // AND THE HOURLY SELF-PING, which is a second, deliberate entry rather than a
  // relaxation of the first. The Commander asked for an hour that "wakes her up
  // and lets her decide what to do, so she might generate one of these videos",
  // and an hour that could not act would be an hour that could only report to
  // nobody. It is the SAME declaration the commander lane gets — one narrow
  // named surface, not a second one nobody reviewed.
  //
  // What keeps the widening narrow lives in `jobs/heartbeat-job.ts` rather than
  // here: one turn an hour, at most two reachings a day counted in his zone and
  // never banked, and — the part that protects his sleep — no heartbeat turn
  // ever records words as HIS, so `harness/urgency.ts` has nothing to verify an
  // urgency claim against and the Outbox holds everything until the window ends.
  heartbeat: toolConfigPath,
  // AND THE MORNING BRIEF, which is the third entry and the least surprising
  // of them. This lane's whole job is to compose his day and put it where he
  // will find it before the 07:00 note announces it; a brief she could not
  // file would exist only in a run record nobody reads, which is the state
  // `jobs/agenda-job.ts` was written to end. Same declaration again — one
  // narrow named surface, not a third one nobody reviewed.
  agenda: toolConfigPath,
  // AND THE RENDER REVIEW, the fourth entry and the narrowest of them: the lane
  // exists for one decision, and the decision is a verb. The Commander's
  // ruling, 2026-08-11 — the push must not go out before the video exists, so
  // she is woken minutes after starting a render to look at the finished clip
  // and decide whether he should have it. A review turn without `show_him`
  // could judge a render and then do nothing about the judgement, which is the
  // state `jobs/render-review-job.ts` was written to end. Same declaration
  // again — one narrow named surface, not a fourth one nobody reviewed.
  //
  // What keeps it narrow lives in that job rather than here: every wake is
  // caused by a render she herself started, is about that one render, spends
  // one turn, is bounded in how many times it may recur, and counts against
  // the same daily ceiling the hourly self-ping spends from.
  studio: toolConfigPath,
  // Still nothing: the dream must not be able to write a reminder while judging
  // what matters.
  consolidation: undefined,
  // The extraction turn reads a conversation, and a conversation is untrusted
  // the moment he pastes an article into it. It is a READER turn — no built-ins
  // AND no MCP — and it must stay that way for a reason sharper than the other
  // lanes: a reader's output is consumed once, but an extracted fact becomes
  // preamble on every later turn. This entry must never become a path.
  extraction: undefined,
};

describe("bootstrap — the container", () => {
  describe.each(Object.values(LANES))("the %s lane", (lane) => {
    it("should take its turns in her home", async () => {
      // `cwd` decides which CLAUDE.md she reads, and therefore who she thinks
      // she is. It is the half of the container that produced the original
      // failure.
      const { dir, databasePath } = home();
      const { runner, seen } = recordingRunner();
      const built = bootstrap(testConfig({ databasePath }), { runner });
      closers.push(() => built.database.close());

      await built.agent.forLane(lane).ask("who are you?");

      expect(seen).toHaveLength(1);
      expect(seen[0]?.cwd).toBe(dir);
    });

    it("should never let a turn run in the directory the service was launched from", async () => {
      // The failure stated directly. `process.cwd()` is this repository when
      // launchd starts the service, and a turn that inherits it reads an
      // engineering brief before it reads SOUL.md.
      const { databasePath } = home();
      const { runner, seen } = recordingRunner();
      const built = bootstrap(testConfig({ databasePath }), { runner });
      closers.push(() => built.database.close());

      await built.agent.forLane(lane).ask("who are you?");

      expect(seen[0]?.cwd).not.toBe(process.cwd());
      expect(seen[0]?.cwd).not.toBeUndefined();
    });

    it("should carry no built-in tools", async () => {
      // The line that must never relax. Built-ins are Bash, Read, Edit, Write,
      // Task — a coding agent's hands. Everything Syl owns runs through this
      // service, so her turns need to think and speak, not act on the machine.
      //
      // On its own this is NOT an empty tool surface, which is why it is its
      // own assertion. Measured 2026-08-10: without `--tools`, 29 built-ins and
      // 59 MCP tools; with `--tools ""`, 0 built-ins and **the same 59 MCP
      // tools**, server still reporting connected. `--tools` governs the
      // built-ins and nothing else. A single "she has no tools" assertion would
      // pass today and mean nothing the moment a server is attached.
      const { databasePath } = home();
      const { runner, seen } = recordingRunner();
      const built = bootstrap(testConfig({ databasePath }), { runner });
      closers.push(() => built.database.close());

      await built.agent.forLane(lane).ask("who are you?");

      expect(seen[0]?.tools).toBe("");
    });

    it("should reach exactly the MCP surface this lane was meant to reach", async () => {
      // The other half, and a separate mechanism: `--strict-mcp-config` decides
      // whether ambient servers attach, `--mcp-config` names the one that does.
      // Stated per lane so this test does not have to be loosened when `syl-009`
      // hands her a narrow named surface — loosening it is how it would end up
      // in a shape that also passes with `Bash` attached.
      const { dir, databasePath } = home();
      const { runner, seen } = recordingRunner();
      const built = bootstrap(testConfig({ databasePath }), { runner });
      closers.push(() => built.database.close());

      await built.agent.forLane(lane).ask("who are you?");

      // Never inherited: without this, every turn picks up whatever MCP servers
      // this machine happens to have. Asked to say hello on her first live turn,
      // Syl answered through `mcp__adjutant__send_message` — development
      // tooling — because it was simply there, and the reply never reached the
      // Commander's phone.
      expect(seen[0]?.strictMcpConfig).toBe(true);
      expect(seen[0]?.mcpConfig).toBe(INTENDED_MCP[lane]?.(dir));
    });

    it("should carry the path to her hands and never their contents", async () => {
      // `syl-009.6`. Which lane gets a declaration is settled above and in
      // `tests/integration/mcp-config-wiring.test.ts`; this is the separate
      // question of what travels with it. The commander lane is handed a
      // **path**, and the credential stays in a `0600` file that Claude Code
      // reads when it starts the server — so a turn's options, which are the
      // thing assembled from a prompt and logged and passed around, never hold
      // the one string that can write the Commander's reminders.
      //
      // Swept over the whole options object rather than field by field: the
      // leak worth catching is the one somebody adds to a field this test does
      // not know about.
      const { databasePath } = home();
      const { runner, seen } = recordingRunner();
      const built = bootstrap(testConfig({ databasePath }), { runner });
      closers.push(() => built.database.close());

      await built.agent.forLane(lane).ask("who are you?");

      expect(built.agentKey.token).not.toBe("");
      expect(JSON.stringify(seen[0] ?? {})).not.toContain(built.agentKey.token);
    });

    it("should load none of this machine's settings, hooks or plugins", async () => {
      // The third door, and the one still open after `cwd` and `tools` were
      // fixed. Hooks and plugins are not read from the working directory, so
      // moving her home did nothing to them: measured on 2.1.226, a turn in
      // `~/.syl` with an empty built-in surface still had `bd prime` and an
      // "Adjutant Agent Protocol" document injected at SessionStart, from the
      // user-level settings and an installed plugin.
      const { databasePath } = home();
      const { runner, seen } = recordingRunner();
      const built = bootstrap(testConfig({ databasePath }), { runner });
      closers.push(() => built.database.close());

      await built.agent.forLane(lane).ask("who are you?");

      expect(seen[0]?.settingSources).toBe("");
    });
  });

  it("should refuse to boot when her home holds a CLAUDE.md", () => {
    // The whole bead in one assertion: a future change that drops project
    // instructions into her home stops the service instead of quietly handing
    // her a new personality.
    const { dir, databasePath } = home();
    writeFileSync(join(dir, "CLAUDE.md"), "# You are an engineer on this codebase.");

    expect(() => bootstrap(testConfig({ databasePath }), { runner: silentRunner })).toThrow(
      ContainerViolationError,
    );
  });

  it("should refuse before it opens the database", () => {
    // A service that opens a store, binds a port and only then declines is a
    // service somebody restarts until it works. It must not get that far — and
    // a WAL left behind by a refused boot is a file handle per attempt.
    const { dir, databasePath } = home();
    mkdirSync(join(dir, ".beads"), { recursive: true });

    expect(() => bootstrap(testConfig({ databasePath }), { runner: silentRunner })).toThrow(
      ContainerViolationError,
    );
    // `openDatabase` would have created it.
    expect(() => rmSync(databasePath)).toThrow();
  });

  it("should start normally in a home that holds only her data", () => {
    const { dir, databasePath } = home();
    writeFileSync(join(dir, "cert-status.json"), "{}");
    mkdirSync(join(dir, "sessions"), { recursive: true });

    const built = bootstrap(testConfig({ databasePath }), { runner: silentRunner });
    closers.push(() => built.database.close());

    expect(built.deps.keys).toBeDefined();
  });

  it("should skip the check for an in-memory store, which is a test", () => {
    // There is no home then, `cwd` stays at `process.cwd()` — this repository —
    // and asserting would fail every test in the suite over a container that
    // does not exist.
    const built = bootstrap(testConfig({ databasePath: ":memory:" }), { runner: silentRunner });
    closers.push(() => built.database.close());

    expect(sylHome(testConfig({ databasePath: ":memory:" }))).toBeUndefined();
  });
});

describe("describeContainer", () => {
  const HOME = "/Users/Reason/.syl";
  /** What `toolConfigPath` resolves to, as a value this file states for itself. */
  const HANDS = toolConfigPath(HOME);

  it("should name the directory her turns run in", () => {
    // The line that did not exist. Where she thinks was inferable from a
    // launchd plist and written down nowhere, so the first person to notice she
    // was living in the repo was the Commander, from her own answer.
    expect(describeContainer(HOME, undefined).join("\n")).toContain(HOME);
  });

  it("should be exactly one line", () => {
    // Once per boot. A container that announces itself twice is noise, and
    // noise at startup is what nobody reads.
    expect(describeContainer(HOME, undefined)).toHaveLength(1);
    expect(describeContainer(HOME, HANDS)).toHaveLength(1);
  });

  it("should warn, and name the launch directory, when there is no home", () => {
    const [line] = describeContainer(undefined, undefined);

    expect(line).toContain("WARNING");
    expect(line).toContain(process.cwd());
  });

  it("should say something DIFFERENT about her hands when she has been given some", () => {
    // The assertion that makes the notice a function of the configuration
    // rather than a second statement of it, and the only shape of test that
    // could have caught `syl-009.9`.
    //
    // The line used to end "no MCP" as a constant. `syl-009.3` handed the
    // commander lane a declaration and the constant did not move, so on the
    // morning the config was written the boot printed, in the same second, that
    // she had no MCP. A test naming today's string would have gone green
    // through exactly that — which is why this one names no string at all and
    // asserts only that the two configurations cannot print the same line.
    expect(describeContainer(HOME, HANDS)[0]).not.toBe(describeContainer(HOME, undefined)[0]);
  });

  it("should claim no MCP only when no declaration was resolved", () => {
    // The claim itself, in both directions. "no MCP" is a security property and
    // it must be printed when, and only when, it is true.
    expect(describeContainer(HOME, undefined)[0]).toContain("no MCP");
    expect(describeContainer(HOME, HANDS)[0]).not.toContain("no MCP");
  });

  it("should name the declaration she was actually given", () => {
    // The path, because the next question after "she has MCP" is "from where",
    // and the whole argument in `tools/config.ts` is that the answer is under
    // her home rather than in a checked-out branch. A notice that says "some
    // MCP" answers nothing.
    expect(describeContainer(HOME, HANDS)[0]).toContain(HANDS);
  });

  it("should name every lane that has a surface, and no lane that does not", () => {
    // "no MCP" and "MCP on two lanes of five" are different security postures,
    // and so are "MCP on two lanes" and "MCP". Somebody debugging why she did
    // something reads this line to decide whether she could have; a notice that
    // reported the service as tooled would send them looking in the wrong
    // place just as surely as one that reported it as untooled.
    //
    // Derived from `LANES_WITH_HANDS` rather than naming today's two, because
    // the failure worth catching is the notice that did not move when the list
    // did — which is exactly what happened when the heartbeat was given hands
    // and the line went on saying "the commander lane ONLY and no other".
    const [line] = describeContainer(HOME, HANDS);

    for (const lane of LANES_WITH_HANDS) expect(line).toContain(lane);
    for (const lane of Object.values(LANES)) {
      if (LANES_WITH_HANDS.includes(lane)) continue;
      expect(line, `${lane} has no hands and must not be named as if it had`).not.toContain(lane);
    }
    expect(line).toMatch(/lane/i);
  });

  it("should be derived from the declaration the commander lane is actually given", async () => {
    // The loop closed. The tests above prove the notice tracks its argument;
    // this proves the argument is the same value the turn carries, so there is
    // no third place for the two to disagree.
    const { dir, databasePath } = home();
    const { runner, seen } = recordingRunner();
    const built = bootstrap(testConfig({ databasePath }), { runner });
    closers.push(() => built.database.close());

    await built.agent.forLane(LANES.commander).ask("who are you?");

    expect(built.hands).toBe(seen[0]?.mcpConfig);
    expect(describeContainer(dir, built.hands)[0]).toContain(toolConfigPath(dir));
  });
});
