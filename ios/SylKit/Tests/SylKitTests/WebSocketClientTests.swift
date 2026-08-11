import XCTest

@testable import SylKit

/// The client driving the protocol over a stubbed socket.
///
/// `URLSessionWebSocketTask` cannot be intercepted the way a data task can —
/// `MockURLProtocol` never sees a WebSocket upgrade — which is why
/// `WebSocketConnecting` exists as a seam. Without it, none of this would be testable
/// except against a live server.
final class WebSocketClientTests: XCTestCase {
    private let token = "syl_pat_9f2c41d8b7e04a6f8c1d3e5a7b9c0d2e"

    // MARK: - Handshake and gap recovery

    func testShouldAnswerTheChallengeCarryingItsHighWaterMark() async throws {
        let socket = FakeSocket()
        let client = makeClient(socket: socket, lastSeq: 4471)

        await client.start()
        await socket.push(challenge())
        let sent = try await socket.waitForSend(count: 1)

        let frame = try decodeClientFrame(sent[0])
        guard case .authResponse(let response) = frame else {
            return XCTFail("expected auth_response, got \(frame)")
        }
        XCTAssertEqual(response.token, token)
        XCTAssertEqual(response.lastSeq, 4471)
        await client.stop()
    }

    func testShouldNotMissTheChallengeWhenTheServerSpeaksBeforeAnyoneIsListening() async throws {
        // The server sends `auth_challenge` the instant the connection opens. A client
        // built on an event-subscription API that awaits `open` and only then attaches
        // a listener misses it entirely — and a lost first frame looks exactly like a
        // server that never sent one, so the hour goes into reading the server's code.
        //
        // This client pulls: `URLSessionWebSocketTask` buffers until `receive()` asks.
        // Queueing the challenge before the client even starts proves the ordering.
        let socket = FakeSocket()
        await socket.push(challenge())
        await socket.push(connected(lastSeq: 7))
        let client = makeClient(socket: socket, lastSeq: 7)

        await client.start()

        try await eventually { await client.connectionState == .connected }
        await client.stop()
    }

    func testShouldAskForTheGapWhenTheServerIsAhead() async throws {
        let socket = FakeSocket()
        let client = makeClient(socket: socket, lastSeq: 4471)

        await client.start()
        await socket.push(challenge())
        await socket.push(connected(lastSeq: 4488))
        let sent = try await socket.waitForSend(count: 2)

        guard case .sync(let sync) = try decodeClientFrame(sent[1]) else {
            return XCTFail("expected a sync frame, got \(sent[1])")
        }
        XCTAssertEqual(sync.sinceSeq, 4471)
        await client.stop()
    }

    func testShouldReportConnectedOnceTheHandshakeCompletes() async throws {
        let socket = FakeSocket()
        let client = makeClient(socket: socket, lastSeq: 4488)

        await client.start()
        await socket.push(challenge())
        await socket.push(connected(lastSeq: 4488))
        try await eventually { await client.connectionState == .connected }

        await client.stop()
    }

    // MARK: - Events

    func testShouldPublishAMessageItReceives() async throws {
        let socket = FakeSocket()
        let client = makeClient(socket: socket, lastSeq: 4487)
        let events = await client.events()

        await client.start()
        await socket.push(challenge())
        await socket.push(connected(lastSeq: 4487))
        await socket.push(serverChatMessage(seq: 4488, messageSeq: 1284))

        let message = try await firstMessage(in: events)
        XCTAssertEqual(message.seq, 1284, "the message's position in its thread")
        let mark = await client.lastSeq
        XCTAssertEqual(mark, 4488, "the client's position in the frame stream")
        await client.stop()
    }

    func testShouldNotAdvanceTheHighWaterMarkOnPresence() async throws {
        let socket = FakeSocket()
        let client = makeClient(socket: socket, lastSeq: 4488)

        await client.start()
        await socket.push(challenge())
        await socket.push(connected(lastSeq: 4488))
        await socket.push(presenceFrame(state: "thinking", ttlMs: 15_000))
        try await eventually { await client.presenceState() == .thinking }

        let mark = await client.lastSeq
        XCTAssertEqual(mark, 4488)
        await client.stop()
    }

    func testShouldExposePresenceAsAbsentAgainOnceTheTTLAndGraceHavePassed() async throws {
        let clock = MutableClock(start: try Instant.parse("2026-08-09T07:00:03.114Z"))
        let socket = FakeSocket()
        let client = makeClient(socket: socket, lastSeq: 1, clock: clock)

        await client.start()
        await socket.push(challenge())
        await socket.push(connected(lastSeq: 1))
        await socket.push(presenceFrame(state: "speaking", ttlMs: 4000))
        try await eventually { await client.presenceState() == .speaking }

        clock.advance(by: 40)

        let state = await client.presenceState()
        XCTAssertEqual(state, .absent, "the failure mode has to be quiet, not stuck")
        await client.stop()
    }

    // MARK: - Sending

    func testShouldRefuseToSendBeforeTheHandshakeCompletes() async throws {
        let socket = FakeSocket()
        let client = makeClient(socket: socket)

        await client.start()

        do {
            try await client.send(
                text: "hello",
                conversationId: SylIDs.interactiveConversation,
                clientId: "c1",
                idempotencyKey: "k1"
            )
            XCTFail("expected NotConnected so the caller falls back to HTTP")
        } catch is WebSocketClient.NotConnected {
            // The caller sends over HTTP instead, and reconciles identically.
        }
        await client.stop()
    }

    func testShouldSendAChatFrameCarryingBothAClientIdAndAnIdempotencyKey() async throws {
        // They are not the same thing. `clientId` identifies *this message* for
        // reconciliation; `idempotencyKey` identifies *this attempt* so a retried send
        // is not a second message.
        let socket = FakeSocket()
        let client = makeClient(socket: socket, lastSeq: 1)

        await client.start()
        await socket.push(challenge())
        await socket.push(connected(lastSeq: 1))
        _ = try await socket.waitForSend(count: 1)

        try await client.send(
            text: "Remind me to call the pharmacy at 4 today.",
            conversationId: SylIDs.interactiveConversation,
            clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
            idempotencyKey: "9f2c41d8-b7e0-4a6f-8c1d-3e5a7b9c0d2e"
        )
        let sent = try await socket.waitForSend(count: 2)

        guard case .chatMessage(let frame) = try decodeClientFrame(sent[1]) else {
            return XCTFail("expected a chat_message, got \(sent[1])")
        }
        XCTAssertEqual(frame.clientId, "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44")
        XCTAssertEqual(frame.idempotencyKey, "9f2c41d8-b7e0-4a6f-8c1d-3e5a7b9c0d2e")
        await client.stop()
    }

    // MARK: - Reconnection

    func testShouldReconnectAfterTheSocketDropsAndKeepItsHighWaterMark() async throws {
        let first = FakeSocket()
        let second = FakeSocket()
        let connector = FakeConnector(sockets: [first, second])
        let client = makeClient(connector: connector, lastSeq: 4471)

        await client.start()
        await first.push(challenge())
        await first.push(connected(lastSeq: 4472))
        await first.push(serverChatMessage(seq: 4472, messageSeq: 1000))
        try await eventually { await client.lastSeq == 4472 }

        await first.fail()

        await second.push(challenge())
        let sent = try await second.waitForSend(count: 1)

        guard case .authResponse(let response) = try decodeClientFrame(sent[0]) else {
            return XCTFail("expected auth_response on the new socket")
        }
        XCTAssertEqual(
            response.lastSeq,
            4472,
            "the mark surviving the drop is what makes a tunnel a non-event"
        )
        await client.stop()
    }

    func testShouldKeepReceivingAfterTheServerRestartsUnderneathTheReconnect() async throws {
        // `syl-47j`, driven through the client the app actually runs rather than the
        // state machine underneath it. `SocketSessionTests` proves the rule; this
        // proves the rule is reached — the client builds a fresh `SocketSession` on
        // every reconnect, so a mark carried forward without the run it belongs to
        // would be reinterpreted against the new stream and nothing would say so.
        let first = FakeSocket()
        let second = FakeSocket()
        let connector = FakeConnector(sockets: [first, second])
        let client = makeClient(connector: connector, lastSeq: 4471, serverEpoch: "boot-a")
        let events = await client.events()

        await client.start()
        await first.push(challenge())
        await first.push(connected(lastSeq: 4471, serverEpoch: "boot-a"))
        await first.push(serverChatMessage(seq: 4472, messageSeq: 1000))
        try await eventually { await client.lastSeq == 4472 }

        // The Mac reboots. The socket drops, the client reconnects on its own, and the
        // service on the other end has forgotten every frame it ever numbered.
        await first.fail()
        await second.push(challenge())
        await second.push(connected(lastSeq: 0, serverEpoch: "boot-b"))
        await second.push(serverChatMessage(seq: 1, messageSeq: 1001))

        // Without the reset this hangs: `1 > 4472` is false, the frame is filed as
        // already seen, and the socket stays green and silent forever. The stream also
        // carries the pre-restart message, so this waits for the one after it rather
        // than taking whatever arrives first.
        let message = try await message(seq: 1001, in: events)
        XCTAssertEqual(message.seq, 1001)

        let mark = await client.lastSeq
        XCTAssertEqual(mark, 1, "the mark now belongs to the run that is actually running")
        let epoch = await client.serverEpoch
        XCTAssertEqual(epoch, "boot-b")
        await client.stop()
    }

    func testShouldCarryTheServerRunIntoTheSessionItBuildsOnReconnect() async throws {
        // The ordinary reconnect, and the other half of the same wiring. The epoch has
        // to reach the new `SocketSession` or every reconnect looks like a restart and
        // replays the whole buffer.
        let first = FakeSocket()
        let second = FakeSocket()
        let connector = FakeConnector(sockets: [first, second])
        let client = makeClient(connector: connector, lastSeq: 4471, serverEpoch: "boot-a")

        await client.start()
        await first.push(challenge())
        await first.push(connected(lastSeq: 4472, serverEpoch: "boot-a"))
        await first.push(serverChatMessage(seq: 4472, messageSeq: 1000))
        try await eventually { await client.lastSeq == 4472 }

        await first.fail()
        await second.push(challenge())
        await second.push(connected(lastSeq: 4472, serverEpoch: "boot-a"))
        _ = try await second.waitForSend(count: 1)

        // Still 4472, and no sync asked for: same run, no gap, nothing to replay.
        try await eventually { await client.connectionState == .connected }
        let mark = await client.lastSeq
        XCTAssertEqual(mark, 4472, "the same run's mark must survive an ordinary reconnect")
        await client.stop()
    }

    func testShouldStopReconnectingAfterAFatalError() async throws {
        let first = FakeSocket()
        let second = FakeSocket()
        let connector = FakeConnector(sockets: [first, second])
        let client = makeClient(connector: connector, lastSeq: 1)

        await client.start()
        await first.push(challenge())
        await first.push(connected(lastSeq: 1))
        await first.push(fatalAuthError())
        try await eventually { await connector.connectionCount == 1 }

        // Give the run loop room to do the wrong thing if it is going to.
        try await Task.sleep(nanoseconds: 50_000_000)

        let count = await connector.connectionCount
        XCTAssertEqual(count, 1, "fatal means re-pair, not loop against a wall")
        await client.stop()
    }

    func testShouldSurviveAFrameItCannotDecodeRatherThanDroppingTheSocket() async throws {
        // The service may add a frame type. A client that closes on one is a client
        // that breaks on a server deploy.
        let socket = FakeSocket()
        let connector = FakeConnector(sockets: [socket])
        let client = makeClient(connector: connector, lastSeq: 1)

        await client.start()
        await socket.push(challenge())
        await socket.push(connected(lastSeq: 1))
        await socket.push(#"{"type":"aurora","shimmer":true}"#)
        await socket.push(serverChatMessage(seq: 2, messageSeq: 1))

        try await eventually { await client.lastSeq == 2 }
        let count = await connector.connectionCount
        XCTAssertEqual(count, 1, "the socket stayed up")
        await client.stop()
    }

    // MARK: - The address it opens

    func testShouldOpenTheSocketOnWsRatherThanTheBaseURLScheme() async throws {
        // `syl-w40`. The client is configured with the same `http` base the REST API
        // uses; what it must hand the connector is `ws`. Handing `URLSession` the
        // `http` one does not fail the connection — it aborts the process.
        let socket = FakeSocket()
        let connector = FakeConnector(sockets: [socket])
        let client = makeClient(connector: connector)

        await client.start()
        await socket.push(challenge())
        await socket.push(connected(lastSeq: 0))
        try await eventually { await client.connectionState == .connected }

        let urls = await connector.urls
        XCTAssertEqual(urls.map(\.absoluteString), ["ws://syl.test/api/v1/ws"])
        await client.stop()
    }

    func testShouldReportAServerAddressThatCannotCarryASocketInsteadOfOpeningOne() async throws {
        // Nothing retried, nothing opened, and a reason the app can show. The
        // alternative — reaching `URLSession` with it — is a dead process.
        let connector = FakeConnector(sockets: [FakeSocket()])
        let client = makeClient(connector: connector, baseURL: "file:///tmp/api/v1")
        let events = await client.events()

        await client.start()

        var reported: ApiError?
        for await event in events {
            if case .error(let error, let fatal) = event {
                XCTAssertTrue(fatal, "no retry can fix an address")
                reported = error
                break
            }
        }
        XCTAssertEqual(reported?.code, .validationFailed)
        XCTAssertTrue(reported?.message.contains("file") == true, "\(reported as Any)")

        let attempts = await connector.urls
        XCTAssertEqual(attempts, [], "the socket must not be opened at all")
        let state = await client.connectionState
        XCTAssertEqual(state, .offline, "the app stays usable over HTTP")
        await client.stop()
    }

    // MARK: - The wait between attempts

    /// **The reconnect the app actually ships**, default arguments and all.
    ///
    /// Every other case here injects `sleeper: { _ in }`, which is right — the backoff
    /// schedule is arithmetic and waiting it out would make the suite slower than the
    /// thing it tests — and it meant the default sleeper had never run. It aborted the
    /// process the first time it did, on the first real reconnect: an async closure
    /// written as a *default argument* is built at the call site, in the caller's
    /// module, and calling it from inside the actor's run loop corrupted the task
    /// allocator ("freed pointer was not the last allocation", SIGABRT). Built inside
    /// `init` instead, from the same source text, it is fine.
    ///
    /// It is the same shape of bug as `syl-w40` itself: a default that every test
    /// substituted away, so the thing that shipped was the one thing never executed.
    func testShouldSurviveTheReconnectWaitItShipsWith() async throws {
        let first = FakeSocket()
        let connector = FakeConnector(sockets: [first, FakeSocket()])
        let client = WebSocketClient(
            configuration: ServerConfiguration(baseURL: URL(string: "http://syl.test/api/v1")!),
            connector: connector,
            tokenProvider: StaticTokenProvider(token),
            // Zero delay, so the wait the app ships is executed rather than waited on.
            reconnectPolicy: RetryPolicy(maxAttempts: .max, baseDelay: 0, maxDelay: 0),
            keepaliveInterval: 0
            // No `sleeper:`, and that is the entire point of this case.
        )

        await client.start()
        await first.push(challenge())
        await first.push(connected(lastSeq: 0))
        try await eventually { await client.connectionState == .connected }

        await first.fail()

        try await eventually { await connector.connectionCount == 2 }
        await client.stop()
    }

    // MARK: - Keepalive bookkeeping

    func testShouldTolerateOneMissedPongAndGiveUpAfterTwo() {
        var keepalive = Keepalive(interval: 30, missedPongsBeforeDead: 2)

        XCTAssertTrue(keepalive.pingSent())
        XCTAssertTrue(keepalive.pingSent())
        XCTAssertFalse(keepalive.pingSent(), "two missed pongs is a dead socket")
    }

    func testShouldForgetOutstandingPingsWhenAPongArrives() {
        var keepalive = Keepalive(interval: 30, missedPongsBeforeDead: 2)
        _ = keepalive.pingSent()

        keepalive.pongReceived()

        XCTAssertEqual(keepalive.outstandingPings, 0)
    }

    func testShouldStartEvenOnAFreshConnection() {
        var keepalive = Keepalive()
        _ = keepalive.pingSent()

        keepalive.reset()

        XCTAssertEqual(keepalive.outstandingPings, 0)
    }

    // MARK: - Reconnect policy

    func testShouldCapReconnectBackoffAtThirtySecondsAndNeverGiveUp() {
        // A home Mac that is rebooting will be back; a client that stopped trying would
        // need the Commander to notice and relaunch the app.
        let policy = RetryPolicy.socketReconnect

        XCTAssertEqual(policy.maxDelay, 30)
        XCTAssertEqual(policy.delay(beforeAttempt: 20), 30, accuracy: 0.0001)
        XCTAssertTrue(policy.shouldRetry(after: .transport(code: .timedOut, description: ""), attempt: 500))
    }

    // MARK: - Harness

    private func makeClient(
        socket: FakeSocket? = nil,
        connector: FakeConnector? = nil,
        baseURL: String = "http://syl.test/api/v1",
        lastSeq: Int = 0,
        serverEpoch: String? = nil,
        clock: MutableClock? = nil
    ) -> WebSocketClient {
        let connector = connector ?? FakeConnector(sockets: [socket ?? FakeSocket()])
        let clock = clock ?? MutableClock(start: Date())
        return WebSocketClient(
            configuration: ServerConfiguration(baseURL: URL(string: baseURL)!),
            connector: connector,
            tokenProvider: StaticTokenProvider(token),
            lastSeq: lastSeq,
            serverEpoch: serverEpoch,
            reconnectPolicy: RetryPolicy(maxAttempts: .max, baseDelay: 0, maxDelay: 0),
            // Keepalive off: the ping loop is bookkeeping, tested directly above, and a
            // zero-delay timer here would spin the test process.
            keepaliveInterval: 0,
            sleeper: { _ in },
            randomSampler: { 1 },
            now: { clock.now }
        )
    }

    private func decodeClientFrame(_ text: String) throws -> WsClientFrame {
        try SylJSON.decoder().decode(WsClientFrame.self, from: Data(text.utf8))
    }

    private func firstMessage(in events: AsyncStream<SocketEvent>) async throws -> Message {
        for await event in events {
            if case .message(let message) = event { return message }
        }
        throw Timeout()
    }

    /// The message with a given conversation sequence, skipping any before it.
    ///
    /// A test that spans a reconnect sees everything from both connections, so
    /// "the first message" is the wrong question — it answers about the session that
    /// already ended.
    ///
    /// **Bounded, unlike `firstMessage`.** The stream stays open for the life of the
    /// client, so a message that never arrives is a test that never finishes rather
    /// than a test that fails — and a regression here is precisely "the message never
    /// arrives". Verified by reverting the fix and watching this report a timeout
    /// instead of hanging the suite.
    private func message(
        seq: Int,
        in events: AsyncStream<SocketEvent>,
        timeout: TimeInterval = 2
    ) async throws -> Message {
        let found = await withTaskGroup(of: Message?.self) { group in
            group.addTask {
                for await event in events {
                    if case .message(let message) = event, message.seq == seq { return message }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        guard let found else { throw Timeout() }
        return found
    }

    /// Polls a condition rather than sleeping a guessed interval. The run loop is a
    /// detached task, so there is no completion to await.
    private func eventually(
        timeout: TimeInterval = 2,
        _ condition: @Sendable () async -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        throw Timeout()
    }

    private struct Timeout: Error {}

    // MARK: - Frames

    private func challenge() -> String {
        #"{"type":"auth_challenge","nonce":"b7e04a6f8c1d3e5a","protocolVersion":1}"#
    }

    /// Built as raw JSON on purpose, so these cases exercise the decoder too — a
    /// `serverEpoch` the model failed to read would look exactly like a service that
    /// does not send one, which is the failure mode with no symptom.
    private func connected(lastSeq: Int, serverEpoch: String? = nil) -> String {
        let epoch = serverEpoch.map { "\"serverEpoch\":\"\($0)\"," } ?? ""
        return """
        {"type":"connected","lastSeq":\(lastSeq),"serverTime":"2026-08-09T07:00:05.000Z",
         "protocolVersion":1,\(epoch)
         "principal":{"id":"syl:principal:0198f100-0000-7000-8000-000000000001",
         "name":"The Commander"}}
        """
    }

    private func serverChatMessage(seq: Int, messageSeq: Int) -> String {
        """
        {"type":"chat_message","seq":\(seq),"ts":"2026-08-09T07:00:03.140Z",
         "message":{"id":"syl:message:0198f2c0-0002-7000-8000-00000000b002",
         "conversationId":"\(SylIDs.interactiveConversation)","clientId":null,
         "role":"assistant","text":"Done.","createdAt":"2026-08-09T07:00:03.114Z",
         "seq":\(messageSeq)}}
        """
    }

    private func presenceFrame(state: String, ttlMs: Int) -> String {
        """
        {"type":"presence","state":"\(state)","intensity":0.5,
         "since":"2026-08-09T07:00:03.114Z","ttl_ms":\(ttlMs)}
        """
    }

    private func fatalAuthError() -> String {
        """
        {"type":"error","error":{"code":"UNAUTHORIZED","message":"Token expired mid-session.",
         "retryable":false,"details":null,"retryAfterMs":null},"fatal":true}
        """
    }
}

// MARK: - Test doubles

/// A clock a test can move. Presence expiry is defined in seconds; waiting them out
/// would make the suite take longer than the thing it is testing.
final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(start: Date) {
        self.current = start
    }

    var now: Date { lock.withLock { current } }

    func advance(by seconds: TimeInterval) {
        lock.withLock { current = current.addingTimeInterval(seconds) }
    }
}

/// A socket the test drives: frames go in with `push`, and what the client wrote comes
/// out of `sent`.
actor FakeSocket: WebSocketConnection {
    struct Closed: Error {}

    private var inbound: [String] = []
    private var waiter: CheckedContinuation<String, Error>?
    private var closed = false
    private(set) var sent: [String] = []

    func push(_ text: String) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: text)
        } else {
            inbound.append(text)
        }
    }

    /// Drop the socket the way a tunnel does.
    func fail() {
        closed = true
        if let waiter {
            self.waiter = nil
            waiter.resume(throwing: Closed())
        }
    }

    nonisolated func send(_ text: String) async throws {
        await record(text)
    }

    private func record(_ text: String) {
        sent.append(text)
    }

    nonisolated func receive() async throws -> String {
        try await next()
    }

    private func next() async throws -> String {
        if !inbound.isEmpty { return inbound.removeFirst() }
        if closed { throw Closed() }
        return try await withCheckedThrowingContinuation { continuation in
            self.waiter = continuation
        }
    }

    nonisolated func close() {
        Task { await self.fail() }
    }

    /// Waits until the client has written `count` frames.
    func waitForSend(count: Int, timeout: TimeInterval = 2) async throws -> [String] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if sent.count >= count { return sent }
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        throw Closed()
    }
}

/// Hands out prepared sockets in order, and counts how many times the client asked.
actor FakeConnector: WebSocketConnecting {
    struct Exhausted: Error {}

    private var sockets: [FakeSocket]
    private(set) var connectionCount = 0
    /// Every URL the client asked for, in order. Recorded because the scheme it builds
    /// is not cosmetic: an `http` one aborts the process at `URLSession` (`syl-w40`).
    private(set) var urls: [URL] = []

    init(sockets: [FakeSocket]) {
        self.sockets = sockets
    }

    nonisolated func connect(to url: URL) async throws -> any WebSocketConnection {
        try await take(url)
    }

    private func take(_ url: URL) throws -> any WebSocketConnection {
        urls.append(url)
        guard !sockets.isEmpty else { throw Exhausted() }
        connectionCount += 1
        return sockets.removeFirst()
    }
}
