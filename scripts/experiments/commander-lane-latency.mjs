#!/usr/bin/env node
/**
 * How long does a turn on the Commander's lane actually take, and why?
 *
 * `syl-chzl.4.4`. Her face has never once answered a question: every `ask_syl`
 * in the log is a `face.ask.slow` against a 6,500ms deadline inside Runway's
 * hard 8s ceiling. The epic was costed on ~1,635ms warm (28746b5) and that
 * number is no longer true of his lane.
 *
 * THIS SCRIPT NEVER TOUCHES HIS THREAD. Every turn resumes with
 * `--fork-session`, which mints a new session id from his transcript and leaves
 * the original untouched — so the live service can keep resuming it while this
 * runs, and no measurement turn is ever appended to the conversation he reads.
 *
 * Usage:
 *   node scripts/experiments/commander-lane-latency.mjs [--session <id>] [--runs 3]
 *   node scripts/experiments/commander-lane-latency.mjs --inspect   # no model calls
 *
 * Stamp every result with the CLI version it was taken on. The whole reason
 * this bead exists is that a load-bearing measurement against someone else's
 * binary was still being trusted several versions later.
 */

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const SESSION_FILE = join(HOME, ".syl", "sessions", "commander");
const PROJECT_DIR = join(HOME, ".claude", "projects", "-Users-Reason--syl");
const CLAUDE_BIN = process.env["CLAUDE_BIN"] ?? join(HOME, ".local", "bin", "claude");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const FLAG = (name) => process.argv.includes(`--${name}`);

const sessionId = arg("session", existsSync(SESSION_FILE) ? readFileSync(SESSION_FILE, "utf8").trim() : undefined);
const runs = Number(arg("runs", "3"));

if (!sessionId) {
  console.error("No commander session id. Pass --session <uuid>.");
  process.exit(1);
}

const cliVersion = execFileSync(CLAUDE_BIN, ["--version"], { encoding: "utf8" }).trim();

/** Walk a transcript's ACTIVE chain — the file is append-only and has branches,
 *  so raw bytes overstate what a turn actually pays for. */
function inspect(id) {
  const path = join(PROJECT_DIR, `${id}.jsonl`);
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const byUuid = new Map();
  const order = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.uuid) { byUuid.set(o.uuid, o); order.push(o); }
  }
  if (!order.length) return undefined;
  const chain = [];
  const seen = new Set();
  let cur = order[order.length - 1].uuid;
  while (cur && byUuid.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const o = byUuid.get(cur);
    chain.push(o);
    cur = o.parentUuid;
  }
  chain.reverse();

  const nameOf = new Map();
  for (const o of chain) {
    if (o.type === "assistant" && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) if (b.type === "tool_use") nameOf.set(b.id, b.name);
    }
  }
  let textChars = 0, images = 0, imageB64 = 0, thinking = 0, userText = 0, asstText = 0;
  const toolText = {}, toolImg = {};
  for (const o of chain) {
    const c = o.message?.content;
    if (typeof c === "string") { textChars += c.length; (o.type === "user" ? userText += c.length : asstText += c.length); continue; }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === "tool_result") {
        const n = nameOf.get(b.tool_use_id) ?? "?";
        const blocks = Array.isArray(b.content) ? b.content : [];
        if (!blocks.length) { textChars += JSON.stringify(b.content ?? "").length; continue; }
        for (const x of blocks) {
          if (x.type === "image") { images++; const d = x.source?.data?.length ?? 0; imageB64 += d; toolImg[n] = (toolImg[n] ?? 0) + d; }
          else { const len = (x.text ?? "").length; textChars += len; toolText[n] = (toolText[n] ?? 0) + len; }
        }
      } else {
        const s = JSON.stringify(b).length;
        textChars += s;
        if (b.type === "thinking") thinking += s;
        else if (b.type === "text") (o.type === "user" ? userText += s : asstText += s);
      }
    }
  }
  // The authoritative context size: what the API itself reported on the last turn.
  let lastContext, compactions = 0;
  for (const o of chain) {
    if (o.isCompactSummary) compactions++;
    const u = o.message?.usage;
    if (o.type === "assistant" && u) lastContext = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  return { path, chain: chain.length, textChars, images, imageB64, thinking, userText, asstText, toolText, toolImg, lastContext, compactions };
}

const MB = (n) => (n / 1048576).toFixed(2) + " MB";

function report(label, s) {
  if (!s) { console.log(`${label}: no transcript`); return; }
  console.log(`\n=== ${label} ===`);
  console.log(`  transcript      ${s.path}`);
  console.log(`  active chain    ${s.chain} nodes, ${s.compactions} compact summaries`);
  console.log(`  CONTEXT (API)   ${s.lastContext ? s.lastContext.toLocaleString() + " tokens" : "unknown"}`);
  console.log(`  text            ${MB(s.textChars)}   (his words ${MB(s.userText)}, hers ${MB(s.asstText)}, thinking ${MB(s.thinking)})`);
  console.log(`  images          ${s.images}  = ${MB(s.imageB64)} base64`);
  const img = Object.entries(s.toolImg).sort((a, b) => b[1] - a[1]);
  if (img.length) {
    console.log(`  image payload by tool:`);
    for (const [n, b] of img) console.log(`     ${n.padEnd(30)} ${MB(b)}`);
  }
  const txt = Object.entries(s.toolText).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (txt.length) {
    console.log(`  tool text by tool:`);
    for (const [n, b] of txt) console.log(`     ${n.padEnd(30)} ${MB(b)}`);
  }
}

/**
 * One turn against the real binary, in the commander lane's real shape minus
 * MCP — the question here is what the CONTEXT costs, and a tool round trip
 * would add a variable that is the same on both sides of the comparison.
 */
function turn(prompt, { resume, fork = true, sessionId: mint, extraArgs = [] }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--permission-mode", "bypassPermissions",
      "--tools", "",
      "--setting-sources", "",
      "--strict-mcp-config",
      ...extraArgs,
    ];
    if (resume) { args.push("--resume", resume); if (fork) args.push("--fork-session"); }
    else if (mint) args.push("--session-id", mint);

    const env = { ...process.env };
    delete env["ANTHROPIC_API_KEY"];
    delete env["ANTHROPIC_AUTH_TOKEN"];

    const started = Date.now();
    let firstToken;
    const child = spawn(CLAUDE_BIN, args, { cwd: join(HOME, ".syl"), env, stdio: ["pipe", "pipe", "pipe"] });

    let buf = "";
    let init, result, err = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.type === "system" && o.subtype === "init") init = o;
        if (o.type === "assistant" && firstToken === undefined) firstToken = Date.now() - started;
        if (o.type === "result") result = o;
      }
    });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", reject);
    child.on("close", () => {
      if (!result) return reject(new Error(`no result. stderr: ${err.slice(0, 600)}`));
      resolve({
        ms: Date.now() - started,
        firstToken,
        sessionId: result.session_id ?? init?.session_id,
        costUsd: result.total_cost_usd,
        apiKeySource: init?.apiKeySource,
        usage: result.usage,
        text: (result.result ?? "").slice(0, 160),
        isError: result.is_error,
      });
    });

    child.stdin.write(JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    }) + "\n");
    child.stdin.end();
  });
}

const PROMPT = "Reply with exactly the word ACK and nothing else.";

async function measure(label, resume) {
  console.log(`\n--- ${label} (${runs} runs, forked each time) ---`);
  const times = [];
  for (let i = 0; i < runs; i++) {
    try {
      const r = await turn(PROMPT, { resume });
      times.push(r.ms);
      const ctx = r.usage ? (r.usage.input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0) : 0;
      console.log(`  run ${i + 1}: ${String(r.ms).padStart(6)}ms  firstToken=${String(r.firstToken ?? "-").padStart(6)}ms  ctx=${ctx.toLocaleString().padStart(9)}  apiKeySource=${r.apiKeySource}  cost=$${(r.costUsd ?? 0).toFixed(4)}  ${JSON.stringify(r.text)}`);
      if (r.apiKeySource !== "none") throw new Error(`SUBSCRIPTION RAILS VIOLATED: apiKeySource=${r.apiKeySource}`);
    } catch (e) {
      console.log(`  run ${i + 1}: FAILED — ${e.message}`);
    }
  }
  if (times.length) {
    const sorted = [...times].sort((a, b) => a - b);
    console.log(`  min ${sorted[0]}ms  median ${sorted[Math.floor(sorted.length / 2)]}ms  max ${sorted[sorted.length - 1]}ms  avg ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)}ms`);
  }
  return times;
}

console.log(`claude ${cliVersion}   (stamp every number with this)`);
console.log(`commander session: ${sessionId}`);
report("HIS LANE, AS IT STANDS", inspect(sessionId));

if (FLAG("inspect")) process.exit(0);

const target = arg("compare", undefined);
await measure("BEFORE — resuming his lane", sessionId);
if (target) {
  report("COMPARISON LANE", inspect(target));
  await measure("AFTER — resuming the compacted lane", target);
}
