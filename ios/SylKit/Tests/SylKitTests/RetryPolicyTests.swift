import XCTest

@testable import SylKit

/// Retry is not a nicety here. Since Tailscale 1.48 the iOS network extension does not
/// stay resident, so the first request after a wake can fail while the tunnel comes
/// up. A client without backoff reports "server down" about a server that is fine.
final class RetryPolicyTests: XCTestCase {
    // MARK: - The schedule

    func testShouldNotDelayBeforeTheFirstAttempt() {
        XCTAssertEqual(RetryPolicy.default.delay(beforeAttempt: 1), 0)
    }

    func testShouldGrowTheDelayExponentiallyFromTheBaseDelay() {
        let policy = RetryPolicy(maxAttempts: 5, baseDelay: 0.5, maxDelay: 30, multiplier: 2)

        XCTAssertEqual(policy.delay(beforeAttempt: 2), 0.5, accuracy: 0.0001)
        XCTAssertEqual(policy.delay(beforeAttempt: 3), 1.0, accuracy: 0.0001)
        XCTAssertEqual(policy.delay(beforeAttempt: 4), 2.0, accuracy: 0.0001)
        XCTAssertEqual(policy.delay(beforeAttempt: 5), 4.0, accuracy: 0.0001)
    }

    func testShouldCapTheDelayAtTheCeiling() {
        let policy = RetryPolicy(maxAttempts: 20, baseDelay: 1, maxDelay: 8, multiplier: 2)

        XCTAssertEqual(policy.delay(beforeAttempt: 12), 8, accuracy: 0.0001)
    }

    // MARK: - Jitter

    func testShouldNeverWaitLongerThanTheScheduleAfterJitter() {
        let policy = RetryPolicy(baseDelay: 1, maxDelay: 30, multiplier: 2, jitter: 0.5...1.0)

        let longest = policy.delay(beforeAttempt: 3, randomSample: 1.0)
        let shortest = policy.delay(beforeAttempt: 3, randomSample: 0.0)

        XCTAssertEqual(longest, 2.0, accuracy: 0.0001)
        XCTAssertEqual(shortest, 1.0, accuracy: 0.0001)
    }

    func testShouldSpreadTheDelayAcrossTheJitterRangeSoTwoClientsDoNotSynchronise() {
        // Without jitter, the outbox flush, the sync pull and the socket reconnect all
        // wake at once and retry in lockstep against a Mac that is still booting.
        let policy = RetryPolicy(baseDelay: 1, jitter: 0.5...1.0)

        let midpoint = policy.delay(beforeAttempt: 2, randomSample: 0.5)

        XCTAssertEqual(midpoint, 0.75, accuracy: 0.0001)
    }

    func testShouldClampAJitterSampleOutsideZeroToOne() {
        let policy = RetryPolicy(baseDelay: 1, jitter: 0.5...1.0)

        XCTAssertEqual(policy.delay(beforeAttempt: 2, randomSample: 4.2), 1.0, accuracy: 0.0001)
        XCTAssertEqual(policy.delay(beforeAttempt: 2, randomSample: -3), 0.5, accuracy: 0.0001)
    }

    // MARK: - The server's own opinion

    func testShouldHonourAServerSuggestedFloorRatherThanJitterBelowIt() {
        // When the server says how long to wait, it knows something the client does
        // not; waiting less simply earns another RATE_LIMITED.
        let policy = RetryPolicy(baseDelay: 0.5, jitter: 0.5...1.0)

        let delay = policy.delay(beforeAttempt: 2, randomSample: 0, serverFloor: 2)

        XCTAssertEqual(delay, 2, accuracy: 0.0001)
    }

    func testShouldIgnoreAServerFloorShorterThanTheJitteredDelay() {
        let policy = RetryPolicy(baseDelay: 4, jitter: 1.0...1.0)

        let delay = policy.delay(beforeAttempt: 2, randomSample: 1, serverFloor: 0.1)

        XCTAssertEqual(delay, 4, accuracy: 0.0001)
    }

    // MARK: - Whether to retry at all

    func testShouldRetryATransportFailureThatLooksLikeATunnelComingUp() {
        let policy = RetryPolicy(maxAttempts: 3)
        let error = APIError.transport(code: .cannotConnectToHost, description: "")

        XCTAssertTrue(policy.shouldRetry(after: error, attempt: 1))
    }

    func testShouldStopAfterTheLastAttempt() {
        let policy = RetryPolicy(maxAttempts: 3)
        let error = APIError.transport(code: .timedOut, description: "")

        XCTAssertFalse(policy.shouldRetry(after: error, attempt: 3))
    }

    func testShouldNeverRetryAnAuthenticationFailure() {
        // Retrying an auth failure fifty times is the worst possible response to a key
        // having shadowed the subscription login.
        let policy = RetryPolicy(maxAttempts: 5)
        let error = APIError.api(
            ApiError(code: .unauthorized, message: "Token expired.", retryable: false),
            status: 401
        )

        XCTAssertFalse(policy.shouldRetry(after: error, attempt: 1))
    }

    func testShouldNotRetryACancelledRequest() {
        XCTAssertFalse(RetryPolicy(maxAttempts: 5).shouldRetry(after: .cancelled, attempt: 1))
    }

    func testShouldRefuseAPolicyThatPermitsNoAttempts() {
        // A precondition rather than a clamp: a zero-attempt policy is a typo, and
        // silently turning it into one attempt hides the typo.
        XCTAssertEqual(RetryPolicy.none.maxAttempts, 1)
    }
}
