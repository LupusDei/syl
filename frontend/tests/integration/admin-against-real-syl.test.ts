import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startLiveService,
  type LiveService,
} from "../../../backend/tests/helpers/live-service.js";
import { createAdminClient, type AdminClient } from "../../src/api/client.js";

/**
 * The web admin's typed client against the real service.
 *
 * The admin was built entirely against `npm run mock`, and `client.test.ts`
 * drives it through a stubbed `AuthedRequest`. Both are measured against
 * `shared/openapi.yaml`. Neither has ever put a request on a socket that Syl
 * was listening to — so the parts a stub cannot have an opinion about (a real
 * query string, a real bearer header, a real 404 body) have never been checked.
 *
 * This imports across the workspace boundary, which is unusual and deliberate:
 * a test whose whole subject is a boundary has to be able to see both sides of
 * it. It uses the client the admin ships, not a copy of it.
 */

/** The admin's transport, minus the React hook that normally supplies it. */
function authedRequest(syl: LiveService): (path: string, init?: RequestInit) => Promise<Response> {
  return async (path, init) =>
    fetch(`${syl.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${syl.token}`, ...(init?.headers ?? {}) },
    });
}

describe("the web admin against the real service", () => {
  let syl: LiveService;
  let admin: AdminClient;

  beforeAll(async () => {
    syl = await startLiveService();
    admin = createAdminClient({ request: authedRequest(syl) });
  });

  afterAll(async () => {
    await syl.close();
  });

  it("should read health, which is the first thing the shell renders", async () => {
    const health = await admin.health();

    expect(["ok", "degraded", "down"]).toContain(health.status);
    expect(health.checks.length).toBeGreaterThan(0);
  });

  it("should page conversations and their messages through real query strings", async () => {
    // Query construction is exactly what a stubbed transport cannot get wrong,
    // and exactly what a real server can reject.
    const conversations = await admin.listConversations({ lane: "interactive", limit: 10 });
    expect(conversations.items.length).toBeGreaterThan(0);

    const first = conversations.items[0];
    if (first === undefined) throw new Error("no conversation to read");

    const conversation = await admin.getConversation(first.id);
    expect(conversation.id).toBe(first.id);

    const messages = await admin.listMessages(first.id, { limit: 5, direction: "backward" });
    expect(messages.hasMore).toBe(false);
  });

  it("should read the outbox, including the unacknowledged view the admin exists for", async () => {
    const all = await admin.listDeliveries({ limit: 20 });
    expect(all.items).toEqual([]);

    const unacknowledged = await admin.listDeliveries({ unacknowledged: true });
    expect(unacknowledged.items).toEqual([]);
  });

  it("should read jobs and devices", async () => {
    const jobs = await admin.listJobs({ limit: 20 });
    expect(Array.isArray(jobs.items)).toBe(true);

    const devices = await admin.listDevices();
    expect(Array.isArray(devices.items)).toBe(true);
  });

  it("should surface a real 404 as a typed contract error rather than a transport failure", async () => {
    await expect(
      admin.getJob("syl:job:00000000-0000-7000-8000-0000000000ff"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("should reject an unauthenticated call the way the shell expects, so it can sign out", async () => {
    const anonymous = createAdminClient({
      request: async (path, init) => fetch(`${syl.baseUrl}${path}`, init),
    });

    await expect(anonymous.listJobs()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
