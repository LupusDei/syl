#!/usr/bin/env node
/**
 * Render a shot of Syl, and write down what rendered it.
 *
 *   npm run video -- 1-emerge
 *   npm run video -- --all
 *   npm run video -- --concat loop
 *
 * ## Why this script exists rather than a shell history
 *
 * Eight loops were generated on 2026-08-10. Several are lovely. **The prompts
 * were never recorded**, so on 2026-08-11 there was no way to make a ninth in
 * the same style, and no way to re-run the two that failed with one thing
 * changed. The outputs survived and the inputs did not, which is the same
 * defect this project keeps finding elsewhere: a result kept, and the thing
 * that produced it thrown away.
 *
 * So the rule here: **a shot is its prompt, not its mp4.** `shots.json` holds
 * the shots. Every render writes a sidecar `.json` beside the video recording
 * the exact model, prompt, reference, duration and task id that produced it —
 * so a file on disk can always answer "what made you", and a good accident can
 * be repeated.
 *
 * ## What it does not do
 *
 * It does not overwrite a video that already exists (pass `--force`). Renders
 * cost real credits and an accidental re-run of `--all` is eight of them.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

/**
 * Where the reference and the rendered videos live: **Syl's home.**
 *
 * The Commander's ruling, 2026-08-11: *"her videos should be generated and
 * placed within her context I think. certainly not in temp or in the runway
 * project."* This used to resolve `../runwayml`, a separate toolkit checkout,
 * and `backend/src/render/studio.ts` has the whole of why that was wrong.
 *
 * Still outside the repository, which was the original and correct reason for
 * not putting it in `assets/`: a 15s render is 12-15MB. Her home is not a
 * repository — it is where her database, her sessions and her memory already
 * live.
 *
 * **The same rule the service uses, in the same order**, so a render she made
 * and a render this script made land in the same directory under the same
 * naming rule and either can find the other: `SYL_VIDEO_STUDIO`, then her home
 * (the directory holding `SYL_DB_PATH`), then `.syl/` beside the source, which
 * is where the default configuration puts the database.
 */
const STUDIO =
  process.env.SYL_VIDEO_STUDIO ??
  (process.env.SYL_DB_PATH ? dirname(resolve(process.env.SYL_DB_PATH)) : resolve(repoRoot, ".syl"));

/** Her renders, flat, exactly as `studioAt` lays them out. */
const RENDER_DIR = join(STUDIO, "renders");

const API_BASE = "https://api.dev.runwayml.com/v1";
const API_VERSION = "2024-11-06";
const POLL_MS = 5_000;
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED", "CANCELLED"]);

function die(message) {
  console.error(`\n[syl-video] ${message}\n`);
  process.exit(1);
}

function auth() {
  const secret = process.env.RUNWAYML_API_SECRET;
  if (!secret) {
    die(
      "RUNWAYML_API_SECRET is not set.\n\n" +
        "  Renders are billed to the Runway account, not to the Claude subscription —\n" +
        "  this is the one place in the project that spends metered money, which is why\n" +
        "  it is a separate key and a separate script.\n\n" +
        "  Export it, or put it in the environment the service is started with — the\n" +
        "  same secret `RunwayClient` reads. It is never written into her home.",
    );
  }
  return {
    Authorization: `Bearer ${secret}`,
    "X-Runway-Version": API_VERSION,
    "Content-Type": "application/json",
  };
}

async function api(method, path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: auth(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) die(`API ${response.status} on ${method} ${path}\n\n  ${text}`);
  return text === "" ? {} : JSON.parse(text);
}

/**
 * A local image as a data URI, which is how Runway takes a `promptImage`.
 *
 * **`promptImage` is the video's first frame**, not a style hint, and it also
 * decides the video's shape — see `backend/src/render/studio.ts`. The default
 * is therefore the bare ribbon every loop opens on, and handing over her
 * smiling headshot instead is exactly the defect that made the service's
 * renders open on her face, in landscape.
 */
function asDataUri(path) {
  const full = resolve(STUDIO, path);
  if (!existsSync(full)) {
    die(
      `Opening image not found: ${full}\n\n` +
        "  It is the first frame of the clip, and its shape is the clip's shape.\n" +
        "  The service places it on boot from `assets/syl_opening_ribbon.png`;\n" +
        "  copy that there by hand if you are running this on a machine that has\n" +
        "  never booted her — see docs/VIDEO.md.",
    );
  }
  const kind = full.endsWith(".png") ? "png" : "jpeg";
  return `data:image/${kind};base64,${readFileSync(full).toString("base64")}`;
}

async function poll(taskId) {
  for (;;) {
    const task = await api("GET", `/tasks/${taskId}`);
    if (TERMINAL.has(task.status)) return task;
    process.stderr.write(`  …${task.status}\n`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function download(url, to) {
  const response = await fetch(url);
  if (!response.ok) die(`Could not download the finished render: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(to));
}

/**
 * Render one shot and record what rendered it.
 *
 * The sidecar is the point. `renderedAt` is stamped after the fact rather than
 * passed in, and `taskId` is kept because it is the only handle Runway will
 * accept if a render needs chasing up later.
 */
async function render(shot, defaults, { force }) {
  mkdirSync(RENDER_DIR, { recursive: true });
  const out = join(RENDER_DIR, `syl-loop-${shot.name}.mp4`);
  const startedAt = new Date().toISOString();

  if (existsSync(out) && !force) {
    console.log(`  ${shot.name}: already rendered — pass --force to spend credits again`);
    return out;
  }

  const spec = {
    model: shot.model ?? defaults.model,
    promptImage: asDataUri(shot.reference ?? defaults.reference),
    promptText: shot.prompt,
    ratio: shot.ratio ?? defaults.ratio,
    duration: shot.duration ?? defaults.duration,
  };

  console.log(`  ${shot.name}: submitting (${spec.model}, ${spec.duration}s, ${spec.ratio})`);
  const created = await api("POST", "/image_to_video", spec);
  const task = await poll(created.id);
  if (task.status !== "SUCCEEDED") die(`${shot.name} did not succeed:\n\n${JSON.stringify(task, null, 2)}`);

  const url = (task.output ?? task.artifacts ?? [])[0];
  if (!url) die(`${shot.name} succeeded with no output.`);
  await download(url, out);

  // The record, written beside the thing it explains, in the SHAPE THE SERVICE
  // READS — `backend/src/render/render-service.ts`, `RenderRecord`. A sidecar
  // that is missing a field is not a record there; it is `unreadable`, which is
  // its own state and deliberately not "failed". That distinction was bought
  // with a real lie: a hand-written sidecar with no `status` had her report a
  // render still in flight as one that had failed.
  //
  // `credits` and `usd` are `null` rather than a guess. This script does not
  // price a render, and "nobody wrote down what this cost" and "this was free"
  // are different facts.
  //
  // `promptImage` is omitted deliberately — it is a multi-megabyte data URI,
  // and the PATH is the useful fact. Keeping the base64 would make this file
  // unreadable to a person, which is the one thing it must not be.
  writeFileSync(
    `${out}.json`,
    `${JSON.stringify(
      {
        name: `syl-loop-${shot.name}`,
        status: "ready",
        startedAt,
        renderedAt: new Date().toISOString(),
        taskId: created.id,
        model: spec.model,
        ratio: spec.ratio,
        duration: spec.duration,
        reference: shot.reference ?? defaults.reference,
        framing: shot.framing,
        prompt: shot.prompt,
        because: `A shot from scripts/video/shots.json, rendered with \`npm run video -- ${shot.name}\`.`,
        reason: null,
        credits: null,
        usd: null,
        video: out,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`  ${shot.name}: saved ${out}`);
  return out;
}

/**
 * Join rendered shots end to end.
 *
 * `-c copy` rather than a re-encode: every clip comes from the same model at
 * the same ratio, so the streams are already compatible and re-encoding would
 * cost quality for nothing.
 */
function concat(names, outName) {
  const dir = RENDER_DIR;
  const files = names.map((n) => join(dir, `syl-loop-${n}.mp4`));
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length > 0) die(`Cannot concatenate — not rendered yet:\n\n  ${missing.join("\n  ")}`);

  const list = join(dir, `${outName}.concat.txt`);
  writeFileSync(list, `${files.map((f) => `file '${f}'`).join("\n")}\n`);
  const out = join(dir, `${outName}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
  console.log(`  joined ${files.length} shots -> ${out}`);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const named = args.filter((a) => !a.startsWith("--"));

  const manifest = JSON.parse(readFileSync(join(here, "shots.json"), "utf8"));
  const { defaults, shots } = manifest;

  if (args.includes("--list") || args.length === 0) {
    console.log("\nShots in scripts/video/shots.json:\n");
    for (const s of shots) {
      const flag = s.knownProblem ? "  ⚠ " : "    ";
      console.log(`${flag}${s.name.padEnd(18)} ${s.framing ?? ""}`);
    }
    console.log("\n  npm run video -- <name>        render one");
    console.log("  npm run video -- --all         render every shot");
    console.log("  npm run video -- --concat all  join them in manifest order\n");
    console.log("  ⚠ marks a shot with a known consistency problem — see docs/VIDEO.md\n");
    return;
  }

  if (args.includes("--concat")) {
    const label = named[0] ?? "all";
    concat(shots.map((s) => s.name), `syl-loop-${label}`);
    return;
  }

  const chosen = args.includes("--all") ? shots : shots.filter((s) => named.includes(s.name));
  if (chosen.length === 0) die(`No shot named ${named.join(", ")}. Run with --list.`);

  for (const shot of chosen) {
    if (shot.knownProblem) {
      console.log(`\n  ⚠ ${shot.name} has a known consistency problem:\n    ${shot.knownProblem}\n`);
    }
    await render(shot, defaults, { force });
  }
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
