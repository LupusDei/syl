import type { Conversation, Delivery, Device, Job, Reminder, Run } from "@syl/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERACTIVE_CONVERSATION_ID } from "../../src/services/database.js";
import {
  expectConformingFailure,
  expectConformingSuccess,
  fillPath,
  operation,
  specOperations,
} from "../helpers/contract.js";
import { startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * Does the **real** server honour the contract?
 *
 * `shared/tests/mock-server.test.ts` proves the mock does, and proves it
 * structurally — the mock's routing table is derived from `openapi.yaml`, so it
 * cannot serve a path the spec lacks or miss one it has. That guarantee is
 * about the mock. Both clients were built against the mock. If Syl herself
 * disagrees with the spec, every existing test in this repository still passes
 * and the disagreement is discovered by a phone.
 *
 * So this boots Syl the way `main` does — `bootstrap`, a real SQLite file, a
 * real port — drives her over HTTP, and validates each response against the
 * schema `openapi.yaml` names for that operation. No fixtures: fixtures prove
 * the shapes are decodable, and this proves the service emits them.
 */

/**
 * Operations in the contract with no route on the real service.
 *
 * A **finding, not a configuration** — see `syl-c1m`. The mock serves all nine,
 * because it reads the spec; Syl serves none of them, because someone has to
 * write the router. The iOS client has full `Todo`, `Goal` and `Sync` models
 * and calls `GET /sync` on every foreground reconcile.
 *
 * The test below asserts this set **exactly**, so landing one of these routes
 * turns the suite red until its name is removed, and adding a tenth
 * unimplemented operation turns it red immediately.
 */
const UNIMPLEMENTED: readonly string[] = [
  "completeTodo",
  "createGoal",
  "createTodo",
  "getGoal",
  "getTodo",
  "listGoals",
  "listTodos",
  "syncSinceCursor",
  "updateTodo",
];

/** Path parameters that are syntactically valid but name nothing. */
const ABSENT_IDS: Readonly<Record<string, string>> = {
  conversationId: "syl:conversation:00000000-0000-7000-8000-0000000000ff",
  reminderId: "syl:reminder:00000000-0000-7000-8000-0000000000ff",
  todoId: "syl:todo:00000000-0000-7000-8000-0000000000ff",
  goalId: "syl:goal:00000000-0000-7000-8000-0000000000ff",
  deviceId: "syl:device:00000000-0000-7000-8000-0000000000ff",
  deliveryId: "syl:delivery:00000000-0000-7000-8000-0000000000ff",
  jobId: "syl:job:00000000-0000-7000-8000-0000000000ff",
  runId: "syl:run:00000000-0000-7000-8000-0000000000ff",
};

const CHICAGO = "America/Chicago";
const APNS_TOKEN = "5f1c93ab".repeat(8);

describe("the live service against shared/openapi.yaml", () => {
  let syl: LiveService;

  beforeAll(async () => {
    syl = await startLiveService();
  });

  afterAll(async () => {
    await syl.close();
  });

  describe("every operation the contract publishes", () => {
    /**
     * Probe each operation **without** a token.
     *
     * A mounted route answers `UNAUTHORIZED`; an unmounted path falls through
     * to the terminal `notFound` handler. Both are 404/401 envelopes, so the
     * discriminator is which one comes back — and going in unauthenticated
     * means the answer cannot depend on whether the resource exists, which is
     * what makes this a routing check rather than a fixture check.
     */
    it("should be routable, or else named in UNIMPLEMENTED", async () => {
      const unroutable: string[] = [];

      for (const spec of specOperations()) {
        if (!spec.requiresAuth) continue;

        const response = await syl.api(fillPath(spec.template, ABSENT_IDS), {
          method: spec.method,
          anonymous: true,
          ...(spec.method === "GET" || spec.method === "DELETE"
            ? {}
            : { body: JSON.stringify({}) }),
        });
        const body = (await response.json()) as { error?: { code?: string } };

        if (body.error?.code !== "UNAUTHORIZED") unroutable.push(spec.operationId);
      }

      expect(unroutable.sort()).toEqual([...UNIMPLEMENTED].sort());
    });

    it("should answer an unmounted contract path with the terminal 404, not a framework page", async () => {
      // How the seam actually presents to a client: not a typed refusal from a
      // route, but the catch-all saying nothing here matches.
      const response = await syl.api("/todos");
      const error = await expectConformingFailure(response, "NOT_FOUND");

      expect(response.status).toBe(404);
      expect(error["message"]).toContain("No route on this service matches");
    });

    it("should still be answering in the contract's envelope when it refuses", async () => {
      // The one property a client cannot recover from losing: a body that is
      // neither envelope means "this is not Syl", and a 404 HTML page from a
      // proxy is indistinguishable from a route that does not exist.
      const response = await syl.api("/nothing/here/at/all");

      expect(response.headers.get("content-type")).toMatch(/application\/json/u);
      await expectConformingFailure(response, "NOT_FOUND");
    });
  });

  describe("health", () => {
    it("should conform without a token, as the only unauthenticated read", async () => {
      const response = await syl.api("/health", { anonymous: true });
      const health = await expectConformingSuccess<{ status: string }>(response, "getHealth");

      expect(["ok", "degraded"]).toContain(health.status);
      expect(operation("getHealth").requiresAuth).toBe(false);
    });
  });

  describe("auth", () => {
    it("should conform on whoami", async () => {
      const response = await syl.api("/auth/whoami");
      await expectConformingSuccess(response, "whoami");
    });

    it("should refuse a bad token in the contract's failure envelope", async () => {
      const response = await syl.api("/auth/whoami", {
        headers: { authorization: "Bearer not-a-token" },
      });
      const error = await expectConformingFailure(response, "UNAUTHORIZED");

      expect(response.status).toBe(401);
      expect(error["retryable"]).toBe(false);
    });
  });

  describe("conversations", () => {
    it("should conform on the page, the lane, and its messages", async () => {
      const page = await expectConformingSuccess<{ items: Conversation[] }>(
        await syl.api("/conversations"),
        "listConversations",
      );
      expect(page.items.some((item) => item.id === INTERACTIVE_CONVERSATION_ID)).toBe(true);

      await expectConformingSuccess(
        await syl.api(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}`),
        "getConversation",
      );
      await expectConformingSuccess(
        await syl.api(`/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`),
        "listMessages",
      );
    });

    it("should conform on a send", async () => {
      const path = `/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`;
      const body = JSON.stringify({
        clientId: "syl:message:00000000-0000-7000-8000-00000000c0de",
        text: "Is the pharmacy still open?",
      });

      const first = await syl.api(path, { method: "POST", body, idempotencyKey: "conform-send" });
      await expectConformingSuccess(first, "sendMessage");
    });

    /**
     * `syl-9e0` — the replay answers 200, and 201 is the only success status
     * the contract documents for `sendMessage`.
     *
     * `backend/src/routes/idempotency.ts` — which every other write route goes
     * through — argues the opposite case in its own doc comment: *"A replayed
     * request answers with the stored status, not a fresh one. A client that
     * got a 201 the first time and a 200 the second has to reconcile two
     * different answers to one operation."* Two files in one service disagree,
     * and the contract sides with the one this route does not use.
     */
    it("should replay a repeated send, at a status the contract does not document", async () => {
      const path = `/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`;
      const body = JSON.stringify({
        clientId: "syl:message:00000000-0000-7000-8000-00000000cafe",
        text: "Did the parcel arrive?",
      });

      const first = await syl.api(path, { method: "POST", body, idempotencyKey: "conform-cafe" });
      expect(first.status).toBe(201);

      const replay = await syl.api(path, { method: "POST", body, idempotencyKey: "conform-cafe" });
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      // The body still conforms; only the status is off-contract.
      expect(replay.status).toBe(200);
      expect(operation("sendMessage").successStatus).toBe(201);
    });
  });

  describe("idempotency", () => {
    /**
     * `Idempotency-Key` is `required: true` on every write in the contract,
     * with the reason spelled out next to it: the mobile outbox retries by
     * design and will duplicate without it.
     *
     * `syl-9e0` — `sendMessage` is the one write that never asks. It is the
     * only route that does not go through `routes/idempotency.ts`, so it also
     * cannot answer `IDEMPOTENCY_KEY_REUSE` for a reused key with a different
     * body. `MessageStore` deduping on `clientId` masks the common case, which
     * is why no unit test noticed.
     */
    const NOT_ENFORCING: readonly string[] = ["sendMessage"];

    it("should refuse every declared write that arrives without the header", async () => {
      const bodies: Readonly<Record<string, unknown>> = {
        pairDevice: { pairingCode: "0000-0000", deviceName: "probe" },
        sendMessage: { clientId: "syl:message:probe", text: "probe" },
        createReminder: { text: "probe", wallTime: "09:00", tz: CHICAGO, date: "2099-09-09" },
        registerDevice: { token: APNS_TOKEN, environment: "production", platform: "ios" },
      };

      const accepted: string[] = [];
      for (const spec of specOperations()) {
        if (!spec.requiresAuth) continue;
        if (spec.method === "GET") continue;
        if (UNIMPLEMENTED.includes(spec.operationId)) continue;

        const response = await fetch(`${syl.baseUrl}${fillPath(spec.template, ABSENT_IDS)}`, {
          method: spec.method,
          headers: { "content-type": "application/json", authorization: `Bearer ${syl.token}` },
          body: JSON.stringify(bodies[spec.operationId] ?? {}),
        });
        const body = (await response.json()) as { error?: { code?: string } };

        if (body.error?.code !== "IDEMPOTENCY_KEY_REQUIRED") accepted.push(spec.operationId);
      }

      expect(accepted.sort()).toEqual([...NOT_ENFORCING].sort());
    });

    it("should reject a reused key carrying a different body", async () => {
      const first = await syl.api("/reminders", {
        method: "POST",
        idempotencyKey: "reuse-probe",
        body: JSON.stringify({
          text: "First body.",
          wallTime: "08:00",
          tz: CHICAGO,
          date: "2099-07-08",
        }),
      });
      expect(first.status).toBe(201);

      const reused = await syl.api("/reminders", {
        method: "POST",
        idempotencyKey: "reuse-probe",
        body: JSON.stringify({
          text: "A different body entirely.",
          wallTime: "08:00",
          tz: CHICAGO,
          date: "2099-07-08",
        }),
      });
      await expectConformingFailure(reused, "IDEMPOTENCY_KEY_REUSE");
    });
  });

  describe("reminders", () => {
    let reminder: Reminder;

    it("should conform through the whole lifecycle", async () => {
      reminder = await expectConformingSuccess<Reminder>(
        await syl.api("/reminders", {
          method: "POST",
          body: JSON.stringify({
            text: "Call the pharmacy — the refill lapses today.",
            wallTime: "16:00",
            tz: CHICAGO,
            date: "2099-01-02",
          }),
        }),
        "createReminder",
      );

      await expectConformingSuccess(await syl.api("/reminders"), "listReminders");
      await expectConformingSuccess(
        await syl.api(`/reminders/${encodeURIComponent(reminder.id)}`),
        "getReminder",
      );
      await expectConformingSuccess(
        await syl.api(`/reminders/${encodeURIComponent(reminder.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ text: "Call the pharmacy before it closes." }),
        }),
        "updateReminder",
      );
      await expectConformingSuccess(
        await syl.api(`/reminders/${encodeURIComponent(reminder.id)}/snooze`, {
          method: "POST",
          body: JSON.stringify({ minutes: 30 }),
        }),
        "snoozeReminder",
      );
      await expectConformingSuccess(
        await syl.api(`/reminders/${encodeURIComponent(reminder.id)}/complete`, { method: "POST" }),
        "completeReminder",
      );
    });

    it("should store an IANA zone rather than the offset it resolved to", async () => {
      // Constraint 5, checked on the wire rather than in the store: a response
      // carrying `-05:00` would be correct today and an hour wrong in November.
      const created = await expectConformingSuccess<Reminder>(
        await syl.api("/reminders", {
          method: "POST",
          body: JSON.stringify({
            text: "Winter check.",
            wallTime: "07:00",
            tz: CHICAGO,
            date: "2099-12-02",
          }),
        }),
        "createReminder",
      );

      expect(created.tz).toBe(CHICAGO);
      expect(created.nextFireAt).toMatch(/Z$/u);
      // 07:00 Chicago in December is CST, so 13:00Z. In June it would be 12:00Z.
      expect(created.nextFireAt).toBe("2099-12-02T13:00:00.000Z");
    });

    it("should conform when refusing a deferral that is not later", async () => {
      const created = await expectConformingSuccess<Reminder>(
        await syl.api("/reminders", {
          method: "POST",
          body: JSON.stringify({
            text: "Never move backwards.",
            wallTime: "09:00",
            tz: CHICAGO,
            date: "2099-03-04",
          }),
        }),
        "createReminder",
      );

      const response = await syl.api(`/reminders/${encodeURIComponent(created.id)}/snooze`, {
        method: "POST",
        body: JSON.stringify({ minutes: -10 }),
      });
      // Whichever of the two codes it picks, the envelope is the contract's.
      const body = (await response.clone().json()) as { error?: { code?: string } };
      await expectConformingFailure(response, body.error?.code ?? "VALIDATION_FAILED");
      expect(["VALIDATION_FAILED", "DEFERRAL_NOT_LATER"]).toContain(body.error?.code);
    });

    it("should conform on cancel", async () => {
      const created = await expectConformingSuccess<Reminder>(
        await syl.api("/reminders", {
          method: "POST",
          body: JSON.stringify({
            text: "To be cancelled.",
            wallTime: "10:00",
            tz: CHICAGO,
            date: "2099-05-06",
          }),
        }),
        "createReminder",
      );
      await expectConformingSuccess(
        await syl.api(`/reminders/${encodeURIComponent(created.id)}`, { method: "DELETE" }),
        "cancelReminder",
      );
    });
  });

  describe("devices and deliveries", () => {
    it("should conform on registration, listing and unregistration", async () => {
      const device = await expectConformingSuccess<Device>(
        await syl.api("/devices", {
          method: "POST",
          body: JSON.stringify({
            token: APNS_TOKEN,
            environment: "production",
            platform: "ios",
            name: "Commander's iPhone",
            appVersion: "0.1.0 (14)",
            osVersion: "26.1",
          }),
        }),
        "registerDevice",
      );

      await expectConformingSuccess(await syl.api("/devices"), "listDevices");
      await expectConformingSuccess(
        await syl.api(`/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" }),
        "unregisterDevice",
      );
    });

    it("should conform on an empty outbox page", async () => {
      await expectConformingSuccess<{ items: Delivery[] }>(
        await syl.api("/deliveries"),
        "listDeliveries",
      );
    });

    it("should conform when a delivery is not there", async () => {
      const response = await syl.api(
        `/deliveries/${encodeURIComponent(ABSENT_IDS["deliveryId"] ?? "")}`,
      );
      await expectConformingFailure(response, "NOT_FOUND");
    });
  });

  describe("jobs", () => {
    it("should conform on the job list, one job, its runs, and a run", async () => {
      const page = await expectConformingSuccess<{ items: Job[] }>(
        await syl.api("/jobs"),
        "listJobs",
      );
      // `bootstrap` alone does not define the delivery job — `main` does, when
      // it builds the runtime — so an empty page here is correct and the rest
      // of this test is about the shapes, not the contents.
      const job = page.items[0];
      if (job === undefined) return;

      await expectConformingSuccess(
        await syl.api(`/jobs/${encodeURIComponent(job.id)}`),
        "getJob",
      );
      const runs = await expectConformingSuccess<{ items: Run[] }>(
        await syl.api(`/jobs/${encodeURIComponent(job.id)}/runs`),
        "listJobRuns",
      );
      const run = runs.items[0];
      if (run === undefined) return;
      await expectConformingSuccess(
        await syl.api(`/runs/${encodeURIComponent(run.id)}`),
        "getRun",
      );
    });
  });
});
