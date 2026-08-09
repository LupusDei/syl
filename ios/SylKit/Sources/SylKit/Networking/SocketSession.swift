import Foundation

/// What the socket tells the rest of the app.
public enum SocketEvent: Equatable, Sendable {
    case connectionState(SocketConnectionState)
    /// A message arrived, either live or replayed. The client cannot tell, and does
    /// not need to: both are messages the Commander has not seen.
    case message(Message)
    /// The server's half of an optimistic send. Match `clientId` against the pending
    /// row and swap in `serverId`.
    case deliveryConfirmation(DeliveryConfirmation)
    /// A presence frame. Never replayed, never numbered.
    case presence(WsPresence)
    /// **The gap is older than the server remembers.** The client must not treat
    /// itself as caught up: fall back to `GET /sync` and a history fetch. A phone
    /// that spent a weekend in a drawer takes this path, and a client that ignores it
    /// silently misses everything that aged out.
    case needsHTTPSync(fromSeq: Int)
    case error(ApiError, fatal: Bool)
}

/// Offline is a state to design, not an error to report. An assistant that silently
/// fails to sync is worse than one that says so.
public enum SocketConnectionState: Equatable, Sendable {
    case idle
    case connecting
    /// The socket is open and the handshake is in flight. The server speaks first.
    case authenticating
    case connected
    /// Retrying, with the attempt number, because "reconnecting (3)" is honest and a
    /// spinner is not.
    case reconnecting(attempt: Int)
    /// The tailnet is down or the Mac is off. Recoverable, and the app stays usable.
    case offline
    /// The token was refused. Stop reconnecting and re-pair rather than loop against
    /// a wall.
    case unauthenticated
}

/// The socket protocol, as a pure state machine.
///
/// No I/O, no timers, no `URLSession`. Everything subtle about this protocol is about
/// **sequencing** — which frames advance the high-water mark, which are replayable,
/// what a gap means and what `complete: false` means — and all of it is cheap to be
/// exact about only if it can be exercised without a server. It is the same instinct
/// as the backend rule that the protocol codec stays pure.
public struct SocketSession: Sendable {
    /// What the caller should do next.
    public enum Outcome: Equatable, Sendable {
        case send(WsClientFrame)
        case emit(SocketEvent)
        /// The server is about to close, or has told us to stop. Do not reconnect.
        case stop(reason: String)
    }

    public enum Phase: Equatable, Sendable {
        /// The server speaks first. A client that sends `auth_response` unprompted is
        /// answering a challenge it has not seen, and the server closes on it.
        case awaitingChallenge
        case awaitingConnected
        case ready
        case closed
    }

    /// The frame-stream high-water mark. **Not** a message sequence: this is the
    /// client's position in one server's frame stream, and feeding it to anything
    /// expecting `Message.seq` desynchronises the socket.
    public private(set) var lastSeq: Int
    public private(set) var phase: Phase = .awaitingChallenge
    /// The protocol version the server announced, once it has.
    public private(set) var protocolVersion: Int?
    /// The newest frame sequence the server said it holds, from `connected`.
    ///
    /// Kept because a `sync_response` may be **truncated** by the server's `limit`
    /// without being incomplete. Truncation is not loss — nothing aged out, the page
    /// was simply capped — so the client re-syncs from `toSeq` rather than falling
    /// back to HTTP. Without remembering where the server was, a truncated page would
    /// leave the client believing it was caught up until the next live frame happened
    /// to reveal the hole.
    public private(set) var serverLastSeq: Int = 0

    private let token: String
    private let supportedProtocolVersion: Int

    public init(token: String, lastSeq: Int = 0, supportedProtocolVersion: Int = 1) {
        self.token = token
        self.lastSeq = lastSeq
        self.supportedProtocolVersion = supportedProtocolVersion
    }

    /// Feed one server frame in; get the actions to take out.
    public mutating func receive(_ frame: WsServerFrame) -> [Outcome] {
        switch frame {
        case .authChallenge(let challenge):
            return handle(challenge)
        case .connected(let connected):
            return handle(connected)
        case .chatMessage(let frame):
            return handleNumbered(seq: frame.seq, event: .message(frame.message))
        case .deliveryConfirmation(let frame):
            return handleNumbered(
                seq: frame.seq,
                event: .deliveryConfirmation(frame.asDeliveryConfirmation)
            )
        case .presence(let presence):
            // The deliberate exception, and the rule the whole frame exists around.
            // Presence carries no seq and must never touch the high-water mark: doing
            // so would either replay a stale state on reconnect or punch a hole in the
            // sequence space, and holes are precisely how gap detection works.
            return [.emit(.presence(presence))]
        case .syncResponse(let response):
            return handle(response)
        case .pong:
            // Liveness is the caller's business; the protocol has nothing to say.
            return []
        case .error(let frame):
            return handle(frame)
        }
    }

    /// The socket dropped. Keeps `lastSeq` — that is the whole point of it — and puts
    /// the handshake back to the start.
    public mutating func socketClosed() {
        guard phase != .closed else { return }
        phase = .awaitingChallenge
        protocolVersion = nil
    }

    // MARK: - Handshake

    private mutating func handle(_ challenge: WsAuthChallenge) -> [Outcome] {
        guard challenge.protocolVersion == supportedProtocolVersion else {
            // A mobile app in the field will outlive several server deploys. Refusing
            // to interpret frames is safer than guessing at their meaning.
            phase = .closed
            return [
                .emit(.error(
                    ApiError(
                        code: .conflict,
                        message: """
                            This app speaks protocol v\(supportedProtocolVersion); the service \
                            speaks v\(challenge.protocolVersion). Update the app.
                            """,
                        retryable: false
                    ),
                    fatal: true
                )),
                .stop(reason: "protocol version mismatch"),
            ]
        }

        protocolVersion = challenge.protocolVersion
        phase = .awaitingConnected
        return [
            .emit(.connectionState(.authenticating)),
            .send(.authResponse(
                WsAuthResponse(token: token, nonce: challenge.nonce, lastSeq: lastSeq)
            )),
        ]
    }

    private mutating func handle(_ connected: WsConnected) -> [Outcome] {
        protocolVersion = connected.protocolVersion
        phase = .ready
        serverLastSeq = max(serverLastSeq, connected.lastSeq)

        var outcomes: [Outcome] = [.emit(.connectionState(.connected))]

        // The server's newest sequence against ours. Anything above our mark is a gap.
        if connected.lastSeq > lastSeq {
            outcomes.append(.send(.sync(WsSync(sinceSeq: lastSeq))))
        }
        return outcomes
    }

    // MARK: - Numbered frames

    private mutating func handleNumbered(seq: Int, event: SocketEvent) -> [Outcome] {
        // A live frame is proof of where the server is, and keeps the truncation check
        // in `handle(_: WsSyncResponse)` from asking for a range that no longer exists.
        serverLastSeq = max(serverLastSeq, seq)

        // Already seen. This is the ordinary case on reconnect: the server replays
        // from our mark and the first frames back are ones we already hold.
        guard seq > lastSeq else { return [] }

        var outcomes: [Outcome] = []

        // A hole in the sequence space is how loss is detected. Ask for the range
        // before consuming this frame, so the replayed frames arrive in order.
        if seq > lastSeq + 1 {
            outcomes.append(.send(.sync(WsSync(sinceSeq: lastSeq))))
        }

        lastSeq = seq
        outcomes.append(.emit(event))
        return outcomes
    }

    // MARK: - Gap recovery

    private mutating func handle(_ response: WsSyncResponse) -> [Outcome] {
        var outcomes: [Outcome] = []

        if !response.complete {
            // **`complete: false` means the range aged out of the replay buffer** —
            // genuinely unrecoverable history — and nothing else. It does NOT mean the
            // page was truncated by the server's `limit`; the service is explicit
            // about that, and treating a truncated page as incomplete would send the
            // client to `GET /sync` on every large gap.
            //
            // The frames we did get are real and worth applying, but the client is NOT
            // caught up and must say so.
            outcomes.append(.emit(.needsHTTPSync(fromSeq: response.fromSeq)))
        }

        for frame in response.frames {
            switch frame {
            case .chatMessage(let frame):
                outcomes += consumeReplayed(seq: frame.seq, event: .message(frame.message))
            case .deliveryConfirmation(let frame):
                outcomes += consumeReplayed(
                    seq: frame.seq,
                    event: .deliveryConfirmation(frame.asDeliveryConfirmation)
                )
            }
        }

        let previous = lastSeq
        // The socket is now at `toSeq` whether or not the payload was complete: the
        // frames below it are gone from the buffer and asking again would loop.
        lastSeq = max(lastSeq, response.toSeq)

        // Truncation, the other half of the same rule. A capped page leaves the client
        // short of where the server said it was, and nothing was lost — so ask again
        // from here rather than falling back to HTTP.
        //
        // Guarded on progress: a page that moved the mark nowhere would otherwise ask
        // for the same range forever.
        if lastSeq > previous, lastSeq < serverLastSeq {
            outcomes.append(.send(.sync(WsSync(sinceSeq: lastSeq))))
        }

        return outcomes
    }

    /// A replayed frame never triggers another `sync` — that is the request we are
    /// already answering, and re-asking on a hole inside the reply is an infinite loop.
    private mutating func consumeReplayed(seq: Int, event: SocketEvent) -> [Outcome] {
        guard seq > lastSeq else { return [] }
        lastSeq = seq
        return [.emit(event)]
    }

    // MARK: - Errors

    private mutating func handle(_ frame: WsError) -> [Outcome] {
        var outcomes: [Outcome] = [.emit(.error(frame.error, fatal: frame.fatal))]

        guard frame.fatal else {
            // Informational; the socket stays up.
            return outcomes
        }

        phase = .closed
        if frame.error.code == .unauthorized || frame.error.code == .forbidden {
            outcomes.append(.emit(.connectionState(.unauthenticated)))
        }
        outcomes.append(.stop(reason: frame.error.message))
        return outcomes
    }
}
