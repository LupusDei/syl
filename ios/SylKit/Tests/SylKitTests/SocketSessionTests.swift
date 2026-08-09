import XCTest

@testable import SylKit

/// The protocol, exercised without a socket.
///
/// Everything that is easy to get wrong here is about sequencing, and none of it needs
/// I/O to be wrong — so none of it needs I/O to be tested.
final class SocketSessionTests: XCTestCase {
    private let token = "syl_pat_9f2c41d8b7e04a6f8c1d3e5a7b9c0d2e"

    private func makeSession(lastSeq: Int = 0) -> SocketSession {
        SocketSession(token: token, lastSeq: lastSeq)
    }

    // MARK: - Handshake

    func testShouldAnswerTheChallengeWithTheTokenAndItsHighWaterMark() {
        var session = makeSession(lastSeq: 4471)

        let outcomes = session.receive(.authChallenge(WsAuthChallenge(nonce: "abc", protocolVersion: 1)))

        XCTAssertEqual(
            outcomes,
            [
                .emit(.connectionState(.authenticating)),
                .send(.authResponse(WsAuthResponse(token: token, nonce: "abc", lastSeq: 4471))),
            ]
        )
        XCTAssertEqual(session.phase, .awaitingConnected)
    }

    func testShouldStartAwaitingTheChallengeBecauseTheServerSpeaksFirst() {
        // A client that sends auth_response unprompted is answering a challenge it has
        // not seen, and the server closes on it.
        XCTAssertEqual(makeSession().phase, .awaitingChallenge)
    }

    func testShouldRefuseAProtocolVersionItDoesNotUnderstand() {
        // A mobile app in the field will outlive several server deploys. Guessing at
        // frames from a version it does not know is worse than refusing them.
        var session = makeSession()

        let outcomes = session.receive(
            .authChallenge(WsAuthChallenge(nonce: "abc", protocolVersion: 7))
        )

        XCTAssertEqual(session.phase, .closed)
        XCTAssertTrue(outcomes.contains { outcome in
            if case .stop = outcome { return true }
            return false
        })
    }

    func testShouldBecomeReadyAndReportConnectedWhenThereIsNoGap() {
        var session = makeSession(lastSeq: 4488)
        _ = session.receive(.authChallenge(WsAuthChallenge(nonce: "n", protocolVersion: 1)))

        let outcomes = session.receive(.connected(connected(lastSeq: 4488)))

        XCTAssertEqual(outcomes, [.emit(.connectionState(.connected))])
        XCTAssertEqual(session.phase, .ready)
    }

    // MARK: - Gap detection

    func testShouldAskForTheMissingRangeWhenTheServerIsAheadOnReconnect() {
        var session = makeSession(lastSeq: 4471)
        _ = session.receive(.authChallenge(WsAuthChallenge(nonce: "n", protocolVersion: 1)))

        let outcomes = session.receive(.connected(connected(lastSeq: 4488)))

        XCTAssertEqual(
            outcomes,
            [
                .emit(.connectionState(.connected)),
                .send(.sync(WsSync(sinceSeq: 4471))),
            ]
        )
    }

    func testShouldUseSinceSeqAndNotTheHTTPCursorWhenRecoveringAGap() {
        // `sinceSeq` on the frame; `since` on the endpoint. Feeding one to the other
        // makes the client either replay everything or believe it is caught up.
        var session = makeSession(lastSeq: 100)
        _ = session.receive(.authChallenge(WsAuthChallenge(nonce: "n", protocolVersion: 1)))

        let outcomes = session.receive(.connected(connected(lastSeq: 140)))

        guard case .send(.sync(let sync)) = outcomes.last else {
            return XCTFail("expected a sync frame, got \(outcomes)")
        }
        XCTAssertEqual(sync.sinceSeq, 100)
    }

    func testShouldAskForTheRangeWhenALiveFrameSkipsASequence() {
        var session = ready(lastSeq: 10)

        let outcomes = session.receive(.chatMessage(chatMessage(seq: 14, messageSeq: 900)))

        XCTAssertEqual(outcomes, [.send(.sync(WsSync(sinceSeq: 10)))])
        XCTAssertEqual(
            session.lastSeq,
            10,
            """
            the mark must NOT jump the hole. Advancing it to 14 would make every frame \
            in the replay look already-seen, so the answer to our own question would be \
            discarded in full and nothing would ask again.
            """
        )
    }

    func testShouldDeliverEveryFrameInTheGapAfterALiveFrameRevealedIt() {
        // The end-to-end path the previous test only starts. This is the regression
        // that matters: ask for the gap, then actually receive what was asked for.
        var session = ready(lastSeq: 10)
        _ = session.receive(.chatMessage(chatMessage(seq: 14, messageSeq: 900)))

        let outcomes = session.receive(
            .syncResponse(
                WsSyncResponse(
                    fromSeq: 10,
                    toSeq: 14,
                    complete: true,
                    frames: [
                        .chatMessage(chatMessage(seq: 11, messageSeq: 897)),
                        .chatMessage(chatMessage(seq: 12, messageSeq: 898)),
                        .chatMessage(chatMessage(seq: 13, messageSeq: 899)),
                        .chatMessage(chatMessage(seq: 14, messageSeq: 900)),
                    ]
                )
            )
        )

        XCTAssertEqual(outcomes.count, 4, "all four, including the one that revealed the gap")
        XCTAssertEqual(session.lastSeq, 14)
    }

    func testShouldNotAskForAnythingWhenTheNextFrameIsContiguous() {
        var session = ready(lastSeq: 10)

        let outcomes = session.receive(.chatMessage(chatMessage(seq: 11, messageSeq: 900)))

        XCTAssertEqual(outcomes.count, 1)
        XCTAssertEqual(session.lastSeq, 11)
    }

    func testShouldIgnoreAFrameItHasAlreadySeen() {
        // The ordinary case on reconnect: the server replays from our mark and the
        // first frames back are ones we already hold. Emitting them again would
        // duplicate messages in the thread.
        var session = ready(lastSeq: 20)

        let outcomes = session.receive(.chatMessage(chatMessage(seq: 20, messageSeq: 900)))

        XCTAssertTrue(outcomes.isEmpty)
        XCTAssertEqual(session.lastSeq, 20)
    }

    // MARK: - Presence is the exception

    func testShouldNeverAdvanceTheHighWaterMarkOnAPresenceFrame() {
        // Numbering presence would force either a replay the rules forbid or a hole in
        // the sequence space — and holes are how gap detection works, so every
        // reconnect would look like data loss.
        var session = ready(lastSeq: 20)

        let outcomes = session.receive(.presence(presence()))

        XCTAssertEqual(session.lastSeq, 20)
        XCTAssertEqual(outcomes, [.emit(.presence(presence()))])
    }

    func testShouldNeverAskForASyncBecauseOfAPresenceFrame() {
        var session = ready(lastSeq: 20)

        let outcomes = session.receive(.presence(presence()))

        XCTAssertFalse(outcomes.contains { outcome in
            if case .send = outcome { return true }
            return false
        })
    }

    // MARK: - Replay

    func testShouldEmitEveryReplayedFrameInOrderAndAdvanceToTheEndOfTheRange() {
        var session = ready(lastSeq: 4471)

        let outcomes = session.receive(
            .syncResponse(
                WsSyncResponse(
                    fromSeq: 4471,
                    toSeq: 4488,
                    complete: true,
                    frames: [
                        .deliveryConfirmation(deliveryConfirmation(seq: 4487, messageSeq: 1283)),
                        .chatMessage(chatMessage(seq: 4488, messageSeq: 1284)),
                    ]
                )
            )
        )

        XCTAssertEqual(outcomes.count, 2)
        XCTAssertEqual(session.lastSeq, 4488)
        guard case .emit(.deliveryConfirmation) = outcomes[0] else {
            return XCTFail("expected the confirmation first, got \(outcomes[0])")
        }
        guard case .emit(.message) = outcomes[1] else {
            return XCTFail("expected the message second, got \(outcomes[1])")
        }
    }

    func testShouldDemandAnHTTPSyncWhenTheGapFellOffTheReplayBuffer() {
        // `complete: false` means the client's gap is older than the server remembers.
        // A client that ignores it silently misses everything that aged out — which is
        // exactly the phone that spent a weekend in a drawer.
        var session = ready(lastSeq: 4102)

        let outcomes = session.receive(
            .syncResponse(
                WsSyncResponse(fromSeq: 4102, toSeq: 4488, complete: false, frames: [])
            )
        )

        XCTAssertEqual(outcomes, [.emit(.needsHTTPSync(fromSeq: 4102))])
    }

    func testShouldAskAgainWhenAPageWasTruncatedRatherThanFallingBackToHTTP() {
        // The service is explicit: truncation by `limit` is NOT incompleteness. Nothing
        // was lost, so the client re-syncs from `toSeq`. Treating a capped page as
        // incomplete would send it to GET /sync on every large gap, and the two ends
        // would disagree about what "complete" means.
        var session = makeSession(lastSeq: 100)
        _ = session.receive(.authChallenge(WsAuthChallenge(nonce: "n", protocolVersion: 1)))
        _ = session.receive(.connected(connected(lastSeq: 500)))

        // A page CARRYING FRAMES, deliberately. An empty one is the only shape under
        // which a progress guard read after the replay loop would still look correct,
        // so an empty-page test cannot catch that mistake.
        let outcomes = session.receive(
            .syncResponse(
                WsSyncResponse(
                    fromSeq: 100,
                    toSeq: 300,
                    complete: true,
                    frames: [
                        .chatMessage(chatMessage(seq: 299, messageSeq: 800)),
                        .chatMessage(chatMessage(seq: 300, messageSeq: 801)),
                    ]
                )
            )
        )

        XCTAssertEqual(outcomes.last, .send(.sync(WsSync(sinceSeq: 300))))
        XCTAssertFalse(
            outcomes.contains { outcome in
                if case .emit(.needsHTTPSync) = outcome { return true }
                return false
            },
            "a truncated page is not a lost one"
        )
    }

    func testShouldStopAskingOnceATruncatedSequenceCatchesUpWithTheServer() {
        var session = makeSession(lastSeq: 100)
        _ = session.receive(.authChallenge(WsAuthChallenge(nonce: "n", protocolVersion: 1)))
        _ = session.receive(.connected(connected(lastSeq: 300)))

        let outcomes = session.receive(
            .syncResponse(WsSyncResponse(fromSeq: 100, toSeq: 300, complete: true, frames: []))
        )

        XCTAssertTrue(outcomes.isEmpty)
    }

    func testShouldNotLoopWhenAPageMovesTheMarkNowhere() {
        // A page that returned nothing and advanced nothing would otherwise ask for
        // the same range forever.
        var session = makeSession(lastSeq: 300)
        _ = session.receive(.authChallenge(WsAuthChallenge(nonce: "n", protocolVersion: 1)))
        _ = session.receive(.connected(connected(lastSeq: 500)))

        let outcomes = session.receive(
            .syncResponse(WsSyncResponse(fromSeq: 300, toSeq: 300, complete: true, frames: []))
        )

        XCTAssertFalse(outcomes.contains { outcome in
            if case .send = outcome { return true }
            return false
        })
    }

    func testShouldStillAdvanceToTheEndOfAnIncompleteRangeSoItDoesNotAskAgainForever() {
        var session = ready(lastSeq: 4102)

        _ = session.receive(
            .syncResponse(
                WsSyncResponse(fromSeq: 4102, toSeq: 4488, complete: false, frames: [])
            )
        )

        XCTAssertEqual(
            session.lastSeq,
            4488,
            "the frames below toSeq are gone from the buffer; re-asking would loop"
        )
    }

    func testShouldNotAskForAnotherSyncBecauseOfAHoleInsideTheReplayItself() {
        // Re-asking on a hole inside the answer to the previous ask is an infinite loop.
        var session = ready(lastSeq: 10)

        let outcomes = session.receive(
            .syncResponse(
                WsSyncResponse(
                    fromSeq: 10,
                    toSeq: 40,
                    complete: true,
                    frames: [.chatMessage(chatMessage(seq: 40, messageSeq: 900))]
                )
            )
        )

        XCTAssertFalse(outcomes.contains { outcome in
            if case .send = outcome { return true }
            return false
        })
    }

    // MARK: - Errors

    func testShouldStayUpOnANonFatalError() {
        var session = ready(lastSeq: 1)

        let outcomes = session.receive(
            .error(
                WsError(
                    error: ApiError(code: .rateLimited, message: "Slow down.", retryable: true),
                    fatal: false
                )
            )
        )

        XCTAssertEqual(session.phase, .ready)
        XCTAssertEqual(outcomes.count, 1)
    }

    func testShouldStopReconnectingOnAFatalAuthError() {
        // `fatal: true` means re-pair, not loop against a wall.
        var session = ready(lastSeq: 1)

        let outcomes = session.receive(
            .error(
                WsError(
                    error: ApiError(
                        code: .unauthorized, message: "Token expired mid-session.", retryable: false),
                    fatal: true
                )
            )
        )

        XCTAssertEqual(session.phase, .closed)
        XCTAssertTrue(outcomes.contains(.emit(.connectionState(.unauthenticated))))
        XCTAssertTrue(outcomes.contains { outcome in
            if case .stop = outcome { return true }
            return false
        })
    }

    // MARK: - Reconciliation

    func testShouldReconcileADeliveryConfirmationUsingTheMessageSequence() {
        var session = ready(lastSeq: 4486)

        let outcomes = session.receive(
            .deliveryConfirmation(deliveryConfirmation(seq: 4487, messageSeq: 1283))
        )

        guard case .emit(.deliveryConfirmation(let confirmation)) = outcomes.first else {
            return XCTFail("expected a confirmation, got \(outcomes)")
        }
        XCTAssertEqual(confirmation.seq, 1283, "the reconciled row is positioned in its thread")
        XCTAssertEqual(session.lastSeq, 4487, "the socket is positioned in the frame stream")
    }

    // MARK: - Builders

    private func ready(lastSeq: Int) -> SocketSession {
        var session = makeSession(lastSeq: lastSeq)
        _ = session.receive(.authChallenge(WsAuthChallenge(nonce: "n", protocolVersion: 1)))
        _ = session.receive(.connected(connected(lastSeq: lastSeq)))
        return session
    }

    private func connected(lastSeq: Int) -> WsConnected {
        WsConnected(
            lastSeq: lastSeq,
            serverTime: instant("2026-08-09T07:00:05.000Z"),
            protocolVersion: 1,
            principal: Principal(
                id: "syl:principal:0198f100-0000-7000-8000-000000000001",
                name: "The Commander"
            )
        )
    }

    private func chatMessage(seq: Int, messageSeq: Int) -> WsServerChatMessage {
        WsServerChatMessage(
            seq: seq,
            ts: instant("2026-08-09T07:00:03.140Z"),
            message: Message(
                id: "syl:message:0198f2c0-0002-7000-8000-00000000b002",
                conversationId: SylIDs.interactiveConversation,
                clientId: nil,
                role: .assistant,
                text: "Done.",
                createdAt: instant("2026-08-09T07:00:03.114Z"),
                seq: messageSeq
            )
        )
    }

    private func deliveryConfirmation(seq: Int, messageSeq: Int) -> WsDeliveryConfirmation {
        WsDeliveryConfirmation(
            seq: seq,
            ts: instant("2026-08-09T06:59:48.260Z"),
            clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
            serverId: "syl:message:0198f2c0-0001-7000-8000-00000000b001",
            conversationId: SylIDs.interactiveConversation,
            messageSeq: messageSeq,
            acceptedAt: instant("2026-08-09T06:59:48.220Z")
        )
    }

    private func presence() -> WsPresence {
        WsPresence(
            state: .speaking,
            intensity: 0.4,
            since: instant("2026-08-09T07:00:03.114Z"),
            ttlMs: 4000
        )
    }

    private func instant(_ text: String) -> Date {
        // Force-unwrapping a literal the contract itself uses; a failure here is a
        // broken test fixture, not a runtime condition.
        try! Instant.parse(text)
    }
}
