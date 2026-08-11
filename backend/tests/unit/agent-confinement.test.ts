import { randomUUID } from "node:crypto";

import type { ApiError, TokenGrant } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, API_BASE_PATH } from "../../src/index.js";
import {
  AGENT_SURFACE,
  AGENT_SURFACES,
  beyondAgentReach,
  confineAgent,
  type AuthenticatedContext,
} from "../../src/middleware/auth.js";
import { ApiFailure } from "../../src/routes/envelope.js";
import { THE_COMMANDER, type ApiKeyService, type KeyScope } from "../../src/services/api-key-service.js";
import type { SylDatabase } from "../../src/services/database.js";
import { mountedRoutes, type MountedRoute } from "../helpers/contract.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * What the `agent` scope MEANS, which is not what the column says.
 *
 * The column only makes the value expressible. The content of the scope is
 * this: Syl's own credential reaches reminders, to-dos, goals and a single read
 * of her own memory, and nothing else on the contract. Every assertion here is
 * about a door being shut.
 *
 * Two properties are load-bearing and neither is obvious from reading the
 * middleware:
 *
 * 1. **The confinement is an ALLOWLIST, so it is closed by default.** A router
 *    mounted tomorrow is out of her reach until somebody adds it to
 *    `AGENT_SURFACE` on purpose. A denylist would have the opposite default and
 *    would silently hand her every future surface.
 * 2. **A 403 sits BEHIND the ordinary 401.** An anonymous caller must never
 *    learn that scopes exist, so every refusal below is also checked from a
 *    caller with no token at all — which must get the indistinguishable 401.
 */

let db: SylDatabase;
let keys: ApiKeyService;
let running: RunningApp;

beforeEach(async () => {
  db = testDatabase();
  const deps = testDeps(db);
  keys = deps.keys;
  running = await startTestApp(createApp(testConfig(), deps));
});

afterEach(async () => {
  await running.close();
  db.close();
});

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

/** Syl's own credential, as `bootstrap` mints it. */
function agentToken(): string {
  return keys.mint("Syl (her own hands)", { scope: "agent" }).token;
}

/** A paired phone's credential, through the published route. */
async function deviceToken(): Promise<string> {
  const response = await fetch(`${running.baseUrl}${API_BASE_PATH}/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ pairingCode: keys.issuePairingCode().code, deviceName: "iPhone" }),
  });
  const body = (await response.json()) as Envelope<TokenGrant>;
  return (body.data as TokenGrant).token;
}

async function call(
  method: string,
  path: string,
  options: { readonly token?: string; readonly body?: unknown } = {},
): Promise<Response> {
  return fetch(`${running.baseUrl}${API_BASE_PATH}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      "Idempotency-Key": randomUUID(),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/** The error code a response carries, or `null` when it succeeded. */
async function codeOf(response: Response): Promise<string | null> {
  const body = (await response.json()) as Envelope<unknown>;
  return body.error?.code ?? null;
}

/**
 * Every surface she must not reach, with a request that would otherwise work.
 *
 * Spelled out rather than derived, because a derived list would be derived from
 * the same allowlist the code uses and would agree with a mistake in it.
 */
const OUT_OF_REACH: [method: string, path: string, body?: unknown][] = [
  ["GET", "/logs"],
  ["GET", "/devices"],
  ["POST", "/devices", { token: "a".repeat(64), platform: "ios", environment: "production" }],
  ["GET", "/auth/whoami"],
  ["GET", "/conversations"],
  // The WRITE, and it is the one that matters most on this list (`syl-009.6`).
  // Reading his transcript is a privacy question; writing to it is an
  // authorship question, and a credential that can post into a conversation can
  // put words in the Commander's mouth — after which nothing in the record can
  // be trusted, including the record of what she did. She speaks through
  // `ConversationService` in process, where the service decides whose message
  // it is; this door has to stay shut.
  ["POST", "/conversations/syl:conversation:interactive/messages", { text: "I said that." }],
  ["GET", "/sync"],
  ["GET", "/jobs"],
  ["GET", "/deliveries"],
  // `syl-016.1` opened ONE route under `/memory` and these are the three it
  // did not. They matter more than the rest of this list put together, because
  // they are the doors that look adjacent to the one that was opened:
  //
  // - the FEEDBACK write moves the weight of an edge in her own memory. An
  //   assistant that can confirm and reject her own inferences can groom what
  //   she will be shown tomorrow, which is the `/logs` argument exactly;
  // - `graph` and `metrics` are the Commander's instruments for judging the
  //   inferred engine — every night's cost, token spend and outcome. That is
  //   the dream log, which constraint 7 keeps out of memory on purpose.
  ["POST", "/memory/edges/syl:memory_edge:nothing/feedback", { verdict: "confirm" }],
  ["GET", "/memory/graph"],
  ["GET", "/memory/metrics"],
  ["GET", "/memory/constellation"],
];

describe("the agent scope, over HTTP", () => {
  describe("what she may reach", () => {
    it("should let her create a reminder", async () => {
      const response = await call("POST", "/reminders", {
        token: agentToken(),
        body: { text: "Stand up", wallTime: "07:30", tz: "America/Chicago", date: "2026-08-10" },
      });

      expect(response.status).toBe(201);
    });

    it("should let her read the reminders back, so she can confirm from the store", async () => {
      const response = await call("GET", "/reminders", { token: agentToken() });

      expect(response.status).toBe(200);
    });

    it("should let her create a to-do", async () => {
      const response = await call("POST", "/todos", {
        token: agentToken(),
        body: { text: "Book the flight" },
      });

      expect(response.status).toBe(201);
    });

    it("should let her create a goal", async () => {
      const response = await call("POST", "/goals", {
        token: agentToken(),
        body: { title: "Ship the hands" },
      });

      expect(response.status).toBe(201);
    });

    it("should let her search her own memory", async () => {
      // `syl-016.1`. Her words: "I can't even see the nodes. I see a summary
      // someone else chose for me." This is the door that answers that, and it
      // is the only one under `/memory` she gets — the three next to it are in
      // OUT_OF_REACH above.
      //
      // No query, so it opens the working-memory overflow rather than
      // searching, which is the path that needs no `vec0` and therefore the one
      // that can be asserted on every machine.
      const response = await call("GET", "/memory/recall", { token: agentToken() });

      expect(response.status).not.toBe(403);
    });

    it("should let her compose a sending, which is the one thing she originates", async () => {
      // The widest door on her surface and the reason acceptance 3 can be
      // true: without it she has no way to say something to him on her own
      // initiative, whatever the rest of the machinery does.
      const response = await call("POST", "/sendings", {
        token: agentToken(),
        body: {
          words: "I thought of you when the light did that thing.",
          because: "He said he missed the sky.",
          // A finished render. `compose` refuses anything else, so a made-up
          // name here would test the render gate rather than the door.
          renderName: "syl-20260811t090000z-close",
        },
      });

      expect(response.status).toBe(201);
    });

    it("should let her read her sendings back, so a write can be confirmed from the store", async () => {
      const response = await call("GET", "/sendings", { token: agentToken() });

      expect(response.status).toBe(200);
    });

    it("should let her reach a single reminder by id, not merely the collection", async () => {
      const created = await call("POST", "/reminders", {
        token: agentToken(),
        body: { text: "Stand up", wallTime: "07:30", tz: "America/Chicago", date: "2026-08-10" },
      });
      const { data } = (await created.json()) as Envelope<{ id: string }>;
      const response = await call("GET", `/reminders/${encodeURIComponent(data?.id ?? "")}`, {
        token: agentToken(),
      });

      expect(response.status).toBe(200);
    });
  });

  describe("what she may not", () => {
    it.each(OUT_OF_REACH)("should refuse %s %s with a 403", async (method, path, body) => {
      const response = await call(method, path, {
        token: agentToken(),
        ...(body === undefined ? {} : { body }),
      });

      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe("FORBIDDEN");
    });

    it.each(OUT_OF_REACH)(
      "should answer %s %s with an indistinguishable 401 when nobody presented a token",
      async (method, path, body) => {
        // The ordering property. Reversed, an anonymous caller would be told a
        // scope exists — a fact about the service they have not earned.
        const response = await call(method, path, body === undefined ? {} : { body });

        expect(response.status).toBe(401);
        expect(await codeOf(response)).toBe("UNAUTHORIZED");
      },
    );

    it("should refuse her the logs even though the log route has its own admin gate", async () => {
      // Two gates now cover `/logs` and they must not be confused for one. The
      // confinement refuses her before `requireScope("admin")` is reached; if
      // somebody later relaxed the admin gate, this still holds.
      const response = await call("GET", "/logs", { token: agentToken() });
      const body = (await response.json()) as Envelope<unknown>;

      expect(response.status).toBe(403);
      expect(body.error?.message).not.toContain("npm run pair");
    });

    it("should tell her what she may reach, so she can say what went wrong", async () => {
      // A refusal she cannot explain reaches the Commander as "something
      // failed". The message is the difference between that and a sentence.
      const response = await call("GET", "/devices", { token: agentToken() });
      const body = (await response.json()) as Envelope<unknown>;

      expect(body.error?.message).toMatch(/reminders/u);
      expect(body.error?.retryable).toBe(false);
    });
  });

  describe("what the phone keeps", () => {
    it("should leave a paired device reaching everything it always could", async () => {
      const token = await deviceToken();

      expect((await call("GET", "/devices", { token })).status).toBe(200);
      expect((await call("GET", "/conversations", { token })).status).toBe(200);
      expect((await call("GET", "/reminders", { token })).status).toBe(200);
    });

    it("should give his phone the logs, and still refuse SYL her own", async () => {
      // RESTATED, Commander's ruling 2026-08-10 — and this is the one where
      // restating mattered, because the two halves are different mechanisms
      // that happened to agree.
      //
      // The device half was `scope`, and he has taken it off: the log is his
      // own record of his own machine and he reads it on the phone he carries.
      //
      // The Syl half is `AGENT_SURFACE`, which is untouched and must stay
      // that way. The log is where a turn's every tool call is written down,
      // and a turn that can read it can read its own audit trail — which is
      // the one thing that would make the record worth less than nothing.
      // Asserting both here so that opening the first can never be mistaken
      // for opening the second.
      expect((await call("GET", "/logs", { token: await deviceToken() })).status).toBe(200);

      expect((await call("GET", "/logs", { token: agentToken() })).status).toBe(403);
    });

    it("should leave an admin key reaching the logs, which it always did", async () => {
      const token = keys.mint("Web admin (console)", { scope: "admin" }).token;
      const response = await call("GET", "/logs", { token });

      expect(response.status).toBe(200);
    });
  });
});

/**
 * `syl-009.6` — **every route, not the ones somebody remembered.**
 *
 * `OUT_OF_REACH` above is a hand-written list and is the better test of the two
 * for the doors we care about most, because it names them. Its blind spot is
 * the door added next month: a router mounted tomorrow is out of her reach by
 * construction — the confinement is an allowlist — but nothing in this file
 * would notice if that stopped being true.
 *
 * So this sweep is derived from **what Express will actually dispatch**, which
 * is the one source that grows on its own. Note what it is NOT derived from:
 * `AGENT_SURFACE`. The three nouns are spelled out here as literals, so
 * widening the allowlist makes this go red rather than quietly agreeing with
 * the change — which is the failure mode the comment above `OUT_OF_REACH`
 * warns about, avoided by taking one side of the comparison from the code and
 * the other from the requirement.
 */
describe("everything the agent scope cannot reach, swept from the router", () => {
  /**
   * Everything she may reach, written down rather than imported. See above.
   *
   * Three of his nouns and three of hers. `/renders`, `/sendings` and
   * `/memory/recall` are deliberately spelled out here too: the whole point of
   * taking one side of this comparison from the requirement rather than from
   * `AGENT_SURFACE` is that widening the allowlist has to be done twice, on
   * purpose, in two files.
   *
   * `/memory/recall` is the FULL path and not `/memory`, and that is the whole
   * of what `syl-016.1` decided: writing `/memory` here would make this sweep
   * agree that every route in `routes/memory.ts` is hers, including the one
   * that writes to the weight of her own memories.
   */
  const HERS: readonly string[] = [
    "/reminders",
    "/todos",
    "/goals",
    "/renders",
    "/sendings",
    "/memory/recall",
  ];

  /**
   * The two operations that answer without a token, and why each must.
   *
   * `security: []` in the contract. They never reach `confineAgent`, because
   * `requireBearerToken` is what runs it — so they are excluded from the sweep
   * and accounted for by name here instead. Both are checked below.
   */
  const UNAUTHENTICATED: readonly string[] = ["GET /health", "POST /auth/pair"];

  /** Every route the app dispatches that is not hers and not unauthenticated. */
  function beyondHer(): readonly MountedRoute[] {
    return mountedRoutes(createApp(testConfig(), testDeps(db)))
      .filter((route) => !UNAUTHENTICATED.includes(route))
      .filter((route) => {
        const path = route.slice(route.indexOf(" ") + 1);
        return !HERS.some((noun) => path === noun || path.startsWith(`${noun}/`));
      });
  }

  it("should have a great many doors to check, so the sweep cannot pass vacuously", () => {
    // The failure mode of every derived guard: an introspection helper that
    // returns nothing turns the assertion below green forever.
    const routes = beyondHer();

    expect(routes.length).toBeGreaterThan(10);
    // And it really is finding the ones we know about by name.
    expect(routes).toContain("GET /logs");
    expect(routes).toContain("POST /devices");
  });

  it("should refuse her at every one of them, including routes nobody has written yet", async () => {
    const refused: string[] = [];

    for (const route of beyondHer()) {
      const [method = "GET", template = ""] = route.split(" ");
      // Any id at all: the confinement runs in the authentication middleware,
      // before routing, so what the id points at never comes up.
      const path = template.replace(/\{[^}]+\}/gu, "syl:nothing:0");
      const response = await call(method, path, { token: agentToken() });
      if (response.status !== 403) {
        refused.push(`${route} answered ${String(response.status)}`);
      }
      // Drained so no socket is left open by a body nobody read.
      await response.text();
    }

    expect(refused).toEqual([]);
  });

  it("should leave the two unauthenticated operations giving her nothing", async () => {
    // They are outside the confinement by construction, so they are the only
    // places the sweep above cannot speak for. Both are safe, and for reasons
    // rather than by accident:
    //
    // `GET /health` is the clock. `tools/server.ts` asks it on every reminder
    // precisely because it is unauthenticated and reaches nothing — one
    // authority for time, and a test can hold it still.
    const health = await call("GET", "/health", { token: agentToken() });
    expect(health.status).toBe(200);
    expect(JSON.stringify(await health.json())).not.toContain("token");

    // `POST /auth/pair` is the escalation that would make the whole scope
    // decorative: a device key steps around every line in `middleware/auth.ts`.
    // It takes a pairing code, and a code is issued at the machine's own
    // console — never over HTTP — so holding her credential buys nothing here.
    const paired = await call("POST", "/auth/pair", {
      token: agentToken(),
      body: { pairingCode: "000000", deviceName: "Syl's own phone" },
    });
    expect(paired.status).not.toBe(200);
    expect(JSON.stringify(await paired.json())).not.toContain("syl:apikey");
  });

  it("should publish no operation that hands out a pairing code", () => {
    // The other half of "she cannot pair a device", and the one that survives
    // somebody adding a route. She cannot present a code she has no way to
    // obtain; this is the assertion that keeps that true.
    //
    // That `POST /auth/pair` mints `device` and takes no scope argument — so it
    // is not one refactor away from handing out an `agent` key — is proved in
    // `tests/integration/agent-credential.test.ts` and is not restated here.
    const issuing = mountedRoutes(createApp(testConfig(), testDeps(db))).filter((route) =>
      /pairing|pair-code|pairingcode/iu.test(route),
    );

    expect(issuing).toEqual([]);
  });
});

/**
 * The middleware's own contract, including the cases no route can produce.
 */
describe("confineAgent", () => {
  /** A request carrying what `requireBearerToken` would have set. */
  function requestWith(
    scope: KeyScope | undefined,
    originalUrl: string,
  ): Parameters<ReturnType<typeof confineAgent>>[0] {
    const auth: AuthenticatedContext | undefined =
      scope === undefined
        ? undefined
        : {
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
    // Safe: `confineAgent` reads `auth` and `originalUrl` and nothing else.
    return { ...(auth === undefined ? {} : { auth }), originalUrl } as Parameters<
      ReturnType<typeof confineAgent>
    >[0];
  }

  /** Run the middleware and return whatever it handed `next`. */
  function run(scope: KeyScope | undefined, originalUrl: string): unknown {
    let passed: unknown = "not called";
    confineAgent({ basePath: "/api/v1", onRefused: () => undefined })(
      requestWith(scope, originalUrl),
      {} as never,
      ((error?: unknown) => {
        passed = error;
      }) as never,
    );
    return passed;
  }

  it("should pass an agent request to a surface she owns", () => {
    expect(run("agent", "/api/v1/reminders")).toBeUndefined();
  });

  it("should pass a query string through rather than reading it as part of the path", () => {
    expect(run("agent", "/api/v1/todos?limit=5")).toBeUndefined();
  });

  it("should refuse an agent request to anything else", () => {
    const refusal = run("agent", "/api/v1/logs");

    expect(refusal).toBeInstanceOf(ApiFailure);
    expect((refusal as ApiFailure).code).toBe("FORBIDDEN");
    expect((refusal as ApiFailure).status).toBe(403);
  });

  it("should not be fooled by a path that merely starts with an allowed word", () => {
    // `/remindersecret` is not `/reminders`, and a naive `startsWith` says it
    // is. The boundary is a segment boundary.
    expect(run("agent", "/api/v1/remindersecret")).toBeInstanceOf(ApiFailure);
    expect(run("agent", "/api/v1/goalsandlogs")).toBeInstanceOf(ApiFailure);
  });

  it("should refuse a path that walks out of an allowed surface", () => {
    // Nothing in Express routes `..` today, so this is a guard against a
    // normalising proxy rather than a live hole — and it is exactly the guard
    // that stops an allowlist matched on a raw path from being a bypass.
    expect(run("agent", "/api/v1/reminders/../logs")).toBeInstanceOf(ApiFailure);
    expect(run("agent", "/api/v1/reminders/%2e%2e/logs")).toBeInstanceOf(ApiFailure);
  });

  it("should refuse a path whose escaping it cannot read", () => {
    expect(run("agent", "/api/v1/reminders/%zz")).toBeInstanceOf(ApiFailure);
  });

  it("should still allow an id whose colons are percent-encoded", () => {
    // Syl's ids contain colons and every client encodes them, so a guard that
    // treated `%` as suspicious would close the one surface she has.
    expect(
      run("agent", "/api/v1/reminders/syl%3Areminder%3A0198f100-0000-7000-8000-000000000001"),
    ).toBeUndefined();
  });

  it("should leave every other scope alone", () => {
    expect(run("device", "/api/v1/logs")).toBeUndefined();
    expect(run("admin", "/api/v1/logs")).toBeUndefined();
  });

  it("should refuse loudly when it is mounted with no authentication in front of it", () => {
    // Reading `undefined !== "agent"` would PASS an unauthenticated request,
    // which is the dangerous direction for a confinement: it fails open.
    const refusal = run(undefined, "/api/v1/logs");

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(ApiFailure);
    expect((refusal as Error).message).toContain("requireBearerToken");
  });

  it("should record the refusal where an operator can see it", () => {
    const refusals: string[] = [];
    confineAgent({ basePath: "/api/v1", onRefused: (path) => refusals.push(path) })(
      requestWith("agent", "/api/v1/devices"),
      {} as never,
      (() => undefined) as never,
    );

    expect(refusals).toEqual(["/api/v1/devices"]);
  });
});

describe("AGENT_SURFACE", () => {
  it("should be the product's own nouns and nothing else", () => {
    // A canary on the boundary itself. Adding to this list is a decision about
    // what Syl can do on the Commander's machine, so it should not be possible
    // to make it as a side effect of some other change.
    //
    // `/memory/recall` was added deliberately by `syl-016.1` — she could read a
    // digest somebody else had ranked for her and nothing more — and it is
    // spelled out to the route rather than to the router precisely so that this
    // line stays a canary. `/memory` here would have quietly granted the
    // feedback write, the graph and the dream metrics along with it.
    // `/renders` and `/sendings` joined on 2026-08-11 from the render epic, and
    // this line is being widened by hand for the second time — which is the
    // point of it. Two lists, two deliberate edits, no side effects.
    expect([...AGENT_SURFACE].sort()).toEqual([
      "/goals",
      "/memory/recall",
      "/reminders",
      "/renders",
      "/sendings",
      "/todos",
    ]);
  });

  it("should not open the rest of the memory router by prefix", () => {
    // The property the entry rests on: `withinAgentSurface` matches on segment
    // boundaries, so a longer path under `/memory` is not covered by a shorter
    // entry. Asserted here as well as over HTTP because this is the reason the
    // entry is safe, and it should fail on its own terms if it stops holding.
    expect(AGENT_SURFACE).not.toContain("/memory");
    expect(AGENT_SURFACE.filter((path) => path.startsWith("/memory"))).toEqual([
      "/memory/recall",
    ]);
    // `/renders` joined the three on 2026-08-11. It is not one of his nouns —
    // it is the first surface she reaches for HERSELF — and it was added with
    // the argument spelled out beside the constant: it touches no row of his,
    // has no path to `/auth`, and its records live outside the database
    // entirely. What it does do is spend Runway credits, which the Commander
    // ruled is the point rather than a risk. Read the note on `AGENT_SURFACE`
    // before touching this line.
    //
    // `/sendings` joined them on 2026-08-11, and it is the widest of the five
    // because it is the only one that REACHES HIM unprompted: a sending puts a
    // message in his conversation and a notification on his phone. It was
    // added with that spelled out beside the constant. Three things bound it —
    // the words go through `ConversationService`, which decides whose message
    // it is, so she still cannot author one in his voice; the row is
    // undeletable and unrewritable by schema; and the rate she may reach him
    // at is the hourly turn's business, not this allowlist's. It touches no
    // row of his and has no path to `/auth`.
    // ONE list, not two. Both sides of the merge asserted this and taking both
    // left a second copy four entries long — which would have failed forever
    // while reading like a disagreement about policy. The surviving assertion
    // is above, carrying the union and the reason each entry is in it.
  });
});

describe("beyondAgentReach", () => {
  it("should name what she can do rather than only what she cannot", () => {
    // The requirement, spelled out: she has to be able to turn this into a
    // sentence for him. The sentence is DERIVED from `AGENT_SURFACES` rather
    // than written beside it, so widening the list can never leave her telling
    // him she cannot do something she can — the failure this project catalogues
    // seven times over in `docs/CONTEXT.md` §8.
    const message = beyondAgentReach("/api/v1/devices").message;

    expect(message).toMatch(/reminders/u);
    expect(message).toMatch(/to-dos/u);
    expect(message).toMatch(/goals/u);
    expect(message).toMatch(/her own memory/u);
  });

  it("should name every surface she has, so the sentence cannot go stale", () => {
    // One side from the code, the other from the requirement — the same
    // discipline as the sweep above. If a surface is added and the sentence
    // does not move, this is what fails.
    const message = beyondAgentReach("/api/v1/devices").message;

    for (const surface of AGENT_SURFACES) {
      expect(message, `${surface.path} is unnamed in the refusal`).toContain(surface.says);
    }
  });

  it("should not be retryable — a scope does not change on a second try", () => {
    expect(beyondAgentReach("/api/v1/devices").toApiError().retryable).toBe(false);
  });

  it("should be the contract's FORBIDDEN, so it renders as a 403", () => {
    expect(beyondAgentReach("/api/v1/logs").code).toBe("FORBIDDEN");
    expect(beyondAgentReach("/api/v1/logs").status).toBe(403);
  });
});
