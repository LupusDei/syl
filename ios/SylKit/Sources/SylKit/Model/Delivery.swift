import Foundation

/// `adjutant` is the interim channel — an MCP tool inside the model's subprocess,
/// which is exactly why it is being replaced. A model can decline to call a tool.
public enum DeliveryChannel: String, Codable, Equatable, Sendable, CaseIterable {
    case apns, adjutant, websocket
}

public enum DeliveryState: String, Codable, Equatable, Sendable, CaseIterable {
    case pending, sending, delivered, acknowledged, failed, abandoned
}

/// Feeds the interruption ledger. A message class below 20% engagement over 14 days
/// with at least 5 sends is automatically demoted and the Commander is told once.
public enum DeliveryEngagement: String, Codable, Equatable, Sendable, CaseIterable {
    case delivered
    case opened
    case actedOn = "acted_on"
    case dismissed
    case ignored
}

/// How hard a notification is allowed to interrupt.
///
/// `time-sensitive` breaks through Focus and the Scheduled Summary and needs only the
/// paid developer tier. `critical` would bypass Do Not Disturb and the mute switch but
/// requires an entitlement Apple will not grant a personal assistant, which is why it
/// is not in this enum.
public enum InterruptionLevel: String, Codable, Equatable, Sendable, CaseIterable {
    case passive
    case active
    case timeSensitive = "time-sensitive"
}

/// Self-sufficient by design. The reminder text goes in the body, never an id to
/// fetch: push reaches the phone over Apple's network, which does not touch the
/// tailnet, so a notification must still be readable when the tunnel is down.
public struct DeliveryPayload: Codable, Equatable, Sendable {
    public let title: String
    public let body: String
    public let interruptionLevel: InterruptionLevel
    public let categoryIdentifier: String?
    public let threadIdentifier: String?

    public init(
        title: String,
        body: String,
        interruptionLevel: InterruptionLevel = .active,
        categoryIdentifier: String? = nil,
        threadIdentifier: String? = nil
    ) {
        self.title = title
        self.body = body
        self.interruptionLevel = interruptionLevel
        self.categoryIdentifier = categoryIdentifier
        self.threadIdentifier = threadIdentifier
    }

    private enum CodingKeys: String, CodingKey {
        case title, body, interruptionLevel, categoryIdentifier, threadIdentifier
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try container.decode(String.self, forKey: .title)
        body = try container.decode(String.self, forKey: .body)
        interruptionLevel =
            try container.decodeIfPresent(InterruptionLevel.self, forKey: .interruptionLevel)
            ?? .active
        categoryIdentifier = try container.decodeIfPresent(String.self, forKey: .categoryIdentifier)
        threadIdentifier = try container.decodeIfPresent(String.self, forKey: .threadIdentifier)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(title, forKey: .title)
        try container.encode(body, forKey: .body)
        try container.encode(interruptionLevel, forKey: .interruptionLevel)
        try container.encodeRequiredNullable(categoryIdentifier, forKey: .categoryIdentifier)
        try container.encodeRequiredNullable(threadIdentifier, forKey: .threadIdentifier)
    }
}

/// One outbox row.
///
/// `deliveredAt` means APNs accepted the request. Only `ackedAt` — set by the device
/// through `POST /deliveries/{id}/ack` — marks the row delivered. Apple exposes no
/// query endpoint for delivery status, so the acknowledgement is the only fact we have.
public struct Delivery: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    public let channel: DeliveryChannel
    /// What kind of proactive message this is, for the interruption ledger.
    public let messageClass: String
    public let reminderId: SylID?
    public let payload: DeliveryPayload
    public let idempotencyKey: String
    public let state: DeliveryState
    public let attempts: Int
    public let nextAttemptAt: Date?
    public let deliveredAt: Date?
    public let ackedAt: Date?
    public let engagement: DeliveryEngagement?
    public let late: Bool
    public let scheduledFor: Date?
    /// Non-empty when this row is the single "here is what waited overnight"
    /// notification for a batch deferred past quiet hours.
    public let coalescedReminderIds: [SylID]
    /// Opaque forensics only — there is no public query endpoint, which is precisely
    /// why the client ack exists.
    public let apnsUniqueId: String?
    public let lastError: String?
    public let createdAt: Date

    public init(
        id: SylID,
        channel: DeliveryChannel,
        messageClass: String,
        reminderId: SylID?,
        payload: DeliveryPayload,
        idempotencyKey: String,
        state: DeliveryState,
        attempts: Int,
        nextAttemptAt: Date?,
        deliveredAt: Date?,
        ackedAt: Date?,
        engagement: DeliveryEngagement?,
        late: Bool,
        scheduledFor: Date?,
        coalescedReminderIds: [SylID],
        apnsUniqueId: String?,
        lastError: String?,
        createdAt: Date
    ) {
        self.id = id
        self.channel = channel
        self.messageClass = messageClass
        self.reminderId = reminderId
        self.payload = payload
        self.idempotencyKey = idempotencyKey
        self.state = state
        self.attempts = attempts
        self.nextAttemptAt = nextAttemptAt
        self.deliveredAt = deliveredAt
        self.ackedAt = ackedAt
        self.engagement = engagement
        self.late = late
        self.scheduledFor = scheduledFor
        self.coalescedReminderIds = coalescedReminderIds
        self.apnsUniqueId = apnsUniqueId
        self.lastError = lastError
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, channel, messageClass, reminderId, payload, idempotencyKey, state
        case attempts, nextAttemptAt, deliveredAt, ackedAt, engagement, late
        case scheduledFor, coalescedReminderIds, apnsUniqueId, lastError, createdAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(SylID.self, forKey: .id)
        channel = try container.decode(DeliveryChannel.self, forKey: .channel)
        messageClass = try container.decode(String.self, forKey: .messageClass)
        reminderId = try container.decodeRequiredNullable(SylID.self, forKey: .reminderId)
        payload = try container.decode(DeliveryPayload.self, forKey: .payload)
        idempotencyKey = try container.decode(String.self, forKey: .idempotencyKey)
        state = try container.decode(DeliveryState.self, forKey: .state)
        attempts = try container.decode(Int.self, forKey: .attempts)
        nextAttemptAt = try container.decodeRequiredNullable(Date.self, forKey: .nextAttemptAt)
        deliveredAt = try container.decodeRequiredNullable(Date.self, forKey: .deliveredAt)
        ackedAt = try container.decodeRequiredNullable(Date.self, forKey: .ackedAt)
        engagement = try container.decodeRequiredNullable(
            DeliveryEngagement.self, forKey: .engagement)
        late = try container.decode(Bool.self, forKey: .late)
        scheduledFor = try container.decodeRequiredNullable(Date.self, forKey: .scheduledFor)
        coalescedReminderIds = try container.decode([SylID].self, forKey: .coalescedReminderIds)
        apnsUniqueId = try container.decodeRequiredNullable(String.self, forKey: .apnsUniqueId)
        lastError = try container.decodeRequiredNullable(String.self, forKey: .lastError)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(channel, forKey: .channel)
        try container.encode(messageClass, forKey: .messageClass)
        try container.encodeRequiredNullable(reminderId, forKey: .reminderId)
        try container.encode(payload, forKey: .payload)
        try container.encode(idempotencyKey, forKey: .idempotencyKey)
        try container.encode(state, forKey: .state)
        try container.encode(attempts, forKey: .attempts)
        try container.encodeRequiredNullable(nextAttemptAt, forKey: .nextAttemptAt)
        try container.encodeRequiredNullable(deliveredAt, forKey: .deliveredAt)
        try container.encodeRequiredNullable(ackedAt, forKey: .ackedAt)
        try container.encodeRequiredNullable(engagement, forKey: .engagement)
        try container.encode(late, forKey: .late)
        try container.encodeRequiredNullable(scheduledFor, forKey: .scheduledFor)
        try container.encode(coalescedReminderIds, forKey: .coalescedReminderIds)
        try container.encodeRequiredNullable(apnsUniqueId, forKey: .apnsUniqueId)
        try container.encodeRequiredNullable(lastError, forKey: .lastError)
        try container.encode(createdAt, forKey: .createdAt)
    }
}

public typealias DeliveryPage = Page<Delivery>

/// The only thing that marks a reminder delivered. The device retries this call by
/// design, and acknowledging an already-acknowledged delivery is a no-op.
public struct AcknowledgeDeliveryRequest: Codable, Equatable, Sendable {
    /// When the device saw it — which may be well after `deliveredAt`.
    public let ackedAt: Date
    public let engagement: DeliveryEngagement?

    public init(ackedAt: Date, engagement: DeliveryEngagement? = nil) {
        self.ackedAt = ackedAt
        self.engagement = engagement
    }

    private enum CodingKeys: String, CodingKey {
        case ackedAt, engagement
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ackedAt = try container.decode(Date.self, forKey: .ackedAt)
        engagement = try container.decodeIfPresent(DeliveryEngagement.self, forKey: .engagement)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(ackedAt, forKey: .ackedAt)
        try container.encodeIfPresent(engagement, forKey: .engagement)
    }
}
