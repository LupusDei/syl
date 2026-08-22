import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ASK_SECRET_PREFIX,
  hashAskSecret,
  mintAskSecret,
  verifyAskCredential,
  ASK_REJECTION_MESSAGE,
} from "../../src/face/ask-credential.js";
import { FaceSessionStore } from "../../src/face/face-session-store.js";
import { TOKEN_PREFIX } from "../../src/services/api-key-service.js";
import type { Clock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";

/**
 * The credential the avatar presents when it calls back to ask her something.
 *
 * It is deliberately NOT an `api_keys` row. A `device` key is the Commander's
 * phone, a standing credential for his own data with a Principal behind it;
 * this is a one-purpose token for a machine, alive for the minutes one face
 * session lasts. The tests below assert both directions of that separation,
 * because the way this leaks is somebody widening a scope check.
 */
describe("the ask_syl per-session credential", () => {
  let database: SylDatabase;
  let sessions: FaceSessionStore;
  let now: number;
  const clock: Clock = () => now;

  const AVATAR = "48cbc73d-f47f-41de-bed8-58a532b3b84b";
  const FIVE_MINUTES = 5 * 60 * 1_000;

  beforeEach(() => {
    now = Date.parse("2026-08-21T12:00:00.000Z");
    database = openDatabase({ path: IN_MEMORY });
    sessions = new FaceSessionStore({ db: database.handle, clock });
  });

  afterEach(() => {
    database.close();
  });

  /** Open a session holding a freshly minted credential, as the broker does. */
  function openWithCredential(id = "rts_one", expiresAt = now + FIVE_MINUTES) {
    const minted = mintAskSecret();
    sessions.open({
      id,
      avatarId: AVATAR,
      credits: 2,
      dollars: 0.02,
      askSecretHash: minted.hash,
      askExpiresAt: expiresAt,
    });
    return minted.secret;
  }

  describe("minting", () => {
    it("should mint a secret nobody can confuse with a device token", () => {
      const { secret } = mintAskSecret();

      expect(secret.startsWith(ASK_SECRET_PREFIX)).toBe(true);
      expect(secret.startsWith(TOKEN_PREFIX)).toBe(false);
      expect(ASK_SECRET_PREFIX).not.toBe(TOKEN_PREFIX);
    });

    it("should mint a different secret every time", () => {
      const seen = new Set(Array.from({ length: 50 }, () => mintAskSecret().secret));

      expect(seen.size).toBe(50);
    });

    it("should hand back the hash and never keep the secret", () => {
      const { secret, hash } = mintAskSecret();

      expect(hash).toBe(hashAskSecret(secret));
      expect(hash).not.toContain(secret);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("verifying", () => {
    it("should accept the secret minted for that session", () => {
      const secret = openWithCredential();

      const result = verifyAskCredential({ sessions, sessionId: "rts_one", secret, now });

      expect(result.ok).toBe(true);
      expect(result.ok && result.session.id).toBe("rts_one");
    });

    it("should reject the secret of ANOTHER live session", () => {
      openWithCredential("rts_one");
      const otherSecret = openWithCredential("rts_two");

      const result = verifyAskCredential({
        sessions,
        sessionId: "rts_one",
        secret: otherSecret,
        now,
      });

      expect(result.ok).toBe(false);
    });

    it("should reject a credential after its session has ended", () => {
      const secret = openWithCredential();
      expect(verifyAskCredential({ sessions, sessionId: "rts_one", secret, now }).ok).toBe(true);

      sessions.settle({ id: "rts_one", ended: "closed", credits: 4, dollars: 0.04 });

      const result = verifyAskCredential({ sessions, sessionId: "rts_one", secret, now });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe("settled");
    });

    it("should reject a credential after it has been reaped as idle", () => {
      const secret = openWithCredential();
      sessions.settle({ id: "rts_one", ended: "reaped", credits: 4, dollars: 0.04 });

      expect(verifyAskCredential({ sessions, sessionId: "rts_one", secret, now }).ok).toBe(false);
    });

    it("should expire on its own even if the session was never settled", () => {
      // Belt and braces: a process that died without settling must not leave a
      // credential live forever on a row nothing will ever close.
      const secret = openWithCredential("rts_one", now + FIVE_MINUTES);

      const result = verifyAskCredential({
        sessions,
        sessionId: "rts_one",
        secret,
        now: now + FIVE_MINUTES,
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe("expired");
    });

    it("should still accept one millisecond before the expiry", () => {
      const secret = openWithCredential("rts_one", now + FIVE_MINUTES);

      expect(
        verifyAskCredential({ sessions, sessionId: "rts_one", secret, now: now + FIVE_MINUTES - 1 })
          .ok,
      ).toBe(true);
    });

    it("should reject a malformed secret without touching the store", () => {
      openWithCredential();

      for (const secret of ["", "   ", "not-a-secret", `${TOKEN_PREFIX}0123456789abcdef`]) {
        expect(verifyAskCredential({ sessions, sessionId: "rts_one", secret, now }).ok).toBe(false);
      }
    });

    it("should reject a well-formed secret for a session that does not exist", () => {
      const { secret } = mintAskSecret();

      const result = verifyAskCredential({ sessions, sessionId: "rts_nobody", secret, now });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe("unknown_session");
    });
  });

  describe("what a rejected caller learns", () => {
    it("should give every rejection the same outward message", () => {
      const secret = openWithCredential("rts_one");
      sessions.settle({ id: "rts_one", ended: "closed", credits: 4, dollars: 0.04 });
      const { secret: strayCredential } = mintAskSecret();

      const rejections = [
        verifyAskCredential({ sessions, sessionId: "rts_one", secret, now }),
        verifyAskCredential({ sessions, sessionId: "rts_nobody", secret: strayCredential, now }),
        verifyAskCredential({ sessions, sessionId: "rts_one", secret: "junk", now }),
      ];

      for (const rejection of rejections) {
        expect(rejection.ok).toBe(false);
        expect(rejection.ok === false && rejection.message).toBe(ASK_REJECTION_MESSAGE);
      }
    });

    it("should not disclose whether a session id exists", () => {
      // The reason is internal — it goes to the log, where it answers "why did
      // her face stop answering". It must not be derivable from the message.
      const unknown = verifyAskCredential({
        sessions,
        sessionId: "rts_nobody",
        secret: mintAskSecret().secret,
        now,
      });
      openWithCredential("rts_real");
      const wrongSecret = verifyAskCredential({
        sessions,
        sessionId: "rts_real",
        secret: mintAskSecret().secret,
        now,
      });

      expect(unknown.ok).toBe(false);
      expect(wrongSecret.ok).toBe(false);
      expect(unknown.ok === false && unknown.message).toBe(
        wrongSecret.ok === false ? wrongSecret.message : "",
      );
    });

    it("should say nothing about the session in the message itself", () => {
      const result = verifyAskCredential({
        sessions,
        sessionId: "rts_a_very_distinctive_id",
        secret: mintAskSecret().secret,
        now,
      });

      expect(result.ok === false && result.message).not.toContain("rts_a_very_distinctive_id");
    });
  });
});
