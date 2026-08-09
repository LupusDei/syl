import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FetchRefused, type FetchResult } from "../../src/connections/fetch.js";
import {
  createContentIngestionHandler,
  defineContentIngestionJob,
  ensureContentIngestionJob,
  IDLE_POLL_MS,
  IntakeQueue,
  nextWakeFor,
} from "../../src/connections/intake-job.js";
import { ArticleIntake, RETRY_DELAY_MS } from "../../src/connections/intake.js";
import type { IntakeStore } from "../../src/connections/intake-store.js";
import type { Run } from "@syl/shared";
import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import type { JobContext, JobHandler } from "../../src/services/job-runner.js";
import { JobStore } from "../../src/services/job-store.js";
import { intakeDatabase, testIntakeStore } from "../helpers/intake.js";
import { TEST_NOW } from "../helpers/service.js";

/**
 * The engine intake never had.
 *
 * `content_ingestion` was a declared `JobKind` with no handler and no job row,
 * so a complete, well-tested ladder had nothing to turn it. These tests are
 * about the two pieces that make it turn: which source is advanced next
 * ({@link IntakeQueue}), and what one run of the job does.
 */

const ARTICLE = [
  "<!DOCTYPE html><html><head><title>Tidy Desks</title></head><body>",
  "<p>A cleared desk correlates with fewer context switches per hour.</p>",
  "</body></html>",
].join("\n");

let db: SylDatabase;
let store: IntakeStore;
let jobs: JobStore;
let now: number;

beforeEach(() => {
  now = TEST_NOW;
  db = intakeDatabase();
  store = testIntakeStore(db);
  jobs = new JobStore({ db: db.handle, clock: () => now });
});

afterEach(() => {
  db.close();
});

/** A fetcher that answers with a fixed body and never opens a socket. */
function serving(body: string) {
  return async (url: string): Promise<FetchResult> => ({
    url,
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body,
    bytes: Buffer.byteLength(body),
    chain: [url],
  });
}

/** The context `JobRunner` would hand a handler. */
function context(at: number): JobContext {
  const run: Run = {
    id: "syl:run:00000000-0000-7000-8000-000000000001",
    jobId: "syl:job:00000000-0000-7000-8000-000000000001",
    kind: "content_ingestion",
    triggerInstant: new Date(at).toISOString(),
    actualInstant: new Date(at).toISOString(),
    latenessMs: 0,
    outcome: "abandoned",
    spoke: false,
    turns: 0,
    costUsd: 0,
    summary: null,
    error: null,
    attempts: 1,
    startedAt: new Date(at).toISOString(),
    finishedAt: null,
    steps: [],
  };
  return {
    job: ensureContentIngestionJob(jobs, at),
    run,
    triggerInstant: run.triggerInstant,
    late: false,
    now: at,
  };
}

describe("IntakeQueue", () => {
  it("should hand back nothing when nothing has been scheduled", () => {
    const queue = new IntakeQueue();

    expect(queue.claim(now)).toBeNull();
    expect(queue.nextWakeAt()).toBeNull();
    expect(queue.size).toBe(0);
  });

  it("should hand back a source that is due, and only once", () => {
    const queue = new IntakeQueue();
    queue.schedule({ sourceId: "syl:source:a", notBefore: now });

    expect(queue.claim(now)).toBe("syl:source:a");
    // Claiming removes it. The step that follows re-schedules it if there is
    // more to do; a source that has finished must not linger.
    expect(queue.claim(now)).toBeNull();
  });

  it("should not hand back a source whose backoff has not elapsed", () => {
    const queue = new IntakeQueue();
    queue.schedule({ sourceId: "syl:source:a", notBefore: now + RETRY_DELAY_MS });

    expect(queue.claim(now)).toBeNull();
    expect(queue.claim(now + RETRY_DELAY_MS)).toBe("syl:source:a");
  });

  it("should take the source that has been waiting longest", () => {
    const queue = new IntakeQueue();
    queue.schedule({ sourceId: "syl:source:late", notBefore: now - 1_000 });
    queue.schedule({ sourceId: "syl:source:early", notBefore: now - 60_000 });

    // Oldest first, so one document cannot starve another by being submitted
    // more often.
    expect(queue.claim(now)).toBe("syl:source:early");
    expect(queue.claim(now)).toBe("syl:source:late");
  });

  it("should keep only the latest instant for a source scheduled twice", () => {
    const queue = new IntakeQueue();
    queue.schedule({ sourceId: "syl:source:a", notBefore: now });
    queue.schedule({ sourceId: "syl:source:a", notBefore: now + 5_000 });

    expect(queue.size).toBe(1);
    expect(queue.claim(now)).toBeNull();
  });

  it("should report the earliest instant anything becomes claimable", () => {
    const queue = new IntakeQueue();
    queue.schedule({ sourceId: "syl:source:a", notBefore: now + 5_000 });
    queue.schedule({ sourceId: "syl:source:b", notBefore: now + 500 });

    expect(queue.nextWakeAt()).toBe(now + 500);
  });

  it("should forget a source on request, so a purged one is not re-advanced", () => {
    const queue = new IntakeQueue();
    queue.schedule({ sourceId: "syl:source:a", notBefore: now });
    queue.forget("syl:source:a");

    expect(queue.claim(now)).toBeNull();
  });

  describe("recover", () => {
    it("should seed everything mid-ladder from the store", () => {
      const intake = new ArticleIntake({ store, clock: () => now, fetch: serving(ARTICLE) });
      const submitted = intake.submit({
        url: "https://example.com/tidy-desks",
        channel: "link",
        requestedBy: "commander",
      });

      // A fresh process: the queue is empty and only the `stage` column knows
      // there is work outstanding.
      const queue = new IntakeQueue();
      expect(queue.recover(intake, now)).toBe(1);
      expect(queue.claim(now)).toBe(submitted.source.id);
    });

    it("should not seed a source that has finished or failed", () => {
      store.create({
        url: "https://example.com/done",
        channel: "link",
        requestedBy: "commander",
        retention: "standard",
        retentionReason: "public web content",
      });
      const [pending] = store.pending();
      store.update(pending?.id ?? "", { stage: "done" });

      expect(new IntakeQueue().recover(store, now)).toBe(0);
    });

    it("should not move a backoff that is already known", () => {
      const { source } = store.create({
        url: "https://example.com/waiting",
        channel: "link",
        requestedBy: "commander",
        retention: "standard",
        retentionReason: "public web content",
      });

      const queue = new IntakeQueue();
      queue.schedule({ sourceId: source.id, notBefore: now + RETRY_DELAY_MS });
      queue.recover(store, now);

      // Recovery is for what the queue does not know about. A source already
      // backing off keeps its backoff rather than being retried immediately.
      expect(queue.claim(now)).toBeNull();
    });
  });
});

describe("defineContentIngestionJob", () => {
  it("should define exactly one row, and find it again rather than defining a second", () => {
    const first = ensureContentIngestionJob(jobs, now);
    const second = ensureContentIngestionJob(jobs, now + 60_000);

    expect(second.id).toBe(first.id);
    expect(jobs.list({ kind: "content_ingestion" }).items).toHaveLength(1);
  });

  it("should spend no turns outside the one reader turn a read step needs", () => {
    const job = defineContentIngestionJob(jobs);

    // One, not none: `#readStep` spawns exactly one `--tools ""` turn. A
    // budget of more than one would mean a run could drain a whole book.
    expect(job.budget.maxTurns).toBe(1);
    expect(job.budget.allowedTools).toEqual([]);
  });

  it("should never speak, and never outrank a reminder", () => {
    const job = defineContentIngestionJob(jobs);

    // A source being read is not news, and reading an article is never more
    // urgent than the Commander's own work or a reminder.
    expect(job.speaks).toBe(false);
    expect(job.priority).toBe("background");
  });

  it("should skip a missed instant rather than catching up on every one", () => {
    // Three missed wake-ups produce one pass, not three: the durable state is
    // the source's stage, not the instant we meant to look at it.
    expect(defineContentIngestionJob(jobs).catchUp.policy).toBe("skip");
  });
});

describe("the content_ingestion handler", () => {
  function handlerFor(intake: ArticleIntake, queue: IntakeQueue): JobHandler {
    return createContentIngestionHandler({ intake, queue, clock: () => now });
  }

  it("should do nothing and sleep when there is nothing to ingest", async () => {
    const queue = new IntakeQueue();
    const intake = new ArticleIntake({ store, clock: () => now, fetch: serving(ARTICLE) });

    const result = await handlerFor(intake, queue)(context(now));

    expect(result.outcome).toBe("success");
    expect(result.turns).toBe(0);
    expect(result.nextRunAt).toBe(new Date(now + IDLE_POLL_MS).toISOString());
  });

  it("should advance one step per run, and no more", async () => {
    const queue = new IntakeQueue();
    const intake = new ArticleIntake({
      store,
      clock: () => now,
      fetch: serving(ARTICLE),
      scheduler: queue,
    });
    const handler = handlerFor(intake, queue);
    const { source } = intake.submit({
      url: "https://example.com/tidy-desks",
      channel: "link",
      requestedBy: "commander",
    });

    // Submission scheduled it. One run does the fetch step and stops — a
    // thirty-chapter book is thirty runs, not one that never returns.
    await handler(context(now));
    expect(intake.get(source.id)?.stage).toBe("read");
    expect(intake.get(source.id)?.chunkCount).toBe(1);

    // And it asked to be called again, promptly.
    expect(queue.size).toBe(1);
  });

  it("should count the turn a read step spends, and no turn for a fetch step", async () => {
    const queue = new IntakeQueue();
    const intake = new ArticleIntake({
      store,
      clock: () => now,
      fetch: serving(ARTICLE),
      scheduler: queue,
    });
    const handler = handlerFor(intake, queue);
    intake.submit({
      url: "https://example.com/tidy-desks",
      channel: "link",
      requestedBy: "commander",
    });

    // The fetch step spawns nothing at all.
    expect((await handler(context(now))).turns).toBe(0);
  });

  it("should record a refused source on the run without failing the run", async () => {
    const queue = new IntakeQueue();
    const intake = new ArticleIntake({
      store,
      clock: () => now,
      scheduler: queue,
      fetch: () => Promise.reject(new FetchRefused("blocked_address", "169.254.169.254 is not public.")),
    });
    const { source } = intake.submit({
      url: "http://169.254.169.254/latest/meta-data/",
      channel: "link",
      requestedBy: "commander",
    });

    const result = await handlerFor(intake, queue)(context(now));

    // The SSRF refusal is permanent, so the source is done for.
    expect(intake.get(source.id)?.stage).toBe("failed");
    expect(intake.get(source.id)?.failure).toMatch(/not public/u);

    // But the RUN succeeded. A source Syl refused to fetch is intake working,
    // not intake broken — and marking the job failed would count towards a
    // circuit breaker that would then stop every other source too.
    expect(result.outcome).toBe("success");
    expect(result.error).toContain(source.id);

    // Nothing left to do for it, so the queue is empty and the job sleeps.
    expect(queue.size).toBe(0);
  });

  it("should put a source back in the queue when a step throws unexpectedly", async () => {
    const queue = new IntakeQueue();
    const intake = new ArticleIntake({ store, clock: () => now, scheduler: queue });
    const { source } = intake.submit({
      url: "https://example.com/doomed",
      channel: "link",
      requestedBy: "commander",
    });

    const ctx = context(now);
    // `advance` sorts its own failures into permanent and retryable, so
    // anything that escapes it is a failure the ladder did not expect — a
    // vanished row, a disk error. `claim` has already removed the source, so
    // without the guard it would never re-enter the queue until a restart: a
    // source silently dropped by a store error nobody saw.
    store.purge(source.id);

    await expect(handlerFor(intake, queue)(ctx)).rejects.toThrow(/no intake source/u);
    expect(queue.claim(now + RETRY_DELAY_MS)).toBe(source.id);
  });

  it("should back a retryable failure off rather than spinning on it", async () => {
    const queue = new IntakeQueue();
    const intake = new ArticleIntake({
      store,
      clock: () => now,
      scheduler: queue,
      fetch: () => Promise.reject(new Error("socket hang up")),
    });
    intake.submit({
      url: "https://example.com/flaky",
      channel: "link",
      requestedBy: "commander",
    });

    const result = await handlerFor(intake, queue)(context(now));

    expect(result.nextRunAt).toBe(new Date(now + RETRY_DELAY_MS).toISOString());
    expect(queue.claim(now)).toBeNull();
  });
});

describe("nextWakeFor", () => {
  it("should sleep the idle poll when nothing is queued", () => {
    expect(nextWakeFor(new IntakeQueue(), now)).toBe(new Date(now + IDLE_POLL_MS).toISOString());
  });

  it("should wake for the earliest queued source", () => {
    const queue = new IntakeQueue();
    queue.schedule({ sourceId: "syl:source:a", notBefore: now + 30_000 });

    expect(nextWakeFor(queue, now)).toBe(new Date(now + 30_000).toISOString());
  });

  it("should never return an instant in the past", () => {
    // A backlog whose instants have all passed would otherwise ask the runner
    // for a negative delay, which it clamps — but the job's own `nextRunAt`
    // would then be a lie about when it meant to run.
    const queue = new IntakeQueue();
    queue.schedule({ sourceId: "syl:source:a", notBefore: now - 600_000 });

    expect(nextWakeFor(queue, now)).toBe(new Date(now).toISOString());
  });

  it("should never sleep past the idle ceiling", () => {
    const queue = new IntakeQueue();
    queue.schedule({ sourceId: "syl:source:a", notBefore: now + 10 * IDLE_POLL_MS });

    expect(nextWakeFor(queue, now)).toBe(new Date(now + IDLE_POLL_MS).toISOString());
  });
});

describe("the clock the handler schedules from", () => {
  it("should default to the system clock when none is injected", async () => {
    const queue = new IntakeQueue();
    const intake = new ArticleIntake({ store, clock: fixedClock(TEST_NOW) });
    const handler = createContentIngestionHandler({ intake, queue });

    const before = Date.now();
    const result = await handler(context(TEST_NOW));

    expect(Date.parse(result.nextRunAt ?? "")).toBeGreaterThanOrEqual(before + IDLE_POLL_MS);
  });
});
