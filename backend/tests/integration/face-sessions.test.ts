import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TokenGrant } from "@syl/shared";

import { createFaceRuntime, type FaceRuntime } from "../../src/face/face-runtime.js";
import type {
  CreateRealtimeSessionInput,
  LiveKitConnectCreds,
  RealtimeSessionRow,
  RunwaySessionApi,
} from "../../src/face/runway-client.js";
import { LANES, SylAgent, memorySessionStore } from "../../src/harness/agent.js";
import type { TurnResult } from "../../src/harness/session.js";
import { API_BASE_PATH, createApp } from "../../src/index.js";
import type { ApiKeyService } from "../../src/services/api-key-service.js";
import type { MessageStore } from "../../src/services/message-store.js";
import { fixedClock } from "../../src/services/clock.js";
import { ConversationService } from "../../src/services/conversation-service.js";
import { INTERACTIVE_CONVERSATION_ID, type SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps, TEST_NOW } from "../helpers/service.js";

/**
 * How a client asks for a face — `syl-chzl.3.5`.
 *
 * Two authentication systems meet in one router and the tests are mostly about
 * keeping them apart: three routes for the Commander's paired device, and one
 * for a machine holding a credential that exists for the length of one session.
 */

/** The dev-org secret, so a leak test can assert on its VALUE. */
const RUNWAY_SECRET = "key_thisisthesecretandmustneverleavetheserver";
const AVATAR = "48cbc73d-f47f-41de-bed8-58a532b3b84b";

/** A Runway that readies immediately. */
class FakeRunway implements RunwaySessionApi {
  created: CreateRealtimeSessionInput[] = [];
  next = 1;

  createRealtimeSession(input: CreateRealtimeSessionInput): Promise<RealtimeSessionRow> {
    this.created.push(input);
    return Promise.resolve({ id: `rts_${String(this.next++)}`, status: "PENDING" });
  }

  getRealtimeSession(sessionId: string): Promise<RealtimeSessionRow> {
    return Promise.resolve({
      id: sessionId,
      status: "READY",
      // The short-lived browser credential. Deliberately NOT derived from the
      // secret, so a test asserting the secret is absent means something.
      sessionKey: "stk_shortlived",
      expiresAt: new Date(TEST_NOW + 300_000).toISOString(),
    });
  }

  connectBackend(): Promise<LiveKitConnectCreds> {
    return Promise.resolve({ url: "wss://livekit.example", token: "lk_tok", roomName: "room-1" });
  }
}

/** The `data` off a success envelope, or a failure the assertion can read. */
function dataOf<T>(body: unknown): T {
  const envelope = body as { success?: boolean; data?: T; error?: { message?: string } };
  if (envelope.success !== true || envelope.data === undefined) {
    throw new Error(`expected a success envelope, got: ${JSON.stringify(body)}`);
  }
  return envelope.data;
}

describe("the face session routes", () => {
  let db: SylDatabase;
  let keys: ApiKeyService;
  let running: RunningApp;
  let runway: FakeRunway;
  let face: FaceRuntime;
  let warm: boolean;
  let attached: { sessionId: string; askSecret: string }[];
  let attachFails: boolean;
  let faceLog: { event: string; fields: Record<string, unknown> }[];
  let messages: MessageStore;

  const clock = fixedClock(TEST_NOW);

  beforeEach(async () => {
    warm = true;
    attached = [];
    attachFails = false;
    faceLog = [];
    runway = new FakeRunway();
    db = testDatabase();
    const deps = testDeps(db);
    keys = deps.keys;
    messages = deps.messages;

    // Her own conversation service, with a runner that answers instantly and
    // reports the subscription rail — so the ask path is exercised end to end
    // without spawning anything.
    const conversations = new ConversationService({
      messages: deps.messages,
      agent: new SylAgent({
        store: memorySessionStore(),
        runner: (prompt: string): Promise<TurnResult> =>
          Promise.resolve({
            sessionId: "session-1",
            text: `You asked: ${prompt}`,
            spoken: `You asked: ${prompt}`,
            costUsd: 0,
            numTurns: 1,
            contextTokens: 0,
            init: { apiKeySource: "none" } as unknown as TurnResult["init"],
            events: [],
          }),
      }),
      log: () => undefined,
    });

    face = createFaceRuntime({
      db: db.handle,
      conversations,
      clock,
      client: runway,
      avatarId: AVATAR,
      isLaneWarm: () => warm,
      dailyCreditCeiling: 300,
      transport: {
        attach: (input) => {
          if (attachFails) return Promise.reject(new Error("the room refused us"));
          attached.push(input);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      },
      log: (event, fields) => faceLog.push({ event, fields }),
      logError: () => undefined,
    });

    running = await startTestApp(createApp(testConfig(), { ...deps, face }));
  });

  afterEach(async () => {
    face.stop();
    await running.close();
    db.close();
  });

  /** A paired phone's credential, through the published route. */
  async function deviceToken(): Promise<string> {
    const response = await fetch(`${running.baseUrl}${API_BASE_PATH}/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ pairingCode: keys.issuePairingCode().code, deviceName: "iPhone" }),
    });
    return dataOf<TokenGrant>(await response.json()).token;
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

  interface OpenedFace {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly avatarId: string;
    readonly expiresAt?: string;
  }

  async function openFace(token?: string): Promise<{ status: number; body: unknown }> {
    const bearer = token ?? (await deviceToken());
    const response = await call("POST", "/face/sessions", { token: bearer });
    return { status: response.status, body: await response.json() };
  }

  describe("opening a face", () => {
    it("should hand back a short-lived session key", async () => {
      const { status, body } = await openFace();

      expect(status).toBe(201);
      const data = dataOf<OpenedFace>(body);
      expect(data.sessionId).toBe("rts_1");
      expect(data.sessionKey).toBe("stk_shortlived");
      expect(data.avatarId).toBe(AVATAR);
    });

    it("should never put the Runway secret in the response", async () => {
      const { body } = await openFace();

      // On the VALUE, not the field names — a rename is how this leaks.
      expect(JSON.stringify(body)).not.toContain(RUNWAY_SECRET);
      expect(JSON.stringify(body)).not.toContain(RUNWAY_SECRET.slice(0, 12));
    });

    it("should never put the per-session ask credential in the response", async () => {
      const { body } = await openFace();

      const secret = face.sessions.get("rts_1")?.askSecretHash ?? "impossible";
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(JSON.stringify(body)).not.toContain("syl_face_");
    });

    it("should hand a client the four fields it needs and nothing else", async () => {
      const { body } = await openFace();

      const data = dataOf<Record<string, unknown>>(body);
      expect(Object.keys(data).sort()).toEqual([
        "avatarId",
        "expiresAt",
        "sessionId",
        "sessionKey",
      ]);
    });

    it("should attach the avatar's tool loop with the session's own credential", async () => {
      await openFace();

      expect(attached).toHaveLength(1);
      expect(attached[0]?.sessionId).toBe("rts_1");
      expect(attached[0]?.askSecret.startsWith("syl_face_")).toBe(true);
    });

    it("should say in the log that the tool loop attached, not only that it failed", async () => {
      await openFace();

      // **The ambiguity this removes is the point.** The attach path used to
      // log only on failure, so a healthy attach and an attach that never ran
      // produced the same record — nothing — and on 2026-08-23 that was why
      // nobody could say whether the avatar had ever had a tool to call. An
      // absence that means "fine" must not look like an absence that means
      // "never happened".
      const line = faceLog.find((entry) => entry.event === "face.rpc.attached");
      expect(line?.fields["sessionId"]).toBe("rts_1");
      expect(typeof line?.fields["elapsedMs"]).toBe("number");
    });

    it("should still hand over a face whose tool loop could not attach, and say so", async () => {
      attachFails = true;

      const { status } = await openFace();

      // A face that cannot answer is better than a live, billable session
      // thrown away — and it must be loud, because from the outside a mute
      // face and a broken one look identical.
      expect(status).toBe(201);
      expect(faceLog.map((entry) => entry.event)).toContain("face.rpc.attach_failed");
      expect(faceLog.map((entry) => entry.event)).not.toContain("face.rpc.attached");
    });

    it("should record the session in the ledger", async () => {
      await openFace();

      expect(face.sessions.get("rts_1")?.credits).toBe(2);
      expect(face.guard.spentToday()).toBe(2);
    });
  });

  describe("the refusals a client can act on", () => {
    it("should name the ceiling rather than answering 500 when the day's budget is spent", async () => {
      face.guard.recordSpend(300);

      const response = await call("POST", "/face/sessions", { token: await deviceToken() });
      const body = (await response.json()) as {
        error: { code: string; message: string; details?: Record<string, unknown> };
      };

      expect(response.status).toBe(429);
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(body.error.message).toMatch(/300/);
      expect(body.error.details?.["creditCeiling"]).toBe(300);
      // Nothing was created, so nothing was charged.
      expect(runway.created).toHaveLength(0);
    });

    it("should refuse to open a face on a cold lane, and spend nothing", async () => {
      warm = false;

      const response = await call("POST", "/face/sessions", { token: await deviceToken() });
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(409);
      expect(body.error.message).toMatch(/cold/i);
      expect(runway.created).toHaveLength(0);
      expect(face.guard.spentToday()).toBe(0);
    });
  });

  describe("reading a face", () => {
    it("should report the session, its live meter and the day's spend", async () => {
      const token = await deviceToken();
      await openFace(token);

      const response = await call("GET", "/face/sessions/rts_1", { token });
      expect(response.status).toBe(200);
      const data = dataOf<{
        session: Record<string, unknown>;
        meter: Record<string, unknown>;
        budget: Record<string, unknown>;
      }>(await response.json());
      expect(data.session["sessionId"]).toBe("rts_1");
      expect(data.session["closedAt"]).toBeNull();
      expect(data.meter["credits"]).toBe(2);
      expect(data.budget).toEqual({
        creditsSpentToday: 2,
        creditCeiling: 300,
        creditsRemaining: 298,
        dollarsSpentToday: 0.02,
      });
    });

    it("should never expose the credential hash through the read", async () => {
      const token = await deviceToken();
      await openFace(token);
      const hash = face.sessions.get("rts_1")?.askSecretHash ?? "impossible";

      const response = await call("GET", "/face/sessions/rts_1", { token });

      expect(await response.text()).not.toContain(hash);
    });

    it("should 404 a session that does not exist", async () => {
      const response = await call("GET", "/face/sessions/rts_nobody", {
        token: await deviceToken(),
      });

      expect(response.status).toBe(404);
    });
  });

  describe("closing a face", () => {
    it("should settle the accounting", async () => {
      const token = await deviceToken();
      await openFace(token);

      const response = await call("DELETE", "/face/sessions/rts_1", { token });
      expect(response.status).toBe(200);
      expect(dataOf<Record<string, unknown>>(await response.json())["ended"]).toBe("closed");
      expect(face.sessions.get("rts_1")?.closedAt).not.toBeNull();
    });

    it("should be idempotent on a second call rather than charging twice", async () => {
      const token = await deviceToken();
      await openFace(token);

      await call("DELETE", "/face/sessions/rts_1", { token });
      const spentAfterFirst = face.guard.spentToday();
      const second = await call("DELETE", "/face/sessions/rts_1", { token });

      expect(second.status).toBe(200);
      expect(face.guard.spentToday()).toBe(spentAfterFirst);
      expect(face.sessions.get("rts_1")?.ended).toBe("closed");
    });
  });

  describe("who may reach these routes", () => {
    it("should give an anonymous caller the ordinary indistinguishable 401", async () => {
      for (const [method, path] of [
        ["POST", "/face/sessions"],
        ["GET", "/face/sessions/rts_1"],
        ["DELETE", "/face/sessions/rts_1"],
      ] as const) {
        const response = await call(method, path);
        expect(response.status).toBe(401);
      }
    });

    it("should refuse SYL's own credential, because a face costs his money", async () => {
      const agent = keys.mint("Syl (her own hands)", { scope: "agent" }).token;

      const response = await call("POST", "/face/sessions", { token: agent });
      const body = (await response.json()) as { error: { code: string } };

      expect(response.status).toBe(403);
      expect(body.error.code).toBe("FORBIDDEN");
      expect(runway.created).toHaveLength(0);
    });
  });

  describe("the ask_syl ingress", () => {
    /** Open a face and take the credential the transport was handed. */
    async function openAndTakeSecret(): Promise<string> {
      await openFace();
      const secret = attached[0]?.askSecret;
      if (secret === undefined) throw new Error("no credential was attached");
      return secret;
    }

    async function ask(
      secret: string | undefined,
      question = "What is on today?",
      sessionId = "rts_1",
    ): Promise<Response> {
      return fetch(`${running.baseUrl}${API_BASE_PATH}/face/sessions/${sessionId}/ask`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret === undefined ? {} : { authorization: `Bearer ${secret}` }),
        },
        body: JSON.stringify({ question }),
      });
    }

    it("should answer with her words when the per-session credential is right", async () => {
      const secret = await openAndTakeSecret();

      const response = await ask(secret);
      expect(response.status).toBe(200);
      const data = dataOf<{ ok: boolean; say: string }>(await response.json());
      expect(data.ok).toBe(true);
      expect(data.say).toBe("You asked: What is on today?");
    });

    it("should put both halves of the exchange in his conversation", async () => {
      const secret = await openAndTakeSecret();

      await ask(secret, "Did the deploy go out?");

      // `list` answers newest first.
      const page = messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 10 });
      expect(page.items.map((message) => message.role)).toEqual(["assistant", "user"]);
    });

    it("should require NO idempotency key, because the provider will not send one", async () => {
      const secret = await openAndTakeSecret();

      const response = await ask(secret);

      expect(response.status).toBe(200);
    });

    it("should reject an anonymous caller with the ordinary 401", async () => {
      await openAndTakeSecret();

      const response = await ask(undefined);

      expect(response.status).toBe(401);
    });

    it("should reject a paired DEVICE token: this is not a route for his phone", async () => {
      await openAndTakeSecret();

      const response = await ask(await deviceToken());

      expect(response.status).toBe(401);
    });

    it("should reject SYL's own credential too", async () => {
      await openAndTakeSecret();

      const response = await ask(keys.mint("Syl", { scope: "agent" }).token);

      expect(response.status).toBe(401);
    });

    /**
     * A SESSION THAT ENDED IS NOT A STRANGER AT THE DOOR, and since
     * `syl-chzl.4.7` the two are answered differently on purpose.
     *
     * The credential stops WORKING either way — no turn runs and she answers
     * nothing. What changed is that a caller who proved it holds this session's
     * secret now gets the ending said out loud instead of a bare 401, because
     * a 401 here is the silently-mute-while-billing failure wearing an HTTP
     * status. Reachable only after the hash matched, so nothing is disclosed;
     * the non-disclosure test below is the guard on that and stays 401.
     */
    it("should stop answering once the session has ended, and say so rather than 401", async () => {
      const token = await deviceToken();
      const secret = await openAndTakeSecret();
      expect((await ask(secret)).status).toBe(200);
      const before = messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 50 }).items.length;

      await call("DELETE", "/face/sessions/rts_1", { token });

      const response = await ask(secret);
      expect(response.status).toBe(200);
      const data = dataOf<{ ok: boolean; say: string; failure?: string }>(await response.json());
      expect(data.ok).toBe(false);
      expect(data.failure).toBe("expired");
      expect(data.say).not.toBe("");
      // The part that matters as much as the sentence: nothing ran.
      expect(messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 50 }).items).toHaveLength(before);
    });

    it("should stop answering once the reaper has cut the session", async () => {
      const secret = await openAndTakeSecret();
      face.broker.recordSessionEnd("rts_1", "reaped");
      const before = messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 50 }).items.length;

      const response = await ask(secret);

      expect(response.status).toBe(200);
      const data = dataOf<{ ok: boolean; failure?: string }>(await response.json());
      expect(data.failure).toBe("expired");
      expect(messages.list(INTERACTIVE_CONVERSATION_ID, { limit: 50 }).items).toHaveLength(before);
    });

    it("should not disclose whether a session id exists", async () => {
      const secret = await openAndTakeSecret();

      const unknown = await ask(secret, "Hello?", "rts_does_not_exist");
      const wrong = await ask("syl_face_00000000000000000000000000000000");

      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(await unknown.text()).toBe(await wrong.text());
    });

    it("should say something sayable rather than hanging when the lane goes cold", async () => {
      const secret = await openAndTakeSecret();
      warm = false;

      const response = await ask(secret);
      expect(response.status).toBe(200);
      const data = dataOf<{ ok: boolean; say: string }>(await response.json());
      expect(data.ok).toBe(false);
      expect(data.say).not.toBe("");
    });

    it("should refuse a body with no question in it", async () => {
      const secret = await openAndTakeSecret();

      const response = await fetch(
        `${running.baseUrl}${API_BASE_PATH}/face/sessions/rts_1/ask`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
          body: JSON.stringify({}),
        },
      );

      expect(response.status).toBe(400);
    });

    it("should mark the session active, so a live conversation is never reaped", async () => {
      const secret = await openAndTakeSecret();
      const before = face.sessions.get("rts_1")?.lastActivityAt;

      await ask(secret);

      expect(face.sessions.get("rts_1")?.lastActivityAt).toBe(before);
      // The clock is fixed in this test, so equality is the honest assertion;
      // the moving-clock case is covered in `face-ask-syl.test.ts`.
      expect(face.broker.shouldDisconnectIdle(face.sessions.get("rts_1")!)).toBe(false);
    });
  });

  describe("what the page says became of it", () => {
    /**
     * The route that would have named the failure in one session instead of
     * two — `0037`.
     *
     * 2026-08-23: two sessions, ninety cents, both reaped, `lastActivityAt`
     * equal to `openedAt` to the millisecond on both. The cause was on the
     * device (iOS terminated the app over an undeclared camera usage, four
     * seconds in) and NOTHING about it reached this service. A blank record was
     * compatible with "it worked" and with "the document never ran".
     */
    async function report(
      key: string | undefined,
      body: unknown = { state: "connected" },
      sessionId = "rts_1",
    ): Promise<Response> {
      return fetch(`${running.baseUrl}${API_BASE_PATH}/face/sessions/${sessionId}/report`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
        },
        body: JSON.stringify(body),
      });
    }

    it("should take a report from the key the page was given to draw her with", async () => {
      await openFace();

      const response = await report("stk_shortlived", {
        state: "autoplay_blocked",
        detail: "1 element paused with data ready",
      });

      // 202: a note taken about a session, not a change to one.
      expect(response.status).toBe(202);
      const session = face.sessions.get("rts_1");
      expect(session?.clientState).toBe("autoplay_blocked");
      expect(session?.clientDetail).toBe("1 element paused with data ready");
    });

    it("should never let a report keep a dead face alive", async () => {
      await openFace();
      const before = face.sessions.get("rts_1")?.lastActivityAt;

      await report("stk_shortlived", { state: "booting" });

      // **Telemetry is not activity.** A page reporting every second would
      // otherwise hold a mute, billing face open at twenty cents a minute, and
      // would erase the one field that diagnosed this failure at all.
      expect(face.sessions.get("rts_1")?.lastActivityAt).toBe(before);
    });

    it("should refuse an anonymous caller with the ordinary 401", async () => {
      await openFace();

      expect((await report(undefined)).status).toBe(401);
    });

    it("should refuse a paired DEVICE token: his phone is not the page", async () => {
      await openFace();

      expect((await report(await deviceToken())).status).toBe(401);
    });

    it("should refuse the ask_syl credential, which is a different power entirely", async () => {
      await openFace();
      const askSecret = attached[0]?.askSecret;

      // A caller holding that one can speak AS THE AVATAR and drive her turns.
      // The two credentials on one row must never be interchangeable.
      expect((await report(askSecret)).status).toBe(401);
    });

    it("should stop accepting reports once the session has ended", async () => {
      await openFace();
      face.broker.recordSessionEnd("rts_1", "closed");

      // Closed with the session, structurally: the credential is a column of
      // the row that was just settled.
      expect((await report("stk_shortlived")).status).toBe(401);
    });

    it("should not disclose whether a session id exists", async () => {
      await openFace();

      const unknown = await report("stk_shortlived", { state: "connected" }, "rts_nosuch");
      const wrongKey = await report("stk_nottherightone");

      expect(unknown.status).toBe(401);
      expect(wrongKey.status).toBe(401);
    });

    it("should refuse SYL's own credential, and with a 401 rather than a 400", async () => {
      await openFace();
      const hers = face.sessions.get("rts_1")?.askSecretHash ?? "hers";

      const response = await report(hers, { state: "not a real state" });

      // The ordering matters as much as the answer. A 400 here would tell a
      // caller holding a credential this route does not accept that the route
      // exists and what shape it wants — which is what the confinement sweep in
      // `agent-credential.test.ts` refuses to allow on any surface.
      expect(response.status).toBe(401);
    });

    it("should refuse a word outside the closed vocabulary", async () => {
      await openFace();

      const response = await report("stk_shortlived", { state: "everything is on fire" });

      // A closed list is what stops this becoming a free-text pipe from a web
      // view into his database. 400, not 401: it discloses nothing about the
      // session, only that the caller used a word this route does not know.
      expect(response.status).toBe(400);
      expect(face.sessions.get("rts_1")?.clientState).toBeNull();
    });
  });

  describe("one face at a time", () => {
    it("should cut the first face when a second is opened", async () => {
      await openFace();
      await openFace();

      // He pressed twice and got two live billable sessions 82 seconds apart,
      // because the client-side rule died with the client. It lives on the
      // server now: `rts_1` is settled before `rts_2` is created.
      expect(face.sessions.get("rts_1")?.ended).toBe("closed");
      expect(face.sessions.live().map((row) => row.id)).toEqual(["rts_2"]);
    });
  });

  describe("the warm lane it runs on", () => {
    it("should be the Commander's own, so SOUL.md and her memory are in the loop", () => {
      // Named here rather than only in the unit test, because this integration
      // is where a re-wiring would silently give the face a lane of its own.
      expect(LANES.commander).toBe("commander");
    });
  });
});
