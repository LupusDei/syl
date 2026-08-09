import type { Job } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createContentIngestionHandler, ensureContentIngestionJob } from "../../src/connections/intake-job.js";
import type { IntakeSource } from "../../src/connections/intake-store.js";
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

  async function submit(url: string): Promise<IntakeSource> {
    return expectData<IntakeSource>(
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

      const reloaded = await expectData<IntakeSource>(
        await syl.api(`/intake/${encodeURIComponent(source.id)}`),
      );
      expect(reloaded.id).toBe(source.id);

      // Submitting the same link twice is one source, not two.
      const again = await syl.api("/intake", {
        method: "POST",
        body: JSON.stringify({ url: "https://example.com/tidy-desks", channel: "email" }),
      });
      expect(again.status).toBe(200);
      expect((await again.json() as { data: IntakeSource }).data.id).toBe(source.id);
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

        const advanced = await expectData<IntakeSource>(
          await syl.api(`/intake/${encodeURIComponent(source.id)}`),
        );

        // `stage: "failed"` is `#fail`'s record of a PERMANENT refusal — a
        // retryable one leaves the stage where it was. A tailnet address will
        // not become public on the next pass, and retrying is a loop that
        // probes the Commander's own network.
        expect(advanced.stage, "the ladder carried a tailnet link forward").toBe("failed");
        expect(advanced.failure).toContain("100.100.42.7");
        // `carrier_grade_nat` is the address CLASS, and only `parseUrl` names
        // it. A refusal that had opened a socket first would have come back
        // through `asRefusal` as a bare transport message with no class in it —
        // so this word is the evidence that nothing left the machine.
        expect(
          advanced.failure,
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
        const after = await expectData<IntakeSource>(
          await syl.api(`/intake/${encodeURIComponent(source.id)}`),
        );
        expect(after.id).toBe(source.id);
        expect(after.url).toBe(TAILNET_URL);
        expect(after.failure).not.toBeNull();
      } finally {
        runner.stop();
      }
    });
  });

  describe("what the shipped service does NOT wire", () => {
    /**
     * `syl-md5` in its second form.
     *
     * `bootstrap` builds `intake` and `intakeQueue` and calls
     * `intakeQueue.recover`, but the `content_ingestion` **job row** is created
     * only in `main` (backend/src/index.ts:385), and the handler is registered
     * only in `main`'s `createDeliveryRuntime` call. A service booted through
     * `bootstrap` + `startServer` — which is what every test uses, and what
     * `startLiveService` documents as "Syl, started the way `main` starts her"
     * — will accept a submission over HTTP and then never advance it.
     */
    it("should accept a link that nothing will ever ingest, when booted the way every test boots her", async () => {
      const source = await submit("https://example.com/tidy-desks");
      expect(source.stage).toBe("fetch");

      // Everything `bootstrap` + `startServer` produced is running. No job
      // exists to move it.
      const jobs = await expectData<{ items: Job[] }>(await syl.api("/jobs"));
      expect(
        jobs.items.filter((job) => job.kind === "content_ingestion"),
        "bootstrap now creates the content_ingestion job — update this test and syl-md5",
      ).toHaveLength(0);

      // The work is remembered, at least: the queue has it, so the moment
      // something does define the job the source is picked up.
      expect(syl.deps.intakeQueue.size).toBe(1);
    });
  });
});
