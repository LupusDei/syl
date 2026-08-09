import { createHash } from "node:crypto";

import { instant, systemClock, type Clock } from "./clock.js";
import type { Database } from "./sqlite.js";

/**
 * The idempotency ledger.
 *
 * Every write in the contract takes an `Idempotency-Key`, and that is not
 * politeness: the mobile client keeps a local outbox and retries by design, so
 * without a key a flaky tunnel turns one reminder into three. The rule is
 * simple and the failure of getting it slightly wrong is not.
 *
 * - Same key, same request → the stored response is replayed and the operation
 *   runs once.
 * - Same key, different request → `409`. A client reusing a key across two
 *   different operations has a bug, and answering the second one "successfully"
 *   with the first one's response is the worst possible way to tell it.
 *
 * **Only successful responses are recorded.** A validation failure that gets
 * remembered would make the client's corrected retry fail forever with the
 * original error, which is the opposite of what a retry is for.
 */

/** How long a key is honoured. The contract's number. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60_000;

/** Thrown when one key has been used for two different requests. */
export class IdempotencyConflict extends Error {
  constructor() {
    super("That Idempotency-Key has already been used for a different request.");
    this.name = "IdempotencyConflict";
  }
}

/** A response worth replaying. */
export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Serialise a value with its object keys in a stable order.
 *
 * The contract says "byte-identical body", but a client that rebuilds its JSON
 * between retries may emit the same fields in a different order. Failing that
 * retry with a 409 would be technically defensible and practically hostile, so
 * the fingerprint is taken over the *meaning* rather than the bytes.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, held]) => held !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, held]) => `${JSON.stringify(key)}:${stableStringify(held)}`);

  return `{${entries.join(",")}}`;
}

/** Identify a request by what it asks for, not by when it was sent. */
export function fingerprintOf(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()} ${path}\n${stableStringify(body)}`, "utf8")
    .digest("hex");
}

export interface IdempotencyStoreOptions {
  readonly db: Database;
  readonly clock?: Clock;
  readonly retentionMs?: number;
}

export class IdempotencyStore {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #retentionMs: number;

  constructor(options: IdempotencyStoreOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
    this.#retentionMs = options.retentionMs ?? IDEMPOTENCY_RETENTION_MS;
  }

  /**
   * Look a key up.
   *
   * @returns the stored response to replay, or `null` if this key is new.
   * @throws {IdempotencyConflict} if the key was used for a different request.
   */
  lookup(key: string, fingerprint: string): StoredResponse | null {
    const row = this.#db
      .prepare(
        "SELECT fingerprint, status, response_json, created_at FROM idempotency_keys WHERE key = ?",
      )
      .get(key);
    if (row === undefined) return null;

    // Safe assertion: our own columns on a STRICT table.
    const typed = row as unknown as {
      fingerprint: string;
      status: number;
      response_json: string;
      created_at: string;
    };

    // An expired key is not a conflict — it is a key we no longer hold, and
    // treating it as one would refuse a legitimate request a day later.
    if (Date.parse(typed.created_at) + this.#retentionMs <= this.#clock()) {
      this.#db.prepare("DELETE FROM idempotency_keys WHERE key = ?").run(key);
      return null;
    }

    if (typed.fingerprint !== fingerprint) throw new IdempotencyConflict();

    return { status: typed.status, body: JSON.parse(typed.response_json) };
  }

  /** Remember a successful response so the client's retry replays it. */
  save(key: string, fingerprint: string, status: number, body: unknown): void {
    this.#db
      .prepare(
        `INSERT INTO idempotency_keys (key, fingerprint, status, response_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           status = excluded.status,
           response_json = excluded.response_json,
           created_at = excluded.created_at`,
      )
      .run(key, fingerprint, status, JSON.stringify(body ?? null), instant(this.#clock()));
  }

  /** Drop keys past their retention. @returns how many went. */
  prune(): number {
    const cutoff = instant(this.#clock() - this.#retentionMs);
    const result = this.#db
      .prepare("DELETE FROM idempotency_keys WHERE created_at <= ?")
      .run(cutoff);
    return Number(result.changes);
  }
}
