import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * A very small MCP client. Enough to be a client, and no more.
 *
 * It exists so a test can do what Claude Code does: read the declaration the
 * commander lane was handed, start the server it names as a subprocess, and
 * speak JSON-RPC over its stdio. Nothing here fakes the transport — the whole
 * point of the tests that use it is that the process really starts, really
 * connects to Syl's own API, and really writes a row.
 */

/** How long a request gets before the test says so itself. */
export const MCP_TIMEOUT_MS = 10_000;

export interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

/** A tool as `tools/list` describes it. */
export interface McpToolDescription {
  readonly name: string;
  readonly inputSchema?: {
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

/** What a `tools/call` reply carries back. */
export interface McpToolResult {
  readonly isError?: boolean;
  readonly content?: readonly { readonly text?: string }[];
}

/** One server named by a declaration. */
export interface DeclaredServer {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
}

/** Every server a declaration names, in the order it names them. */
export function serversDeclaredIn(configPath: string): readonly [string, DeclaredServer][] {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers?: Record<string, DeclaredServer>;
  };
  return Object.entries(config.mcpServers ?? {});
}

/** One MCP server, spoken to over stdio the way Claude Code speaks to it. */
export class McpServerProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, (response: JsonRpcResponse) => void>();
  #buffer = "";
  #nextId = 1;
  #stderr = "";

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    this.#child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        newline = this.#buffer.indexOf("\n");
        if (line === "") continue;
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue; // a server logging to stdout is not our business here
        }
        if (message.id === undefined) continue;
        this.#pending.get(message.id)?.(message);
        this.#pending.delete(message.id);
      }
    });
  }

  static start(
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ): McpServerProcess {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new McpServerProcess(child);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const settled = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `the MCP server did not answer ${method} within ${String(MCP_TIMEOUT_MS)}ms. ` +
              `stderr: ${this.#stderr.trim()}`,
          ),
        );
      }, MCP_TIMEOUT_MS);
      timer.unref();
      this.#pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const response = await settled;
    if (response.error !== undefined) {
      throw new Error(`the MCP server refused ${method}: ${response.error.message ?? "no reason"}`);
    }
    return response.result;
  }

  notify(method: string, params: unknown): void {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** `initialize` and the notification that follows it, as a client must. */
  async handshake(clientName: string): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "0" },
    });
    this.notify("notifications/initialized", {});
  }

  stop(): void {
    this.#child.kill();
  }
}
