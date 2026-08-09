import XCTest

@testable import SylKit

/// Presence expiry, which is the rule that keeps a dropped connection from leaving Syl
/// frozen mid-thought forever. The failure mode has to be quiet, not stuck.
final class PresenceTimelineTests: XCTestCase {
    private let received = try! Instant.parse("2026-08-09T07:00:03.114Z")

    private func thinking(ttlMs: Int = 15_000) -> WsPresence {
        WsPresence(state: .thinking, intensity: 0.55, since: received, ttlMs: ttlMs)
    }

    // MARK: - The default

    func testShouldBeAbsentBeforeAnythingHasEverPutHerOnScreen() {
        // `absent` is the default, not `idle` — she is not on screen unless something
        // put her there.
        XCTAssertEqual(PresenceTimeline().state(at: received), .absent)
    }

    // MARK: - Within the TTL

    func testShouldRenderTheFrameStateWhileTheTTLHolds() {
        var timeline = PresenceTimeline()
        timeline.record(thinking(), at: received)

        XCTAssertEqual(timeline.state(at: received.addingTimeInterval(14)), .thinking)
    }

    func testShouldClampTheIntensityItRenders() {
        var timeline = PresenceTimeline()
        timeline.record(
            WsPresence(state: .alert, intensity: 1.4, since: received, ttlMs: 8000),
            at: received
        )

        XCTAssertEqual(timeline.intensity(at: received), 1.0, accuracy: 0.0001)
    }

    func testShouldReportHowLongTheCurrentStateHasBeenRunning() throws {
        // `since` is when the state began, not when the frame was sent, so a client
        // joining mid-speaking can tell how long it has been going.
        let began = try! Instant.parse("2026-08-09T07:00:00.114Z")
        var timeline = PresenceTimeline()
        timeline.record(
            WsPresence(state: .speaking, intensity: 0.4, since: began, ttlMs: 4000),
            at: received
        )

        XCTAssertEqual(try XCTUnwrap(timeline.duration(at: received)), 3, accuracy: 0.0001)
    }

    // MARK: - Expiry

    func testShouldFallBackToIdleOnceTheTTLExpires() {
        var timeline = PresenceTimeline()
        timeline.record(thinking(ttlMs: 15_000), at: received)

        XCTAssertEqual(timeline.state(at: received.addingTimeInterval(15.001)), .idle)
    }

    func testShouldFallBackToAbsentAfterAFurtherThirtySecondsOfSilence() {
        var timeline = PresenceTimeline()
        timeline.record(thinking(ttlMs: 15_000), at: received)

        XCTAssertEqual(timeline.state(at: received.addingTimeInterval(15 + 29)), .idle)
        XCTAssertEqual(timeline.state(at: received.addingTimeInterval(15 + 31)), .absent)
    }

    func testShouldExpireAZeroTTLFrameImmediately() {
        // `absent` carries ttl_ms 0.
        var timeline = PresenceTimeline()
        timeline.record(
            WsPresence(state: .absent, intensity: 0, since: received, ttlMs: 0),
            at: received
        )

        XCTAssertEqual(timeline.state(at: received), .idle)
    }

    func testShouldReportNoIntensityOnceTheStateHasExpired() {
        // An amplitude outliving its state is the same lie as the state itself.
        var timeline = PresenceTimeline()
        timeline.record(thinking(ttlMs: 1000), at: received)

        XCTAssertEqual(timeline.intensity(at: received.addingTimeInterval(5)), 0)
        XCTAssertNil(timeline.duration(at: received.addingTimeInterval(5)))
    }

    func testShouldReportTheInstantAtWhichTheRenderedStateNextChanges() {
        var timeline = PresenceTimeline()
        timeline.record(thinking(ttlMs: 4000), at: received)

        XCTAssertEqual(timeline.nextTransition(), received.addingTimeInterval(4))
    }

    // MARK: - Disconnection

    func testShouldForgetPresenceWhenTheSocketDrops() {
        // Replaying "thinking" from four minutes ago is a lie: it asserts something
        // about now that stopped being true while the socket was down.
        var timeline = PresenceTimeline()
        timeline.record(thinking(), at: received)

        timeline.clear()

        XCTAssertEqual(timeline.state(at: received), .absent)
        XCTAssertNil(timeline.nextTransition())
    }

    // MARK: - Replacement

    func testShouldRenderTheMostRecentFrameWhenSeveralArrive() {
        var timeline = PresenceTimeline()
        timeline.record(thinking(ttlMs: 15_000), at: received)
        timeline.record(
            WsPresence(state: .speaking, intensity: 0.4, since: received, ttlMs: 4000),
            at: received.addingTimeInterval(3)
        )

        XCTAssertEqual(timeline.state(at: received.addingTimeInterval(5)), .speaking)
    }
}
