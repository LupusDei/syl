/**
 * Does `/compact` work on the WARM path — one live process serving many turns?
 *
 * `syl-chzl.4.4`. The compaction turn is taken by the hourly ping, which goes
 * `SylAgent` -> `WarmLanes` -> `PersistentSession`, so it lands in a process
 * that then has to serve the NEXT turn. The first capture spawned a fresh
 * process for the follow-up, which verifies the *resumed* case and says nothing
 * about this one — and "the live process is unusable after a compaction" would
 * be a defect that only ever appears in production.
 *
 * It also produces the AFTER number in the shape that actually matters: a WARM
 * follow-up is what a face question is.
 *
 *   npx tsx scripts/experiments/warm-lane-compaction.mts <session-id>
 *
 * Pass a session you do not mind rewriting. NEVER his live lane — read
 * `~/.syl/sessions/commander`, fork it with `--fork-session`, and pass the fork.
 */
import { PersistentSession } from "../../backend/src/harness/persistent-session.js";

const SESSION = process.argv[2];
if (SESSION === undefined) throw new Error("pass a session id to resume");

const base = {
  permissionMode: "bypassPermissions",
  tools: "",
  settingSources: "",
  strictMcpConfig: true,
  cwd: `${process.env["HOME"]}/.syl`,
  lane: "commander",
} as const;

const session = new PersistentSession({ lane: "commander" });

async function turn(label: string, prompt: string, resume?: string) {
  const started = Date.now();
  const r = await session.run(prompt, { ...base, ...(resume === undefined ? {} : { resume }) });
  const ms = Date.now() - started;
  console.log(
    `  ${label.padEnd(28)} ${String(ms).padStart(7)}ms  ctx=${r.contextTokens.toLocaleString().padStart(9)}  ` +
      `apiKeySource=${r.init.apiKeySource}  ${JSON.stringify(r.text.slice(0, 50))}`,
  );
  // Constraint 3, asserted on THIS turn's own init — the CLI emits a fresh one
  // every turn, which is what makes a long-lived process safe here.
  if (r.init.apiKeySource !== "none") throw new Error(`RAILS VIOLATED: ${r.init.apiKeySource}`);
  return r;
}

const ACK = "Reply with exactly the word ACK and nothing else.";
console.log(`warm path, ONE process, resuming ${SESSION}\n`);
const first = await turn("turn 1 (pays the spawn)", ACK, SESSION);
await turn("turn 2 WARM (the face case)", ACK);
await turn("turn 3 WARM", ACK);
console.log("\n  --- /compact in the SAME live process ---");
await turn("turn 4 /compact", "/compact");
console.log("\n  --- can that process still serve turns? ---");
await turn("turn 5 WARM after compact", ACK);
await turn("turn 6 WARM after compact", ACK);
console.log(`\n  session id throughout: ${first.sessionId}`);
await session.close();
