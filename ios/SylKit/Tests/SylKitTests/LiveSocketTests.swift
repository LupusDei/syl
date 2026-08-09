import Foundation
import XCTest

@testable import SylKit

/// Syl's coordinates, from the environment the harness sets.
///
/// Shared by `LiveServerTests` (HTTP) and `LiveSocketTests` (the socket), because both
/// halves must skip on exactly the same condition. `backend/tests/integration/ios-live-server.test.ts`
/// boots a throwaway service, pairs a device and fills these in; a human can do it by
/// hand against any running Syl.
struct LiveSyl {
    let url: URL
    let token: String

    /// Throws `XCTSkip` when this is somebody's machine rather than the harness.
    static func fromEnvironment() throws -> LiveSyl {
        let environment = ProcessInfo.processInfo.environment
        guard let raw = environment["SYL_LIVE_URL"], let url = URL(string: raw) else {
            throw XCTSkip("set SYL_LIVE_URL and SYL_LIVE_TOKEN to run against a real Syl")
        }
        guard let token = environment["SYL_LIVE_TOKEN"], !token.isEmpty else {
            throw XCTSkip("set SYL_LIVE_TOKEN to a bearer token from POST /auth/pair")
        }
        return LiveSyl(url: url, token: token)
    }
}

/// **The real socket, over the real transport, against a real backend.**
///
/// This is the one place `URLSessionWebSocketConnector` runs. Every other socket test
/// in the package injects a fake `WebSocketConnecting` — which is right, because the
/// protocol is a state machine and a state machine deserves tests that take
/// milliseconds — but it meant the shipping connector had never once been executed.
/// It crashed the app on its first real connect (`syl-w40`: an `http` socket URL, an
/// `NSException` no Swift `catch` can see, SIGABRT), and 1870 green tests had nothing
/// to say about it.
///
/// So what belongs here is only what a substitute cannot answer: does a socket
/// actually open, does the handshake actually complete against the server's own
/// implementation, do frames actually arrive, and does a genuinely broken transport
/// actually come back.
final class LiveSocketTests: XCTestCase {
    private func makeClient(
        lastSeq: Int = 0,
        serverEpoch: String? = nil,
        connector: any WebSocketConnecting = URLSessionWebSocketConnector()
    ) throws -> WebSocketClient {
        let live = try LiveSyl.fromEnvironment()
        return WebSocketClient(
            configuration: ServerConfiguration(baseURL: live.url),
            connector: connector,
            tokenProvider: StaticTokenProvider(live.token),
            lastSeq: lastSeq,
            serverEpoch: serverEpoch,
            // Reconnects immediately: the backoff schedule is arithmetic and is tested
            // as arithmetic. What is untested anywhere else is whether a dropped socket
            // comes back over a real transport at all.
            reconnectPolicy: RetryPolicy(maxAttempts: .max, baseDelay: 0, maxDelay: 0),
            // The keepalive would not fire inside a test this short anyway; off, so a
            // failure here is never about a timer.
            keepaliveInterval: 0
        )
    }

    // MARK: - The handshake

    func testShouldOpenARealSocketAndCompleteTheHandshake() async throws {
        let client = try makeClient()
        let log = EventLog()
        let drain = await log.drain(await client.events())
        defer { drain.cancel() }

        await client.start()

        try await eventually("the socket never reached connected", log) {
            await client.connectionState == .connected
        }

        // The server speaks first and the client answers: `authenticating` is proof
        // the challenge arrived and was answered, not that a TCP connection opened.
        let states = await log.states
        XCTAssertTrue(states.contains(.authenticating), "no auth challenge was answered; saw \(states)")
        XCTAssertTrue(states.contains(.connected), "saw \(states)")
        let errors = await log.errors
        XCTAssertEqual(errors.map(\.code), [], "the socket reported: \(errors)")

        // `serverEpoch` comes off the wire in `connected`, and everything about
        // carrying a mark across a reconnect depends on it being there.
        let epoch = await client.serverEpoch
        XCTAssertNotNil(epoch, "the service did not name its run in `connected`")

        await client.stop()
    }

    // MARK: - Frames, both directions

    func testShouldSendAMessageOverTheSocketAndReceiveTheServersFramesBack() async throws {
        let client = try makeClient()
        let log = EventLog()
        let drain = await log.drain(await client.events())
        defer { drain.cancel() }

        await client.start()
        try await eventually("never connected", log) { await client.connectionState == .connected }

        let clientId = "syl:message:\(UUID().uuidString.lowercased())"
        let text = "Live check from SylKit over the real socket."
        try await client.send(
            text: text,
            conversationId: SylIDs.interactiveConversation,
            clientId: clientId,
            idempotencyKey: IdempotencyKey.generate()
        )

        // The confirmation reconciles the optimistic row; the chat_message is the
        // Commander's own message coming back numbered. Both are broadcast, and a
        // client that got one but not the other would show a message that never
        // settles.
        try await eventually("no delivery confirmation for \(clientId)", log) {
            await log.confirmations.contains { $0.clientId == clientId }
        }
        try await eventually("the message never came back on the frame stream", log) {
            await log.messages.contains { $0.clientId == clientId }
        }

        let confirmations = await log.confirmations
        let confirmation = try XCTUnwrap(confirmations.first { $0.clientId == clientId })
        XCTAssertTrue(SylIDs.isWellFormed(confirmation.serverId))
        XCTAssertTrue(SylIDs.areEqual(confirmation.conversationId, SylIDs.interactiveConversation))
        let received = await log.messages
        let message = try XCTUnwrap(received.first { $0.clientId == clientId })
        XCTAssertEqual(message.text, text)
        XCTAssertEqual(message.role, .user)

        // Numbered frames advance the high-water mark. If they did not, a reconnect
        // would replay them.
        let mark = await client.lastSeq
        XCTAssertGreaterThanOrEqual(mark, confirmation.seq)

        await client.stop()
    }

    // MARK: - Losing the transport and getting it back

    func testShouldReconnectOverTheRealTransportAndKeepItsMarkAndItsRun() async throws {
        // The reason this is worth the seconds it costs: the iOS Tailscale extension
        // is torn down when idle, so a dropped socket is the ordinary case, not the
        // exotic one. Every other test of it uses a fake that closes on request.
        let connector = RecordingConnector()
        let client = try makeClient(connector: connector)
        let log = EventLog()
        let drain = await log.drain(await client.events())
        defer { drain.cancel() }

        await client.start()
        try await eventually("never connected", log) { await client.connectionState == .connected }

        // Something on the mark, so "kept it" means something.
        try await client.send(
            text: "Before the drop.",
            conversationId: SylIDs.interactiveConversation,
            clientId: "syl:message:\(UUID().uuidString.lowercased())",
            idempotencyKey: IdempotencyKey.generate()
        )
        try await eventually("no frames before the drop", log) { await client.lastSeq > 0 }
        let markBefore = await client.lastSeq
        let epochBefore = await client.serverEpoch

        // The transport goes away underneath a client that has no idea.
        connector.dropTheOpenSocket()

        try await eventually("the client never opened a second socket", log) {
            connector.connectionCount >= 2
        }
        try await eventually("the socket never came back", log) {
            await client.connectionState == .connected
        }

        // Same run, so the mark is still meaningful and must not have been thrown
        // away — that is the difference between a reconnect and a full replay.
        let markAfter = await client.lastSeq
        let epochAfter = await client.serverEpoch
        XCTAssertEqual(epochAfter, epochBefore, "the same server run must keep the same epoch")
        XCTAssertGreaterThanOrEqual(markAfter, markBefore, "the mark went backwards inside one run")

        await client.stop()
    }

    // MARK: - A mark from a run that is gone

    /// `syl-47j`, against a server that really does name its run.
    ///
    /// The reset path has only ever been driven through a fake connector fed a
    /// hand-written `connected` frame. Here the epoch is the real one the service
    /// generated at boot, and the client's stored epoch is from a run that never
    /// existed — exactly the shape of a phone relaunched after the Mac rebooted.
    func testShouldResetAMarkThatBelongsToAServerRunThatIsGone() async throws {
        let stale = "syl:server:0000000000000000000000000000dead"
        let client = try makeClient(lastSeq: 4471, serverEpoch: stale)
        let log = EventLog()
        let drain = await log.drain(await client.events())
        defer { drain.cancel() }

        await client.start()
        try await eventually("never connected", log) { await client.connectionState == .connected }

        let epoch = await client.serverEpoch
        XCTAssertNotNil(epoch)
        XCTAssertNotEqual(epoch, stale, "the client kept an epoch the server never issued")

        // 4471 was a position in a stream that no longer exists. Keeping it would mean
        // treating every frame this run produces as already seen.
        let mark = await client.lastSeq
        XCTAssertLessThan(mark, 4471, "a mark from a dead run was carried into a live one")

        await client.stop()
    }

    // MARK: - Harness

    /// Polls until `condition` holds, then fails with what the socket actually did.
    ///
    /// A bare `for await` with a deadline checked inside the loop cannot time out: if
    /// no event ever arrives it waits forever, and a hung `swift test` in CI reads as
    /// an infrastructure problem rather than as this.
    private func eventually(
        _ what: String,
        _ log: EventLog,
        timeout: TimeInterval = 15,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: @Sendable () async -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let states = await log.states
        let errors = await log.errors
        XCTFail("\(what) — states: \(states), errors: \(errors)", file: file, line: line)
    }
}

/// Everything the socket said, kept where an assertion can read it.
///
/// One consumer, because `AsyncStream` allows exactly one; every test reads the log
/// rather than the stream.
actor EventLog {
    private(set) var events: [SocketEvent] = []

    func drain(_ stream: AsyncStream<SocketEvent>) -> Task<Void, Never> {
        Task { [weak self] in
            for await event in stream {
                await self?.record(event)
            }
        }
    }

    private func record(_ event: SocketEvent) {
        events.append(event)
    }

    var states: [SocketConnectionState] {
        events.compactMap { if case .connectionState(let state) = $0 { return state } else { return nil } }
    }

    var errors: [ApiError] {
        events.compactMap { if case .error(let error, _) = $0 { return error } else { return nil } }
    }

    var messages: [Message] {
        events.compactMap { if case .message(let message) = $0 { return message } else { return nil } }
    }

    var confirmations: [DeliveryConfirmation] {
        events.compactMap {
            if case .deliveryConfirmation(let confirmation) = $0 { return confirmation } else { return nil }
        }
    }
}

/// The real connector, with the sockets it opened kept where a test can reach them.
///
/// **Not a fake.** Every connection handed out here is a `URLSessionWebSocketTask`
/// talking to the real service; the only thing added is a handle on it, because the
/// one honest way to prove a reconnect over a real transport is to take the real
/// transport away.
final class RecordingConnector: WebSocketConnecting, @unchecked Sendable {
    private let underlying: any WebSocketConnecting
    private let lock = NSLock()
    private var opened: [any WebSocketConnection] = []

    init(_ underlying: any WebSocketConnecting = URLSessionWebSocketConnector()) {
        self.underlying = underlying
    }

    var connectionCount: Int {
        lock.withLock { opened.count }
    }

    func connect(to url: URL) async throws -> any WebSocketConnection {
        let connection = try await underlying.connect(to: url)
        lock.withLock { opened.append(connection) }
        return connection
    }

    /// Kills the socket the client is using right now, the way an idle tunnel does.
    func dropTheOpenSocket() {
        lock.withLock { opened.last }?.close()
    }
}
