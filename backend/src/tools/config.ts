import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where Syl's hands live on disk, and how they are started.
 *
 * ## Under her home, absolute, from configuration — never from the repository
 *
 * `ops/container.ts` refuses to boot the service when the file declaring her
 * tools sits outside `~/.syl`, and that refusal is the point rather than a
 * side-effect. Her turns already run in her home with no built-in tools and no
 * ambient settings; the tool declaration is *the one door that is deliberately
 * opened*, so a path into a checked-out branch would reattach her to the
 * workshop through the only opening left. It would also mean her capabilities
 * change when somebody switches branches, which is not a property an assistant
 * should have.
 *
 * So the path is derived from her home and from nothing else, and the check in
 * `container.ts` is what makes that a guarantee rather than a habit.
 *
 * ## Why the file is rewritten on every boot
 *
 * It carries two things this process cannot know in advance: the **port** the
 * kernel gave the listener, and **her credential**, which `agent-key.ts` mints
 * fresh on every boot because the previous plaintext died with the previous
 * process. A stale file is therefore not merely out of date — it is a token
 * that no longer verifies, pointed at a port nothing is listening on. Written
 * `0600` for the same reason: it holds the one credential that can write the
 * Commander's reminders.
 *
 * ## Why a subprocess at all
 *
 * Because that is what an MCP server is. Claude Code starts it, speaks JSON-RPC
 * over its stdio, and it lives for the turn. It is a separate process from this
 * service by construction, which is why everything it needs — the port, the
 * token, his zone, and what he said this turn — has to travel through this file
 * rather than through a shared object.
 */

/**
 * The MCP server's name, and therefore the prefix on every verb she sees.
 *
 * Claude Code presents an MCP tool as `mcp__<server>__<tool>`, so this string
 * is not internal: it is part of what the model reads. `syl` rather than
 * `syl-tools` because the second half already says what they are, and
 * `mcp__syl__remind_me` is as close to "remind me" as the CLI's naming allows.
 */
export const TOOL_SERVER_NAME = "syl";

/** How Claude Code names a verb from {@link TOOL_SERVER_NAME}. */
export function mcpToolName(verb: string): string {
  return `mcp__${TOOL_SERVER_NAME}__${verb}`;
}

/** The directory under her home that holds everything about her hands. */
function handsDirectory(home: string): string {
  return join(home, "tools");
}

/**
 * The file declaring her tools, given her home.
 *
 * Not `.mcp.json` and not at the top of her home, deliberately: `~/.syl/.mcp.json`
 * is one of the doors `container.ts` refuses, because a file with that name in
 * the working directory is an *ambient* surface every turn would inherit. This
 * one is handed to a single lane by name, which is the opposite arrangement,
 * and giving it the ambient spelling would make the two indistinguishable to
 * anybody reading the directory.
 */
export function toolConfigPath(home: string): string {
  return join(handsDirectory(home), "hands.json");
}

/**
 * The file carrying what the Commander said this turn.
 *
 * `harness/urgency.ts` can only do its job against his actual words, and the
 * tool server is a different process that is deliberately unable to read the
 * conversation — `AGENT_SURFACE` excludes `/conversations` precisely so she
 * cannot author messages as him. So the service writes his message here before
 * each turn that carries hands, and the server reads it when, and only when, a
 * quoted urgency claim has to be checked.
 *
 * A file rather than an environment variable in the declaration above, because
 * the declaration is written once per boot and his message changes every turn.
 * Absent or unreadable reads as "he said nothing", which grants nothing —
 * the safe direction, and the same default as an unmatched quote.
 */
export function turnFilePath(home: string): string {
  return join(handsDirectory(home), "his-message.txt");
}

/** How to start the tool server: an argv, resolved for the way this code is running. */
export interface ToolServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Resolve the argv that starts `tools/server.ts`.
 *
 * Two shapes, decided by what this module itself is: compiled next to the
 * server in `dist/`, or the TypeScript source under `src/`. The check is on
 * this file's own extension rather than on `NODE_ENV` or on a flag, because it
 * is asking a question with a fact behind it — *what is on disk beside me* —
 * and cannot be wrong about an environment somebody forgot to set.
 *
 * `process.execPath` rather than `"node"`: the same reasoning as
 * `harness/claude-bin.ts`. The service can be started by launchd with a `PATH`
 * that has no node on it at all, and a child that cannot be spawned is a turn
 * with no hands and an error message about a missing binary.
 */
export function toolServerLaunch(): ToolServerLaunch {
  const here = fileURLToPath(import.meta.url);
  const compiled = here.endsWith(".js");
  const entry = join(dirname(here), compiled ? "server.js" : "server.ts");

  if (!existsSync(entry)) {
    throw new Error(
      `Syl's tool server is not where it should be: ${entry} does not exist. Her hands are ` +
        `started as a subprocess from this path, so nothing she is asked to do can happen ` +
        `until it is there. If this is a compiled build, \`npm run build\` did not emit it.`,
    );
  }

  if (compiled) return { command: process.execPath, args: [entry] };

  // Running from source, so the file on disk is TypeScript and node cannot load
  // it unaided — its imports carry the emitted `.js` extensions, which type
  // stripping alone does not resolve. `tsx` is how every other entry point in
  // this repository runs from source (`npm run ping`, `npm run pair`), and it
  // is resolved rather than assumed to be on `PATH` for the same reason as
  // `process.execPath` above.
  const loader = createRequire(import.meta.url).resolve("tsx");
  return { command: process.execPath, args: ["--import", loader, entry] };
}

/** What the tool server has to be told, none of which it can work out for itself. */
export interface ToolConfigContents {
  /** Her home. The file is written under it, and nowhere else is accepted. */
  readonly home: string;
  /** The loopback base for Syl's own API, e.g. `http://127.0.0.1:8888/api/v1`. */
  readonly baseUrl: string;
  /** Her own credential. Never the phone's. See `services/agent-key.ts`. */
  readonly token: string;
  /** His configured zone. IANA, always — non-negotiable constraint 5. */
  readonly tz: string;
}

/** The declaration, as a value, so a test can read it without going to disk. */
export function toolConfig(contents: ToolConfigContents): Record<string, unknown> {
  const launch = toolServerLaunch();
  return {
    mcpServers: {
      [TOOL_SERVER_NAME]: {
        command: launch.command,
        args: [...launch.args],
        env: {
          SYL_API_BASE_URL: contents.baseUrl,
          SYL_AGENT_TOKEN: contents.token,
          SYL_TIMEZONE: contents.tz,
          SYL_TURN_FILE: turnFilePath(contents.home),
        },
      },
    },
  };
}

/**
 * Write the declaration under her home and return its absolute path.
 *
 * @returns the path, so the caller hands on the value this function produced
 * rather than recomputing it — one place decides where her hands live.
 */
export function writeToolConfig(contents: ToolConfigContents): string {
  const path = toolConfigPath(contents.home);
  mkdirSync(dirname(path), { recursive: true });
  // `0600` on the file and on the directory: this is her credential on disk for
  // as long as the process lives, and the only reader that should ever have it
  // is a child of this process.
  writeFileSync(path, `${JSON.stringify(toolConfig(contents), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

/**
 * Record what the Commander said, for the urgency check and for nothing else.
 *
 * Never throws. A turn that cannot write this file must still take place — the
 * consequence of the file being missing is that no reminder can claim urgency,
 * which is the safe outcome and the one this whole seam defaults to.
 */
export function writeTurnMessage(home: string, message: string): void {
  try {
    const path = turnFilePath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, message, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* c8 ignore next -- a home she cannot write to fails far louder elsewhere */
  }
}
