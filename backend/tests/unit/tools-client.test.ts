import { randomUUID } from "node:crypto";

import type { Reminder } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { API_BASE_PATH, bootstrap, createApp, type Bootstrapped } from "../../src/index.js";
import { SylApiClient, type FetchLike, type ToolFailure } from "../../src/tools/client.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig } from "../helpers/service.js";

/**
 * Syl's client for Syl's own API.
 *
 * ## Why this goes over HTTP at all
 *
 * `ReminderService` is in the same process and calling it directly would be
 * faster. It would also be a second path into the same data, and validation,
 * idempotency, quiet-hours deferral and the store's CHECK constraints are all
 * enforced at the API boundary. The day the two drift is the day a reminder she
 * made behaves differently from one the phone made — so most of this file runs
 * against a **real bootstrapped service on a real socket**, not a double. The
 * doubles appear only where the failure being modelled is the transport itself.
 *
 * ## What a failure has to be
 *
 * Structured, and never a bare throw. She has to tell the Commander what went
 * wrong, and "something failed" is not that. Every path below ends in a
 * `ToolFailure` carrying a kind, the operation, and a sentence.
 */

let built: Bootstrapped;
let running: RunningApp;
let client: SylApiClient;

/** A reminder body the service will accept. */
const A_REMINDER = {
  text: "Stand up",
  wallTime: "07:30",
  tz: "America/Chicago",
  date: "2026-08-10",
};

beforeEach(async () => {
  built = bootstrap(testConfig({ databasePath: ":memory:" }));
  running = await startTestApp(createApp(testConfig(), built.deps));
  client = new SylApiClient({
    baseUrl: `${running.baseUrl}${API_BASE_PATH}`,
    token: built.agentKey.token,
  });
});

afterEach(async () => {
  await running.close();
  built.database.close();
});

/** The failure a result carries, or a thrown explanation of the success. */
function failureOf(result: { ok: boolean; failure?: ToolFailure }): ToolFailure {
  if (result.ok || result.failure === undefined) {
    throw new Error(`expected a failure, got ${JSON.stringify(result)}`);
  }
  return result.failure;
}

/** A client pointed at a socket nobody is listening on. */
function unreachableClient(): SylApiClient {
  return new SylApiClient({
    // Port 1 on loopback: privileged, unbound, and refused immediately.
    baseUrl: `http://127.0.0.1:1${API_BASE_PATH}`,
    token: built.agentKey.token,
  });
}

/** A client whose transport does whatever the test says. */
function clientWith(fetchImpl: FetchLike, options: { readonly timeoutMs?: number } = {}) {
  return new SylApiClient({
    baseUrl: `${running.baseUrl}${API_BASE_PATH}`,
    token: built.agentKey.token,
    fetch: fetchImpl,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

describe("SylApiClient, against her own service", () => {
  it("should create a reminder and hand back what the store recorded", async () => {
    const result = await client.post<Reminder>("/reminders", A_REMINDER);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);
    expect(result.data.text).toBe("Stand up");
    // From the store, not from her intention: the id only exists because a row
    // was written.
    expect(built.deps.reminders.get(result.data.id)?.text).toBe("Stand up");
  });

  it("should read a collection back", async () => {
    await client.post<Reminder>("/reminders", A_REMINDER);
    const result = await client.get<{ items: readonly Reminder[] }>("/reminders");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toHaveLength(1);
  });

  it("should pass a query string through rather than swallowing it", async () => {
    await client.post<Reminder>("/reminders", A_REMINDER);
    const result = await client.get<{ items: readonly Reminder[] }>("/reminders", {
      state: "scheduled",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toHaveLength(1);
  });

  it("should carry the agent key, so an unauthenticated call is not what happens", async () => {
    // The control for every other assertion here: without the header the
    // service answers 401, so a green suite would otherwise be compatible with
    // a client that never authenticated at all.
    const anonymous = new SylApiClient({
      baseUrl: `${running.baseUrl}${API_BASE_PATH}`,
      token: `syl_pat_${"0".repeat(32)}`,
    });

    expect(failureOf(await anonymous.post("/reminders", A_REMINDER)).status).toBe(401);
    expect((await client.post("/reminders", A_REMINDER)).ok).toBe(true);
  });

  it("should send a fresh Idempotency-Key per call, so two asks are two reminders", async () => {
    // The header is required on every write. A client that reused one key would
    // have its second reminder answered with a replay of the first — she would
    // report making two and the store would hold one.
    // The SAME body twice, deliberately: a different body would come back as
    // IDEMPOTENCY_KEY_REUSE and this test would pass against a client that
    // reused its key. Identical requests are what a replay actually looks like.
    const first = await client.post<Reminder>("/reminders", A_REMINDER);
    const second = await client.post<Reminder>("/reminders", A_REMINDER);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.id).not.toBe(second.data.id);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
  });

  it("should report a replay rather than hiding it", async () => {
    const key = randomUUID();
    const fixed = new SylApiClient({
      baseUrl: `${running.baseUrl}${API_BASE_PATH}`,
      token: built.agentKey.token,
      idempotencyKey: () => key,
    });

    const first = await fixed.post<Reminder>("/reminders", A_REMINDER);
    const second = await fixed.post<Reminder>("/reminders", A_REMINDER);

    expect(first.ok && !first.replayed).toBe(true);
    expect(second.ok && second.replayed).toBe(true);
  });

  it("should not send an Idempotency-Key on a read", async () => {
    const seen: (string | null)[] = [];
    const spy = clientWith(async (url, init) => {
      seen.push(new Headers(init?.headers).get("Idempotency-Key"));
      return fetch(url, init);
    });

    await spy.get("/reminders");
    await spy.post("/reminders", A_REMINDER);

    expect(seen[0]).toBeNull();
    expect(seen[1]).not.toBeNull();
  });
});

describe("SylApiClient, when the service refuses", () => {
  it("should surface the contract's code and message rather than a status alone", async () => {
    const failure = failureOf(await client.post("/reminders", { text: "" }));

    expect(failure.kind).toBe("refused");
    expect(failure.status).toBe(400);
    expect(failure.code).toBe("VALIDATION_FAILED");
    expect(failure.message).not.toBe("");
    expect(failure.details).not.toBeNull();
  });

  it("should say which operation it was, so she can name what she was doing", async () => {
    const failure = failureOf(await client.post("/reminders", { text: "" }));

    expect(failure.operation).toBe("POST /reminders");
  });

  it("should carry the contract's own retryable flag rather than guessing", async () => {
    const validation = failureOf(await client.post("/reminders", { text: "" }));

    expect(validation.retryable).toBe(false);
  });

  it("should render a 403 from her own confinement as something she can explain", async () => {
    // The one refusal she will meet by design. It must arrive as a sentence
    // about what she may do, not as "403".
    const failure = failureOf(await client.get("/logs"));

    expect(failure.status).toBe(403);
    expect(failure.code).toBe("FORBIDDEN");
    expect(failure.message).toMatch(/reminders, to-dos and goals/u);
  });

  it("should say her own credential stopped working, not 'Re-pair this device'", async () => {
    // `syl-009.5.2`. The service's 401 is one sentence for every rejection, on
    // purpose — telling malformed from revoked is an oracle for guessing
    // tokens — and that sentence ends "Re-pair this device". Said by Syl it
    // sends the Commander to fix his phone, which is the one thing that is not
    // broken. She knows what the middleware refuses to guess: which credential
    // she presented. See `revokedCredential` in `tools/client.ts`.
    built.deps.keys.revoke(
      built.deps.keys.liveKeysWithScope("agent")[0]?.id ?? "",
      "taken away by hand",
    );

    const failure = failureOf(await client.post("/reminders", A_REMINDER));

    expect(failure.status).toBe(401);
    expect(failure.code).toBe("UNAUTHORIZED");
    expect(failure.message).toMatch(/credential/iu);
    expect(failure.message).toMatch(/nothing was written/iu);
    expect(failure.message).not.toMatch(/re-pair this device/iu);
    expect(failure.retryable).toBe(false);
  });

  it("should leave every other refusal in the service's own words", async () => {
    // The translation above is for ONE code and must not spread. Everything
    // else the service says is written to be repeated to him verbatim, and a
    // client that rewrote refusals would be a second opinion that drifts.
    const failure = failureOf(await client.get("/logs"));

    expect(failure.message).toMatch(/reminders, to-dos and goals/u);
    expect(failure.message).not.toMatch(/credential is no longer accepted/u);
  });

  it("should render a 404 as a refusal rather than an empty success", async () => {
    const failure = failureOf(await client.get("/reminders/syl:reminder:nope"));

    expect(failure.kind).toBe("refused");
    expect(failure.code).toBe("NOT_FOUND");
  });

  it("should never throw, whatever the service answers", async () => {
    // The whole contract of this module in one line. A throw crosses the tool
    // boundary as a stack trace and reaches the Commander as silence.
    await expect(client.get("/logs")).resolves.toMatchObject({ ok: false });
    await expect(client.post("/reminders", { text: "" })).resolves.toMatchObject({ ok: false });
    await expect(client.del("/reminders/syl:reminder:nope")).resolves.toMatchObject({ ok: false });
  });
});

describe("SylApiClient, when the transport fails", () => {
  it("should report an unreachable service, naming where it tried", async () => {
    const failure = failureOf(await unreachableClient().get("/reminders"));

    expect(failure.kind).toBe("unreachable");
    expect(failure.status).toBeNull();
    expect(failure.message).toContain("127.0.0.1:1");
  });

  it("should mark an unreachable service retryable — it may simply be starting", async () => {
    expect(failureOf(await unreachableClient().get("/reminders")).retryable).toBe(true);
  });

  it("should report a timeout as its own kind, not as a refusal", async () => {
    const slow = clientWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      { timeoutMs: 20 },
    );

    const failure = failureOf(await slow.get("/reminders"));

    expect(failure.kind).toBe("timed_out");
    expect(failure.retryable).toBe(true);
  });

  it("should report a body that is not one of the two envelopes", async () => {
    // A proxy, a captive portal, a Tailscale error page. A client that cannot
    // parse an envelope has hit something that is not Syl, and saying so is
    // more useful than a JSON parse error.
    const wrong = clientWith(async () => new Response("<html>gateway</html>", { status: 200 }));

    const failure = failureOf(await wrong.get("/reminders"));

    expect(failure.kind).toBe("malformed");
    expect(failure.message).toMatch(/envelope/u);
  });

  it("should report a failure status whose body is not an envelope either", async () => {
    const wrong = clientWith(async () => new Response("nope", { status: 502 }));

    const failure = failureOf(await wrong.get("/reminders"));

    expect(failure.kind).toBe("malformed");
    expect(failure.status).toBe(502);
  });

  it("should treat a success envelope with no data as malformed rather than undefined", async () => {
    // `undefined` typed as `T` is the failure a conformance check exists to
    // prevent, and it would reach her as a reminder object with no id.
    const empty = clientWith(
      async () =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    expect(failureOf(await empty.get("/reminders")).kind).toBe("malformed");
  });

  it("should survive a transport that throws something that is not an Error", async () => {
    const hostile = clientWith(() => Promise.reject("just a string"));

    expect(failureOf(await hostile.get("/reminders")).kind).toBe("unreachable");
  });
});

describe("SylApiClient, on construction", () => {
  it("should refuse a base URL that is not loopback", () => {
    // Her credential must never leave the machine. A misconfigured base URL is
    // the one way it could, and it is a programming error rather than a runtime
    // outcome — so this throws where every other failure here does not.
    expect(
      () => new SylApiClient({ baseUrl: "https://example.com/api/v1", token: "syl_pat_x" }),
    ).toThrow(/loopback/iu);
  });

  it("should refuse a tailnet address, which is reachable and still not this machine", () => {
    expect(
      () => new SylApiClient({ baseUrl: "http://100.64.1.2:4201/api/v1", token: "syl_pat_x" }),
    ).toThrow(/loopback/iu);
  });

  it("should accept the three spellings of this machine", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(
        () => new SylApiClient({ baseUrl: `http://${host}:4201/api/v1`, token: "syl_pat_x" }),
      ).not.toThrow();
    }
  });

  it("should accept the rest of 127.0.0.0/8, which the kernel also treats as loopback", () => {
    expect(
      () => new SylApiClient({ baseUrl: "http://127.0.0.53:4201/api/v1", token: "syl_pat_x" }),
    ).not.toThrow();
  });

  it("should refuse a hostname that is not localhost, whatever it resolves to", () => {
    // What a name resolves to is not a property of the configuration, and this
    // check exists to make the configuration legible.
    expect(
      () => new SylApiClient({ baseUrl: "http://syl.local:4201/api/v1", token: "syl_pat_x" }),
    ).toThrow(/loopback/iu);
  });

  it("should refuse a base URL it cannot parse", () => {
    expect(() => new SylApiClient({ baseUrl: "not a url", token: "syl_pat_x" })).toThrow();
  });

  it("should refuse an empty token, which would fail on every call instead of here", () => {
    expect(
      () => new SylApiClient({ baseUrl: "http://127.0.0.1:4201/api/v1", token: "" }),
    ).toThrow(/token/iu);
  });
});
