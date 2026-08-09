import Foundation

/// Exponential backoff with jitter, and it is **not optional**.
///
/// Since Tailscale 1.48 the iOS network extension deliberately does not stay
/// resident in the background, so the first request after a wake can fail while the
/// tunnel re-establishes. Treating that as "server down" makes a healthy system feel
/// broken. Every call retries.
///
/// Jitter matters more than it looks: without it, a phone waking up and firing the
/// outbox, a sync and a socket reconnect at once produces three synchronised retry
/// storms against a Mac that is still booting.
public struct RetryPolicy: Sendable, Equatable {
    /// Total attempts including the first. `1` disables retrying.
    public let maxAttempts: Int
    /// Delay before the second attempt.
    public let baseDelay: TimeInterval
    /// Ceiling on any single delay.
    public let maxDelay: TimeInterval
    /// Growth factor per attempt.
    public let multiplier: Double
    /// The proportion of the computed delay actually waited, sampled per attempt.
    /// `0.5...1.0` is "full-ish" jitter: never longer than the schedule, never
    /// synchronised with another client.
    public let jitter: ClosedRange<Double>

    public init(
        maxAttempts: Int = 4,
        baseDelay: TimeInterval = 0.5,
        maxDelay: TimeInterval = 8,
        multiplier: Double = 2,
        jitter: ClosedRange<Double> = 0.5...1.0
    ) {
        precondition(maxAttempts >= 1, "a policy that permits no attempts cannot make a request")
        precondition(baseDelay >= 0, "a negative delay is not a delay")
        precondition(jitter.lowerBound >= 0 && jitter.upperBound <= 1, "jitter is a proportion")
        self.maxAttempts = maxAttempts
        self.baseDelay = baseDelay
        self.maxDelay = maxDelay
        self.multiplier = multiplier
        self.jitter = jitter
    }

    /// The default for HTTP calls: four attempts over roughly three and a half
    /// seconds, which comfortably covers a tunnel coming back up without making a
    /// genuinely-down server feel like a hang.
    public static let `default` = RetryPolicy()

    /// No retrying. For calls whose caller does its own scheduling.
    public static let none = RetryPolicy(maxAttempts: 1)

    /// The backoff schedule for `attempt`, before jitter. Attempt 1 is the first
    /// request, so the first delay is `delay(beforeAttempt: 2) == baseDelay`.
    public func delay(beforeAttempt attempt: Int) -> TimeInterval {
        guard attempt > 1 else { return 0 }
        let exponent = Double(attempt - 2)
        return min(baseDelay * pow(multiplier, exponent), maxDelay)
    }

    /// The delay actually waited before `attempt`, given a jitter sample in `0...1`
    /// and any server-suggested floor.
    ///
    /// A `Retry-After` floor is honoured rather than jittered away: when the server
    /// says how long to wait it knows something the client does not, and waiting less
    /// than it asked simply earns another `RATE_LIMITED`.
    public func delay(
        beforeAttempt attempt: Int,
        randomSample: Double,
        serverFloor: TimeInterval? = nil
    ) -> TimeInterval {
        let scheduled = delay(beforeAttempt: attempt)
        let span = jitter.upperBound - jitter.lowerBound
        let proportion = jitter.lowerBound + span * min(max(randomSample, 0), 1)
        let jittered = scheduled * proportion
        guard let serverFloor else { return jittered }
        return max(jittered, serverFloor)
    }

    /// Whether another attempt should be made after `error` on `attempt`.
    public func shouldRetry(after error: APIError, attempt: Int) -> Bool {
        attempt < maxAttempts && error.isRetryable
    }
}
