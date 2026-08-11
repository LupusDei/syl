import { loadSchemas, validateOrThrow } from "@syl/shared";
import { describe, expect, it } from "vitest";

import type { AdjutantClient } from "../../src/agents/adjutant-client.js";
import { SylApiClient, type FetchLike } from "../../src/tools/client.js";
import { TOOLS } from "../../src/tools/schemas.js";
import {
  advertisedTools,
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
    // No fleet by default: most verbs have nothing to do with the others, and
    // a test that had to opt OUT of reaching them would be a test that reached
    // them by accident.
    fleet: null,
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

/** The to-do these tests are about, and the goal. Real ids: `syl:<type>:<uuidv7>`. */
const THE_TODO = "syl:todo:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f";
const THE_GOAL = "syl:goal:0198f2c1-4a3b-7d21-9f00-0a0b0c0d0e0f";

/** `/todos/syl%3Atodo%3A…`, so the assertions read as paths rather than as escapes. */
const TODO_PATH = `/todos/${encodeURIComponent(THE_TODO)}`;
const GOAL_PATH = `/goals/${encodeURIComponent(THE_GOAL)}`;

/**
 * A stored to-do, in the contract's shape.
 *
 * Every field, including the ones this verb never touches. A fixture written
 * down to the fields a handler happens to read is a fixture that agrees with
 * the handler by construction, and the drift it would have caught is exactly
 * the kind that reaches him as a confident sentence about a row that does not
 * look like that. `the fixtures in this file` below measures it against
 * `openapi.yaml` rather than against our own types (constitution rule 1).
 */
function storedTodo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: THE_TODO,
    text: "Buy flour",
    goalId: null,
    dueAt: null,
    pinned: false,
    status: "open",
    source: "commander",
    delegatedJobId: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    completedAt: null,
    ...over,
  };
}

/** A stored goal, in the contract's shape. */
function storedGoal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: THE_GOAL,
    parentId: null,
    title: "Run a half marathon",
    why: null,
    targetDate: null,
    metricKey: null,
    targetValue: null,
    cadenceDays: null,
    status: "active",
    statusReason: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

/** A page, in the shape `/todos` and the rest actually answer with. */
function page(items: readonly unknown[]): unknown {
  return { items, nextCursor: null, hasMore: false };
}

/**
 * A store holding one to-do, which remembers what was done to it.
 *
 * Stateful rather than a constant answer, because the two facts these tests
 * turn on are both about state: a row read after a write must reflect the
 * write, and completing an already-done to-do must return it **unchanged** —
 * `TodoService.complete` says so, and it says so because the phone's outbox
 * retries that call by design and a retry that moved `completedAt` forward
 * would rewrite when he actually finished it.
 */
function todoApi(initial: Record<string, unknown> = storedTodo()): FakeApi {
  let row = initial;
  return fakeApi({
    [`${TODO_PATH}/complete`]: () => {
      if (row["status"] !== "done") {
        row = storedTodo({ ...row, status: "done", completedAt: new Date(NOW).toISOString() });
      }
      return ok(row);
    },
    [TODO_PATH]: () => ok(row),
    "/todos": (made) => (made.method === "POST" ? ok(row, 201) : ok(page([row]))),
  });
}

/** The sending these tests are about, and the render it is made from. */
const THE_SENDING = "syl:sending:0198f2c1-4a3b-7d21-9f00-2b3c4d5e6f70";
const SENDING_PATH = `/sendings/${encodeURIComponent(THE_SENDING)}`;
const THE_RENDER = "syl-20260811t090000z-close";

/** A stored sending, in the contract's shape. Every field, as above. */
function storedSending(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: THE_SENDING,
    words: "I thought of you when the light did that thing.",
    because: "He said he missed the sky.",
    messageId: "syl:message:0198f2c1-4a3b-7d21-9f00-3c4d5e6f7081",
    state: "pending",
    renderName: THE_RENDER,
    video: null,
    reason: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

/**
 * A store holding one sending.
 *
 * The row it answers a read with differs from the one it answers the write
 * with, on purpose — `syl-009.3.4`. If the envelope carried the write's own
 * echo this would pass while reporting her intention rather than what is
 * stored, which is the one difference that matters on the path where a write
 * was transformed or replayed.
 */
function sendingApi(
  stored: Record<string, unknown> = storedSending(),
  renders: readonly unknown[] = [{ name: THE_RENDER, status: "ready" }],
): FakeApi {
  return fakeApi({
    [SENDING_PATH]: () => ok(stored),
    "/sendings": (made) => (made.method === "POST" ? ok(storedSending(), 201) : ok(page([stored]))),
    // Read only on the path where she has not chosen a render, so the refusal
    // can tell "you have not made one yet" from "name the one you meant".
    "/renders": () => ok({ items: renders, unreadable: [], spend: null }),
  });
}

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
    // `remember` is declared in `schemas.ts` and there is still no route that
    // WRITES a memory. `syl-016.1` opened `/memory/recall` on her credential
    // and deliberately nothing else under `/memory`, so the read landed and
    // the write did not. Offering `remember` anyway would tell her she can keep
    // what he said about his life and answer 403 every time, which is the
    // defect this epic exists to fix, one layer along.
    expect(TOOLS.map((tool) => tool.name)).toContain("remember");
    expect(advertisedToolNames()).not.toContain("remember");
  });

  it("should refuse EVERY write that arrives without its reason, whatever the verb", async () => {
    // `tool-surface-budget` holds the same rule one layer up — that every verb
    // which changes something DECLARES `because` — and a declaration nothing
    // enforces is a field the model omits at 3am. This is the enforcing half,
    // and it is guarded by shape for the same reason: a seventh verb added next
    // month is covered without anyone remembering this file exists.
    //
    // A required field this table has no answer for fails loudly rather than
    // being skipped, so a new verb cannot slip through the guard by arriving
    // with a field nobody taught it.
    const plausible: Readonly<Record<string, unknown>> = {
      text: "Something he asked for.",
      when: FIVE_MINUTES,
      id: THE_TODO,
      fact: "His wife's birthday is in March.",
      // `ask_agent` — added when she gained a way to reach the fleet. The guard
      // failed loudly on these rather than skipping the verb, which is the
      // behaviour it was built for: a new verb cannot get past it by arriving
      // with fields nobody taught it.
      who: "treasurer",
      question: "What is he actually paying for health insurance?",
      // `render_me` — the first verb here that is about her rather than about
      // him, and the first one that spends money. It is held to the same rule,
      // which is the point of guarding by shape rather than by a list of names.
      scene: "she turns once and lets the light run down her arm",
      framing: "close_portrait",
      // `show_him` — the verb that reaches him unprompted, and therefore the
      // one where the reason is doing the most work: he cannot tell a gift
      // from a machine acting on his behalf without it.
      words: "I thought of you when the light did that thing.",
      renderName: THE_RENDER,
    };

    for (const tool of advertisedTools()) {
      const required = (tool.inputSchema as { required?: readonly string[] }).required ?? [];
      if (!required.includes("because")) continue;

      const args: Record<string, unknown> = {};
      for (const field of required) {
        if (field === "because") continue;
        const value = plausible[field];
        expect(value, `${tool.name} requires ${field} and this guard has no value for it`).toBeDefined();
        args[field] = value;
      }

      const api = todoApi();
      const { envelope, isError } = await call(contextFor(api), tool.name, args);

      expect(envelope.ok, `${tool.name} accepted a write with no reason`).toBe(false);
      expect(isError).toBe(true);
      if (!envelope.ok) expect(envelope.reason).toContain("because");
      // And nothing was written on the way to refusing. A verb that refuses
      // AFTER it has acted has not refused.
      expect(api.calls.filter((made) => made.method !== "GET")).toEqual([]);
    }
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

/**
 * `recall` — `syl-016.1`, the verb that lets her look at her own memory.
 *
 * The route's own behaviour is `memory-recall.test.ts`'s. What is being held
 * here is the seam: what goes on the wire, and what comes back to her.
 */
describe("recall", () => {
  const A_NODE = "syl:memory_node:0198f2c1-4a3b-7d21-9f00-2b2b2b2b2b2b";

  /** What the route answers, in the shape `routes/memory.ts` builds. */
  function recalled(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      generatedAt: new Date(NOW).toISOString(),
      asked: "the roofer",
      mode: "search",
      found: [
        {
          id: A_NODE,
          kind: "person",
          label: "the roofer",
          body: "replaced the gutter in March",
          updatedAt: new Date(NOW).toISOString(),
          origin: "matched",
          score: 0.32,
          channels: ["keyword"],
        },
      ],
      connections: [],
      channels: ["keyword"],
      ceiling: 0.4,
      limit: 10,
      more: null,
      byKind: [],
      explanation: "The best 10 match(es) for that question…",
      ...over,
    };
  }

  function recallApi(over: Record<string, unknown> = {}): FakeApi {
    return fakeApi({ "/memory/recall": () => ok(recalled(over)) });
  }

  it("should hand her the ids, unsummarised", async () => {
    // The bead in one assertion, at this layer. A verb built because she was
    // handed somebody else's summary must not summarise on the way past — and
    // an id is what every other verb in `syl-016` acts on.
    const api = recallApi();

    const { envelope } = await call(contextFor(api), "recall", { question: "the roofer" });

    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    const subject = envelope.subject as { found: { id: string }[] };
    expect(subject.found[0]?.id).toBe(A_NODE);
    expect(api.calls[0]?.path).toContain("q=the+roofer");
  });

  it("should ask nothing when she asks nothing, which is how the overflow opens", async () => {
    // `syl-016.2`. A present-but-empty `q` would make the wire say something
    // she did not; the route reads an absent one as "show me what you hid".
    const api = recallApi({ mode: "not_shown", asked: null });

    await call(contextFor(api), "recall", {});

    expect(api.calls[0]?.path).not.toContain("q=");
    expect(api.calls[0]?.method).toBe("GET");
  });

  it("should carry the names she decided the question is about", async () => {
    // `retrieve.ts`: extracting an entity from free text is a JUDGEMENT, and
    // judgement belongs to the model. Without them the structural channel has
    // nothing to work from and contributes zero.
    const api = recallApi();

    await call(contextFor(api), "recall", {
      question: "the gutter",
      about: ["the roofer", "  "],
      kind: "person",
      limit: 3,
    });

    const path = api.calls[0]?.path ?? "";
    expect(path).toContain("about=the+roofer");
    // The blank was dropped rather than sent: an entity that is whitespace is
    // not an entity, and passing it would have the ranker score against noise.
    expect(path).not.toContain("about=the+roofer%2C");
    expect(path).toContain("kind=person");
    expect(path).toContain("limit=3");
  });

  it("should not demand a reason for looking at what she already knows", async () => {
    // Every verb that CHANGES something carries `because`. This changes
    // nothing, and requiring a reason to remember would teach her the field is
    // decoration — which is what would then happen on the verbs where it is
    // load-bearing.
    const { envelope } = await call(contextFor(recallApi()), "recall", { question: "roofer" });

    expect(envelope.ok).toBe(true);
  });

  it("should turn a machine that cannot search into a sentence, never into silence", async () => {
    // `sqlite-vec` ships per-platform binaries as OPTIONAL dependencies, so
    // "absent" is a state `npm install` reports success for. She has to be able
    // to say "I could not look", which is a different sentence from "you never
    // told me about your brother".
    const api = fakeApi({
      "/memory/recall": () =>
        failure(
          503,
          "UPSTREAM_UNAVAILABLE",
          "Syl's memory cannot be searched on this machine right now.",
          true,
        ),
    });

    const { envelope, isError } = await call(contextFor(api), "recall", { question: "brother" });

    expect(isError).toBe(true);
    expect(envelope.ok).toBe(false);
    if (envelope.ok) return;
    expect(envelope.reason).toContain("cannot be searched");
    expect(envelope.retryable).toBe(true);
  });

  it("should report when it looked, so she is not inventing a moment", async () => {
    const { envelope } = await call(contextFor(recallApi()), "recall", { question: "roofer" });

    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(envelope.at).toBe(new Date(NOW).toISOString());
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

describe("the fixtures in this file", () => {
  it("should be the shapes the contract publishes, not the shapes our types allow", async () => {
    // Constitution rule 1, applied to the one layer where it is cheap to skip:
    // these rows never come from the service in a unit test, so nothing but
    // this measures them against `openapi.yaml`. A handler that reads a field
    // the contract does not carry passes every test in this file otherwise.
    const schemas = loadSchemas();

    validateOrThrow(schemas, "Todo", storedTodo(), "storedTodo()");
    validateOrThrow(schemas, "Todo", storedTodo({ status: "done", completedAt: new Date(NOW).toISOString() }), "a finished storedTodo()");
    validateOrThrow(schemas, "Goal", storedGoal(), "storedGoal()");
    validateOrThrow(schemas, "TodoPage", page([storedTodo()]), "a page of to-dos");
    validateOrThrow(schemas, "Sending", storedSending(), "storedSending()");
    validateOrThrow(
      schemas,
      "Sending",
      storedSending({ state: "failed", reason: "There is no render by that name." }),
      "a storedSending() whose video will never come",
    );
  });
});

/**
 * The verb that reaches him, and the one acceptance 3 and 4 rest on.
 *
 * Everything else on this surface answers something he started. This one is
 * her deciding to say something, so the tests are about the two halves that
 * make it hers: **the words go whatever happens to the video**, and **it will
 * not go without a face**.
 */
describe("show_him — saying something to him in her own face", () => {
  it("should be a verb she is actually offered, so nothing has to name it twice", () => {
    // The heartbeat derives its `allowedTools` from this list. A verb that
    // existed only in `schemas.ts` would be advertised and unperformable; one
    // named by hand in the heartbeat instead would drift the day it is
    // renamed.
    expect(advertisedToolNames()).toContain("show_him");
  });

  it("should say it to him and report the sending the STORE has", async () => {
    const api = sendingApi(storedSending({ words: "as the store actually has it" }));

    const { envelope } = await call(contextFor(api), "show_him", {
      words: "I thought of you when the light did that thing.",
      because: "He said he missed the sky.",
      renderName: THE_RENDER,
    });

    expect(api.calls.map((made) => `${made.method} ${made.path}`)).toEqual([
      "POST /sendings",
      `GET ${SENDING_PATH}`,
    ]);
    expect(api.calls[0]?.body).toEqual({
      words: "I thought of you when the light did that thing.",
      because: "He said he missed the sky.",
      renderName: THE_RENDER,
    });
    expect(envelope).toMatchObject({ ok: true, action: "show_him" });
    if (envelope.ok) {
      const subject = envelope.subject as { words: string; state: string };
      expect(subject.words).toBe("as the store actually has it");
      // `pending` is the honest answer: the words are his and the video is
      // still being made. Reporting `ready` here would have her describing a
      // clip that does not exist yet.
      expect(subject.state).toBe("pending");
      expect(envelope.at).toBe(new Date(NOW).toISOString());
    }
  });

  it("should refuse with nothing to say, and say nothing", async () => {
    const api = sendingApi();

    const { envelope, isError } = await call(contextFor(api), "show_him", {
      because: "He said he missed the sky.",
      renderName: THE_RENDER,
    });

    expect(isError).toBe(true);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toContain("words");
    // Refused before anything left this process. A verb that refuses after it
    // has acted has not refused.
    expect(api.calls).toEqual([]);
  });

  it("should refuse to go without a face, and say plainly that that is what a sending is", async () => {
    // The definition rather than a validation choice: a sending is her saying
    // something IN HER OWN FACE, and words with no face is an ordinary
    // message she already has a conversation for. The refusal has to say that
    // — she turns it into a sentence, and "renderName is required" is not one.
    const api = sendingApi();

    const { envelope, isError } = await call(contextFor(api), "show_him", {
      words: "I thought of you when the light did that thing.",
      because: "He said he missed the sky.",
    });

    expect(isError).toBe(true);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.reason).toMatch(/face/iu);
      expect(envelope.reason).toContain("renderName");
      // And it tells her how to choose one rather than only that she must.
      expect(envelope.reason).toContain("see_myself");
      // Retryable: she can render herself, or name one she already made, and
      // call again. That is a materially different instruction from "this
      // cannot work".
      expect(envelope.retryable).toBe(true);
    }
    // Nothing was written on the way to refusing. Looking at what she has
    // rendered is a read and is the whole point of this path.
    expect(api.calls.filter((made) => made.method !== "GET")).toEqual([]);
  });

  it("should refuse `latest`, because a sending is the one she CHOSE", async () => {
    // Not style. `latest` resolves at creation to whatever render was made
    // most recently, and the voice track is about to start writing voiced
    // clips as their own records — so `latest` will begin returning
    // derivatives rather than originals, silently, with nothing failing when
    // it does. **A sending refuses UPDATE**, so the wrong `renderName` is
    // permanent from the first write and the immutability trigger cannot help:
    // it refuses re-pointing a row, not recording the wrong value at creation.
    // An immutable record of the wrong thing is worse than a mutable one.
    const api = sendingApi();

    const { envelope, isError } = await call(contextFor(api), "show_him", {
      words: "I thought of you when the light did that thing.",
      because: "He said he missed the sky.",
      renderName: "latest",
    });

    expect(isError).toBe(true);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.reason).toMatch(/see_myself/u);
      expect(envelope.retryable).toBe(true);
    }
    expect(api.calls.filter((made) => made.method !== "GET")).toEqual([]);
  });

  it("should tell her she has not rendered anything yet, when that is the actual situation", async () => {
    // A different situation with a different next step, so it gets a different
    // sentence. "Name the one you meant" is useless advice to somebody with
    // nothing to name.
    const api = sendingApi(storedSending(), []);

    const { envelope } = await call(contextFor(api), "show_him", {
      words: "I thought of you when the light did that thing.",
      because: "He said he missed the sky.",
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.reason).toContain("render_me");
      expect(envelope.reason).not.toContain("see_myself");
    }
    expect(api.calls.filter((made) => made.method !== "GET")).toEqual([]);
  });

  it("should still refuse when it cannot see what she has rendered", async () => {
    // The read is there to choose the better sentence, never to decide whether
    // to refuse. A service that could not answer must not become a path into
    // composing without a face.
    const api = fakeApi({
      "/renders": () => failure(500, "INTERNAL", "the studio is unreadable", true),
      "/sendings": () => ok(storedSending(), 201),
    });

    const { envelope, isError } = await call(contextFor(api), "show_him", {
      words: "Hello.",
      because: "b",
    });

    expect(isError).toBe(true);
    expect(envelope.ok).toBe(false);
    expect(api.calls.filter((made) => made.method !== "GET")).toEqual([]);
  });

  it("should still be a success when the render named does not exist, because the words went anyway", async () => {
    // The edge case the whole feature is built around. A name she
    // half-remembered costs the VIDEO and nothing else: her words are already
    // in his conversation and already carried the notification, and the row
    // says so. Reporting this as a failure would have her apologising for a
    // message he has read.
    const api = sendingApi(
      storedSending({ state: "failed", reason: "There is no render by that name, so this one goes without a video." }),
    );

    const { envelope, isError } = await call(contextFor(api), "show_him", {
      words: "I made you something.",
      because: "He said he missed the sky.",
      renderName: "syl-nonexistent",
    });

    expect(isError).toBe(false);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      const subject = envelope.subject as { state: string; reason: string; words: string };
      expect(subject.state).toBe("failed");
      expect(subject.reason).toMatch(/no render/iu);
      // And the words are on the row, which is where he reads them from.
      expect(subject.words).not.toBe("");
    }
  });

  it("should say what went wrong when her own service refuses, in its own words", async () => {
    const api = fakeApi({
      "/sendings": () =>
        failure(422, "VALIDATION_FAILED", "words is required.", false),
    });

    const { envelope, isError } = await call(contextFor(api), "show_him", {
      words: "Hello.",
      because: "b",
      renderName: THE_RENDER,
    });

    expect(isError).toBe(true);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toBe("words is required.");
  });

  it("should not claim it reached him when the row could not be read back", async () => {
    const api = fakeApi({
      "/sendings": (made) =>
        made.method === "POST"
          ? ok(storedSending(), 201)
          : failure(500, "INTERNAL", "the store fell over", true),
    });

    const { envelope } = await call(contextFor(api), "show_him", {
      words: "Hello.",
      because: "b",
      renderName: THE_RENDER,
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toMatch(/may well have gone through/iu);
  });
});

describe("add_todo", () => {
  it("should put it on his list and report the row the STORE has", async () => {
    // `syl-009.3.4`. The echo and the stored row differ on purpose: if the
    // envelope carried what the write said it did, this passes while reporting
    // her intention rather than his list.
    const api = fakeApi({
      [TODO_PATH]: () => ok(storedTodo({ text: "as the store actually has it" })),
      "/todos": () => ok(storedTodo(), 201),
    });

    const { envelope } = await call(contextFor(api), "add_todo", {
      text: "Buy flour",
      because: "He said he was out.",
    });

    expect(api.calls.map((made) => `${made.method} ${made.path}`)).toEqual([
      "POST /todos",
      `GET ${TODO_PATH}`,
    ]);
    expect(envelope).toMatchObject({ ok: true, action: "add_todo" });
    if (envelope.ok) {
      expect((envelope.subject as { text: string }).text).toBe("as the store actually has it");
      // The moment the row was last written, so she can say what she did
      // without inventing a time for it.
      expect(envelope.at).toBe(new Date(NOW).toISOString());
    }
  });

  it("should refuse with nothing to add, and write nothing", async () => {
    const api = todoApi();

    const { envelope, isError } = await call(contextFor(api), "add_todo", {
      because: "He said he was out.",
    });

    expect(isError).toBe(true);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toContain("text");
    expect(api.calls).toEqual([]);
  });

  it("should say what went wrong when the store refuses, in the store's own words", async () => {
    const api = fakeApi({
      "/todos": () => failure(422, "VALIDATION_FAILED", "A to-do must say something.", false),
    });

    const { envelope, isError } = await call(contextFor(api), "add_todo", {
      text: "Buy flour",
      because: "He said he was out.",
    });

    expect(isError).toBe(true);
    if (!envelope.ok) {
      expect(envelope.reason).toBe("A to-do must say something.");
      expect(envelope.retryable).toBe(false);
    }
  });

  it("should admit uncertainty when the write landed and the read back did not", async () => {
    // "It failed" would be a lie in the dangerous direction here: the to-do is
    // on his list and she would be telling him it is not.
    const api = fakeApi({
      [TODO_PATH]: () => failure(500, "INTERNAL", "the store is unwell", true),
      "/todos": () => ok(storedTodo(), 201),
    });

    const { envelope } = await call(contextFor(api), "add_todo", {
      text: "Buy flour",
      because: "He said he was out.",
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toMatch(/may well have gone through/u);
  });
});

/**
 * The one verb that takes something away.
 *
 * The dangerous case is not a bad id — a bad id is loud. It is her *inferring*
 * that he finished something. Nothing in a schema can tell a machine whether
 * that inference is right, so the tests here are about the two things that can
 * be arranged instead: she must never write on a guess she has not checked, and
 * whatever she says afterwards must NAME the item, because him hearing the
 * wrong title is the only place a wrong guess can still be caught.
 */
describe("finish_todo — the verb that removes", () => {
  it("should mark it done and report the stored row, with the moment it was finished", async () => {
    const api = todoApi();

    const { envelope } = await call(contextFor(api), "finish_todo", {
      id: THE_TODO,
      because: "He said he had done it.",
    });

    expect(envelope).toMatchObject({ ok: true, action: "finish_todo" });
    if (envelope.ok) {
      const row = envelope.subject as { text: string; status: string };
      // Named, in his words. This is the guard: she reports what LEFT his list,
      // so a wrong inference is audible in the same breath she acts on it.
      expect(row.text).toBe("Buy flour");
      expect(row.status).toBe("done");
      expect(envelope.at).toBe(new Date(NOW).toISOString());
    }
  });

  it("should look it up before it writes, so a wrong id takes nothing off his list", async () => {
    // A stale or half-remembered id is the shape a wrong guess usually arrives
    // in. Reading first makes it a question rather than a write.
    const api = fakeApi({
      "/todos": () => failure(404, "NOT_FOUND", "There is no such to-do.", false),
    });

    const { envelope, isError } = await call(contextFor(api), "finish_todo", {
      id: THE_TODO,
      because: "He said he had done it.",
    });

    expect(isError).toBe(true);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.reason).toContain("There is no such to-do.");
      // And it must say so: "I could not" and "nothing changed" are different
      // sentences, and only one of them lets him stop worrying about the list.
      expect(envelope.reason).toMatch(/nothing has come off/iu);
    }
    expect(api.calls.map((made) => made.method)).toEqual(["GET"]);
  });

  it("should not claim to have finished something that was already finished", async () => {
    // The second shape of a wrong guess: an id from a list she read two turns
    // ago, for an item that has since been ticked off. The store would answer
    // this happily — `complete` on a done row returns it unchanged — and she
    // would report having just done it. That is her claiming an act she did not
    // perform, about an item she may have picked by mistake.
    const finished = new Date(NOW - 3_600_000).toISOString();
    const api = todoApi(storedTodo({ status: "done", completedAt: finished, updatedAt: finished }));

    const { envelope, isError } = await call(contextFor(api), "finish_todo", {
      id: THE_TODO,
      because: "He said he had done it.",
    });

    expect(isError).toBe(true);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.reason).toContain("Buy flour");
      expect(envelope.reason).toContain(finished);
      expect(envelope.retryable).toBe(false);
    }
    // Nothing written. Not for the store's sake — it is idempotent — but so
    // that `turn.tool` and the log do not record an act that did not happen.
    expect(api.calls.filter((made) => made.method !== "GET")).toEqual([]);
  });

  it("should refuse without an id, and point at where an id comes from", async () => {
    const api = todoApi();

    const { envelope } = await call(contextFor(api), "finish_todo", {
      because: "He said it is done.",
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toContain("which one");
    expect(api.calls).toEqual([]);
  });

  it("should admit uncertainty when the completion landed and the read back did not", async () => {
    // Worst of both: telling him it failed would leave him doing a thing he has
    // already done, and telling him it worked would be a guess.
    let reads = 0;
    const api = fakeApi({
      [`${TODO_PATH}/complete`]: () => ok(storedTodo({ status: "done", completedAt: new Date(NOW).toISOString() })),
      [TODO_PATH]: () => {
        reads += 1;
        return reads === 1 ? ok(storedTodo()) : failure(500, "INTERNAL", "the store is unwell", true);
      },
    });

    const { envelope } = await call(contextFor(api), "finish_todo", {
      id: THE_TODO,
      because: "He said he had done it.",
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toMatch(/may well have gone through/u);
  });
});

describe("set_goal", () => {
  it("should record it and report the row the store has", async () => {
    const api = fakeApi({
      [GOAL_PATH]: () => ok(storedGoal({ why: "He has mentioned it three times this month." })),
      "/goals": () => ok(storedGoal(), 201),
    });

    const { envelope } = await call(contextFor(api), "set_goal", {
      text: "Run a half marathon",
      because: "He has mentioned it three times this month.",
    });

    expect(api.calls.map((made) => `${made.method} ${made.path}`)).toEqual([
      "POST /goals",
      `GET ${GOAL_PATH}`,
    ]);
    expect(envelope).toMatchObject({ ok: true, action: "set_goal" });
    if (envelope.ok) {
      expect((envelope.subject as { why: string }).why).toBe(
        "He has mentioned it three times this month.",
      );
    }
  });

  it("should put the reason for a goal where the goal keeps one", async () => {
    // `because` has a home on this row and nowhere else in the contract, so it
    // is stored rather than only logged.
    const api = fakeApi({
      [GOAL_PATH]: () => ok(storedGoal()),
      "/goals": () => ok(storedGoal(), 201),
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

  it("should refuse with no goal to record, and write nothing", async () => {
    const api = fakeApi({ "/goals": () => ok(storedGoal(), 201) });

    const { envelope, isError } = await call(contextFor(api), "set_goal", {
      because: "He has mentioned it three times this month.",
    });

    expect(isError).toBe(true);
    if (!envelope.ok) expect(envelope.reason).toContain("goal");
    expect(api.calls).toEqual([]);
  });

  it("should say what went wrong when the store refuses, in the store's own words", async () => {
    const api = fakeApi({
      "/goals": () => failure(422, "VALIDATION_FAILED", "A goal must have a title.", false),
    });

    const { envelope, isError } = await call(contextFor(api), "set_goal", {
      text: "Run a half marathon",
      because: "He has mentioned it three times this month.",
    });

    expect(isError).toBe(true);
    if (!envelope.ok) expect(envelope.reason).toBe("A goal must have a title.");
  });
});

describe("whats_outstanding", () => {
  it("should read what is outstanding across all three lists", async () => {
    const api = fakeApi({
      "/reminders": () => ok(page([storedReminder()])),
      "/todos": () => ok(page([storedTodo()])),
      "/goals": () => ok(page([storedGoal()])),
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
    const api = fakeApi({ "/todos": () => ok(page([])) });

    await call(contextFor(api), "whats_outstanding", { of: "todos" });

    expect(api.calls.map((made) => made.path)).toEqual(["/todos?status=open&limit=50"]);
  });

  it("should show him everything rather than nothing when the filter is not one she has", async () => {
    // The failure this prevents is silent and is the worst answer available: a
    // filter she misspelled matches no list, every list goes unread, and the
    // envelope comes back `ok` and empty — which she reports as "you have
    // nothing outstanding". Widening cannot mislead him; an empty answer can.
    const api = fakeApi({
      "/reminders": () => ok(page([])),
      "/todos": () => ok(page([storedTodo()])),
      "/goals": () => ok(page([])),
    });

    const { envelope } = await call(contextFor(api), "whats_outstanding", { of: "tasks" });

    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(Object.keys(envelope.subject as object).sort()).toEqual([
        "goals",
        "reminders",
        "todos",
      ]);
    }
  });

  it("should refuse rather than half-answer when one of the lists cannot be read", async () => {
    // A partial list is indistinguishable from a short one. "You have nothing
    // else on" is a sentence she must not say from a page that never arrived.
    const api = fakeApi({
      "/reminders": () => ok(page([])),
      "/todos": () => ok(page([storedTodo()])),
      "/goals": () => failure(503, "UNAVAILABLE", "The store is not answering.", true),
    });

    const { envelope, isError } = await call(contextFor(api), "whats_outstanding", {});

    expect(isError).toBe(true);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.reason).toBe("The store is not answering.");
      expect(envelope.retryable).toBe(true);
    }
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
/**
 * `cancel_reminder` and `change_reminder` — the verbs he asked for by name.
 *
 * He told her to remove two reminders and she could not, and said so:
 *
 * > "I could not remove the 1:45 and 5:45 ones... I'm not going to tell you
 * > they're gone when they aren't."
 *
 * The honesty was right and the gap was real: a thing that can only create and
 * never cancel accumulates junk until he stops trusting the list. These tests
 * hold the two properties that make handing her the verbs safe — she reads
 * before she writes, and whatever she says afterwards NAMES what she touched,
 * because him hearing the wrong reminder read back is the last place a wrong id
 * is catchable.
 */
describe("cancel_reminder — the verb that stops something firing", () => {
  const REMINDER_PATH = "/reminders/syl%3Areminder%3A0000";

  function reminderApi(initial = storedReminder()): FakeApi {
    let row = initial;
    return fakeApi({
      [REMINDER_PATH]: (made) => {
        if (made.method === "DELETE") row = storedReminder({ ...row, deliveryState: "cancelled" });
        if (made.method === "PATCH") row = storedReminder({ ...row, ...made.body });
        return ok(row);
      },
    });
  }

  it("should cancel it and name what it cancelled", async () => {
    const api = reminderApi();

    const { envelope } = await call(contextFor(api), "cancel_reminder", {
      id: "syl:reminder:0000",
      because: "He asked me to remove it.",
    });

    expect(envelope).toMatchObject({ ok: true, action: "cancel_reminder" });
    if (envelope.ok) {
      const row = envelope.subject as { text: string; deliveryState: string };
      expect(row.text).toBe("Take the bread out of the oven.");
      expect(row.deliveryState).toBe("cancelled");
    }
  });

  it("should look it up before it writes, so a wrong id cancels nothing", async () => {
    const api = fakeApi({
      [REMINDER_PATH]: () => failure(404, "NOT_FOUND", "There is no such reminder.", false),
    });

    const { envelope, isError } = await call(contextFor(api), "cancel_reminder", {
      id: "syl:reminder:0000",
      because: "He asked me to remove it.",
    });

    expect(isError).toBe(true);
    expect(api.calls.some((made) => made.method === "DELETE")).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toContain("nothing has been called off");
  });

  it("should refuse rather than claim it just cancelled one that was already cancelled", async () => {
    // The write would SUCCEED and she would announce having stopped something
    // she did not touch — about a reminder she may have picked by mistake.
    const api = reminderApi(storedReminder({ deliveryState: "cancelled" }));

    const { envelope } = await call(contextFor(api), "cancel_reminder", {
      id: "syl:reminder:0000",
      because: "He asked me to remove it.",
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.reason).toContain("already cancelled");
      expect(envelope.retryable).toBe(false);
    }
  });

  it("should move a reminder without disturbing what he did not mention", async () => {
    // The reason this is not "cancel it and make a new one": he is thinking of
    // it as the SAME reminder, and a patch that sent every field back would
    // quietly overwrite the ones she did not think to include.
    const api = reminderApi();

    const { envelope } = await call(contextFor(api), "change_reminder", {
      id: "syl:reminder:0000",
      when: { said: "at 8pm", kind: "time_of_day", wallTime: "20:00" },
      because: "He moved it.",
    });

    expect(envelope).toMatchObject({ ok: true, action: "change_reminder" });
    const patch = api.calls.find((made) => made.method === "PATCH")?.body ?? {};
    expect(patch["wallTime"]).toBe("20:00");
    // Untouched, and absent rather than sent back as itself.
    expect(patch["text"]).toBeUndefined();
  });

  it("should ask rather than guess when he is vague about the new time", async () => {
    // The vagueness veto applies to a MOVE exactly as it does to a creation —
    // "push it back a bit" has the same way of being wrong.
    const api = reminderApi();

    const { envelope } = await call(contextFor(api), "change_reminder", {
      id: "syl:reminder:0000",
      when: { said: "later", kind: "relative" },
      because: "He moved it.",
    });

    expect(envelope.ok).toBe(false);
    expect(api.calls.some((made) => made.method === "PATCH")).toBe(false);
  });

  it("should refuse a change that changes nothing rather than report success", async () => {
    // A silent no-op reads to her as success, and she tells him it moved.
    const api = reminderApi();

    const { envelope } = await call(contextFor(api), "change_reminder", {
      id: "syl:reminder:0000",
      because: "He said to change it.",
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toContain("did not catch what to change");
    expect(api.calls.some((made) => made.method === "PATCH")).toBe(false);
  });
});

/**
 * `drop_todo` — abandoning is not finishing.
 *
 * Two facts about his life that a single verb would have flattened: one is an
 * achievement, the other is a decision, and he may want to tell them apart in
 * six months. The store already knew — `dropped` has been in `TodoStatus`
 * since the table was written — and only the vocabulary was missing.
 */
describe("drop_todo — the verb that gives up", () => {
  it("should mark it dropped and name what left the list", async () => {
    const api = todoApi();

    const { envelope } = await call(contextFor(api), "drop_todo", {
      id: THE_TODO,
      because: "He said he is not going to do it.",
    });

    expect(envelope).toMatchObject({ ok: true, action: "drop_todo" });
    const patch = api.calls.find((made) => made.method === "PATCH")?.body ?? {};
    expect(patch["status"]).toBe("dropped");
    if (envelope.ok) expect((envelope.subject as { text: string }).text).toBe("Buy flour");
  });

  it("should refuse to restyle something he actually finished", async () => {
    // Rewriting a completed item as abandoned edits his history, and he is the
    // only one who can say which it was.
    const api = todoApi(storedTodo({ status: "done", completedAt: new Date(NOW).toISOString() }));

    const { envelope } = await call(contextFor(api), "drop_todo", {
      id: THE_TODO,
      because: "He said to drop it.",
    });

    expect(envelope.ok).toBe(false);
    expect(api.calls.some((made) => made.method === "PATCH")).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toContain("already marked done");
  });

  it("should look it up before it writes, so a wrong id drops nothing", async () => {
    const api = fakeApi({
      [TODO_PATH]: () => failure(404, "NOT_FOUND", "There is no such to-do.", false),
    });

    const { isError } = await call(contextFor(api), "drop_todo", {
      id: THE_TODO,
      because: "He said to drop it.",
    });

    expect(isError).toBe(true);
    expect(api.calls.some((made) => made.method === "PATCH")).toBe(false);
  });
});

/**
 * `change_goal` — the three ways a goal ends, kept apart.
 *
 * One verb, because achieving, abandoning and setting aside are one change to
 * one row and three verbs would have to agree about what each leaves behind.
 * The DISTINCTION survives in the enum, which is the half that matters to him:
 * "I did it", "I decided not to" and "not now" are three different things that
 * happened in his life, and a system that flattened them would make his own
 * history unreadable a year later.
 */
describe("change_goal — the verb that ends one", () => {
  function goalApi(initial = storedGoal()): FakeApi {
    let row = initial;
    return fakeApi({
      [GOAL_PATH]: (made) => {
        if (made.method === "PATCH") row = { ...row, ...made.body };
        return ok(row);
      },
    });
  }

  it("should carry his reason into the goal's own record of why it ended", async () => {
    const api = goalApi();

    const { envelope } = await call(contextFor(api), "change_goal", {
      id: THE_GOAL,
      status: "abandoned",
      because: "He decided the video series matters more.",
    });

    expect(envelope).toMatchObject({ ok: true, action: "change_goal" });
    const patch = api.calls.find((made) => made.method === "PATCH")?.body ?? {};
    expect(patch["status"]).toBe("abandoned");
    // The `because` becomes the goal's `statusReason`, so a year from now the
    // row can say why it ended and not only that it did.
    expect(patch["statusReason"]).toBe("He decided the video series matters more.");
  });

  it("should reword without touching the state, and change state without rewording", async () => {
    const api = goalApi();

    await call(contextFor(api), "change_goal", {
      id: THE_GOAL,
      text: "Cook for the family three nights a week",
      because: "He restated it.",
    });

    const patch = api.calls.find((made) => made.method === "PATCH")?.body ?? {};
    expect(patch["title"]).toBe("Cook for the family three nights a week");
    expect(patch["status"]).toBeUndefined();
    // No state change, so no reason attached to one.
    expect(patch["statusReason"]).toBeUndefined();
  });

  it("should refuse a change that changes nothing rather than report success", async () => {
    const api = goalApi();

    const { envelope } = await call(contextFor(api), "change_goal", {
      id: THE_GOAL,
      because: "He said to change it.",
    });

    expect(envelope.ok).toBe(false);
    expect(api.calls.some((made) => made.method === "PATCH")).toBe(false);
  });

  it("should look it up before it writes", async () => {
    const api = fakeApi({
      [GOAL_PATH]: () => failure(404, "NOT_FOUND", "There is no such goal.", false),
    });

    const { isError } = await call(contextFor(api), "change_goal", {
      id: THE_GOAL,
      status: "achieved",
      because: "He said he did it.",
    });

    expect(isError).toBe(true);
    expect(api.calls.some((made) => made.method === "PATCH")).toBe(false);
  });
});

/**
 * `syl-y82` — the reason she was required to give, and then kept.
 *
 * `remind_me` demanded `because` from the day it shipped and threw it away.
 * artanis found it the way it had to be found: reading the store while chasing
 * something else, seeing "text Ela and tell her you love her" with a message
 * drafted, and telling the Commander nobody had asked her for it. He had
 * asked. **If it fooled a careful reader with the database open, it will fool
 * him with a notification.**
 *
 * `SOUL.md` promises two things about anticipation — that he can tell a good
 * suggestion from a wrong one, and that he can tell her to stop making a kind
 * he does not want. Both were false while this was dropped on the floor.
 */
describe("a reminder remembers why it exists", () => {
  it("should carry his reason into the store", async () => {
    const api = fakeApi({
      "/reminders": (made) => (made.method === "POST" ? ok(storedReminder(), 201) : ok(page([]))),
      "/reminders/syl%3Areminder%3A0000": () => ok(storedReminder()),
      "/health": () => ok({ now: new Date(NOW).toISOString() }),
    });

    await call(contextFor(api, "Remind me at 6 to text Ela."), "remind_me", {
      text: "Text Ela and tell her you love her.",
      when: { said: "at 6pm", kind: "time_of_day", wallTime: "18:00" },
      because: "He mentioned she has had a hard week.",
      origin: "he_asked",
    });

    const posted = api.calls.find((made) => made.method === "POST")?.body ?? {};
    expect(posted["because"]).toBe("He mentioned she has had a hard week.");
  });

  it("should record that SHE thought of it when he never spoke", async () => {
    // Derived, not claimed. A heartbeat or dream turn carries no message from
    // him, so it cannot be a response to one — and those are exactly the 3am
    // reminders, the case where he most needs to know it was hers.
    const api = fakeApi({
      "/reminders": (made) => (made.method === "POST" ? ok(storedReminder(), 201) : ok(page([]))),
      "/reminders/syl%3Areminder%3A0000": () => ok(storedReminder()),
      "/health": () => ok({ now: new Date(NOW).toISOString() }),
    });

    // No message from him at all — a heartbeat or a dream turn.
    await call(contextFor(api, ""), "remind_me", {
      text: "Dave's birthday is Thursday.",
      when: { said: "tomorrow morning", kind: "part_of_day", part: "morning", day: "tomorrow" },
      because: "He mentioned Dave in March.",
      // She claims he asked. He did not say anything at all this turn.
      origin: "he_asked",
    });

    const posted = api.calls.find((made) => made.method === "POST")?.body ?? {};
    expect(posted["origin"]).toBe("she_noticed");
  });

  it("should fall to 'she noticed' when she does not claim he asked", async () => {
    // The asymmetry, which is the whole design: a wrong "she noticed" gives her
    // less credit than she is owed and is harmless. A wrong "he asked" tells
    // him he said something he did not — the failure that fooled a careful
    // reader. Silence falls the safe way.
    const api = fakeApi({
      "/reminders": (made) => (made.method === "POST" ? ok(storedReminder(), 201) : ok(page([]))),
      "/reminders/syl%3Areminder%3A0000": () => ok(storedReminder()),
      "/health": () => ok({ now: new Date(NOW).toISOString() }),
    });

    await call(contextFor(api, "I'm heading to Tennessee Friday."), "remind_me", {
      text: "Pack for Tennessee.",
      when: { said: "at 8pm", kind: "time_of_day", wallTime: "20:00" },
      because: "He is travelling Friday.",
    });

    const posted = api.calls.find((made) => made.method === "POST")?.body ?? {};
    expect(posted["origin"]).toBe("she_noticed");
  });
});

/**
 * `ask_agent` — she can reach the fleet, under her own name, on his behalf.
 *
 * `syl-014`. The Commander wants her asking the treasurer what his insurance
 * actually costs. Three properties make that safe enough to hand her, and each
 * is here because leaving it out was the tempting version.
 */
describe("ask_agent — putting a question to someone who knows more", () => {
  const fleet = (
    result: Awaited<ReturnType<AdjutantClient["ask"]>>,
  ): { asked: { who: string; body: string }[]; client: AdjutantClient } => {
    const asked: { who: string; body: string }[] = [];
    return {
      asked,
      client: {
        ask: async (who: string, body: string) => {
          asked.push({ who, body });
          return result;
        },
      } as unknown as AdjutantClient,
    };
  };

  const sent = {
    ok: true as const,
    data: { messageId: "msg-1", at: new Date(NOW).toISOString() },
  };

  it("should ask, and report having ASKED rather than having an answer", async () => {
    // The distinction the whole verb turns on. Agents are offline most of the
    // time — `treasurer` was not live when this was written — so a verb that
    // implied an answer would have her telling him the treasurer said something.
    const { asked, client } = fleet(sent);

    const { envelope } = await call(
      { ...contextFor(fakeApi({})), fleet: client },
      "ask_agent",
      {
        who: "treasurer",
        question: "What is he paying for health insurance?",
        because: "He asked me to find out.",
      },
    );

    expect(envelope).toMatchObject({ ok: true, action: "ask_agent" });
    expect(asked).toEqual([
      { who: "treasurer", body: "What is he paying for health insurance?" },
    ]);
    if (envelope.ok) {
      const subject = envelope.subject as Record<string, unknown>;
      expect(subject["who"]).toBe("treasurer");
      // No answer field to mistake for one.
      expect(subject["answer"]).toBeUndefined();
    }
  });

  it("should refuse someone off the roster WITHOUT sending, and name who she can ask", async () => {
    // The roster is checked before the transport, so a name she should not
    // reach never leaves this process — and the refusal is something she can
    // turn into a sentence for him.
    const { asked, client } = fleet(sent);

    const { envelope } = await call(
      { ...contextFor(fakeApi({})), fleet: client },
      "ask_agent",
      { who: "nova", question: "Anything.", because: "He asked." },
    );

    expect(envelope.ok).toBe(false);
    expect(asked).toEqual([]);
    if (!envelope.ok) {
      expect(envelope.reason).toContain("nova");
      expect(envelope.reason).toContain("treasurer");
    }
  });

  it("should say plainly that it did not ask when it could not", async () => {
    // "I could not reach them" and "they have not replied yet" are different
    // facts and he acts differently on each. Reporting the first as the second
    // is the failure this project keeps finding.
    const { client } = fleet({
      ok: false as const,
      failure: {
        kind: "unreachable" as const,
        operation: "ask" as const,
        message: "Adjutant did not answer.",
        retryable: true,
      },
    });

    const { envelope } = await call(
      { ...contextFor(fakeApi({})), fleet: client },
      "ask_agent",
      { who: "treasurer", question: "Anything.", because: "He asked." },
    );

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toContain("I have not asked treasurer");
  });

  it("should answer without a fleet rather than throw", async () => {
    // Adjutant is optional. A machine without one is not misconfigured — it is
    // a machine where she talks only to him — and it must not take a turn down.
    const { envelope } = await call(
      { ...contextFor(fakeApi({})), fleet: null },
      "ask_agent",
      { who: "treasurer", question: "Anything.", because: "He asked." },
    );

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.reason).toContain("no way to reach");
  });
});





