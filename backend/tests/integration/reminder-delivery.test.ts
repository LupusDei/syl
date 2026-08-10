import { generateKeyPairSync } from "node:crypto";

import type { ApiError, Delivery, Device, Reminder, Run, RunPage } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createReminderDeliveryHandler,
  defineReminderDeliveryJob,
} from "../../src/jobs/reminder-delivery-job.js";
import { createApp, syncResolvers } from "../../src/index.js";
import { IntakeStore } from "../../src/connections/intake-store.js";
import { ArticleIntake } from "../../src/connections/intake.js";
import { ApnsClient } from "../../src/services/apns-service.js";
import { DeviceTokenService } from "../../src/services/device-token-service.js";
import { GoalService } from "../../src/services/goal-service.js";
import { IdempotencyStore } from "../../src/services/idempotency.js";
import { JobRunner, type JobHandler, type Timers } from "../../src/services/job-runner.js";
import { JobStore } from "../../src/services/job-store.js";
import { MessageStore } from "../../src/services/message-store.js";
import { Outbox } from "../../src/services/outbox.js";
import { ReminderService } from "../../src/services/reminder-service.js";
import { SyncService } from "../../src/services/sync-service.js";
import { TodoService } from "../../src/services/todo-service.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startFakeApns, type FakeApns } from "../helpers/fake-apns.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testChat, testConfig, testDatabase, testKeys, testMemory } from "../helpers/service.js";

/**
 * `syl-002.5.1` — the end-to-end proof, and the point of the whole feature.
 *
 * A reminder set through the API fires at the correct wall-clock instant,
 * arrives as a time-sensitive push, is acknowledged by the device, and is
 * marked delivered. Everything below the HTTP boundary is the real thing: a
 * migrated SQLite database, the real job runner, the real outbox, and the real
 * APNs client speaking real HTTP/2 to a server standing in for Apple.
 *
 * Two things are asserted that no unit test can assert:
 *
 * 1. **Nothing in the delivery path spawns a subprocess.** `node:child_process`
 *    is replaced for this file, and any `spawn` fails the run. That is the
 *    property the guarantee rests on — a delivery path with a model in it
 *    inherits every failure mode the model has — and it is only checkable from
 *    outside, across every module the path touches.
 * 2. **The device's acknowledgement travels the whole way round.** The delivery
 *    id is read out of the notification body the fake Apple received, exactly
 *    as the phone would read it, and posted back to the ack endpoint. Nothing
 *    in the test knows that id by any other route.
 */

const { spawnCalls } = vi.hoisted(() => ({ spawnCalls: [] as unknown[][] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      spawnCalls.push(args);
      throw new Error("The delivery path must never spawn a subprocess.");
    },
  };
});

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

const CHICAGO = "America/Chicago";
const TOKEN = "9c0d2e41".repeat(8);

/** 2026-08-09T12:00Z — 07:00 in Chicago, well outside quiet hours. */
const MORNING = Date.UTC(2026, 7, 9, 12, 0, 0, 0);
/** 16:00 in Chicago on the same day, which is the reminder's instant. */
const FIRE_AT = "2026-08-09T21:00:00.000Z";

/** A timer the test drives by hand, so no wall-clock second is ever spent. */
const inertTimers: Timers = { set: () => 0, clear: () => undefined };

describe("syl-002.5.1 — a reminder reaches the Commander", () => {
  let db: SylDatabase;
  let now: number;
  let running: RunningApp;
  let apple: FakeApns;
  let apns: ApnsClient;
  let runner: JobRunner;
  let outbox: Outbox;
  let reminders: ReminderService;
  let jobs: JobStore;
  let token: string;
  let keyCounter = 0;

  beforeEach(async () => {
    spawnCalls.length = 0;
    db = testDatabase();
    now = MORNING;
    keyCounter = 0;

    const clock = (): number => now;
    apple = await startFakeApns();

    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    apns = new ApnsClient({
      credentials: {
        keyId: "ABCD123456",
        teamId: "TEAM123456",
        bundleId: "com.jmm.syl",
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      },
      origins: { production: apple.origin, sandbox: apple.origin },
      clock,
    });

    const devices = new DeviceTokenService({ db: db.handle, clock });
    outbox = new Outbox({
      db: db.handle,
      clock,
      quietHours: { quiet: { start: "22:00", end: "08:00" }, tz: CHICAGO },
    });
    reminders = new ReminderService({ db: db.handle, clock });
    jobs = new JobStore({ db: db.handle, clock });
    const keys = testKeys(db, { clock });
    const messages = new MessageStore({ db: db.handle, clock });
    const todos = new TodoService({ db: db.handle, clock });
    const goals = new GoalService({ db: db.handle, clock });

    running = await startTestApp(
      createApp(testConfig(), {
        keys,
        messages,
        chat: testChat(messages),
        devices,
        outbox,
        reminders,
        todos,
        goals,
        sync: new SyncService({
          db: db.handle,
          clock,
          resolvers: syncResolvers({ messages, reminders, todos, goals, devices, outbox, jobs }),
        }),
        jobs,
        idempotency: new IdempotencyStore({ db: db.handle, clock }),
        intake: new ArticleIntake({ store: new IntakeStore({ db: db.handle, clock }), clock }),
        memory: testMemory(db, clock),
      }),
    );
    token = keys.pair(keys.issuePairingCode().code, "Commander's iPhone").token;

    // Due from the moment the service booted, which here is "before any of
    // this". The job reschedules itself to the next real instant after every
    // pass, so its first one only has to be early enough not to hold anything
    // up.
    defineReminderDeliveryJob(jobs, new Date(now - 24 * 60 * 60_000).toISOString());
    const handler: JobHandler = createReminderDeliveryHandler({
      reminders,
      outbox,
      devices,
      apns,
    });

    runner = new JobRunner({
      store: jobs,
      handlers: new Map([["reminder_delivery", handler]]),
      clock,
      timers: inertTimers,
      owner: "proof",
    });
  });

  afterEach(async () => {
    runner.stop();
    await running.close();
    await apns.close();
    await apple.close();
    db.close();
  });

  async function api(
    path: string,
    init: RequestInit & { readonly idempotencyKey?: string } = {},
  ): Promise<Response> {
    const { idempotencyKey, ...rest } = init;
    keyCounter += 1;
    return fetch(`${running.baseUrl}/api/v1${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "Idempotency-Key": idempotencyKey ?? `proof-${keyCounter}`,
        ...(rest.headers ?? {}),
      },
    });
  }

  async function registerDevice(): Promise<Device> {
    const response = await api("/devices", {
      method: "POST",
      body: JSON.stringify({
        token: TOKEN,
        environment: "production",
        platform: "ios",
        name: "Commander's iPhone",
        appVersion: "0.1.0 (14)",
        osVersion: "26.1",
      }),
    });
    const body = (await response.json()) as Envelope<Device>;
    if (body.data === undefined) throw new Error("device registration failed");
    return body.data;
  }

  async function setReminder(overrides: Record<string, unknown> = {}): Promise<Reminder> {
    const response = await api("/reminders", {
      method: "POST",
      body: JSON.stringify({
        text: "Call the pharmacy — the refill lapses today.",
        wallTime: "16:00",
        tz: CHICAGO,
        date: "2026-08-09",
        ...overrides,
      }),
    });
    const body = (await response.json()) as Envelope<Reminder>;
    if (body.data === undefined) throw new Error(`reminder failed: ${JSON.stringify(body)}`);
    return body.data;
  }

  /** Read the `aps` dictionary out of what the fake Apple received. */
  function pushBody(index = 0): Record<string, unknown> {
    const push = apple.pushes[index];
    if (push === undefined) throw new Error("Apple received no such notification");
    return push.body as Record<string, unknown>;
  }

  function aps(index = 0): Record<string, unknown> {
    return pushBody(index)["aps"] as Record<string, unknown>;
  }

  it("should fire at the wall-clock instant, arrive time-sensitive, and be marked delivered only on the ack", async () => {
    await registerDevice();
    const reminder = await setReminder();

    // The reminder resolves 16:00 America/Chicago to a real instant, from a
    // wall time and a zone rather than from a stored offset.
    expect(reminder.nextFireAt).toBe(FIRE_AT);

    // --- Before the instant: nothing happens. -----------------------------
    now = Date.parse(FIRE_AT) - 1;
    await runner.start();
    expect(apple.pushes).toHaveLength(0);
    expect(outbox.list().items).toHaveLength(0);

    // --- At the instant: exactly one push. --------------------------------
    now = Date.parse(FIRE_AT);
    await runner.tick();

    expect(apple.pushes).toHaveLength(1);
    const push = apple.pushes[0];
    expect(push?.path).toBe(`/3/device/${TOKEN}`);
    expect(push?.headers["apns-topic"]).toBe("com.jmm.syl");
    // alert + priority 10 is the only combination that is neither throttled
    // against a battery budget nor dropped in Low Power Mode.
    expect(push?.headers["apns-push-type"]).toBe("alert");
    expect(push?.headers["apns-priority"]).toBe("10");
    expect(push?.authorization).toMatch(/^bearer /);

    // Time-sensitive: it breaks through Focus and the Scheduled Summary.
    expect(aps()["interruption-level"]).toBe("time-sensitive");
    // Self-sufficient: the text itself travels, never an id to fetch. Push
    // reaches the phone over Apple's network, which does not touch the tailnet.
    expect(aps()["alert"]).toEqual({
      title: "Syl",
      body: "Call the pharmacy — the refill lapses today.",
    });

    // --- The outbox row: accepted, not yet delivered. ----------------------
    const afterPush = outbox.list().items;
    expect(afterPush).toHaveLength(1);
    const delivery = afterPush[0];
    expect(delivery?.state).toBe("delivered");
    expect(delivery?.deliveredAt).toBe(FIRE_AT);
    expect(delivery?.ackedAt).toBeNull();
    expect(delivery?.late).toBe(false);

    // The delivery id is read out of the notification exactly as the phone
    // would read it. Nothing here knows it by any other route.
    const deliveryId = pushBody()["deliveryId"];
    expect(deliveryId).toBe(delivery?.id);

    // --- The device acknowledges. ------------------------------------------
    const ack = await api(`/deliveries/${String(deliveryId)}/ack`, {
      method: "POST",
      body: JSON.stringify({ ackedAt: "2026-08-09T21:00:07.220Z", engagement: "opened" }),
    });
    const acked = (await ack.json()) as Envelope<Delivery>;

    expect(ack.status).toBe(200);
    expect(acked.data?.state).toBe("acknowledged");
    expect(acked.data?.ackedAt).toBe("2026-08-09T21:00:07.220Z");

    // --- And the reminder is closed by the acknowledgement, not the push. --
    const after = (await (await api(`/reminders/${reminder.id}`)).json()) as Envelope<Reminder>;
    expect(after.data?.deliveryState).toBe("acknowledged");

    // --- Zero turns, zero cost, no subprocess. -----------------------------
    const runs = (await (
      await api(`/jobs/${jobs.list().items[0]?.id ?? ""}/runs`)
    ).json()) as Envelope<RunPage>;
    const spoke = runs.data?.items.find((run: Run) => run.spoke === true);
    expect(spoke?.turns).toBe(0);
    expect(spoke?.costUsd).toBe(0);
    expect(spoke?.summary).toBeNull();
    expect(spawnCalls).toHaveLength(0);
  });

  it("should not fire twice when the runner ticks again", async () => {
    await registerDevice();
    await setReminder();

    now = Date.parse(FIRE_AT);
    await runner.start();
    await runner.tick();
    await runner.tick();

    // The outbox key is derived from the occurrence, so a second pass joins
    // the existing row rather than writing a second notification.
    expect(apple.pushes).toHaveLength(1);
    expect(outbox.list().items).toHaveLength(1);
  });

  it("should fire late and say so after the machine has slept and woken", async () => {
    // The scenario the bead names: the instant passes while nothing is
    // running, and the reminder is neither dropped nor pretends to be on time.
    await registerDevice();
    const reminder = await setReminder();

    now = MORNING;
    await runner.start();
    expect(apple.pushes).toHaveLength(0);

    // Asleep for eleven hours. No ticks happen at all in between.
    now = Date.parse(FIRE_AT) + 5 * 60 * 60_000;
    await runner.tick();

    expect(apple.pushes).toHaveLength(1);
    const delivery = outbox.list().items[0];
    expect(delivery?.late).toBe(true);
    expect(delivery?.scheduledFor).toBe(FIRE_AT);
    expect(reminders.get(reminder.id)?.late).toBe(true);

    const run = jobs.listRuns().items.find((candidate) => candidate.spoke);
    expect(run?.latenessMs).toBeGreaterThan(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it("should hold an overnight batch until the window lifts, as one notification", async () => {
    // deferPastQuietHours collapses everything in the window onto the same
    // instant. Ten reminders would otherwise arrive as ten notifications in
    // one second — correct by the letter of the guarantee, awful in practice.
    await registerDevice();
    for (const text of ["The parcel is out for delivery.", "Priya replied.", "Rent cleared."]) {
      await setReminder({ text, wallTime: "23:00", date: "2026-08-08" });
    }

    // 23:30 in Chicago on the 8th, deep inside quiet hours.
    now = Date.UTC(2026, 7, 9, 4, 30);
    await runner.start();

    // The batch is in the outbox and Apple has heard nothing.
    expect(apple.pushes).toHaveLength(0);
    const held = outbox.list().items;
    expect(held).toHaveLength(1);
    expect(held[0]?.coalescedReminderIds).toHaveLength(3);
    expect(held[0]?.nextAttemptAt).toBe("2026-08-09T13:00:00.000Z");

    // 08:00 in Chicago. The window lifts.
    now = Date.UTC(2026, 7, 9, 13, 0);
    await runner.tick();

    expect(apple.pushes).toHaveLength(1);
    expect(aps()["alert"]).toEqual({
      title: "Syl",
      body: "Three things came in overnight. They're in the app when you're ready.",
    });
    // Deliberately not time-sensitive: breaking through Focus to report a
    // quiet night is the noise this exists to stop.
    expect(aps()["interruption-level"]).toBe("active");

    // Acknowledging the digest closes every reminder inside it.
    const deliveryId = String(pushBody()["deliveryId"]);
    await api(`/deliveries/${deliveryId}/ack`, {
      method: "POST",
      body: JSON.stringify({ ackedAt: "2026-08-09T13:00:09.000Z" }),
    });

    for (const id of held[0]?.coalescedReminderIds ?? []) {
      expect(reminders.get(id)?.deliveryState).toBe("acknowledged");
    }
    expect(spawnCalls).toHaveLength(0);
  });

  it("should survive Apple being unreachable and deliver on the retry", async () => {
    await registerDevice();
    await setReminder();

    apple.reply({ status: 503, reason: "ServiceUnavailable" });
    now = Date.parse(FIRE_AT);
    await runner.start();

    const failed = outbox.list().items[0];
    expect(failed?.state).toBe("pending");
    expect(failed?.lastError).toContain("503");
    expect(failed?.nextAttemptAt).not.toBeNull();

    // The row is still here, which is the whole point. When the backoff
    // expires it goes again, and this time Apple takes it.
    now = Date.parse(failed?.nextAttemptAt ?? "");
    await runner.tick();

    expect(apple.pushes).toHaveLength(2);
    expect(outbox.get(failed?.id ?? "")?.state).toBe("delivered");
    expect(spawnCalls).toHaveLength(0);
  });

  it("should unregister a dead token and keep the reminder waiting", async () => {
    await registerDevice();
    await setReminder();

    apple.reply({ status: 410, reason: "Unregistered" });
    now = Date.parse(FIRE_AT);
    await runner.start();

    // The token is gone, but the reminder is not: the phone re-registering is
    // exactly the case the outbox exists to survive.
    const listed = (await (await api("/devices")).json()) as Envelope<{ items: Device[] }>;
    expect(listed.data?.items[0]?.active).toBe(false);
    expect(outbox.list().items[0]?.state).toBe("pending");

    await registerDevice();
    now = Date.parse(outbox.list().items[0]?.nextAttemptAt ?? "");
    await runner.tick();

    expect(outbox.list().items[0]?.state).toBe("delivered");
  });

  it("should still hold the reminder when no device has ever registered", async () => {
    await setReminder();

    now = Date.parse(FIRE_AT);
    await runner.start();

    expect(apple.pushes).toHaveLength(0);
    const held = outbox.list().items[0];
    expect(held?.state).toBe("pending");
    expect(held?.lastError).toContain("No device");
    // Not dropped, not failed — waiting. The app's foreground reconcile finds
    // it whether or not push ever worked.
    expect(outbox.list({ unacknowledged: true }).items).toHaveLength(1);
  });
});
