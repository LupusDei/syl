import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PAIRING_CODE_TTL_MS,
  hashToken,
  KEY_SCOPES,
  PAIRING_CODE_RETENTION_MS,
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

  it("should supersede the previous code rather than leave two windows open", () => {
    // This reverses the old behaviour, which returned the same code while it
    // was live so an operator did not chase a moving target. That only worked
    // while the code lived in one process's memory; it is in the store now,
    // because `npm run pair` is a *different process* from the service and the
    // database file is the only thing they share. A memo in the service would
    // keep handing out a code another process had already replaced.
    //
    // One live code at any instant is also the safer invariant on its own
    // terms: asking twice because the first slip got lost must not leave the
    // first code working.
    const first = keys.issuePairingCode();
    now += 1_000;
    const second = keys.issuePairingCode();

    expect(second.code).not.toBe(first.code);
    expect(() => keys.pair(first.code, "Late device")).toThrow(/expired/);
    expect(keys.pair(second.code, "Commander's iPhone").tokenType).toBe("Bearer");
  });

  it("should mint a fresh code once the last one has expired", () => {
    const first = keys.issuePairingCode();
    now += DEFAULT_PAIRING_CODE_TTL_MS + 1;

    expect(keys.issuePairingCode().code).not.toBe(first.code);
  });

  it("should forget codes that have been dead for longer than the retention window", () => {
    // Bounds the table, and bounds the scan: every candidate a redemption
    // compares against costs a scrypt, so an unbounded history would turn one
    // request into a minute of CPU.
    keys.issuePairingCode();
    now += PAIRING_CODE_RETENTION_MS + DEFAULT_PAIRING_CODE_TTL_MS + 1;
    keys.issuePairingCode();

    const rows = db.handle.prepare("SELECT id FROM pairing_codes").all();
    expect(rows).toHaveLength(1);
  });

  it("should never write the code itself, only a salted hash of it", () => {
    // Eight digits is 10^8. A SHA-256 of one is reversible in seconds by
    // anyone who can read this file, which would turn read access to syl.db —
    // which yields no usable credential today — into the ability to mint one.
    const issued = keys.issuePairingCode();

    const stored = JSON.stringify(db.handle.prepare("SELECT * FROM pairing_codes").all());

    expect(stored).not.toContain(issued.code);
    expect(stored).not.toContain(issued.code.replace("-", ""));
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

    try {
      keys.pair(code, "Somebody else's iPhone");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PairingError);
      // Not "wrong code". Telling the Commander to retype eight digits he has
      // already spent is how a person ends up doing it four times.
      expect((error as PairingError).reason).toBe("already_used");
    }
    expect(db.handle.prepare("SELECT id FROM api_keys").all()).toHaveLength(1);
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

  it("should give a guess and a dead window the same answer, and a held code a better one", () => {
    // The security property that lets pairing distinguish its failures at all.
    //
    // `expired` and `already_used` are reachable *only* by presenting a code
    // that matches a stored one. Everything else — a wrong guess, an attempt
    // made while nothing is live — is one indistinguishable `unknown`. So an
    // attacker cannot learn when a pairing window is open, and the Commander,
    // who does hold the code, is told which of the four things went wrong.
    const wrongGuessWithNoWindow = reasonFor(() => keys.pair("1234-5678", "Attacker"));

    const live = keys.issuePairingCode().code;
    const wrongGuessWithAWindowOpen = reasonFor(() =>
      keys.pair(live === "0000-0000" ? "1111-1111" : "0000-0000", "Attacker"),
    );

    expect(wrongGuessWithAWindowOpen).toBe(wrongGuessWithNoWindow);
    expect(wrongGuessWithAWindowOpen).toBe("unknown");

    // And the holder of the code gets the useful answer.
    now += DEFAULT_PAIRING_CODE_TTL_MS + 1;
    expect(reasonFor(() => keys.pair(live, "Commander's iPhone"))).toBe("expired");
  });
});

/** The reason a pairing attempt failed with, for tests that compare them. */
function reasonFor(attempt: () => unknown): string {
  try {
    attempt();
  } catch (error) {
    if (error instanceof PairingError) return error.reason;
    throw error;
  }
  throw new Error("that pairing attempt was expected to fail and did not");
}

describe("single use, as the store enforces it", () => {
  /**
   * The constraint, reached directly.
   *
   * `pair` marks a code redeemed and inserts the key inside one transaction,
   * so the ordinary path never gets here. This is the backstop under it: a
   * UNIQUE index on `api_keys.pairing_code_id` means one pairing code can mint
   * at most one key **whatever the calling code does** — including a future
   * refactor that reintroduces a read-modify-write, and including a second
   * process that never runs any of this file.
   */
  it("should refuse two keys claiming the same pairing code", () => {
    keys.pair(keys.issuePairingCode().code, "Commander's iPhone");
    const pairingCodeId = (
      db.handle.prepare("SELECT pairing_code_id FROM api_keys").get() as {
        pairing_code_id: string;
      }
    ).pairing_code_id;

    expect(pairingCodeId).not.toBeNull();
    expect(() =>
      db.handle
        .prepare(
          `INSERT INTO api_keys (id, token_hash, token_suffix, device_name, created_at, pairing_code_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "syl:apikey:00000000-0000-7000-8000-000000000003",
          "not-a-real-hash",
          "bbbb",
          "Somebody else's iPhone",
          "2026-08-09T07:00:00.000Z",
          pairingCodeId,
        ),
    ).toThrow(/UNIQUE/i);
  });

  it("should still allow many keys minted without a pairing code", () => {
    // SQLite treats NULLs as distinct in a UNIQUE index. If it did not, the
    // console bootstrap path would break the second time it was used, and the
    // constraint above would be unshippable.
    keys.mint("Console bootstrap");
    keys.mint("Console bootstrap, again");

    expect(db.handle.prepare("SELECT id FROM api_keys").all()).toHaveLength(2);
  });

  it("should let a redeemed code be forgotten without disturbing the key it granted", () => {
    // `ON DELETE SET NULL`. The retention purge has to be able to run without
    // the foreign key refusing it, or the table grows forever.
    const token = keys.pair(keys.issuePairingCode().code, "Commander's iPhone").token;
    db.handle.prepare("DELETE FROM pairing_codes").run();

    expect(keys.verify(token).ok).toBe(true);
    expect(
      (db.handle.prepare("SELECT pairing_code_id FROM api_keys").get() as {
        pairing_code_id: string | null;
      }).pairing_code_id,
    ).toBeNull();
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

/**
 * The scope, and the asymmetry that makes it worth having.
 *
 * The claim being tested is not "there is a column". It is that **the only way
 * to obtain an admin key is to be able to write to this database** — no HTTP
 * path reaches it — and that everything already paired stays weak.
 */
describe("key scope", () => {
  it("should mint `device` from a pairing code, always", () => {
    const grant = keys.pair(keys.issuePairingCode().code, "Commander's iPhone");
    const record = keys.list()[0];

    expect(keys.verify(grant.token)).toMatchObject({ ok: true, key: { scope: "device" } });
    expect(record?.scope).toBe("device");
  });

  it("should default a console mint to `device` as well, so admin is always deliberate", () => {
    // The weak default is the point: a caller that forgets to say what it wants
    // gets the scope that can do less. A widening default turns every future
    // `mint` call site into a potential hole.
    const grant = keys.mint("Console bootstrap");

    expect(keys.verify(grant.token)).toMatchObject({ ok: true, key: { scope: "device" } });
  });

  it("should mint `admin` only when the console asks for it by name", () => {
    const grant = keys.mint("Web admin (console)", { scope: "admin" });

    expect(keys.verify(grant.token)).toMatchObject({ ok: true, key: { scope: "admin" } });
  });

  it("should keep the two scopes apart on the same store", () => {
    const device = keys.pair(keys.issuePairingCode().code, "Commander's iPhone");
    const admin = keys.mint("Web admin (console)", { scope: "admin" });

    expect(keys.verify(device.token)).toMatchObject({ key: { scope: "device" } });
    expect(keys.verify(admin.token)).toMatchObject({ key: { scope: "admin" } });
    expect(keys.liveKeysWithScope("admin").map((key) => key.deviceName)).toEqual([
      "Web admin (console)",
    ]);
  });

  it("should stop counting a revoked admin key as live", () => {
    const admin = keys.mint("Web admin (console)", { scope: "admin" });
    const record = keys.liveKeysWithScope("admin")[0];
    keys.revoke(record?.id ?? "", "browser retired");

    expect(keys.liveKeysWithScope("admin")).toEqual([]);
    expect(keys.verify(admin.token)).toEqual({ ok: false, reason: "revoked" });
  });

  it("should mint `agent` only when the service asks for it by name", () => {
    const grant = keys.mint("Syl (her own hands)", { scope: "agent" });

    expect(keys.verify(grant.token)).toMatchObject({ ok: true, key: { scope: "agent" } });
  });

  it("should never mint `agent` from a pairing code, however the body is spelled", () => {
    // `pair` takes a code and a device name and NOTHING else. This is the claim
    // that makes the scope defensible: not that the route currently passes
    // "device", but that there is no parameter through which a caller could ask
    // for anything else. The assertion is on the signature as much as the row.
    const grant = keys.pair(keys.issuePairingCode().code, "Commander's iPhone");

    expect(keys.pair.length).toBe(2);
    expect(keys.verify(grant.token)).toMatchObject({ ok: true, key: { scope: "device" } });
    expect(keys.liveKeysWithScope("agent")).toEqual([]);
  });

  it("should keep all three scopes apart on the same store", () => {
    const device = keys.pair(keys.issuePairingCode().code, "Commander's iPhone");
    const admin = keys.mint("Web admin (console)", { scope: "admin" });
    const agent = keys.mint("Syl (her own hands)", { scope: "agent" });

    expect(keys.verify(device.token)).toMatchObject({ key: { scope: "device" } });
    expect(keys.verify(admin.token)).toMatchObject({ key: { scope: "admin" } });
    expect(keys.verify(agent.token)).toMatchObject({ key: { scope: "agent" } });
    expect(keys.liveKeysWithScope("agent").map((key) => key.deviceName)).toEqual([
      "Syl (her own hands)",
    ]);
  });

  it("should stop counting a revoked agent key as live, so her hands can be taken away", () => {
    // US3: revoking her must stop her acting. It is the same mechanism as a
    // phone, which is the whole reason her credential lives in this table.
    const agent = keys.mint("Syl (her own hands)", { scope: "agent" });
    const record = keys.liveKeysWithScope("agent")[0];
    keys.revoke(record?.id ?? "", "hands withdrawn");

    expect(keys.liveKeysWithScope("agent")).toEqual([]);
    expect(keys.verify(agent.token)).toEqual({ ok: false, reason: "revoked" });
  });

  it("should list every scope it knows, so a caller cannot iterate a stale set", () => {
    expect([...KEY_SCOPES].sort()).toEqual(["admin", "agent", "device"]);
  });

  it("should refuse a scope the schema does not know", () => {
    // The CHECK constraint in 0014, widened by 0015. A typo must fail at the write: an
    // unrecognised scope compared against "admin" denies access, which is safe
    // and then looks exactly like a bug in the middleware.
    expect(() =>
      db.handle
        .prepare(
          `INSERT INTO api_keys (id, token_hash, token_suffix, device_name, scope, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("syl:apikey:x", "hash", "aaaa", "Typo", "Admin", "2026-08-09T07:00:00.000Z"),
    ).toThrow(/CHECK/i);
  });

  it("should read an unrecognised stored scope as the weaker one", () => {
    // A database restored from a future version, or edited by hand. Widening
    // on an unknown value would turn a stray string into an open door; the
    // CHECK above means this service can never write one itself.
    const grant = keys.mint("Console bootstrap");
    // The CHECK is what stops this service writing such a row, so it has to be
    // stood down to produce one at all — which is itself the evidence that the
    // constraint above is load-bearing rather than decorative.
    db.handle.exec("PRAGMA ignore_check_constraints = ON");
    db.handle
      .prepare("UPDATE api_keys SET scope = 'superuser' WHERE token_hash = ?")
      .run(hashToken(grant.token));
    db.handle.exec("PRAGMA ignore_check_constraints = OFF");

    expect(keys.verify(grant.token)).toMatchObject({ ok: true, key: { scope: "device" } });
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
