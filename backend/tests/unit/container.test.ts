import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContainerViolationError,
  assertContainer,
  inspectContainer,
} from "../../src/ops/container.js";

const homes: string[] = [];

/** A directory that looks like Syl's actual home: data, and nothing that instructs. */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "syl-home-"));
  homes.push(dir);
  writeFileSync(join(dir, "syl.db"), "");
  writeFileSync(join(dir, "cert-status.json"), "{}");
  mkdirSync(join(dir, "sessions"), { recursive: true });
  mkdirSync(join(dir, "certs"), { recursive: true });
  mkdirSync(join(dir, "memory"), { recursive: true });
  return dir;
}

function write(dir: string, relative: string, contents: string): void {
  const path = join(dir, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("inspectContainer", () => {
  it("should find nothing wrong with a directory that holds only her data", () => {
    // The happy path is the one that has to keep working on the Commander's
    // machine every morning. A check that fires on her real home is a check
    // somebody deletes.
    expect(inspectContainer(home())).toEqual([]);
  });

  it("should find nothing wrong with a home that does not exist yet", () => {
    // First boot on a new machine: `sylHome` creates the directory, but nothing
    // guarantees the order, and "it is not there" is the emptiest room there is.
    expect(inspectContainer(join(tmpdir(), "syl-home-that-never-was"))).toEqual([]);
  });

  it("should report every violation at once, not just the first", () => {
    // Whoever hits this is cleaning a directory. Reporting one file at a time
    // turns that into four boots, and by the third they are deleting things
    // without reading why.
    const dir = home();
    write(dir, "CLAUDE.md", "# instructions");
    write(dir, ".mcp.json", "{}");
    mkdirSync(join(dir, ".beads"), { recursive: true });

    const paths = inspectContainer(dir).map((violation) => violation.path);

    expect(paths).toEqual(
      expect.arrayContaining([join(dir, "CLAUDE.md"), join(dir, ".mcp.json"), join(dir, ".beads")]),
    );
    expect(paths).toHaveLength(3);
  });

  it("should say what loads each file and why it matters, not merely that it is banned", () => {
    // The whole point of the message: whoever reads it will not know this
    // history, and "remove CLAUDE.md" without a reason is an instruction to
    // work around the check rather than to understand it.
    const dir = home();
    write(dir, "CLAUDE.md", "# instructions");

    const [violation] = inspectContainer(dir);

    expect(violation?.loads).toMatch(/\S/);
    expect(violation?.why).toMatch(/\S/);
  });
});

describe("assertContainer", () => {
  it("should let her start in a home that holds only her data", () => {
    expect(() => assertContainer(home())).not.toThrow();
  });

  it.each([
    ["CLAUDE.md", "CLAUDE.md", "# You are an engineer on this codebase."],
    ["CLAUDE.local.md", "CLAUDE.local.md", "# local overrides"],
    ["AGENTS.md", "AGENTS.md", "# agent instructions"],
    [".mcp.json", ".mcp.json", '{"mcpServers":{}}'],
  ])("should refuse to boot when her home holds %s", (_label, relative, contents) => {
    const dir = home();
    write(dir, relative, contents);

    expect(() => assertContainer(dir)).toThrow(ContainerViolationError);
    expect(() => assertContainer(dir)).toThrow(relative);
  });

  it("should refuse to boot when her home is a beads workspace", () => {
    // A `.beads` directory in her home means somebody ran `bd init` there —
    // which means somebody is treating the place she thinks in as a project.
    const dir = home();
    mkdirSync(join(dir, ".beads"), { recursive: true });

    expect(() => assertContainer(dir)).toThrow(/\.beads/);
  });

  it("should refuse to boot when .claude/settings.json carries hooks", () => {
    const dir = home();
    write(
      dir,
      ".claude/settings.json",
      JSON.stringify({
        hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "bd prime" }] }] },
      }),
    );

    expect(() => assertContainer(dir)).toThrow(/settings\.json/);
    expect(() => assertContainer(dir)).toThrow(ContainerViolationError);
  });

  it("should allow .claude/settings.json that carries no hooks", () => {
    // The named failure is a hook — a command that runs and injects text into
    // her context. Settings that only set, say, a model are not that, and a
    // check that refuses them refuses something legitimate for no gain.
    const dir = home();
    write(dir, ".claude/settings.json", JSON.stringify({ model: "claude-haiku-4-5", hooks: {} }));

    expect(() => assertContainer(dir)).not.toThrow();
  });

  it("should refuse a .claude/settings.json it cannot parse", () => {
    // Edge case, and the direction of the refusal is the point: a settings file
    // this check cannot read is a settings file it cannot clear. "Probably
    // fine" is the reasoning that put her in the repository.
    const dir = home();
    write(dir, ".claude/settings.local.json", "{ not json");

    expect(() => assertContainer(dir)).toThrow(/settings\.local\.json/);
  });

  it("should refuse subagents, commands and skills planted in her home", () => {
    const dir = home();
    write(dir, ".claude/agents/engineer.md", "# an engineer");
    write(dir, ".claude/commands/ship.md", "# ship it");
    write(dir, ".claude/skills/review/SKILL.md", "# review");

    const message = String(expectThrown(() => assertContainer(dir)));

    expect(message).toContain(join(".claude", "agents"));
    expect(message).toContain(join(".claude", "commands"));
    expect(message).toContain(join(".claude", "skills"));
  });

  it("should ignore an empty .claude directory", () => {
    // Created by something incidental. An empty room is still an empty room.
    const dir = home();
    mkdirSync(join(dir, ".claude"), { recursive: true });

    expect(() => assertContainer(dir)).not.toThrow();
  });

  it("should name the home directory and carry the violations on the error", () => {
    // The error is read by a person at 7am and by `startSyl`'s caller. Both
    // need more than a string: the fields are what a log query can group on.
    const dir = home();
    write(dir, "CLAUDE.md", "# instructions");

    const error = expectThrown(() => assertContainer(dir));

    expect(error).toBeInstanceOf(ContainerViolationError);
    expect((error as ContainerViolationError).home).toBe(dir);
    expect((error as ContainerViolationError).violations).toHaveLength(1);
    expect(error.message).toContain(dir);
  });

  it("should accept an MCP config that lives under her home", () => {
    // `--tools ""` empties the BUILT-INS only: measured 2026-08-10, a turn with
    // the flag reported 0 built-ins and 59 MCP tools, server still connected. So
    // "no tools" is not one property, and her hands — when `syl-009` gives her
    // some — arrive as a narrow named MCP surface rather than as Bash. This is
    // where that surface is allowed to be declared.
    const dir = home();

    expect(() => assertContainer(dir, { mcpConfig: join(dir, "mcp", "hands.json") })).not.toThrow();
  });

  it("should refuse an MCP config that points back into the source tree", () => {
    const dir = home();

    const error = expectThrown(() =>
      assertContainer(dir, { mcpConfig: "/Users/Reason/code/ai/syl/.mcp.json" }),
    );

    expect(error).toBeInstanceOf(ContainerViolationError);
    expect(error.message).toContain("/Users/Reason/code/ai/syl/.mcp.json");
  });

  it("should refuse a relative MCP config, which resolves against whatever cwd happens to be", () => {
    // The same class of silent failure as a relative auto-memory directory: it
    // resolves against a working directory nobody chose, and on the day it
    // resolves into the repository nothing says so.
    const dir = home();

    expect(() => assertContainer(dir, { mcpConfig: "mcp/hands.json" })).toThrow(
      ContainerViolationError,
    );
  });

  it("should refuse an MCP config that escapes her home by traversal", () => {
    const dir = home();

    expect(() => assertContainer(dir, { mcpConfig: join(dir, "..", "elsewhere.json") })).toThrow(
      ContainerViolationError,
    );
  });

  it("should not be fooled by a sibling directory whose name starts the same", () => {
    // `~/.syl-old/.mcp.json` is not under `~/.syl`, and a prefix comparison
    // without a separator says it is.
    const dir = home();

    expect(() => assertContainer(dir, { mcpConfig: `${dir}-old/hands.json` })).toThrow(
      ContainerViolationError,
    );
  });

  it("should explain that this is why she called herself an engineer", () => {
    // Not decoration. The message is the only place the history reaches the
    // person who hits it, and without it the obvious move is to delete the
    // check rather than the file.
    const dir = home();
    write(dir, "CLAUDE.md", "# instructions");

    expect(expectThrown(() => assertContainer(dir)).message).toMatch(/system prompt|engineer/i);
  });
});

/** Run `fn`, require it to throw, and hand back what it threw. */
function expectThrown(fn: () => void): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw, and it did not");
}
