/**
 * SPIKE — how long after she has the words until there is a SOUND?
 *
 * ## The question
 *
 * time-to-first-sound = time-to-her-first-text + TTS synthesis.
 *
 * The first half is measured: `first-token-latency.mjs` found ~1635ms on a warm
 * follow-up turn and ~7450ms on a cold one. **The second half had never been
 * measured for the voice she actually uses** — every number in the tree was for
 * the Anthropic side of the pipe, and the mouth cannot open on text.
 *
 * ## Method — deliberately the production path, not a fair-fight benchmark
 *
 * This imports `RunwaySpeechClient` out of `backend/dist` and drives
 * `HER_VOICE` with the reference clip that is on this machine. Same endpoint,
 * same `seed_audio` model, same `reference-audio` body, same base64'd 28-second
 * clip on the wire. A hand-rolled client calling a cheaper vendor would produce
 * a number that is not about Syl.
 *
 * Three utterances of realistic length, run ONCE each — this spends real money.
 * The interesting output is not the mean, it is **whether the clock scales with
 * character count**: if it does, a long answer is a different product from a
 * short one, and the covering behaviour has to carry a variable gap rather than
 * a fixed one.
 *
 * ## What "first playable audio" means for a task API
 *
 * `POST /v1/text_to_speech` is not a stream. It hands back a task id, and the
 * mp3 exists only when `GET /v1/tasks/{id}` says `SUCCEEDED` and names a signed
 * URL. So there are two honest instants and both are reported:
 *
 *   ready       the URL exists — the earliest a streaming player could begin
 *   on disk     the mp3 is local and definitely playable
 *
 * Polled at 250ms rather than production's 3000ms, so the number measured is
 * synthesis rather than our own poll quantisation. What production would
 * actually observe is reported alongside it, rounded up to the 3s grid.
 *
 * Deliberately NOT a test. Throwaway, in the same shape as
 * `first-token-latency.mjs`.
 *
 * Usage:
 *   export RUNWAYML_API_SECRET=...   # from com.jmm.syl.core.plist, never printed
 *   node scripts/experiments/tts-synthesis-latency.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { HER_VOICE, samplePath } from "../../backend/dist/voice/her-voice.js";
import { RunwaySpeechClient } from "../../backend/dist/voice/speech.js";
import { isTerminal } from "../../backend/dist/render/runway.js";

/** Her first-text latency, warm and cold, from `first-token-latency.mjs` @ 28746b5. */
const FIRST_TEXT_WARM_MS = 1635;
const FIRST_TEXT_COLD_MS = 7450;

/** Fine enough to measure synthesis instead of our own sleep. */
const POLL_MS = 250;
/** What production actually polls at (`voice-service.ts`). */
const PRODUCTION_POLL_MS = 3_000;
const GIVE_UP_MS = 180_000;

/**
 * Three lengths, chosen to be the shapes she actually answers in.
 *
 * Kept short on purpose — each one is a real charge, and the paragraph is still
 * only a paragraph.
 */
const UTTERANCES = [
  { label: "one sentence", text: "The deploy went green about ten minutes ago." },
  {
    label: "two sentences",
    text:
      "The deploy went green about ten minutes ago, and the health gate confirmed the new commit " +
      "is the one answering. Nothing rolled back.",
  },
  {
    label: "short paragraph",
    text:
      "The deploy went green about ten minutes ago, and the health gate confirmed the new commit " +
      "is the one answering, so nothing rolled back. Two things are still open from this morning: " +
      "the pairing flow needs a decision about which scope a phone gets, and the reader path is " +
      "waiting on you to say whether quarantine is strict enough. Neither is urgent, but the first " +
      "one blocks the others.",
  },
];

const secret = (process.env["RUNWAYML_API_SECRET"] ?? "").trim();
if (secret === "") {
  console.error(
    "RUNWAYML_API_SECRET is not in the environment. It lives in\n" +
      "  ~/Library/LaunchAgents/com.jmm.syl.core.plist\n" +
      "Source it for the run; do not write it anywhere.",
  );
  process.exit(1);
}

const home = process.env["SYL_HOME"] ?? join(homedir(), ".syl");
const sample = samplePath(home, HER_VOICE);
if (!existsSync(sample)) {
  console.error(`Her reference clip is not at ${sample}, so there is no voice to measure.`);
  process.exit(1);
}
const referenceMp3 = readFileSync(sample);

const outDir = mkdtempSync(join(tmpdir(), "syl-tts-spike-"));
const client = new RunwaySpeechClient({ secret });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`voice:      ${HER_VOICE.name} (${HER_VOICE.model})`);
console.log(`reference:  ${sample} — ${String(referenceMp3.length)} bytes`);
console.log(`poll:       ${String(POLL_MS)}ms (production polls at ${String(PRODUCTION_POLL_MS)}ms)`);
console.log(`output:     ${outDir}\n`);

/** One utterance, timed end to end. */
async function measure(utterance, index) {
  const chars = utterance.text.length;
  console.log(`── ${utterance.label} — ${String(chars)} chars ──`);

  const t0 = Date.now();
  const submitted = await client.submit({
    model: HER_VOICE.model,
    promptText: utterance.text,
    referenceMp3,
    outputFormat: HER_VOICE.outputFormat,
  });
  const submitMs = Date.now() - t0;
  if (!submitted.ok) {
    console.log(`   REFUSED after ${String(submitMs)}ms: ${submitted.failure.message}\n`);
    return { ...utterance, chars, failed: submitted.failure.message };
  }
  console.log(`   submitted at ${String(submitMs)}ms — task ${submitted.data.id}`);

  let url = null;
  let credits = submitted.data.estimatedCredits;
  let polls = 0;
  while (Date.now() - t0 < GIVE_UP_MS) {
    await sleep(POLL_MS);
    polls += 1;
    const task = await client.task(submitted.data.id);
    if (!task.ok) {
      if (!task.failure.retryable) {
        console.log(`   task read failed: ${task.failure.message}\n`);
        return { ...utterance, chars, failed: task.failure.message };
      }
      continue;
    }
    if (!isTerminal(task.data.status)) continue;
    if (task.data.status !== "SUCCEEDED") {
      console.log(`   ended ${task.data.status}\n`);
      return { ...utterance, chars, failed: `ended ${task.data.status}` };
    }
    url = task.data.output[0] ?? null;
    if (task.data.credits !== null) credits = task.data.credits;
    break;
  }
  if (url === null) {
    console.log(`   never produced audio within ${String(GIVE_UP_MS)}ms\n`);
    return { ...utterance, chars, failed: "no audio before give-up" };
  }

  const readyMs = Date.now() - t0;
  const to = join(outDir, `${String(index + 1)}.mp3`);
  const downloaded = await client.download(url, to);
  const onDiskMs = Date.now() - t0;

  console.log(`   ready at     ${String(readyMs)}ms  (${String(polls)} polls)`);
  console.log(
    `   on disk at   ${String(onDiskMs)}ms` +
      (downloaded.ok ? `  — ${String(downloaded.data)} bytes` : `  — download failed: ${downloaded.failure.message}`),
  );
  console.log(`   credits      ${credits === null ? "not reported" : String(credits)}\n`);

  return { ...utterance, chars, submitMs, readyMs, onDiskMs, credits, failed: null };
}

/** Least-squares slope of ms against chars, so "does it scale" is a number. */
function slope(rows) {
  const n = rows.length;
  const mx = rows.reduce((a, r) => a + r.chars, 0) / n;
  const my = rows.reduce((a, r) => a + r.onDiskMs, 0) / n;
  const num = rows.reduce((a, r) => a + (r.chars - mx) * (r.onDiskMs - my), 0);
  const den = rows.reduce((a, r) => a + (r.chars - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

const results = [];
for (const [index, utterance] of UTTERANCES.entries()) {
  results.push(await measure(utterance, index));
}

const good = results.filter((r) => r.failed === null);
console.log("─── synthesis, her voice ───");
for (const r of results) {
  if (r.failed !== null) {
    console.log(`  ${r.label.padEnd(16)} ${String(r.chars).padStart(4)} chars   FAILED: ${r.failed}`);
    continue;
  }
  console.log(
    `  ${r.label.padEnd(16)} ${String(r.chars).padStart(4)} chars   ` +
      `submit ${String(r.submitMs).padStart(5)}ms   ready ${String(r.readyMs).padStart(6)}ms   ` +
      `on disk ${String(r.onDiskMs).padStart(6)}ms   ${String(Math.round(r.onDiskMs / r.chars))}ms/char`,
  );
}

if (good.length === 0) {
  console.log("\n  Nothing succeeded, so there is no number.");
  process.exit(1);
}

const mean = Math.round(good.reduce((a, r) => a + r.onDiskMs, 0) / good.length);
const shortest = good[0];
console.log(`\n  mean synthesis (to playable on disk): ${String(mean)}ms`);

if (good.length > 1) {
  const perChar = slope(good);
  const spread = Math.max(...good.map((r) => r.onDiskMs)) - Math.min(...good.map((r) => r.onDiskMs));
  console.log(
    `  scales with length: ${
      Math.abs(perChar) < 2 ? "NO — flat" : "YES"
    } — ${String(Math.round(perChar * 100) / 100)}ms per character, ` +
      `${String(spread)}ms spread across ${String(good[0].chars)}–${String(good[good.length - 1].chars)} chars`,
  );
}

const totalWarm = FIRST_TEXT_WARM_MS + shortest.onDiskMs;
const totalCold = FIRST_TEXT_COLD_MS + shortest.onDiskMs;
console.log(`\n  TIME TO FIRST SOUND, one-sentence answer`);
console.log(`    warm turn: ${String(FIRST_TEXT_WARM_MS)}ms + ${String(shortest.onDiskMs)}ms = ${String(totalWarm)}ms`);
console.log(`    cold turn: ${String(FIRST_TEXT_COLD_MS)}ms + ${String(shortest.onDiskMs)}ms = ${String(totalCold)}ms`);
console.log(
  `\n  VERDICT: ${
    totalWarm < 2_000
      ? "COMFORTABLE — under ~2s."
      : totalWarm <= 4_000
        ? "SURVIVES ONLY WITH A COVERING BEHAVIOUR — the gap is Phase 5's whole budget."
        : "REFUSED at this attach point — over ~4s on a one-sentence answer."
  }`,
);

const billed = good.reduce((a, r) => a + (r.credits ?? 0), 0);
console.log(`\n  credits reported across ${String(good.length)} utterances: ${String(billed)}`);
