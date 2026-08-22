import { instant, systemClock, type Clock } from "../services/clock.js";
import type { Database } from "../services/sqlite.js";

/**
 * Face sessions on disk — `syl-chzl.3.3`.
 *
 * `face-cost-guard.ts` is pure and holds today's tally in memory. This is where
 * the durability lives, and the split is deliberate: the cost model can be
 * exercised exhaustively in milliseconds precisely because nothing in it opens
 * a database.
 *
 * Two questions this answers and the guard cannot:
 *
 * - **"Has today's ceiling been reached?"** across a restart. A crash at noon
 *   must not hand the afternoon a fresh budget. `creditsOnDayOf` is what seeds
 *   `FaceCostGuard.adoptDailyTotal` at boot.
 * - **"What is still open?"** after a process died with a face running. A
 *   session nothing knows about is the silent leak the reaper exists to
 *   prevent, and {@link FaceSessionStore.live} is how it is found again.
 *
 * See `0036_face_sessions.sql` for why the id is Runway's, why `ended` has four
 * values, and why the per-session `ask_syl` credential is a column here rather
 * than a row in `api_keys`.
 */

/** How a face session ended. `null` on a row means it has not. */
export type FaceSessionEnd = "closed" | "reaped" | "expired" | "failed";

/** Every end state, so a caller can iterate them without restating the union. */
export const FACE_SESSION_ENDS: readonly FaceSessionEnd[] = [
  "closed",
  "reaped",
  "expired",
  "failed",
];

/** One face session, as the ledger holds it. */
export interface FaceSession {
  readonly id: string;
  readonly avatarId: string;
  readonly openedAt: string;
  /** `null` while the session is live. */
  readonly closedAt: string | null;
  /** Everything charged for this session so far, upfront included. */
  readonly credits: number;
  readonly dollars: number;
  /** `null` while the session is live. */
  readonly ended: FaceSessionEnd | null;
  /** What the reaper reads. Moved forward by every `ask_syl` call. */
  readonly lastActivityAt: string;
  /** SHA-256 of the per-session `ask_syl` secret, hex. Never the secret. */
  readonly askSecretHash: string;
  /** The credential's hard stop, independent of the row being settled. */
  readonly askExpiresAt: string;
}

/**
 * A face session with the credential material removed.
 *
 * The type is the guard rather than a handler remembering to pick fields: a
 * route returning a `FaceSession` is a type error waiting to be caught, and a
 * column added to the row tomorrow does not silently join the response.
 */
export type PublicFaceSession = Omit<FaceSession, "askSecretHash" | "askExpiresAt">;

/** Opening a session in the ledger. Called after the provider create succeeded. */
export interface OpenFaceSession {
  /** Runway's realtime-session id. */
  readonly id: string;
  readonly avatarId: string;
  /** The upfront credits the provider has already charged. */
  readonly credits: number;
  readonly dollars: number;
  /** SHA-256 of the per-session `ask_syl` secret, hex. */
  readonly askSecretHash: string;
  /** Epoch milliseconds at which the credential stops being accepted. */
  readonly askExpiresAt: number;
}

/** Settling a session: how it ended, and what the whole thing cost. */
export interface SettleFaceSession {
  readonly id: string;
  readonly ended: FaceSessionEnd;
  /** The WHOLE session's credits, upfront included — not the streaming delta. */
  readonly credits: number;
  readonly dollars: number;
}

/** A settle, and whether this call was the one that did it. */
export interface SettleOutcome {
  readonly session: FaceSession;
  /** `false` when the row was already settled and nothing changed. */
  readonly settled: boolean;
}

/** Thrown when the ledger cannot record what it was asked to. */
export class FaceSessionError extends Error {
  readonly kind:
    | "blank_id"
    | "blank_avatar"
    | "blank_secret_hash"
    | "negative_spend"
    | "duplicate_session"
    | "unknown_session";

  constructor(kind: FaceSessionError["kind"], message: string) {
    super(message);
    this.name = "FaceSessionError";
    this.kind = kind;
  }
}

interface FaceSessionRow {
  readonly id: string;
  readonly avatar_id: string;
  readonly opened_at: string;
  readonly closed_at: string | null;
  readonly credits: number;
  readonly dollars: number;
  readonly ended: string | null;
  readonly last_activity_at: string;
  readonly ask_secret_hash: string;
  readonly ask_expires_at: string;
}

const COLUMNS =
  "id, avatar_id, opened_at, closed_at, credits, dollars, ended, last_activity_at, " +
  "ask_secret_hash, ask_expires_at";

function toSession(row: FaceSessionRow): FaceSession {
  return {
    id: row.id,
    avatarId: row.avatar_id,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    credits: row.credits,
    dollars: row.dollars,
    // Safe assertion: the column carries a CHECK constraint listing exactly
    // these four values, so anything else cannot have been written.
    ended: row.ended as FaceSessionEnd | null,
    lastActivityAt: row.last_activity_at,
    askSecretHash: row.ask_secret_hash,
    askExpiresAt: row.ask_expires_at,
  };
}

/** The UTC day `epochMs` falls in, as the `YYYY-MM-DD` an instant starts with. */
function utcDayOf(epochMs: number): string {
  return instant(epochMs).slice(0, 10);
}

export interface FaceSessionStoreOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

export class FaceSessionStore {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: FaceSessionStoreOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Record a session the provider has already created and charged for.
   *
   * Called immediately after a successful create and **before** the poll to
   * READY, because Runway charges at create. A ledger that waited for READY
   * would silently omit every session that never got there, and those are
   * exactly the ones nobody would otherwise notice paying for.
   */
  open(input: OpenFaceSession): FaceSession {
    const id = input.id.trim();
    if (id === "") {
      throw new FaceSessionError(
        "blank_id",
        "A face session is recorded by the provider's own session id, and this one is blank. " +
          "A row nothing can address is a charge nothing can settle.",
      );
    }

    const avatarId = input.avatarId.trim();
    if (avatarId === "") {
      throw new FaceSessionError("blank_avatar", "A face session records which avatar spoke.");
    }

    const askSecretHash = input.askSecretHash.trim();
    if (askSecretHash === "") {
      throw new FaceSessionError(
        "blank_secret_hash",
        "A face session without an ask_syl credential hash is a session whose ingress cannot " +
          "authenticate anyone. Refusing to open one.",
      );
    }

    if (!Number.isFinite(input.credits) || input.credits < 0) {
      throw new FaceSessionError(
        "negative_spend",
        `Credits must be finite and non-negative, got ${String(input.credits)}.`,
      );
    }

    const at = instant(this.#clock());

    try {
      this.#db
        .prepare(
          `INSERT INTO face_sessions (${COLUMNS}) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          avatarId,
          at,
          Math.round(input.credits),
          input.dollars,
          at,
          askSecretHash,
          instant(input.askExpiresAt),
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE|PRIMARY KEY/i.test(message)) {
        throw new FaceSessionError(
          "duplicate_session",
          `A face session ${id} is already in the ledger. One provider session is one row.`,
        );
      }
      throw error;
    }

    const created = this.get(id);
    if (created === null) throw new Error("a face session vanished during open");
    return created;
  }

  /** One session by id, or `null`. */
  get(id: string): FaceSession | null {
    const row = this.#db
      .prepare(`SELECT ${COLUMNS} FROM face_sessions WHERE id = ?`)
      .get(id) as FaceSessionRow | undefined;
    return row === undefined ? null : toSession(row);
  }

  /**
   * Everything still open, oldest first.
   *
   * Oldest first because the session that has been running longest is the one
   * bleeding the most, and a reaper that takes them in any other order can
   * starve the worst case behind a stream of newer ones.
   *
   * Unpaged, deliberately: more than a handful of concurrent faces is itself
   * the emergency, and a page boundary would hide it.
   */
  live(): readonly FaceSession[] {
    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM face_sessions WHERE closed_at IS NULL ORDER BY opened_at, id`,
      )
      .all();
    return rows.map((row) => toSession(row as unknown as FaceSessionRow));
  }

  /**
   * Credits charged for every session OPENED on the UTC day containing
   * `epochMs`.
   *
   * This is what seeds the guard at boot. See the migration header for why
   * attribution is by open day and what that costs at midnight.
   */
  creditsOnDayOf(epochMs: number): number {
    const day = utcDayOf(epochMs);
    const row = this.#db
      .prepare(
        "SELECT COALESCE(SUM(credits), 0) AS total FROM face_sessions " +
          "WHERE opened_at >= ? AND opened_at < ?",
      )
      .get(`${day}T00:00:00.000Z`, `${day}T99`) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  /**
   * Note that something happened on a live session.
   *
   * Silent about an unknown or already-settled session on purpose. This is
   * called from the `ask_syl` ingress on every question, and a throw there
   * would turn a race against the reaper — she answers as the session is being
   * cut — into a failed answer. The reaper's own decision is made from the
   * value it reads, so a touch that lands nowhere costs nothing.
   */
  touch(id: string, at: number = this.#clock()): void {
    this.#db
      .prepare("UPDATE face_sessions SET last_activity_at = ? WHERE id = ? AND closed_at IS NULL")
      .run(instant(at), id);
  }

  /**
   * Adopt the provider's own reported session cap as the credential's expiry.
   *
   * A session row is written the instant the create succeeds, which is before
   * the provider has told us when the session ends — `expiresAt` only appears
   * on the READY poll. So `open` writes a short, conservative floor and this
   * replaces it with the real cap once it is known.
   *
   * **Only while the session is open**, so a settled session can never have its
   * credential brought back to life, and only from the value the provider
   * reported. It is not a general "extend this credential" verb and must not
   * grow into one: the credential's lifetime is a property of the session, and
   * the moment anything else can set it, it stops being one.
   */
  adoptProviderExpiry(id: string, expiresAt: number): void {
    this.#db
      .prepare("UPDATE face_sessions SET ask_expires_at = ? WHERE id = ? AND closed_at IS NULL")
      .run(instant(expiresAt), id);
  }

  /**
   * End a session and record what it cost.
   *
   * **Idempotent.** A second settle returns the row unchanged rather than
   * overwriting it, because the paths that settle a session genuinely race: the
   * Commander closes the face at the moment the reaper decides it is idle, and
   * both are correct. The first one to arrive is the truth; the second must not
   * be able to rewrite how it ended or double the spend. `settleOnce` is the
   * same operation for a caller that needs to know which it was — the reaper
   * does, because it only logs a reap it actually performed.
   */
  settle(input: SettleFaceSession): FaceSession {
    return this.settleOnce(input).session;
  }

  /** {@link settle}, saying whether this call was the one that settled the row. */
  settleOnce(input: SettleFaceSession): SettleOutcome {
    const existing = this.get(input.id);
    if (existing === null) {
      throw new FaceSessionError(
        "unknown_session",
        `There is no face session ${input.id} to settle. A charge with no row is a charge ` +
          "nothing can account for.",
      );
    }
    if (existing.closedAt !== null) return { session: existing, settled: false };

    if (!Number.isFinite(input.credits) || input.credits < 0) {
      throw new FaceSessionError(
        "negative_spend",
        `Credits must be finite and non-negative, got ${String(input.credits)}.`,
      );
    }

    const at = instant(this.#clock());
    this.#db
      .prepare(
        "UPDATE face_sessions SET closed_at = ?, ended = ?, credits = ?, dollars = ? " +
          "WHERE id = ? AND closed_at IS NULL",
      )
      .run(at, input.ended, Math.round(input.credits), input.dollars, input.id);

    const settled = this.get(input.id);
    if (settled === null) throw new Error("a face session vanished during settle");
    return { session: settled, settled: true };
  }

  /**
   * The session without its credential material.
   *
   * A method rather than a free function so that "what may leave the server"
   * has one definition sitting beside the row it strips.
   */
  publicView(session: FaceSession): PublicFaceSession {
    const { askSecretHash: _hash, askExpiresAt: _expiry, ...rest } = session;
    return rest;
  }
}
