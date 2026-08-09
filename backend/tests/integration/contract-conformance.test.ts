import type { Conversation, Delivery, Device, Job, Reminder, Run } from "@syl/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp, NO_ROUTE_MESSAGE } from "../../src/index.js";
import { INTERACTIVE_CONVERSATION_ID } from "../../src/services/database.js";
import {
  expectConformingFailure,
  expectConformingSuccess,
  fillPath,
  mountedRoutes,
  operation,
  specOperations,
} from "../helpers/contract.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";
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
 * A **finding, not a configuration**, and it is empty. `syl-c1m` held nine
 * here: the mock served all nine because it reads the spec, Syl served none of
 * them because someone had to write the router, and both clients were built
 * against the difference. `/todos`, `/goals` and `/sync` are implemented now.
 *
 * The test below asserts this set **exactly**, in both directions: landing one
 * of these routes turns the suite red until its name is removed, and
 * publishing an operation nobody implemented turns it red immediately.
 */
const UNIMPLEMENTED: readonly string[] = [];

/**
 * Routes the service dispatches that the contract does not publish.
 *
 * Also a finding, and the mirror of the one above. `syl-21u`: article intake
 * is mounted and undeclared, so no generated client can reach it and no
 * fixture pins its shapes. Less dangerous than the reverse — nothing was built
 * against an illusion — but it is still a contract that does not describe the
 * service, and it is listed here so it is visible on every run rather than
 * only in a bead.
 */
const UNDECLARED: readonly string[] = ["GET /intake/{sourceId}", "POST /intake"];

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
     * The anti-divergence guard, and the deliverable of `syl-c1m`.
     *
     * Every operation in `openapi.yaml` is probed against the running service
     * and must be **routed**. The discriminator is the terminal 404's exact
     * message, imported from the service rather than written here: an
     * unmounted path is the only thing that reaches `notFound`, and a test
     * asserting on prose it authored itself proves nothing about the service.
     *
     * Authenticated operations are probed **without** a token, so the answer
     * cannot depend on whether a resource exists — this is a routing check,
     * not a fixture check. Unauthenticated ones are probed too. The previous
     * version of this loop skipped them (`if (!spec.requiresAuth) continue`),
     * which meant a published-but-unimplemented `GET /health` or
     * `POST /auth/pair` would have sailed through; `syl-ux1` was exactly that
     * blind spot in the neighbouring idempotency probe, so it is not a
     * hypothetical.
     */
    it("should route every operation the contract publishes, or else name it in UNIMPLEMENTED", async () => {
      const unroutable: string[] = [];
      const probed: string[] = [];

      for (const spec of specOperations()) {
        probed.push(spec.operationId);
        const response = await syl.api(fillPath(spec.template, ABSENT_IDS), {
          method: spec.method,
          anonymous: spec.requiresAuth,
          ...(spec.method === "GET" || spec.method === "DELETE"
            ? {}
            : { body: JSON.stringify({}) }),
        });
        const body = (await response.json()) as { error?: { message?: string } };

        if (body.error?.message === NO_ROUTE_MESSAGE) unroutable.push(spec.operationId);
      }

      // The loop is only worth its assertion if it ran. A `specOperations()`
      // that returned nothing — a moved `paths` key, a parse that silently
      // failed — would make every check in this file vacuously green.
      expect(probed.length).toBe(specOperations().length);
      expect(probed.length).toBeGreaterThan(20);
      expect(probed).toContain("getHealth");
      expect(probed).toContain("pairDevice");
      expect(probed).toContain("syncSinceCursor");

      expect(unroutable.sort()).toEqual([...UNIMPLEMENTED].sort());
    });

    /**
     * The same question, asked backwards.
     *
     * A guard that only walks the spec is blind to the other divergence: an
     * endpoint the service dispatches that no client can know about. Syl has
     * two (`syl-21u`), and they are named in `UNDECLARED` so they are visible
     * on every run.
     */
    it("should dispatch nothing the contract does not publish, or else name it in UNDECLARED", () => {
      const database = testDatabase();
      try {
        const app = createApp(testConfig(), testDeps(database));
        const declared = new Set(
          specOperations().map((spec) => `${spec.method} ${spec.template}`),
        );
        const served = mountedRoutes(app);

        // `mountedRoutes` throws on an empty walk, and this pins the count so
        // an introspection change that finds one layer instead of thirty
        // cannot pass either.
        expect(served.length).toBeGreaterThanOrEqual(declared.size);

        expect(served.filter((route) => !declared.has(route)).sort()).toEqual(
          [...UNDECLARED].sort(),
        );
      } finally {
        database.close();
      }
    });

    it("should answer a path the contract has never published with the terminal 404", async () => {
      // How the seam actually presents to a client: not a typed refusal from a
      // route, but the catch-all saying nothing here matches. This is also the
      // control for the guard above — it proves `NO_ROUTE_MESSAGE` is a
      // reachable answer, so "no operation produced it" is a real result and
      // not a string that never appears.
      const response = await syl.api("/todos/not-an-id/reassign");
      const error = await expectConformingFailure(response, "NOT_FOUND");

      expect(response.status).toBe(404);
      expect(error["message"]).toBe(NO_ROUTE_MESSAGE);
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
     * `syl-9e0` — the replay used to answer 200, and 201 is the only success
     * status the contract documents for `sendMessage`.
     *
     * `backend/src/routes/idempotency.ts` — which every other write route goes
     * through — argued the opposite case in its own doc comment: *"A replayed
     * request answers with the stored status, not a fresh one. A client that
     * got a 201 the first time and a 200 the second has to reconcile two
     * different answers to one operation."* Two files in one service disagreed,
     * and the contract sided with the one this route did not use. It uses it
     * now, so the disagreement is gone and this asserts the resolution.
     */
    it("should replay a repeated send at the status the contract documents", async () => {
      const path = `/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`;
      const body = JSON.stringify({
        clientId: "syl:message:00000000-0000-7000-8000-00000000cafe",
        text: "Did the parcel arrive?",
      });

      const first = await syl.api(path, { method: "POST", body, idempotencyKey: "conform-cafe" });
      expect(first.status).toBe(201);

      const replay = await syl.api(path, { method: "POST", body, idempotencyKey: "conform-cafe" });
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(replay.status).toBe(operation("sendMessage").successStatus);
      await expectConformingSuccess(replay, "sendMessage");
    });
  });

  describe("idempotency", () => {
    /**
     * `Idempotency-Key` is `required: true` on every write in the contract,
     * with the reason spelled out next to it: the mobile outbox retries by
     * design and will duplicate without it.
     *
     * The list is empty and must stay empty. `syl-ux1` — two writes used to
     * ignore the header, and this probe saw neither of them. `sendMessage` was
     * listed as a known exception; `pairDevice` was not even reached, because
     * the loop skipped every operation declaring `security: []` and pairing is
     * the one write that must be unauthenticated. The endpoint with no recovery
     * path — the pairing code is consumed on use and cannot be reissued — was
     * the endpoint the guard could not see.
     */
    const NOT_ENFORCING: readonly string[] = [];

    it("should refuse every declared write that arrives without the header", async () => {
      const bodies: Readonly<Record<string, unknown>> = {
        pairDevice: { pairingCode: "0000-0000", deviceName: "probe" },
        sendMessage: { clientId: "syl:message:probe", text: "probe" },
        createReminder: { text: "probe", wallTime: "09:00", tz: CHICAGO, date: "2099-09-09" },
        registerDevice: { token: APNS_TOKEN, environment: "production", platform: "ios" },
      };

      const probed: string[] = [];
      const accepted: string[] = [];
      for (const spec of specOperations()) {
        if (spec.method === "GET") continue;
        if (UNIMPLEMENTED.includes(spec.operationId)) continue;
        probed.push(spec.operationId);

        const response = await fetch(`${syl.baseUrl}${fillPath(spec.template, ABSENT_IDS)}`, {
          method: spec.method,
          headers: {
            "content-type": "application/json",
            // Unauthenticated writes get no token, and must still be probed:
            // an operation skipped for declaring `security: []` is an
            // operation this guard is blind to.
            ...(spec.requiresAuth ? { authorization: `Bearer ${syl.token}` } : {}),
          },
          body: JSON.stringify(bodies[spec.operationId] ?? {}),
        });
        const body = (await response.json()) as { error?: { code?: string } };

        if (body.error?.code !== "IDEMPOTENCY_KEY_REQUIRED") accepted.push(spec.operationId);
      }

      expect(probed).toContain("pairDevice");
      expect(probed).toContain("sendMessage");
      expect(accepted.sort()).toEqual([...NOT_ENFORCING].sort());
    });

    it("should replay a pairing whose response was lost rather than burning the code", async () => {
      // `syl-ux1`, on the live service. The pairing code is consumed on use and
      // there is no endpoint to reissue one, so this retry used to answer 401
      // and leave the device permanently unpairable.
      const body = JSON.stringify({
        pairingCode: syl.deps.keys.issuePairingCode().code,
        deviceName: "A device with a flaky tunnel",
      });
      const send = async (): Promise<Response> =>
        fetch(`${syl.baseUrl}/auth/pair`, {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": "conform-pair" },
          body,
        });

      const first = await send();
      const granted = await expectConformingSuccess<{ token: string }>(first, "pairDevice");

      const retry = await send();
      expect(retry.headers.get("idempotency-replayed")).toBe("true");
      const replayed = await expectConformingSuccess<{ token: string }>(retry, "pairDevice");
      expect(replayed.token).toBe(granted.token);
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

  describe("todos and goals", () => {
    it("should conform through the whole to-do lifecycle", async () => {
      const goal = await expectConformingSuccess<{ id: string }>(
        await syl.api("/goals", {
          method: "POST",
          body: JSON.stringify({
            title: "Stop carrying the household in his head",
            why: "Because that is the thing Syl is for.",
            targetDate: "2026-12-31",
            cadenceDays: 7,
          }),
        }),
        "createGoal",
      );

      await expectConformingSuccess(await syl.api("/goals"), "listGoals");
      await expectConformingSuccess(
        await syl.api(`/goals/${encodeURIComponent(goal.id)}`),
        "getGoal",
      );

      const todo = await expectConformingSuccess<{ id: string }>(
        await syl.api("/todos", {
          method: "POST",
          body: JSON.stringify({
            text: "Renew the passport before the trip.",
            goalId: goal.id,
            dueAt: "2026-11-01T12:00:00.000Z",
            pinned: true,
          }),
        }),
        "createTodo",
      );

      await expectConformingSuccess(await syl.api("/todos"), "listTodos");
      await expectConformingSuccess(
        await syl.api(`/todos/${encodeURIComponent(todo.id)}`),
        "getTodo",
      );
      await expectConformingSuccess(
        await syl.api(`/todos/${encodeURIComponent(todo.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ text: "Renew the passport this week." }),
        }),
        "updateTodo",
      );
      await expectConformingSuccess(
        await syl.api(`/todos/${encodeURIComponent(todo.id)}/complete`, { method: "POST" }),
        "completeTodo",
      );
    });

    it("should conform when refusing a to-do linked to a goal that is not there", async () => {
      const response = await syl.api("/todos", {
        method: "POST",
        body: JSON.stringify({ text: "Linked to nowhere", goalId: ABSENT_IDS["goalId"] }),
      });
      await expectConformingFailure(response, "VALIDATION_FAILED");
    });

    it("should conform when a to-do is not there", async () => {
      const response = await syl.api(`/todos/${encodeURIComponent(ABSENT_IDS["todoId"] ?? "")}`);
      await expectConformingFailure(response, "NOT_FOUND");
    });
  });

  describe("sync", () => {
    it("should conform on a bootstrap and on a follow-up page", async () => {
      const first = await expectConformingSuccess<{ cursor: string }>(
        await syl.api("/sync"),
        "syncSinceCursor",
      );
      await expectConformingSuccess(
        await syl.api(`/sync?since=${encodeURIComponent(first.cursor)}&limit=10&types=todo`),
        "syncSinceCursor",
      );
    });

    it("should conform when refusing a cursor it did not issue", async () => {
      // The refusal that matters: a bad cursor read as "start over" or "start
      // from now" is a device that silently re-downloads or silently skips.
      const response = await syl.api("/sync?since=not-a-cursor");
      await expectConformingFailure(response, "VALIDATION_FAILED");
    });

    it("should hand back a cursor that walks forward over a real write", async () => {
      const before = await expectConformingSuccess<{ cursor: string }>(
        await syl.api("/sync"),
        "syncSinceCursor",
      );
      const todo = await expectConformingSuccess<{ id: string }>(
        await syl.api("/todos", {
          method: "POST",
          body: JSON.stringify({ text: "Something the phone should learn about." }),
        }),
        "createTodo",
      );

      const after = await expectConformingSuccess<{
        changes: { id: string; op: string; resource: Record<string, unknown> | null }[];
      }>(
        await syl.api(`/sync?since=${encodeURIComponent(before.cursor)}`),
        "syncSinceCursor",
      );

      const change = after.changes.find((candidate) => candidate.id === todo.id);
      expect(change?.op).toBe("upsert");
      expect(change?.resource?.["text"]).toBe("Something the phone should learn about.");
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
