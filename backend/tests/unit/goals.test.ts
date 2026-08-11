import type { ApiError, Goal, GoalPage } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../../src/index.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * `/goals` over a real socket.
 *
 * Three operations, exactly as the contract publishes them. There is
 * deliberately no `PATCH /goals/{id}` here, and the absence is asserted: a
 * route the spec does not describe is the same divergence `syl-c1m` is about,
 * pointing the other way.
 */

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
  const key = idempotencyKey === undefined ? `key-${String(keyCounter)}` : idempotencyKey;

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

async function create(overrides: Record<string, unknown> = {}): Promise<Goal> {
  const response = await api("/goals", {
    method: "POST",
    body: JSON.stringify({ title: "Ship Syl", ...overrides }),
  });
  const body = (await response.json()) as Envelope<Goal>;
  if (body.data === undefined) throw new Error(`create failed: ${JSON.stringify(body)}`);
  return body.data;
}

describe("POST /api/v1/goals", () => {
  it("should answer 201 with the created goal", async () => {
    const response = await api("/goals", {
      method: "POST",
      body: JSON.stringify({ title: "Ship Syl", why: "So he stops carrying it in his head." }),
    });
    const body = (await response.json()) as Envelope<Goal>;

    expect(response.status).toBe(201);
    expect(body.data?.title).toBe("Ship Syl");
    expect(body.data?.why).toBe("So he stops carrying it in his head.");
    expect(body.data?.status).toBe("active");
  });

  it("should refuse a body with no title, in the contract's failure envelope", async () => {
    const response = await api("/goals", { method: "POST", body: JSON.stringify({}) });
    const body = (await response.json()) as Envelope<Goal>;

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.["field"]).toBe("title");
  });

  it("should refuse a parent that names nothing", async () => {
    const response = await api("/goals", {
      method: "POST",
      body: JSON.stringify({
        title: "Orphan",
        parentId: "syl:goal:00000000-0000-7000-8000-00000000dead",
      }),
    });
    const body = (await response.json()) as Envelope<Goal>;

    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.["field"]).toBe("parentId");
  });

  it("should nest a goal under an existing one", async () => {
    const parent = await create({ title: "This year" });
    const child = await create({ title: "This season", parentId: parent.id });

    expect(child.parentId).toBe(parent.id);
  });

  it("should refuse a target date that is not a date that exists", async () => {
    const response = await api("/goals", {
      method: "POST",
      body: JSON.stringify({ title: "Impossible", targetDate: "2026-02-31" }),
    });
    const body = (await response.json()) as Envelope<Goal>;

    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.["field"]).toBe("targetDate");
  });

  it("should refuse a write with no Idempotency-Key", async () => {
    const response = await api("/goals", {
      method: "POST",
      idempotencyKey: null,
      body: JSON.stringify({ title: "Unkeyed" }),
    });
    expect(((await response.json()) as Envelope<Goal>).error?.code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  });

  it("should replay a repeated create rather than writing a second goal", async () => {
    const body = JSON.stringify({ title: "Sent twice" });
    await api("/goals", { method: "POST", idempotencyKey: "same", body });
    const second = await api("/goals", { method: "POST", idempotencyKey: "same", body });

    expect(second.headers.get("idempotency-replayed")).toBe("true");
    const listed = (await (await api("/goals")).json()) as Envelope<GoalPage>;
    expect(listed.data?.items).toHaveLength(1);
  });
});

describe("GET /api/v1/goals", () => {
  it("should answer a page, newest first", async () => {
    const first = await create({ title: "First" });
    const second = await create({ title: "Second" });

    const body = (await (await api("/goals")).json()) as Envelope<GoalPage>;
    expect(body.data?.items.map((goal) => goal.id)).toEqual([second.id, first.id]);
  });

  it("should refuse a status outside the enum, in the contract's failure envelope", async () => {
    const response = await api("/goals?status=in_progress");
    const body = (await response.json()) as Envelope<GoalPage>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.["field"]).toBe("status");
  });

  it("should narrow to a status, and treat dormant as an ordinary one", async () => {
    await create({ title: "Live" });
    const dormant = await create({ title: "Parked", status: "dormant" });

    const body = (await (await api("/goals?status=dormant")).json()) as Envelope<GoalPage>;
    expect(body.data?.items.map((goal) => goal.id)).toEqual([dormant.id]);
  });

  it("should refuse an unauthenticated read", async () => {
    const response = await api("/goals", { anonymous: true });
    expect(response.status).toBe(401);
    expect(((await response.json()) as Envelope<GoalPage>).error?.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /api/v1/goals/{goalId}", () => {
  it("should answer with the goal", async () => {
    const created = await create();
    const body = (await (
      await api(`/goals/${encodeURIComponent(created.id)}`)
    ).json()) as Envelope<Goal>;

    expect(body.success).toBe(true);
    expect(body.data?.id).toBe(created.id);
  });

  it("should answer NOT_FOUND for an id that names nothing", async () => {
    const response = await api("/goals/syl%3Agoal%3A00000000-0000-7000-8000-00000000dead");
    const body = (await response.json()) as Envelope<Goal>;

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("should answer NOT_FOUND for a path segment that is not an id at all", async () => {
    const body = (await (await api("/goals/banana")).json()) as Envelope<Goal>;
    expect(body.error?.message).toBe("That is not a goal id.");
  });
});

describe("updating a goal, which the contract now publishes", () => {
  it("should reword one without disturbing what he did not mention", async () => {
    // RESTATED. This asserted that PATCH did NOT exist, "because the contract
    // declares none" — the mirror of `syl-c1m`, and a good guard: serving an
    // endpoint the spec does not describe is a divergence invisible to every
    // client.
    //
    // The Commander asked for the other half ("totally manage all data in her
    // realm"), so the CONTRACT moved first and the route followed. The guard
    // is kept pointed the same way — the route and the spec must agree — and
    // only the direction of agreement changed. Deleting it would have thrown
    // away the reason the route did not exist for so long.
    const created = await create();

    const response = await api(`/goals/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed" }),
    });
    const body = (await response.json()) as Envelope<Goal>;

    expect(response.status).toBe(200);
    expect(body.data?.title).toBe("Renamed");
    // Untouched by a patch that did not name them.
    expect(body.data?.why).toBe(created.why);
    expect(body.data?.targetDate).toBe(created.targetDate);
    expect(body.data?.status).toBe(created.status);
  });

  it("should carry the reason with the state change", async () => {
    // A goal that says `abandoned` and cannot say why is the field he will
    // want a year later and not have.
    const created = await create();

    const response = await api(`/goals/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "abandoned", statusReason: "He decided against it." }),
    });
    const body = (await response.json()) as Envelope<Goal>;

    expect(body.data?.status).toBe("abandoned");
    expect(body.data?.statusReason).toBe("He decided against it.");
  });

  it("should refuse a status the vocabulary does not have", async () => {
    // 400 like every other validation failure on this router, not a
    // hand-picked 422 — a route that answers differently from its neighbours
    // for the same class of mistake is a route clients special-case.
    const created = await create();

    const response = await api(`/goals/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "finished-ish" }),
    });

    expect(response.status).toBe(400);
  });
});
