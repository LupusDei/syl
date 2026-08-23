import { parseInstant, systemClock, type Clock } from "../services/clock.js";
import { systemEntropy, type Entropy } from "../services/id.js";
import { mintAskSecret } from "./ask-credential.js";
import { AskSylIngress } from "./ask-syl.js";
import { hashSessionKey } from "./client-report.js";
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
 * startSession()      START WARMING HER → cost gate → create → charge
 *                     → poll to READY → warm gate, now that the turn has had
 *                       the whole open to run in
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
 * ## Two gates, both free, and the warm one moved
 *
 * The **warm-lane** gate exists because a cold spawn is ~7,450ms against the
 * provider's 8-second tool ceiling, so a face opened on a cold path is a face
 * that pays ~$0.20/minute to be unable to answer. The **ceiling** gate is
 * unchanged and still runs before any HTTP call.
 *
 * The warm gate now runs **after READY** rather than before the create, and
 * the reason is a measurement rather than a preference: making it work meant
 * awaiting a keep-warm turn, and two real opens put that turn at 20.6s and
 * 22.4s. Twenty seconds of black screen, before Runway had even been asked for
 * a session. So the turn is started first and *judged* last, which spends the
 * same twenty seconds alongside the create and the poll instead of in front of
 * them. A lane that could not be warmed is still refused; see `startSession`
 * step 4a for the three outcomes and `#beginWarmUp` for the numbers.
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
 * How long the `ask_syl` credential lives when the provider reports no cap.
 *
 * A floor, not a guess at the provider's behaviour. It used to be the CREATE
 * TIMEOUT — 30 seconds — which is a number about how long we are willing to
 * wait for a session to become ready and has nothing to do with how long one
 * lasts. A session whose cap Runway did not report therefore lost its
 * credential half a minute in, and the avatar went mute on a face that was
 * still billing.
 *
 * Five minutes matches the observed cap. When the provider DOES report one,
 * `adoptProviderExpiry` replaces this with the real value, so this is only ever
 * reached on the path where we know nothing.
 */
const DEFAULT_CREDENTIAL_TTL_MS = 5 * 60 * 1_000;

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

/**
 * A keep-warm turn that is running right now, as the open needs to see it.
 *
 * Three fields and no more: whether one was taken at all (which is what the
 * pre-create gate reads), whether it has finished (which is what the
 * post-READY gate reads), and the promise itself for a caller that genuinely
 * wants to wait — the open deliberately does not.
 */
interface WarmUpInFlight {
  readonly started: boolean;
  readonly finished: () => boolean;
  readonly settled: Promise<void>;
}

/** No turn was taken: no warmer, already warm, or no budget to open at all. */
const NO_WARM_UP: WarmUpInFlight = {
  started: false,
  finished: () => true,
  settled: Promise.resolve(),
};

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
  /**
   * `syl-chzl.2.3` — make the lane warm, before {@link isLaneWarm} judges it.
   *
   * A **preparation, not a gate.** It is awaited before the cold refusal below,
   * so the ordinary case — he has not spoken to her for fifteen minutes, the
   * idle reaper took the process, and he long-presses her face — costs one
   * cheap turn rather than a refusal. It is only called when the lane is
   * actually cold and there is budget to open a session at all: warming a lane
   * for a face today's ceiling will refuse is a turn spent on nothing.
   *
   * It must resolve rather than reject whatever happens; `harness/keep-warm.ts`
   * is the implementation and never throws. A rejection here is swallowed and
   * logged anyway, because a warm-up that failed is a question for the gate,
   * not a 500 for the phone.
   *
   * Omitted means the lane is taken as it is found — which is what every caller
   * did before this existed, and what a suite injecting its own runner still
   * wants: there is no warm process for anything to be warm about.
   */
  readonly warmLane?: () => Promise<unknown>;
  /**
   * Actually cut a session's stream — `transport.close`.
   *
   * Used by {@link FaceSessionBroker.startSession} to supersede a face that is
   * already open. Optional, and its absence is not a no-op that pretends to
   * work: without it nothing is superseded at all, because settling a row while
   * the stream runs on is the leak wearing the guard's uniform.
   */
  readonly disconnect?: (sessionId: string) => Promise<void>;
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
  readonly #warmLane: (() => Promise<unknown>) | null;
  readonly #disconnect: ((sessionId: string) => Promise<void>) | null;
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
    this.#tools = options.tools ?? AskSylIngress.toolDefinitions();
    this.#isLaneWarm = options.isLaneWarm ?? null;
    this.#warmLane = options.warmLane ?? null;
    this.#disconnect = options.disconnect ?? null;
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
   * START a keep-warm turn if — and only if — one would be worth taking, and
   * **return without waiting for it**.
   *
   * ## Why it is no longer awaited, which is a measured decision
   *
   * It used to be: `startSession` awaited the whole warm turn and only then
   * created the session. Two real opens on 2026-08-23 put numbers on that —
   * `lane.warm.taken` at **20,559ms** and **22,369ms**, with the Runway create
   * following 0.5s later in both cases. Twenty seconds of a long press spent
   * on a black screen before the provider had even been asked for a session,
   * and the page then had its own wake to do on top.
   *
   * The turn cannot be made cheap: a lane goes warm only by taking a turn, and
   * what makes it slow is exactly the cold context ingestion that makes it
   * warm afterwards (`harness/keep-warm.ts`). So it is **hidden behind the
   * create and the poll** instead of run in front of them — the same twenty
   * seconds, spent alongside work that had to happen anyway.
   *
   * Three refusals, in the order that spends least:
   *
   * - **no warmer supplied**: the lane is taken as found, as it always was;
   * - **already warm**: the process is live and has handshaken, so a turn here
   *   would buy nothing and would race the reaper for no reason;
   * - **no budget**: today's ceiling is spent, so the gate below is going to
   *   refuse this session anyway. Warming for a face that cannot open is a
   *   subscription turn burned on a refusal. The cheap check runs first even
   *   though the *gate* order stays lane-then-ceiling, which is asserted in
   *   `face-session-broker.test.ts` and unaffected: this is not a gate.
   *
   * The returned promise never rejects — everything is caught inside — so a
   * caller may drop it. `harness/keep-warm.ts` already resolves on failure;
   * the `catch` here is the belt for a caller that supplies something else,
   * because a preparation that can fail an open is not a preparation.
   */
  #beginWarmUp(): WarmUpInFlight {
    if (this.#warmLane === null) return NO_WARM_UP;
    if (this.#isLaneWarm !== null && this.#isLaneWarm()) return NO_WARM_UP;
    if (!this.#guard.canStartSession()) return NO_WARM_UP;

    const warmLane = this.#warmLane;
    const startedAt = this.#now();
    let done = false;

    const settled = (async (): Promise<void> => {
      try {
        const outcome = await warmLane();
        this.#log("face.lane.warmed", { outcome, elapsedMs: this.#now() - startedAt });
      } catch (error) {
        this.#log("face.lane.warm_failed", {
          elapsedMs: this.#now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        done = true;
      }
    })();

    return { started: true, finished: (): boolean => done, settled };
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
    // 0. WARM HER, ALONGSIDE THE OPEN RATHER THAN IN FRONT OF IT.
    //    `syl-chzl.2.3`: the lane goes cold after fifteen idle minutes and
    //    there is no free pre-warm — the CLI emits nothing until a frame
    //    arrives, so a lane becomes warm only by taking a turn. Without this,
    //    the ordinary case (he has not spoken to her in a while and
    //    long-presses her face) hits the refusal below every single time.
    //
    //    **Started, not awaited.** Measured at 20.6s and 22.4s on two real
    //    opens; see `#beginWarmUp`. It now runs for the length of the create
    //    and the poll instead of before them.
    const warming = this.#beginWarmUp();

    // 1. The free gates, cheapest first. Neither makes an HTTP call.
    //
    //    The cold gate refuses only when NOTHING IS BEING DONE ABOUT IT. With
    //    a turn already in flight the lane's coldness is a fact about this
    //    instant and not about the instant her face appears, and refusing on
    //    it would refuse precisely the case `#beginWarmUp` exists to serve.
    //    The re-check after READY is where a warm-up that failed is caught.
    if (this.#isLaneWarm !== null && !warming.started && !this.#isLaneWarm()) {
      throw new FaceColdLaneError();
    }
    if (!this.#guard.canStartSession()) {
      throw new FaceCostCeilingError(this.#guard.dailyCreditCeiling, this.#guard.spentToday());
    }
    if (this.#avatarId === "") {
      throw new Error(
        "No avatar is configured, so there is no face to open. Set SYL_FACE_AVATAR_ID.",
      );
    }

    // 1b. ONE FACE AT A TIME. Everything still open is cut and settled BEFORE
    //     anything new is created, so at no instant are two meters running.
    //     See `#supersedeLive` for why it is before the create and not after.
    await this.#supersedeLive();

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
    const createStartedAt = this.#now();
    const created = await this.#runway.createRealtimeSession(input);
    const createMs = this.#now() - createStartedAt;
    const sessionId = created.id;
    const upfront = this.#upfrontCredits();

    this.#guard.recordSpend(upfront);
    this.#sessions.open({
      id: sessionId,
      avatarId: this.#avatarId,
      credits: upfront,
      dollars: upfront * this.#guard.costModel.dollarsPerCredit,
      askSecretHash: minted.hash,
      // The provider's cap when it reported one at create; otherwise a floor,
      // replaced by the real cap at READY. `provider_cap_at` stays NULL until
      // the provider actually says something, so "no cap" and "capped" remain
      // distinguishable — see the migration.
      askExpiresAt: this.#expiryOf(created) ?? this.#now() + DEFAULT_CREDENTIAL_TTL_MS,
    });
    this.#log("face.session.opened", {
      sessionId,
      avatarId: this.#avatarId,
      credits: upfront,
      // **Stage timings, because "waking her" for thirty-five seconds was
      // unanswerable without them.** Every number the wake is made of is
      // logged at the stage that spent it: this one, `readyMs` below,
      // `face.lane.warmed`'s `elapsedMs`, and `face.rpc.attached`'s in
      // `routes/face.ts`. A latency nobody can attribute is a latency nobody
      // can cut.
      createMs,
      warmingLane: warming.started,
    });

    // 4. Poll to READY.
    const readyStartedAt = this.#now();
    const ready = await this.#pollToReady(sessionId);
    const readyMs = this.#now() - readyStartedAt;
    this.#log("face.session.ready", { sessionId, readyMs, pollIntervalMs: this.#pollIntervalMs });

    // 4a. THE COLD GATE, ASKED AT THE MOMENT IT ACTUALLY MATTERS.
    //
    //     The warm turn has now had the create and the whole poll to run in,
    //     and there are three answers:
    //
    //     - **warm**: the ordinary one, and nothing to say.
    //     - **still warming**: hand the face over. Her page has its own wake
    //       to do — imports, a room join, a first frame — and he has to speak
    //       before anything asks her anything. If a question does beat the
    //       turn, `AskSylIngress` has its own cold gate and answers it in
    //       words. Refusing a session that is drawing correctly, to protect
    //       against a question nobody has asked, is the trade the old serial
    //       warm made and it cost twenty seconds every single time.
    //     - **finished and STILL cold**: the warm-up failed. That is the case
    //       the gate is for, and it still refuses — the row is settled
    //       `failed` and the upfront the provider already charged is on it,
    //       exactly as for a session that never readied.
    if (this.#isLaneWarm !== null && !this.#isLaneWarm()) {
      if (warming.finished()) {
        this.#fail(sessionId);
        throw new FaceColdLaneError();
      }
      this.#log("face.lane.still_warming", {
        sessionId,
        note: "the face is ready before the keep-warm turn is; the ask ingress guards the gap",
      });
    }

    // The provider only reports its cap once the session is up, so the
    // credential's floor written above is replaced by the real thing now.
    const cap = ready.expiresAt === undefined ? Number.NaN : Date.parse(ready.expiresAt);
    if (!Number.isNaN(cap)) this.#sessions.adoptProviderExpiry(sessionId, cap);

    // The page's own credential, hashed (`0037`). It exists only from here —
    // the provider does not issue a session key before READY — which is why a
    // session that never readied can never accept a client report.
    this.#sessions.bindClientCredential(sessionId, hashSessionKey(ready.sessionKey));

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

  /**
   * One face at a time — the fix for the second long press.
   *
   * ## What happened
   *
   * 2026-08-23: he pressed, saw nothing, and pressed again 82 seconds later.
   * Two realtime sessions were live at once and **both were billing**, 44 and
   * 46 credits, and neither was ever closed by the client — the idle reaper
   * found them both two minutes in. `LiveFaceModel` guards rule 1 correctly on
   * the phone, and the guard is worth nothing across a crash, a force-quit or a
   * relaunch, because the model that holds it does not survive any of them. A
   * rule that only exists in the client is a rule that stops existing exactly
   * when the client is the thing going wrong.
   *
   * ## Why "replace" and not "join"
   *
   * There is nothing to join. A realtime session's `sessionKey` is short-lived
   * and handed out once at READY; it is not stored, and the provider offers no
   * second issue of it. So the honest maximum is that opening a face *ends*
   * whatever face was open, which is also what a second long press means.
   *
   * ## Why BEFORE the create and not after
   *
   * Because after leaves a window — the create plus the poll to READY, up to
   * thirty seconds — during which two meters run, and the whole point is that
   * they never do. The cost is real and it is accepted: if the create then
   * fails he has lost a face he already had. That face was one he had just
   * asked to replace, and he gets a refusal sentence rather than silence.
   *
   * ## A cut that fails does NOT settle the row
   *
   * Same rule as the reaper's, for the same reason: a row marked closed while
   * the stream runs on makes the ledger say the leak has stopped. It is logged
   * loudly, left open, and the reaper picks it up on its own terms.
   */
  async #supersedeLive(): Promise<void> {
    // With no way to cut a stream there is nothing honest to do here. Settling
    // the rows would only hide the second meter, which is worse than the bug.
    if (this.#disconnect === null) return;

    for (const other of this.#sessions.live()) {
      try {
        await this.#disconnect(other.id);
      } catch (error) {
        this.#log("face.session.supersede_failed", {
          sessionId: other.id,
          error: error instanceof Error ? error.message : String(error),
          note: "still open and still billing; left for the reaper",
        });
        continue;
      }

      // `closed` rather than a fifth `ended` value: SQLite cannot widen a
      // CHECK without rebuilding the table, and the distinction that matters —
      // reaped from closed — is untouched. The log line below is what names
      // this one, with both ids on it.
      const settled = this.recordSessionEnd(other.id, "closed").settled;
      if (settled) {
        this.#log("face.session.superseded", {
          sessionId: other.id,
          clientState: other.clientState,
          note: "a second face was opened, so this one was cut before it could bill alongside it",
        });
      }
    }
  }

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
