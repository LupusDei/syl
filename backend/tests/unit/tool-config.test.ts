import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  mcpToolName,
  TOOL_SERVER_NAME,
  toolConfig,
  toolConfigPath,
  toolServerLaunch,
  turnFilePath,
  writeToolConfig,
  writeTurnMessage,
} from "../../src/tools/config.js";
import { inspectContainer } from "../../src/ops/container.js";

/**
 * Where her hands are declared, and whether that declaration actually starts
 * anything.
 *
 * The second half is the one worth the subprocess. Everything else in this file
 * is arithmetic on paths; `toolServerLaunch()` is a claim about a command line
 * working on this machine, and a claim like that has exactly one honest test.
 */

const homes: string[] = [];

function aHome(): string {
  const home = mkdtempSync(join(tmpdir(), "syl-hands-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop() as string, { recursive: true, force: true });
});

function contentsFor(home: string): Parameters<typeof writeToolConfig>[0] {
  return {
    home,
    baseUrl: "http://127.0.0.1:8888/api/v1",
    token: "a-token-that-exists-in-one-place",
    tz: "America/Chicago",
  };
}

describe("where her hands are declared", () => {
  it("should live under her home, so the container check accepts it", () => {
    // `ops/container.ts` refuses to boot when the file declaring her tools sits
    // outside `~/.syl`, because a declaration read from the source tree
    // reattaches her to the workshop through the one door deliberately left
    // open. This is that refusal, asserted from the other side.
    const home = aHome();

    expect(inspectContainer(home, { mcpConfig: toolConfigPath(home) })).toEqual([]);
  });

  it("should be refused by that same check if it were ever put in the repository", () => {
    const home = aHome();
    const inRepo = new URL("../../src/tools/config.ts", import.meta.url).pathname;

    expect(inspectContainer(home, { mcpConfig: inRepo })).toHaveLength(1);
  });

  it("should not take the ambient spelling a turn would inherit", () => {
    // `~/.syl/.mcp.json` is one of the doors `container.ts` refuses, because a
    // file with that name is picked up by the working directory rather than
    // handed to a lane. Giving this one that spelling would make the two
    // indistinguishable to anyone reading her home.
    const home = aHome();

    expect(toolConfigPath(home)).not.toBe(join(home, ".mcp.json"));
    expect(toolConfigPath(home).startsWith(home)).toBe(true);
  });

  it("should be written readable by nobody but her own process", () => {
    // It carries the agent credential for as long as this process lives.
    const home = aHome();
    const path = writeToolConfig(contentsFor(home));

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("should return the path it wrote, so nobody recomputes it", () => {
    const home = aHome();

    expect(writeToolConfig(contentsFor(home))).toBe(toolConfigPath(home));
  });
});

describe("what the declaration says", () => {
  it("should name one server, and tell it the port, the credential and his zone", () => {
    const home = aHome();
    const config = toolConfig(contentsFor(home)) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };

    expect(Object.keys(config.mcpServers)).toEqual([TOOL_SERVER_NAME]);
    const server = config.mcpServers[TOOL_SERVER_NAME];
    expect(server?.env).toEqual({
      SYL_API_BASE_URL: "http://127.0.0.1:8888/api/v1",
      SYL_AGENT_TOKEN: "a-token-that-exists-in-one-place",
      SYL_TIMEZONE: "America/Chicago",
      SYL_TURN_FILE: turnFilePath(home),
    });
  });

  it("should point at loopback and never at the tailnet", () => {
    // Her credential must never leave the machine it was minted on. The client
    // refuses a non-loopback base at construction; this is the same rule one
    // step earlier, where the value is chosen.
    const home = aHome();
    const config = toolConfig(contentsFor(home)) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };

    expect(config.mcpServers[TOOL_SERVER_NAME]?.env["SYL_API_BASE_URL"]).toMatch(
      /^http:\/\/127\.0\.0\.1:/u,
    );
  });

  it("should spell the verbs the way Claude Code will present them", () => {
    expect(mcpToolName("remind_me")).toBe("mcp__syl__remind_me");
  });
});

describe("what he said this turn", () => {
  it("should be written where the server can read it, and nowhere else", () => {
    const home = aHome();
    writeTurnMessage(home, "wake me for this one, whatever the hour");

    expect(readFileSync(turnFilePath(home), "utf8")).toBe(
      "wake me for this one, whatever the hour",
    );
    expect(turnFilePath(home).startsWith(home)).toBe(true);
  });

  it("should never throw, because a turn must happen whether or not this lands", () => {
    // The consequence of losing this file is that no reminder can claim
    // urgency, which is the safe outcome. Losing the turn is not.
    expect(() => writeTurnMessage(join(aHome(), "not", "a", "\0directory"), "anything")).not.toThrow();
  });
});

describe("starting the tool server for real", () => {
  it("should resolve an argv that this machine can actually run", async () => {
    // The one claim in this file that cannot be checked by reading. The server
    // is a subprocess, started from a path this module resolves, and every verb
    // she has depends on that argv being right on the machine she runs on —
    // where `PATH` is launchd's and the source may be TypeScript.
    const launch = toolServerLaunch();
    const child = spawn(launch.command, [...launch.args], {
      env: {
        ...process.env,
        SYL_API_BASE_URL: "http://127.0.0.1:8888/api/v1",
        SYL_AGENT_TOKEN: "token",
        SYL_TIMEZONE: "America/Chicago",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const listed = new Promise<string>((resolve, reject) => {
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        if (out.includes("\n")) resolve(out);
      });
      child.stderr.on("data", (chunk: string) => {
        err += chunk;
      });
      child.on("exit", (code) => {
        reject(new Error(`the tool server exited ${String(code)} without answering. stderr: ${err}`));
      });
    });

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`,
    );

    try {
      const reply = JSON.parse((await listed).split("\n")[0] ?? "{}") as {
        result?: { tools?: { name: string }[] };
      };
      expect(reply.result?.tools?.map((tool) => tool.name)).toContain("remind_me");
    } finally {
      child.kill();
    }
  });

  it("should die at startup rather than answer without a credential", async () => {
    // A server with no token would answer 401 to everything and report a
    // hundred identical failures instead of one missing configuration. Claude
    // Code reports the server as failed, and the capability section she is
    // given says she has no hands — which is true.
    const launch = toolServerLaunch();
    const child = spawn(launch.command, [...launch.args], {
      env: { ...process.env, SYL_API_BASE_URL: "", SYL_AGENT_TOKEN: "", SYL_TIMEZONE: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const [code, stderr] = await new Promise<[number | null, string]>((resolve) => {
      let err = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        err += chunk;
      });
      child.on("exit", (exit) => resolve([exit, err]));
    });

    expect(code).not.toBe(0);
    expect(stderr).toContain("SYL_AGENT_TOKEN");
  });
});
