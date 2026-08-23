import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MEMORY_TOOL_NAME,
  AskSylIngress,
  COLD_LANE_LINE,
  TOO_SLOW_LINE,
  TURN_FAILED_LINE,
} from "../../src/face/ask-syl.js";
import { createFaceRuntime } from "../../src/face/face-runtime.js";
import { FaceSessionStore } from "../../src/face/face-session-store.js";
import { mintAskSecret } from "../../src/face/ask-credential.js";
import {
  createRunwayFaceTransport,
  type CreateRpcHandlerFn,
  type CreateRpcHandlerOptions,
  type RpcHandlerLike,
  type RpcToolHandler,
} from "../../src/face/rpc-transport.js";
import type {
  CreateRealtimeSessionInput,
  LiveKitConnectCreds,
  RealtimeSessionRow,
  RunwaySessionApi,
} from "../../src/face/runway-client.js";
import { fixedClock } from "../../src/services/clock.js";
import { testDatabase, TEST_NOW } from "../helpers/service.js";
import type { SylDatabase } from "../../src/services/database.js";

/**
 * The other half of her face — `syl-chzl.7.5`.
 *
 * The page draws her. This is what lets her *answer*: `@runwayml/avatars-node-rpc`
 * dials OUT to the session's LiveKit room, joins it as one more participant, and
 * registers `ask_syl` there. Every byte of it is outbound, which is why the
 * ingress needs no inbound exposure and no tunnel.
 *
 * The package drags a platform-specific native binary (`@livekit/rtc-node`), so
 * the factory is injected here and lazily imported in production. These tests
 * therefore run — and typecheck — with the package absent, which is the same
 * arrangement Adjutant's `bridge-rpc-handler.ts` uses and for the same reason.
 *
 * **What is actually being asserted** is the one thing the seam exists for: an
 * RPC invocation reaches her turn and comes back with something she can say. On
 * every path. A tool call that throws is a face that freezes, and a face that
 * freezes on a stream costing twenty cents a minute is the worst outcome this
 * epic has.
 */

/** A handler factory that records what it was asked for and hands back the tools. */
function fakeFactory(): {
  readonly create: CreateRpcHandlerFn;
  readonly calls: CreateRpcHandlerOptions[];
  readonly closed: string[];
  tool(name: string): RpcToolHandler;
  fail(error: Error): void;
} {
  const calls: CreateRpcHandlerOptions[] = [];
  const closed: string[] = [];
  let failure: Error | null = null;

  const create: CreateRpcHandlerFn = (options) => {
    if (failure !== null) return Promise.reject(failure);
    calls.push(options);
    const handler: RpcHandlerLike = {
      connected: true,
      close: () => {
        closed.push(options.credentials?.roomName ?? options.sessionId ?? "?");
        return Promise.resolve();
      },
    };
    return Promise.resolve(handler);
  };

  return {
    create,
    calls,
    closed,
    tool(name: string): RpcToolHandler {
      const registered = calls.at(-1)?.tools[name];
      if (registered === undefined) throw new Error(`no handler was registered for ${name}`);
      return registered;
    },
    fail(error: Error): void {
      failure = error;
    },
  };
}

/** A Runway that readies immediately, so the broker can be driven end to end. */
class FakeRunway implements RunwaySessionApi {
  createRealtimeSession(_input: CreateRealtimeSessionInput): Promise<RealtimeSessionRow> {
    return Promise.resolve({ id: "rts_live", status: "PENDING" });
  }

  getRealtimeSession(sessionId: string): Promise<RealtimeSessionRow> {
    return Promise.resolve({ id: sessionId, status: "READY", sessionKey: "stk_shortlived" });
  }

  connectBackend(): Promise<LiveKitConnectCreds> {
    return Promise.resolve(CREDS);
  }
}

const CREDS: LiveKitConnectCreds = {
  url: "wss://livekit.example",
  token: "lk_token_for_one_room",
  roomName: "room-1",
};

let db: SylDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  vi.useRealTimers();
});

/** A live session in the ledger, plus the credential minted with it. */
function openSession(store: FaceSessionStore, id = "rts_1"): string {
  const minted = mintAskSecret();
  store.open({
    id,
    avatarId: "avatar-1",
    credits: 2,
    dollars: 0.02,
    askSecretHash: minted.hash,
    askExpiresAt: TEST_NOW + 300_000,
  });
  return minted.secret;
}

interface Harness {
  readonly store: FaceSessionStore;
  readonly ingress: AskSylIngress;
  readonly factory: ReturnType<typeof fakeFactory>;
  readonly askSecret: string;
  readonly sessionId: string;
  readonly connects: string[];
}

function harness(
  options: {
    answer?: (input: { sessionId: string; question: string }) => Promise<string>;
    isLaneWarm?: () => boolean;
    deadlineMs?: number;
  } = {},
): Harness {
  db = testDatabase();
  const clock = fixedClock(TEST_NOW);
  const store = new FaceSessionStore({ db: db.handle, clock });
  const ingress = new AskSylIngress({
    sessions: store,
    answer: options.answer ?? (({ question }) => Promise.resolve(`You asked: ${question}`)),
    now: clock,
    log: () => undefined,
    ...(options.isLaneWarm === undefined ? {} : { isLaneWarm: options.isLaneWarm }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  });
  const askSecret = openSession(store);
  return { store, ingress, factory: fakeFactory(), askSecret, sessionId: "rts_1", connects: [] };
}

function transportFor(h: Harness, log?: (event: string, fields: Record<string, unknown>) => void) {
  return createRunwayFaceTransport({
    ingress: h.ingress,
    connectBackend: (sessionId: string) => {
      h.connects.push(sessionId);
      return Promise.resolve(CREDS);
    },
    createHandler: h.factory.create,
    log: log ?? ((): void => undefined),
  });
}

describe("the live face transport", () => {
  it("should join the session's room with credentials we fetched ourselves", async () => {
    const h = harness();
    const transport = transportFor(h);

    await transport.attach({ sessionId: h.sessionId, askSecret: h.askSecret });

    expect(h.connects).toEqual([h.sessionId]);
    const options = h.factory.calls[0];
    expect(options?.credentials).toEqual(CREDS);
    // **The org secret is not handed to the vendor's RPC library.** It stays in
    // `RunwayClient`, which is the one place in this service that holds it; the
    // library gets room-scoped credentials that expire with the session.
    expect(options?.apiKey).toBeUndefined();
    // Every DECLARED tool is registered, checked against the declaration rather
    // than against a list written out here — a tool the model is told about
    // with no handler behind it is a face that freezes when it calls one.
    expect(Object.keys(options?.tools ?? {})).toEqual(
      AskSylIngress.toolDefinitions().map((tool) => tool.name),
    );
    expect(Object.keys(options?.tools ?? {})).toContain(MEMORY_TOOL_NAME);
  });

  it("should let an RPC invocation reach her turn and return the answer", async () => {
    const h = harness({ answer: ({ question }) => Promise.resolve(`I heard: ${question}`) });
    const transport = transportFor(h);
    await transport.attach({ sessionId: h.sessionId, askSecret: h.askSecret });

    const result = await h.factory.tool(MEMORY_TOOL_NAME)({ question: "Did the deploy go out?" });

    expect(result).toEqual({ ok: true, say: "I heard: Did the deploy go out?" });
  });

  it("should return something she can say when the turn overruns the ceiling", async () => {
    // Runway gives up at 8s and tool-using turns measured 1.8-6.9s warm, so some
    // WILL overrun. Silence is the worst available outcome; an honest "ask me
    // again" is not.
    const h = harness({
      answer: () => new Promise<string>(() => undefined),
      deadlineMs: 5,
    });
    const transport = transportFor(h);
    await transport.attach({ sessionId: h.sessionId, askSecret: h.askSecret });

    const result = await h.factory.tool(MEMORY_TOOL_NAME)({ question: "How is the day?" });

    expect(result).toEqual({ ok: false, say: TOO_SLOW_LINE, failure: "slow" });
    expect(TOO_SLOW_LINE).not.toBe("");
  });

  it("should return something she can say when the turn fails outright", async () => {
    const h = harness({ answer: () => Promise.reject(new Error("the lane died")) });
    const transport = transportFor(h);
    await transport.attach({ sessionId: h.sessionId, askSecret: h.askSecret });

    const result = await h.factory.tool(MEMORY_TOOL_NAME)({ question: "Anything?" });

    expect(result).toEqual({ ok: false, say: TURN_FAILED_LINE, failure: "failed" });
  });

  it("should refuse a cold lane instantly rather than gambling on the ceiling", async () => {
    const h = harness({ isLaneWarm: () => false });
    const transport = transportFor(h);
    await transport.attach({ sessionId: h.sessionId, askSecret: h.askSecret });

    const result = await h.factory.tool(MEMORY_TOOL_NAME)({ question: "Anything?" });

    expect(result).toEqual({ ok: false, say: COLD_LANE_LINE, failure: "cold" });
  });

  it("should never reject an RPC call, whatever the model sends", async () => {
    const h = harness();
    const transport = transportFor(h);
    await transport.attach({ sessionId: h.sessionId, askSecret: h.askSecret });
    const tool = h.factory.tool(MEMORY_TOOL_NAME);

    // A missing argument, a wrong type, and an empty question. A rejection here
    // is the avatar standing there with nothing to say.
    for (const args of [{}, { question: 42 }, { question: "   " }]) {
      const result = await tool(args as Record<string, unknown>);
      expect(result["ok"]).toBe(false);
      expect(String(result["say"] ?? "")).not.toBe("");
    }
  });

  it("should present the session's own credential, not be trusted for arriving", async () => {
    const h = harness();
    const transport = transportFor(h);
    // Attached with a credential that is not this session's.
    await transport.attach({ sessionId: h.sessionId, askSecret: "not-the-secret" });

    const result = await h.factory.tool(MEMORY_TOOL_NAME)({ question: "Let me in." });

    // One gate, two doors: the LiveKit path verifies exactly as the HTTP door
    // does, so the two cannot drift and one of them end up weaker.
    expect(result["ok"]).toBe(false);
    expect(result["failure"]).toBe("unauthorised");
  });

  it("should leave the room when the session closes", async () => {
    const h = harness();
    const transport = transportFor(h);
    await transport.attach({ sessionId: h.sessionId, askSecret: h.askSecret });

    await transport.close(h.sessionId);

    expect(h.factory.closed).toEqual([CREDS.roomName]);
    expect(transport.has(h.sessionId)).toBe(false);
  });

  it("should be safe to close twice and safe to close what was never attached", async () => {
    const h = harness();
    const transport = transportFor(h);
    await transport.attach({ sessionId: h.sessionId, askSecret: h.askSecret });

    await transport.close(h.sessionId);
    await transport.close(h.sessionId);
    await transport.close("rts_never_existed");

    // `onDisappear` and the scene going to background both mean he has left,
    // they race, and the reaper is a third caller. One close is all that fires.
    expect(h.factory.closed).toEqual([CREDS.roomName]);
  });

  it("should forget a handler the room dropped, so a later close is not a lie", async () => {
    const h = harness();
    const transport = transportFor(h);
    await transport.attach({ sessionId: h.sessionId, askSecret: h.askSecret });

    h.factory.calls[0]?.onDisconnected?.();

    expect(transport.has(h.sessionId)).toBe(false);
    await transport.close(h.sessionId);
    expect(h.factory.closed).toEqual([]);
  });

  it("should replace a handler rather than stack two on one session", async () => {
    const h = harness();
    const transport = transportFor(h);

    await transport.attach({ sessionId: h.sessionId, askSecret: h.askSecret });
    await transport.attach({ sessionId: h.sessionId, askSecret: h.askSecret });

    // The renewal path opens a fresh session, but a retry of the same one must
    // not leave a participant in the room with nobody holding it.
    expect(h.factory.closed).toEqual([CREDS.roomName]);
    expect(h.factory.calls).toHaveLength(2);
  });

  it("should surface an attach failure rather than swallowing it", async () => {
    const h = harness();
    const transport = transportFor(h);
    h.factory.fail(new Error("livekit refused the join"));

    await expect(
      transport.attach({ sessionId: h.sessionId, askSecret: h.askSecret }),
    ).rejects.toThrow(/livekit refused the join/);

    // The route catches it and hands the session over anyway — a face that
    // cannot answer beats a face that was paid for and thrown away — but the
    // transport does not decide that, and it does not report success.
    expect(transport.has(h.sessionId)).toBe(false);
  });

  it("should close every room it holds when the service shuts down", async () => {
    const h = harness();
    openSession(h.store, "rts_2");
    const transport = transportFor(h);
    await transport.attach({ sessionId: h.sessionId, askSecret: h.askSecret });
    await transport.attach({ sessionId: "rts_2", askSecret: h.askSecret });

    await transport.closeAll();

    expect(h.factory.closed).toHaveLength(2);
    expect(transport.has(h.sessionId)).toBe(false);
    expect(transport.has("rts_2")).toBe(false);
  });
});

describe("the face runtime's transport seam", () => {
  it("should build the transport from its OWN ingress and broker", async () => {
    // The real transport binds `ask_syl` to the ingress and fetches room
    // credentials through the broker, and both are constructed inside
    // `createFaceRuntime`. A caller handing in a finished transport would have
    // to assemble a second copy of the runtime to make one — hence the factory.
    db = testDatabase();
    const factory = fakeFactory();
    const runway = new FakeRunway();

    const runtime = createFaceRuntime({
      db: db.handle,
      conversations: { ask: () => Promise.reject(new Error("not asked here")) },
      clock: fixedClock(TEST_NOW),
      client: runway,
      avatarId: "avatar-1",
      log: () => undefined,
      transport: ({ ingress, broker }) =>
        createRunwayFaceTransport({
          ingress,
          connectBackend: (sessionId) => broker.connectBackend(sessionId),
          createHandler: factory.create,
          log: () => undefined,
        }),
    });

    const opened = await runtime.broker.startSession();
    await runtime.transport.attach({
      sessionId: opened.credentials.sessionId,
      askSecret: opened.askSecret,
    });

    // The handler it registered verifies against the ledger the runtime owns —
    // proof it was wired to that ingress and not to one of its own.
    const answered = await factory.tool(MEMORY_TOOL_NAME)({ question: "Anything?" });
    expect(answered["ok"]).toBe(false);
    expect(answered["failure"]).not.toBe("unauthorised");
  });

  it("should leave every room when the service stops", async () => {
    db = testDatabase();
    const factory = fakeFactory();
    const runway = new FakeRunway();

    const runtime = createFaceRuntime({
      db: db.handle,
      conversations: { ask: () => Promise.reject(new Error("not asked here")) },
      clock: fixedClock(TEST_NOW),
      client: runway,
      avatarId: "avatar-1",
      log: () => undefined,
      transport: ({ ingress, broker }) =>
        createRunwayFaceTransport({
          ingress,
          connectBackend: (sessionId) => broker.connectBackend(sessionId),
          createHandler: factory.create,
          log: () => undefined,
        }),
    });

    const opened = await runtime.broker.startSession();
    await runtime.transport.attach({
      sessionId: opened.credentials.sessionId,
      askSecret: opened.askSecret,
    });

    await runtime.stop();

    // A shutdown that leaves a participant of ours inside a live LiveKit room is
    // the idle leak wearing its last hat: nothing on this machine is holding it
    // any more, and only the provider's cap would ever end it.
    expect(factory.closed).toEqual([CREDS.roomName]);
  });
});
