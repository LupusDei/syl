import { describe, expect, it } from "vitest";

import { SylApiClient, type FetchLike } from "../../src/tools/client.js";
import { TOOLS } from "../../src/tools/schemas.js";
import {
  advertisedToolNames,
  createToolServer,
  HANDLERS,
  type ToolContext,
  type ToolEnvelope,
} from "../../src/tools/server.js";

/**
 * The MCP server, at the grain of one message in and one reply out.
 *
 * `us6-she-can-act` drives the real thing — a spawned process, real stdio, a
 * real service — and that is the test the epic is judged on. It is also the
 * wrong instrument for "what happens when the store answers 409", so everything
 * that is about a *branch* lives here, against a fake `fetch` that stands in
 * for Syl's own API.
 *
 * The fake answers in the contract's envelopes, because the client reads those
 * and a fake that answered in some convenient shape would be testing itself.
 */

const HIS_ZONE = "America/Chicago";
/** 2026-08-10T12:00:00Z, and the service's answer to "what time is it". */
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0, 0);

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

interface FakeApi {
  readonly calls: Call[];
  readonly fetch: FetchLike;
}

/** A response in the contract's success envelope. */
function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A response in the contract's failure envelope. */
function failure(status: number, code: string, message: string, retryable = false): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message, retryable } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A stand-in for Syl's own API.
 *
 * `routes` is consulted in order; the first prefix that matches answers. `now`
 * is served from the constant above, so the tool's clock is the service's clock
 * exactly as it is in production.
 */
function fakeApi(routes: Record<string, (call: Call) => Response>): FakeApi {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const path = input.replace("http://127.0.0.1:8888/api/v1", "");
      const call: Call = {
        method: init?.method ?? "GET",
        path,
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null,
      };
      calls.push(call);

      if (path === "/health") {
        return ok({ status: "ok", version: "0.1.0", startedAt: "", now: new Date(NOW).toISOString(), checks: [], build: null });
      }
      for (const [prefix, answer] of Object.entries(routes)) {
        if (path.startsWith(prefix)) return answer(call);
      }
      return failure(404, "NOT_FOUND", `nothing fake answers ${call.method} ${path}`);
    },
  };
}

function contextFor(api: FakeApi, hisMessage = ""): ToolContext {
  return {
    client: new SylApiClient({
      baseUrl: "http://127.0.0.1:8888/api/v1",
      token: "test-token",
      fetch: api.fetch,
    }),
    tz: HIS_ZONE,
    hisMessage: () => hisMessage,
  };
}

/** Call a verb and read the pinned envelope back out of the MCP result. */
async function call(
  context: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ envelope: ToolEnvelope; isError: boolean }> {
  const reply = await createToolServer(context).handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = reply?.result as {
    content: { text: string }[];
    isError?: boolean;
  };
  return {
    envelope: JSON.parse(result.content[0]?.text ?? "{}") as ToolEnvelope,
    isError: result.isError === true,
  };
}

/** A stored reminder, in the contract's shape. */
function storedReminder(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "syl:reminder:0000",
    kind: "commitment",
    text: "Take the bread out of the oven.",
    todoId: null,
    eventId: null,
    wallTime: "07:05",
    tz: HIS_ZONE,
    rrule: null,
    scheduledFor: new Date(NOW + 5 * 60_000).toISOString(),
    nextFireAt: new Date(NOW + 5 * 60_000).toISOString(),
    urgent: false,
    late: false,
    deferredFrom: null,
    supersedesPrevious: false,
    deliveryState: "scheduled",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    completedAt: null,
    ...over,
  };
}

/** The five minutes case, wired end to end through the fake. */
function remindingApi(): FakeApi {
  return fakeApi({
    "/reminders": (made) =>
      made.method === "POST"
        ? ok(storedReminder(), 201)
        : ok(storedReminder({ text: "as the store actually has it" })),
  });
}

const FIVE_MINUTES = { said: "in five minutes", kind: "relative", minutes: 5 };

describe("the tool surface she is offered", () => {
  it("should advertise every verb that has a handler, with the schema from schemas.ts", async () => {
    const reply = await createToolServer(contextFor(fakeApi({}))).handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (reply?.result as { tools: { name: string; inputSchema: unknown }[] }).tools;

    expect(tools.map((tool) => tool.name)).toEqual(Object.keys(HANDLERS));
    // The schema object itself, not a copy: a hand-written one here would drift
    // the day somebody rewords a description, and the descriptions ARE the
    // personality.
    for (const tool of tools) {
      expect(tool.inputSchema).toBe(TOOLS.find((known) => known.name === tool.name)?.inputSchema);
    }
  });

  it("should not offer a verb it has nowhere to perform", () => {
    // `remember` is declared in `schemas.ts` and there is no route that writes
    // a memory — `AGENT_SURFACE` is reminders, to-dos and goals. Offering it
    // would tell her she can keep what he said about his life and answer 403
    // every time, which is the defect this epic exists to fix, one layer along.
    expect(TOOLS.map((tool) => tool.name)).toContain("remember");
    expect(advertisedToolNames()).not.toContain("remember");
  });

  it("should refuse a verb it does not have, in words rather than in a protocol error", async () => {
    const { envelope, isError } = await call(contextFor(fakeApi({})), "delete_everything", {});

    expect(isError).toBe(true);
    expect(envelope.ok).toBe(false);
    // What she CAN do, because a refusal she can act on beats a refusal she can
    // only repeat.
    if (!envelope.ok) expect(envelope.reason).toContain("remind_me");
  });
});

describe("the MCP handshake", () => {
  it("should answer initialize with a protocol version and its tool capability", async () => {
    const reply = await createToolServer(contextFor(fakeApi({}))).handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });

    expect(reply?.result).toMatchObject({ capabilities: { tools: {} } });
    expect((reply?.result as { protocolVersion: string }).protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it("should not answer a notification, which has no id to answer", async () => {
    const reply = await createToolServer(contextFor(fakeApi({}))).handle({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(reply).toBeNull();
  });

  it("should refuse a method it does not implement, and say which", async () => {
    const reply = await createToolServer(contextFor(fakeApi({}))).handle({
      jsonrpc: "2.0",
      id: 7,
      method: "resources/list",
    });

    expect(reply?.error?.message).toContain("resources/list");
    expect(reply?.id).toBe(7);
  });
});

describe("remind_me", () => {
  it("should turn 'in five minutes' into a stored reminder five minutes from the SERVICE's now", async () => {
    const api = remindingApi();

    const { envelope } = await call(contextFor(api), "remind_me", {
      text: "Take the bread out of the oven.",
      when: FIVE_MINUTES,
      because: "He asked for it.",
    });

    const posted = api.calls.find((made) => made.method === "POST");
    // Not this process's clock. A subprocess reading `Date.now()` would put the
    // reminder five minutes from whenever the test happened to run, and the
    // acceptance criterion of this epic is a claim about exactly this sum.
    expect(posted?.body?.["wallTime"]).toBe(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: HIS_ZONE,
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(NOW + 5 * 60_000)),
    );
    expect(posted?.body?.["tz"]).toBe(HIS_ZONE);
    // A place, never an offset — non-negotiable constraint 5, at the exact
    // point a human phrase becomes stored time.
    expect(String(posted?.body?.["tz"])).toContain("/");

    expect(envelope).toMatchObject({ ok: true, action: "remind_me" });
    if (envelope.ok) expect(envelope.at).toBe(new Date(NOW + 5 * 60_000).toISOString());
  });

  it("should report the row it READ BACK, not the one the write echoed", async () => {
    // `syl-009.3.4`. The two differ here on purpose: if the envelope carried
    // the write's own echo, this would pass while reporting her intention.
    const api = remindingApi();

    const { envelope } = await call(contextFor(api), "remind_me", {
      text: "Take the bread out of the oven.",
      when: FIVE_MINUTES,
      because: "He asked for it.",
    });

    expect(api.calls.map((made) => `${made.method} ${made.path}`)).toEqual([
      "GET /health",
      "POST /reminders",
      "GET /reminders/syl%3Areminder%3A0000",
    ]);
    if (envelope.ok) {
      expect((envelope.subject as { text: string }).text).toBe("as the store actually has it");
    }
  });

  it("should ask rather than guess when the time cannot be resolved, and write nothing", async () => {
    const api = remindingApi();

    const { envelope, isError } = await call(contextFor(api), "remind_me", {
      text: "Call the plumber.",
      when: { said: "later", kind: "relative", minutes: 30 },
      because: "He asked for it.",
    });

    expect(isError).toBe(true);
    // The question `time.ts` wrote, handed on verbatim — she says it to him.
    if (!envelope.ok) expect(envelope.reason).toContain("when exactly");
    expect(api.calls.filter((made) => made.method === "POST")).toEqual([]);
  });

  it("should refuse without a reason attached, because every write carries one", async () => {
    const api = remindingApi();

    const { envelope } = await call(contextFor(api), "remind_me", {
      text: "Call the plumber.",
      when: FIVE_MINUTES,
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toContain("because");
    expect(api.calls).toEqual([]);
  });

  it("should say what went wrong when the store refuses, in the store's own words", async () => {
    // `syl-009.3.5`. Silence after "I've set that for you" is the worst
    // outcome available, so the sentence has to survive all the way out.
    const api = fakeApi({
      "/reminders": () =>
        failure(422, "VALIDATION_FAILED", "That is not a wall time I can store.", false),
    });

    const { envelope, isError } = await call(contextFor(api), "remind_me", {
      text: "Call the plumber.",
      when: FIVE_MINUTES,
      because: "He asked for it.",
    });

    expect(isError).toBe(true);
    if (!envelope.ok) {
      expect(envelope.reason).toBe("That is not a wall time I can store.");
      expect(envelope.retryable).toBe(false);
    }
  });

  it("should admit uncertainty when the write landed and the read back did not", async () => {
    // The one case where "it failed" would be a lie in the dangerous direction.
    const api = fakeApi({
      "/reminders": (made) =>
        made.method === "POST"
          ? ok(storedReminder(), 201)
          : failure(500, "INTERNAL", "the store is unwell", true),
    });

    const { envelope } = await call(contextFor(api), "remind_me", {
      text: "Call the plumber.",
      when: FIVE_MINUTES,
      because: "He asked for it.",
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toMatch(/may well have gone through/u);
  });
});

describe("urgency, at the one place it is decided", () => {
  /** The urgent flag the store was actually asked for. */
  async function urgencyOf(
    quoted: string | undefined,
    hisMessage: string,
  ): Promise<unknown> {
    const api = remindingApi();
    await call(contextFor(api, hisMessage), "remind_me", {
      text: "Check the deploy.",
      when: FIVE_MINUTES,
      because: "He asked for it.",
      ...(quoted === undefined ? {} : { urgentBecauseHeSaid: quoted }),
    });
    return api.calls.find((made) => made.method === "POST")?.body?.["urgent"];
  }

  it("should let his own words through", async () => {
    expect(await urgencyOf("wake me for this", "wake me for this one, whatever the hour")).toBe(
      true,
    );
  });

  it("should NOT be satisfied by the field merely being present", async () => {
    // `syl-p8k`, stated as the assertion. `urgent: input.urgentBecauseHeSaid
    // !== undefined` is the one-liner that suggests itself here and it restores
    // the defect in full — the model satisfies a presence check by emitting any
    // string at all, and the cost is his house woken at three.
    expect(await urgencyOf("he would want this tonight", "remind me about Dave's birthday")).toBe(
      false,
    );
    expect(await urgencyOf("true", "remind me about Dave's birthday")).toBe(false);
    expect(await urgencyOf("", "remind me about Dave's birthday")).toBe(false);
  });

  it("should default to not urgent when she claims nothing", async () => {
    expect(await urgencyOf(undefined, "remind me about Dave's birthday")).toBe(false);
  });

  it("should grant nothing when his message cannot be established at all", async () => {
    // The unverifiable case — no turn file, or one that could not be read. It
    // must not read as permission.
    expect(await urgencyOf("wake me for this", "")).toBe(false);
  });
});

describe("the to-do and goal verbs", () => {
  it("should add a to-do and report the stored row", async () => {
    const api = fakeApi({
      "/todos": (made) =>
        made.method === "POST"
          ? ok({ id: "syl:todo:1", text: "Buy flour", status: "open", updatedAt: "2026-08-10T12:00:00.000Z" }, 201)
          : ok({ id: "syl:todo:1", text: "Buy flour", status: "open", updatedAt: "2026-08-10T12:00:00.000Z" }),
    });

    const { envelope } = await call(contextFor(api), "add_todo", {
      text: "Buy flour",
      because: "He said he was out.",
    });

    expect(envelope).toMatchObject({ ok: true, action: "add_todo" });
    expect(api.calls.map((made) => `${made.method} ${made.path}`)).toEqual([
      "POST /todos",
      "GET /todos/syl%3Atodo%3A1",
    ]);
  });

  it("should finish a to-do only when told which one", async () => {
    const { envelope } = await call(contextFor(fakeApi({})), "finish_todo", {
      because: "He said it is done.",
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toContain("which one");
  });

  it("should put the reason for a goal where the goal keeps one", async () => {
    // `because` has a home on this row and nowhere else in the contract, so it
    // is stored rather than only logged.
    const api = fakeApi({
      "/goals": (made) =>
        made.method === "POST"
          ? ok({ id: "syl:goal:1", title: "Run a half marathon", why: null, updatedAt: "" }, 201)
          : ok({ id: "syl:goal:1", title: "Run a half marathon", why: null, updatedAt: "" }),
    });

    await call(contextFor(api), "set_goal", {
      text: "Run a half marathon",
      because: "He has mentioned it three times this month.",
    });

    expect(api.calls[0]?.body).toEqual({
      title: "Run a half marathon",
      why: "He has mentioned it three times this month.",
    });
  });

  it("should read what is outstanding across all three lists", async () => {
    const api = fakeApi({
      "/reminders": () => ok({ items: [storedReminder()], nextCursor: null, hasMore: false }),
      "/todos": () => ok({ items: [], nextCursor: null, hasMore: false }),
      "/goals": () => ok({ items: [], nextCursor: null, hasMore: false }),
    });

    const { envelope } = await call(contextFor(api), "whats_outstanding", {});

    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(Object.keys(envelope.subject as object).sort()).toEqual([
        "goals",
        "reminders",
        "todos",
      ]);
    }
    // "Outstanding" means still to come. A reminder delivered last Tuesday is
    // not on his plate, so the reads are filtered rather than raw.
    expect(api.calls.map((made) => made.path)).toEqual([
      "/reminders?state=scheduled&limit=50",
      "/todos?status=open&limit=50",
      "/goals?status=active&limit=50",
    ]);
  });

  it("should read only the list she asked for", async () => {
    const api = fakeApi({ "/todos": () => ok({ items: [], nextCursor: null, hasMore: false }) });

    await call(contextFor(api), "whats_outstanding", { of: "todos" });

    expect(api.calls.map((made) => made.path)).toEqual(["/todos?status=open&limit=50"]);
  });
});

describe("when something goes wrong that nothing anticipated", () => {
  it("should still come back as a sentence rather than as a dead subprocess", async () => {
    // The last net. A handler that throws must not cross MCP as a stack trace
    // and reach him as silence.
    const context: ToolContext = {
      ...contextFor(fakeApi({})),
      hisMessage: () => {
        throw new Error("the turn file exploded");
      },
    };

    const { envelope, isError } = await call(context, "remind_me", {
      text: "Check the deploy.",
      when: FIVE_MINUTES,
      because: "He asked for it.",
      urgentBecauseHeSaid: "tonight",
    });

    expect(isError).toBe(true);
    if (!envelope.ok) expect(envelope.reason).toContain("the turn file exploded");
  });
});
