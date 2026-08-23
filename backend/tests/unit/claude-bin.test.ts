import { describe, it, expect } from "vitest";

import {
  RealBinaryUnderTestError,
  refuseRealBinaryUnderTest,
  resolveClaudeBin,
  resolveClaudeBinFromProcess,
  type ResolveDeps,
} from "../../src/harness/claude-bin.js";

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

/**
 * THE REAL BINARY MUST NEVER BE REACHABLE FROM A TEST — `syl-2vml`.
 *
 * Measured on 2026-08-23: `us2-he-can-talk-to-her` left ELEVEN live
 * `/Users/Reason/.local/bin/claude` child processes behind it, `killed=false`,
 * still running when the next file started in the same serial fork. They were
 * the residue starving `us6b` into a 120s timeout, and every one of them was a
 * real turn on the Commander's subscription.
 *
 * `tests/helpers/live-service.ts` already stated the rule — "what it must never
 * do is find the real CLI: that costs money, needs a login, and is not
 * deterministic" — and the rule was enforced by a helper remembering to pass
 * `claudeBin`. Forty-three of forty-six `startLiveService` calls did not, and
 * read as though they spawned nothing because they injected a `runner`; the
 * runner covers the conversation turn and the EXTRACTION turn goes out behind
 * it, through `runReaderTurn`, resolving the binary for itself.
 *
 * So the rule moves to the chokepoint. A guard you have to remember to switch
 * on is not a guard — written down twice already in this repository, about the
 * reader's auto-memory and about its tool surface. This is the third.
 */
describe("refusing the real binary under test", () => {
  it("should refuse when vitest is running", () => {
    expect(() => refuseRealBinaryUnderTest({ VITEST: "true" })).toThrow(RealBinaryUnderTestError);
  });

  it("should refuse under NODE_ENV=test too, for a runner that is not vitest", () => {
    expect(() => refuseRealBinaryUnderTest({ NODE_ENV: "test" })).toThrow(
      RealBinaryUnderTestError,
    );
  });

  it("should say what to do about it, because the fix is a one-line helper change", () => {
    let message = "";
    try {
      refuseRealBinaryUnderTest({ VITEST: "true" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // The error is read by whoever wrote the test that tripped it, and the
    // useful thing to tell them is which seam to pass a fake through.
    expect(message).toMatch(/claudeBin/);
    expect(message).toMatch(/fake/i);
  });

  it("should NOT refuse a real run, which is the whole point of the binary existing", () => {
    expect(() => refuseRealBinaryUnderTest({})).not.toThrow();
    expect(() => refuseRealBinaryUnderTest({ NODE_ENV: "production" })).not.toThrow();
  });

  it("should refuse EVEN WHEN CLAUDE_BIN is set, because an override is not permission", () => {
    // CLAUDE_BIN points at a real, working CLI — that is what it is for. Under
    // test, honouring it would reopen the hole for anyone whose shell exports
    // one, which is most developer machines and was this very agent's.
    expect(() =>
      refuseRealBinaryUnderTest({ VITEST: "true", CLAUDE_BIN: "/usr/local/bin/claude" }),
    ).toThrow(RealBinaryUnderTestError);
  });

  it("should be what `resolveClaudeBinFromProcess` actually calls", () => {
    // The pure resolver stays pure and its own tests keep injecting deps; the
    // guard belongs on the ONE function that reaches the real process.
    expect(() => resolveClaudeBinFromProcess()).toThrow(RealBinaryUnderTestError);
  });
});
