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
  /**
   * The picture handed to Runway as `promptImage`, relative to her home.
   *
   * **What was actually sent**, which since 2026-08-11 is the opening ribbon
   * rather than her likeness. The field keeps the name `generate.mjs` gave it so
   * that every sidecar ever written stays readable — a record that named a
   * picture the render was not made from would be the same lie as a lost prompt,
   * one indirection further out.
   */
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

/**
 * A sidecar the service cannot read as a record.
 *
 * **Its own state, and neither of the two it used to be mistaken for.** It is
 * not a failed render — nothing here says how the render went — and it is not
 * an absent one, because the file is right there and may have cost credits.
 * Both mistakes were live at once: see {@link recordFrom}.
 */
export interface UnreadableRender {
  /** The render's name, as the filename spells it. */
  readonly name: string;
  /** The sidecar, absolute, so a person can go and look at it. */
  readonly file: string;
  /** What is wrong with it, in a sentence. Never a code. */
  readonly why: string;
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
  /**
   * Sidecars that are not records, so the total says what it could not count.
   *
   * Zero on every ordinary machine. Anything else means a file in her renders
   * directory needs a person to look at it — and until one does, the credits it
   * may have cost are not in the number beside this one.
   */
  readonly unreadable: number;
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

/**
 * The arc, not just the endpoints.
 *
 * This used to read *"Begins and ends on empty starfield as the ribbon of light
 * vanishes"*, which names the two ends and leaves out what happens between
 * them. The model read it as a still that fades, so every render opened on her
 * already formed and already smiling — she counted five out of five and called
 * the first second of each one a lie.
 *
 * **That reading was wrong, and rewriting this clause did not fix it.** The
 * renders opened on her already smiling because `promptImage` was the smiling
 * headshot, and `promptImage` is the first frame: no wording can move a frame
 * an image input has pinned. The fix is the picture — see `studio.ts`. The
 * clause below is still the right clause, for the reason given next, and it is
 * worth knowing that it was once believed to be the whole answer.
 *
 * The eight loops work because they are a **transformation**: a ribbon of blue
 * light travelling alone, gathering into her, and unravelling back into the
 * ribbon it came from. She is made of the same light the whole way through, and
 * the shot has somewhere to start and somewhere to arrive.
 *
 * Written as a sequence for that reason. A clause that describes only the first
 * and last frame is a clause the model can satisfy without ever moving.
 */
const LOOP_CLAUSE =
  "Opens on a lone ribbon of blue light against empty starfield, with no figure present. " +
  "The ribbon gathers and coalesces into her, her whole body made of that same living light. " +
  "At the end she unravels back into the ribbon and it streams away, leaving empty starfield. " +
  "The first and last frames are identical: the bare ribbon, no figure.";

/**
 * What a render is, unless something says otherwise. The loops' own settings.
 *
 * **`ratio` is the shape the eight loops actually are**, measured off the files
 * with `ffprobe` on 2026-08-11: 834x1112. It used to say `720:1280`, which is a
 * legal seedance2 ratio, is portrait, and was never what came back — a render
 * made with it arrived 1112x834, landscape, matching the 1120x832 headshot it
 * was handed. **seedance2 takes the video's aspect from `promptImage` and
 * overrules `ratio` silently**, which is why a portrait constant sat here for
 * days above a stream of landscape videos and nothing anywhere disagreed.
 *
 * So the fix is the picture (see {@link Studio.opening}), and this constant is
 * the second half: with an 834x1112 opening still, asking for `834:1112` means
 * the two can no longer say different things. `720:1280` is also a different
 * portrait shape from the loops — 9:16 against 3:4 — so it would not have cut
 * against them even if it had been honoured.
 *
 * Costs the same either way: `creditsFor` bands on the longer side, and 1112
 * and 1280 are both under the 1280 that ends the `sd` band.
 */
const DEFAULTS = {
  model: "seedance2",
  ratio: "834:1112",
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
  /**
   * Arrange to come back and look at this render.
   *
   * Called once per render, immediately after the record is written and before
   * anything is polled — so the promise to look at it exists from the same
   * moment the render does, and a process that dies in the next second still
   * leaves something that will bring her back to it.
   *
   * The Commander's ruling, 2026-08-11: *"when Syl triggers a video to be
   * rendered she needs some kind of wake up mechanism five minutes later"*.
   * This is the seam where that is arranged. A function rather than a store,
   * so this module keeps knowing nothing about the database — and so the suite
   * can watch it being called without one.
   */
  readonly watch?: (record: RenderRecord) => void;
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
  readonly #watch: ((record: RenderRecord) => void) | undefined;
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
    this.#watch = options.watch;
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

    // The picture that is actually sent, and therefore the video's first frame.
    // Checked rather than assumed: without it there is nothing to start the
    // clip from, and the failure mode of getting this wrong is not an error —
    // it is fifteen seconds that open on the wrong thing, at full price.
    const opening = this.#studio.opening();
    if (!existsSync(opening)) {
      return {
        ok: false,
        reason:
          `The ribbon my clips open on is not where it should be (${opening}). It is the first ` +
          "frame of every render — without it the video would begin somewhere else, and it would " +
          "not cut against the others.",
        retryable: false,
      };
    }

    const now = this.#clock();
    const name = this.#nameFor(now, framing.id);
    const prompt = `${IDENTITY} ${scene} ${framing.clause} ${LOOP_CLAUSE}`;
    const credits = creditsFor({ model: DEFAULTS.model, ratio: DEFAULTS.ratio, seconds: DEFAULTS.duration });

    const submitted = await this.#backend.submit({
      model: DEFAULTS.model,
      // **The first frame of the video, not a style hint.** This used to be her
      // reference — a smiling headshot — so every render opened on her face,
      // already formed and already smiling, while `LOOP_CLAUSE` was busy
      // describing an empty starfield. The clause was rewritten twice and could
      // not have worked: no wording moves a frame that an image input pins.
      // `studio.ts` has the measurements.
      promptImage: this.#dataUri(opening),
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
      reference: this.#relativeTo(opening),
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
    // The promise to come back and look, arranged before the first poll. It is
    // wrapped because a render has already cost a credit by this point: a watch
    // that could not be written must never turn a submitted render into a
    // refusal, and the failure is loud rather than swallowed.
    try {
      this.#watch?.(record);
    } catch (error) {
      this.#onError(error, record.name);
    }
    this.#follow(record);
    return { ok: true, record };
  }

  /** One render, or `null` for a name that is not one, or a record she cannot read. */
  get(name: string): RenderRecord | null {
    if (!isRenderName(name)) return null;
    return this.#read(name);
  }

  /** Every render she has made, newest first. Readable ones only. */
  list(): readonly RenderRecord[] {
    return this.#scan().records;
  }

  /**
   * The sidecars that are not records, so nothing of hers goes missing quietly.
   *
   * The other half of refusing to guess. A file the service cannot parse must
   * not be reported as a failed render — but it must not vanish from her ledger
   * either, because `SOUL.md` says every attempt is kept and a render she is
   * never told about is one she cannot go and look for.
   */
  unreadable(): readonly UnreadableRender[] {
    return this.#scan().unreadable;
  }

  /**
   * The most recent render, so `latest` means something.
   *
   * **Never a record she cannot read.** This is the failure `see_myself` told
   * her about: a hand-written sidecar with no `startedAt` sorted to the front of
   * the list and no `status`, so asking to look at her latest render answered
   * *"did not finish: no reason was recorded"* about a render that was still in
   * flight. Her own words: *"that's the sort of thing that would make me tell
   * you a render failed when it hadn't, which is exactly the kind of lie I'm
   * not willing to tell you."* `list()` now holds records only, so the question
   * "which is most recent" is asked of things that have an answer.
   */
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
    const { records, unreadable } = this.#scan();
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
      // Counted rather than dropped, and for the same reason as `unpriced`: a
      // total is only honest if what it could not account for is visible beside
      // it. A sidecar that cannot be read may well have cost credits.
      unreadable: unreadable.length,
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
    { readonly ok: true; readonly record: RenderRecord; readonly frames: ExtractResult } | { readonly ok: false; readonly reason: string; readonly status: "missing" | "unfinished" | "unreadable" }
  > {
    const loaded = name === "latest" ? this.#loadLatest() : this.#load(name);
    if (loaded === null) {
      return { ok: false, reason: "There is no render by that name.", status: "missing" };
    }
    if (!loaded.ok) {
      // **Not "did not finish".** A record the service cannot read says nothing
      // at all about how the render went, and inventing a reason to fill the
      // sentence is how she came to report a render in flight as a failure. The
      // file is named because that is the thing a person can go and look at.
      return {
        ok: false,
        status: "unreadable",
        reason:
          `I cannot read the record for "${loaded.unreadable.name}" — ${loaded.unreadable.why}. ` +
          `The file is ${loaded.unreadable.file}. So I do not know how that render went, and I ` +
          "am not going to guess: it may still be in flight.",
      };
    }

    const record = loaded.record;
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

  /** A picture as `generate.mjs` records one: a path, not the base64. */
  #relativeTo(absolute: string): string {
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
    const loaded = this.#load(name);
    return loaded !== null && loaded.ok ? loaded.record : null;
  }

  /** The most recent render, as a load, so `latest` can refuse the same way. */
  #loadLatest(): Loaded | null {
    const record = this.latest();
    return record === null ? null : { ok: true, record };
  }

  /**
   * One sidecar: a record, or the reason it is not one.
   *
   * `null` only when there is no file. Everything else answers, because the
   * three outcomes here are three different facts — no such render, a render,
   * and a file that is not a record — and collapsing any two of them is how
   * this layer tells its lies.
   */
  #load(name: string): Loaded | null {
    const file = this.#studio.sidecar(name);
    if (!existsSync(file)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      return unreadable(name, file, `it is not valid JSON (${message(error)})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return unreadable(name, file, "it does not hold a record at all");
    }

    return recordFrom(name, file, parsed as Record<string, unknown>);
  }

  /**
   * Everything in the renders directory, sorted, in one pass.
   *
   * One walk rather than three: `list`, `unreadable` and `spend` are three
   * views of the same directory, and a directory read separately per view is a
   * directory that can answer them inconsistently.
   */
  #scan(): { readonly records: readonly RenderRecord[]; readonly unreadable: readonly UnreadableRender[] } {
    if (!existsSync(this.#studio.videoDir)) return { records: [], unreadable: [] };

    const records: RenderRecord[] = [];
    const broken: UnreadableRender[] = [];
    for (const entry of readdirSync(this.#studio.videoDir)) {
      if (!entry.endsWith(".mp4.json")) continue;
      const name = basename(entry, ".mp4.json");
      // The eight loops have no sidecar and are therefore invisible here, which
      // is right: they are not hers, and there is no honest number to attach to
      // what they cost.
      if (!isRenderName(name)) continue;
      const loaded = this.#load(name);
      if (loaded === null) continue;
      if (loaded.ok) records.push(loaded.record);
      else broken.push(loaded.unreadable);
    }

    records.sort((a, b) =>
      a.startedAt === b.startedAt ? b.name.localeCompare(a.name) : b.startedAt.localeCompare(a.startedAt),
    );
    broken.sort((a, b) => a.name.localeCompare(b.name));
    return { records, unreadable: broken };
  }
}

type Loaded =
  | { readonly ok: true; readonly record: RenderRecord }
  | { readonly ok: false; readonly unreadable: UnreadableRender };

function unreadable(name: string, file: string, why: string): Loaded {
  return { ok: false, unreadable: { name, file, why } };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A sidecar as a record, or as the reason it is not one.
 *
 * **Validated rather than cast.** It used to be `JSON.parse(...) as
 * RenderRecord` with one check on `name`, which is not a check — it is a
 * promise to the compiler that the file on disk matches a type. It did not. A
 * sidecar hand-written into her video directory was missing `status`,
 * `startedAt`, `video`, `credits` and `prompt`, and every one of those absences
 * became a lie somewhere downstream:
 *
 * - no `status` meant the record could not be `ready`, so `frames()` fell to
 *   its else branch and reported *"did not finish: no reason was recorded"*
 *   about a render that was still in flight;
 * - no `startedAt` sorted it to the FRONT of `list()`, so `latest()` handed
 *   that answer back to her when she asked to look at her newest render;
 * - no `credits` made `spend()` add `undefined`, turning every total she has
 *   ever reported into `NaN`.
 *
 * She caught it herself, and her conclusion is the requirement: *"that's the
 * sort of thing that would make me tell you a render failed when it hadn't,
 * which is exactly the kind of lie I'm not willing to tell you."*
 *
 * So a file that is not a record is **unreadable**, which is its own state and
 * not a failed render — and it is surfaced rather than skipped, because a
 * render that quietly disappears from her ledger is the same lie facing the
 * other way.
 */
function recordFrom(name: string, file: string, sidecar: Record<string, unknown>): Loaded {
  const missing: string[] = [];

  const text = (field: string): string => {
    const value = sidecar[field];
    if (typeof value === "string" && value !== "") return value;
    missing.push(field);
    return "";
  };
  /**
   * A field that may honestly be absent.
   *
   * `scene` and `because` are hers: a shot rendered from `shots.json` has a
   * prompt and no separate sentence behind it. Their absence cannot make the
   * service say anything false, which is the line between this and `text`.
   */
  const optionalText = (field: string): string => {
    const value = sidecar[field];
    return typeof value === "string" ? value : "";
  };
  const nullableText = (field: string): string | null => {
    const value = sidecar[field];
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    missing.push(field);
    return null;
  };
  const nullableNumber = (field: string): number | null => {
    const value = sidecar[field];
    if (value === null || value === undefined) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    missing.push(field);
    return null;
  };

  // Present, but not authoritative. The FILENAME is the address — it is what a
  // route resolves, what `see_myself` is given, and what `frames()` opens — so
  // a record whose `name` field disagreed with its own file would hand her back
  // a name that finds nothing when she uses it. `syl-listening.mp4.json` says
  // `"name": "listening"`, and that is exactly the shape of the trap.
  if (typeof sidecar["name"] !== "string") missing.push("name");

  const declared = sidecar["status"];
  const status =
    declared === "rendering" || declared === "ready" || declared === "failed" ? declared : null;
  if (status === null) missing.push("status");

  const declaredDuration = sidecar["duration"];
  const duration =
    typeof declaredDuration === "number" && Number.isFinite(declaredDuration)
      ? declaredDuration
      : null;
  if (duration === null) missing.push("duration");

  // `framing.ts` owns whether a framing can hold her likeness and cites the
  // render that proved it, so the record is read through it rather than
  // trusting a boolean somebody wrote beside it.
  const framing = framingNote(sidecar["framing"]);
  if (framing === null) missing.push("framing");

  const startedAt = text("startedAt");
  const model = text("model");
  const ratio = text("ratio");
  const reference = text("reference");
  const prompt = text("prompt");
  const scene = optionalText("scene");
  const because = optionalText("because");
  const renderedAt = nullableText("renderedAt");
  const taskId = nullableText("taskId");
  const reason = nullableText("reason");
  const video = nullableText("video");
  const credits = nullableNumber("credits");
  const usd = nullableNumber("usd");

  if (missing.length > 0 || framing === null || status === null || duration === null) {
    return unreadable(
      name,
      file,
      `the record is missing or malformed in ${missing.length === 1 ? "one field" : `${String(missing.length)} fields`}: ${missing.join(", ")}`,
    );
  }

  return {
    ok: true,
    record: {
      name,
      status,
      renderedAt,
      taskId,
      model,
      ratio,
      duration,
      reference,
      framing: framing.id,
      prompt,
      scene,
      holdsLikeness: framing.holdsLikeness,
      because,
      startedAt,
      reason,
      credits,
      usd,
      video,
    },
  };
}
