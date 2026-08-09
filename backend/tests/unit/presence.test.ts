import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_QUIET_HOURS,
  DEFAULT_TIMEZONE,
  PRESENCE_TTL_MS,
  PresenceService,
  derivePresence,
  type PresenceFacts,
  type PresenceFrame,
} from "../../src/services/presence.js";

/**
 * Presence is derived, never emitted.
 *
 * The service computes `{state, intensity, since, ttl_ms}` from facts it
 * already owns — a turn started, audio began, quiet hours are running. A model
 * asked to declare its own state forgets, drifts, and above all lies about
 * latency: if Syl says "thinking" and then the subprocess stalls, the ribbon
 * says thinking because the model said so, not because anything is happening.
 * Derived state cannot lie, because it is downstream of the thing it describes.
 */

/** Wednesday 2026-08-12, 14:00 America/Chicago — daytime, well outside quiet. */
const DAYTIME = Date.UTC(2026, 7, 12, 19, 0, 0);
/** The same day at 02:00 Chicago, inside 23:00–08:00. */
const NIGHT = Date.UTC(2026, 7, 12, 7, 0, 0);

function facts(overrides: Partial<PresenceFacts> = {}): PresenceFacts {
  return {
    muted: false,
    attached: false,
    turnsInFlight: 0,
    audioPlaying: false,
    micLive: false,
    alertUntil: null,
    manifestUntil: null,
    affect: null,
    level: null,
    ...overrides,
  };
}

describe("derivePresence", () => {
  it("should be absent by default — she is not on screen unless something put her there", () => {
    // The single choice that does the most for restraint. A character that is
    // always present is wallpaper inside a week.
    expect(derivePresence(facts(), DAYTIME, options()).state).toBe("absent");
  });

  it("should be idle when a client is attached and nothing is happening", () => {
    expect(derivePresence(facts({ attached: true }), DAYTIME, options()).state).toBe("idle");
  });

  it("should be thinking while a turn is in flight", () => {
    const derived = derivePresence(facts({ attached: true, turnsInFlight: 1 }), DAYTIME, options());

    expect(derived.state).toBe("thinking");
  });

  it("should be speaking once audio is playing, even mid-turn", () => {
    const derived = derivePresence(
      facts({ attached: true, turnsInFlight: 1, audioPlaying: true }),
      DAYTIME,
      options(),
    );

    expect(derived.state).toBe("speaking");
  });

  it("should be listening while the microphone is live", () => {
    expect(derivePresence(facts({ attached: true, micLive: true }), DAYTIME, options()).state).toBe(
      "listening",
    );
  });

  it("should let an alert outrank everything, because it is the interruption", () => {
    const derived = derivePresence(
      facts({ attached: true, audioPlaying: true, alertUntil: DAYTIME + 1_000 }),
      DAYTIME,
      options(),
    );

    expect(derived.state).toBe("alert");
  });

  it("should drop a transient state once its window has passed", () => {
    const held = facts({ attached: true, alertUntil: DAYTIME + 1_000 });

    expect(derivePresence(held, DAYTIME + 2_000, options()).state).toBe("idle");
  });

  it("should be absent during quiet hours, unconditionally", () => {
    // Including for a reminder deferred to the morning. `schedule.ts` already
    // computes the window correctly and has tests; presence reads the answer.
    const busy = facts({ attached: true, turnsInFlight: 1, alertUntil: NIGHT + 10_000 });

    expect(derivePresence(busy, NIGHT, options()).state).toBe("absent");
  });

  it("should be absent while muted, however much is going on", () => {
    // The hard mute is decoupled from notifications: reminders keep arriving
    // exactly as before. Anything that couples the two makes muting expensive.
    const busy = facts({ muted: true, attached: true, turnsInFlight: 1, audioPlaying: true });

    expect(derivePresence(busy, DAYTIME, options()).state).toBe("absent");
  });

  it("should carry the affect hint's own intensity for delighted and concerned", () => {
    // The two states the service genuinely cannot infer, because they need
    // judgement about content rather than about mechanism.
    const derived = derivePresence(
      facts({ attached: true, affect: { state: "concerned", intensity: 0.6, until: DAYTIME + 5_000 } }),
      DAYTIME,
      options(),
    );

    expect(derived).toMatchObject({ state: "concerned", intensity: 0.6 });
  });

  it("should let a turn in flight outrank an affect hint", () => {
    // Mechanism beats mood: what she is doing right now is the more honest
    // thing to show.
    const derived = derivePresence(
      facts({
        attached: true,
        turnsInFlight: 1,
        affect: { state: "delighted", intensity: 1, until: DAYTIME + 5_000 },
      }),
      DAYTIME,
      options(),
    );

    expect(derived.state).toBe("thinking");
  });

  it("should follow the audio level when one is available", () => {
    const derived = derivePresence(
      facts({ attached: true, audioPlaying: true, level: 0.8 }),
      DAYTIME,
      options(),
    );

    expect(derived.intensity).toBeCloseTo(0.8);
  });

  it("should give every state a ttl, and absent a ttl of zero", () => {
    expect(derivePresence(facts(), DAYTIME, options()).ttlMs).toBe(0);
    expect(derivePresence(facts({ attached: true, turnsInFlight: 1 }), DAYTIME, options()).ttlMs).toBe(
      PRESENCE_TTL_MS.thinking,
    );
  });

  it("should keep intensity inside 0..1 even when a hint is out of range", () => {
    const derived = derivePresence(
      facts({ attached: true, affect: { state: "concerned", intensity: 4, until: DAYTIME + 1_000 } }),
      DAYTIME,
      options(),
    );

    expect(derived.intensity).toBe(1);
  });
});

describe("PresenceService", () => {
  let emitted: PresenceFrame[];
  let now: number;
  let service: PresenceService;

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
    now = DAYTIME;
    service = new PresenceService({
      clock: () => now,
      emit: (frame) => emitted.push(frame),
    });
  });

  afterEach(() => {
    service.close();
    vi.useRealTimers();
  });

  it("should start absent and say nothing until a fact changes", () => {
    expect(service.current.state).toBe("absent");
    expect(emitted).toEqual([]);
  });

  it("should emit when the derived state changes", () => {
    service.setAttached(true);
    service.turnStarted();

    expect(emitted.map((frame) => frame.state)).toEqual(["idle", "thinking"]);
  });

  it("should not emit again for a fact that changes nothing", () => {
    service.setAttached(true);
    emitted.length = 0;

    service.setAttached(true);

    expect(emitted).toEqual([]);
  });

  it("should hold `since` constant across repeated frames of the same state", () => {
    // `since` is when the state began, not when the frame was sent. Re-stamping
    // it makes it a duplicate of the send time and destroys the only
    // information it carries — a client joining mid-speaking could no longer
    // tell how long it had been going.
    service.setAttached(true);
    service.turnStarted();
    const first = emitted.at(-1);

    now += PRESENCE_TTL_MS.thinking; // long enough to force a refresh
    vi.advanceTimersByTime(PRESENCE_TTL_MS.thinking);

    const later = emitted.at(-1);
    expect(later?.state).toBe("thinking");
    expect(later?.since).toBe(first?.since);
    expect(emitted.filter((frame) => frame.state === "thinking").length).toBeGreaterThan(1);
  });

  it("should re-stamp `since` when the state actually changes", () => {
    service.setAttached(true);
    const idleSince = emitted.at(-1)?.since;

    now += 5_000;
    service.turnStarted();

    expect(emitted.at(-1)?.since).not.toBe(idleSince);
  });

  it("should refresh before the ttl elapses, so a long turn never lapses client-side", () => {
    // The client falls back to idle when a ttl runs out. A three-minute turn
    // must not make Syl look like she stopped thinking after fifteen seconds.
    service.setAttached(true);
    service.turnStarted();
    emitted.length = 0;

    now += PRESENCE_TTL_MS.thinking;
    vi.advanceTimersByTime(PRESENCE_TTL_MS.thinking);

    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted.every((frame) => frame.state === "thinking")).toBe(true);
  });

  it("should return to what is underneath when a transient state expires", () => {
    service.setAttached(true);
    service.alerted();
    expect(service.current.state).toBe("alert");

    now += PRESENCE_TTL_MS.alert + 1;
    vi.advanceTimersByTime(PRESENCE_TTL_MS.alert + 1);

    expect(service.current.state).toBe("idle");
    expect(emitted.at(-1)?.state).toBe("idle");
  });

  it("should count turns rather than flag them, so two turns do not end at the first result", () => {
    service.setAttached(true);
    service.turnStarted();
    service.turnStarted();

    service.turnEnded();
    expect(service.current.state).toBe("thinking");

    service.turnEnded();
    expect(service.current.state).toBe("idle");
  });

  it("should not go negative when a turn is ended twice", () => {
    service.setAttached(true);
    service.turnStarted();
    service.turnEnded();
    service.turnEnded();

    service.turnStarted();

    expect(service.current.state).toBe("thinking");
  });

  it("should go absent the moment the hard mute goes on, and recover when it comes off", () => {
    service.setAttached(true);
    service.turnStarted();

    service.setMuted(true);
    expect(service.current.state).toBe("absent");

    service.setMuted(false);
    expect(service.current.state).toBe("thinking");
  });

  it("should ignore an affect hint until affect hints are switched on", () => {
    // The contract defines the hint now and leaves it off through P1, so the
    // character degrades to a perfectly good neutral one if it is never sent.
    service.setAttached(true);
    service.affect({ state: "concerned", intensity: 0.6 });

    expect(service.current.state).toBe("idle");
  });

  it("should honour an affect hint when they are enabled", () => {
    const withHints = new PresenceService({
      clock: () => now,
      emit: (frame) => emitted.push(frame),
      affectHints: true,
    });
    try {
      withHints.setAttached(true);
      withHints.affect({ state: "concerned", intensity: 0.6 });

      expect(withHints.current).toMatchObject({ state: "concerned", intensity: 0.6 });
    } finally {
      withHints.close();
    }
  });

  it("should ignore an unknown or malformed affect name rather than break", () => {
    const withHints = new PresenceService({
      clock: () => now,
      emit: (frame) => emitted.push(frame),
      affectHints: true,
    });
    try {
      withHints.setAttached(true);
      withHints.affect({ state: "smug", intensity: 0.6 });
      withHints.affect(null);

      expect(withHints.current.state).toBe("idle");
    } finally {
      withHints.close();
    }
  });

  it("should rate-limit delighted to once a day, and require asking twice to notice", () => {
    // A character that celebrates everything celebrates nothing.
    const withHints = new PresenceService({
      clock: () => now,
      emit: (frame) => emitted.push(frame),
      affectHints: true,
    });
    try {
      withHints.setAttached(true);
      withHints.affect({ state: "delighted", intensity: 1 });
      expect(withHints.current.state).toBe("delighted");

      now += PRESENCE_TTL_MS.delighted + 1;
      vi.advanceTimersByTime(PRESENCE_TTL_MS.delighted + 1);
      withHints.affect({ state: "delighted", intensity: 1 });
      expect(withHints.current.state).toBe("idle");

      now += 24 * 60 * 60 * 1000;
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      withHints.affect({ state: "delighted", intensity: 1 });
      expect(withHints.current.state).toBe("delighted");
    } finally {
      withHints.close();
    }
  });

  it("should never leave concerned rate-limited — a deadline at risk is not a celebration", () => {
    const withHints = new PresenceService({
      clock: () => now,
      emit: (frame) => emitted.push(frame),
      affectHints: true,
    });
    try {
      withHints.setAttached(true);
      withHints.affect({ state: "concerned", intensity: 0.6 });
      now += PRESENCE_TTL_MS.concerned + 1;
      withHints.affect({ state: "concerned", intensity: 0.9 });

      expect(withHints.current).toMatchObject({ state: "concerned", intensity: 0.9 });
    } finally {
      withHints.close();
    }
  });

  it("should follow the quiet-hours boundary without being told", () => {
    // The window is wall-clock, so nothing pushes the service across it. A tick
    // clamped to a minute is what makes sleep, wake and DST self-heal.
    now = NIGHT;
    service.setAttached(true);
    service.turnStarted();
    expect(service.current.state).toBe("absent");

    // 08:00 Chicago, the moment the window ends.
    now = Date.UTC(2026, 7, 12, 13, 0, 0);
    vi.advanceTimersByTime(60_000);

    expect(service.current.state).toBe("thinking");
  });

  it("should emit nothing after close, so a shut-down service cannot animate a client", () => {
    service.setAttached(true);
    service.close();
    emitted.length = 0;

    service.turnStarted();

    expect(emitted).toEqual([]);
  });

  it("should survive being closed twice", () => {
    service.close();
    expect(() => service.close()).not.toThrow();
  });

  it("should clamp the audio level it is handed", () => {
    service.setAttached(true);
    service.audioStarted();
    service.setLevel(4);

    expect(service.current.intensity).toBe(1);
  });

  it("should stop speaking when the audio ends", () => {
    service.setAttached(true);
    service.audioStarted();
    service.audioEnded();

    expect(service.current.state).toBe("idle");
  });

  it("should open and close the microphone", () => {
    service.setAttached(true);
    service.micOpened();
    expect(service.current.state).toBe("listening");

    service.micClosed();
    expect(service.current.state).toBe("idle");
  });

  it("should show the manifest set piece and then let it go", () => {
    service.setAttached(true);
    service.manifested();
    expect(service.current.state).toBe("manifest");

    now += PRESENCE_TTL_MS.manifest + 1;
    vi.advanceTimersByTime(PRESENCE_TTL_MS.manifest + 1);

    expect(service.current.state).toBe("idle");
  });

  it("should never emit a frame the contract would reject", () => {
    service.setAttached(true);
    service.turnStarted();
    service.audioStarted();
    service.alerted();

    for (const frame of emitted) {
      expect(frame.intensity).toBeGreaterThanOrEqual(0);
      expect(frame.intensity).toBeLessThanOrEqual(1);
      expect(frame.ttlMs).toBeGreaterThanOrEqual(0);
      expect(frame.since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(PRESENCE_TTL_MS[frame.state]).toBeDefined();
    }
  });
});

describe("the defaults", () => {
  it("should use the Commander's zone and window, stored as an IANA name", () => {
    // Never a fixed UTC offset: an offset is a property of an instant, not of
    // a place, and one that reaches storage survives exactly one DST boundary.
    expect(DEFAULT_TIMEZONE).toBe("America/Chicago");
    expect(DEFAULT_QUIET_HOURS).toEqual({ start: "23:00", end: "08:00" });
  });

  it("should match the ttl values the contract's fixtures were captured with", () => {
    expect(PRESENCE_TTL_MS.thinking).toBe(15_000);
    expect(PRESENCE_TTL_MS.speaking).toBe(4_000);
    expect(PRESENCE_TTL_MS.alert).toBe(8_000);
    expect(PRESENCE_TTL_MS.absent).toBe(0);
  });
});

/** Options as `derivePresence` takes them. */
function options() {
  return { quietHours: DEFAULT_QUIET_HOURS, timeZone: DEFAULT_TIMEZONE };
}
