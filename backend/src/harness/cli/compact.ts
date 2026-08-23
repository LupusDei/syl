/**
 * Sweep a lane's thread by hand, ONCE, when waiting for the night is too long.
 *
 *   npm run compact -- --dry-run     what it would do, touching nothing
 *   npm run compact                  do it (refuses if the service is up)
 *
 * ## Why this exists at all
 *
 * `syl-chzl.4.4` put the sweep on the hourly ping behind four gates, one of
 * which is quiet hours — deliberately, because compaction measured **104,504ms**
 * and holding his lane for two minutes while he is awake is its own failure.
 * The consequence is that a lane discovered at 861,739 tokens at midday stays
 * there until 23:00, and his face cannot answer a single question in between.
 *
 * That is the right default and the wrong answer on the day the thread is
 * already too big. So: one operator command, run deliberately, by a person who
 * knows what it costs.
 *
 * ## The one way to make his conversation worse, and the guard that prevents it
 *
 * **A `--resume` against a session another process is already holding.** The
 * service keeps a warm `claude` on the commander lane (`harness/warm-lanes.ts`),
 * and `SylAgent` serialises turns per lane precisely so two processes never
 * append to one transcript. A hand-run turn is outside that queue and cannot be
 * let into it — there is no IPC to the running service's in-memory lock.
 *
 * So this refuses to run while the service is listening. **That is a mechanism,
 * not advice**: {@link refuseIfServiceIsUp} probes the port and exits non-zero,
 * so the dangerous invocation is not merely discouraged, it is unavailable. The
 * operator stops the service, runs this, starts it again — and during that
 * window nothing else can be mid-turn, because nothing else is running.
 *
 * Everything else about the operation is identical to the scheduled path: it is
 * the same `compactLane` against the same `COMPACT_PROMPT`, so there is no
 * second implementation to drift.
 *
 * ## What it does NOT do
 *
 * It does not reset, and it cannot: it is handed `runTurn` and a session id and
 * calls `compactLane`, which takes an `ask` and nothing else. It does not clear
 * the stored session id, does not write a message, does not touch the database,
 * and does not report to him. The lane's id is read and reused, never rewritten.
 */
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../../config.js";
import { sessionStoreFor, sylHome } from "../../index.js";
import { LANES } from "../agent.js";
import { COMPACT_PROMPT, compactLane, describeCompaction } from "../compaction.js";
import { runTurn } from "../session.js";

/**
 * Where the RUNNING service keeps her database, according to launchd.
 *
 * **Not a guess, and not this shell's default.** `config.ts` defaults
 * `SYL_DB_PATH` to the relative `.syl/syl.db`, which resolves against the
 * caller's cwd — so an operator running this from the repo silently targets
 * `<repo>/.syl/syl.db` instead of `~/.syl/syl.db`. The first dry run did
 * exactly that and reported "no stored session" for a lane holding 861,739
 * tokens. That is the safe direction and still the wrong answer, and had a
 * `.syl` existed in the repo it would have been the *dangerous* direction: a
 * `--resume` aimed at somebody else's conversation.
 *
 * The plist is the deployment's own statement of where she lives — the same
 * file launchd reads to start her — so asking it is a correspondence check
 * rather than a second opinion. Absent or unreadable, we fall back to the
 * ordinary configuration and SAY which source was used, because the failure
 * this prevents is quiet confidence about the wrong path.
 */
function deployedDatabasePath(): { path: string; source: string } | undefined {
  const plist = join(homedir(), "Library", "LaunchAgents", "com.jmm.syl.core.plist");
  try {
    const printed = execFileSync("/usr/bin/plutil", ["-p", plist], { encoding: "utf8" });
    const match = /"SYL_DB_PATH"\s*=>\s*"([^"]+)"/u.exec(printed);
    if (match?.[1] !== undefined) return { path: match[1], source: "com.jmm.syl.core.plist" };
  } catch {
    // No plist on this machine, or plutil unavailable. Fall through.
  }
  return undefined;
}

/**
 * Is something listening on Syl's port?
 *
 * A connect probe rather than a pidfile or a `launchctl` query: what matters is
 * whether a process could be **mid-turn on this session right now**, and the
 * honest test for that is whether the service is reachable. A stale pidfile
 * would answer the wrong question confidently.
 */
async function somethingIsListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1_500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** The guard. Exits rather than returning a boolean nobody has to check. */
async function refuseIfServiceIsUp(port: number): Promise<void> {
  if (!(await somethingIsListening(port))) return;
  process.stderr.write(
    `\nREFUSED: something is listening on 127.0.0.1:${String(port)}.\n\n` +
      `  Syl holds a warm \`claude\` process on the commander lane, and \`SylAgent\`\n` +
      `  serialises turns per lane so two processes never append to one transcript.\n` +
      `  A turn started from here is OUTSIDE that queue and cannot be let into it.\n\n` +
      `  Stop her, sweep, start her again:\n\n` +
      `    launchctl bootout gui/$(id -u)/com.jmm.syl\n` +
      `    npm run compact\n` +
      `    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jmm.syl.plist\n\n` +
      `  While she is down he sees a service that is unavailable, which is honest,\n` +
      `  rather than a Syl that says nothing for 104 seconds, which is not.\n\n`,
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const laneAt = argv.indexOf("--lane");
  const lane = laneAt === -1 ? LANES.commander : (argv[laneAt + 1] ?? LANES.commander);

  // PRECEDENCE, AND IT IS NOT COSMETIC. An explicit `SYL_DB_PATH` WINS over the
  // plist, always. The first version of this had it the other way round and the
  // plist silently overrode the env var — which meant this file's own tests,
  // pointed at a temp directory, resolved to the REAL database and ran three
  // `/compact` turns against the Commander's live thread. Nothing was lost,
  // because the transcript is append-only; it was still an unauthorised
  // rewrite of his conversation, executed by a test.
  //
  // The rule that prevents it: **the plist is a fallback for an UNSET variable,
  // never an override for a set one.** Anything that reaches past an explicit
  // instruction to consult the environment is aiming somewhere the caller did
  // not ask for, and here "somewhere" is whichever conversation this machine
  // happens to be running.
  const configured = loadConfig();
  const explicit = process.env["SYL_DB_PATH"] !== undefined;
  const deployed = explicit ? undefined : deployedDatabasePath();
  const config =
    deployed === undefined ? configured : { ...configured, databasePath: deployed.path };
  const home = sylHome(config);
  const source = deployed?.source ?? (explicit ? "SYL_DB_PATH (explicit)" : "config default");

  // THE GUARD BEFORE ANYTHING ELSE CAN FAIL FOR A DULLER REASON. An unsafe run
  // must say so whatever else is wrong with it; reversed, an operator with a
  // missing session file learns only that, fixes it, and meets the real refusal
  // one step later having already decided to push on.
  //
  // **`--dry-run` is exempt, deliberately.** It sends nothing, so it is safe
  // against a live service — and a preview that required taking her down would
  // not be consulted, which would leave the operator improvising the very thing
  // this file exists to make unnecessary. Exempting it is what makes the guard
  // affordable to obey.
  if (!dryRun) await refuseIfServiceIsUp(config.port);

  // Read the session id EXACTLY where the service keeps it, by asking the same
  // function the service asks. A path written out here would be a second
  // opinion about where her conversation lives, and the one that drifted would
  // send `--resume` at nothing.
  const sessionId = sessionStoreFor(config).read(lane);
  if (sessionId === undefined || sessionId.trim() === "") {
    process.stderr.write(
      `Lane "${lane}" has no stored session (looked where the service keeps it, ` +
        `beside ${config.databasePath}). Nothing to compact.\n`,
    );
    process.exit(1);
    return;
  }

  process.stdout.write(`database      ${config.databasePath}  (from ${source})\n`);
  process.stdout.write(`lane          ${lane}\n`);
  process.stdout.write(`session       ${sessionId}\n`);
  process.stdout.write(`prompt        ${COMPACT_PROMPT}\n`);
  process.stdout.write(`transcript    ~/.claude/projects/<slug>/${sessionId}.jsonl (append-only; nothing here rewrites it)\n\n`);

  if (dryRun) {
    process.stdout.write(
      `--dry-run: nothing was sent.\n\n` +
        `  A real run sends ${COMPACT_PROMPT} as one turn on this session and waits.\n` +
        `  It took 104,504ms when measured on CLI 2.1.235 against a 861,739-token\n` +
        `  thread. It appends a compact_boundary frame; every byte before that frame\n` +
        `  stays on disk, and the summary the CLI writes ends with the path of the\n` +
        `  transcript it was made from. The session id does not change.\n`,
    );
    return;
  }

  process.stdout.write(`Compacting. This took 104,504ms when measured — do not interrupt it.\n`);
  const started = Date.now();

  // The SAME function the hourly ping calls, against the same prompt. A second
  // implementation here would be a second thing to keep correct, and the one
  // that drifted would be the one nobody runs.
  const outcome = await compactLane({
    before: 0, // Unknown from here: no turn has reported this lane's size to this
    //           process. Reported honestly rather than guessed — `describeCompaction`
    //           prints what it has, and the next real turn reports the new size.
    ask: (prompt) =>
      runTurn(prompt, {
        resume: sessionId,
        lane,
        permissionMode: "bypassPermissions",
        tools: "",
        settingSources: "",
        strictMcpConfig: true,
        // HER home, resolved exactly as the service resolves it — a turn run
        // from the repo would read this repo's settings instead of hers.
        ...(home === undefined ? {} : { cwd: home }),
      }),
  });

  const elapsed = Date.now() - started;
  process.stdout.write(`\n${describeCompaction(outcome)}\n`);
  process.stdout.write(`took ${elapsed.toLocaleString()}ms\n`);

  if (!outcome.ok) {
    process.stderr.write(
      `\nThe thread was NOT rewritten. A failed compaction writes no boundary frame,\n` +
        `so the transcript is exactly as it was and the lane is merely still large.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `\nStart her again, then ask her something to confirm:\n` +
      `  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jmm.syl.plist\n`,
  );
}

await main();
