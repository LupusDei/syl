/**
 * SPIKE — how long until she starts SPEAKING?
 *
 * ## The question, and why the existing measurement does not answer it
 *
 * `persistent-session.mjs` measured time to `result` — turn COMPLETION — and
 * found ~1.4s on follow-up turns against 5.5-9.7s for a fresh spawn. That is
 * the right number for "when is the answer ready".
 *
 * **It is the wrong number for a live face.** A speaking avatar does not wait
 * for the turn to finish; it starts speaking on the first words and streams the
 * rest. So the number that decides whether a real-time character is possible is
 * TIME TO FIRST ASSISTANT TEXT, and `syl-per1` says so in its own description:
 * *"first-token latency, which is what TTS actually needs, will be lower still.
 * Measure that separately before promising anything."*
 *
 * Nobody measured it separately. This does.
 *
 * ## What a result means
 *
 * The budget is a spoken one. A person perceives a reply as immediate under
 * roughly 300ms, conversational to about 1s, and laboured past 2s.
 *
 *   under ~800ms   a live character is viable; the mouth can open on time
 *   1-2s           viable only with a covering behaviour — a glance, a breath,
 *                  something that is honestly her thinking rather than a stall
 *   over ~2s       the face is a liability. It would sit there, and a face that
 *                  sits there is worse than no face, because the halo never
 *                  pretended to be about to speak
 *
 * ## Method
 *
 * One process, several turns, stdin held open — the persistent-session shape
 * that `runTurn` does not use yet (`syl-per1`). For each turn we record the
 * first `assistant` text event and the `result`, so the gap between "she starts"
 * and "she finishes" is visible too: that gap is the room TTS has to work in.
 *
 * Deliberately NOT a test. A throwaway harness, in the shape the Bridge's own
 * spec used for the same purpose — "throwaway code, not production, not TDD".
 *
 * Usage: node scripts/experiments/first-token-latency.mjs [turns]
 */

import { spawn } from "node:child_process";

const TURNS = Number(process.argv[2] ?? 4);
const GIVE_UP_MS = 120_000;

/** Short prompts: we are measuring the pipe, not her reasoning. */
const PROMPTS = [
  "Say hello in one short sentence.",
  "What is two plus two? One sentence.",
  "Name one colour. One word is fine.",
  "Say goodbye in one short sentence.",
  "Count to three.",
  "Name a bird.",
];

function frame(text) {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

// Constraint 3: never let a credential reach the child.
const env = { ...process.env };
delete env["ANTHROPIC_API_KEY"];
delete env["ANTHROPIC_AUTH_TOKEN"];

const args = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--strict-mcp-config",
];

console.log(`spawning: claude ${args.join(" ")}`);
console.log(`turns: ${String(TURNS)}\n`);

const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });

/** One row per turn. */
const rows = [];
let turnIndex = -1;
let sentAt = 0;
let buffer = "";
let apiKeySource = null;

function sendTurn() {
  turnIndex += 1;
  if (turnIndex >= TURNS) return finish();
  rows.push({ turn: turnIndex + 1, firstText: null, result: null });
  sentAt = Date.now();
  child.stdin.write(frame(PROMPTS[turnIndex % PROMPTS.length]));
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const at = Date.now() - sentAt;
    const row = rows[turnIndex];

    if (event.type === "system" && event.subtype === "init") {
      // Constraint 3 again, asserted rather than assumed: a set key silently
      // outranks the subscription login and reroutes billing.
      apiKeySource = event.apiKeySource ?? null;
      console.log(`init: apiKeySource=${String(apiKeySource)}`);
      continue;
    }

    // FIRST ASSISTANT TEXT — the measurement this file exists for.
    if (event.type === "assistant" && row !== undefined && row.firstText === null) {
      const content = event.message?.content;
      const hasText = Array.isArray(content)
        ? content.some((part) => part?.type === "text" && String(part.text ?? "").trim() !== "")
        : false;
      if (hasText) {
        row.firstText = at;
        console.log(`turn ${String(row.turn)}: first text at ${String(at)}ms`);
      }
    }

    if (event.type === "result" && row !== undefined && row.result === null) {
      row.result = at;
      console.log(`turn ${String(row.turn)}: result    at ${String(at)}ms`);
      sendTurn();
    }
  }
});

child.stderr.on("data", (c) => process.stderr.write(c));

function finish() {
  child.stdin.end();

  console.log("\n─── first token, which is what a speaking face needs ───");
  for (const r of rows) {
    const gap = r.firstText !== null && r.result !== null ? r.result - r.firstText : null;
    console.log(
      `  turn ${String(r.turn)}  first text ${String(r.firstText ?? "—")}ms` +
        `   result ${String(r.result ?? "—")}ms` +
        `   speaking room ${gap === null ? "—" : `${String(gap)}ms`}`,
    );
  }

  // Turn 1 pays CLI startup and is reported separately — averaging it in would
  // hide the number that actually matters, which is the steady state.
  const followUps = rows.slice(1).map((r) => r.firstText).filter((v) => v !== null);
  if (followUps.length > 0) {
    const avg = Math.round(followUps.reduce((a, b) => a + b, 0) / followUps.length);
    console.log(`\n  turn 1 first text (pays CLI startup): ${String(rows[0]?.firstText ?? "—")}ms`);
    console.log(`  follow-up first text, average:        ${String(avg)}ms`);
    console.log(
      `\n  VERDICT: ${
        avg < 800
          ? "VIABLE — the mouth can open on time."
          : avg < 2000
            ? "VIABLE ONLY WITH A COVERING BEHAVIOUR — she needs something honest to do while thinking."
            : "NOT VIABLE as a speaking face on this architecture."
      }`,
    );
  }

  if (apiKeySource !== "none") {
    console.log(`\n  WARNING: apiKeySource was ${String(apiKeySource)}, not "none".`);
  }
  process.exit(0);
}

setTimeout(() => {
  console.error(`\ngave up after ${String(GIVE_UP_MS)}ms`);
  child.kill("SIGKILL");
  process.exit(1);
}, GIVE_UP_MS);

sendTurn();
