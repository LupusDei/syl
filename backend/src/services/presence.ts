import type { PresenceState } from "@syl/shared";

import { isWithinQuietHours, type QuietHours } from "../harness/schedule.js";
import { instant, systemClock, type Clock } from "./clock.js";
import type { AffectHint } from "./message-store.js";

/**
 * Syl's presence, derived from facts the service already owns.
 *
 * ## The model does not emit this
 *
 * A turn started, so: `thinking`. Audio began, so: `speaking`. The turn
 * returned a result, so: `idle`. Quiet hours are running, so: `absent`. Every
 * one of those is something the service knows for certain, and asking a model
 * to declare its own state instead buys three problems: it forgets, it emits
 * values that were never in the enum, and — the one that decides it — **it
 * lies about latency.** If Syl announces that she is thinking and the
 * subprocess then stalls, the ribbon says thinking because the model said so,
 * not because anything is happening. Derived state cannot lie, because it is
 * downstream of the thing it describes.
 *
 * The model contributes exactly one optional thing: an affect hint for the two
 * states that need judgement about content rather than about mechanism,
 * `delighted` and `concerned`. It is off by default, ignored when malformed,
 * and its absence degrades to a perfectly good neutral character — which is
 * the only safe way to put a model in a UI path.
 *
 * ## `absent` is the default, not `idle`
 *
 * That single choice does more for restraint than any behavioural instruction:
 * it makes presence something she has to earn rather than something she has to
 * be talked out of.
 *
 * ## The frames are not replayable, and this service is why
 *
 * Presence carries no `seq` and is never logged, so `SylSocketServer` cannot
 * replay it even if someone later wants it to. Replaying a message the
 * Commander missed is the whole point of the replay buffer; replaying
 * "thinking" from four minutes ago is a lie. Messages replay. Presence does
 * not.
 *
 * ## Deriving is pure; the service only holds facts
 *
 * {@link derivePresence} is a pure function of the facts and an instant, so
 * every precedence rule is testable without a timer. The class around it does
 * three things: keep the facts, keep `since` stable, and re-emit before a TTL
 * would lapse.
 */

/** The Commander's zone. An IANA name, never a fixed offset. */
export const DEFAULT_TIMEZONE = "America/Chicago";

/** No character between these wall-clock times. */
export const DEFAULT_QUIET_HOURS: QuietHours = { start: "23:00", end: "08:00" };

/**
 * How long each state stays valid without a further frame.
 *
 * On expiry the client falls back to `idle`, and after a further 30 seconds of
 * silence to `absent`. The failure mode has to be quiet, not stuck.
 *
 * `thinking`, `speaking`, `alert` and `absent` match the values the contract's
 * fixtures were captured with; a test pins them so a casual edit cannot drift
 * the wire away from what the app was built against.
 */
export const PRESENCE_TTL_MS: Readonly<Record<PresenceState, number>> = {
  absent: 0,
  idle: 30_000,
  listening: 5_000,
  thinking: 15_000,
  speaking: 4_000,
  alert: 8_000,
  delighted: 6_000,
  concerned: 20_000,
  manifest: 6_000,
};

/** Default amplitude per state, when nothing better is known. */
const DEFAULT_INTENSITY: Readonly<Record<PresenceState, number>> = {
  absent: 0,
  idle: 0.15,
  listening: 0.4,
  thinking: 0.55,
  speaking: 0.4,
  alert: 0.9,
  delighted: 0.9,
  concerned: 0.6,
  manifest: 1,
};

/** The two states an affect hint may ask for. Anything else is ignored. */
const AFFECT_STATES: readonly PresenceState[] = ["delighted", "concerned"];

/** `delighted` needs a real close, and one a day at most. */
export const DELIGHTED_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The longest the service will go without recomputing.
 *
 * Quiet hours are wall-clock, so nothing pushes the service across their
 * boundary — and sleep, wake, DST and an NTP correction all move the clock
 * underneath it. Recomputing from `now` at least once a minute makes every one
 * of those self-heal, for the same reason the job runner clamps its timer.
 */
const MAX_TICK_MS = 60_000;

/** How much intensity has to move before it is worth another frame. */
const INTENSITY_EPSILON = 0.05;

/** A held affect hint. */
export interface HeldAffect {
  readonly state: PresenceState;
  readonly intensity: number;
  /** When it stops applying. */
  readonly until: number;
}

/** Everything the derivation looks at. */
export interface PresenceFacts {
  /** The hard mute. Decoupled from notifications, and it wins over everything. */
  readonly muted: boolean;
  /** Whether any client is attached — "present but silent" is `idle`. */
  readonly attached: boolean;
  /** How many turns are in flight. Counted, not flagged, so two turns nest. */
  readonly turnsInFlight: number;
  readonly audioPlaying: boolean;
  readonly micLive: boolean;
  /** Until when a time-sensitive delivery holds the screen. */
  readonly alertUntil: number | null;
  /** Until when the set piece is running. */
  readonly manifestUntil: number | null;
  readonly affect: HeldAffect | null;
  /** Audio or input amplitude, when one is known. */
  readonly level: number | null;
}

/** What the derivation needs to know about the Commander's day. */
export interface PresenceWindow {
  readonly quietHours: QuietHours;
  readonly timeZone: string;
}

/** A presence frame, in this service's own camelCase. */
export interface PresenceFrame {
  readonly state: PresenceState;
  readonly intensity: number;
  /** When the current state began — not when the frame was sent. */
  readonly since: string;
  /** Rendered on the wire as the contract's one snake_case field, `ttl_ms`. */
  readonly ttlMs: number;
}

/** Where a frame goes. `SylSocketServer.announcePresence` has this shape. */
export type PresenceSink = (frame: PresenceFrame) => void;

/** State and amplitude, before `since` is attached. */
export interface DerivedPresence {
  readonly state: PresenceState;
  readonly intensity: number;
  readonly ttlMs: number;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Work out what Syl's presence is, from the facts and the time.
 *
 * Pure, and the precedence is the whole content of the function:
 *
 * 1. **Muted or in quiet hours → `absent`.** Unconditionally, including for a
 *    reminder that was deferred and will be shown in the morning.
 * 2. **`alert`** — the interruption outranks whatever it interrupted. It is
 *    rationed by being coupled to the `time-sensitive` interruption level: if
 *    a message is not worth breaking through Focus, it is not worth this.
 * 3. **`manifest`**, the rare set piece.
 * 4. **`speaking`**, then **`thinking`**, then **`listening`** — mechanism,
 *    most specific first. Audio playing is more informative than a turn being
 *    open, since audio only plays once a turn has produced something.
 * 5. **`delighted` / `concerned`** — mood, below every mechanism, because what
 *    she is doing right now is the more honest thing to show.
 * 6. **`idle`** if anyone is watching, else **`absent`**.
 */
export function derivePresence(
  facts: PresenceFacts,
  now: number,
  window: PresenceWindow,
): DerivedPresence {
  const state = deriveState(facts, now, window);
  const intensity =
    state === "delighted" || state === "concerned"
      ? clamp(facts.affect?.intensity ?? DEFAULT_INTENSITY[state])
      : (state === "speaking" || state === "listening") && facts.level !== null
        ? clamp(facts.level)
        : DEFAULT_INTENSITY[state];

  return { state, intensity, ttlMs: PRESENCE_TTL_MS[state] };
}

function deriveState(facts: PresenceFacts, now: number, window: PresenceWindow): PresenceState {
  if (facts.muted) return "absent";
  if (isWithinQuietHours(new Date(now), window.quietHours, window.timeZone)) return "absent";

  if (facts.alertUntil !== null && facts.alertUntil > now) return "alert";
  if (facts.manifestUntil !== null && facts.manifestUntil > now) return "manifest";
  if (facts.audioPlaying) return "speaking";
  if (facts.turnsInFlight > 0) return "thinking";
  if (facts.micLive) return "listening";
  if (facts.affect !== null && facts.affect.until > now) return facts.affect.state;

  return facts.attached ? "idle" : "absent";
}

export interface PresenceServiceOptions {
  readonly clock?: Clock;
  /** Where frames go. Omit for a service that only computes. */
  readonly emit?: PresenceSink;
  readonly quietHours?: QuietHours;
  readonly timeZone?: string;
  /**
   * Whether a turn's affect hint may reach the character.
   *
   * Off by default. The contract defines the hint now so the app never needs a
   * protocol change; switching it on is a separate decision.
   */
  readonly affectHints?: boolean;
}

/**
 * Holds the facts, keeps `since` honest, and re-emits before a TTL lapses.
 *
 * Every mutator recomputes and emits only if something a client would notice
 * has changed, so a busy turn does not produce a frame per event.
 */
export class PresenceService {
  readonly #clock: Clock;
  readonly #emit: PresenceSink | null;
  readonly #window: PresenceWindow;
  readonly #affectHints: boolean;

  #muted = false;
  #attached = false;
  #turnsInFlight = 0;
  #audioPlaying = false;
  #micLive = false;
  #alertUntil: number | null = null;
  #manifestUntil: number | null = null;
  #affect: HeldAffect | null = null;
  #level: number | null = null;
  #lastDelightedAt: number | null = null;

  #frame: PresenceFrame;
  /** When the current state must be re-announced, or null if it never must. */
  #refreshAt: number | null = null;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(options: PresenceServiceOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#emit = options.emit ?? null;
    this.#window = {
      quietHours: options.quietHours ?? DEFAULT_QUIET_HOURS,
      timeZone: options.timeZone ?? DEFAULT_TIMEZONE,
    };
    this.#affectHints = options.affectHints ?? false;

    const now = this.#clock();
    const derived = derivePresence(this.#facts(), now, this.#window);
    // The opening state is not announced: nobody is listening yet, and a
    // client that connects gets the next real change. `absent` is also what a
    // client assumes before it has heard anything.
    this.#frame = { ...derived, since: instant(now) };
    this.#arm();
  }

  /** The frame a client would currently be showing. */
  get current(): PresenceFrame {
    return this.#frame;
  }

  /** A turn started. Counted, so two overlapping turns end at the second result. */
  turnStarted(): void {
    this.#turnsInFlight += 1;
    this.#settle();
  }

  /** A turn returned a result. */
  turnEnded(): void {
    // Clamped at zero: an unbalanced call is a bug in a caller, and the right
    // response is a character that still works rather than a negative count
    // that makes her permanently idle.
    this.#turnsInFlight = Math.max(0, this.#turnsInFlight - 1);
    this.#settle();
  }

  /** The first audio frame played. */
  audioStarted(): void {
    this.#audioPlaying = true;
    this.#settle();
  }

  audioEnded(): void {
    this.#audioPlaying = false;
    this.#level = null;
    this.#settle();
  }

  micOpened(): void {
    this.#micLive = true;
    this.#settle();
  }

  micClosed(): void {
    this.#micLive = false;
    this.#level = null;
    this.#settle();
  }

  /**
   * Amplitude, 0..1.
   *
   * Only used while speaking or listening. The device samples its own audio at
   * 60 Hz and never sends it; this is for a level the service itself knows.
   */
  setLevel(level: number): void {
    this.#level = clamp(level);
    this.#settle();
  }

  /** A time-sensitive delivery went out. */
  alerted(): void {
    this.#alertUntil = this.#clock() + PRESENCE_TTL_MS.alert;
    this.#settle();
  }

  /** The pre-rendered set piece. A few seconds, and rare. */
  manifested(): void {
    this.#manifestUntil = this.#clock() + PRESENCE_TTL_MS.manifest;
    this.#settle();
  }

  /** Whether any client is attached. `idle` is "present but silent". */
  setAttached(attached: boolean): void {
    this.#attached = attached;
    this.#settle();
  }

  /** The hard mute: pins her to `absent` while reminders keep arriving. */
  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.#settle();
  }

  /**
   * Offer the affect hint a turn emitted.
   *
   * Absent means neutral, malformed is ignored, and an unknown name is
   * ignored. `delighted` additionally needs a real close and is allowed once a
   * day: a character that celebrates everything celebrates nothing.
   */
  affect(hint: AffectHint | null): void {
    if (!this.#affectHints || hint === null) return;

    // Safe comparison rather than a cast: the hint comes from a model, so an
    // unrecognised name is expected rather than exceptional.
    const state = AFFECT_STATES.find((candidate) => candidate === hint.state);
    if (state === undefined) return;

    const now = this.#clock();
    if (state === "delighted") {
      if (this.#lastDelightedAt !== null && now - this.#lastDelightedAt < DELIGHTED_INTERVAL_MS) {
        return;
      }
      this.#lastDelightedAt = now;
    }

    this.#affect = { state, intensity: clamp(hint.intensity), until: now + PRESENCE_TTL_MS[state] };
    this.#settle();
  }

  /** Stop the timer and stop emitting. Safe to call twice. */
  close(): void {
    this.#closed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  // ------------------------------------------------------------- internals ---

  #facts(): PresenceFacts {
    return {
      muted: this.#muted,
      attached: this.#attached,
      turnsInFlight: this.#turnsInFlight,
      audioPlaying: this.#audioPlaying,
      micLive: this.#micLive,
      alertUntil: this.#alertUntil,
      manifestUntil: this.#manifestUntil,
      affect: this.#affect,
      level: this.#level,
    };
  }

  /**
   * Recompute, emit if a client would notice, and re-arm the timer.
   *
   * The only path. A separate "just refresh" path would have to decide which
   * of two coinciding deadlines it was serving, and a tie there is a state
   * change that arrives half a TTL late.
   */
  #settle(): void {
    if (this.#closed) return;

    const now = this.#clock();
    const derived = derivePresence(this.#facts(), now, this.#window);
    const previous = this.#frame;

    if (derived.state !== previous.state) {
      // A new state begins now, so `since` is re-stamped. This is the only
      // place it moves.
      this.#frame = { ...derived, since: instant(now) };
      this.#publish(now);
    } else if (Math.abs(derived.intensity - previous.intensity) >= INTENSITY_EPSILON) {
      this.#frame = { ...derived, since: previous.since };
      this.#publish(now);
    } else if (this.#refreshAt !== null && now >= this.#refreshAt) {
      // Nothing changed, but the state has to be re-announced before its TTL
      // runs out — a three-minute turn must not leave the client falling back
      // to idle after fifteen seconds.
      this.#publish(now);
    }

    this.#arm();
  }

  #publish(now: number): void {
    const ttl = this.#frame.ttlMs;
    // Half the TTL leaves room for one lost frame. A state with no TTL —
    // `absent` — is the resting state and needs no keepalive.
    this.#refreshAt = ttl > 0 ? now + Math.max(1, Math.floor(ttl / 2)) : null;
    this.#emit?.(this.#frame);
  }

  /**
   * Arm one timer for the earliest thing that could change the answer.
   *
   * Recomputed from `now` on every tick rather than accumulated, so a laptop
   * that slept through three deadlines wakes up and settles once instead of
   * firing three stale ones.
   */
  #arm(): void {
    if (this.#closed) return;
    if (this.#timer !== null) clearTimeout(this.#timer);

    const now = this.#clock();
    const deadlines: number[] = [now + MAX_TICK_MS];

    // A transient state stops applying the instant its window closes, and the
    // state underneath it has to appear then rather than at the next tick.
    for (const at of [this.#alertUntil, this.#manifestUntil, this.#affect?.until ?? null]) {
      if (at !== null && at > now) deadlines.push(at + 1);
    }

    if (this.#refreshAt !== null) deadlines.push(this.#refreshAt);

    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        this.#settle();
      },
      Math.max(0, Math.min(...deadlines) - now),
    );
    // A pending timer must not hold the process open on its own.
    this.#timer.unref?.();
  }
}
