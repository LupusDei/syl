import Foundation

/// The frame catalogue. `chat_message` is the one type that exists in both
/// directions with different shapes; they are distinguished by direction, not by
/// name, because they are the same logical event seen from two ends.
public enum WsFrameType: String, Codable, Equatable, Sendable, CaseIterable {
    case authChallenge = "auth_challenge"
    case authResponse = "auth_response"
    case connected
    case chatMessage = "chat_message"
    case deliveryConfirmation = "delivery_confirmation"
    case presence
    case sync
    case syncResponse = "sync_response"
    case ping
    case pong
    case error
}

/// Server → client, first frame on every connection. **The server speaks first**; a
/// client that sends `auth_response` unprompted is closed on.
public struct WsAuthChallenge: Codable, Equatable, Sendable {
    public let nonce: String
    public let protocolVersion: Int

    public init(nonce: String, protocolVersion: Int) {
        self.nonce = nonce
        self.protocolVersion = protocolVersion
    }

    private enum CodingKeys: String, CodingKey {
        case type, nonce, protocolVersion
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try WsFrame.expect(.authChallenge, in: container, forKey: CodingKeys.type)
        nonce = try container.decode(String.self, forKey: .nonce)
        protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(WsFrameType.authChallenge, forKey: .type)
        try container.encode(nonce, forKey: .nonce)
        try container.encode(protocolVersion, forKey: .protocolVersion)
    }
}

/// Client → server, in reply to the challenge.
///
/// Authentication is a frame rather than a header because the browser WebSocket API
/// cannot set one. The iOS client *could* use a header and deliberately does not:
/// one handshake, one code path, two platforms.
public struct WsAuthResponse: Codable, Equatable, Sendable {
    public let token: String
    public let nonce: String?
    /// The highest **frame** sequence the client already holds.
    public let lastSeq: Int?

    public init(token: String, nonce: String?, lastSeq: Int?) {
        self.token = token
        self.nonce = nonce
        self.lastSeq = lastSeq
    }

    private enum CodingKeys: String, CodingKey {
        case type, token, nonce, lastSeq
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try WsFrame.expect(.authResponse, in: container, forKey: CodingKeys.type)
        token = try container.decode(String.self, forKey: .token)
        nonce = try container.decodeIfPresent(String.self, forKey: .nonce)
        lastSeq = try container.decodeIfPresent(Int.self, forKey: .lastSeq)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(WsFrameType.authResponse, forKey: .type)
        try container.encode(token, forKey: .token)
        try container.encodeRequiredNullable(nonce, forKey: .nonce)
        try container.encodeRequiredNullable(lastSeq, forKey: .lastSeq)
    }
}

/// Server → client. `lastSeq` is the newest **frame** sequence the server holds; the
/// client compares it with its own high-water mark and sends `sync` if there is a gap.
public struct WsConnected: Codable, Equatable, Sendable {
    public let lastSeq: Int
    public let serverTime: Date
    public let protocolVersion: Int
    /// **Which run of the server this is** — the identity of the frame stream, not of
    /// the service.
    ///
    /// `lastSeq` alone is meaningless without it. The sequence is held in memory and
    /// begins again at zero on every restart, so a number from a run that has ended
    /// names nothing: a client holding 57 that reconnects to a fresh run is told
    /// `lastSeq: 0`, concludes there is no gap, and then discards every frame the new
    /// run sends as already-seen. Green indicator, live keepalive, no messages —
    /// `syl-47j`.
    ///
    /// Optional because a service older than this field is still a service the app
    /// must talk to; `SocketSession` has a weaker fallback for that case. New services
    /// always send it.
    public let serverEpoch: String?
    public let principal: Principal

    public init(
        lastSeq: Int,
        serverTime: Date,
        protocolVersion: Int,
        serverEpoch: String? = nil,
        principal: Principal
    ) {
        self.lastSeq = lastSeq
        self.serverTime = serverTime
        self.protocolVersion = protocolVersion
        self.serverEpoch = serverEpoch
        self.principal = principal
    }

    private enum CodingKeys: String, CodingKey {
        case type, lastSeq, serverTime, protocolVersion, serverEpoch, principal
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try WsFrame.expect(.connected, in: container, forKey: CodingKeys.type)
        lastSeq = try container.decode(Int.self, forKey: .lastSeq)
        serverTime = try container.decode(Date.self, forKey: .serverTime)
        protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
        serverEpoch = try container.decodeIfPresent(String.self, forKey: .serverEpoch)
        principal = try container.decode(Principal.self, forKey: .principal)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(WsFrameType.connected, forKey: .type)
        try container.encode(lastSeq, forKey: .lastSeq)
        try container.encode(serverTime, forKey: .serverTime)
        try container.encode(protocolVersion, forKey: .protocolVersion)
        // `encodeIfPresent`, not `encodeRequiredNullable`. A frame from a service that
        // does not send this field must round-trip byte-for-byte through the model, and
        // the contract fixtures are the gate that says so.
        try container.encodeIfPresent(serverEpoch, forKey: .serverEpoch)
        try container.encode(principal, forKey: .principal)
    }
}

/// Client → server. Same semantics as `POST /conversations/{id}/messages`.
///
/// `clientId` identifies *this message* for reconciliation; `idempotencyKey`
/// identifies *this attempt* so a retried send is not a second message. Both are
/// required, and they are not the same thing.
public struct WsClientChatMessage: Codable, Equatable, Sendable {
    public let clientId: String
    public let conversationId: SylID
    public let text: String
    public let idempotencyKey: String

    public init(clientId: String, conversationId: SylID, text: String, idempotencyKey: String) {
        self.clientId = clientId
        self.conversationId = conversationId
        self.text = text
        self.idempotencyKey = idempotencyKey
    }

    private enum CodingKeys: String, CodingKey {
        case type, clientId, conversationId, text, idempotencyKey
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try WsFrame.expect(.chatMessage, in: container, forKey: CodingKeys.type)
        clientId = try container.decode(String.self, forKey: .clientId)
        conversationId = try container.decode(SylID.self, forKey: .conversationId)
        text = try container.decode(String.self, forKey: .text)
        idempotencyKey = try container.decode(String.self, forKey: .idempotencyKey)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(WsFrameType.chatMessage, forKey: .type)
        try container.encode(clientId, forKey: .clientId)
        try container.encode(conversationId, forKey: .conversationId)
        try container.encode(text, forKey: .text)
        try container.encode(idempotencyKey, forKey: .idempotencyKey)
    }
}

/// Server → client. Numbered and replayable: this is the frame whose loss the
/// sequence-and-replay machinery exists to make a non-event.
public struct WsServerChatMessage: Codable, Equatable, Sendable {
    /// The **frame** sequence. `message.seq` is the conversation sequence. They are
    /// different numbers.
    public let seq: Int
    public let ts: Date
    public let message: Message

    public init(seq: Int, ts: Date, message: Message) {
        self.seq = seq
        self.ts = ts
        self.message = message
    }

    private enum CodingKeys: String, CodingKey {
        case type, seq, ts, message
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try WsFrame.expect(.chatMessage, in: container, forKey: CodingKeys.type)
        seq = try container.decode(Int.self, forKey: .seq)
        ts = try container.decode(Date.self, forKey: .ts)
        message = try container.decode(Message.self, forKey: .message)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(WsFrameType.chatMessage, forKey: .type)
        try container.encode(seq, forKey: .seq)
        try container.encode(ts, forKey: .ts)
        try container.encode(message, forKey: .message)
    }
}

/// Server → client. Carries **both** sequence spaces, and the whole reason they are
/// named apart lives here.
///
/// `seq` is this frame's position in the server's frame stream, used for gap
/// detection. `messageSeq` is the resulting message's position in its conversation,
/// used for ordering history. Feed the wrong one to `sync` and the client either
/// replays the whole stream or silently believes it is caught up.
public struct WsDeliveryConfirmation: Codable, Equatable, Sendable {
    /// Frame-stream sequence.
    public let seq: Int
    public let ts: Date
    public let clientId: String
    public let serverId: SylID
    public let conversationId: SylID
    /// Conversation sequence. **Not** `seq`.
    public let messageSeq: Int
    public let acceptedAt: Date

    public init(
        seq: Int,
        ts: Date,
        clientId: String,
        serverId: SylID,
        conversationId: SylID,
        messageSeq: Int,
        acceptedAt: Date
    ) {
        self.seq = seq
        self.ts = ts
        self.clientId = clientId
        self.serverId = serverId
        self.conversationId = conversationId
        self.messageSeq = messageSeq
        self.acceptedAt = acceptedAt
    }

    private enum CodingKeys: String, CodingKey {
        case type, seq, ts, clientId, serverId, conversationId, messageSeq, acceptedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try WsFrame.expect(.deliveryConfirmation, in: container, forKey: CodingKeys.type)
        seq = try container.decode(Int.self, forKey: .seq)
        ts = try container.decode(Date.self, forKey: .ts)
        clientId = try container.decode(String.self, forKey: .clientId)
        serverId = try container.decode(SylID.self, forKey: .serverId)
        conversationId = try container.decode(SylID.self, forKey: .conversationId)
        messageSeq = try container.decode(Int.self, forKey: .messageSeq)
        acceptedAt = try container.decode(Date.self, forKey: .acceptedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(WsFrameType.deliveryConfirmation, forKey: .type)
        try container.encode(seq, forKey: .seq)
        try container.encode(ts, forKey: .ts)
        try container.encode(clientId, forKey: .clientId)
        try container.encode(serverId, forKey: .serverId)
        try container.encode(conversationId, forKey: .conversationId)
        try container.encode(messageSeq, forKey: .messageSeq)
        try container.encode(acceptedAt, forKey: .acceptedAt)
    }

    /// The same reconciliation pair the HTTP path produces, so one code path can
    /// swallow both. The HTTP body's bare `seq` is the message sequence, which is
    /// `messageSeq` here — mapping it explicitly is what keeps the two apart.
    public var asDeliveryConfirmation: DeliveryConfirmation {
        DeliveryConfirmation(
            clientId: clientId,
            serverId: serverId,
            conversationId: conversationId,
            seq: messageSeq,
            acceptedAt: acceptedAt
        )
    }
}

/// **Treat an unrecognised value as `idle`.**
///
/// The enum is open on purpose so the service can add a state without shipping an app
/// update. A client that rejects the frame instead is a client that breaks on a
/// server deploy. This is the one deliberate exception to the strict-decoding rule.
public enum PresenceState: String, Codable, Equatable, Sendable, CaseIterable {
    case absent, idle, listening, thinking, speaking, alert, delighted, concerned, manifest

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PresenceState(rawValue: raw) ?? .idle
    }
}

/// Server → client. **Never replayed, and it carries no `seq`.**
///
/// Replaying `thinking` from four minutes ago is a lie: it asserts something about
/// *now* that stopped being true while the socket was down. Numbering it would force
/// either a forbidden replay or holes in the sequence space, and holes are exactly
/// how gap detection works.
public struct WsPresence: Codable, Equatable, Sendable {
    public let state: PresenceState
    /// Amplitude, not a separate state. **Clamped client-side** — a server sending
    /// 1.4 is wrong but must not break the app. See `clampedIntensity`.
    public let intensity: Double
    /// When the current **state** began — not when the frame was sent. Held constant
    /// across repeated frames of the same state, so a client joining mid-`speaking`
    /// can tell how long it has been going.
    public let since: Date
    /// How long this state stays valid with no further frame. On expiry the client
    /// falls back to `idle`, and after a further 30 seconds of silence to `absent`.
    ///
    /// **The one snake_case field on the wire.** Every other field is camelCase,
    /// which is exactly why a blanket `.convertFromSnakeCase` decoding strategy is
    /// wrong: it would rewrite this to `ttlMs` and mangle everything else.
    public let ttlMs: Int

    public init(state: PresenceState, intensity: Double, since: Date, ttlMs: Int) {
        self.state = state
        self.intensity = intensity
        self.since = since
        self.ttlMs = ttlMs
    }

    /// `intensity` constrained to 0...1. Use this for rendering; `intensity` keeps
    /// whatever the server sent so a round-trip stays faithful.
    public var clampedIntensity: Double {
        min(max(intensity, 0), 1)
    }

    /// How long this state stays valid. Nil is not possible — a zero TTL means the
    /// state expires immediately, which is what `absent` sends.
    public var ttl: TimeInterval {
        TimeInterval(ttlMs) / 1000
    }

    /// The instant this state stops being true.
    public func expiry(from received: Date) -> Date {
        received.addingTimeInterval(ttl)
    }

    private enum CodingKeys: String, CodingKey {
        case type, state, intensity, since
        // The only place in this client where a wire name and a Swift name differ.
        case ttlMs = "ttl_ms"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try WsFrame.expect(.presence, in: container, forKey: CodingKeys.type)
        state = try container.decode(PresenceState.self, forKey: .state)
        intensity = try container.decode(Double.self, forKey: .intensity)
        since = try container.decode(Date.self, forKey: .since)
        ttlMs = try container.decode(Int.self, forKey: .ttlMs)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(WsFrameType.presence, forKey: .type)
        try container.encode(state, forKey: .state)
        try container.encode(intensity, forKey: .intensity)
        try container.encode(since, forKey: .since)
        try container.encode(ttlMs, forKey: .ttlMs)
    }
}

/// Client → server. Gap recovery on this socket, by **sequence number**.
///
/// Deliberately not named like `GET /sync`, and its parameter is `sinceSeq` rather
/// than `since`, so the two mechanisms cannot be conflated.
public struct WsSync: Codable, Equatable, Sendable {
    public let sinceSeq: Int
    public let limit: Int?

    public init(sinceSeq: Int, limit: Int? = nil) {
        self.sinceSeq = sinceSeq
        self.limit = limit
    }

    private enum CodingKeys: String, CodingKey {
        case type, sinceSeq, limit
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try WsFrame.expect(.sync, in: container, forKey: CodingKeys.type)
        sinceSeq = try container.decode(Int.self, forKey: .sinceSeq)
        limit = try container.decodeIfPresent(Int.self, forKey: .limit)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(WsFrameType.sync, forKey: .type)
        try container.encode(sinceSeq, forKey: .sinceSeq)
        try container.encodeRequiredNullable(limit, forKey: .limit)
    }
}

/// The two frame types that enter the replay buffer. Nothing else is replayable —
/// notably not `presence`.
public enum WsReplayableFrame: Codable, Equatable, Sendable {
    case chatMessage(WsServerChatMessage)
    case deliveryConfirmation(WsDeliveryConfirmation)

    private enum DiscriminatorKeys: String, CodingKey {
        case type
    }

    /// The frame-stream sequence, which every replayable frame carries.
    public var seq: Int {
        switch self {
        case .chatMessage(let frame): return frame.seq
        case .deliveryConfirmation(let frame): return frame.seq
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DiscriminatorKeys.self)
        let type = try container.decode(WsFrameType.self, forKey: .type)
        switch type {
        case .chatMessage:
            self = .chatMessage(try WsServerChatMessage(from: decoder))
        case .deliveryConfirmation:
            self = .deliveryConfirmation(try WsDeliveryConfirmation(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: DiscriminatorKeys.type,
                in: container,
                debugDescription: """
                    \"\(type.rawValue)\" is not replayable. The replay buffer holds only \
                    chat_message and delivery_confirmation; presence in particular must \
                    never appear here.
                    """
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .chatMessage(let frame): try frame.encode(to: encoder)
        case .deliveryConfirmation(let frame): try frame.encode(to: encoder)
        }
    }
}

/// Server → client. `complete: false` means the requested range fell off the replay
/// buffer — the client's gap is older than the server remembers, and it must fall
/// back to `GET /sync` rather than assume it is caught up.
public struct WsSyncResponse: Codable, Equatable, Sendable {
    public let fromSeq: Int
    public let toSeq: Int
    public let complete: Bool
    public let frames: [WsReplayableFrame]

    public init(fromSeq: Int, toSeq: Int, complete: Bool, frames: [WsReplayableFrame]) {
        self.fromSeq = fromSeq
        self.toSeq = toSeq
        self.complete = complete
        self.frames = frames
    }

    private enum CodingKeys: String, CodingKey {
        case type, fromSeq, toSeq, complete, frames
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try WsFrame.expect(.syncResponse, in: container, forKey: CodingKeys.type)
        fromSeq = try container.decode(Int.self, forKey: .fromSeq)
        toSeq = try container.decode(Int.self, forKey: .toSeq)
        complete = try container.decode(Bool.self, forKey: .complete)
        frames = try container.decode([WsReplayableFrame].self, forKey: .frames)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(WsFrameType.syncResponse, forKey: .type)
        try container.encode(fromSeq, forKey: .fromSeq)
        try container.encode(toSeq, forKey: .toSeq)
        try container.encode(complete, forKey: .complete)
        try container.encode(frames, forKey: .frames)
    }
}

/// Client → server. Application-level, above any transport ping, because
/// intermediaries terminate and forge transport pings and the client learns nothing.
public struct WsPing: Codable, Equatable, Sendable {
    public let ts: Date

    public init(ts: Date) {
        self.ts = ts
    }

    private enum CodingKeys: String, CodingKey {
        case type, ts
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try WsFrame.expect(.ping, in: container, forKey: CodingKeys.type)
        ts = try container.decode(Date.self, forKey: .ts)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(WsFrameType.ping, forKey: .type)
        try container.encode(ts, forKey: .ts)
    }
}

/// Server → client. Echoes the client `ts` and adds the server's own clock.
public struct WsPong: Codable, Equatable, Sendable {
    public let ts: Date
    public let serverTime: Date

    public init(ts: Date, serverTime: Date) {
        self.ts = ts
        self.serverTime = serverTime
    }

    private enum CodingKeys: String, CodingKey {
        case type, ts, serverTime
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try WsFrame.expect(.pong, in: container, forKey: CodingKeys.type)
        ts = try container.decode(Date.self, forKey: .ts)
        serverTime = try container.decode(Date.self, forKey: .serverTime)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(WsFrameType.pong, forKey: .type)
        try container.encode(ts, forKey: .ts)
        try container.encode(serverTime, forKey: .serverTime)
    }
}

/// Server → client. Carries the same `ApiError` as HTTP, so one error renderer serves
/// both transports.
///
/// `fatal: true` means stop reconnecting and re-pair, rather than loop against a wall.
public struct WsError: Codable, Equatable, Sendable {
    public let error: ApiError
    public let fatal: Bool

    public init(error: ApiError, fatal: Bool) {
        self.error = error
        self.fatal = fatal
    }

    private enum CodingKeys: String, CodingKey {
        case type, error, fatal
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try WsFrame.expect(.error, in: container, forKey: CodingKeys.type)
        error = try container.decode(ApiError.self, forKey: .error)
        fatal = try container.decode(Bool.self, forKey: .fatal)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(WsFrameType.error, forKey: .type)
        try container.encode(error, forKey: .error)
        try container.encode(fatal, forKey: .fatal)
    }
}

// MARK: - Frame unions

public enum WsFrame {
    /// Asserts the `type` discriminator matches the model being decoded.
    ///
    /// Without this, `chat_message` in the client shape and `chat_message` in the
    /// server shape would both decode from whichever bytes happened to fit, which is
    /// exactly the confusion the direction-not-name rule is trying to avoid.
    static func expect<Key: CodingKey>(
        _ expected: WsFrameType,
        in container: KeyedDecodingContainer<Key>,
        forKey key: Key
    ) throws {
        let actual = try container.decode(WsFrameType.self, forKey: key)
        guard actual == expected else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: container,
                debugDescription: "expected frame type \(expected.rawValue), got \(actual.rawValue)"
            )
        }
    }
}

/// Every frame a client may send.
public enum WsClientFrame: Codable, Equatable, Sendable {
    case authResponse(WsAuthResponse)
    case chatMessage(WsClientChatMessage)
    case sync(WsSync)
    case ping(WsPing)

    private enum DiscriminatorKeys: String, CodingKey {
        case type
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DiscriminatorKeys.self)
        switch try container.decode(WsFrameType.self, forKey: .type) {
        case .authResponse: self = .authResponse(try WsAuthResponse(from: decoder))
        case .chatMessage: self = .chatMessage(try WsClientChatMessage(from: decoder))
        case .sync: self = .sync(try WsSync(from: decoder))
        case .ping: self = .ping(try WsPing(from: decoder))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: DiscriminatorKeys.type,
                in: container,
                debugDescription: "\(other.rawValue) is not a client frame"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .authResponse(let frame): try frame.encode(to: encoder)
        case .chatMessage(let frame): try frame.encode(to: encoder)
        case .sync(let frame): try frame.encode(to: encoder)
        case .ping(let frame): try frame.encode(to: encoder)
        }
    }
}

/// Every frame a server may send.
public enum WsServerFrame: Codable, Equatable, Sendable {
    case authChallenge(WsAuthChallenge)
    case connected(WsConnected)
    case chatMessage(WsServerChatMessage)
    case deliveryConfirmation(WsDeliveryConfirmation)
    case presence(WsPresence)
    case syncResponse(WsSyncResponse)
    case pong(WsPong)
    case error(WsError)

    private enum DiscriminatorKeys: String, CodingKey {
        case type
    }

    /// The frame-stream sequence, for the two numbered frames. Nil for everything
    /// else — and `presence` is nil *by design*, not by omission.
    public var seq: Int? {
        switch self {
        case .chatMessage(let frame): return frame.seq
        case .deliveryConfirmation(let frame): return frame.seq
        default: return nil
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DiscriminatorKeys.self)
        switch try container.decode(WsFrameType.self, forKey: .type) {
        case .authChallenge: self = .authChallenge(try WsAuthChallenge(from: decoder))
        case .connected: self = .connected(try WsConnected(from: decoder))
        case .chatMessage: self = .chatMessage(try WsServerChatMessage(from: decoder))
        case .deliveryConfirmation:
            self = .deliveryConfirmation(try WsDeliveryConfirmation(from: decoder))
        case .presence: self = .presence(try WsPresence(from: decoder))
        case .syncResponse: self = .syncResponse(try WsSyncResponse(from: decoder))
        case .pong: self = .pong(try WsPong(from: decoder))
        case .error: self = .error(try WsError(from: decoder))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: DiscriminatorKeys.type,
                in: container,
                debugDescription: "\(other.rawValue) is not a server frame"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .authChallenge(let frame): try frame.encode(to: encoder)
        case .connected(let frame): try frame.encode(to: encoder)
        case .chatMessage(let frame): try frame.encode(to: encoder)
        case .deliveryConfirmation(let frame): try frame.encode(to: encoder)
        case .presence(let frame): try frame.encode(to: encoder)
        case .syncResponse(let frame): try frame.encode(to: encoder)
        case .pong(let frame): try frame.encode(to: encoder)
        case .error(let frame): try frame.encode(to: encoder)
        }
    }
}
