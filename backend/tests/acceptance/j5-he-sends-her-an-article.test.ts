import type { Job } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createContentIngestionHandler, ensureContentIngestionJob } from "../../src/connections/intake-job.js";
import type { IntakeAnswer, Reading } from "../../src/connections/intake-view.js";
import { fixedClock } from "../../src/services/clock.js";
import { JobRunner, type Timers } from "../../src/services/job-runner.js";
import { expectData, startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * **Journey 5 — he sends her an article.**
 *
 * Submitted over HTTP, recorded with provenance, and then advanced by the same
 * `content_ingestion` handler `main` registers, over the same `ArticleIntake`
 * `bootstrap` built — which means over the **real `safeFetch`**, not an
 * injected one. `bootstrap` deliberately leaves the fetcher at its default so
 * that a production caller cannot substitute away the SSRF guard, and this
 * journey is the only test that takes it at its word.
 *
 * The consequence is the finding: because the production guard refuses every
 * address a test can bind, the *happy path* of intake cannot be driven through
 * the shipped service at all. What can be driven through it — and is, here — is
 * the refusal.
 */

const FROZEN = Date.parse("2026-08-10T18:00:00.000Z");
const inertTimers: Timers = { set: () => 0, clear: () => undefined };

/** A Tailscale address. The Commander's own machines live in this range. */
const TAILNET_URL = "http://100.100.42.7:4201/api/v1/reminders";

describe("Journey 5 — he sends her an article", () => {
  let syl: LiveService;

  beforeEach(async () => {
    syl = await startLiveService({ clock: fixedClock(FROZEN) });
  });

  afterEach(async () => {
    await syl.close();
  });

  /** The runner `main` builds for intake: the same handler, the same queue. */
  function intakeRunner(): JobRunner {
    ensureContentIngestionJob(syl.deps.jobs, FROZEN);
    return new JobRunner({
      store: syl.deps.jobs,
      handlers: new Map([
        [
          "content_ingestion",
          createContentIngestionHandler({
            intake: syl.deps.intake,
            queue: syl.deps.intakeQueue,
            clock: () => FROZEN,
          }),
        ],
      ]),
      clock: () => FROZEN,
      timers: inertTimers,
      owner: "j5",
    });
  }

  /**
   * The reading out of an intake response.
   *
   * Both operations answer with `{ reading, reads }` rather than the store's
   * row — `syl-r1t`. The row carries the page's own `<title>`, which is raw
   * response bytes, and `read_this` puts this answer inside a turn holding MCP
   * tools. See `connections/intake-view.ts`.
   */
  async function readingIn(response: Response): Promise<Reading> {
    return (await expectData<IntakeAnswer>(response)).reading;
  }

  async function submit(url: string): Promise<Reading> {
    return readingIn(
      await syl.api("/intake", { method: "POST", body: JSON.stringify({ url, channel: "share" }) }),
    );
  }

  describe("submission", () => {
    it("should record a shared link with its provenance, and be readable back over HTTP", async () => {
      const source = await submit("https://example.com/tidy-desks");

      // Provenance: who asked, how it arrived, and how long it may be kept.
      // `requestedBy` comes from the verified principal, never from the body.
      expect(source.url).toBe("https://example.com/tidy-desks");
      expect(source.channel).toBe("share");
      expect(source.requestedBy).not.toBe("unknown");
      expect(source.retention).toBeDefined();
      expect(source.retentionReason).toBeTruthy();
      expect(source.stage).toBe("fetch");

      const reloaded = await readingIn(
        await syl.api(`/intake/${encodeURIComponent(source.id)}`),
      );
      expect(reloaded.id).toBe(source.id);

      // Submitting the same link twice is one source, not two.
      const again = await syl.api("/intake", {
        method: "POST",
        body: JSON.stringify({ url: "https://example.com/tidy-desks", channel: "email" }),
      });
      expect(again.status).toBe(200);
      expect((await again.json() as { data: IntakeAnswer }).data.reading.id).toBe(source.id);
    });

    it("should refuse a scheme that is not a fetch, at the door", async () => {
      for (const url of ["file:///etc/passwd", "data:text/html,<p>hi", "gopher://example.com/"]) {
        const response = await syl.api("/intake", {
          method: "POST",
          body: JSON.stringify({ url }),
        });
        expect(response.status, `${url} was accepted`).toBe(400);
      }
    });
  });

  describe("the boundary that matters — a link into the tailnet", () => {
    it("should refuse to fetch a Tailscale address through the shipped service, and never retry it", async () => {
      // Recorded, because the door only checks the scheme. The address is the
      // fetcher's business, and the fetcher is what the ladder reaches next.
      const source = await submit(TAILNET_URL);
      expect(source.stage).toBe("fetch");

      const runner = intakeRunner();
      try {
        await runner.start();

        const advanced = await readingIn(
          await syl.api(`/intake/${encodeURIComponent(source.id)}`),
        );

        // `stage: "failed"` is `#fail`'s record of a PERMANENT refusal — a
        // retryable one leaves the stage where it was. A tailnet address will
        // not become public on the next pass, and retrying is a loop that
        // probes the Commander's own network.
        expect(advanced.stage, "the ladder carried a tailnet link forward").toBe("failed");
        // The refusal reaches her as a sentence with a verdict on retrying, not
        // as free text — `syl-r1t`. It names the address, and that is safe to
        // repeat precisely because no response was read: there is nothing of
        // one to quote.
        expect(advanced.refusal?.retryable).toBe(false);
        expect(advanced.refusal?.says).toContain("100.100.42.7");
        // `carrier_grade_nat` is the address CLASS, and only `parseUrl` names
        // it. A refusal that had opened a socket first would have come back
        // through `asRefusal` as a bare transport message with no class in it —
        // so this word is the evidence that nothing left the machine.
        expect(
          advanced.refusal?.says,
          "the refusal did not come from the address guard",
        ).toContain("carrier_grade_nat");

        // And it is not queued for another attempt.
        expect(syl.deps.intakeQueue.size).toBe(0);
      } finally {
        runner.stop();
      }
    });

    it("should not remove the source from the world when it refuses it", async () => {
      // A refused link is still a thing he sent her. It stays visible, with the
      // reason, rather than vanishing.
      const source = await submit(TAILNET_URL);
      const runner = intakeRunner();
      try {
        await runner.start();
        const after = await readingIn(
          await syl.api(`/intake/${encodeURIComponent(source.id)}`),
        );
        expect(after.id).toBe(source.id);
        expect(after.url).toBe(TAILNET_URL);
        expect(after.refusal).not.toBeNull();
      } finally {
        runner.stop();
      }
    });
  });

  describe("what the shipped service wires", () => {
    /**
     * `syl-md5` in its second form, now closed.
     *
     * `bootstrap` built `intake` and `intakeQueue` and called
     * `intakeQueue.recover`, but the `content_ingestion` **job row** was created
     * only in `main`, and the handler registered only in `main`'s
     * `createDeliveryRuntime` call. A service booted through
     * `bootstrap` + `startServer` — which was every test, including the one that
     * documents itself as "Syl, started the way `main` starts her" — accepted a
     * submission over HTTP and then never advanced it. Nothing could see that,
     * because `main` was not callable.
     *
     * `startSyl` is `main` now, and this boots through it.
     */
    it("should advance a link it accepted, booted the way every test boots her", async () => {
      const source = await submit("https://example.com/tidy-desks");
      expect(source.stage).toBe("fetch");
      expect(syl.deps.intakeQueue.size).toBe(1);

      // The job exists because the service made it, not because this test did.
      const jobs = await expectData<{ items: Job[] }>(await syl.api("/jobs"));
      const ingestion = jobs.items.filter((job) => job.kind === "content_ingestion");
      expect(ingestion).toHaveLength(1);
      expect(ingestion[0]?.nextRunAt).not.toBeNull();

      // And the runtime the service built for itself moves it — no handler
      // assembled here, no runner assembled here.
      await syl.runtime.runner.tick();

      const after = await readingIn(
        await syl.api(`/intake/${encodeURIComponent(source.id)}`),
      );
      // The real `safeFetch` refuses to resolve example.com in this sandbox, so
      // what is asserted is that it *moved* — off `fetch`, by the shipped
      // wiring — rather than sitting where every previous boot left it.
      expect(after.stage).not.toBe("fetch");
      expect(syl.deps.intakeQueue.size).toBe(0);
    });
  });
});
