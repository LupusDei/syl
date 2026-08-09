import type { ApiError, Reminder, ReminderPage } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../../src/index.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { TEST_NOW, testConfig, testDatabase, testDeps } from "../helpers/service.js";

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let token: string;
let keyCounter = 0;

beforeEach(async () => {
  db = testDatabase();
  deps = testDeps(db);
  running = await startTestApp(createApp(testConfig(), deps));
  token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
  keyCounter = 0;
});

afterEach(async () => {
  await running.close();
  db.close();
});

async function api(
  path: string,
  init: RequestInit & { readonly anonymous?: boolean; readonly idempotencyKey?: string | null } = {},
): Promise<Response> {
  const { anonymous, idempotencyKey, ...rest } = init;
  keyCounter += 1;
  const key = idempotencyKey === undefined ? `key-${keyCounter}` : idempotencyKey;

  return fetch(`${running.baseUrl}/api/v1${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(anonymous === true ? {} : { authorization: `Bearer ${token}` }),
      ...(key === null ? {} : { "Idempotency-Key": key }),
      ...(rest.headers ?? {}),
    },
  });
}

function creation(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    text: "Call the pharmacy — the refill lapses today.",
    wallTime: "16:00",
    tz: "America/Chicago",
    date: "2026-08-09",
    ...overrides,
  });
}

async function create(overrides: Record<string, unknown> = {}): Promise<Reminder> {
  const response = await api("/reminders", { method: "POST", body: creation(overrides) });
  const body = (await response.json()) as Envelope<Reminder>;
  if (body.data === undefined) throw new Error(`create failed: ${JSON.stringify(body)}`);
  return body.data;
}

describe("POST /api/v1/reminders", () => {
  it("should create a reminder at the requested wall clock", async () => {
    const response = await api("/reminders", { method: "POST", body: creation() });
    const body = (await response.json()) as Envelope<Reminder>;

    expect(response.status).toBe(201);
    expect(body.data?.nextFireAt).toBe("2026-08-09T21:00:00.000Z");
    expect(body.data?.deliveryState).toBe("scheduled");
    expect(body.data?.wallTime).toBe("16:00");
    expect(body.data?.tz).toBe("America/Chicago");
  });

  it("should keep the text exactly as it arrived", async () => {
    // Delivery reads this verbatim. Nothing downstream will improve it.
    const reminder = await create();
    expect(reminder.text).toBe("Call the pharmacy — the refill lapses today.");
  });

  it("should refuse an rrule outside the supported subset", async () => {
    const response = await api("/reminders", {
      method: "POST",
      body: creation({ date: null, rrule: "FREQ=HOURLY" }),
    });
    const body = (await response.json()) as Envelope<Reminder>;

    expect(response.status).toBe(422);
    expect(body.error?.code).toBe("RRULE_UNSUPPORTED");
  });

  it("should refuse a fixed UTC offset in place of a zone", async () => {
    const response = await api("/reminders", { method: "POST", body: creation({ tz: "-05:00" }) });
    expect(response.status).toBe(400);
  });

  it("should refuse a reminder with no time at all", async () => {
    const response = await api("/reminders", {
      method: "POST",
      body: creation({ date: null, rrule: null }),
    });
    expect(response.status).toBe(400);
  });

  it("should require an Idempotency-Key", async () => {
    const response = await api("/reminders", {
      method: "POST",
      body: creation(),
      idempotencyKey: null,
    });
    expect(((await response.json()) as Envelope<Reminder>).error?.code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  });

  it("should replay a retried creation rather than making two reminders", async () => {
    await api("/reminders", { method: "POST", body: creation(), idempotencyKey: "same" });
    const again = await api("/reminders", {
      method: "POST",
      body: creation(),
      idempotencyKey: "same",
    });

    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    const listed = (await (await api("/reminders")).json()) as Envelope<ReminderPage>;
    expect(listed.data?.items).toHaveLength(1);
  });

  it("should require authentication", async () => {
    const response = await api("/reminders", {
      method: "POST",
      body: creation(),
      anonymous: true,
    });
    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/reminders", () => {
  it("should page and filter", async () => {
    await create();
    const second = await create({ text: "Second." });
    await api(`/reminders/${second.id}`, { method: "DELETE" });

    const cancelled = (await (
      await api("/reminders?state=cancelled")
    ).json()) as Envelope<ReminderPage>;
    expect(cancelled.data?.items).toHaveLength(1);

    const page = (await (await api("/reminders?limit=1")).json()) as Envelope<ReminderPage>;
    expect(page.data?.items).toHaveLength(1);
    expect(page.data?.hasMore).toBe(true);
  });

  it("should filter by when it is next due", async () => {
    await create();
    const early = (await (
      await api("/reminders?dueBefore=2026-08-09T20:00:00.000Z")
    ).json()) as Envelope<ReminderPage>;
    expect(early.data?.items).toHaveLength(0);
  });

  it("should refuse a state the contract does not define", async () => {
    expect((await api("/reminders?state=pondering")).status).toBe(400);
  });

  it("should refuse a cursor it did not issue", async () => {
    expect((await api("/reminders?cursor=nope")).status).toBe(400);
  });
});

describe("GET /api/v1/reminders/{reminderId}", () => {
  it("should return the reminder", async () => {
    const reminder = await create();
    const body = (await (await api(`/reminders/${reminder.id}`)).json()) as Envelope<Reminder>;
    expect(body.data?.id).toBe(reminder.id);
  });

  it("should answer 404 for an id it does not have", async () => {
    expect((await api("/reminders/syl:reminder:00000000-0000-7000-8000-0000000000ff")).status).toBe(
      404,
    );
    expect((await api("/reminders/nonsense")).status).toBe(404);
  });
});

describe("PATCH /api/v1/reminders/{reminderId}", () => {
  it("should change the text without moving the reminder", async () => {
    const reminder = await create();
    const response = await api(`/reminders/${reminder.id}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "Pharmacy closes at 18:00." }),
    });
    const body = (await response.json()) as Envelope<Reminder>;

    expect(body.data?.text).toBe("Pharmacy closes at 18:00.");
    expect(body.data?.nextFireAt).toBe(reminder.nextFireAt);
  });

  it("should recompute the instant when the wall time moves", async () => {
    const reminder = await create();
    const body = (await (
      await api(`/reminders/${reminder.id}`, {
        method: "PATCH",
        body: JSON.stringify({ wallTime: "18:00" }),
      })
    ).json()) as Envelope<Reminder>;
    expect(body.data?.nextFireAt).toBe("2026-08-09T23:00:00.000Z");
  });

  it("should refuse an unsupported rule", async () => {
    const reminder = await create();
    const response = await api(`/reminders/${reminder.id}`, {
      method: "PATCH",
      body: JSON.stringify({ rrule: "FREQ=MINUTELY" }),
    });
    expect(response.status).toBe(422);
  });

  it("should answer 404 for a reminder it does not have", async () => {
    const response = await api("/reminders/syl:reminder:00000000-0000-7000-8000-0000000000ff", {
      method: "PATCH",
      body: JSON.stringify({ text: "x" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/v1/reminders/{reminderId}/snooze", () => {
  it("should defer to a strictly later instant", async () => {
    const reminder = await create();
    const response = await api(`/reminders/${reminder.id}/snooze`, {
      method: "POST",
      body: JSON.stringify({ minutes: 15 }),
    });
    const body = (await response.json()) as Envelope<Reminder>;

    expect(response.status).toBe(200);
    expect(body.data?.deliveryState).toBe("deferred");
    expect(body.data?.deferredFrom).toBe(reminder.nextFireAt);
    expect(Date.parse(body.data?.nextFireAt ?? "")).toBeGreaterThan(
      Date.parse(reminder.nextFireAt),
    );
  });

  it("should refuse a deferral that does not move forward", async () => {
    // The one outcome the project forbids is a deferral that drops a reminder.
    const reminder = await create();
    const response = await api(`/reminders/${reminder.id}/snooze`, {
      method: "POST",
      body: JSON.stringify({ until: reminder.nextFireAt }),
    });
    const body = (await response.json()) as Envelope<Reminder>;

    expect(response.status).toBe(422);
    expect(body.error?.code).toBe("DEFERRAL_NOT_LATER");
  });

  it("should refuse an earlier instant", async () => {
    const reminder = await create();
    const response = await api(`/reminders/${reminder.id}/snooze`, {
      method: "POST",
      body: JSON.stringify({ until: "2026-08-09T13:00:00.000Z" }),
    });
    expect(((await response.json()) as Envelope<Reminder>).error?.code).toBe("DEFERRAL_NOT_LATER");
  });

  it("should refuse both until and minutes at once", async () => {
    const reminder = await create();
    const response = await api(`/reminders/${reminder.id}/snooze`, {
      method: "POST",
      body: JSON.stringify({ until: "2026-08-10T21:00:00.000Z", minutes: 15 }),
    });
    expect(response.status).toBe(400);
  });

  it("should refuse a body that names neither", async () => {
    const reminder = await create();
    const response = await api(`/reminders/${reminder.id}/snooze`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("should refuse fields of the wrong type", async () => {
    const reminder = await create();
    expect(
      (
        await api(`/reminders/${reminder.id}/snooze`, {
          method: "POST",
          body: JSON.stringify({ minutes: "fifteen" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(`/reminders/${reminder.id}/snooze`, {
          method: "POST",
          body: JSON.stringify({ until: 12 }),
        })
      ).status,
    ).toBe(400);
  });
});

describe("closing a reminder", () => {
  it("should complete it without deleting the row", async () => {
    const reminder = await create();
    const body = (await (
      await api(`/reminders/${reminder.id}/complete`, { method: "POST" })
    ).json()) as Envelope<Reminder>;

    expect(body.data?.deliveryState).toBe("completed");
    expect(body.data?.completedAt).toBe(new Date(TEST_NOW).toISOString());
    expect((await api(`/reminders/${reminder.id}`)).status).toBe(200);
  });

  it("should cancel it without deleting the row", async () => {
    const reminder = await create();
    const body = (await (
      await api(`/reminders/${reminder.id}`, { method: "DELETE" })
    ).json()) as Envelope<Reminder>;

    expect(body.data?.deliveryState).toBe("cancelled");
    expect((await api(`/reminders/${reminder.id}`)).status).toBe(200);
  });

  it("should answer 404 for a reminder it does not have", async () => {
    const missing = "/reminders/syl:reminder:00000000-0000-7000-8000-0000000000ff";
    expect((await api(`${missing}/complete`, { method: "POST" })).status).toBe(404);
    expect((await api(missing, { method: "DELETE" })).status).toBe(404);
  });
});
