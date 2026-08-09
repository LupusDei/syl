import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PAIRING_CODE_TTL_MS,
  hashToken,
  PairingError,
  THE_COMMANDER,
  TOKEN_PREFIX,
  type ApiKeyService,
} from "../../src/services/api-key-service.js";
import type { SylDatabase } from "../../src/services/database.js";
import { countingEntropy, TEST_NOW, testDatabase, testKeys } from "../helpers/service.js";

let db: SylDatabase;
let now: number;
let keys: ApiKeyService;

/** A service whose clock the test moves. */
function build(options: { tokenTtlMs?: number; pairingCodeTtlMs?: number } = {}): ApiKeyService {
  return testKeys(db, {
    clock: () => now,
    entropy: countingEntropy(),
    ...options,
  });
}

beforeEach(() => {
  db = testDatabase();
  now = TEST_NOW;
  keys = build();
});

afterEach(() => {
  db.close();
});

/** Pair a device through the front door and return its token. */
function pairedToken(name = "Commander's iPhone"): string {
  return keys.pair(keys.issuePairingCode().code, name).token;
}

describe("issuePairingCode", () => {
  it("should mint a readable eight-digit code with an expiry", () => {
    const issued = keys.issuePairingCode();

    expect(issued.code).toMatch(/^\d{4}-\d{4}$/);
    expect(issued.expiresAt).toBe(new Date(now + DEFAULT_PAIRING_CODE_TTL_MS).toISOString());
  });

  it("should return the same code while it is live, not a moving target", () => {
    const first = keys.issuePairingCode();
    now += 1_000;

    expect(keys.issuePairingCode().code).toBe(first.code);
  });

  it("should mint a fresh code once the last one has expired", () => {
    const first = keys.issuePairingCode();
    now += DEFAULT_PAIRING_CODE_TTL_MS + 1;

    expect(keys.issuePairingCode().code).not.toBe(first.code);
  });
});

describe("pair", () => {
  it("should exchange a live code for a Bearer grant naming the one principal", () => {
    const grant = keys.pair(keys.issuePairingCode().code, "Commander's iPhone");

    expect(grant.tokenType).toBe("Bearer");
    expect(grant.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(grant.principal).toEqual(THE_COMMANDER);
    expect(grant.expiresAt > new Date(now).toISOString()).toBe(true);
  });

  it("should consume the code, so a captured one cannot pair a second device", () => {
    // The whole scheme rests on the code being seen once, on a console the
    // Commander is sitting at. A replayable code pairs an attacker's device
    // just as well as his.
    const code = keys.issuePairingCode().code;
    keys.pair(code, "Commander's iPhone");

    expect(() => keys.pair(code, "Somebody else's iPhone")).toThrow(PairingError);
  });

  it("should refuse a code that is not the current one", () => {
    keys.issuePairingCode();

    expect(() => keys.pair("0000-0000", "Attacker")).toThrow(/not the current/);
  });

  it("should refuse a code that has expired", () => {
    const code = keys.issuePairingCode().code;
    now += DEFAULT_PAIRING_CODE_TTL_MS + 1;

    expect(() => keys.pair(code, "Late device")).toThrow(/expired/);
  });

  it("should refuse a malformed code without consulting the live one", () => {
    keys.issuePairingCode();

    try {
      keys.pair("not-a-code", "Attacker");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as PairingError).reason).toBe("malformed");
    }
  });

  it("should refuse when no code has been issued at all", () => {
    try {
      keys.pair("1234-5678", "Attacker");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as PairingError).reason).toBe("unknown");
    }
  });
});

describe("the stored row", () => {
  it("should never contain the token, only its SHA-256", () => {
    // A copy of syl.db must yield nothing that can be presented to the API.
    const token = pairedToken();

    const rows = db.handle.prepare("SELECT token_hash, token_suffix FROM api_keys").all();
    const stored = JSON.stringify(rows);

    expect(stored).not.toContain(token);
    expect(stored).toContain(createHash("sha256").update(token, "utf8").digest("hex"));
  });

  it("should keep only the last four characters for display", () => {
    const token = pairedToken();

    const row = db.handle.prepare("SELECT token_suffix FROM api_keys").get() as {
      token_suffix: string;
    };

    expect(row.token_suffix).toBe(token.slice(-4));
    expect(row.token_suffix).toHaveLength(4);
  });

  it("should refuse two keys hashing to the same value", () => {
    // Lookup is by hash. A duplicate would make "which device is this" have
    // two answers, and the schema is what stops that rather than a code path
    // somebody has to remember to write.
    const token = pairedToken();

    expect(() =>
      db.handle
        .prepare(
          "INSERT INTO api_keys (id, token_hash, token_suffix, device_name, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          "syl:apikey:00000000-0000-7000-8000-000000000002",
          hashToken(token),
          "aaaa",
          "Clone",
          "2026-08-09T07:00:00.000Z",
        ),
    ).toThrow(/UNIQUE/i);
  });
});

describe("verify", () => {
  it("should accept a token it just issued and name the principal", () => {
    const token = pairedToken();

    const result = keys.verify(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toEqual(THE_COMMANDER);
    expect(result.key.deviceName).toBe("Commander's iPhone");
  });

  it("should reject a token that was never issued", () => {
    const result = keys.verify(`${TOKEN_PREFIX}${"0".repeat(32)}`);

    expect(result).toEqual({ ok: false, reason: "unknown" });
  });

  it("should reject anything that is not shaped like a token", () => {
    expect(keys.verify("").ok).toBe(false);
    expect(keys.verify("Bearer something").ok).toBe(false);
    expect(keys.verify(`${TOKEN_PREFIX}short`)).toEqual({ ok: false, reason: "malformed" });
  });

  it("should reject a revoked token", () => {
    const token = pairedToken();
    const id = (db.handle.prepare("SELECT id FROM api_keys").get() as { id: string }).id;
    keys.revoke(id, "phone lost");

    expect(keys.verify(token)).toEqual({ ok: false, reason: "revoked" });
  });

  it("should reject an expired token", () => {
    keys = build({ tokenTtlMs: 1_000 });
    const token = pairedToken();
    now += 1_001;

    expect(keys.verify(token)).toEqual({ ok: false, reason: "expired" });
  });

  it("should treat the exact expiry instant as expired", () => {
    keys = build({ tokenTtlMs: 1_000 });
    const token = pairedToken();
    now += 1_000;

    expect(keys.verify(token).ok).toBe(false);
  });

  it("should record when the key was last used", () => {
    const token = pairedToken();
    now += 5_000;

    keys.verify(token);

    const row = db.handle.prepare("SELECT last_used_at FROM api_keys").get() as {
      last_used_at: string | null;
    };
    expect(row.last_used_at).toBe(new Date(now).toISOString());
  });

  it("should not write on every request, since that would make a read a write", () => {
    const token = pairedToken();
    now += 5_000;
    keys.verify(token);
    const first = (
      db.handle.prepare("SELECT last_used_at FROM api_keys").get() as { last_used_at: string }
    ).last_used_at;

    now += 1_000;
    keys.verify(token);

    const second = (
      db.handle.prepare("SELECT last_used_at FROM api_keys").get() as { last_used_at: string }
    ).last_used_at;
    expect(second).toBe(first);
  });

  it("should write again once the record is stale enough to be worth updating", () => {
    const token = pairedToken();
    keys.verify(token);
    now += 120_000;

    keys.verify(token);

    const row = db.handle.prepare("SELECT last_used_at FROM api_keys").get() as {
      last_used_at: string;
    };
    expect(row.last_used_at).toBe(new Date(now).toISOString());
  });
});

describe("revoke", () => {
  it("should report that it cut off a live key", () => {
    pairedToken();
    const id = (db.handle.prepare("SELECT id FROM api_keys").get() as { id: string }).id;

    expect(keys.revoke(id, "phone lost")).toBe(true);
  });

  it("should keep the row, so which device and when stays answerable", () => {
    pairedToken();
    const id = (db.handle.prepare("SELECT id FROM api_keys").get() as { id: string }).id;

    keys.revoke(id, "phone lost");

    const row = db.handle
      .prepare("SELECT device_name, revoked_at, revoked_reason FROM api_keys WHERE id = ?")
      .get(id) as { device_name: string; revoked_at: string; revoked_reason: string };
    expect(row.device_name).toBe("Commander's iPhone");
    expect(row.revoked_reason).toBe("phone lost");
    expect(row.revoked_at).toBe(new Date(now).toISOString());
  });

  it("should report false for a key that was already revoked", () => {
    pairedToken();
    const id = (db.handle.prepare("SELECT id FROM api_keys").get() as { id: string }).id;
    keys.revoke(id, "first");

    expect(keys.revoke(id, "second")).toBe(false);
  });

  it("should report false for an id that does not exist", () => {
    expect(keys.revoke("syl:apikey:00000000-0000-7000-8000-0000000000ff", "nope")).toBe(false);
  });
});

describe("list", () => {
  it("should be empty before anything is paired", () => {
    expect(keys.list()).toEqual([]);
  });

  it("should put live keys before revoked ones", () => {
    pairedToken("Phone");
    const phoneId = (db.handle.prepare("SELECT id FROM api_keys").get() as { id: string }).id;
    now += 1_000;
    pairedToken("Laptop");
    keys.revoke(phoneId, "sold");

    expect(keys.list().map((key) => key.deviceName)).toEqual(["Laptop", "Phone"]);
  });

  it("should never expose anything presentable to the API", () => {
    const token = pairedToken();

    expect(JSON.stringify(keys.list())).not.toContain(token);
  });
});

describe("hashToken", () => {
  it("should be SHA-256 hex", () => {
    expect(hashToken("abc")).toBe(createHash("sha256").update("abc", "utf8").digest("hex"));
  });

  it("should differ for tokens differing in one character", () => {
    expect(hashToken(`${TOKEN_PREFIX}${"0".repeat(32)}`)).not.toBe(
      hashToken(`${TOKEN_PREFIX}${"0".repeat(31)}1`),
    );
  });
});
