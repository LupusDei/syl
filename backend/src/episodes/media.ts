/**
 * What an episode needs from ffmpeg and whisper (`syl-8tts`): hearing a take,
 * measuring a mix, and assembling scenes under one music bed.
 *
 * Each binary is called through an injected {@link MediaRunner}, the seam
 * `render/frames.ts` uses, so no test runs ffmpeg or whisper. The parsers are
 * pinned against output captured from the real binaries on this machine
 * (`tests/fixtures/whisper-cli-scene.txt`, `ffmpeg-ebur128-summary.txt`) rather
 * than against what we think they print.
 *
 * whisper-cli is new to this service. It runs locally, costs nothing, and is
 * the only thing that can tell a take that said its line from one that said
 * something else.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { TARGET_LUFS } from "./rules.js";

export interface RunOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** Why it failed, when it did. Empty on success. */
  readonly message: string;
}

export type MediaRunner = (file: string, args: readonly string[], timeoutMs: number) => Promise<RunOutcome>;

const run = promisify(execFile);

/** The default runner: the real binary, answering with a value rather than a throw. */
export const mediaRunner: MediaRunner = async (file, args, timeoutMs) => {
  try {
    const { stdout, stderr } = await run(file, [...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, stdout, stderr, message: "" };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      message: failed.message ?? String(error),
    };
  }
};

export interface MediaTools {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly whisper: string;
  /** The whisper model file, e.g. `ggml-base.en.bin`. */
  readonly whisperModel: string;
  readonly run: MediaRunner;
}

export type MediaResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const MINUTE = 60_000;

/**
 * whisper-cli's transcript as one line of text.
 *
 * Only the TIMESTAMPED form is ever asked for. `-nt` silently drops whole
 * segments, and in the kit that looked exactly like a take that had skipped
 * half its line.
 */
export function parseWhisper(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => line.replace(/^\s*\[[^\]]*\]\s*/u, "").trim())
    .filter((line) => line !== "")
    .join(" ");
}

/**
 * The integrated loudness from ffmpeg's ebur128 SUMMARY, or `null`.
 *
 * Every progress line also carries an `I:` value, a running one. Only the
 * figure under `Summary:` is the whole file's, so that block is found first.
 */
export function parseIntegratedLoudness(stderr: string): number | null {
  const summary = stderr.split("Summary:")[1];
  if (summary === undefined) return null;
  const found = /I:\s+(-?\d+(?:\.\d+)?) LUFS/u.exec(summary);
  return found?.[1] === undefined ? null : Number(found[1]);
}

/** Hear a take: its own audio, transcribed. */
export async function transcribe(tools: MediaTools, media: string, workDir: string, stem: string): Promise<MediaResult<string>> {
  const wav = join(workDir, `${stem}.16k.wav`);
  const extracted = await tools.run(
    tools.ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", "-i", media, "-vn", "-ar", "16000", "-ac", "1", wav],
    2 * MINUTE,
  );
  if (!extracted.ok) return { ok: false, reason: `ffmpeg could not pull the audio out of ${stem}: ${extracted.message}` };
  const heard = await tools.run(tools.whisper, ["-m", tools.whisperModel, "-f", wav, "-np"], 5 * MINUTE);
  if (!heard.ok) return { ok: false, reason: `whisper could not transcribe ${stem}: ${heard.message}` };
  return { ok: true, value: parseWhisper(heard.stdout) };
}

export async function durationOf(tools: MediaTools, media: string): Promise<MediaResult<number>> {
  const probed = await tools.run(
    tools.ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", media],
    MINUTE,
  );
  const seconds = Number(probed.stdout.trim());
  if (!probed.ok || !Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, reason: `ffprobe could not read how long ${media} is. ${probed.message}`.trim() };
  }
  return { ok: true, value: seconds };
}

export async function loudnessOf(tools: MediaTools, media: string): Promise<MediaResult<number>> {
  const measured = await tools.run(
    tools.ffmpeg,
    ["-hide_banner", "-nostats", "-i", media, "-af", "ebur128", "-f", "null", "-"],
    5 * MINUTE,
  );
  const lufs = parseIntegratedLoudness(measured.stderr);
  if (!measured.ok || lufs === null) return { ok: false, reason: `ffmpeg could not measure the loudness of ${media}.` };
  return { ok: true, value: lufs };
}

/**
 * The ffmpeg arguments that turn scenes into an episode.
 *
 * 1. The scenes are concatenated WITH their own audio. Her voice and the
 *    effects were generated with the picture and must not be separated from it.
 * 2. One music bed is looped under the whole episode at a low level, faded in
 *    and out.
 * 3. The bed is ducked under her voice (`sidechaincompress` keyed on the
 *    dialogue), so the music never competes with a line.
 * 4. The mix is normalised to -16 LUFS, a phone's loudness, which is where he
 *    and the children will hear it.
 */
export function assemblyArgs(clips: readonly string[], seconds: readonly number[], bed: string, out: string): string[] {
  if (clips.length === 0 || clips.length !== seconds.length) {
    throw new RangeError("assembly needs one duration per clip, and at least one clip");
  }
  const inputs: string[] = [];
  const graph: string[] = [];
  clips.forEach((clip, index) => {
    inputs.push("-i", clip);
    const length = seconds[index] ?? 0;
    graph.push(
      `[${String(index)}:v]scale=834:1112,fps=24,setsar=1,format=yuv420p[v${String(index)}];` +
        `[${String(index)}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:${length.toFixed(3)}[a${String(index)}]`,
    );
  });
  const n = clips.length;
  const total = seconds.reduce((sum, value) => sum + value, 0);
  graph.push(
    `${clips.map((_, index) => `[v${String(index)}][a${String(index)}]`).join("")}concat=n=${String(n)}:v=1:a=1[v][dlg]`,
  );
  inputs.push("-stream_loop", "-1", "-i", bed);
  graph.push(
    `[${String(n)}:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,` +
      `volume=0.22,afade=t=in:d=1.5,afade=t=out:st=${(total - 2.5).toFixed(3)}:d=2.5[bed]`,
  );
  graph.push("[dlg]asplit=2[dlg1][key]");
  graph.push("[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[ducked]");
  graph.push(
    `[dlg1][ducked]amix=inputs=2:normalize=0:duration=first,loudnorm=I=${String(TARGET_LUFS)}:TP=-1.5:LRA=11[a]`,
  );
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    ...inputs,
    "-filter_complex", graph.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "23",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
    out,
  ];
}

export async function assemble(
  tools: MediaTools,
  clips: readonly string[],
  bed: string,
  out: string,
): Promise<MediaResult<string>> {
  const seconds: number[] = [];
  for (const clip of clips) {
    const measured = await durationOf(tools, clip);
    if (!measured.ok) return measured;
    seconds.push(measured.value);
  }
  // A twelve-scene episode took about four minutes on this machine. Fifteen is
  // room for a busy one, not a target.
  const done = await tools.run(tools.ffmpeg, assemblyArgs(clips, seconds, bed, out), 15 * MINUTE);
  if (!done.ok) return { ok: false, reason: `ffmpeg could not assemble the episode: ${done.message}` };
  return { ok: true, value: out };
}
