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

import { autoMemoryAt } from "../../memory/auto-memory.js";
import { withMemoryIndex } from "../../memory/index-guarantee.js";
import { SylAgent, fileSessionStore } from "../agent.js";
import { runTurn } from "../session.js";

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
    // One directory, shared by every lane. `--session-id` partitions the
    // transcripts; nothing should partition what Syl knows.
    autoMemory: autoMemoryAt(join(root, ".syl", "memory")),
    // The index is Syl's job, not the model's (`syl-03d`). Printed rather than
    // silent, because the whole bug was that nothing said anything.
    runner: withMemoryIndex(runTurn, {
      onRebuild: (index) => {
        if (index.indexed.length > 0 || index.dropped.length > 0) {
          console.log(
            `  [index] ${index.indexed.length} unfiled memor${index.indexed.length === 1 ? "y" : "ies"} indexed` +
              `${index.dropped.length > 0 ? `, ${index.dropped.length} over budget` : ""}` +
              `${index.changed ? "" : " (already current)"}`,
          );
        }
      },
    }),
    ...(soul ? { soul } : {}),
    turnOptions: {
      model: "claude-haiku-4-5",
      // NO MCP, because the SERVICE has none — and a smoke test that runs a
      // different shape than production is not a smoke test.
      //
      // This used to pass `.mcp.json`, on the reasoning that scoping to Syl's
      // own config beat inheriting every ambient server. True as far as it
      // went, but `.mcp.json` IS Adjutant, the channel agents use to report to
      // the Commander while building. So `npm run ping -- "hello"` answered him
      // through `mcp__adjutant__send_message` — and he rightly asked why his
      // assistant was replying over the development tooling.
      //
      // Worse, it made this command lie about the thing it exists to check.
      // The service builds `SylAgent` with no MCP config at all, so ping was
      // exercising a configuration production never uses: different tool
      // surface, different turn count, different latency. Measured: attaching
      // it cost ~2.5s per turn and turned "hello" into FOUR turns, three of
      // them tool calls.
      //
      // Syl's reply is the RETURN VALUE of the turn. She needs no tool to
      // speak; `ConversationService` persists what she says and broadcasts it.
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
  console.log(`  caps      ${init.capabilities.join(", ")}`);
  // Printed rather than assumed: the CLI discards an autoMemoryDirectory it
  // does not like and falls back to its own default in complete silence, so
  // this line is the only place the redirect is visible to a human.
  console.log(`  memory    ${init.autoMemoryPath ?? "OFF — nothing will be remembered"}\n`);

  console.log(`> ${prompt}\n`);
  console.log(`${result.text}\n`);
  console.log(`  turns ${result.numTurns}   reported cost $${result.costUsd.toFixed(6)}`);
  console.log("  (cost is an accounting estimate; on subscription rails it is not a charge)");
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
