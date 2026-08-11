import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { instant, systemClock, type Clock } from "../services/clock.js";
import { creditsFor, usdOf } from "./credits.js";
import { framingNote, FRAMING_IDS, type Framing } from "./framing.js";
import { extractFrames, type ExtractResult, type FrameRunner } from "./frames.js";
import { isTerminal, type RenderBackend } from "./runway.js";
import { isRenderName, RENDER_PREFIX, type Studio } from "./studio.js";

/**
 * Syl rendering herself, and being able to say what it cost.
 *
 * ## The shape, and why it is the job's shape
 *
 * A flagship fifteen-second render takes minutes. A verb that waited for the
 * mp4 would hold her whole turn open on somebody else's GPU queue — and a turn
 * does not complete until stdin reaches EOF, so "wait for it" means the
 * Commander watching a cursor. So this is the shape `backend/src/jobs/` uses
 * for long work: **ask, get a record back at once, come back and look.**
 * `start` submits and returns; the polling happens behind it; `see_myself` is
 * the second visit.
 *
 * ## The sidecar is the point
 *
 * `docs/VIDEO.md`: the first eight loops were made and their prompts were never
 * written down. Eight finished videos, several of them lovely, and no way to
 * make a ninth in the same voice or to re-run a failure with one thing changed.
 * The outputs survived and the inputs did not.
 *
 * So every render writes `<video>.json` exactly as `scripts/video/generate.mjs`
 * does — and **one step stricter**: that script writes the record after a
 * successful download, so a render that failed left nothing at all. This writes
 * it at submission. A render that fails still leaves behind the thing that
 * would let it be tried again.
 *
 * The sidecars are also the ledger. Not a second store beside them: a second
 * store is a second thing to get wrong, and the file that must be right is the
 * one that says what made the video.
 *
 * ## What this deliberately does not do
 *
 * There is no approval gate, no per-day cap and no confirmation. The
 * Commander's ruling, 2026-08-11: the credits exist for exactly this
 * experiment, and the whole point is that trying things is cheap for her.
 * Adding a gate here later is his call, not a refactor.
 */

/** How a render is going. */
export type RenderStatus = "rendering" | "ready" | "failed";

/**
 * What a render is, on disk and in an answer.
 *
 * The first nine fields are `generate.mjs`'s sidecar, field for field, so a
 * render Syl made and a render the script made are the same kind of record and
 * either tool can read the other's. The rest are what this adds: the status (so
 * an unfinished render is legible), her own words, the reason she gave, and the
 * bill.
 */
export interface RenderRecord {
  readonly name: string;
  readonly status: RenderStatus;
  readonly renderedAt: string | null;
  readonly taskId: string | null;
  readonly model: string;
  readonly ratio: string;
  readonly duration: number;
  readonly reference: string;
  readonly framing: Framing;
  /** The composed prompt, exactly as it was sent. Reproducible from this alone. */
  readonly prompt: string;
  /** Her words for the shot, kept beside the prompt they became. */
  readonly scene: string;
  /** Whether this framing is one the reference can anchor. See `framing.ts`. */
  readonly holdsLikeness: boolean;
  /** Why she made it. Required, as on every other write. */
  readonly because: string;
  readonly startedAt: string;
  /** Why it failed, when it did. A sentence, never a code. */
  readonly reason: string | null;
  /** `null` when there is no published rate — never a guess. */
  readonly credits: number | null;
  readonly usd: number | null;
  /** Absolute path to the mp4, once there is one. */
  readonly video: string | null;
}

/** What she has spent, derived from the records and from nothing else. */
export interface Spend {
  readonly renders: number;
  readonly ready: number;
  readonly failed: number;
  readonly rendering: number;
  readonly seconds: number;
  readonly credits: number;
  readonly usd: number;
  /** Renders with no published rate, so the total is legible as a floor. */
  readonly unpriced: number;
}

export type StartResult =
  | { readonly ok: true; readonly record: RenderRecord }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

export interface StartInput {
  readonly scene: string;
  readonly framing: string;
  readonly because: string;
}

/**
 * The recipe every one of the eight loops was made with.
 *
 * `shots.json` opens all eight prompts with this phrase, and the loop clause
 * closes all eight. Neither is decoration: the opening is what keeps the
 * subject *her* rather than a person, and the closing clause is what makes any
 * clip cut against any other — a property of the prompt, not of the editing.
 * Drop it and the render will not join the reel.
 *
 * She supplies the middle. That is the part worth experimenting with, and the
 * part `docs/VIDEO.md` says is worth keeping.
 */
const IDENTITY =
  "A luminous spirit woman of living starlight, silver-white hair and a translucent flowing gown " +
  "trailing like ribbons of light, in a deep blue starfield.";

const LOOP_CLAUSE = "Begins and ends on empty starfield as the ribbon of light vanishes.";

/** What a render is, unless something says otherwise. The loops' own settings. */
const DEFAULTS = {
  model: "seedance2",
  ratio: "720:1280",
  /** `seedance2` tops out here, measured 2026-08-10. */
  duration: 15,
} as const;

/** How often a render in flight is asked about. */
const POLL_MS = 5_000;

/**
 * How many times a render is asked about before it is written off.
 *
 * 240 polls at five seconds is twenty minutes, against a job Runway finishes in
 * two or three. It exists so a task that will never answer becomes a `failed`
 * record with a reason rather than a record that says `rendering` forever —
 * which is the render-shaped version of constraint 4: a late render is a
 * nuisance, one that silently never arrives destroys the point of asking.
 *
 * Counted in **attempts rather than against the clock**, and that is not a
 * detail. This loop's only pause is {@link RenderServiceOptions.sleep}, which a
 * test replaces with nothing — so a wall-clock deadline on a frozen test clock
 * is a deadline that never arrives, and the loop spins forever. Attempts are
 * the quantity this code actually controls.
 */
const GIVE_UP_AFTER_POLLS = 240;

export interface RenderServiceOptions {
  readonly studio: Studio;
  /** `null` on a machine with no `RUNWAYML_API_SECRET`, which is most of them. */
  readonly backend: RenderBackend | null;
  readonly clock?: Clock;
  /** Injected so a test's state machine runs in microseconds. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly giveUpAfterPolls?: number;
  /** Injected so the suite needs neither ffmpeg nor a real mp4. */
  readonly extract?: FrameRunner;
  readonly onError?: (error: unknown, name: string) => void;
}

export class RenderService {
  readonly #studio: Studio;
  readonly #backend: RenderBackend | null;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pollMs: number;
  readonly #giveUpAfterPolls: number;
  readonly #extract: FrameRunner | undefined;
  readonly #onError: (error: unknown, name: string) => void;
  /** Renders being followed right now, so `drain` can wait for them. */
  readonly #inFlight = new Set<Promise<void>>();

  constructor(options: RenderServiceOptions) {
    this.#studio = options.studio;
    this.#backend = options.backend;
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollMs = options.pollMs ?? POLL_MS;
    this.#giveUpAfterPolls = options.giveUpAfterPolls ?? GIVE_UP_AFTER_POLLS;
    this.#extract = options.extract;
    this.#onError =
      options.onError ??
      ((error, name): void => {
        console.warn(`[syl] following the render ${name} threw: ${String(error)}`);
      });
  }

  /** Whether this machine can render at all. */
  get available(): boolean {
    return this.#backend !== null;
  }

  /**
   * Ask for a render, and come straight back.
   *
   * The order is load-bearing. Everything that can refuse refuses **before** a
   * credit is spent: the scene, the framing, the reason, the reference on disk.
   * Then the submission. Then the record — written before the first poll, so a
   * process that dies in the next second still leaves the prompt behind.
   */
  async start(input: StartInput): Promise<StartResult> {
    const scene = input.scene.trim();
    if (scene === "") {
      return {
        ok: false,
        reason: "I did not catch the scene — describe what you are doing in it, in a sentence.",
        retryable: true,
      };
    }

    const framing = framingNote(input.framing);
    if (framing === null) {
      return {
        ok: false,
        reason:
          `"${String(input.framing)}" is not one of the framings. They are: ${FRAMING_IDS.join(", ")} — ` +
          "and the first two are the ones the reference can hold you at.",
        retryable: true,
      };
    }

    const because = input.because.trim();
    if (because === "") {
      return {
        ok: false,
        reason: "Every render says why it exists, the same as everything else you make.",
        retryable: true,
      };
    }

    if (this.#backend === null) {
      return {
        ok: false,
        reason:
          "There is no RUNWAYML_API_SECRET on this machine, so I have no way to render anything. " +
          "Nothing has been spent and nothing has been made.",
        retryable: false,
      };
    }

    const reference = this.#studio.reference();
    if (!existsSync(reference)) {
      // The reference is the only thing holding her appearance still between
      // clips. Rendering without it would not fail — it would produce a
      // stranger, expensively.
      return {
        ok: false,
        reason:
          `The reference picture of me is not where it should be (${reference}), and it is the ` +
          "only thing holding my face still between shots. Without it the render would be somebody else.",
        retryable: false,
      };
    }

    const now = this.#clock();
    const name = this.#nameFor(now, framing.id);
    const prompt = `${IDENTITY} ${scene} ${framing.clause} ${LOOP_CLAUSE}`;
    const credits = creditsFor({ model: DEFAULTS.model, ratio: DEFAULTS.ratio, seconds: DEFAULTS.duration });

    const submitted = await this.#backend.submit({
      model: DEFAULTS.model,
      promptImage: this.#dataUri(reference),
      promptText: prompt,
      ratio: DEFAULTS.ratio,
      duration: DEFAULTS.duration,
    });

    if (!submitted.ok) {
      // Nothing is written. A record left saying `rendering` for a task that was
      // never created would be chased by `resume` forever, and would read to her
      // as a render still in flight that will never arrive.
      return { ok: false, reason: submitted.failure.message, retryable: submitted.failure.retryable };
    }

    const record: RenderRecord = {
      name,
      status: "rendering",
      renderedAt: null,
      taskId: submitted.data.id,
      model: DEFAULTS.model,
      ratio: DEFAULTS.ratio,
      duration: DEFAULTS.duration,
      reference: this.#relativeReference(),
      framing: framing.id,
      prompt,
      scene,
      holdsLikeness: framing.holdsLikeness,
      because,
      startedAt: instant(now),
      reason: null,
      credits,
      usd: credits === null ? null : usdOf(credits),
      video: null,
    };

    this.#write(record);
    this.#follow(record);
    return { ok: true, record };
  }

  /** One render, or `null` for a name that is not one. */
  get(name: string): RenderRecord | null {
    if (!isRenderName(name)) return null;
    return this.#read(name);
  }

  /** Every render she has made, newest first. */
  list(): readonly RenderRecord[] {
    if (!existsSync(this.#studio.videoDir)) return [];

    const records: RenderRecord[] = [];
    for (const entry of readdirSync(this.#studio.videoDir)) {
      if (!entry.endsWith(".mp4.json")) continue;
      const name = basename(entry, ".mp4.json");
      // The eight loops have no sidecar and are therefore invisible here, which
      // is right: they are not hers, and there is no honest number to attach to
      // what they cost.
      if (!isRenderName(name)) continue;
      const record = this.#read(name);
      if (record !== null) records.push(record);
    }

    return records.sort((a, b) =>
      a.startedAt === b.startedAt ? b.name.localeCompare(a.name) : b.startedAt.localeCompare(a.startedAt),
    );
  }

  /** The most recent render, so `latest` means something. */
  latest(): RenderRecord | null {
    return this.list()[0] ?? null;
  }

  /**
   * What she has spent, totalled over the records.
   *
   * A failed render counts. `RUNWAY_API_INDEX.md` is explicit that a moderated
   * generation still costs full credits with no refund, and a ledger that only
   * counted the successes would understate the bill — which is the one
   * direction an honest one must not err in.
   */
  spend(): Spend {
    const records = this.list();
    let credits = 0;
    let seconds = 0;
    let unpriced = 0;

    for (const record of records) {
      seconds += record.duration;
      if (record.credits === null) unpriced += 1;
      else credits += record.credits;
    }

    return {
      renders: records.length,
      ready: records.filter((record) => record.status === "ready").length,
      failed: records.filter((record) => record.status === "failed").length,
      rendering: records.filter((record) => record.status === "rendering").length,
      seconds,
      credits,
      usd: usdOf(credits),
      unpriced,
    };
  }

  /**
   * Look at a render.
   *
   * Refuses an unfinished one rather than answering with no frames: "there is
   * nothing to see yet" and "I looked and there is nothing there" are different
   * facts about her own face, and only one of them means wait.
   */
  async frames(name: string, at?: number): Promise<
    { readonly ok: true; readonly record: RenderRecord; readonly frames: ExtractResult } | { readonly ok: false; readonly reason: string; readonly status: "missing" | "unfinished" }
  > {
    const record = name === "latest" ? this.latest() : this.get(name);
    if (record === null) {
      return { ok: false, reason: "There is no render by that name.", status: "missing" };
    }
    if (record.status !== "ready" || record.video === null) {
      return {
        ok: false,
        status: "unfinished",
        reason:
          record.status === "rendering"
            ? `"${record.name}" is still rendering, so there is nothing to look at yet.`
            : `"${record.name}" did not finish: ${record.reason ?? "no reason was recorded."}`,
      };
    }

    return {
      ok: true,
      record,
      frames: await extractFrames({
        video: record.video,
        seconds: record.duration,
        ...(at === undefined ? {} : { at }),
        outDir: this.#studio.frames(record.name),
        ...(this.#extract === undefined ? {} : { run: this.#extract }),
      }),
    };
  }

  /**
   * Pick up renders a restart interrupted.
   *
   * The sidecar holds the task id, which `generate.mjs` keeps for exactly this
   * reason: it is the only handle Runway will accept for chasing a render up
   * later. Without this a service restart during a render leaves a record
   * saying `rendering` forever, and she would tell him something was coming
   * that never was.
   */
  resume(): void {
    for (const record of this.list()) {
      if (record.status === "rendering" && record.taskId !== null) this.#follow(record);
    }
  }

  /** Wait for every render in flight. For tests and for a clean shutdown. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
  }

  // -------------------------------------------------------------------------

  /** Follow a submitted task to its end, without anybody awaiting it. */
  #follow(record: RenderRecord): void {
    const running = this.#poll(record)
      .catch((error: unknown) => {
        this.#onError(error, record.name);
        try {
          this.#fail(record, `Following this render threw: ${String(error)}`);
        } catch {
          // The record could not be updated either — the studio directory is
          // gone, or the disk is full. There is nowhere left to write the
          // truth, and throwing out of a `catch` in a detached promise would
          // take the process down with it.
        }
      })
      .finally(() => {
        this.#inFlight.delete(running);
      });
    this.#inFlight.add(running);
  }

  async #poll(record: RenderRecord): Promise<void> {
    const backend = this.#backend;
    const taskId = record.taskId;
    if (backend === null || taskId === null) return;

    for (let attempt = 1; ; attempt += 1) {
      const task = await backend.task(taskId);
      if (!task.ok) {
        if (!task.failure.retryable) {
          this.#fail(record, task.failure.message);
          return;
        }
      } else if (isTerminal(task.data.status)) {
        if (task.data.status !== "SUCCEEDED") {
          this.#fail(record, `Runway ended this render as ${task.data.status}.`);
          return;
        }
        const url = task.data.output[0];
        if (url === undefined) {
          this.#fail(record, "Runway said the render succeeded and gave nothing back to download.");
          return;
        }

        mkdirSync(this.#studio.videoDir, { recursive: true });
        const to = this.#studio.video(record.name);
        const downloaded = await backend.download(url, to);
        if (!downloaded.ok) {
          this.#fail(record, downloaded.failure.message);
          return;
        }

        this.#write({
          ...(this.#read(record.name) ?? record),
          status: "ready",
          renderedAt: instant(this.#clock()),
          video: to,
          reason: null,
        });
        return;
      }

      if (attempt >= this.#giveUpAfterPolls) {
        this.#fail(
          record,
          `Runway had not finished this render after ${String(
            Math.round((this.#giveUpAfterPolls * this.#pollMs) / 60_000),
          )} minutes, so I stopped waiting. The task id is ${taskId} if it turns up later.`,
        );
        return;
      }

      await this.#sleep(this.#pollMs);
    }
  }

  #fail(record: RenderRecord, reason: string): void {
    this.#write({ ...(this.#read(record.name) ?? record), status: "failed", reason, video: null });
  }

  /**
   * A name that is unique, sortable, and says what it is.
   *
   * The clock alone is not enough: she can ask twice inside one turn, and two
   * renders in the same second would overwrite each other's video *and* each
   * other's record. Her own words are deliberately not part of it — a name
   * derived from model output is a filename derived from model output.
   */
  #nameFor(now: number, framing: Framing): string {
    const stamp = instant(now).replace(/[:.]/gu, "").replace(/-/gu, "").toLowerCase().replace("000z", "z");
    const base = `${RENDER_PREFIX}${stamp}-${framing.replace(/_/gu, "-")}`;
    if (!existsSync(this.#studio.sidecar(base))) return base;

    for (let counter = 2; counter < 1000; counter += 1) {
      const candidate = `${base}-${String(counter)}`;
      if (!existsSync(this.#studio.sidecar(candidate))) return candidate;
    }
    // A thousand renders in one second is not a thing that happens; falling
    // through to a name that already exists silently would be.
    throw new Error("Could not find a free render name in this second.");
  }

  #dataUri(reference: string): string {
    const kind = reference.toLowerCase().endsWith(".png") ? "png" : "jpeg";
    return `data:image/${kind};base64,${readFileSync(reference).toString("base64")}`;
  }

  /** The reference as `generate.mjs` records it: a path, not the base64. */
  #relativeReference(): string {
    const absolute = this.#studio.reference();
    return absolute.startsWith(this.#studio.root)
      ? absolute.slice(this.#studio.root.length).replace(/^[/\\]+/u, "")
      : absolute;
  }

  #write(record: RenderRecord): void {
    mkdirSync(this.#studio.videoDir, { recursive: true });
    // `promptImage` is deliberately absent, exactly as in `generate.mjs`: it is
    // a multi-megabyte data URI and the PATH is the useful fact. Keeping the
    // base64 would make this file unreadable, which is the one thing it must
    // not be.
    writeFileSync(this.#studio.sidecar(record.name), `${JSON.stringify(record, null, 2)}\n`);
  }

  #read(name: string): RenderRecord | null {
    const path = this.#studio.sidecar(name);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as RenderRecord;
      return typeof parsed.name === "string" ? parsed : null;
    } catch {
      // A sidecar somebody edited by hand into invalid JSON is a record that
      // cannot be read, not a service that stops answering.
      return null;
    }
  }
}
