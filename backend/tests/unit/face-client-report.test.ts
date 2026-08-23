import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLIENT_STATES,
  ClientReportIngress,
  MAX_DETAIL,
  REPORT_REJECTION_MESSAGE,
  hashSessionKey,
  isClientState,
} from "../../src/face/client-report.js";
import { FaceSessionStore } from "../../src/face/face-session-store.js";
import type { Clock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";

/**
 * What became of her face on the CLIENT — `0037`.
 *
 * ## The failure these tests exist for
 *
 * On 2026-08-23 two sessions opened on the Commander's phone, ninety cents,
 * both reaped, and `last_activity_at` equalled `opened_at` to the millisecond
 * on both rows. She was never asked anything. Every server-side signal was
 * green, because everything that could have gone wrong went wrong inside a
 * `WKWebView` the server cannot see into — and a blank record was compatible
 * both with "it worked" and with "the document never ran".
 *
 * So the properties under test are the ones that make an absence mean
 * something: the page can say what happened, only the page can, and saying it
 * changes nothing else about the session.
 */
describe("the client report ingress", () => {
  let database: SylDatabase;
  let sessions: FaceSessionStore;
  let reports: ClientReportIngress;
  let logged: { event: string; fields: Record<string, unknown> }[];
  let now: number;
  const clock: Clock = () => now;

  const AVATAR = "48cbc73d-f47f-41de-bed8-58a532b3b84b";
  const KEY = "stk_thepagesownshortlivedkey";

  beforeEach(() => {
    now = Date.parse("2026-08-23T00:17:00.000Z");
    logged = [];
    database = openDatabase({ path: IN_MEMORY });
    sessions = new FaceSessionStore({ db: database.handle, clock });
    reports = new ClientReportIngress({
      sessions,
      now: clock,
      log: (event, fields) => logged.push({ event, fields }),
    });
  });

  afterEach(() => {
    database.close();
  });

  /** A live session whose page holds {@link KEY}. */
  function open(id = "rts_one", key: string | null = KEY) {
    const session = sessions.open({
      id,
      avatarId: AVATAR,
      credits: 2,
      dollars: 0.02,
      askSecretHash: `ask-hash-of-${id}`,
      askExpiresAt: now + 300_000,
    });
    if (key !== null) sessions.bindClientCredential(id, hashSessionKey(key));
    return session;
  }

  describe("the vocabulary", () => {
    it("should accept every word it publishes", () => {
      open();

      for (const state of CLIENT_STATES) {
        expect(reports.report({ sessionId: "rts_one", secret: KEY, state }).ok).toBe(true);
      }
      expect(sessions.get("rts_one")?.clientState).toBe(CLIENT_STATES.at(-1));
    });

    it("should refuse a word it does not publish, and say which words it takes", () => {
      open();

      const outcome = reports.report({ sessionId: "rts_one", secret: KEY, state: "everything is on fire" });

      // The ONE distinguishable rejection, and safely so: it discloses nothing
      // about which sessions exist or which credential is right. A closed
      // vocabulary is what stops this becoming a free-text pipe from a web view
      // into his database.
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toBe("unknown_state");
      expect(outcome.ok === false && outcome.message).toContain("autoplay_blocked");
      expect(sessions.get("rts_one")?.clientState).toBeNull();
    });

    it("should not treat a non-string as a state", () => {
      open();

      for (const state of [undefined, null, 42, { state: "connected" }, ["connected"]]) {
        expect(isClientState(state)).toBe(false);
        expect(reports.report({ sessionId: "rts_one", secret: KEY, state }).ok).toBe(false);
      }
    });
  });

  describe("the credential", () => {
    it("should accept the session key the page was given to draw her with", () => {
      open();

      const outcome = reports.report({ sessionId: "rts_one", secret: KEY, state: "connected" });

      expect(outcome.ok).toBe(true);
      expect(sessions.get("rts_one")?.clientState).toBe("connected");
    });

    it("should refuse the ask_syl credential, which is a different power entirely", () => {
      open();

      // A browser holding the ask credential could speak AS THE AVATAR and
      // drive her turns. The two must never be interchangeable, and the check
      // is that the ask hash on this very row does not open this door.
      const outcome = reports.report({
        sessionId: "rts_one",
        secret: "ask-hash-of-rts_one",
        state: "connected",
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toBe("mismatch");
    });

    it("should refuse a session that never readied, because it has no key", () => {
      // The provider issues no session key before READY, so a session charged
      // for and never readied can never accept a report. NULL refuses.
      open("rts_never_ready", null);

      const outcome = reports.report({
        sessionId: "rts_never_ready",
        secret: KEY,
        state: "connected",
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toBe("no_credential");
    });

    it("should stop accepting reports once the session is settled", () => {
      open();
      sessions.settle({ id: "rts_one", ended: "reaped", credits: 44, dollars: 0.44 });

      const outcome = reports.report({ sessionId: "rts_one", secret: KEY, state: "left" });

      // The route closes with the session, structurally: the credential is a
      // column of the row being settled, so there is no sweeper to run.
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toBe("settled");
    });

    it("should tell a rejected caller nothing about which of them it was", () => {
      open();

      const messages = new Set(
        [
          { sessionId: "rts_one", secret: "wrong" },
          { sessionId: "rts_nosuch", secret: KEY },
          { sessionId: "rts_one", secret: "" },
        ].map((input) => {
          const outcome = reports.report({ ...input, state: "connected" });
          return outcome.ok ? "accepted" : outcome.message;
        }),
      );

      expect(messages).toEqual(new Set([REPORT_REJECTION_MESSAGE]));
    });

    it("should refuse an unauthenticated caller BEFORE it looks at the word", () => {
      open();

      const outcome = reports.report({
        sessionId: "rts_one",
        secret: "wrong",
        state: "everything is on fire",
      });

      // Authenticate first, validate second — the `/logs` ordering one layer
      // in. Reversed, a caller with no credential could tell a route that
      // exists from one that does not by the difference between a 400 and a
      // 401, and Syl's own key would get a 400 from a surface she may not
      // reach at all.
      expect(outcome.ok === false && outcome.reason).toBe("mismatch");
      expect(outcome.ok === false && outcome.message).toBe(REPORT_REJECTION_MESSAGE);
    });

    it("should log the reason it did not tell the caller", () => {
      open();

      reports.report({ sessionId: "rts_nosuch", secret: KEY, state: "connected" });

      // "Why did her face stop reporting" is a question the operator is owed
      // and the caller is not.
      const refusal = logged.find((line) => line.event === "face.client.report_refused");
      expect(refusal?.fields["reason"]).toBe("unknown_session");
    });
  });

  describe("what a report may and may not change", () => {
    it("should NEVER move lastActivityAt", () => {
      const opened = open();
      now += 90_000;

      reports.report({ sessionId: "rts_one", secret: KEY, state: "connected" });

      // **The load-bearing one.** `last_activity_at` is the idle reaper's only
      // input, so a page reporting its state would otherwise hold a mute,
      // billing face open at twenty cents a minute forever — and it is also the
      // field that diagnosed this failure at all, equal to `opened_at` on both
      // of his ninety cents. Telemetry is not activity.
      expect(sessions.get("rts_one")?.lastActivityAt).toBe(opened.lastActivityAt);
      expect(sessions.get("rts_one")?.clientStateAt).toBe("2026-08-23T00:18:30.000Z");
    });

    it("should move no money and settle nothing", () => {
      const opened = open();

      reports.report({ sessionId: "rts_one", secret: KEY, state: "autoplay_blocked" });

      const after = sessions.get("rts_one");
      expect(after?.credits).toBe(opened.credits);
      expect(after?.closedAt).toBeNull();
      expect(after?.ended).toBeNull();
    });

    it("should keep the last word rather than the first", () => {
      open();

      reports.report({ sessionId: "rts_one", secret: KEY, state: "booting" });
      reports.report({ sessionId: "rts_one", secret: KEY, state: "sdk_loaded" });
      reports.report({ sessionId: "rts_one", secret: KEY, state: "autoplay_blocked" });

      // The row answers "what was the last thing that session knew about
      // itself", which is what the reaper needs to explain a dead face. The
      // narrative is the log's job.
      expect(sessions.get("rts_one")?.clientState).toBe("autoplay_blocked");
    });
  });

  describe("the detail", () => {
    it("should keep what the page attached", () => {
      open();

      reports.report({
        sessionId: "rts_one",
        secret: KEY,
        state: "mic_denied",
        detail: "NotAllowedError: Permission denied",
      });

      expect(sessions.get("rts_one")?.clientDetail).toBe("NotAllowedError: Permission denied");
    });

    it("should bound it rather than refuse it", () => {
      open();

      reports.report({ sessionId: "rts_one", secret: KEY, state: "failed", detail: "x".repeat(9_000) });

      // A page that is already failing must not fail twice because its error
      // message was long. Cut, never refused.
      expect(sessions.get("rts_one")?.clientDetail).toHaveLength(MAX_DETAIL);
    });

    it("should record nothing rather than a non-string", () => {
      open();

      reports.report({ sessionId: "rts_one", secret: KEY, state: "ended", detail: { why: "?" } });

      expect(sessions.get("rts_one")?.clientDetail).toBeNull();
    });
  });

  describe("the log", () => {
    it("should give a stalled face its own event name", () => {
      open();

      reports.report({ sessionId: "rts_one", secret: KEY, state: "connected" });
      reports.report({ sessionId: "rts_one", secret: KEY, state: "autoplay_blocked", detail: "1 paused" });

      // The one query worth having is "did a face stall, and why". It is a
      // search for a word rather than a filter over every state a healthy call
      // passes through.
      expect(logged.map((line) => line.event)).toEqual([
        "face.client.state",
        "face.client.stalled",
      ]);
      expect(logged.at(-1)?.fields).toMatchObject({
        sessionId: "rts_one",
        state: "autoplay_blocked",
        detail: "1 paused",
      });
    });
  });
});
