import { parseInstant, systemClock, type Clock } from "../services/clock.js";
import { systemEntropy, type Entropy } from "../services/id.js";
import { mintAskSecret } from "./ask-credential.js";
import { AskSylIngress } from "./ask-syl.js";
import type { FaceCostGuard, SessionMeter } from "./face-cost-guard.js";
import type {
  FaceSession,
  FaceSessionEnd,
  FaceSessionStore,
  SettleOutcome,
} from "./face-session-store.js";
import {
  RunwayClient,
  type CreateRealtimeSessionInput,
  type LiveKitConnectCreds,
  type RealtimeSessionRow,
  type RunwayClientOptions,
  type RunwayRpcToolDef,
  type RunwaySessionApi,
} from "./runway-client.js";

/**
 * The face session lifecycle — `syl-chzl.3.2`.
 *
 * One object the route layer can drive end to end, sitting on three things that
 * each do exactly one job: the thin {@link RunwayClient} (HTTP, and the secret),
 * the pure {@link FaceCostGuard} (ceiling, meter, idle predicate) and the
 * {@link FaceSessionStore} (durability).
 *
 * ```
 * startSession()      warm gate → cost gate → create → charge → poll to READY
 *                     → one-shot client credentials + a per-session credential
 * renewSession()      the same path again; a realtime session cannot be
 *                     extended, so a renew is a fresh, re-gated, re-charged create
 * recordSessionEnd()  end-of-session accounting, idempotent, upfront excluded
 * seedFromLedger()    put today's spend back after a restart
 * liveSessions()      what a dead process left running
 * ```
 *
 * ## The secret
 *
 * `RUNWAYML_API_SECRET` lives inside the client and is **never** part of
 * anything returned. {@link FaceSessionCredentials} is the only thing that goes
 * outward and it carries four fields; the test asserts on the *value* of the
 * secret rather than on field names, because a field rename is exactly how this
 * leaks.
 *
 * The per-session `ask_syl` credential is also not in it. The browser has no
 * use for it, and handing it over would make the ingress reachable from a
 * client.
 *
 * ## Conservative accounting
 *
 * Runway charges the upfront credits the moment a session is created, so they
 * are recorded **immediately after a successful create** — before the poll,
 * and therefore even for a session that never reaches READY. The provider
 * charged them; the ledger says so. A guard that under-counts is worse than no
 * guard, because it reports a safety it has not verified.
 *
 * ## Two gates, both free, both before any money moves
 *
 * The **warm-lane** gate first: a cold spawn is ~7,450ms against the provider's
 * 8-second tool ceiling, so a face opened on a cold path is a face that pays
 * ~$0.20/minute to be unable to answer. Then the **ceiling**. Neither costs
 * anything to check, and no HTTP call is made until both have passed.
 *
 * Polling, the clock and the entropy are injected, so the whole lifecycle is
 * unit-testable with no real timers and no network.
 */

/** Poll interval while waiting for READY. */
const DEFAULT_POLL_INTERVAL_MS = 400;
/** Overall budget before a create is considered to have timed out. */
const DEFAULT_CREATE_TIMEOUT_MS = 30_000;
/** How close to the cap counts as "expiring", so a caller can pre-empt it. */
const DEFAULT_RENEW_LEAD_MS = 30_000;

/**
 * Her avatar on the Runway org: her own face, bound to her own custom voice.
 *
 * A constant with an env override rather than an env var with no default, and
 * the reason is what the two failure modes look like. A missing default means
 * every face request answers 500 on a machine where nobody remembered to set
 * `SYL_FACE_AVATAR_ID` — a silent misconfiguration that presents as a broken
 * feature. A wrong constant means she opens with the wrong face, which is
 * visible in the first frame and impossible to miss.
 *
 * It is not a secret. It is an opaque handle to a row on an org that already
 * requires `RUNWAYML_API_SECRET` to touch, so nothing is protected by leaving
 * it out of the tree — and `syl-chzl.6` has not chosen a likeness yet, so this
 * is explicitly the placeholder that phase replaces.
 */
export const SYL_AVATAR_ID = "48cbc73d-f47f-41de-bed8-58a532b3b84b";

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });

/**
 * The one-shot credentials a browser or a phone receives.
 *
 * Four fields, and the type is the boundary: adding a field here is a visible
 * decision to send something else to a client.
 */
export interface FaceSessionCredentials {
  readonly sessionId: string;
  /** `stk_…`, short-lived, single-use. The only credential that goes outward. */
  readonly sessionKey: string;
  readonly avatarId: string;
  /** ISO instant of the provider's session cap, when it reported one. */
  readonly expiresAt?: string;
}

/** Everything a freshly opened session produced, sorted by who may see it. */
export interface OpenedFaceSession {
  /** For the client. See {@link FaceSessionCredentials}. */
  readonly credentials: FaceSessionCredentials;
  /**
   * For the `ask_syl` RPC handler, and **for nothing else**. Never persisted in
   * this form, never logged, never returned over HTTP.
   */
  readonly askSecret: string;
  /** The ledger row, for a caller that wants to meter or log it. */
  readonly session: FaceSession;
}

/** Today's ceiling is reached. An expected condition, not a fault. */
export class FaceCostCeilingError extends Error {
  readonly code = "FACE_DAILY_CEILING";
  readonly ceiling: number;
  readonly spentToday: number;

  constructor(ceiling: number, spentToday: number) {
    super(
      `Today's face budget is spent: ${String(spentToday)} of ${String(ceiling)} credits, about ` +
        `$${(ceiling / 100).toFixed(2)}. It resets at midnight UTC.`,
    );
    this.name = "FaceCostCeilingError";
    this.ceiling = ceiling;
    this.spentToday = spentToday;
  }
}

/** Her lane is cold, so a face opened now could not answer inside the ceiling. */
export class FaceColdLaneError extends Error {
  readonly code = "FACE_COLD_LANE";

  constructor() {
    super(
      "Her lane is cold. A cold turn takes about 7.5 seconds and the avatar's tool call gives " +
        "up at 8, so a face opened now would pay about $0.20 a minute to be unable to answer.",
    );
    this.name = "FaceColdLaneError";
  }
}

/** A session was created and charged for, and never became usable. */
export class FaceSessionFailedError extends Error {
  readonly code = "FACE_SESSION_FAILED";
  readonly sessionId: string;

  constructor(sessionId: string, why: string) {
    super(`Face session ${sessionId} ${why}. The upfront credits were charged and are recorded.`);
    this.name = "FaceSessionFailedError";
    this.sessionId = sessionId;
  }
}

export interface FaceSessionBrokerOptions {
  /** Injected Runway client. Defaults to a real one, built lazily. */
  readonly client?: RunwaySessionApi;
  /** Used to build the default client. See {@link RunwayClient}. */
  readonly clientOptions?: RunwayClientOptions;
  readonly guard: FaceCostGuard;
  readonly sessions: FaceSessionStore;
  /** Her avatar. Defaults to `SYL_FACE_AVATAR_ID`, then {@link SYL_AVATAR_ID}. */
  readonly avatarId?: string;
  /** Tools declared at create. Defaults to `ask_syl` alone. */
  readonly tools?: readonly RunwayRpcToolDef[];
  /** `syl-chzl.2.2`'s predicate. Omitted means "do not check". */
  readonly isLaneWarm?: () => boolean;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly renewLeadMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: Clock;
  readonly entropy?: Entropy;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

export class FaceSessionBroker {
  #client: RunwaySessionApi | undefined;
  readonly #clientOptions: RunwayClientOptions;
  readonly #guard: FaceCostGuard;
  readonly #sessions: FaceSessionStore;
  readonly #avatarId: string;
  readonly #tools: readonly RunwayRpcToolDef[];
  readonly #isLaneWarm: (() => boolean) | null;
  readonly #pollIntervalMs: number;
  readonly #timeoutMs: number;
  readonly #renewLeadMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: Clock;
  readonly #entropy: Entropy;
  readonly #log: (event: string, fields: Record<string, unknown>) => void;

  constructor(options: FaceSessionBrokerOptions) {
    this.#client = options.client;
    this.#clientOptions = options.clientOptions ?? {};
    this.#guard = options.guard;
    this.#sessions = options.sessions;
    this.#avatarId = options.avatarId ?? process.env["SYL_FACE_AVATAR_ID"] ?? SYL_AVATAR_ID;
    this.#tools = options.tools ?? [AskSylIngress.toolDefinition()];
    this.#isLaneWarm = options.isLaneWarm ?? null;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS;
    this.#renewLeadMs = options.renewLeadMs ?? DEFAULT_RENEW_LEAD_MS;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? systemClock;
    this.#entropy = options.entropy ?? systemEntropy;
    this.#log =
      options.log ??
      ((event, fields) => {
        console.info(`[syl] ${event}`, fields);
      });
  }

  /**
   * The client, built lazily.
   *
   * A broker used purely for TTL, idle and meter arithmetic must never require
   * the secret — the admin's meter view and the reaper's decisions are both
   * that. Constructing the default client validates `RUNWAYML_API_SECRET`, so
   * building it eagerly would make a missing secret break code that does not
   * need one.
   */
  get #runway(): RunwaySessionApi {
    this.#client ??= new RunwayClient(this.#clientOptions);
    return this.#client;
  }

  /** Credits the provider charges the moment a session is created. */
  #upfrontCredits(): number {
    return this.#guard.meter(0).credits;
  }

  /**
   * Open a face: gate, create, charge, poll, hand back credentials.
   *
   * @throws {FaceColdLaneError} her lane cannot answer inside the tool ceiling.
   * @throws {FaceCostCeilingError} today's budget is spent. Nothing is created.
   * @throws {FaceSessionFailedError} it was created and charged, and never
   *   became usable. The row is settled `failed` and the spend is recorded.
   */
  async startSession(): Promise<OpenedFaceSession> {
    // 1. The free gates, cheapest first. Neither makes an HTTP call.
    if (this.#isLaneWarm !== null && !this.#isLaneWarm()) throw new FaceColdLaneError();
    if (!this.#guard.canStartSession()) {
      throw new FaceCostCeilingError(this.#guard.dailyCreditCeiling, this.#guard.spentToday());
    }
    if (this.#avatarId === "") {
      throw new Error(
        "No avatar is configured, so there is no face to open. Set SYL_FACE_AVATAR_ID.",
      );
    }

    // 2. Mint the credential BEFORE the create, so the row can be written with
    //    it in one insert. A session that exists with no credential is a
    //    session whose ingress cannot authenticate anybody.
    const minted = mintAskSecret(this.#entropy);

    const input: CreateRealtimeSessionInput = {
      avatar: { type: "custom", avatarId: this.#avatarId },
      ...(this.#tools.length > 0 ? { tools: this.#tools } : {}),
    };

    // 3. Create. Runway charges here, so everything after this point records
    //    the spend whatever else happens.
    const created = await this.#runway.createRealtimeSession(input);
    const sessionId = created.id;
    const upfront = this.#upfrontCredits();

    this.#guard.recordSpend(upfront);
    this.#sessions.open({
      id: sessionId,
      avatarId: this.#avatarId,
      credits: upfront,
      dollars: upfront * this.#guard.costModel.dollarsPerCredit,
      askSecretHash: minted.hash,
      // The provider's cap when it reported one; otherwise the create timeout,
      // which is a hard floor rather than a guess — a credential must never
      // outlive the process's own patience for the session it belongs to.
      askExpiresAt: this.#expiryOf(created) ?? this.#now() + this.#timeoutMs,
    });
    this.#log("face.session.opened", { sessionId, avatarId: this.#avatarId, credits: upfront });

    // 4. Poll to READY.
    const ready = await this.#pollToReady(sessionId);

    // The provider only reports its cap once the session is up, so the
    // credential's floor written above is replaced by the real thing now.
    const cap = ready.expiresAt === undefined ? Number.NaN : Date.parse(ready.expiresAt);
    if (!Number.isNaN(cap)) this.#sessions.adoptProviderExpiry(sessionId, cap);

    const session = this.#sessions.get(sessionId);
    if (session === null) throw new Error(`face session ${sessionId} vanished after open`);

    return {
      credentials: {
        sessionId,
        sessionKey: ready.sessionKey,
        avatarId: this.#avatarId,
        ...(ready.expiresAt === undefined ? {} : { expiresAt: ready.expiresAt }),
      },
      askSecret: minted.secret,
      session,
    };
  }

  /**
   * Replace a session nearing its cap.
   *
   * A realtime session cannot be extended in place, so this is a fresh create:
   * re-gated, re-charged, and carrying a **new** credential. Carrying the old
   * one over would leave a credential alive across a session boundary, which is
   * the one property `ask-credential.ts` is built to prevent.
   */
  async renewSession(): Promise<OpenedFaceSession> {
    return this.startSession();
  }

  /** LiveKit join credentials for an existing session. Creates nothing, charges nothing. */
  async connectBackend(sessionId: string): Promise<LiveKitConnectCreds> {
    return this.#runway.connectBackend(sessionId);
  }

  /** Everything the ledger still shows open, oldest first. */
  liveSessions(): readonly FaceSession[] {
    return this.#sessions.live();
  }

  /** Put today's durable total back into the guard. Called once, at boot. */
  seedFromLedger(): void {
    const spent = this.#sessions.creditsOnDayOf(this.#now());
    this.#guard.adoptDailyTotal(spent);
    this.#log("face.ledger.seeded", { creditsSpentToday: spent });
  }

  /** What a session that opened at `openedAt` has cost by now. */
  meterSession(session: Pick<FaceSession, "openedAt">): SessionMeter {
    return this.#guard.meter(this.#elapsedMs(session));
  }

  /** Should this session be cut for idleness? */
  shouldDisconnectIdle(session: Pick<FaceSession, "lastActivityAt">): boolean {
    const last = parseInstant(session.lastActivityAt);
    // An unparseable stamp is not evidence of activity. Treat it as idle rather
    // than as a reason to keep billing — a row we cannot read is exactly the
    // silent leak the reaper exists for.
    if (last === null) return true;
    return this.#guard.shouldDisconnectIdle(last);
  }

  /**
   * Settle a session and charge what it cost.
   *
   * The **streaming** portion goes to the guard — the upfront was charged at
   * `startSession` and adding it again would double it — while the ledger gets
   * the whole-session total, because one row holding one number is the version
   * with no arithmetic to get wrong twice.
   *
   * Idempotent, because the paths that settle a session genuinely race: he
   * closes the face at the moment the reaper decides it is idle, and both are
   * correct. Only the call that actually settled the row moves the guard.
   */
  recordSessionEnd(sessionId: string, ended: FaceSessionEnd): SettleOutcome {
    const session = this.#sessions.get(sessionId);
    if (session === null) {
      throw new FaceSessionFailedError(sessionId, "is not in the ledger and cannot be settled");
    }
    if (session.closedAt !== null) return { session, settled: false };

    const meter = this.#guard.meter(this.#elapsedMs(session));
    const outcome = this.#sessions.settleOnce({
      id: sessionId,
      ended,
      credits: meter.credits,
      dollars: meter.dollars,
    });

    if (outcome.settled) {
      const streaming = meter.credits - this.#upfrontCredits();
      if (streaming > 0) this.#guard.recordSpend(streaming);
      this.#log("face.session.ended", {
        sessionId,
        ended,
        credits: meter.credits,
        dollars: Number(meter.dollars.toFixed(4)),
        elapsedSeconds: Math.round(meter.elapsedSeconds),
      });
    }
    return outcome;
  }

  /** Milliseconds until the provider's cap, or `undefined` when it reported none. */
  msUntilExpiry(
    credentials: Pick<FaceSessionCredentials, "expiresAt">,
    nowMs: number = this.#now(),
  ): number | undefined {
    if (credentials.expiresAt === undefined) return undefined;
    const expiry = Date.parse(credentials.expiresAt);
    return Number.isNaN(expiry) ? undefined : expiry - nowMs;
  }

  /**
   * Is this session within the renew lead of its cap?
   *
   * An unknown expiry reads as not expiring: a caller cannot act on a value it
   * does not have, and guessing one would renew — and charge — on a schedule
   * nobody chose.
   */
  isExpiring(
    credentials: Pick<FaceSessionCredentials, "expiresAt">,
    nowMs: number = this.#now(),
  ): boolean {
    const remaining = this.msUntilExpiry(credentials, nowMs);
    return remaining === undefined ? false : remaining <= this.#renewLeadMs;
  }

  // ------------------------------------------------------------- internals ---

  #elapsedMs(session: Pick<FaceSession, "openedAt">): number {
    const openedAt = parseInstant(session.openedAt);
    return openedAt === null ? 0 : this.#now() - openedAt;
  }

  #expiryOf(row: RealtimeSessionRow): number | undefined {
    if (row.expiresAt === undefined) return undefined;
    const parsed = Date.parse(row.expiresAt);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  /**
   * Poll until the session is usable, or settle it `failed` and throw.
   *
   * A transient poll failure is retried rather than treated as a dead session —
   * one `ECONNRESET` against a session that is READY and already paid for is
   * not a reason to throw the session away.
   */
  async #pollToReady(sessionId: string): Promise<{ sessionKey: string; expiresAt?: string }> {
    const attempts = Math.max(1, Math.ceil(this.#timeoutMs / Math.max(1, this.#pollIntervalMs)));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let row: RealtimeSessionRow | undefined;
      try {
        row = await this.#runway.getRealtimeSession(sessionId);
      } catch {
        row = undefined;
      }

      if (row !== undefined) {
        if ((row.status === "READY" || row.status === "RUNNING") && row.sessionKey !== undefined) {
          return {
            sessionKey: row.sessionKey,
            ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
          };
        }
        if (row.status === "FAILED" || row.status === "COMPLETED") {
          this.#fail(sessionId);
          throw new FaceSessionFailedError(sessionId, `ended early with status ${row.status}`);
        }
      }
      await this.#sleep(this.#pollIntervalMs);
    }

    this.#fail(sessionId);
    throw new FaceSessionFailedError(sessionId, "never became ready inside the timeout");
  }

  /**
   * Settle a session that was charged for and never worked.
   *
   * The upfront is already in the guard and in the row, so nothing more is
   * charged — this closes the row so it stops appearing as a live leak and so
   * the credential minted for it dies with it.
   */
  #fail(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session === null || session.closedAt !== null) return;
    this.#sessions.settleOnce({
      id: sessionId,
      ended: "failed",
      credits: session.credits,
      dollars: session.dollars,
    });
    this.#log("face.session.failed", { sessionId, credits: session.credits });
  }
}
