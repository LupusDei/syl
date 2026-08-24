#!/usr/bin/env node
/**
 * Capture the tool names a live Adjutant actually advertises over MCP.
 *
 * ## Why this exists
 *
 * `syl-j8fa` shipped `AdjutantClient.ask` calling **`direct_message`**, a tool
 * Adjutant's `main` has never registered. It exists, complete and reviewed, on
 * the unmerged branch `feat/syl-j8fa-direct-message` — so it was real when it
 * was written against, and the running server has never had it. Every
 * `ask_agent` failed for over a day, hourly, and the failure surfaced as
 * *"Adjutant's answer to ask X was not readable"* because the unknown-tool
 * error came back as prose and `JSON.parse` threw on it.
 *
 * Nothing in this repository could have caught that. Adjutant is a separate
 * service reached over HTTP at runtime: no install, no lockfile, no compiler
 * between our tool-name string literals and its registry. `"direct_message"`
 * type-checked, shipped, and addressed nothing.
 *
 * So the surface is captured HERE and asserted against in
 * `tests/unit/adjutant-tools-exist.test.ts`. It is a fixture in exactly the
 * sense this project already means: **real captured output, never written by
 * hand from our own idea of the shape.** Editing the fixture to make a test
 * pass is the one thing that would make all of this worthless.
 *
 * ## Usage
 *
 *     node backend/scripts/capture-adjutant-tools.mjs [baseUrl]
 *
 * Defaults to `http://127.0.0.1:4201` — Adjutant's backend, NOT Syl's 8888.
 * It writes nothing unless the handshake produced a session and the list came
 * back non-empty, because a fixture that is silently an error page would let
 * every tool name pass by having nothing to check.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "tests", "fixtures", "adjutant-tools-list.json");

const baseUrl = (process.argv[2] ?? "http://127.0.0.1:4201").replace(/\/+$/u, "");

/** The headers Adjutant needs on every `/mcp` call, session id aside. */
function headers(sessionId) {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    // Captured as Syl, deliberately. Adjutant gates some tools on the caller's
    // identity — `nudge_agent` answers "Coordination tools are restricted to
    // the adjutant agent" for her — and a capture taken as the coordinator
    // would record a surface she cannot reach.
    "x-agent-id": "syl",
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
  };
}

/**
 * The JSON-RPC message in an answer, whether SSE-framed or plain.
 *
 * Adjutant answers `text/event-stream` even for a single reply, so a plain
 * `JSON.parse` over the body throws on every successful call.
 */
function parseBody(contentType, text) {
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  const data = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  return JSON.parse(data);
}

async function rpc(request, sessionId) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: headers(sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", ...request }),
  });
  const text = await response.text();
  return { response, text };
}

const initialized = await rpc({
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "capture-adjutant-tools", version: "1" },
  },
});

const sessionId = initialized.response.headers.get("mcp-session-id");
if (sessionId === null || sessionId === "") {
  console.error(
    `No Mcp-Session-Id from ${baseUrl}/mcp. Adjutant binds the session at the handshake and ` +
      "answers tools/list with an error without one, so there is nothing to capture.",
  );
  process.exit(1);
}

const hello = parseBody(
  initialized.response.headers.get("content-type") ?? "",
  initialized.text,
);
const serverInfo = hello?.result?.serverInfo ?? {};

// The notification a client owes the server after `initialize`.
await rpc({ method: "notifications/initialized", params: {} }, sessionId);

const listed = await rpc({ id: 2, method: "tools/list", params: {} }, sessionId);
const message = parseBody(listed.response.headers.get("content-type") ?? "", listed.text);

const tools = message?.result?.tools;
if (!Array.isArray(tools) || tools.length === 0) {
  console.error(
    `tools/list on ${baseUrl} returned no tools. Refusing to write the fixture: an empty ` +
      "surface makes every tool name we call pass the guard by having nothing to check.",
  );
  process.exit(1);
}

const names = tools
  .map((tool) => tool?.name)
  .filter((name) => typeof name === "string")
  .sort();

await writeFile(
  OUT,
  `${JSON.stringify(
    {
      capturedFrom: baseUrl,
      capturedAt: new Date().toISOString(),
      serverName: serverInfo.name ?? null,
      serverVersion: serverInfo.version ?? null,
      protocolVersion: hello?.result?.protocolVersion ?? null,
      // Captured as `syl`. Tools gated to another identity are still ADVERTISED
      // here — `tools/list` is not filtered by caller — so appearing in this
      // list means the tool exists, not that she may call it.
      capturedAs: "syl",
      toolNames: names,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(
  `Captured ${String(names.length)} tool names from ${baseUrl} ` +
    `(${String(serverInfo.name)} ${String(serverInfo.version)}) -> ${path.relative(process.cwd(), OUT)}`,
);
