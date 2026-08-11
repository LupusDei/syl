import { createHash, scryptSync, timingSafeEqual } from "node:crypto";

import type { Principal, TokenGrant } from "@syl/shared";

import { hasExpired, instant, systemClock, type Clock } from "./clock.js";
import { newId } from "./id.js";
import { systemEntropy, type Entropy } from "./id.js";
import type { Database } from "./sqlite.js";

/**
 * Bearer tokens, and the pairing that mints them.
 *
 * Syl answers to the Commander and to nobody else. There are no accounts, no
 * multi-tenancy, and no user table — one principal, and a list of devices that
 * have been paired with it. That constraint deletes an enormous amount of
 * normally-mandatory work, and the corresponding obligation is that the small
 * amount left is done properly.
 *
 * Three properties, each of which is the thing that goes wrong when it is
 * missing:
 *
 * * **The token is never stored.** Only its SHA-256, which is also what
 *   lookup happens by. A copy of `syl.db` therefore contains nothing that can
 *   be presented to the API.
 * * **The pairing code is compared in constant time and is single-use.** It is
 *   eight digits — small enough that a comparison leaking its prefix through
 *   timing is a real attack rather than a theoretical one, and small enough
 *   that it must not be replayable. Single use is enforced by a UNIQUE index
 *   on `api_keys.pairing_code_id`, not by anything in this file; see
 *   `0009_pairing_codes.sql`.
 * * **Every rejection has a distinguishable reason internally and one
 *   indistinguishable message externally.** The service needs to know whether
 *   a token was revoked or merely unknown; a caller must not be able to learn
 *   which, because that turns the API into an oracle for guessing tokens.
 *
 * ## The one place that last rule is deliberately relaxed
 *
 * Pairing tells three failures apart — expired, already used, and everything
 * else — and that is not a hole. `expired` and `already_used` are returned
 * **only when the presented code matches a stored one**, so the only caller
 * who can ever see them is a caller who already holds the code. Every guess
 * that is merely wrong, and every attempt made while no code is live, comes
 * back as the same `unknown`. An attacker learns nothing; the Commander,
 * standing in a kitchen holding a phone with no debugger attached, learns
 * exactly which of the four things went wrong.
 */

/** The one principal. Not a row: a constant, because there is only ever one. */
export const THE_COMMANDER: Principal = {
  id: "syl:principal:0198f100-0000-7000-8000-000000000001",
  name: "The Commander",
};

/** Tokens are `syl_pat_` plus 32 hex characters. */
export const TOKEN_PREFIX = "syl_pat_";
const TOKEN_HEX_LENGTH = 32;
const TOKEN_SHAPE = new RegExp(`^${TOKEN_PREFIX}[0-9a-f]{${TOKEN_HEX_LENGTH}}$`);

/** Pairing codes are `NNNN-NNNN`: readable aloud, typeable on a phone. */
const PAIRING_CODE_SHAPE = /^\d{4}-\d{4}$/;

/** A pairing code is worthless after ten minutes. */
export const DEFAULT_PAIRING_CODE_TTL_MS = 10 * 60 * 1_000;

/**
 * How long a dead pairing code is kept before it is forgotten entirely.
 *
 * Long enough that "that code has already been used" and "that code has
 * expired" are still answerable while the Commander might plausibly still be
 * looking at the slip of paper, and short enough that the table cannot grow
 * into a history of every code ever issued.
 */
export const PAIRING_CODE_RETENTION_MS = 24 * 60 * 60 * 1_000;

/**
 * scrypt cost for a pairing code. About 40ms per hash.
 *
 * Two jobs, and it is worth being explicit that the second is not an accident:
 *
 * 1. A code on disk is eight digits. A SHA-256 of one is reversible in seconds
 *    by anyone who can read `syl.db`, which would turn read access into the
 *    ability to mint a token. 40ms times 10^8 is 133 single-core years.
 * 2. It is the rate limit on the one unauthenticated write. `POST /auth/pair`
 *    has no throttle in front of it and does not need one: this service cannot
 *    be made to check more than ~24 guesses a second, against a secret that is
 *    dead in ten minutes.
 *
 * The cost is paid on the request thread, synchronously, and that is the
 * intended behaviour rather than something to fix later — a caller spraying
 * guesses is a caller queueing behind their own previous guess.
 */
const SCRYPT_COST = { N: 16_384, r: 8, p: 1 } as const;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_SALT_BYTES = 16;

/**
 * How many stored codes a single redemption will compare against.
 *
 * There is normally exactly one — issuing supersedes whatever was live — so
 * this is a bound on pathology rather than a working limit. It matters because
 * every candidate costs a scrypt: without it, a table that somehow grew would
 * turn one request into a minute of CPU.
 */
const PAIRING_CANDIDATES = 8;

/** A device token lasts a year unless revoked. */
export const DEFAULT_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1_000;

/**
 * How stale `last_used_at` may get before a verification writes.
 *
 * Without this, every authenticated request is a write. Under WAL that is
 * survivable and still wrong: it turns a read-only page load into database
 * contention, and the value is only ever read by a human wondering whether a
 * device is still alive.
 */
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/**
 * What a token is allowed to ask for.
 *
 * Not a role system, and it must not grow into one — there is still exactly one
 * principal. It records **which side of the loopback boundary the credential
 * was minted on**, which is the only distinction the service can actually
 * defend:
 *
 * * `device` — minted by `POST /auth/pair`. Reachable over the network, gated
 *   on eight digits that live for ten minutes.
 * * `admin` — minted at the machine's own console and by no HTTP route at all.
 *   Getting one requires write access to `syl.db`, which is already full
 *   compromise, so this scope cannot be escalated *into* remotely.
 * * `agent` — minted by this SERVICE, FOR ITSELF, at boot: `ensureAgentKey` in
 *   `services/agent-key.ts`, called from `bootstrap`. No route returns one and
 *   no CLI mints one, so the same statement holds as for `admin` and holds
 *   more strongly — there is no code path at all that puts an agent token on a
 *   socket.
 *
 * The surface `admin` gates is `GET /logs`, and the reason is that the log is
 * not the Commander's data — it is the record of what Syl *did* on his machine
 * while running pre-authorised. A shoulder-surfed pairing code should not
 * become a transcript of the machine's activity.
 *
 * `agent` is gated the other way round: rather than opening a surface it
 * *closes* every one except the product's own nouns. See `confineAgent` in
 * `middleware/auth.ts`, which is where the content of this scope actually
 * lives — the column only makes the value expressible.
 */
export type KeyScope = "device" | "admin" | "agent";

/** Every scope, for validation and for a CLI's help text. */
export const KEY_SCOPES: readonly KeyScope[] = ["device", "admin", "agent"];

/**
 * Narrow a stored scope, defaulting to the *weakest* one.
 *
 * `0014_api_key_scope.sql` has a CHECK constraint, widened by
 * `0015_agent_scope.sql`, so an unrecognised value cannot be written by this
 * service. It could still arrive from a database edited by hand or restored
 * from a future version — and in that case the safe reading is "neither admin
 * nor agent". A widening default here would turn a typo into an open door.
 *
 * `device` is the fallback rather than `agent` even though `agent` reaches
 * fewer routes, because the two are not ordered: `agent` is *confined*, not
 * merely weak, and reading a stray value as Syl's own credential would let a
 * corrupt row speak as her.
 */
function toScope(value: unknown): KeyScope {
  if (value === "admin") return "admin";
  if (value === "agent") return "agent";
  return "device";
}

/** A paired device's key, as an admin screen sees it. Never the token. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly deviceName: string;
  readonly tokenSuffix: string;
  readonly scope: KeyScope;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
}

/** Why a presented token was not accepted. */
export type RejectionReason = "malformed" | "unknown" | "revoked" | "expired";

/** The result of presenting a token. */
export type Verification =
  | { readonly ok: true; readonly key: ApiKeyRecord; readonly principal: Principal }
  | { readonly ok: false; readonly reason: RejectionReason };

/**
 * Why a pairing attempt failed.
 *
 * `unknown` is the bucket that leaks nothing: a wrong guess and an attempt made
 * while no code is live are the same answer. `expired` and `already_used` are
 * reachable only by presenting a code that matches a stored one.
 */
export type PairingFailure = "malformed" | "unknown" | "expired" | "already_used";

/** Thrown when a pairing code cannot be exchanged. */
export class PairingError extends Error {
  readonly reason: PairingFailure;

  constructor(reason: PairingFailure, message: string) {
    super(message);
    this.name = "PairingError";
    this.reason = reason;
  }
}

/** A pairing code and when it stops working. */
export interface PairingCode {
  readonly code: string;
  readonly expiresAt: string;
}

/** What a console mint may say that pairing may not. */
export interface MintOptions {
  /**
   * Defaults to `device`. `admin` is only ever passed by a console command,
   * and `agent` only by the service minting its own credential at boot.
   */
  readonly scope?: KeyScope;
  /** Overrides the clock, for a test about expiry. */
  readonly now?: number;
}

export interface ApiKeyServiceOptions {
  readonly db: Database;
  readonly clock?: Clock;
  readonly entropy?: Entropy;
  readonly tokenTtlMs?: number;
  readonly pairingCodeTtlMs?: number;
}

/** SHA-256, hex. The only form of a token that touches disk. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Compare two same-length strings without leaking where they differ. */
function equalsInConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length. Both values here are fixed-shape, so a mismatch means the input
  // was malformed and has already been rejected — but guard anyway rather than
  // letting a future caller turn this into a throwing comparison.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Hex from entropy, without going through a string first. */
function randomHex(bytes: number, entropy: Entropy): string {
  const buffer = new Uint8Array(bytes);
  entropy(buffer);
  return Buffer.from(buffer).toString("hex");
}

/**
 * The stored form of a pairing code: scrypt over a per-row salt.
 *
 * `maxmem` is raised because Node's default (32 MiB) is below what N=16384
 * needs and the failure is a thrown `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` rather
 * than a slow hash.
 */
function hashPairingCode(code: string, saltHex: string): string {
  return scryptSync(code, Buffer.from(saltHex, "hex"), SCRYPT_KEY_BYTES, {
    ...SCRYPT_COST,
    maxmem: 256 * SCRYPT_COST.N * SCRYPT_COST.r,
  }).toString("hex");
}

/** A stored pairing code, as SQLite hands it back. */
interface PairingRow {
  readonly id: string;
  readonly code_hash: string;
  readonly salt: string;
  readonly expires_at: string;
  readonly redeemed_at: string | null;
}

/** A row as SQLite hands it back. */
interface KeyRow {
  readonly id: string;
  readonly token_suffix: string;
  readonly device_name: string;
  readonly scope: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
  readonly revoked_reason: string | null;
}

function toRecord(row: KeyRow): ApiKeyRecord {
  return {
    id: row.id,
    deviceName: row.device_name,
    tokenSuffix: row.token_suffix,
    scope: toScope(row.scope),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

const SELECT_COLUMNS =
  "id, token_suffix, device_name, scope, created_at, expires_at, last_used_at, revoked_at, revoked_reason";

export class ApiKeyService {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #entropy: Entropy;
  readonly #tokenTtlMs: number;
  readonly #pairingCodeTtlMs: number;

  constructor(options: ApiKeyServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
    this.#entropy = options.entropy ?? systemEntropy;
    this.#tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.#pairingCodeTtlMs = options.pairingCodeTtlMs ?? DEFAULT_PAIRING_CODE_TTL_MS;
  }

  /**
   * Mint a fresh pairing code and make it the only live one.
   *
   * Every call supersedes whatever was live. That is the whole invariant —
   * **at most one code works at any instant** — and it is why this does not
   * return a cached value the way it used to. The old behaviour ("the same
   * code while it is live") existed to stop an operator chasing a moving
   * target, and it only worked because the code lived in one process's memory.
   * It cannot survive the code being in the store, which is where `npm run
   * pair` has to find it: a memo in the service would keep handing out a code
   * that a second process had already replaced.
   *
   * Two windows open at once is also strictly worse than one. Running the
   * pairing command twice because the first slip of paper got lost should not
   * leave the first code working.
   */
  issuePairingCode(): PairingCode {
    const now = this.#clock();
    const digits = randomHex(4, this.#entropy);
    const value = Number.parseInt(digits, 16) % 100_000_000;
    const padded = String(value).padStart(8, "0");
    const code = `${padded.slice(0, 4)}-${padded.slice(4)}`;

    const salt = randomHex(SCRYPT_SALT_BYTES, this.#entropy);
    const expiresAt = instant(now + this.#pairingCodeTtlMs);

    // Forgetting comes first, so the table cannot grow without bound and so
    // the candidate scan below stays a scan of a handful of rows.
    this.#db
      .prepare("DELETE FROM pairing_codes WHERE expires_at < ?")
      .run(instant(now - PAIRING_CODE_RETENTION_MS));
    // Superseding, not deleting: a code the Commander is still holding should
    // say "expired" rather than "wrong", which is the difference between him
    // asking for a new one and him re-typing the same eight digits.
    this.#db
      .prepare("UPDATE pairing_codes SET expires_at = ? WHERE redeemed_at IS NULL AND expires_at > ?")
      .run(instant(now), instant(now));
    this.#db
      .prepare(
        `INSERT INTO pairing_codes (id, code_hash, salt, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(newId("pairing_code"), hashPairingCode(code, salt), salt, instant(now), expiresAt);

    return { code, expiresAt };
  }

  /**
   * Exchange a pairing code for a bearer token.
   *
   * The code is consumed on success. A code that could be replayed is a code
   * that pairs an attacker's device as well as the Commander's, and the whole
   * scheme rests on it being seen once, on a console he is sitting at.
   *
   * **Nothing here is what makes it single-use.** The redemption and the key
   * insert share one transaction, the update is conditional on
   * `redeemed_at IS NULL`, and `api_keys.pairing_code_id` is UNIQUE — so a
   * second redemption fails in the engine whether it races this method, comes
   * from another process, or arrives after somebody rewrites this function.
   *
   * @throws {PairingError}
   */
  pair(pairingCode: string, deviceName: string): TokenGrant {
    const now = this.#clock();

    // Shape first, and before any hashing: it costs nothing, and it keeps a
    // caller from spending 40ms of this service's CPU on "hello".
    if (!PAIRING_CODE_SHAPE.test(pairingCode)) {
      throw new PairingError("malformed", "A pairing code is eight digits, as NNNN-NNNN.");
    }

    const match = this.#findPairingCode(pairingCode);
    if (match === null) {
      // The indistinguishable answer. A wrong guess and "no code is live" are
      // the same sentence on purpose — telling them apart would say when a
      // pairing window is open, which is the one useful thing an attacker
      // could learn from this endpoint.
      throw new PairingError("unknown", "That pairing code is not the current one.");
    }
    if (match.redeemed_at !== null) {
      throw new PairingError(
        "already_used",
        "That pairing code has already paired a device. Issue a new one.",
      );
    }
    if (hasExpired(match.expires_at, now)) {
      throw new PairingError("expired", "That pairing code has expired. Ask for a new one.");
    }

    return this.#redeem(match.id, deviceName, now);
  }

  /**
   * Mint a token without a pairing code.
   *
   * Used by the console when the Commander bootstraps the first device. It is
   * deliberately separate from `pair` so the pairing rules live in exactly one
   * place and cannot be bypassed by accident.
   *
   * **This is the only way an `admin` or an `agent` token comes into
   * existence**, and it is reachable only by a process that can open `syl.db`.
   * There is deliberately no HTTP route that mints one, and `pair` cannot be
   * asked for a scope — see {@link KeyScope}.
   */
  mint(deviceName: string, options: MintOptions = {}): TokenGrant {
    return this.#insertKey(deviceName, options.now ?? this.#clock(), null, options.scope ?? "device");
  }

  /** Live keys holding a scope, newest first. What the console reports. */
  liveKeysWithScope(scope: KeyScope): readonly ApiKeyRecord[] {
    return this.list().filter((key) => key.revokedAt === null && key.scope === scope);
  }

  /**
   * Consume a code and mint its key, or fail — never half of either.
   *
   * The conditional `UPDATE` is the atomic step: SQLite reports how many rows
   * it changed, so "was this code still unredeemed" and "mark it redeemed" are
   * one operation rather than a read followed by a write with a gap in the
   * middle. The transaction then ties the key to it, and the UNIQUE index
   * refuses the insert if anything ever gets past the update.
   */
  #redeem(pairingCodeId: string, deviceName: string, now: number): TokenGrant {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const consumed = this.#db
        .prepare("UPDATE pairing_codes SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL")
        .run(instant(now), pairingCodeId);
      if (Number(consumed.changes) === 0) {
        throw new PairingError(
          "already_used",
          "That pairing code has already paired a device. Issue a new one.",
        );
      }

      // `device`, always, and not a parameter. Pairing is the one credential
      // path that is reachable over the network; a scope argument here would be
      // one refactor away from a route that accepts it from a caller.
      const grant = this.#insertKey(deviceName, now, pairingCodeId, "device");
      this.#db.exec("COMMIT");
      return grant;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Already unwound. The original failure is the one worth reporting.
      }
      if (error instanceof PairingError) throw error;
      // The UNIQUE index fired, which means two redemptions of one code got
      // past the conditional update — the case this constraint exists for.
      // Rendered as the same failure, because it is the same failure.
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        throw new PairingError(
          "already_used",
          "That pairing code has already paired a device. Issue a new one.",
        );
      }
      throw error;
    }
  }

  /** Write one key row and return the grant. Never called outside a mint. */
  #insertKey(
    deviceName: string,
    now: number,
    pairingCodeId: string | null,
    scope: KeyScope,
  ): TokenGrant {
    const token = `${TOKEN_PREFIX}${randomHex(TOKEN_HEX_LENGTH / 2, this.#entropy)}`;
    const expiresAtMs = now + this.#tokenTtlMs;
    const expiresAt = instant(expiresAtMs);

    this.#db
      .prepare(
        `INSERT INTO api_keys
           (id, token_hash, token_suffix, device_name, scope, created_at, expires_at, pairing_code_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("apikey"),
        hashToken(token),
        token.slice(-4),
        deviceName,
        scope,
        instant(now),
        expiresAt,
        pairingCodeId,
      );

    return {
      token,
      tokenType: "Bearer",
      expiresAt,
      principal: THE_COMMANDER,
    };
  }

  /**
   * The stored code this one is, or `null`.
   *
   * Every candidate costs a scrypt, and every candidate is checked rather than
   * stopping at the first hit: the loop is over a handful of rows, and a
   * caller must not be able to learn anything from how long a rejection took.
   * The comparison itself is constant-time over the hashes.
   */
  #findPairingCode(pairingCode: string): PairingRow | null {
    const rows = this.#db
      .prepare(
        `SELECT id, code_hash, salt, expires_at, redeemed_at FROM pairing_codes
         ORDER BY issued_at DESC LIMIT ?`,
      )
      .all(PAIRING_CANDIDATES);

    let found: PairingRow | null = null;
    for (const row of rows) {
      // Safe assertion: the columns are ours, on a STRICT table.
      const candidate = row as unknown as PairingRow;
      if (equalsInConstantTime(candidate.code_hash, hashPairingCode(pairingCode, candidate.salt))) {
        found = candidate;
      }
    }
    return found;
  }

  /**
   * Check a presented token.
   *
   * Lookup is by hash, so the plaintext is never compared against anything and
   * an attacker who reads the table gains no presentable credential. The
   * reason is returned for the service's own logs; the HTTP layer must render
   * every one of them identically.
   */
  verify(token: string): Verification {
    if (!TOKEN_SHAPE.test(token)) return { ok: false, reason: "malformed" };

    const row = this.#db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM api_keys WHERE token_hash = ?`)
      .get(hashToken(token));

    if (row === undefined) return { ok: false, reason: "unknown" };

    // Safe assertion: the columns are ours, on a STRICT table, and every one
    // is either TEXT NOT NULL or nullable TEXT.
    const record = toRecord(row as unknown as KeyRow);
    const now = this.#clock();

    if (record.revokedAt !== null) return { ok: false, reason: "revoked" };
    if (hasExpired(record.expiresAt, now)) return { ok: false, reason: "expired" };

    this.#touch(record, now);
    return { ok: true, key: record, principal: THE_COMMANDER };
  }

  /** Every key ever issued, live ones first, newest first. */
  list(): readonly ApiKeyRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM api_keys
         ORDER BY (revoked_at IS NOT NULL), created_at DESC`,
      )
      .all();
    return rows.map((row) => toRecord(row as unknown as KeyRow));
  }

  /**
   * Cut a device off.
   *
   * @returns whether a live key was revoked. Revoking an already-revoked key
   * is not an error — it is the same outcome — but the caller may want to know.
   */
  revoke(id: string, reason: string): boolean {
    const result = this.#db
      .prepare("UPDATE api_keys SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL")
      .run(instant(this.#clock()), reason, id);
    return Number(result.changes) > 0;
  }

  /** Record that a key was used, at most once a minute. */
  #touch(record: ApiKeyRecord, now: number): void {
    const last = record.lastUsedAt;
    if (last !== null) {
      const lastMs = Date.parse(last);
      if (!Number.isNaN(lastMs) && now - lastMs < LAST_USED_WRITE_INTERVAL_MS) return;
    }
    this.#db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(instant(now), record.id);
  }
}
