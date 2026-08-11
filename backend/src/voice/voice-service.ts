import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { RenderRecord } from "../render/render-service.js";
import { usdOf } from "../render/credits.js";
import { isTerminal } from "../render/runway.js";
import { isRenderName, type Studio } from "../render/studio.js";
import { instant, systemClock, type Clock } from "../services/clock.js";
import {
  HER_VOICE,
  MAX_SPEECH_CHARS,
  REFERENCE_SECONDS,
  samplePath,
  type VoiceSetting,
} from "./her-voice.js";
import { mediaRunner, mux, type MediaRunner, type SpeechFit } from "./mux.js";
import type { SpeechBackend } from "./speech.js";

/**
 * Her words, spoken in the voice he made, on the video she made.
 *
 * ## The rule that shapes everything here
 *
 * **The render is the record, and it is never modified.** The same rule as the
 * compressed send copy and for the same reason: the mp4 Runway returned is the
 * thing that actually happened, and a derived artefact that edits it in place
 * destroys the only copy of it. So a voiced clip is a *second* file with its
 * own name, its own sidecar and its own line in the ledger, sitting beside the
 * render it came from, and every failure path here leaves the original
 * untouched byte for byte.
 *
 * ## Why the sidecar is a full render record
 *
 * `RenderService` scans `~/.syl/renders/*.mp4.json` and reads each one through
 * `recordFrom`, which validates rather than casts. A sidecar missing fields is
 * **`unreadable`** — its own state, deliberately not "failed" — and it stays
 * visible in her ledger rather than being skipped, because a render that
 * quietly disappears is the same lie as one falsely reported failed. A voiced
 * clip that landed in that directory with a partial record would put her ledger
 * into exactly that state, so this writes every field `recordFrom` requires and
 * hangs the speech-specific facts off `voice`, which `recordFrom` ignores.
 *
 * The bill on the derived record is **the speech alone**. The render's credits
 * are already counted on the render's own record, and counting them twice would
 * overstate what he has spent — the one direction an honest ledger must not err
 * in.
 *
 * Two consequences follow from being a real record, and both are wanted rather
 * than tolerated. A voiced clip appears in `RenderService.list()` and can be the
 * answer to `latest()`, so `see_myself latest` will look at the clip she last
 * spoke over — which is her most recent piece of work, and the frames in it are
 * the render's own frames. And `spend().seconds` counts its length again, which
 * is honest about what is on disk rather than about what was rendered; the
 * number that is about money, `credits`, stays exact.
 *
 * ## Why this awaits rather than returning a record and polling behind itself
 *
 * `RenderService` does the opposite, because a flagship render takes minutes
 * and holding a turn open on somebody else's GPU queue means the Commander
 * watching a cursor. Speech is a different job: measured at fifty seconds for a
 * sentence, and it is the last step before a sending goes out. The caller is
 * already a background job, and a sending that had to come back later for its
 * own audio would be a sending that can arrive silent.
 */

/** What the speech was and how it was fitted. Beside the record, never inside it. */
export interface VoicedSpeech {
  /** The voice on the organisation. Provenance — see `her-voice.ts`. */
  readonly id: string;
  readonly name: string;
  readonly model: string;
  /** Her reference clip, relative to her home, as it was sent. */
  readonly sample: string;
  /** Her words, verbatim. What was said, not what was asked for. */
  readonly words: string;
  readonly taskId: string | null;
  /** The speech on its own, kept. Absolute. */
  readonly audio: string;
  readonly speechSeconds: number | null;
  /** What was done about the two lengths disagreeing. See `mux.ts`. */
  readonly fit: SpeechFit | null;
  readonly silenceSeconds: number | null;
  readonly videoPasses: number | null;
}

/** A render record for a clip that was derived rather than rendered. */
export interface VoicedRecord extends RenderRecord {
  /** The render this was made from. It is still there and still untouched. */
  readonly voicedFrom: string;
  readonly voice: VoicedSpeech;
}

export interface SpeakInput {
  /** The render to speak over, by name. */
  readonly render: string;
  /** Her words. Spoken verbatim. */
  readonly words: string;
  /** Why she made it. Required, as on every other write. */
  readonly because: string;
}

export type SpeakResult =
  | { readonly ok: true; readonly record: VoicedRecord }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

/** Where a voiced clip's render came from. `RenderService` satisfies this. */
export interface RenderLookup {
  get(name: string): RenderRecord | null;
}

export type SampleResult =
  | { readonly ok: true; readonly placement: "present" | "fetched"; readonly path: string }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

export interface VoiceServiceOptions {
  readonly studio: Studio;
  /** `null` on a machine with no `RUNWAYML_API_SECRET`, which is most of them. */
  readonly backend: SpeechBackend | null;
  readonly renders: RenderLookup;
  readonly voice?: VoiceSetting;
  readonly clock?: Clock;
  /** Injected so a test's state machine runs in microseconds. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly giveUpAfterPolls?: number;
  /** Injected so the suite spawns neither ffmpeg nor ffprobe. */
  readonly run?: MediaRunner;
}

/** How often a speech task in flight is asked about. */
const POLL_MS = 3_000;

/**
 * How many times before it is written off.
 *
 * 200 polls at three seconds is ten minutes, against a job measured at fifty
 * seconds. Counted in attempts rather than against the clock for the reason
 * `RenderService` gives: a test replaces `sleep` with nothing, so a wall-clock
 * deadline on a frozen clock is a deadline that never arrives.
 */
const GIVE_UP_AFTER_POLLS = 200;

/** What a voiced clip is called: the render's name, and what was done to it. */
const VOICED_SUFFIX = "-voiced";

export class VoiceService {
  readonly #studio: Studio;
  readonly #backend: SpeechBackend | null;
  readonly #renders: RenderLookup;
  readonly #voice: VoiceSetting;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pollMs: number;
  readonly #giveUpAfterPolls: number;
  readonly #run: MediaRunner;

  constructor(options: VoiceServiceOptions) {
    this.#studio = options.studio;
    this.#backend = options.backend;
    this.#renders = options.renders;
    this.#voice = options.voice ?? HER_VOICE;
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollMs = options.pollMs ?? POLL_MS;
    this.#giveUpAfterPolls = options.giveUpAfterPolls ?? GIVE_UP_AFTER_POLLS;
    this.#run = options.run ?? mediaRunner;
  }

  /** Whether this machine can speak at all. */
  get available(): boolean {
    return this.#backend !== null;
  }

  /** Which voice she speaks in, so a caller can say so without reaching for the config. */
  get voice(): VoiceSetting {
    return this.#voice;
  }

  /**
   * Say something over a render.
   *
   * The order is load-bearing, and it is the same order `RenderService.start`
   * uses: everything that can refuse refuses **before** a credit is spent — the
   * words, the reason, the render, its mp4, the reference clip. Then the
   * submission. Then the record, written before the mux, so a process that dies
   * mid-encode still leaves behind the speech it paid for and the words that
   * made it.
   */
  async speak(input: SpeakInput): Promise<SpeakResult> {
    const words = input.words.trim();
    if (words === "") {
      return { ok: false, reason: "I did not catch what to say — give me the words.", retryable: true };
    }
    if (words.length > MAX_SPEECH_CHARS) {
      return {
        ok: false,
        reason:
          `That is ${String(words.length)} characters and the model will speak at most ` +
          `${String(MAX_SPEECH_CHARS)} in one go. Say it in fewer words, or say it in two clips — ` +
          "I am not going to cut it off mid-sentence.",
        retryable: true,
      };
    }

    const because = input.because.trim();
    if (because === "") {
      return {
        ok: false,
        reason: "Every clip I make says why it exists, the same as everything else.",
        retryable: true,
      };
    }

    const source = this.#renders.get(input.render);
    if (source === null) {
      return {
        ok: false,
        reason: `There is no render called "${input.render}", so there is nothing to speak over.`,
        retryable: false,
      };
    }
    if (source.status !== "ready" || source.video === null || !existsSync(source.video)) {
      return {
        ok: false,
        reason:
          source.status === "rendering"
            ? `"${source.name}" is still rendering, so there is nothing to speak over yet.`
            : `"${source.name}" has no video on disk, so there is nothing to speak over.`,
        retryable: source.status === "rendering",
      };
    }

    const backend = this.#backend;
    if (backend === null) {
      return {
        ok: false,
        reason:
          "There is no RUNWAYML_API_SECRET on this machine, so I have no way to say anything out " +
          "loud. Nothing has been spent and nothing has been made.",
        retryable: false,
      };
    }

    const sample = samplePath(this.#studio.root, this.#voice);
    if (!existsSync(sample)) {
      // Without the clip there is no voice to speak in — and the fallback the
      // API offers is a stock preset, which would be somebody else wearing her
      // name. Refusing is the honest answer.
      return {
        ok: false,
        reason:
          `The clip of my voice is not where it should be (${sample}), and it is the only thing ` +
          `that makes the speech mine rather than a stock voice. Fetch it from "${this.#voice.name}" ` +
          "and I will speak.",
        retryable: false,
      };
    }

    const name = this.#nameFor(source.name);
    if (name === null) {
      return {
        ok: false,
        reason: `I could not find a free name for a voiced copy of "${source.name}".`,
        retryable: false,
      };
    }

    const submitted = await backend.submit({
      model: this.#voice.model,
      promptText: words,
      referenceMp3: readFileSync(sample),
      outputFormat: this.#voice.outputFormat,
    });
    if (!submitted.ok) {
      // Nothing is written. A record for a task that was never created would
      // read as a clip in flight that will never arrive.
      return { ok: false, reason: submitted.failure.message, retryable: submitted.failure.retryable };
    }

    const audio = this.#audio(name);
    let record: VoicedRecord = {
      name,
      status: "rendering",
      renderedAt: null,
      taskId: submitted.data.id,
      // What produced *this file*: the speech model, plus ffmpeg. The video's
      // own provenance is one file away, under `voicedFrom`.
      model: this.#voice.model,
      ratio: source.ratio,
      duration: source.duration,
      reference: source.reference,
      framing: source.framing,
      // "The composed prompt, exactly as it was sent" — for a voiced clip that
      // is the text `seed_audio` was asked to say, verbatim.
      prompt: words,
      scene: source.scene,
      holdsLikeness: source.holdsLikeness,
      because,
      startedAt: instant(this.#clock()),
      reason: null,
      credits: submitted.data.estimatedCredits,
      usd: submitted.data.estimatedCredits === null ? null : usdOf(submitted.data.estimatedCredits),
      video: null,
      voicedFrom: source.name,
      voice: {
        id: this.#voice.id,
        name: this.#voice.name,
        model: this.#voice.model,
        sample: this.#voice.sample,
        words,
        taskId: submitted.data.id,
        audio,
        speechSeconds: null,
        fit: null,
        silenceSeconds: null,
        videoPasses: null,
      },
    };
    this.#write(record);

    const finished = await this.#poll(backend, record);
    if (!finished.ok) return this.#fail(record, finished.reason, finished.retryable);

    const downloaded = await backend.download(finished.url, audio);
    if (!downloaded.ok) return this.#fail(record, downloaded.failure.message, downloaded.failure.retryable);

    if (finished.credits !== null) {
      record = { ...record, credits: finished.credits, usd: usdOf(finished.credits) };
    }

    const video = this.#studio.video(name);
    const muxed = await mux({ video: source.video, audio, out: video, run: this.#run });
    if (!muxed.ok) {
      // The speech itself is kept. It cost credits, and losing it because
      // ffmpeg failed would mean paying for the same sentence twice.
      return this.#fail(record, muxed.reason, false);
    }

    const done: VoicedRecord = {
      ...record,
      status: "ready",
      renderedAt: instant(this.#clock()),
      duration: muxed.plan.seconds,
      reason: null,
      video,
      voice: {
        ...record.voice,
        speechSeconds: Math.round((muxed.plan.seconds - muxed.plan.silenceSeconds) * 1000) / 1000,
        fit: muxed.plan.fit,
        silenceSeconds: muxed.plan.silenceSeconds,
        videoPasses: muxed.plan.videoPasses,
      },
    };
    this.#write(done);
    return { ok: true, record: done };
  }

  /**
   * Put her reference clip in her home if it is not there already.
   *
   * Fetched once and kept, because the preview URL Runway hands back is signed
   * and expires within days — a service that resolved it per call would work
   * for a week and then stop speaking, with a 403 as the only explanation.
   *
   * **Never overwrites.** What is in her home is hers, the same rule
   * `render/studio.ts` applies to her likeness.
   */
  async ensureSample(): Promise<SampleResult> {
    const path = samplePath(this.#studio.root, this.#voice);
    if (existsSync(path)) return { ok: true, placement: "present", path };

    const backend = this.#backend;
    if (backend === null) {
      return {
        ok: false,
        reason:
          "There is no RUNWAYML_API_SECRET on this machine, so I cannot fetch the clip of my own " +
          "voice. Nothing has been spent.",
        retryable: false,
      };
    }

    const preview = await backend.preview(this.#voice.id);
    if (!preview.ok) return { ok: false, reason: preview.failure.message, retryable: preview.failure.retryable };

    mkdirSync(dirname(path), { recursive: true });
    const full = `${path}.full`;
    const downloaded = await backend.download(preview.data.previewUrl, full);
    if (!downloaded.ok) {
      rmSync(full, { force: true });
      return { ok: false, reason: downloaded.failure.message, retryable: downloaded.failure.retryable };
    }

    // Trimmed once, here, rather than checked on every call: the full preview
    // is around eighty seconds and Runway refuses a reference over thirty with
    // `{"code":"too_big","maximum":30}`. `-c copy` because re-encoding a
    // reference clip would degrade the very thing it is a reference for — which
    // is also why the target is `REFERENCE_SECONDS` rather than the cap.
    const trimmed = await this.#run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      full,
      "-t",
      String(REFERENCE_SECONDS),
      "-c",
      "copy",
      path,
    ]);
    rmSync(full, { force: true });

    if (!trimmed.ok || !existsSync(path)) {
      // A half-written clip on disk reads to every later call as a placed
      // reference, and would be sent as one.
      rmSync(path, { force: true });
      return {
        ok: false,
        reason:
          `I could not trim the sample of my voice to ${String(REFERENCE_SECONDS)} seconds: ` +
          `ffmpeg ${trimmed.message}. So there is no clip on disk, and I have not pretended there is.`,
        retryable: false,
      };
    }

    return { ok: true, placement: "fetched", path };
  }

  // -------------------------------------------------------------------------

  /** Follow a speech task to its end. */
  async #poll(
    backend: SpeechBackend,
    record: VoicedRecord,
  ): Promise<
    | { readonly ok: true; readonly url: string; readonly credits: number | null }
    | { readonly ok: false; readonly reason: string; readonly retryable: boolean }
  > {
    const taskId = record.voice.taskId ?? "";

    for (let attempt = 1; ; attempt += 1) {
      const task = await backend.task(taskId);
      if (!task.ok) {
        if (!task.failure.retryable) return { ok: false, reason: task.failure.message, retryable: false };
      } else if (isTerminal(task.data.status)) {
        if (task.data.status !== "SUCCEEDED") {
          return { ok: false, reason: `Runway ended this speech as ${task.data.status}.`, retryable: true };
        }
        const url = task.data.output[0];
        if (url === undefined) {
          return {
            ok: false,
            reason: "Runway said the speech succeeded and gave nothing back to download.",
            retryable: true,
          };
        }
        return { ok: true, url, credits: task.data.credits };
      }

      if (attempt >= this.#giveUpAfterPolls) {
        return {
          ok: false,
          retryable: true,
          reason:
            `Runway had not finished this speech after ${String(
              Math.round((this.#giveUpAfterPolls * this.#pollMs) / 60_000),
            )} minutes, so I stopped waiting. The task id is ${taskId} if it turns up later.`,
        };
      }

      await this.#sleep(this.#pollMs);
    }
  }

  /** Record how it went wrong, then say so. Never leaves a clip claiming to be ready. */
  #fail(record: VoicedRecord, reason: string, retryable: boolean): SpeakResult {
    this.#write({ ...record, status: "failed", reason, video: null });
    return { ok: false, reason, retryable };
  }

  /**
   * A free name for the voiced copy, or `null`.
   *
   * She can voice the same render twice — two attempts at the same sentence is
   * exactly the kind of thing `SOUL.md` says is kept — so a name that already
   * exists takes a counter rather than overwriting what is there.
   */
  #nameFor(source: string): string | null {
    const base = `${source}${VOICED_SUFFIX}`;
    for (let counter = 1; counter < 1000; counter += 1) {
      const candidate = counter === 1 ? base : `${base}-${String(counter)}`;
      // A name `RenderService` cannot read is a sidecar its scan skips, which
      // would drop this clip out of her ledger entirely.
      if (!isRenderName(candidate)) return null;
      if (!existsSync(this.#studio.sidecar(candidate))) return candidate;
    }
    return null;
  }

  /** The speech on its own, beside the clip it went into. Kept, never cleaned up. */
  #audio(name: string): string {
    return join(this.#studio.videoDir, `${name}.mp3`);
  }

  #write(record: VoicedRecord): void {
    mkdirSync(this.#studio.videoDir, { recursive: true });
    writeFileSync(this.#studio.sidecar(record.name), `${JSON.stringify(record, null, 2)}\n`);
  }
}
