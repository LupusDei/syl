import { homedir } from "node:os";
import { sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUTO_MEMORY_ENV_VAR,
  AUTO_MEMORY_INDEX,
  AUTO_MEMORY_INDEX_MAX_BYTES,
  AUTO_MEMORY_INDEX_MAX_LINES,
  AUTO_MEMORY_MAX_BYTES,
  DEFAULT_AUTO_MEMORY_PATH,
  assertAutoMemory,
  autoMemoryAt,
  autoMemoryDirectoryFromEnv,
  autoMemoryOff,
  autoMemorySettings,
  autoMemorySettingsFlag,
  AutoMemoryMismatchError,
  AutoMemoryPathError,
  resolveAutoMemoryPath,
} from "../../src/memory/auto-memory.js";
import { parseEvent, type InitEvent } from "../../src/harness/protocol.js";
import { loadFixture } from "../helpers/fake-claude.js";

/**
 * The directory baked into the `auto-memory-redirect` capture. Taken from the
 * real init frame, not chosen: it is what Claude Code 2.1.226 reported back
 * when handed that path via `--settings`.
 */
const CAPTURED_DIR =
  "/private/tmp/claude-501/-Users-Reason-code-ai-syl-worktrees-tassadar/" +
  "ab05b64b-ab6e-4026-b375-52e73da96203/scratchpad/memtest/sylmem";

/** Pull the init event out of a captured transcript. */
function initOf(fixture: "auto-memory-redirect" | "auto-memory-disabled" | "turn-pong"): InitEvent {
  for (const line of loadFixture(fixture)) {
    const event = parseEvent(line);
    if (event?.kind === "init") return event;
  }
  throw new Error(`fixture ${fixture} has no init event`);
}

describe("auto-memory captures", () => {
  it("should report the requested directory back on the init frame, with a trailing separator", () => {
    // The whole design rests on this field existing and being trustworthy.
    expect(initOf("auto-memory-redirect").autoMemoryPath).toBe(`${CAPTURED_DIR}/`);
  });

  it("should omit memory_paths entirely when auto-memory was switched off", () => {
    expect(initOf("auto-memory-disabled").autoMemoryPath).toBeUndefined();
    // Same capture, reader shape: no tools either.
    expect(initOf("auto-memory-disabled").tools).toEqual([]);
  });

  it("should show an unredirected turn landing in the CLI's own project directory", () => {
    // `turn-pong` predates this work, so it is the control: no setting was
    // passed and memory went to ~/.claude/projects/<sanitised-cwd>/memory/.
    expect(initOf("turn-pong").autoMemoryPath).toMatch(/\/\.claude\/projects\/.*\/memory\/$/);
  });
});

describe("resolveAutoMemoryPath", () => {
  it("should return an absolute path unchanged apart from its trailing separator", () => {
    expect(resolveAutoMemoryPath("/srv/syl/memory/")).toBe("/srv/syl/memory");
  });

  it("should resolve a relative path against the cwd rather than passing it on", () => {
    // The landmine this function exists for: Claude Code discards a relative
    // `autoMemoryDirectory` silently and writes to its own default instead.
    expect(resolveAutoMemoryPath(".syl/memory", "/srv/syl")).toBe("/srv/syl/.syl/memory");
  });

  it("should expand a leading ~/ to the home directory", () => {
    expect(resolveAutoMemoryPath("~/syl-memory")).toBe(`${homedir()}${sep}syl-memory`);
  });

  it("should refuse a blank value rather than fall back to a default nobody asked for", () => {
    expect(() => resolveAutoMemoryPath("   ")).toThrow(AutoMemoryPathError);
  });

  it("should refuse a path containing a NUL byte", () => {
    // A NUL truncates at the syscall boundary, so the path is never what it reads as.
    expect(() => resolveAutoMemoryPath("/srv/syl\0/memory")).toThrow(AutoMemoryPathError);
  });

  it("should collapse . and .. rather than hand the CLI a path it would normalise differently", () => {
    expect(resolveAutoMemoryPath("/srv/syl/../syl/./memory")).toBe("/srv/syl/memory");
  });
});

describe("autoMemoryDirectoryFromEnv", () => {
  it("should default to .syl/memory, resolved against the cwd", () => {
    expect(autoMemoryDirectoryFromEnv({}, "/srv/syl")).toBe(`/srv/syl/${DEFAULT_AUTO_MEMORY_PATH}`);
  });

  it("should honour SYL_AUTO_MEMORY_DIR when it is set", () => {
    expect(autoMemoryDirectoryFromEnv({ [AUTO_MEMORY_ENV_VAR]: "/var/syl/mem" }, "/srv/syl")).toBe(
      "/var/syl/mem",
    );
  });

  it("should treat an exported-but-empty variable as unset, the way every other setting does", () => {
    expect(autoMemoryDirectoryFromEnv({ [AUTO_MEMORY_ENV_VAR]: "  " }, "/srv/syl")).toBe(
      `/srv/syl/${DEFAULT_AUTO_MEMORY_PATH}`,
    );
  });

  it("should throw rather than accept a value the CLI would discard", () => {
    expect(() => autoMemoryDirectoryFromEnv({ [AUTO_MEMORY_ENV_VAR]: "\0" }, "/srv/syl")).toThrow(
      AutoMemoryPathError,
    );
  });
});

describe("autoMemorySettings", () => {
  it("should state the directory and that memory is on", () => {
    expect(autoMemorySettings(autoMemoryAt("/srv/syl/memory"))).toEqual({
      autoMemoryEnabled: true,
      autoMemoryDirectory: "/srv/syl/memory",
    });
  });

  it("should say memory is off without naming a directory", () => {
    expect(autoMemorySettings(autoMemoryOff())).toEqual({ autoMemoryEnabled: false });
  });

  it("should serialise to the JSON string --settings accepts", () => {
    // `--settings` takes a file path or a JSON string; this is the string form,
    // and it is what the live capture was taken with.
    expect(JSON.parse(autoMemorySettingsFlag(autoMemoryAt("/srv/syl/memory")))).toEqual({
      autoMemoryEnabled: true,
      autoMemoryDirectory: "/srv/syl/memory",
    });
  });
});

describe("assertAutoMemory", () => {
  const init = (autoMemoryPath: string | undefined): InitEvent => ({
    kind: "init",
    sessionId: "s",
    raw: {},
    model: "claude-opus-5",
    apiKeySource: "none",
    tools: [],
    capabilities: [],
    mcpServers: [],
    autoMemoryPath,
  });

  it("should accept the real captured frame for the directory it was asked for", () => {
    expect(() => assertAutoMemory(initOf("auto-memory-redirect"), autoMemoryAt(CAPTURED_DIR))).not.toThrow();
  });

  it("should accept a reported path that differs only by its trailing separator", () => {
    expect(() => assertAutoMemory(init("/srv/syl/memory/"), autoMemoryAt("/srv/syl/memory"))).not.toThrow();
  });

  it("should throw when the CLI silently fell back to its own default directory", () => {
    // Exactly the observed failure for a relative setting: no warning, no
    // non-zero exit, just a different directory.
    expect(() =>
      assertAutoMemory(init("/Users/x/.claude/projects/-srv-syl/memory/"), autoMemoryAt("/srv/syl/memory")),
    ).toThrow(AutoMemoryMismatchError);
  });

  it("should throw when memory was asked for and the CLI reported none at all", () => {
    expect(() => assertAutoMemory(init(undefined), autoMemoryAt("/srv/syl/memory"))).toThrow(
      /no memory directory at all/,
    );
  });

  it("should accept an absent memory path when the turn asked for memory to be off", () => {
    expect(() => assertAutoMemory(initOf("auto-memory-disabled"), autoMemoryOff())).not.toThrow();
  });

  it("should throw when a turn that asked for no memory got one anyway", () => {
    // This is the reader turn's guarantee. Untrusted text must not reach a
    // writable store, and `turn-pong` is a real frame that carries one.
    expect(() => assertAutoMemory(initOf("turn-pong"), autoMemoryOff())).toThrow(AutoMemoryMismatchError);
  });

  it("should carry both paths on the error, so the message can say what moved", () => {
    try {
      assertAutoMemory(init("/elsewhere/memory/"), autoMemoryAt("/srv/syl/memory"));
      expect.unreachable("expected a mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(AutoMemoryMismatchError);
      expect((error as AutoMemoryMismatchError).expected).toBe("/srv/syl/memory");
      expect((error as AutoMemoryMismatchError).actual).toBe("/elsewhere/memory/");
    }
  });
});

describe("the CLI's own limits", () => {
  it("should record the index name and load budget read out of Claude Code 2.1.226", () => {
    expect(AUTO_MEMORY_INDEX).toBe("MEMORY.md");
    expect(AUTO_MEMORY_INDEX_MAX_LINES).toBe(200);
    expect(AUTO_MEMORY_INDEX_MAX_BYTES).toBe(25_000);
  });

  it("should put the hard ceiling at four times the load budget", () => {
    // Compaction is refusal: past this the CLI errors the write and the model
    // has to rewrite the index smaller. Consolidation has to fit under it.
    expect(AUTO_MEMORY_MAX_BYTES).toBe(100_000);
  });
});
