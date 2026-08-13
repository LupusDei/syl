import { randomUUID } from "node:crypto";

import express, { type Express, type RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArticleIntake } from "../../src/connections/intake.js";
import { createIntakeRouter, READS_PER_DAY, READ_WINDOW_HOURS } from "../../src/connections/intake-route.js";
import type { IntakeAnswer } from "../../src/connections/intake-view.js";
import { onError } from "../../src/index.js";
import { IdempotencyStore } from "../../src/services/idempotency.js";
import type { KeyScope } from "../../src/services/api-key-service.js";
import { THE_COMMANDER } from "../../src/services/api-key-service.js";
import type { SylDatabase } from "../../src/services/database.js";
import { intakeDatabase, testIntakeStore } from "../helpers/intake.js";
import { TEST_NOW } from "../helpers/service.js";

/**
 * The ceiling on how much reading Syl may set running.
 *
 * `read_this` is the first verb that spends the Commander's time and his tokens
 * without him having asked for anything in particular. A heartbeat turn that
 * decides to follow a link, or a page that talks her into following more of
 * them, is a loop nobody is watching — and unlike a render, which bills against
 * a credit balance he can see, a reading bills against the subscription he
 * cannot.
 *
 * Three decisions, and the arguments for each are on the constants:
 *
 * 1. **A ceiling, not a quota.** `SENDINGS_PER_DAY` is the precedent: it is not
 *    a budget to spend down, it is the number at which something has gone
 *    wrong.
 * 2. **Only her.** The Commander sharing a link from his phone is a person
 *    doing one thing at a time. Metering him would be the service
 *    second-guessing its owner, so a `device` key has no ceiling at all — and
 *    is told so, rather than being given a large number to believe in.
 * 3. **Visible, not silent.** Where she stands rides back on every answer, so
 *    she knows before she hits it rather than discovering the wall. Same rule
 *    as `because`, and the same call `render_me` makes with `spent`.
 */

let db: SylDatabase;
let scope: KeyScope = "agent";

/** Authentication, as `requireBearerToken` would have left the request. */
function asScope(): RequestHandler {
  return (request, _response, next) => {
    request.auth = {
      principal: THE_COMMANDER,
      key: {
        id: "syl:apikey:0198f100-0000-7000-8000-0000000000ff",
        deviceName: "A device",
        tokenSuffix: "abcd",
        scope,
        createdAt: "2026-08-09T07:00:00.000Z",
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null,
      },
    };
    next();
  };
}

/** The router alone, with a ceiling a test can reach in a few calls. */
function mount(allowance: number): Express {
  const intake = new ArticleIntake({
    store: testIntakeStore(db),
    clock: () => TEST_NOW,
    // Nothing is fetched by submission, and no step is ever advanced here.
    fetch: async () => {
      throw new Error("no test in this file may fetch");
    },
  });
  const built = express();
  built.use(express.json());
  built.use(
    createIntakeRouter({
      intake,
      idempotency: new IdempotencyStore({ db: db.handle, clock: () => TEST_NOW }),
      authenticate: asScope(),
      clock: () => TEST_NOW,
      allowance,
    }),
  );
  built.use(onError);
  return built;
}

let started: { readonly url: string; readonly close: () => Promise<void> } | null = null;

/** Bind a random high port, never a fixed one. See `CLAUDE.md` on 8888. */
async function listen(built: Express): Promise<void> {
  const server = built.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  started = {
    url: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function submit(url: string): Promise<Response> {
  return fetch(`${started?.url ?? ""}/intake`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ url }),
  });
}

beforeEach(() => {
  db = intakeDatabase();
  scope = "agent";
  started = null;
});

afterEach(async () => {
  await started?.close();
  db.close();
});

describe("the ceiling on how much Syl may read", () => {
  it("should let her read up to the ceiling and refuse the one after it", async () => {
    await listen(mount(2));

    expect((await submit("https://example.com/one")).status).toBe(201);
    expect((await submit("https://example.com/two")).status).toBe(201);

    const over = await submit("https://example.com/three");
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error?: { code?: string } }).error?.code).toBe("RATE_LIMITED");
  });

  it("should record nothing for the reading it refused", async () => {
    // Refused BEFORE the row is created, so a run against the ceiling cannot
    // walk it up one submission at a time — and so the store does not fill with
    // sources nobody will ever advance.
    await listen(mount(2));
    await submit("https://example.com/one");
    await submit("https://example.com/two");
    await submit("https://example.com/three");

    const row = db.handle.prepare("SELECT count(*) AS n FROM intake_sources").get();
    expect(row).toEqual({ n: 2 });
  });

  it("should say what stopped in a sentence she can repeat to him", async () => {
    // She has to be able to turn this into something he can overrule. "Rate
    // limited" is a code; "I have read ten things today already, send it
    // yourself if it cannot wait" is an answer.
    await listen(mount(2));
    await submit("https://example.com/one");
    await submit("https://example.com/two");

    const over = await submit("https://example.com/three");
    const message = ((await over.json()) as { error?: { message?: string } }).error?.message ?? "";

    expect(message).toContain("ceiling");
    expect(message).toContain("read nothing more");
  });

  it("should tell her where she stands before she gets there", async () => {
    await listen(mount(2));

    const first = (await (await submit("https://example.com/one")).json()) as {
      data?: IntakeAnswer;
    };

    expect(first.data?.reads).toEqual({ used: 1, allowance: 2, windowHours: READ_WINDOW_HOURS });
  });

  it("should not charge her twice for the same link", async () => {
    // A repeat submission is how she waits: nothing is fetched while she is
    // talking to him, so asking again with the same link is how she finds out
    // what it said. Charging for that would make looking the expensive part.
    await listen(mount(2));
    await submit("https://example.com/one");
    await submit("https://example.com/one");

    expect((await submit("https://example.com/two")).status).toBe(201);
  });

  it("should count a reading out of the window as spent", async () => {
    await listen(mount(2));

    // Older than the window by an hour, which no rolling count should see.
    testIntakeStore(db, () => TEST_NOW - (READ_WINDOW_HOURS + 1) * 60 * 60_000).create({
      url: "https://example.com/yesterday",
      channel: "link",
      requestedBy: THE_COMMANDER.id,
      retention: "standard",
      retentionReason: "public web content",
    });

    const answer = (await (await submit("https://example.com/one")).json()) as {
      data?: IntakeAnswer;
    };
    expect(answer.data?.reads.used).toBe(1);
  });

  it("should meter nobody but her", async () => {
    // His own phone sharing a link is a person doing one thing at a time. A
    // service that metered its owner would be second-guessing him, and a
    // `device` key is told there is no ceiling rather than given a big number.
    scope = "device";
    await listen(mount(2)); // the same ceiling, and it must not apply

    expect((await submit("https://example.com/one")).status).toBe(201);
    expect((await submit("https://example.com/two")).status).toBe(201);

    const third = await submit("https://example.com/three");
    expect(third.status).toBe(201);
    expect(((await third.json()) as { data?: IntakeAnswer }).data?.reads.allowance).toBeNull();
  });

  it("should ship a ceiling small enough to bound a runaway and large enough for an afternoon", () => {
    // Pinned so the number is a decision rather than a default somebody drifts.
    // Ten rather than four: `SENDINGS_PER_DAY` bounds how often she may
    // INTERRUPT him, and a reading interrupts nobody.
    expect(READS_PER_DAY).toBe(10);
    expect(READ_WINDOW_HOURS).toBe(24);
  });
});
