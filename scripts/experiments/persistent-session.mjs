#!/usr/bin/env node
/**
 * Does a turn complete WITHOUT stdin EOF, on this CLI version?
 *
 * `docs/CONTEXT.md` §3 records the constraint the whole architecture rests on:
 *
 *   "In -p mode with --input-format stream-json, a turn does not complete until
 *    stdin reaches EOF. Verified by holding stdin open for 25 seconds: elapsed
 *    time was 26 seconds, and the result arrived only on close."
 *
 * That was measured on an older CLI. Everything downstream follows from it —
 * one subprocess per turn, continuity via `--resume`, and a latency floor of
 * ~5.5s that makes real-time voice impossible. Before designing around that
 * floor it is worth re-measuring, because if it has changed the floor mostly
 * disappears.
 *
 * THE EXPERIMENT, and it is deliberately falsifiable:
 *
 *   1. Spawn the CLI exactly as `runTurn` does.
 *   2. Send one user frame and DO NOT close stdin.
 *   3. Wait. If a `result` arrives anyway, the constraint no longer holds.
 *   4. If it does, send a SECOND frame down the SAME process and time it.
 *
 * Step 4 is the number that actually matters. Turn one pays CLI startup no
 * matter what; if turn two comes back in ~1s instead of ~5.5s, a persistent
 * session is worth building and voice becomes plausible. If turn two costs the
 * same, persistence buys nothing and the floor is the round trip itself.
 *
 * Usage: node scripts/experiments/persistent-session.mjs
 */

import { spawn } from "node:child_process";

const HOLD_MS = 45_000;

function frame(text) {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
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
  "--model", "haiku",
  "--strict-mcp-config",
];

console.log(`spawning: claude ${args.join(" ")}\n`);
const started = Date.now();
const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });

let buffer = "";
let firstResultAt = null;
let secondSentAt = null;
let secondResultAt = null;
const followUps = [];
let stdinClosed = false;

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
    const at = Date.now() - started;

    if (event.type === "system" && event.subtype === "init") {
      console.log(`[${at}ms] init — session ${event.session_id}`);
    }

    if (event.type === "result") {
      if (firstResultAt === null) {
        firstResultAt = at;
        console.log(`[${at}ms] RESULT #1 arrived — stdin still open? ${!stdinClosed}`);
        if (!stdinClosed) {
          console.log("\n*** THE CONSTRAINT NO LONGER HOLDS — a result arrived WITHOUT EOF ***\n");
          console.log("sending a second frame down the same process...");
          secondSentAt = Date.now();
          child.stdin.write(frame("Say only: two"));
        }
      } else {
        const took = Date.now() - secondSentAt;
        followUps.push(took);
        console.log(`[${at}ms] RESULT #${followUps.length + 1} — ${took}ms (no process startup)`);
        if (followUps.length < 4) {
          secondSentAt = Date.now();
          child.stdin.write(frame(`Say only: ${String(followUps.length + 2)}`));
        } else {
          const avg = Math.round(followUps.reduce((a, b) => a + b, 0) / followUps.length);
          console.log(`\nPERSISTENT SESSIONS WORK.`);
          console.log(`  turn 1 (with CLI startup): ${firstResultAt}ms`);
          console.log(`  follow-up turns: ${followUps.join("ms, ")}ms`);
          console.log(`  average follow-up: ${avg}ms`);
          child.stdin.end();
          setTimeout(() => child.kill("SIGTERM"), 500);
        }
      }
    }
  }
});

child.stderr.on("data", (c) => process.stderr.write(c));

child.stdin.write(frame("Say only: one"));
console.log("[0ms] wrote frame #1, holding stdin OPEN\n");

// If nothing comes back while stdin is open, the constraint still holds.
setTimeout(() => {
  if (firstResultAt === null) {
    console.log(`\n[${HOLD_MS}ms] no result while stdin was open.`);
    console.log("Closing stdin now — if a result appears immediately, the constraint STILL HOLDS.\n");
    stdinClosed = true;
    child.stdin.end();
    setTimeout(() => {
      if (firstResultAt !== null) {
        console.log("\n*** CONSTRAINT CONFIRMED: the result arrived only on EOF. ***");
        console.log("One subprocess per turn remains forced. The latency floor is real.");
      } else {
        console.log("\n??? no result even after EOF — something else is wrong.");
      }
      child.kill("SIGTERM");
      process.exit(0);
    }, 20_000);
  }
}, HOLD_MS);

child.on("exit", (code, signal) => {
  console.log(`\nchild exited code=${code} signal=${signal} after ${Date.now() - started}ms`);
  process.exit(0);
});
