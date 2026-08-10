import { describe, expect, it, vi } from "vitest";

import type { DeliveryPage, JobPage, RunPage } from "@syl/shared/types";

import { fixture, fixtureResponse } from "../helpers/fixtures";

import { createAdminClient, withQuery, type AdminClient } from "../../src/api/client";
import type { AuthedRequest } from "../../src/api/use-authed-fetch";

/**
 * The transport, faked at the seam `authed-fetch` already draws: the client
 * gets a path and returns a `Response`. Every body below is a shipped fixture
 * — the real bytes the mock serves — so a drift between the contract and what
 * this client expects fails here rather than in a browser.
 */
function recorder(bodies: unknown[], status = 200): { paths: string[]; request: AuthedRequest } {
  const paths: string[] = [];
  let call = 0;
  return {
    paths,
    request: (path) => {
      paths.push(path);
      const body = bodies[Math.min(call, bodies.length - 1)];
      call += 1;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  };
}

/** No sleeping and no jitter, so a retry test is deterministic and instant. */
function clientFor(request: AuthedRequest): AdminClient {
  return createAdminClient({
    request,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  });
}

describe("withQuery", () => {
  it("should leave a path alone when nothing was supplied", () => {
    expect(withQuery("/jobs", {})).toBe("/jobs");
    expect(withQuery("/jobs", { state: undefined, cursor: null })).toBe("/jobs");
  });

  it("should append only the parameters that were given", () => {
    expect(withQuery("/jobs", { state: "failed", limit: 25 })).toBe("/jobs?state=failed&limit=25");
  });

  it("should serialise booleans the way the contract's filter expects", () => {
    expect(withQuery("/deliveries", { unacknowledged: true })).toBe("/deliveries?unacknowledged=true");
  });

  it("should encode values that would otherwise break the query", () => {
    expect(withQuery("/conversations", { cursor: "a b&c" })).toBe("/conversations?cursor=a+b%26c");
  });
});

describe("AdminClient paths", () => {
  it("should request each read endpoint at its contract path", async () => {
    const { paths, request } = recorder([fixture("http/jobs.page")]);
    const client = clientFor(request);

    await client.health();
    await client.listJobs();
    await client.getJob("syl:job:0198f2c4-0001-7000-8000-00000000e001");
    await client.listJobRuns("syl:job:0198f2c4-0001-7000-8000-00000000e001");
    await client.getRun("syl:run:0198f2c7-0001-7000-8000-000000011001");
    await client.listDeliveries();
    await client.getDelivery("syl:delivery:0198f2c6-0001-7000-8000-000000010001");
    await client.listConversations();
    await client.getConversation("syl:conversation:00000000-0000-7000-8000-000000000001");
    await client.listMessages("syl:conversation:00000000-0000-7000-8000-000000000001");
    await client.listDevices();
    await client.listLogs();

    expect(paths).toEqual([
      "/health",
      "/jobs",
      "/jobs/syl%3Ajob%3A0198f2c4-0001-7000-8000-00000000e001",
      "/jobs/syl%3Ajob%3A0198f2c4-0001-7000-8000-00000000e001/runs",
      "/runs/syl%3Arun%3A0198f2c7-0001-7000-8000-000000011001",
      "/deliveries",
      "/deliveries/syl%3Adelivery%3A0198f2c6-0001-7000-8000-000000010001",
      "/conversations",
      "/conversations/syl%3Aconversation%3A00000000-0000-7000-8000-000000000001",
      "/conversations/syl%3Aconversation%3A00000000-0000-7000-8000-000000000001/messages",
      "/devices",
      "/logs",
    ]);
  });

  it("should pass every documented filter through as a query parameter", async () => {
    const { paths, request } = recorder([fixture("http/jobs.page")]);
    const client = clientFor(request);

    await client.listJobs({ state: "failed", kind: "morning_agenda", cursor: "c1", limit: 10 });
    await client.listDeliveries({ unacknowledged: true, state: "pending" });
    await client.listConversations({ lane: "job" });
    await client.listMessages("syl:conversation:1", { direction: "forward", limit: 5 });
    await client.listJobRuns("syl:job:1", { cursor: "c2" });
    await client.listDevices({ limit: 2 });
    await client.listLogs({
      event: "turn.tool",
      level: "warn",
      since: "2026-08-10T00:00:00.000Z",
      until: "2026-08-10T23:59:59.999Z",
      limit: 200,
    });

    expect(paths).toEqual([
      "/jobs?cursor=c1&limit=10&state=failed&kind=morning_agenda",
      "/deliveries?state=pending&unacknowledged=true",
      "/conversations?lane=job",
      "/conversations/syl%3Aconversation%3A1/messages?limit=5&direction=forward",
      "/jobs/syl%3Ajob%3A1/runs?cursor=c2",
      "/devices?limit=2",
      "/logs?limit=200&event=turn.tool&level=warn&since=2026-08-10T00%3A00%3A00.000Z&until=2026-08-10T23%3A59%3A59.999Z",
    ]);
  });
});

describe("AdminClient decoding", () => {
  it("should decode the shipped jobs page into contract types", async () => {
    const { request } = recorder([fixture("http/jobs.page")]);
    const page: JobPage = await clientFor(request).listJobs();

    expect(page.items.length).toBeGreaterThan(0);
    const first = page.items[0];
    expect(first?.kind).toBe("reminder_delivery");
    expect(first?.budget.maxTurns).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it("should decode the shipped deliveries page, unacknowledged rows included", async () => {
    const { request } = recorder([fixture("http/deliveries.page")]);
    const page: DeliveryPage = await clientFor(request).listDeliveries();

    expect(page.items.some((delivery) => delivery.ackedAt === null)).toBe(true);
    const retrying = page.items.find((delivery) => delivery.attempts > 1);
    expect(retrying?.state).toBe("pending");
    expect(retrying?.lastError).not.toBeNull();
  });

  it("should decode a run with its ordered steps", async () => {
    const { request } = recorder([fixture("http/runs.page")]);
    const page: RunPage = await clientFor(request).listJobRuns("syl:job:1");

    const withSteps = page.items.find((run) => run.steps.length > 0);
    expect(withSteps?.steps[0]?.index).toBe(0);
    expect(typeof withSteps?.latenessMs).toBe("number");
  });
});

describe("AdminClient failures", () => {
  it("should throw the typed failure the server named", async () => {
    const { request } = recorder([fixture("errors/not_found")], 404);

    await expect(clientFor(request).getJob("syl:job:missing")).rejects.toThrowError(
      expect.objectContaining({ kind: "api", code: "NOT_FOUND" }) as Error,
    );
  });

  it("should report a body that is not JSON as malformed rather than empty", async () => {
    const request: AuthedRequest = () =>
      Promise.resolve(new Response("<html>gateway</html>", { status: 502 }));

    await expect(clientFor(request).listJobs()).rejects.toThrowError(
      expect.objectContaining({ kind: "malformed", status: 502 }) as Error,
    );
  });

  it("should report a request that never reached Syl as a network failure", async () => {
    const request = vi.fn<AuthedRequest>().mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(clientFor(request).listJobs()).rejects.toThrowError(
      expect.objectContaining({ kind: "network" }) as Error,
    );
    // Retried, because a torn-down tunnel comes back.
    expect(request.mock.calls.length).toBeGreaterThan(1);
  });

  it("should retry a retryable server failure and return the eventual success", async () => {
    const { request, paths } = recorder([fixture("errors/upstream_unavailable")]);
    const flaky = vi
      .fn<AuthedRequest>()
      .mockImplementationOnce(request)
      .mockImplementation(() => Promise.resolve(fixtureResponse("http/jobs.page")));

    const page = await clientFor(flaky).listJobs();
    expect(page.items.length).toBeGreaterThan(0);
    expect(paths).toEqual(["/jobs"]);
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it("should propagate an abort without retrying it", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const request = vi.fn<AuthedRequest>().mockRejectedValue(abort);

    await expect(clientFor(request).listJobs()).rejects.toBe(abort);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("should pass an abort signal down to the transport", async () => {
    const controller = new AbortController();
    const request = vi.fn<AuthedRequest>().mockResolvedValue(fixtureResponse("http/jobs.page"));

    await clientFor(request).listJobs(undefined, { signal: controller.signal });
    expect(request.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should send no init at all when there is no signal", async () => {
    const request = vi.fn<AuthedRequest>().mockResolvedValue(fixtureResponse("http/jobs.page"));

    await clientFor(request).listJobs();
    expect(request.mock.calls[0]?.[1]).toBeUndefined();
  });
});
