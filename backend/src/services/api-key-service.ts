import { createHash, timingSafeEqual } from "node:crypto";

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
 *   that it must not be replayable.
 * * **Every rejection has a distinguishable reason internally and one
 *   indistinguishable message externally.** The service needs to know whether
 *   a token was revoked or merely unknown; a caller must not be able to learn
 *   which, because that turns the API into an oracle for guessing tokens.
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

/** A paired device's key, as an admin screen sees it. Never the token. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly deviceName: string;
  readonly tokenSuffix: string;
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

/** Why a pairing attempt failed. */
export type PairingFailure = "malformed" | "unknown" | "expired";

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

/** A row as SQLite hands it back. */
interface KeyRow {
  readonly id: string;
  readonly token_suffix: string;
  readonly device_name: string;
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
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

const SELECT_COLUMNS =
  "id, token_suffix, device_name, created_at, expires_at, last_used_at, revoked_at, revoked_reason";

export class ApiKeyService {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #entropy: Entropy;
  readonly #tokenTtlMs: number;
  readonly #pairingCodeTtlMs: number;

  /**
   * The live pairing code, held in memory and never written to disk.
   *
   * A pairing code is a credential. Persisting it would mean a code survives
   * the restart that was supposed to invalidate it, and would put a
   * short-lived secret in the same backup as everything else. Losing it on
   * restart is the correct behaviour, not a limitation.
   */
  #pairing: { code: string; expiresAtMs: number } | null = null;

  constructor(options: ApiKeyServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
    this.#entropy = options.entropy ?? systemEntropy;
    this.#tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.#pairingCodeTtlMs = options.pairingCodeTtlMs ?? DEFAULT_PAIRING_CODE_TTL_MS;
  }

  /**
   * The current pairing code, minting a fresh one if there is none or the last
   * one has expired.
   *
   * This is what gets printed on the server console. Calling it repeatedly
   * inside the window returns the same code, so a restart-free operator does
   * not chase a moving target.
   */
  issuePairingCode(): PairingCode {
    const now = this.#clock();
    const live = this.#pairing;

    if (live === null || live.expiresAtMs <= now) {
      const digits = randomHex(4, this.#entropy);
      const value = Number.parseInt(digits, 16) % 100_000_000;
      const padded = String(value).padStart(8, "0");
      this.#pairing = {
        code: `${padded.slice(0, 4)}-${padded.slice(4)}`,
        expiresAtMs: now + this.#pairingCodeTtlMs,
      };
    }

    // Non-null: either it was live, or the branch above just set it.
    const current = this.#pairing as { code: string; expiresAtMs: number };
    return { code: current.code, expiresAt: instant(current.expiresAtMs) };
  }

  /**
   * Exchange a pairing code for a bearer token.
   *
   * The code is consumed on success. A code that could be replayed is a code
   * that pairs an attacker's device as well as the Commander's, and the whole
   * scheme rests on it being seen once, on a console he is sitting at.
   *
   * @throws {PairingError}
   */
  pair(pairingCode: string, deviceName: string): TokenGrant {
    const now = this.#clock();

    if (!PAIRING_CODE_SHAPE.test(pairingCode)) {
      throw new PairingError("malformed", "A pairing code is eight digits, as NNNN-NNNN.");
    }

    const live = this.#pairing;
    if (live === null) {
      throw new PairingError("unknown", "No pairing code is active. Ask the server for one.");
    }
    if (live.expiresAtMs <= now) {
      this.#pairing = null;
      throw new PairingError("expired", "That pairing code has expired. Ask for a new one.");
    }
    if (!equalsInConstantTime(live.code, pairingCode)) {
      throw new PairingError("unknown", "That pairing code is not the current one.");
    }

    this.#pairing = null;
    return this.mint(deviceName, now);
  }

  /**
   * Mint a token without a pairing code.
   *
   * Used by pairing, and by the console when the Commander bootstraps the
   * first device. It is deliberately separate from `pair` so the pairing rules
   * live in exactly one place and cannot be bypassed by accident.
   */
  mint(deviceName: string, now: number = this.#clock()): TokenGrant {
    const token = `${TOKEN_PREFIX}${randomHex(TOKEN_HEX_LENGTH / 2, this.#entropy)}`;
    const expiresAtMs = now + this.#tokenTtlMs;
    const expiresAt = instant(expiresAtMs);

    this.#db
      .prepare(
        `INSERT INTO api_keys (id, token_hash, token_suffix, device_name, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("apikey"),
        hashToken(token),
        token.slice(-4),
        deviceName,
        instant(now),
        expiresAt,
      );

    return {
      token,
      tokenType: "Bearer",
      expiresAt,
      principal: THE_COMMANDER,
    };
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
