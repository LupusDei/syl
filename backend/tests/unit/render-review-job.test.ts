import { afterEach, describe, expect, it } from "vitest";

import type { Job } from "@syl/shared";

import type { QuietHours } from "../../src/harness/schedule.js";
import type { TurnResult } from "../../src/harness/session.js";
import { REACHING_KINDS } from "../../src/jobs/heartbeat-job.js";
import {
  createRenderReviewHandler,
  defineRenderReviewJob,
  describeRenderReview,
  ensureRenderReviewJob,
  FIRST_LOOK_MS,
  HARD_MAX_ATTEMPTS,
  MAX_CHECKS,
  RECHECK_MS,
  RENDER_REVIEW_KIND,
  renderReviewPrompt,
  SENDS_TO_HIM,
  sentToHim,
  type RenderReviewVoice,
} from "../../src/jobs/render-review-job.js";
import type { RenderRecord } from "../../src/render/render-service.js";
import { instant } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import type { JobContext } from "../../src/services/job-runner.js";
import { JobStore } from "../../src/services/job-store.js";
import { RenderWatchStore } from "../../src/services/render-watch-store.js";
import { mcpToolName } from "../../src/tools/config.js";
import { advertisedToolNames } from "../../src/tools/server.js";
import { testDatabase } from "../helpers/service.js";

/**
 * The deferred self-wake, keyed to a render, that ends in her decision.
 *
 * > *"It sounds like the push notification goes out, regardless of whether a
 * > video was created or not — that seems a little bit backwards to me. […]
 * > But you need some ability to wake up to check on the render."*
 * >                                                       — the Commander
 *
 * The four outcomes are the shape of this file, and each has a rule attached
 * that is not obvious from the happy path:
 *
 *  - **ready** — she is woken, she looks, she decides. Only that decision
 *    reaches him.
 *  - **not yet** — she is NOT woken. A turn spent to say "it is not done" is a
 *    turn spent on nothing, on subscription rails. The watch is deferred to a
 *    strictly later instant and the pass costs zero turns.
 *  - **failed** — she is woken anyway, because a render that failed is
 *    information she has and he does not, and whether to say anything is hers.
 *  - **given up on** — bounded, recorded, and she is told once. Constraint 4's
 *    spirit: it must not spin forever and it must not vanish.
 *
 * Every instant here is injected. Nothing in this file may depend on the hour
 * the suite happens to run at, and nothing may spawn `claude` or reach Runway.
 */

const TZ = "America/Chicago";
const QUIET: QuietHours = { start: "22:00", end: "08:00" };

/** 14:00 CDT on Tuesday 11 August 2026. He is awake. */
const AFTERNOON = Date.UTC(2026, 7, 11, 19, 0);
/** 02:00 CDT the same night. He is asleep. */
const SMALL_HOURS = Date.UTC(2026, 7, 11, 7, 0);

const RENDER = "syl-2026-08-11-135500-medium";

const databases: SylDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function stores(): { jobs: JobStore; watches: RenderWatchStore; db: SylDatabase } {
  const db = testDatabase();
  databases.push(db);
  return {
    db,
    jobs: new JobStore({ db: db.handle }),
    watches: new RenderWatchStore({ db: db.handle }),
  };
}

/** A render record in whatever state the case is about. */
function render(overrides: Partial<RenderRecord> = {}): RenderRecord {
  return {
    name: RENDER,
    status: "ready",
    renderedAt: instant(AFTERNOON),
    taskId: "task-1",
    model: "seedance2",
    ratio: "720:1280",
    duration: 15,
    reference: "reference.png",
    framing: "mid_face_visible",
    prompt: "…",
    scene: "I am turning towards him as the ribbon unravels.",
    holdsLikeness: true,
    because: "He said the ribbon shot was the one that felt like me.",
    startedAt: instant(AFTERNOON - FIRST_LOOK_MS),
    reason: null,
    credits: 120,
    usd: 1.2,
    video: "/studio/syl-2026-08-11-135500-medium.mp4",
    ...overrides,
  };
}

/** A turn that said something and reached for the tools it is given. */
function said(text: string, tools: readonly string[] = []): TurnResult {
  return {
    sessionId: "sess-studio",
    text,
    spoken: text,
    costUsd: 0.03,
    numTurns: 1,
    init: {
      kind: "init",
      sessionId: "sess-studio",
      raw: {},
      model: "test",
      apiKeySource: "none",
      mcpServers: [],
      tools: [],
      capabilities: [],
      autoMemoryPath: undefined,
    },
    events: tools.map((name) => ({
      kind: "tool_use" as const,
      sessionId: "sess-studio",
      raw: {},
      name,
      input: {},
    })),
  };
}

interface Recorder extends RenderReviewVoice {
  readonly prompts: string[];
  readonly resets: number[];
}

/** A stand-in for the studio lane. No subprocess ever runs here. */
function voice(answer: TurnResult | (() => Promise<TurnResult>) = said("Looked.")): Recorder {
  const prompts: string[] = [];
  const resets: number[] = [];
  return {
    prompts,
    resets,
    ask: async (prompt: string) => {
      prompts.push(prompt);
      return typeof answer === "function" ? answer() : answer;
    },
    reset: () => {
      resets.push(prompts.length);
    },
  };
}

/**
 * A watch that has already been picked up `attempts` times and is due now.
 *
 * Built by deferring forward from the past rather than by writing the column,
 * because every deferral has to be strictly later than the last — which is the
 * invariant, and a fixture that sidestepped it would be testing a state the
 * store cannot produce.
 */
function agedWatch(watches: RenderWatchStore, attempts: number, now: number) {
  const created = watches.watch({
    renderName: RENDER,
    because: "…",
    checkAt: now - (attempts + 1) * 1_000,
  });
  for (let attempt = attempts; attempt > 0; attempt -= 1) {
    watches.defer(created.id, now - attempt * 1_000);
  }
  return created;
}

/** The context the runner hands a handler, for a pass starting now. */
function contextFor(jobs: JobStore, job: Job, now: number): JobContext {
  const run = jobs.startRun(job, instant(now), now);
  return { job, run, triggerInstant: instant(now), late: false, now };
}

/** Everything a handler needs, with the render and the sendings substituted. */
function harness(options: {
  readonly watches: RenderWatchStore;
  readonly jobs: JobStore;
  readonly record?: RenderRecord | null;
  readonly alreadySent?: boolean;
  readonly voice?: Recorder;
  readonly allowance?: number;
}) {
  const speaker = options.voice ?? voice();
  const handler = createRenderReviewHandler({
    voice: speaker,
    watches: options.watches,
    renders: { get: () => options.record ?? null },
    sendings: { existsForRender: () => options.alreadySent === true },
    jobs: options.jobs,
    tz: TZ,
    quiet: QUIET,
    ...(options.allowance === undefined ? {} : { allowance: options.allowance }),
  });
  return { handler, voice: speaker };
}

describe("defineRenderReviewJob", () => {
  it("should never displace him, a reminder, or his morning", () => {
    // `background`. Looking at her own render is the most deferrable thing in
    // the catalogue: it is her own work, nobody is waiting on it, and it must
    // never take the one rate-limit pool away from something he asked for.
    expect(defineRenderReviewJob(stores().jobs).priority).toBe("background");
  });

  it("should keep its place in the queue across a restart", () => {
    // `at_least_once`. Not fussiness: `recoverLeases` reschedules an
    // `at_most_once` job from its TRIGGER, and this job's trigger is an event
    // with no next instant — so a crash would set `next_run_at = NULL` and the
    // wake would silently never happen again. That is the exact shape of the
    // failure constraint 4 forbids, arriving through the recovery path.
    const job = defineRenderReviewJob(stores().jobs);

    expect(job.deliveryClass).toBe("at_least_once");
    expect(job.catchUp.policy).toBe("never_expires");
  });

  it("should declare the hands it is actually given, rather than claiming none", () => {
    // The `studio` lane is the fourth widening of `LANES_WITH_HANDS`, and the
    // narrowest: this turn exists to reach a decision, and the decision is a
    // verb. Derived from the server so the catalogue cannot claim a verb she
    // does not have — or miss one she does.
    expect(defineRenderReviewJob(stores().jobs).budget.allowedTools).toEqual(
      advertisedToolNames().map(mcpToolName),
    );
  });

  it("should spend at most one turn per wake", () => {
    const job = defineRenderReviewJob(stores().jobs);

    expect(job.budget.maxTurns).toBe(1);
    expect(job.speaks).toBe(true);
  });

  it("should be scheduled from the first moment rather than waiting for a trigger", () => {
    // An event trigger computes no next instant, so a row defined without one
    // is a row `due` never returns. It would look perfectly healthy.
    const job = defineRenderReviewJob(stores().jobs, instant(AFTERNOON));

    expect(job.nextRunAt).toBe(instant(AFTERNOON));
  });
});

describe("ensureRenderReviewJob", () => {
  it("should create exactly one, and then find the one it created", () => {
    const { jobs } = stores();
    const first = ensureRenderReviewJob(jobs, AFTERNOON);
    const second = ensureRenderReviewJob(jobs, AFTERNOON + 60_000);

    expect(second.id).toBe(first.id);
    expect(jobs.list({ kind: RENDER_REVIEW_KIND }).items).toHaveLength(1);
  });

  it("should be ready to run at once, so the first render of a boot is not stranded", () => {
    expect(ensureRenderReviewJob(stores().jobs, AFTERNOON).nextRunAt).toBe(instant(AFTERNOON));
  });
});

describe("the wake she is given", () => {
  it("should be five minutes after the render was asked for", () => {
    // The Commander's number, verbatim: "some kind of wake up mechanism five
    // minutes later to check to see whether or not it's done".
    expect(FIRST_LOOK_MS).toBe(5 * 60_000);
  });

  it("should outlast the render service's own patience before giving up", () => {
    // `RenderService` writes a render off after twenty minutes of polling. If
    // this bound were tighter, the give-up branch would fire while the render
    // was still legitimately in flight, and she would be told a clip had never
    // finished moments before it did.
    expect(FIRST_LOOK_MS + MAX_CHECKS * RECHECK_MS).toBeGreaterThan(20 * 60_000);
  });

  it("should allow a few pickups beyond the re-check bound, and not many", () => {
    // The crash allowance. A wake that ran and never came back leaves the
    // watch waiting; without headroom above MAX_CHECKS the retry would be
    // indistinguishable from "the render never finished".
    expect(HARD_MAX_ATTEMPTS).toBeGreaterThan(MAX_CHECKS);
    expect(HARD_MAX_ATTEMPTS - MAX_CHECKS).toBeLessThanOrEqual(3);
  });
});

describe("when there is nothing to look at", () => {
  it("should spend no turn at all", async () => {
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    const { handler, voice: speaker } = harness({ watches, jobs });

    const result = await handler(contextFor(jobs, job, AFTERNOON));

    expect(speaker.prompts).toHaveLength(0);
    expect(result.outcome).toBe("success");
    expect(result.spoke).toBe(false);
    expect(result.turns).toBe(0);
  });

  it("should always name its own next wake, so an event trigger cannot strand it", async () => {
    // The trigger is an event and computes nothing. A pass that returned no
    // `nextRunAt` would have `release` write NULL, and the job would never run
    // again — silently, with every other signal green.
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    const { handler } = harness({ watches, jobs });

    const result = await handler(contextFor(jobs, job, AFTERNOON));

    expect(typeof result.nextRunAt).toBe("string");
    expect(Date.parse(result.nextRunAt ?? "")).toBeGreaterThan(AFTERNOON);
  });
});

describe("when the render is not done yet", () => {
  it("should not wake her to be told it is not done", async () => {
    // A turn is the expensive thing here. Spending one to say "still going" is
    // spending her rate limit on a database query's worth of information.
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    watches.watch({ renderName: RENDER, because: "…", checkAt: AFTERNOON });
    const { handler, voice: speaker } = harness({
      watches,
      jobs,
      record: render({ status: "rendering", video: null }),
    });

    const result = await handler(contextFor(jobs, job, AFTERNOON));

    expect(speaker.prompts).toHaveLength(0);
    expect(result.turns).toBe(0);
    expect(result.spoke).toBe(false);
  });

  it("should come back to it, strictly later, every time", async () => {
    // Constraint 4 as arithmetic. A re-check that landed on the same instant
    // would be due on every tick forever and would never resolve.
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    const created = watches.watch({ renderName: RENDER, because: "…", checkAt: AFTERNOON });
    const { handler } = harness({
      watches,
      jobs,
      record: render({ status: "rendering", video: null }),
    });

    await handler(contextFor(jobs, job, AFTERNOON));

    const after = watches.get(created.id);
    expect(after?.state).toBe("waiting");
    expect(Date.parse(after?.checkAt ?? "")).toBeGreaterThan(AFTERNOON);
    expect(after?.attempts).toBe(1);
  });

  it("should give up after a bounded number of tries, recorded and never silent", async () => {
    // The other half of constraint 4: it must not vanish, and it must not spin
    // forever. The bound is reached, the watch is settled `gave_up` with a
    // sentence, and she is woken ONCE so the give-up is something she knows
    // about rather than a row nobody reads.
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    const created = agedWatch(watches, MAX_CHECKS, AFTERNOON);
    const { handler, voice: speaker } = harness({
      watches,
      jobs,
      record: render({ status: "rendering", video: null }),
    });

    await handler(contextFor(jobs, job, AFTERNOON));

    expect(speaker.prompts).toHaveLength(1);
    expect(speaker.prompts[0]).toMatch(/never finished|still rendering/i);
    expect(watches.get(created.id)?.state).toBe("gave_up");
    expect(watches.get(created.id)?.note).not.toBeNull();
  });

  it("should stop picking a watch up once even the crash allowance is gone", async () => {
    // A wake that dies mid-turn leaves the watch waiting, which is correct —
    // and a wake that dies mid-turn EVERY time would otherwise be a loop. The
    // last pickup spends no turn: something is systematically wrong and one
    // more attempt will not discover what.
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    const created = agedWatch(watches, HARD_MAX_ATTEMPTS, AFTERNOON);
    const { handler, voice: speaker } = harness({ watches, jobs, record: render() });

    await handler(contextFor(jobs, job, AFTERNOON));

    expect(speaker.prompts).toHaveLength(0);
    expect(watches.get(created.id)?.state).toBe("gave_up");
  });
});

describe("when the render is finished", () => {
  it("should wake her on a thread whose whole subject is that one render", async () => {
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    watches.watch({
      renderName: RENDER,
      because: "He said the ribbon shot was the one that felt like me.",
      checkAt: AFTERNOON,
    });
    const { handler, voice: speaker } = harness({ watches, jobs, record: render() });

    await handler(contextFor(jobs, job, AFTERNOON));

    expect(speaker.prompts).toHaveLength(1);
    expect(speaker.prompts[0]).toContain(RENDER);
    expect(speaker.prompts[0]).toContain("ribbon shot");
    // A fresh thread each time. One render's review has no business carrying
    // her opinions of the last five into every later turn's context.
    expect(speaker.resets).toHaveLength(1);
  });

  it("should tell her to look at it before deciding whether it is any good", async () => {
    // A decision about whether it "looks right" is worth nothing if she cannot
    // look. `see_myself` already pulls stills out of the clip and hands them
    // over as images — this points her at the verb rather than inventing a
    // second way to see.
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    watches.watch({ renderName: RENDER, because: "…", checkAt: AFTERNOON });
    const { handler, voice: speaker } = harness({ watches, jobs, record: render() });

    await handler(contextFor(jobs, job, AFTERNOON));

    expect(speaker.prompts[0]).toContain("see_myself");
    expect(speaker.prompts[0]).toContain("show_him");
  });

  it("should record that she sent it, and settle the watch", async () => {
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    const created = watches.watch({ renderName: RENDER, because: "…", checkAt: AFTERNOON });
    const { handler } = harness({
      watches,
      jobs,
      record: render(),
      voice: voice(said("Sent it — the ribbon holds all the way through.", ["show_him"])),
    });

    const result = await handler(contextFor(jobs, job, AFTERNOON));

    expect(result.spoke).toBe(true);
    expect(watches.get(created.id)?.state).toBe("decided");
    expect(watches.get(created.id)?.note).toContain("ribbon holds");
  });

  it("should record her declining exactly as carefully as her sending", async () => {
    // Restraint is a decision. A pass that recorded only the sends would make
    // a render she looked at and passed on indistinguishable from one nobody
    // ever looked at — and those are the two states this whole mechanism
    // exists to tell apart.
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    const created = watches.watch({ renderName: RENDER, because: "…", checkAt: AFTERNOON });
    const { handler } = harness({
      watches,
      jobs,
      record: render(),
      voice: voice(said("My face goes wrong at the end. Not this one.")),
    });

    const result = await handler(contextFor(jobs, job, AFTERNOON));

    expect(result.outcome).toBe("success");
    expect(result.spoke).toBe(false);
    expect(watches.get(created.id)?.state).toBe("decided");
    expect(watches.get(created.id)?.note).toContain("Not this one");
  });
});

describe("when the render failed", () => {
  it("should still wake her, because whether to say anything is hers", async () => {
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    const created = watches.watch({ renderName: RENDER, because: "…", checkAt: AFTERNOON });
    const { handler, voice: speaker } = harness({
      watches,
      jobs,
      record: render({ status: "failed", video: null, reason: "The task was rejected upstream." }),
    });

    await handler(contextFor(jobs, job, AFTERNOON));

    expect(speaker.prompts).toHaveLength(1);
    expect(speaker.prompts[0]).toContain("The task was rejected upstream.");
    expect(watches.get(created.id)?.state).toBe("decided");
  });

  it("should wake her when the render has vanished entirely", async () => {
    // A sidecar that is gone, or a name that no longer resolves. Not silence:
    // she asked for something, and the honest answer is that it is not there.
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    watches.watch({ renderName: RENDER, because: "…", checkAt: AFTERNOON });
    const { handler, voice: speaker } = harness({ watches, jobs, record: null });

    await handler(contextFor(jobs, job, AFTERNOON));

    expect(speaker.prompts).toHaveLength(1);
    expect(speaker.prompts[0]).toMatch(/not there|gone|cannot find/i);
  });
});

describe("idempotency", () => {
  it("should never wake her twice about a render she has already sent", async () => {
    // The guard on the retried wake. A pass that sent and then died before it
    // could settle its watch comes back to a render he already has; waking her
    // again would be a second decision about one thing, and a second push.
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    const created = watches.watch({ renderName: RENDER, because: "…", checkAt: AFTERNOON });
    const { handler, voice: speaker } = harness({
      watches,
      jobs,
      record: render(),
      alreadySent: true,
    });

    const result = await handler(contextFor(jobs, job, AFTERNOON));

    expect(speaker.prompts).toHaveLength(0);
    expect(result.turns).toBe(0);
    expect(watches.get(created.id)?.state).toBe("decided");
  });

  it("should take a watch out of the due set before the turn, not after", async () => {
    // The window that would otherwise exist: a turn that sends and then dies
    // leaves a watch that is still due, and the next pass would send again.
    // Deferring first bounds the retry and makes it strictly later.
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    const created = watches.watch({ renderName: RENDER, because: "…", checkAt: AFTERNOON });
    let dueDuringTheTurn = -1;
    const { handler } = harness({
      watches,
      jobs,
      record: render(),
      voice: voice(async () => {
        dueDuringTheTurn = watches.due(AFTERNOON).length;
        return said("Sent it.", ["show_him"]);
      }),
    });

    await handler(contextFor(jobs, job, AFTERNOON));

    expect(dueDuringTheTurn).toBe(0);
    expect(watches.get(created.id)?.attempts).toBe(1);
  });

  it("should leave a watch waiting, and strictly later, when the turn dies", async () => {
    // Never dropped. The turn failed, so nothing was decided — and the watch
    // must come back rather than be settled on a decision she never made.
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    const created = watches.watch({ renderName: RENDER, because: "…", checkAt: AFTERNOON });
    const { handler } = harness({
      watches,
      jobs,
      record: render(),
      voice: voice(() => Promise.reject(new Error("the turn died"))),
    });

    const result = await handler(contextFor(jobs, job, AFTERNOON));

    expect(result.outcome).toBe("failure");
    expect(watches.get(created.id)?.state).toBe("waiting");
    expect(Date.parse(watches.get(created.id)?.checkAt ?? "")).toBeGreaterThan(AFTERNOON);
    expect(result.nextRunAt).not.toBeNull();
  });
});

describe("the ceiling", () => {
  it("should spend from the same day's allowance the hour spends from", () => {
    // Moving the send out of the heartbeat would otherwise have removed the
    // bound entirely: the hour would start a render (which reaches nobody) and
    // a different job would do the sending, counted against nothing.
    expect(REACHING_KINDS).toContain(RENDER_REVIEW_KIND);
    expect(REACHING_KINDS).toContain("heartbeat");
  });

  it("should tell her what is left of it, rather than let her cross a bound she cannot see", async () => {
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    watches.watch({ renderName: RENDER, because: "…", checkAt: AFTERNOON });
    const { handler, voice: speaker } = harness({
      watches,
      jobs,
      record: render(),
      allowance: 4,
    });

    await handler(contextFor(jobs, job, AFTERNOON));

    expect(speaker.prompts[0]).toContain("4");
  });

  it("should record an overspend as a failed pass, so the breaker can eventually move", async () => {
    const { jobs, watches } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);
    watches.watch({ renderName: RENDER, because: "…", checkAt: AFTERNOON });
    const { handler } = harness({
      watches,
      jobs,
      record: render(),
      allowance: 0,
      voice: voice(said("Sent it anyway.", ["show_him"])),
    });

    const result = await handler(contextFor(jobs, job, AFTERNOON));

    expect(result.outcome).toBe("failure");
    expect(result.spoke).toBe(true);
    expect(result.error).toMatch(/ceiling|allowance/i);
  });
});

describe("renderReviewPrompt", () => {
  it("should say he is asleep when he is, without pretending nothing can be done", () => {
    const prompt = renderReviewPrompt({
      now: SMALL_HOURS,
      tz: TZ,
      quiet: QUIET,
      inQuietHours: true,
      renderName: RENDER,
      because: "…",
      outcome: "ready",
      reason: null,
      scene: "…",
      holdsLikeness: true,
      spentToday: 0,
      allowance: 4,
    });

    expect(prompt).toContain("asleep");
    expect(prompt).toContain(QUIET.end);
  });

  it("should never claim the video is on its way before she has decided", () => {
    // The whole ruling in one assertion. This turn is where the decision
    // happens; a prompt that framed the sending as already agreed would put
    // the decision back before the looking.
    const prompt = renderReviewPrompt({
      now: AFTERNOON,
      tz: TZ,
      quiet: QUIET,
      inQuietHours: false,
      renderName: RENDER,
      because: "…",
      outcome: "ready",
      reason: null,
      scene: "…",
      holdsLikeness: true,
      spentToday: 0,
      allowance: 4,
    });

    expect(prompt).toMatch(/nothing (has )?(reached|gone to) him/i);
  });

  it("should warn her when the framing was never one her reference could hold", () => {
    // A render at a framing the reference cannot anchor is SUPPOSED to come
    // back as somebody else. Without this she would judge a known limitation
    // as though it were a failure of her own likeness.
    const prompt = renderReviewPrompt({
      now: AFTERNOON,
      tz: TZ,
      quiet: QUIET,
      inQuietHours: false,
      renderName: RENDER,
      because: "…",
      outcome: "ready",
      reason: null,
      scene: "…",
      holdsLikeness: false,
      spentToday: 0,
      allowance: 4,
    });

    expect(prompt).toMatch(/likeness|anchor|hold/i);
  });
});

describe("sentToHim", () => {
  it("should recognise the verb in both spellings a transcript can carry", () => {
    // Claude Code presents an MCP verb as `mcp__syl__show_him`; a fixture
    // written with the bare name means the same thing.
    expect(sentToHim([])).toBe(false);
    expect(sentToHim(said("…", ["show_him"]).events)).toBe(true);
    expect(sentToHim(said("…", [mcpToolName("show_him")]).events)).toBe(true);
    expect(sentToHim(said("…", ["see_myself"]).events)).toBe(false);
  });

  it("should count only the verbs that actually reach him", () => {
    // `see_myself` is looking, not speaking. Counting it would spend a day's
    // allowance on a turn in which she said nothing to him at all.
    expect(SENDS_TO_HIM).toEqual(["show_him"]);
  });
});

describe("describeRenderReview", () => {
  it("should say when she next comes back to look", () => {
    const { jobs } = stores();
    const job = ensureRenderReviewJob(jobs, AFTERNOON);

    const [line] = describeRenderReview(job);
    expect(line).toContain("five minutes");
    expect(line).toContain(job.nextRunAt ?? "");
  });
});
