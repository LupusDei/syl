#!/usr/bin/env -S npx tsx
/**
 * SPIKE — time to first assistant text on the REAL warm lane, with the REAL
 * turn shape. Throwaway; not a test, not production.
 *
 * ## Why the two numbers we already have do not answer the question
 *
 * `scripts/experiments/first-token-latency.mjs` measured first token (~1635ms
 * warm) but with a BARE PROBE: no soul, no memory projection, no tool schemas,
 * no MCP. `syl-per1` measured the real harness (965ms warm follow-up vs 4541ms
 * per-turn) but to `result`, and its own agent flagged that its probe "carried
 * no soul, memory projection, or MCP config… the absolutes need re-taking
 * against the real turn shape".
 *
 * Runway's `BackendRPCTool.timeoutSeconds` maxes out at **8**. Her turn has to
 * finish inside that with the network and Runway's own round trip on top, so
 * the absolute matters and an approximation does not.
 *
 * ## What this drives — the real thing, not a reproduction
 *
 * `PersistentSession` (`harness/persistent-session.ts`) — the same object
 * `WarmLanes` hands the commander lane — with the commander lane's actual
 * `TurnOptions` as `index.ts` builds them:
 *
 *   cwd            ~/.syl
 *   mcpConfig      ~/.syl/tools/hands.json  (+ --strict-mcp-config)
 *   tools          ""            settingSources  ""
 *   autoMemory     off           permissionMode  bypassPermissions
 *   systemPrompt   composeTurnContext() over the REAL contributors:
 *                    the real SOUL.md, the real working-memory projection read
 *                    out of ~/.syl/syl.db, the real capability text derived
 *                    from the real advertised tool names, and the real
 *                    unattended ledger built from the real runs table.
 *
 * `SylAgent` is deliberately NOT in the loop: it would resume — and therefore
 * write into — the Commander's own conversation. This mints a throwaway session
 * id and resumes only itself, which is the one difference from a live turn and
 * costs nothing measurable (`--resume` vs `--session-id` is one argv flag).
 *
 * The database is opened READ-ONLY. Syl's service is live on 8888 and this must
 * not touch her data.
 *
 * Usage: npx tsx scripts/experiments/warm-lane-first-token.mts [turns]
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { composeTurnContext, type Contributor } from "../../backend/src/harness/turn-context.js";
import { capabilityFromToolsOption } from "../../backend/src/harness/capability.js";
import { PersistentSession } from "../../backend/src/harness/persistent-session.js";
import { autoMemoryOff } from "../../backend/src/memory/auto-memory.js";
import { unattendedContributor } from "../../backend/src/jobs/unattended-contributor.js";
import { mcpToolName, toolConfigPath } from "../../backend/src/tools/config.js";
import { advertisedToolNames } from "../../backend/src/tools/server.js";
import type { SylEvent } from "../../backend/src/harness/protocol.js";

const TURNS = Number(process.argv[2] ?? 6);
const HOME = join(homedir(), ".syl");
const DB = join(HOME, "syl.db");
const TZ = "America/Chicago";

/**
 * Conversational, short, and deliberately not asking her to DO anything: the
 * lane carries her real hands against her real service, and this spike must not
 * write to his data. We are measuring the pipe, not her reasoning.
 */
const PROMPTS = process.argv[3] !== undefined ? [process.argv[3]] : [
  "Say hello in one short sentence. Do not use any tools.",
  "In one sentence, how are you finding today? Do not use any tools.",
  "Name one colour you like. One line. Do not use any tools.",
  "In one short sentence, what is the weather like as a metaphor? No tools.",
  "Say something brief and warm. One sentence. No tools.",
  "In one sentence, what does patience feel like? No tools.",
  "One short sentence about the sound of rain. No tools.",
  "Say goodbye in one short sentence. No tools.",
];

// ---------------------------------------------------------------------------
// The real context, read from the real places
// ---------------------------------------------------------------------------

const repoRoot = join(import.meta.dirname, "..", "..");
const soul = readFileSync(join(repoRoot, "SOUL.md"), "utf8").trim();

const db = new DatabaseSync(DB, { readOnly: true });

const projection = db.prepare(`SELECT text FROM working_memory WHERE id = 1`).get() as
  | { text: string }
  | undefined;
const recall = projection?.text ?? "";

// Same shape `JobStore.listRuns` returns, straight off the table. Only the
// fields `unattendedContributor` reads are populated.
const runRows = db
  .prepare(
    `SELECT id, job_id, kind, trigger_instant, actual_instant, lateness_ms, outcome,
            spoke, turns, cost_usd, summary, error, attempts, started_at, finished_at
       FROM runs ORDER BY started_at DESC LIMIT 200`,
  )
  .all() as Array<Record<string, unknown>>;

const runs = runRows.map((r) => ({
  id: String(r["id"]),
  jobId: String(r["job_id"]),
  kind: String(r["kind"]),
  triggerInstant: String(r["trigger_instant"]),
  actualInstant: r["actual_instant"] === null ? null : String(r["actual_instant"]),
  latenessMs: Number(r["lateness_ms"]),
  outcome: String(r["outcome"]),
  spoke: Number(r["spoke"]) === 1,
  turns: Number(r["turns"]),
  costUsd: Number(r["cost_usd"]),
  summary: r["summary"] === null ? null : String(r["summary"]),
  error: r["error"] === null ? null : String(r["error"]),
  attempts: Number(r["attempts"]),
  startedAt: String(r["started_at"]),
  finishedAt: r["finished_at"] === null ? null : String(r["finished_at"]),
  steps: [],
})) as never;

db.close();

const ledger = unattendedContributor(runs, { now: Date.now(), tz: TZ });
const capability = capabilityFromToolsOption("", advertisedToolNames().map(mcpToolName));

const contributors: Contributor[] = [
  { id: "soul", kind: "identity", text: soul },
  { id: "working-memory", kind: "memory", text: recall },
  ...(ledger === undefined ? [] : [ledger]),
  ...(capability === undefined ? [] : [{ id: "capability", kind: "capability" as const, text: capability }]),
];

const context = composeTurnContext({ contributors });

console.log("─── the turn shape being measured ───");
for (const section of context.sections) {
  console.log(`  ${section.id.padEnd(16)} ${section.kind.padEnd(11)} ${String(section.bytes).padStart(7)} bytes`);
}
console.log(`  ${"TOTAL".padEnd(28)} ${String(context.bytes).padStart(7)} bytes system prompt`);
console.log(`  cwd ${HOME}`);
console.log(`  mcp ${toolConfigPath(HOME)}`);
console.log("");

// ---------------------------------------------------------------------------
// Drive the real warm lane
// ---------------------------------------------------------------------------

interface Row {
  turn: number;
  firstText: number | null;
  result: number | null;
  apiKeySource: string;
  toolCount: number;
  mcp: string;
  spokeChars: number;
}

const TURN_OPTIONS = {
  lane: "commander",
  cwd: HOME,
  mcpConfig: toolConfigPath(HOME),
  strictMcpConfig: true,
  tools: "",
  settingSources: "",
  autoMemory: autoMemoryOff(),
  permissionMode: "bypassPermissions",
  systemPrompt: context.systemPrompt,
} as const;

/**
 * SYL_PARTIAL=1 — the same warm process, but with `--include-partial-messages`.
 *
 * The harness does not pass that flag, so every measurement above is time to a
 * COMPLETE assistant message. The CLI can emit token deltas instead, and for a
 * face that can stream, the first delta is the number that matters. There is no
 * `TurnOptions` field for it, so this arm spawns directly off `buildTurnArgv`
 * with the identical argv plus the one flag — an honest reproduction of the
 * warm path rather than the warm path itself.
 */
if (process.env["SYL_PARTIAL"] === "1") {
  const { spawn } = await import("node:child_process");
  const { buildTurnArgv, childEnv, newSessionId } = await import("../../backend/src/harness/session.js");
  const { resolveClaudeBinFromProcess } = await import("../../backend/src/harness/claude-bin.js");

  const id = newSessionId();
  const argv = [...buildTurnArgv(TURN_OPTIONS, id), "--include-partial-messages"];
  const child = spawn(resolveClaudeBinFromProcess(), argv, {
    cwd: HOME,
    env: childEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");

  let buffer = "";
  let sentAt = Date.now();
  let index = 0;
  let firstDelta: number | null = null;
  let firstWhole: number | null = null;
  const deltas: number[] = [];
  const wholes: number[] = [];
  const results: number[] = [];

  const send = (): void => {
    if (index >= TURNS) {
      child.stdin.end();
      console.log("\n─── with --include-partial-messages (raw spawn, identical argv) ───");
      console.log(`  first TOKEN delta:    ${deltas.join("ms, ")}ms`);
      console.log(`  first WHOLE message:  ${wholes.join("ms, ")}ms`);
      console.log(`  result:               ${results.join("ms, ")}ms`);
      setTimeout(() => child.kill("SIGTERM"), 300);
      return;
    }
    firstDelta = null;
    firstWhole = null;
    sentAt = Date.now();
    const text = PROMPTS[index % PROMPTS.length] as string;
    index += 1;
    child.stdin.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
    );
  };

  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim() === "") continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const ms = Date.now() - sentAt;

      if (event["type"] === "stream_event" && firstDelta === null) {
        const raw = JSON.stringify(event["event"] ?? {});
        if (raw.includes("content_block_delta") && raw.includes("text_delta")) {
          firstDelta = ms;
          deltas.push(ms);
        }
      }
      if (event["type"] === "assistant" && firstWhole === null) {
        firstWhole = ms;
        wholes.push(ms);
      }
      if (event["type"] === "result") {
        results.push(ms);
        console.log(
          `turn ${String(index)}  first token ${String(firstDelta ?? "—").padStart(6)}ms` +
            `   whole message ${String(firstWhole ?? "—").padStart(6)}ms   result ${String(ms).padStart(6)}ms`,
        );
        send();
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => process.stderr.write(c));
  send();
} else {
  await measureWarmLane();
}

async function measureWarmLane(): Promise<void> {
const session = new PersistentSession({ lane: "commander" });
const rows: Row[] = [];
let sessionId: string | undefined;

for (let index = 0; index < TURNS; index += 1) {
  const row: Row = {
    turn: index + 1,
    firstText: null,
    result: null,
    apiKeySource: "?",
    toolCount: -1,
    mcp: "?",
    spokeChars: 0,
  };
  rows.push(row);

  const sentAt = Date.now();
  const onEvent = (event: SylEvent): void => {
    if (event.kind === "init") {
      row.apiKeySource = event.apiKeySource;
      row.toolCount = event.tools.length;
      row.mcp = event.mcpServers.map((s) => `${s.name}:${s.status}`).join(",") || "(none)";
    }
    if (event.kind === "assistant_text" && row.firstText === null && event.text.trim() !== "") {
      row.firstText = Date.now() - sentAt;
    }
    if (event.kind === "result" && row.result === null) row.result = Date.now() - sentAt;
  };

  const result = await session.run(PROMPTS[index % PROMPTS.length] as string, {
    ...TURN_OPTIONS,
    ...(sessionId === undefined ? {} : { resume: sessionId }),
    onSessionId: (id) => {
      sessionId = id;
    },
    onEvent,
  });

  row.spokeChars = result.spoken.length;
  const status = session.status();
  console.log(
    `turn ${String(row.turn)}  first text ${String(row.firstText ?? "—").padStart(6)}ms` +
      `   result ${String(row.result ?? "—").padStart(6)}ms` +
      `   apiKeySource=${row.apiKeySource}` +
      `   tools=${String(row.toolCount)}  mcp=${row.mcp}` +
      `   warm=${String(status.warm)} served=${String(status.turnsServed)}`,
  );
  console.log(`        she said: ${JSON.stringify(result.spoken.slice(0, 90))}`);
}

await session.close();

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

const followUps = rows.slice(1).map((r) => r.firstText).filter((v): v is number => v !== null);
const results = rows.slice(1).map((r) => r.result).filter((v): v is number => v !== null);
const avg = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

console.log("\n─── first assistant text, per turn ───");
for (const r of rows) {
  const gap = r.firstText !== null && r.result !== null ? r.result - r.firstText : null;
  console.log(
    `  turn ${String(r.turn)}  first text ${String(r.firstText ?? "—").padStart(6)}ms` +
      `   result ${String(r.result ?? "—").padStart(6)}ms` +
      `   speaking room ${gap === null ? "—" : `${String(gap)}ms`}`,
  );
}

console.log(`\n  turn 1 (pays CLI startup + MCP server startup): ${String(rows[0]?.firstText ?? "—")}ms first text, ${String(rows[0]?.result ?? "—")}ms result`);
if (followUps.length > 0) {
  console.log(`  follow-up first text: ${followUps.join("ms, ")}ms`);
  console.log(`  follow-up first text  min ${String(Math.min(...followUps))}ms  avg ${String(avg(followUps))}ms  max ${String(Math.max(...followUps))}ms`);
  console.log(`  follow-up result      min ${String(Math.min(...results))}ms  avg ${String(avg(results))}ms  max ${String(Math.max(...results))}ms`);

  const worst = Math.max(...results);
  const band =
    worst < 3000
      ? "COMFORTABLE — under ~3s, room to spare against the 8s RPC ceiling."
      : worst < 5000
        ? "WORKS, WITH THE COVERING BEHAVIOUR CARRYING REAL WEIGHT — 3-5s, little margin."
        : worst < 8000
          ? "FRAGILE — 5-8s. It will work sometimes and time out sometimes."
          : "CANNOT SHIP IN THIS SHAPE — over the 8s ceiling.";
  console.log(`\n  VERDICT (worst follow-up TURN COMPLETION vs Runway's 8s cap): ${band}`);
}

const bad = rows.filter((r) => r.apiKeySource !== "none");
console.log(
  bad.length === 0
    ? `\n  apiKeySource === "none" on all ${String(rows.length)} turns. Subscription rails held.`
    : `\n  *** WARNING: ${String(bad.length)} turn(s) reported apiKeySource != "none" ***`,
);
}
