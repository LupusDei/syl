import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LANES } from "../../src/harness/agent.js";
import type { TurnOptions, TurnRunner } from "../../src/harness/session.js";
import { bootstrap, sylHome } from "../../src/index.js";
import { ContainerViolationError, describeContainer } from "../../src/ops/container.js";
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
 * Every lane is `undefined` today — no MCP at all. It will not stay that way.
 * `syl-009` gives her hands as a **narrow, named** MCP surface (`remind_me`,
 * not `Bash`): she loses the engineer's built-ins and gains an assistant's
 * verbs. When that lands, the lane that gets it changes its entry here, in one
 * visible line, and every other lane still fails if a surface appears.
 *
 * The config path itself is checked by `assertContainer`: absolute and under
 * her home. A path in the source tree reattaches her to the workshop through
 * the one door left open.
 */
const INTENDED_MCP: Readonly<Record<(typeof LANES)[keyof typeof LANES], string | undefined>> = {
  commander: undefined,
  heartbeat: undefined,
  agenda: undefined,
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
      const { databasePath } = home();
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
      expect(seen[0]?.mcpConfig).toBe(INTENDED_MCP[lane]);
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
  it("should name the directory her turns run in", () => {
    // The line that did not exist. Where she thinks was inferable from a
    // launchd plist and written down nowhere, so the first person to notice she
    // was living in the repo was the Commander, from her own answer.
    expect(describeContainer("/Users/Reason/.syl").join("\n")).toContain("/Users/Reason/.syl");
  });

  it("should be exactly one line", () => {
    // Once per boot. A container that announces itself twice is noise, and
    // noise at startup is what nobody reads.
    expect(describeContainer("/Users/Reason/.syl")).toHaveLength(1);
  });

  it("should warn, and name the launch directory, when there is no home", () => {
    const [line] = describeContainer(undefined);

    expect(line).toContain("WARNING");
    expect(line).toContain(process.cwd());
  });
});
