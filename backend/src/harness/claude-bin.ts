import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Locate the Claude Code binary.
 *
 * Spawning bare `"claude"` and trusting PATH is not good enough. Claude Code
 * installs to `~/.local/bin`, which is added to PATH by the shell profile —
 * so the same machine resolves it under zsh and fails with ENOENT under bash,
 * depending on which profile the user's terminal loaded. Node's `spawn`
 * inherits whatever PATH it was handed and gives a bare ENOENT with no hint
 * about which of the two problems you have.
 *
 * So: search PATH explicitly, then the known install locations, then fail with
 * a message that says what was tried.
 */
export interface ResolveDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly exists: (path: string) => boolean;
}

/** Standard install locations, in preference order. */
function fallbackLocations(home: string): string[] {
  return [
    join(home, ".local", "bin", "claude"), // official installer default
    join(home, ".claude", "local", "claude"), // older local install layout
    "/opt/homebrew/bin/claude", // Homebrew, Apple Silicon
    "/usr/local/bin/claude", // Homebrew, Intel / manual
    "/usr/bin/claude",
  ];
}

/**
 * Resolve an absolute path to the `claude` binary.
 *
 * @throws if it cannot be found, with a message naming every location searched.
 */
export function resolveClaudeBin(deps: ResolveDeps): string {
  const { env, home, exists } = deps;

  // 1. Explicit override always wins — but verify it, so a typo surfaces here
  //    rather than as an ENOENT from deep inside a spawn.
  const override = env["CLAUDE_BIN"];
  if (override !== undefined && override !== "") {
    if (!exists(override)) {
      throw new Error(
        `CLAUDE_BIN is set to "${override}" but nothing exists at that path.`,
      );
    }
    return override;
  }

  // 2. PATH, in order, so we match what the shell would have done.
  const pathDirs = (env["PATH"] ?? "").split(delimiter).filter((d) => d !== "");
  for (const dir of pathDirs) {
    const candidate = join(dir, "claude");
    if (exists(candidate)) return candidate;
  }

  // 3. Known install locations, for when PATH simply does not have it.
  const fallbacks = fallbackLocations(home);
  for (const candidate of fallbacks) {
    if (exists(candidate)) return candidate;
  }

  throw new Error(
    [
      "Could not find the `claude` binary.",
      "",
      "Searched PATH:",
      ...(pathDirs.length > 0 ? pathDirs.map((d) => `  ${d}`) : ["  (PATH was empty)"]),
      "",
      "Searched standard install locations:",
      ...fallbacks.map((f) => `  ${f}`),
      "",
      "Fix: install Claude Code, or point Syl at it directly:",
      "  CLAUDE_BIN=/full/path/to/claude npm run ping -- 'hello'",
      "",
      "If `which claude` works in your shell but this does not, your shell",
      "profile adds it to PATH for interactive use only — an absolute",
      "CLAUDE_BIN is the reliable fix.",
    ].join("\n"),
  );
}

/** A test reached for the real CLI. See {@link refuseRealBinaryUnderTest}. */
export class RealBinaryUnderTestError extends Error {
  constructor() {
    super(
      [
        "A test tried to resolve the REAL `claude` binary.",
        "",
        "That costs money, needs a login, and is not deterministic — and the",
        "processes are not reliably reaped: on 2026-08-23 one acceptance file",
        "left eleven live `claude` children behind it, which starved the next",
        "file in the same serial fork into a 120-second timeout.",
        "",
        "Fix: give the turn a FAKE binary instead of letting it resolve one.",
        "  - through `startLiveService`, which always supplies a `claudeBin`;",
        "  - or by passing `claudeBin` yourself, from `helpers/fake-claude.ts`.",
        "",
        "Injecting a `runner` is NOT enough. It covers the conversation turn,",
        "and the extraction turn goes out behind it through `runReaderTurn`,",
        "which resolves a binary of its own.",
      ].join("\n"),
    );
    this.name = "RealBinaryUnderTestError";
  }
}

/**
 * Refuse to hand a test the real CLI — `syl-2vml`.
 *
 * The rule already existed, in `tests/helpers/live-service.ts`: *"what it must
 * never do is find the real CLI: that costs money, needs a login, and is not
 * deterministic."* It was enforced by every caller remembering to pass a
 * `claudeBin`, and **forty-three of forty-six `startLiveService` calls did
 * not** — because they injected a `runner` instead, which reads as "this test
 * spawns nothing" and is false. The runner covers the conversation turn; the
 * extraction turn escapes behind it.
 *
 * So the rule moves from the callers to the chokepoint. Under test, resolving
 * the real binary is not a fallback, it is a **loud failure** — a test that
 * gets here has a bug and should be told so in its own run rather than in
 * somebody's electricity bill.
 *
 * **`CLAUDE_BIN` is deliberately not an escape hatch.** It exists to point a
 * REAL run at a real CLI, and honouring it here would reopen the hole for
 * anyone whose shell exports one — which is most developer machines. A test
 * that genuinely wants a binary passes `claudeBin` at the call, which never
 * reaches this function.
 */
export function refuseRealBinaryUnderTest(env: NodeJS.ProcessEnv): void {
  const underTest = env["VITEST"] !== undefined || env["NODE_ENV"] === "test";
  if (!underTest) return;
  throw new RealBinaryUnderTestError();
}

/** Resolve against the real process environment and filesystem. */
export function resolveClaudeBinFromProcess(): string {
  refuseRealBinaryUnderTest(process.env);
  return resolveClaudeBin({
    env: process.env,
    home: homedir(),
    exists: existsSync,
  });
}
