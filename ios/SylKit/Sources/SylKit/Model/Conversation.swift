import Foundation

/// `interactive` is the Commander's own durable thread. `job` lanes hold background
/// work, separated so Syl's inner monologue never interleaves with talking to him.
public enum ConversationLane: String, Codable, Equatable, Sendable, CaseIterable {
    case interactive
    case job
}

public struct Conversation: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    public let lane: ConversationLane
    public let title: String?
    public let createdAt: Date
    public let updatedAt: Date
    public let lastMessageAt: Date?
    public let messageCount: Int

    public init(
        id: SylID,
        lane: ConversationLane,
        title: String?,
        createdAt: Date,
        updatedAt: Date,
        lastMessageAt: Date?,
        messageCount: Int
    ) {
        self.id = id
        self.lane = lane
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastMessageAt = lastMessageAt
        self.messageCount = messageCount
    }

    private enum CodingKeys: String, CodingKey {
        case id, lane, title, createdAt, updatedAt, lastMessageAt, messageCount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(SylID.self, forKey: .id)
        lane = try container.decode(ConversationLane.self, forKey: .lane)
        title = try container.decodeRequiredNullable(String.self, forKey: .title)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        lastMessageAt = try container.decodeRequiredNullable(Date.self, forKey: .lastMessageAt)
        messageCount = try container.decode(Int.self, forKey: .messageCount)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(lane, forKey: .lane)
        try container.encodeRequiredNullable(title, forKey: .title)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
        try container.encodeRequiredNullable(lastMessageAt, forKey: .lastMessageAt)
        try container.encode(messageCount, forKey: .messageCount)
    }
}

public typealias ConversationPage = Page<Conversation>

public enum MessageRole: String, Codable, Equatable, Sendable, CaseIterable {
    case user, assistant, system
}

/// `text` has already had the affect hint stripped by the service. The
/// `<!--affect: concerned 0.6-->` marker a turn may emit drives the `presence`
/// frame and never crosses the wire as message content.
public struct Message: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    public let conversationId: SylID
    /// Echoed back exactly as the client sent it, so an optimistic render can be
    /// reconciled. Null for anything Syl originated.
    public let clientId: String?
    public let role: MessageRole
    public let text: String
    public let createdAt: Date
    /// Monotonic **per conversation**. Not the WebSocket frame sequence — see
    /// `WsDeliveryConfirmation`, which carries both and keeps them apart by name.
    public let seq: Int
    /// In the order they were attached. **Always present, empty when there are none.**
    ///
    /// A client must never have to tell "no attachments" apart from "this server does
    /// not send the field", because those two look identical and mean opposite things
    /// the day a field goes missing. So this is a plain array rather than an optional
    /// one, and ``encode(to:)`` always writes it.
    public let attachments: [Attachment]

    public init(
        id: SylID,
        conversationId: SylID,
        clientId: String?,
        role: MessageRole,
        text: String,
        createdAt: Date,
        seq: Int,
        attachments: [Attachment] = []
    ) {
        self.id = id
        self.conversationId = conversationId
        self.clientId = clientId
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.seq = seq
        self.attachments = attachments
    }

    private enum CodingKeys: String, CodingKey {
        case id, conversationId, clientId, role, text, createdAt, seq, attachments
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(SylID.self, forKey: .id)
        conversationId = try container.decode(SylID.self, forKey: .conversationId)
        clientId = try container.decodeRequiredNullable(String.self, forKey: .clientId)
        role = try container.decode(MessageRole.self, forKey: .role)
        text = try container.decode(String.self, forKey: .text)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        seq = try container.decode(Int.self, forKey: .seq)
        // Tolerant on the way IN, strict on the way OUT, and the asymmetry is
        // deliberate rather than a hedge.
        //
        // The contract makes `attachments` required and the service always sends it, so
        // for a wire response the two spellings never differ. But this same decoder
        // reads the app's **own local rows** — `MessageRecord` stores the encoded
        // `Message` as a payload blob — and every message written to disk before this
        // field existed has no `attachments` key at all. A strict decode would throw on
        // each of them, and because the store maps a whole window at once, the symptom
        // is not one missing bubble: it is the entire transcript disappearing on
        // upgrade, which is a far worse failure than the field-drift this rule guards
        // against. Encoding always emits the key, so a row is repaired the first time
        // it is written back and the round-trip fixture comparison stays exact.
        attachments = try container.decodeIfPresent([Attachment].self, forKey: .attachments) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(conversationId, forKey: .conversationId)
        try container.encodeRequiredNullable(clientId, forKey: .clientId)
        try container.encode(role, forKey: .role)
        try container.encode(text, forKey: .text)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(seq, forKey: .seq)
        try container.encode(attachments, forKey: .attachments)
    }
}

public typealias MessagePage = Page<Message>

/// The client generates `clientId`, renders the bubble immediately as pending, and
/// reconciles when the server confirms. Without it every retry looks like a new
/// message and the optimistic bubble either duplicates or hangs pending forever.
public struct SendMessageRequest: Codable, Equatable, Sendable {
    public let clientId: String
    public let text: String
    /// Optional in the contract; must equal the path parameter when present.
    public let conversationId: SylID?
    /// Ids from `POST /attachments`, in the order they should render.
    ///
    /// Every one must exist and must not already belong to another message; either
    /// failure is `VALIDATION_FAILED` rather than a message that silently loses its
    /// picture.
    ///
    /// **Nil and `[]` are different, and only nil is legal.** The contract says the
    /// field may be omitted but may not be present-and-empty, because an empty array is
    /// a client that meant to omit the field and is worth saying so about. The
    /// initialiser normalises an empty array to nil rather than making every call site
    /// remember, and ``encode(to:)`` omits the key entirely when there is nothing to
    /// attach — so a text-only send is byte-identical to what it was before this field
    /// existed.
    public let attachmentIds: [SylID]?

    public init(
        clientId: String,
        text: String,
        conversationId: SylID?,
        attachmentIds: [SylID]? = nil
    ) {
        self.clientId = clientId
        self.text = text
        self.conversationId = conversationId
        self.attachmentIds = (attachmentIds?.isEmpty ?? true) ? nil : attachmentIds
    }

    private enum CodingKeys: String, CodingKey {
        case clientId, text, conversationId, attachmentIds
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        clientId = try container.decode(String.self, forKey: .clientId)
        text = try container.decode(String.self, forKey: .text)
        conversationId = try container.decodeIfPresent(SylID.self, forKey: .conversationId)
        attachmentIds = try container.decodeIfPresent([SylID].self, forKey: .attachmentIds)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(clientId, forKey: .clientId)
        try container.encode(text, forKey: .text)
        try container.encodeRequiredNullable(conversationId, forKey: .conversationId)
        try container.encodeIfPresent(attachmentIds, forKey: .attachmentIds)
    }
}

/// The HTTP half of optimistic-send reconciliation.
///
/// **`seq` here is the MESSAGE sequence.** This is the one place the bare name
/// means the message space: there is no frame stream in an HTTP response to have a
/// position in. It is spelled this way so a client that sent over HTTP because the
/// socket was down reconciles with exactly the same code path.
public struct DeliveryConfirmation: Codable, Equatable, Sendable {
    public let clientId: String
    public let serverId: SylID
    public let conversationId: SylID
    public let seq: Int
    public let acceptedAt: Date

    public init(
        clientId: String,
        serverId: SylID,
        conversationId: SylID,
        seq: Int,
        acceptedAt: Date
    ) {
        self.clientId = clientId
        self.serverId = serverId
        self.conversationId = conversationId
        self.seq = seq
        self.acceptedAt = acceptedAt
    }
}
