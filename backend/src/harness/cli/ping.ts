/**
 * Walking-skeleton demo: prove the base layer end to end.
 *
 *   npm run ping -- "your prompt here"
 *
 * Verifies, in one run, the four things the architecture rests on:
 *   1. the official CLI is driven over stdio (no tmux, no ACP adapter)
 *   2. credentials resolve to the claude.ai login, not an API key
 *   3. the Adjutant MCP bridge attaches automatically
 *   4. turn boundaries and cost arrive as data, not as scraped text
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SylAgent, fileSessionStore } from "../agent.js";

const here = dirname(fileURLToPath(import.meta.url));
// backend/src/harness/cli -> repo root. SOUL.md, .mcp.json and .syl/ live at
// the root of the monorepo, not inside the backend workspace.
const root = join(here, "..", "..", "..", "..");

function readSoul(): string | undefined {
  try {
    return readFileSync(join(root, "SOUL.md"), "utf8");
  } catch {
    return undefined; // SOUL.md is optional for the smoke test
  }
}

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim() || "Reply with exactly: PONG";
  const soul = readSoul();

  const agent = new SylAgent({
    // One file per lane. The Commander's conversation must not share a
    // transcript with the heartbeat or the nightly consolidation pass.
    store: fileSessionStore(join(root, ".syl", "sessions")),
    ...(soul ? { soul } : {}),
    turnOptions: {
      model: "claude-haiku-4-5",
      // Only Syl's own MCP config; otherwise the session inherits every
      // ambient server and the model thrashes on tool discovery.
      mcpConfig: join(root, ".mcp.json"),
      onEvent: (event) => {
        if (event.kind === "tool_use") console.log(`  [tool] ${event.name}`);
      },
    },
  });

  const resuming = agent.sessionId;
  console.log(resuming ? `Resuming session ${resuming}\n` : "Starting a new session\n");

  const result = await agent.ask(prompt);
  const init = result.init;

  console.log(`  session   ${init.sessionId}`);
  console.log(`  model     ${init.model}`);
  console.log(
    `  auth      apiKeySource=${init.apiKeySource}` +
      `  ${init.apiKeySource === "none" ? "(subscription rails OK)" : "(API KEY — NOT subscription)"}`,
  );
  console.log(`  mcp       ${init.mcpServers.map((s) => `${s.name}=${s.status}`).join(", ") || "none"}`);
  console.log(`  caps      ${init.capabilities.join(", ")}\n`);

  console.log(`> ${prompt}\n`);
  console.log(`${result.text}\n`);
  console.log(`  turns ${result.numTurns}   reported cost $${result.costUsd.toFixed(6)}`);
  console.log("  (cost is an accounting estimate; on subscription rails it is not a charge)");
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
