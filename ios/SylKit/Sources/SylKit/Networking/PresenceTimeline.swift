import Foundation

/// Tracks what Syl's presence *currently* is, given the frames received and the time.
///
/// The rule the whole frame exists around is that presence expires. `ttl_ms` is how
/// long a state stays valid with no further frame; on expiry the client falls back to
/// `idle`, and after a further 30 seconds of silence to `absent`.
///
/// That is what stops a dropped connection leaving Syl frozen mid-thought forever.
/// **The failure mode has to be quiet, not stuck** — a character frozen mid-thought is
/// worse than no character at all, because it is actively misrepresenting what the
/// system is doing.
///
/// Pure and time-injected: `state(at:)` takes the instant rather than reading a clock,
/// so every expiry boundary is a test rather than a stopwatch.
public struct PresenceTimeline: Equatable, Sendable {
    /// How long after the TTL expires before presence decays from `idle` to `absent`.
    public static let idleGrace: TimeInterval = 30

    /// The last frame received, and when it arrived. Nil means nothing has ever put
    /// her on screen — and `absent` is the default, not `idle`.
    private var latest: (frame: WsPresence, receivedAt: Date)?

    public init() {}

    public static func == (lhs: PresenceTimeline, rhs: PresenceTimeline) -> Bool {
        switch (lhs.latest, rhs.latest) {
        case (nil, nil): return true
        case (let l?, let r?): return l.frame == r.frame && l.receivedAt == r.receivedAt
        default: return false
        }
    }

    /// Record a frame. `since` on the frame is when the *state* began, not when the
    /// frame was sent, so it is deliberately not used for expiry — expiry runs from
    /// arrival.
    public mutating func record(_ frame: WsPresence, at received: Date) {
        latest = (frame, received)
    }

    /// Forget everything. Used when the socket drops: a presence state that survived a
    /// disconnection would be asserting something about now that stopped being true.
    public mutating func clear() {
        latest = nil
    }

    /// The state to render at `instant`.
    public func state(at instant: Date) -> PresenceState {
        guard let latest else { return .absent }

        let expiry = latest.receivedAt.addingTimeInterval(latest.frame.ttl)
        if instant < expiry { return latest.frame.state }
        if instant < expiry.addingTimeInterval(Self.idleGrace) { return .idle }
        return .absent
    }

    /// The intensity to render at `instant`, already clamped. Zero once the state has
    /// expired — an amplitude outliving its state is the same lie as the state itself.
    public func intensity(at instant: Date) -> Double {
        guard let latest, state(at: instant) == latest.frame.state else { return 0 }
        return latest.frame.clampedIntensity
    }

    /// How long the current state has been running at `instant`, from the frame's
    /// `since`. A client that joins mid-`speaking` uses this to know how long it has
    /// been going, which is the only information `since` carries.
    public func duration(at instant: Date) -> TimeInterval? {
        guard let latest, state(at: instant) == latest.frame.state else { return nil }
        return instant.timeIntervalSince(latest.frame.since)
    }

    /// The next instant at which the rendered state changes, so a view can schedule
    /// one timer instead of polling.
    public func nextTransition() -> Date? {
        guard let latest else { return nil }
        return latest.receivedAt.addingTimeInterval(latest.frame.ttl)
    }
}
