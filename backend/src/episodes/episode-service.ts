/**
 * Making an episode (`syl-8tts`): the explainer kit's engine, inside her.
 *
 * ## The mechanism, and why it has this shape
 *
 * Every scene is ONE Seedance generation that makes picture, voice and sound
 * effects together. That is the only arrangement in which her lips match her
 * words and a whoosh lands on the rocket. The first explainer laid speech over
 * silent video, and the Commander called the result disjointing. Her voice is
 * held across scenes by a sample of it (`referenceAudio`), and her likeness by
 * one reference picture.
 *
 * Every take is HEARD before it is kept. whisper transcribes it, the transcript
 * is compared with her line, and the first and last scenes must be heard
 * saying the children's names. A take that fails is re-rolled with a new seed,
 * up to {@link MAX_ATTEMPTS} times. The scenes are then assembled under one
 * ducked music bed, and the finished file is checked again as a whole.
 *
 * ## What it does NOT do
 *
 * It does not decide whether the episode is any good to look at. No automated
 * check sees lettering, an extra creature or a drifting face. The episode is
 * settled as an ordinary render, which arms the watch that wakes her to look at
 * it with `see_myself` before she decides whether to `show_him`.
 *
 * It also does not re-render a take it already has. Scenes run once, and a
 * restart settles an episode in flight as failed with its paid takes on disk,
 * rather than resuming it into more spending.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { creditsFor } from "../render/credits.js";
import { isEpisodeName, type RenderPart, type RenderRecord } from "../render/render-service.js";
import { isTerminal, type RenderBackend, type SubmitVoiced } from "../render/runway.js";
import type { Studio } from "../render/studio.js";
import type { AssetsResult, EpisodeAssets } from "./assets.js";
import { assemble, durationOf, loudnessOf, transcribe, type MediaTools } from "./media.js";
import {
  SCENE_SECONDS,
  buildPrompt,
  finalProblems,
  namesIn,
  sceneVerdict,
  validate,
  type EpisodeName,
  type EpisodeScene,
} from "./rules.js";

/** Per scene, covering moderation refusals and takes that said the wrong thing. */
export const MAX_ATTEMPTS = 3;
/**
 * The model, and why it is fixed. The kit measured it on 2026-09-26:
 * `seedance2` refused her likeness three times as a third-party likeness, and
 * `seedance2_5` never did. `seedance2_5` also made the voice the Commander
 * likes, and costs 30 credits a second rather than 40.
 */
export const EPISODE_MODEL = "seedance2_5";
/** Portrait: a phone or a tablet, held by a child. */
export const EPISODE_RATIO = "834:1112";

/** The subset of RenderService an episode needs. It never writes a sidecar itself. */
export interface EpisodeRecords {
  openEpisode: (input: {
    readonly because: string;
    readonly script: string;
    readonly prompts: readonly string[];
    readonly model: string;
    readonly ratio: string;
    readonly reference: string;
    readonly sceneSeconds: number;
    readonly creditsPerScene: number | null;
  }) => RenderRecord;
  updateEpisode: (name: string, parts: readonly RenderPart[]) => RenderRecord | null;
  settleEpisode: (
    name: string,
    outcome:
      | { readonly status: "ready"; readonly video: string; readonly parts: readonly RenderPart[] }
      | { readonly status: "failed"; readonly reason: string; readonly parts: readonly RenderPart[] },
  ) => RenderRecord | null;
  list: () => readonly RenderRecord[];
}

export interface EpisodeServiceOptions {
  readonly renders: EpisodeRecords;
  readonly studio: Studio;
  readonly backend: RenderBackend | null;
  /** Read on every start, so a file put in place is picked up without a restart. */
  readonly assets: () => AssetsResult;
  /** ffmpeg, ffprobe and whisper. The whisper model comes from the assets. */
  readonly media: Omit<MediaTools, "whisperModel">;
  readonly dataUri: (path: string) => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly giveUpAfterPolls?: number;
  readonly seed?: () => number;
  readonly onError?: (error: unknown, name: string) => void;
}

export interface StartEpisodeInput {
  readonly scenes: readonly EpisodeScene[];
  readonly because: string;
}

export type StartEpisodeResult =
  | { readonly ok: true; readonly record: RenderRecord }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

interface SceneOutcome {
  readonly part: RenderPart;
  readonly passed: boolean;
  readonly why: string;
}

export class EpisodeService {
  readonly #options: EpisodeServiceOptions;
  readonly #inFlight = new Set<Promise<void>>();

  constructor(options: EpisodeServiceOptions) {
    this.#options = options;
  }

  /** Whether an episode could be started right now, and if not, why not. */
  availability(): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    if (this.#options.backend === null) {
      return { ok: false, reason: "There is no Runway key on this machine, so nothing can be rendered." };
    }
    const assets = this.#options.assets();
    return assets.ok ? { ok: true } : { ok: false, reason: assets.reason };
  }

  /**
   * Check the script, write the record, and come straight back. The scenes are
   * made in the background. Everything that can refuse refuses before a credit
   * is spent.
   */
  start(input: StartEpisodeInput): StartEpisodeResult {
    const backend = this.#options.backend;
    if (backend === null) return { ok: false, reason: "There is no Runway key on this machine, so nothing can be rendered.", retryable: false };
    const loaded = this.#options.assets();
    if (!loaded.ok) return { ok: false, reason: loaded.reason, retryable: false };
    const assets = loaded.assets;
    if (input.because.trim() === "") return { ok: false, reason: "Say why you are making it.", retryable: false };

    const problems = validate(input.scenes, assets.cast, assets.names);
    if (problems.length > 0) {
      return { ok: false, reason: `Nothing was spent. The script breaks the formula: ${problems.join(" ")}`, retryable: false };
    }

    const prompts = input.scenes.map((scene) => buildPrompt(scene, assets.cast));
    const record = this.#options.renders.openEpisode({
      because: input.because,
      script: input.scenes.map((scene) => scene.line).join("\n\n"),
      prompts,
      model: EPISODE_MODEL,
      ratio: EPISODE_RATIO,
      reference: assets.reference,
      sceneSeconds: SCENE_SECONDS,
      creditsPerScene: perScene(),
    });

    const job = this.#make(backend, assets, record, input.scenes, prompts).catch((error: unknown) => {
      (this.#options.onError ?? defaultOnError)(error, record.name);
      this.#options.renders.settleEpisode(record.name, {
        status: "failed",
        reason: `Making the episode stopped on an error: ${error instanceof Error ? error.message : String(error)}`,
        parts: this.#options.renders.list().find((r) => r.name === record.name)?.parts ?? record.parts,
      });
    });
    this.#inFlight.add(job);
    void job.finally(() => this.#inFlight.delete(job));
    return { ok: true, record };
  }

  /**
   * After a restart: settle every episode that was in flight as failed.
   *
   * Never resumed. Its takes were being followed by a process that no longer
   * exists, and picking them up again would mean re-submitting. What was paid
   * for is on disk in the parts folder and recorded against each scene.
   */
  resume(): void {
    for (const record of this.#options.renders.list()) {
      if (!isEpisodeName(record.name) || record.status !== "rendering") continue;
      this.#options.renders.settleEpisode(record.name, {
        status: "failed",
        reason:
          "Syl restarted while this episode was being made, so it was not finished. Every take " +
          "that was paid for is kept in the parts folder; making it again starts fresh.",
        parts: record.parts,
      });
    }
  }

  /** Wait for every episode in flight. For tests and a clean shutdown. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
  }

  async #make(
    backend: RenderBackend,
    assets: EpisodeAssets,
    record: RenderRecord,
    scenes: readonly EpisodeScene[],
    prompts: readonly string[],
  ): Promise<void> {
    const work = join(this.#options.studio.videoDir, "parts", record.name);
    mkdirSync(work, { recursive: true });
    const media: MediaTools = { ...this.#options.media, whisperModel: assets.whisperModel };
    const greets = namesIn(scenes[0]?.line ?? "", assets.names);
    const parts: RenderPart[] = [...record.parts];
    const progress = (index: number, part: RenderPart): void => {
      parts[index] = part;
      this.#options.renders.updateEpisode(record.name, parts);
    };

    const outcomes = await Promise.all(
      scenes.map((scene, index) =>
        this.#scene({
          backend, assets, media, work, record, scene, index,
          prompt: prompts[index] ?? "",
          greets: index === 0 || index === scenes.length - 1 ? greets : [],
          progress,
        }),
      ),
    );

    const failed = outcomes.map((outcome, index) => ({ outcome, index })).filter(({ outcome }) => !outcome.passed);
    if (failed.length > 0) {
      this.#options.renders.settleEpisode(record.name, {
        status: "failed",
        reason:
          `${failed.map(({ index, outcome }) => `Scene ${String(index + 1)} ${outcome.why}`).join("; ")}, after ` +
          `${String(MAX_ATTEMPTS)} takes, so the episode was not assembled. The takes that passed are kept; ` +
          "rewrite the failing scenes and make it again.",
        parts,
      });
      return;
    }

    const video = this.#options.studio.video(record.name);
    const clips = outcomes.map((outcome) => outcome.part.video ?? "");
    const assembled = await assemble(media, clips, assets.bed, video);
    if (!assembled.ok) {
      this.#options.renders.settleEpisode(record.name, { status: "failed", reason: assembled.reason, parts });
      return;
    }

    const problems = await this.#verify(media, video, work, scenes, greets, assets.names);
    if (problems.length > 0) {
      this.#options.renders.settleEpisode(record.name, {
        status: "failed",
        reason: `It was assembled and did not pass its final check: ${problems.join("; ")}. The file is at ${video}.`,
        parts,
      });
      return;
    }
    this.#options.renders.settleEpisode(record.name, { status: "ready", video, parts });
  }

  async #verify(
    media: MediaTools,
    video: string,
    work: string,
    scenes: readonly EpisodeScene[],
    greets: readonly EpisodeName[],
    names: readonly EpisodeName[],
  ): Promise<string[]> {
    const seconds = await durationOf(media, video);
    const lufs = await loudnessOf(media, video);
    const heard = await transcribe(media, video, work, "episode");
    const unmeasured = [seconds, lufs, heard].filter((result) => !result.ok).map((result) => (result.ok ? "" : result.reason));
    if (!seconds.ok || !lufs.ok || !heard.ok) return unmeasured;
    return finalProblems(scenes, heard.value, seconds.value, lufs.value, greets, names);
  }

  async #scene(input: {
    readonly backend: RenderBackend;
    readonly assets: EpisodeAssets;
    readonly media: MediaTools;
    readonly work: string;
    readonly record: RenderRecord;
    readonly scene: EpisodeScene;
    readonly index: number;
    readonly prompt: string;
    readonly greets: readonly EpisodeName[];
    readonly progress: (index: number, part: RenderPart) => void;
  }): Promise<SceneOutcome> {
    const base = input.record.parts[input.index];
    if (base === undefined) throw new Error(`scene ${String(input.index + 1)} has no part in the record`);
    let part: RenderPart = base;
    let why = "was never attempted";
    let charged = 0;
    let anyCharge = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const spec: SubmitVoiced = {
        model: EPISODE_MODEL,
        promptImage: [{ uri: this.#options.dataUri(input.assets.reference) }],
        promptText: input.prompt,
        ratio: EPISODE_RATIO,
        duration: SCENE_SECONDS,
        audio: true,
        referenceAudio: [{ type: "audio", uri: this.#options.dataUri(input.assets.voice) }],
        seed: (this.#options.seed ?? randomSeed)(),
      };
      const submitted = await input.backend.submit(spec);
      if (!submitted.ok) {
        why = `could not be sent (${submitted.failure.message})`;
        continue;
      }
      const task = await this.#await(input.backend, submitted.data.id);
      if (task.charged !== null) {
        charged += task.charged;
        anyCharge = true;
      }
      part = { ...part, taskId: submitted.data.id, charged: anyCharge ? charged : null };
      if (task.status !== "SUCCEEDED" || task.output[0] === undefined) {
        why = `was refused or failed (${task.failureCode ?? task.failure ?? task.status})`;
        part = { ...part, failureCode: task.failureCode, failure: task.failure };
        input.progress(input.index, part);
        continue;
      }

      const stem = `scene-${String(input.index + 1)}.take${String(attempt)}`;
      const take = join(input.work, `${stem}.mp4`);
      const downloaded = await input.backend.download(task.output[0], take);
      if (!downloaded.ok) {
        why = `came back and could not be downloaded (${downloaded.failure.message})`;
        input.progress(input.index, part);
        continue;
      }
      const heard = await transcribe(input.media, take, input.work, stem);
      if (!heard.ok) {
        why = `could not be heard (${heard.reason})`;
        input.progress(input.index, part);
        continue;
      }
      const verdict = sceneVerdict(input.scene, heard.value, input.greets, input.assets.names);
      why = verdict.why;
      if (verdict.ok) {
        part = { ...part, video: take, status: "ready", failureCode: null, failure: null };
        input.progress(input.index, part);
        return { part, passed: true, why };
      }
      input.progress(input.index, part);
    }
    part = { ...part, status: "failed" };
    input.progress(input.index, part);
    return { part, passed: false, why };
  }

  /** Poll one task to the end. A task that never ends is reported, never waited on forever. */
  async #await(backend: RenderBackend, id: string): Promise<{
    readonly status: string;
    readonly output: readonly string[];
    readonly charged: number | null;
    readonly failureCode: string | null;
    readonly failure: string | null;
  }> {
    const sleep = this.#options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const limit = this.#options.giveUpAfterPolls ?? 240;
    for (let poll = 0; poll < limit; poll += 1) {
      const answered = await backend.task(id);
      if (answered.ok && isTerminal(answered.data.status)) return answered.data;
      await sleep(this.#options.pollMs ?? 5_000);
    }
    return { status: "TIMED_OUT", output: [], charged: null, failureCode: null, failure: "Runway never finished it" };
  }
}

/** The rate card's figure for one scene. */
function perScene(): number | null {
  return creditsFor({ model: EPISODE_MODEL, seconds: SCENE_SECONDS, ratio: EPISODE_RATIO });
}

function randomSeed(): number {
  return Math.floor(Math.random() * 4_000_000_000) + 1;
}

function defaultOnError(error: unknown, name: string): void {
  console.warn(`[syl] making the episode ${name} threw: ${String(error)}`);
}
