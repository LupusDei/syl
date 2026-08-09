import { rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createContentIngestionHandler,
  ensureContentIngestionJob,
} from "../../src/connections/intake-job.js";
import type { IntakeSource } from "../../src/connections/intake-store.js";
import { fixedClock } from "../../src/services/clock.js";
import { JobRunner, type Timers } from "../../src/services/job-runner.js";
import { expectData, startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * `syl-1o7` — does article intake work against the database the service opens?
 *
 * The schema check next door asks whether the tables exist. That is necessary
 * and it is not the question: intake could have every table and still be
 * unreachable, which is exactly where it was. Nothing constructed
 * `IntakeStore`, there was no route, and `content_ingestion` was a declared
 * `JobKind` with no handler — so landing the migration alone would have made
 * the schema test green and changed nothing about whether a link can be
 * ingested.
 *
 * So this drives the whole thing through `startLiveService`: real `bootstrap`,
 * a real SQLite **file** with all eight migrations applied, a real TCP port,
 * and the job runner assembled the way `main` assembles it.
 *
 * ## The fetcher is the real one
 *
 * `bootstrap` leaves `ArticleIntake`'s fetcher at its default, `safeFetch` —
 * the SSRF guard — and nothing here overrides it. That is deliberate: the one
 * thing worse than intake not working is intake working with the guard off.
 * The ladder is therefore driven against an address the guard must refuse, and
 * the refusal being recorded on the source row is the proof that the fetch
 * step really ran against a real store.
 */

const FROZEN = Date.UTC(2026, 7, 10, 17, 0, 0, 0);

/** Timers the runner never actually arms, so a test drives every tick. */
const inertTimers: Timers = { set: () => null, clear: () => undefined };

describe("article intake against a live, migrated service", () => {
  let syl: LiveService;
  /** Store directories a restart test kept alive past its service's close. */
  let leftovers: string[] = [];

  beforeEach(async () => {
    syl = await startLiveService({ clock: fixedClock(FROZEN) });
    leftovers = [];
  });

  afterEach(async () => {
    await syl.close();
    // WAL leaves `-wal` and `-shm` beside the `.db`, so a restart test that
    // deletes only the file it named leaves two behind on every run.
    for (const directory of leftovers) rmSync(directory, { recursive: true, force: true });
  });

  describe("submission over HTTP", () => {
    it("should record a submitted link in the real database", async () => {
      const response = await syl.api("/intake", {
        method: "POST",
        body: JSON.stringify({ url: "https://example.com/tidy-desks?utm_source=newsletter" }),
      });
      const source = await expectData<IntakeSource>(response);

      expect(response.status).toBe(201);
      expect(source.id).toMatch(/^syl:source:/u);
      expect(source.stage).toBe("fetch");
      // Never negotiable, and it is a column rather than an assumption: a link
      // the Commander sent himself is exactly as hostile as one Syl found.
      expect(source.origin).toBe("untrusted");
      // The classifier ran, and the tracking parameter is not part of the key.
      expect(source.retention).toBe("standard");
      expect(source.canonicalUrl).toBe("https://example.com/tidy-desks");

      // And it is really in the file, not in something the route kept.
      const row = syl.database.handle
        .prepare("SELECT stage FROM intake_sources WHERE id = ?")
        .get(source.id);
      expect(row).toEqual({ stage: "fetch" });
    });

    it("should hand back the same source when the same link arrives twice", async () => {
      const body = JSON.stringify({ url: "https://example.com/tidy-desks" });
      const first = await expectData<IntakeSource>(
        await syl.api("/intake", { method: "POST", body }),
      );

      // A different idempotency key, so this is the store's UNIQUE index doing
      // the work rather than the replay ledger — the Share Extension and a
      // forwarded email are two genuinely different requests for one article.
      const repeat = await syl.api("/intake", { method: "POST", body });

      expect(repeat.status).toBe(200);
      expect((await expectData<IntakeSource>(repeat)).id).toBe(first.id);
    });

    it("should replay a retried submission under the same idempotency key", async () => {
      const body = JSON.stringify({ url: "https://example.com/retried" });
      await syl.api("/intake", { method: "POST", body, idempotencyKey: "intake-retry" });
      const replay = await syl.api("/intake", { method: "POST", body, idempotencyKey: "intake-retry" });

      expect(replay.headers.get("idempotency-replayed")).toBe("true");
    });

    it("should honour an explicit retention class over the classifier", async () => {
      const source = await expectData<IntakeSource>(
        await syl.api("/intake", {
          method: "POST",
          body: JSON.stringify({ url: "https://example.com/notes", retention: "sensitive" }),
        }),
      );

      expect(source.retention).toBe("sensitive");
      expect(source.expiresAt).toBeNull();
    });

    it("should classify a bank link as sensitive without being asked", async () => {
      const source = await expectData<IntakeSource>(
        await syl.api("/intake", {
          method: "POST",
          body: JSON.stringify({ url: "https://secure.chase.com/statements" }),
        }),
      );

      expect(source.retention).toBe("sensitive");
    });

    it("should refuse a body that is not a URL, in the contract's envelope", async () => {
      const response = await syl.api("/intake", {
        method: "POST",
        body: JSON.stringify({ url: "not a url at all" }),
      });
      const body = (await response.json()) as { success: boolean; error?: { code?: string } };

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe("VALIDATION_FAILED");
    });

    it("should refuse a scheme Syl does not fetch, without recording it", async () => {
      // `safeFetch` would refuse these too, permanently, at the fetch step —
      // but a submission that can never succeed should be answered at the door
      // rather than left in the store as a source to wonder about.
      for (const url of ["file:///etc/passwd", "data:text/html,<p>hi</p>", "ftp://example.com/x"]) {
        const response = await syl.api("/intake", {
          method: "POST",
          body: JSON.stringify({ url }),
        });

        expect(response.status).toBe(400);
      }

      expect(
        syl.database.handle.prepare("SELECT count(*) AS n FROM intake_sources").get(),
      ).toEqual({ n: 0 });
    });

    it("should refuse a channel or a retention class it does not know", async () => {
      for (const body of [
        { url: "https://example.com/a", channel: "telepathy" },
        { url: "https://example.com/b", retention: "forever" },
      ]) {
        const response = await syl.api("/intake", { method: "POST", body: JSON.stringify(body) });
        const envelope = (await response.json()) as { error?: { code?: string } };

        expect(response.status).toBe(400);
        expect(envelope.error?.code).toBe("VALIDATION_FAILED");
      }
    });

    it("should refuse a submission with no Idempotency-Key", async () => {
      // Every write takes one. The client that needs it most is the phone's
      // outbox, which retries by design.
      const response = await fetch(`${syl.baseUrl}/intake`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${syl.token}` },
        body: JSON.stringify({ url: "https://example.com/keyless" }),
      });
      const body = (await response.json()) as { error?: { code?: string } };

      expect(body.error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    it("should refuse an anonymous submission", async () => {
      const response = await syl.api("/intake", {
        method: "POST",
        anonymous: true,
        body: JSON.stringify({ url: "https://example.com/anything" }),
      });
      const body = (await response.json()) as { error?: { code?: string } };

      expect(body.error?.code).toBe("UNAUTHORIZED");
    });

    it("should read a source back by id, and 404 an id that names nothing", async () => {
      const source = await expectData<IntakeSource>(
        await syl.api("/intake", {
          method: "POST",
          body: JSON.stringify({ url: "https://example.com/readback" }),
        }),
      );

      const fetched = await expectData<IntakeSource>(
        await syl.api(`/intake/${encodeURIComponent(source.id)}`),
      );
      expect(fetched.id).toBe(source.id);

      // Unencoded, because `syl:source:<uuid>` is what a client actually puts
      // in a path and the colons must not stop the route matching. The
      // discriminator is the message: a mounted route says "no intake source",
      // an unmounted path falls through to the terminal handler.
      const absent = await syl.api("/intake/syl:source:00000000-0000-7000-8000-0000000000ff");
      const failure = (await absent.json()) as { error?: { message?: string } };

      expect(absent.status).toBe(404);
      expect(failure.error?.message).toContain("no intake source");

      const garbage = await syl.api("/intake/not-an-id");
      expect(((await garbage.json()) as { error?: { message?: string } }).error?.message).toContain(
        "not an intake source id",
      );
    });
  });

  describe("the content_ingestion job", () => {
    /** The runner `main` builds, on inert timers so ticks are explicit. */
    function runner(): JobRunner {
      ensureContentIngestionJob(syl.deps.jobs, FROZEN);
      return new JobRunner({
        store: syl.deps.jobs,
        handlers: new Map([
          [
            "content_ingestion",
            createContentIngestionHandler({
              intake: syl.deps.intake,
              queue: syl.deps.intakeQueue,
              clock: fixedClock(FROZEN),
            }),
          ],
        ]),
        clock: fixedClock(FROZEN),
        timers: inertTimers,
      });
    }

    it("should advance a submitted source when the runner ticks", async () => {
      const source = await expectData<IntakeSource>(
        await syl.api("/intake", {
          method: "POST",
          // The guard must refuse this. `bootstrap` uses `safeFetch` and this
          // test does not override it, so what runs here is the production
          // fetcher against a link-local address.
          body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }),
        }),
      );

      // The submission reached the queue, which means `ArticleIntake` finally
      // has the scheduler it has always asked for.
      expect(syl.deps.intakeQueue.size).toBe(1);

      const tick = await runner().tick();
      expect(tick.ran).toHaveLength(1);

      // The fetch step ran, the SSRF guard refused it, and the reason is on the
      // row in the migrated database.
      const advanced = await expectData<IntakeSource>(
        await syl.api(`/intake/${encodeURIComponent(source.id)}`),
      );
      expect(advanced.stage).toBe("failed");
      expect(advanced.failure).toMatch(/169\.254\.169\.254|not public|refus/iu);
    });

    it("should not fail the job when a source is refused", async () => {
      await syl.api("/intake", {
        method: "POST",
        body: JSON.stringify({ url: "http://10.0.0.1/internal" }),
      });

      await runner().tick();
      const runs = syl.deps.jobs.listRuns({ limit: 10 }).items;

      // A source Syl refused to fetch is intake working, not intake broken.
      // Five "failures" in a row would otherwise open a circuit breaker that
      // stops every other source too.
      expect(runs.map((run) => run.outcome)).toEqual(["success"]);
    });

    it("should have a registered handler, unlike every other kind in the catalogue", async () => {
      // The specific defect: `JobRunner.#runOne` fails a job whose kind has no
      // handler. Before this wave `content_ingestion` had none, so the job — if
      // anything had ever defined one — would have failed on sight.
      await syl.api("/intake", {
        method: "POST",
        body: JSON.stringify({ url: "http://10.0.0.2/internal" }),
      });

      await runner().tick();
      const [run] = syl.deps.jobs.listRuns({ limit: 1 }).items;

      expect(run?.error ?? "").not.toMatch(/No handler is registered/u);
    });
  });

  describe("across a restart", () => {
    it("should pick a half-ingested source back up", async () => {
      const source = await expectData<IntakeSource>(
        await syl.api("/intake", {
          method: "POST",
          body: JSON.stringify({ url: "https://example.com/half-read" }),
        }),
      );

      // Down hard, mid-ladder. The queue is in memory; the stage is not.
      const path = syl.databasePath;
      if (syl.directory !== null) leftovers.push(syl.directory);
      await syl.close({ keepDatabase: true });

      // `afterEach` closes whatever `syl` names, so the restarted service takes
      // its place rather than being cleaned up by hand.
      syl = await startLiveService({ databasePath: path });

      // `bootstrap` recovered it from `intake_sources.stage`, which is the
      // whole point of a resumable ladder: a crash costs at most one retry
      // delay and never a source.
      expect(syl.deps.intakeQueue.size).toBe(1);
      expect(syl.deps.intake.get(source.id)?.stage).toBe("fetch");
    });
  });
});
