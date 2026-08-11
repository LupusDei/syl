import { describe, it, expect } from "vitest";

import { resolveClaudeBin, type ResolveDeps } from "../../src/harness/claude-bin.js";

function deps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    env: {},
    home: "/Users/test",
    exists: () => false,
    ...overrides,
  };
}

describe("resolveClaudeBin", () => {
  it("should honor an explicit CLAUDE_BIN override above everything else", () => {
    const resolved = resolveClaudeBin(
      deps({
        env: { CLAUDE_BIN: "/custom/claude", PATH: "/usr/bin" },
        exists: (p) => p === "/custom/claude" || p === "/usr/bin/claude",
      }),
    );
    expect(resolved).toBe("/custom/claude");
  });

  it("should reject a CLAUDE_BIN that does not exist rather than failing later with ENOENT", () => {
    expect(() =>
      resolveClaudeBin(deps({ env: { CLAUDE_BIN: "/nope/claude" } })),
    ).toThrow(/CLAUDE_BIN/);
  });

  it("should find the binary on PATH when it is there", () => {
    const resolved = resolveClaudeBin(
      deps({
        env: { PATH: "/usr/bin:/usr/local/bin" },
        exists: (p) => p === "/usr/local/bin/claude",
      }),
    );
    expect(resolved).toBe("/usr/local/bin/claude");
  });

  it("should prefer the earliest PATH entry, matching shell resolution order", () => {
    const resolved = resolveClaudeBin(
      deps({
        env: { PATH: "/first:/second" },
        exists: (p) => p === "/first/claude" || p === "/second/claude",
      }),
    );
    expect(resolved).toBe("/first/claude");
  });

  it("should fall back to the standard install location when PATH does not include it", () => {
    // This is the real failure: ~/.local/bin is on PATH under zsh but not bash,
    // so the same machine works in one shell and throws ENOENT in the other.
    const resolved = resolveClaudeBin(
      deps({
        env: { PATH: "/usr/bin" },
        exists: (p) => p === "/Users/test/.local/bin/claude",
      }),
    );
    expect(resolved).toBe("/Users/test/.local/bin/claude");
  });

  it("should find a Homebrew install on Apple Silicon", () => {
    const resolved = resolveClaudeBin(
      deps({ env: {}, exists: (p) => p === "/opt/homebrew/bin/claude" }),
    );
    expect(resolved).toBe("/opt/homebrew/bin/claude");
  });

  it("should tolerate a missing PATH entirely instead of crashing", () => {
    const resolved = resolveClaudeBin(
      deps({ env: {}, exists: (p) => p === "/Users/test/.local/bin/claude" }),
    );
    expect(resolved).toBe("/Users/test/.local/bin/claude");
  });

  it("should throw an actionable error naming what it tried when nothing is found", () => {
    // A bare ENOENT tells the user nothing. The message must say what was
    // searched and how to fix it.
    let message = "";
    try {
      resolveClaudeBin(deps({ env: { PATH: "/usr/bin" } }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/could not find the `claude`/i);
    expect(message).toMatch(/CLAUDE_BIN/);
    expect(message).toMatch(/\/usr\/bin/); // reports the PATH it searched
    expect(message).toMatch(/\.local\/bin/); // and the fallbacks
  });
});
