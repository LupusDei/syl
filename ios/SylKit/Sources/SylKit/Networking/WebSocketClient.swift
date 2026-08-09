import Foundation

/// The live connection to Syl.
///
/// The client is a thin driver over `SocketSession`, which holds everything subtle
/// about the protocol and holds it purely. This type owns only the things that
/// genuinely need the outside world: opening a socket, reading frames off it,
/// keepalive, and reconnecting with backoff.
///
/// Reconnecting matters more here than it looks. The iOS Tailscale extension is torn
/// down when idle, so the first attempt after a wake can fail while the tunnel
/// re-establishes; every reconnect retries, and the state the app shows says
/// "reconnecting (2)" rather than pretending nothing is wrong.
public actor WebSocketClient {
    /// Waits between reconnect attempts. Injected so a test drives the schedule
    /// without spending the wall-clock time it describes.
    ///
    /// **The default is built inside `init`, never written as a default argument.**
    /// A default argument is evaluated in the *caller's* module — which is why the
    /// compiler refuses to let one reference an internal symbol — so an async closure
    /// literal there is a thunk formed at every call site. Awaiting one from inside
    /// this actor's own long-lived run task corrupts the task allocator: "freed
    /// pointer was not the last allocation", SIGABRT, on the first reconnect. The
    /// identical source text formed inside `init` is fine, and so is a named function.
    /// Measured both ways; `testShouldSurviveTheReconnectWaitItShipsWith` pins it.
    public typealias Sleeper = @Sendable (TimeInterval) async throws -> Void

    /// Raised when a caller tries to send over a socket that is not ready. The caller
    /// falls back to `POST /conversations/{id}/messages`, which reconciles identically.
    public struct NotConnected: Error, CustomStringConvertible {
        public init() {}

        public var description: String {
            "the socket is not ready — send over HTTP and reconcile by clientId instead"
        }
    }

    /// The socket endpoint, or the reason this configuration has none.
    ///
    /// Kept as a `Result` rather than thrown from `init` so that a server URL the app
    /// cannot open a socket on is an offline state with a stated reason, exactly like
    /// an unreachable tailnet — not a failure at construction that every call site has
    /// to have an answer for.
    private let socketURL: Result<URL, SocketURLError>
    private let connector: any WebSocketConnecting
    private let tokenProvider: TokenProviding
    private let reconnectPolicy: RetryPolicy
    private let keepaliveInterval: TimeInterval
    private let sleeper: Sleeper
    private let randomSampler: APIClient.RandomSampler
    private let now: @Sendable () -> Date

    private var session: SocketSession?
    private var connection: (any WebSocketConnection)?
    private var keepalive: Keepalive
    private var presence = PresenceTimeline()
    private var runTask: Task<Void, Never>?
    private var keepaliveTask: Task<Void, Never>?
    private var continuation: AsyncStream<SocketEvent>.Continuation?

    /// The frame-stream high-water mark, kept across reconnects. This is what makes
    /// "the phone was in a tunnel" a non-event rather than lost messages.
    public private(set) var lastSeq: Int

    /// The server run `lastSeq` belongs to. **Persist it with the mark, not instead of
    /// it** — a mark restored on the next launch without the run it came from is
    /// `syl-47j` again, one relaunch later.
    public private(set) var serverEpoch: String?

    /// The state the app should show. Offline is a state to design, not an error.
    public private(set) var connectionState: SocketConnectionState = .idle

    public init(
        configuration: ServerConfiguration,
        connector: any WebSocketConnecting = URLSessionWebSocketConnector(),
        tokenProvider: TokenProviding,
        lastSeq: Int = 0,
        serverEpoch: String? = nil,
        reconnectPolicy: RetryPolicy = .socketReconnect,
        keepaliveInterval: TimeInterval = 30,
        missedPongsBeforeDead: Int = 2,
        // **Not a default argument.** See `Sleeper`.
        sleeper: Sleeper? = nil,
        randomSampler: @escaping APIClient.RandomSampler = { Double.random(in: 0...1) },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        // `/ws` hangs off the same versioned base as the REST API, same origin and
        // same token — but **not** the same scheme. `socketURL()` maps `http` to `ws`
        // and `https` to `wss`; handing `URLSession` an `http` socket URL aborts the
        // process rather than failing (`syl-w40`).
        self.socketURL = Result { try configuration.socketURL() }
            .mapError { error in
                // `socketURL()` throws nothing else. Mapping rather than force-casting
                // keeps a future third case from becoming a crash of its own.
                error as? SocketURLError ?? .malformedServerURL(configuration.baseURL)
            }
        self.connector = connector
        self.tokenProvider = tokenProvider
        self.lastSeq = lastSeq
        self.serverEpoch = serverEpoch
        self.reconnectPolicy = reconnectPolicy
        self.keepaliveInterval = keepaliveInterval
        self.keepalive = Keepalive(
            interval: keepaliveInterval,
            missedPongsBeforeDead: missedPongsBeforeDead
        )
        self.sleeper = sleeper ?? { seconds in
            try await Task.sleep(nanoseconds: UInt64(max(seconds, 0) * 1_000_000_000))
        }
        self.randomSampler = randomSampler
        self.now = now
    }

    // MARK: - Events

    /// The event stream. One consumer; calling it again replaces the previous one.
    ///
    /// The replaced continuation is finished rather than dropped: an abandoned
    /// continuation leaves its `for await` loop suspended forever, and the task that
    /// owns it never completes.
    public func events() -> AsyncStream<SocketEvent> {
        continuation?.finish()
        // Bounded. The consumer writes to disk per event, and an unbounded buffer
        // behind a slow consumer grows for as long as the socket is busy.
        return AsyncStream(bufferingPolicy: .bufferingNewest(256)) { continuation in
            self.continuation = continuation
        }
    }

    /// Syl's presence right now, decayed per the TTL rules.
    public func presenceState() -> PresenceState {
        presence.state(at: now())
    }

    // MARK: - Lifecycle

    public func start() {
        guard runTask == nil else { return }
        runTask = Task { [weak self] in
            await self?.run()
        }
    }

    public func stop() {
        runTask?.cancel()
        runTask = nil
        teardownConnection()
        session = nil
        presence.clear()
        set(.idle)
        continuation?.finish()
        // Cleared, not just finished. A later `start()` would otherwise run a working
        // socket whose every event goes to a stream nobody can hear.
        continuation = nil
    }

    /// Closes the socket and stops the keepalive. Every exit from the pump runs this,
    /// including the fatal one — a stopped client that left its task looping and its
    /// `URLSessionWebSocketTask` open would keep both for the life of the process.
    private func teardownConnection() {
        stopKeepalive()
        connection?.close()
        connection = nil
    }

    /// Sends over the socket. Throws `NotConnected` when it is not ready, which is the
    /// caller's cue to use HTTP — the two paths reconcile identically by `clientId`.
    public func send(
        text: String,
        conversationId: SylID,
        clientId: String,
        idempotencyKey: String
    ) async throws {
        guard let connection, session?.phase == .ready else { throw NotConnected() }
        try await write(
            .chatMessage(
                WsClientChatMessage(
                    clientId: clientId,
                    conversationId: conversationId,
                    text: text,
                    idempotencyKey: idempotencyKey
                )
            ),
            to: connection
        )
    }

    // MARK: - The loop

    private func run() async {
        var attempt = 1
        // Cleared on every exit, so `start()` is not a permanent no-op afterwards.
        // Without it a client that stopped — a missing token, a fatal error — could
        // never be restarted once the Commander re-paired.
        defer { runTask = nil }

        while !Task.isCancelled {
            set(attempt == 1 ? .connecting : .reconnecting(attempt: attempt))

            let outcome = await connectAndPump()
            teardownConnection()
            // Presence does not survive a disconnection: a state held across the gap
            // would assert something about now that stopped being true.
            presence.clear()

            switch outcome {
            case .stopped:
                return
            case .disconnected(let hadReachedReady):
                if hadReachedReady { attempt = 1 }
                guard !Task.isCancelled else { return }

                set(attempt == 1 ? .offline : .reconnecting(attempt: attempt))
                let delay = reconnectPolicy.delay(
                    beforeAttempt: attempt + 1,
                    randomSample: randomSampler()
                )
                do {
                    try await sleeper(delay)
                } catch {
                    return
                }
                attempt += 1
            }
        }
    }

    private enum PumpOutcome {
        /// A fatal error, or a deliberate stop. Do not reconnect.
        case stopped
        /// The socket went away. `hadReachedReady` resets the backoff, because a
        /// connection that worked and then dropped is a different situation from one
        /// that never came up.
        case disconnected(hadReachedReady: Bool)
    }

    private func connectAndPump() async -> PumpOutcome {
        // Before the token, deliberately. A server URL a socket cannot be opened on is
        // wrong whether or not the app is paired, and the pairing bug that used to
        // return `.unauthenticated` first is exactly what hid `syl-w40` until pairing
        // started working.
        let url: URL
        switch socketURL {
        case .success(let resolved):
            url = resolved
        case .failure(let error):
            // Not a disconnection: no retry can make this configuration work, so a
            // reconnect loop would be a loop against a wall. Say why, and stop.
            continuation?.yield(
                .error(
                    ApiError(
                        code: .validationFailed,
                        message: "Syl's address cannot carry a socket — \(error)",
                        retryable: false
                    ),
                    fatal: true
                )
            )
            // The socket is not coming up and the rest of the app still works over
            // HTTP, which is what `offline` means to everything that reads it.
            set(.offline)
            return .stopped
        }

        guard let token = await tokenProvider.token() else {
            set(.unauthenticated)
            return .stopped
        }

        let connection: any WebSocketConnection
        do {
            connection = try await connector.connect(to: url)
        } catch {
            return .disconnected(hadReachedReady: false)
        }

        self.connection = connection
        var session = SocketSession(token: token, lastSeq: lastSeq, serverEpoch: serverEpoch)
        self.session = session
        keepalive.reset()
        startKeepalive()

        var reachedReady = false

        while !Task.isCancelled {
            let text: String
            do {
                text = try await connection.receive()
            } catch {
                return .disconnected(hadReachedReady: reachedReady)
            }

            guard let frame = decodeFrame(text) else { continue }

            if case .pong = frame { keepalive.pongReceived() }
            if case .presence(let presenceFrame) = frame {
                presence.record(presenceFrame, at: now())
            }

            let outcomes = session.receive(frame)
            self.session = session
            // Both, together. The mark can go *backwards* here — that is the whole
            // point of `syl-47j` — and a mark carried into the next reconnect without
            // the run it belongs to would be reinterpreted against the wrong stream.
            lastSeq = session.lastSeq
            serverEpoch = session.serverEpoch
            if session.phase == .ready { reachedReady = true }

            for outcome in outcomes {
                switch outcome {
                case .emit(let event):
                    if case .connectionState(let state) = event {
                        set(state)
                    } else {
                        continuation?.yield(event)
                    }
                case .send(let frame):
                    do {
                        try await write(frame, to: connection)
                    } catch {
                        return .disconnected(hadReachedReady: reachedReady)
                    }
                case .stop:
                    return .stopped
                }
            }
        }
        return .stopped
    }

    private func decodeFrame(_ text: String) -> WsServerFrame? {
        do {
            return try SylJSON.decoder().decode(WsServerFrame.self, from: Data(text.utf8))
        } catch {
            // An unrecognised frame is not a reason to drop a working socket. The
            // service may have added a frame type; a client that closes on one is a
            // client that breaks on a server deploy.
            continuation?.yield(
                .error(
                    ApiError(
                        code: .validationFailed,
                        message: "Unreadable frame: \(error)",
                        retryable: false
                    ),
                    fatal: false
                )
            )
            return nil
        }
    }

    private func write(_ frame: WsClientFrame, to connection: any WebSocketConnection) async throws {
        let data = try SylJSON.encoder().encode(frame)
        try await connection.send(String(decoding: data, as: UTF8.self))
    }

    private func set(_ state: SocketConnectionState) {
        guard state != connectionState else { return }
        connectionState = state
        continuation?.yield(.connectionState(state))
    }

    // MARK: - Keepalive

    private func startKeepalive() {
        guard keepaliveInterval > 0 else { return }
        keepaliveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    try await self.sleepForKeepalive()
                } catch {
                    return
                }
                await self.pingOrGiveUp()
            }
        }
    }

    private func sleepForKeepalive() async throws {
        try await sleeper(keepaliveInterval)
    }

    private func pingOrGiveUp() async {
        guard let connection, session?.phase == .ready else { return }
        guard keepalive.pingSent() else {
            // Two missed pongs. The socket is gone whether or not it has admitted it;
            // closing makes `receive` throw and the run loop reconnect.
            connection.close()
            return
        }
        try? await write(.ping(WsPing(ts: now())), to: connection)
    }

    private func stopKeepalive() {
        keepaliveTask?.cancel()
        keepaliveTask = nil
    }
}

extension RetryPolicy {
    /// Socket reconnection: exponential backoff with jitter, **capped at 30 seconds**
    /// and never giving up. A home Mac that is rebooting will be back; a client that
    /// stopped trying would need the Commander to notice and relaunch the app.
    public static let socketReconnect = RetryPolicy(
        maxAttempts: .max,
        baseDelay: 1,
        maxDelay: 30,
        multiplier: 2
    )
}
