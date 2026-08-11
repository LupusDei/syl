import Foundation

/// Every resource `GET /sync` can name.
///
/// **This list has to be complete, not merely sufficient.** ``SyncChange/type`` is a
/// non-optional enum, so one value this enum does not know fails the decode of the
/// change, which fails the decode of the array, which fails the whole page — every pass,
/// for as long as the row exists. It is not a change that is skipped; it is sync that
/// stops. `sending` was added to the contract with the sendings backend and is here for
/// that reason, whether or not the client stores one.
public enum SyncResourceType: String, Codable, Equatable, Sendable, CaseIterable {
    case conversation, message, reminder, todo, goal, device, delivery, job, run, sending
}

public enum SyncChangeOp: String, Codable, Equatable, Sendable, CaseIterable {
    case upsert, delete
}

/// One change in a `GET /sync` page.
///
/// `resource` stays untyped on purpose: the contract types it by the sibling `type`
/// field, so a client switches on `type` and decodes the matching model. Use
/// `decodeResource(as:)` rather than reaching into the `JSONValue` by hand.
public struct SyncChange: Codable, Equatable, Sendable {
    public let type: SyncResourceType
    public let op: SyncChangeOp
    public let id: SylID
    public let at: Date
    /// The full resource for `upsert`, null for `delete`.
    public let resource: JSONValue?

    public init(type: SyncResourceType, op: SyncChangeOp, id: SylID, at: Date, resource: JSONValue?) {
        self.type = type
        self.op = op
        self.id = id
        self.at = at
        self.resource = resource
    }

    private enum CodingKeys: String, CodingKey {
        case type, op, id, at, resource
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(SyncResourceType.self, forKey: .type)
        op = try container.decode(SyncChangeOp.self, forKey: .op)
        id = try container.decode(SylID.self, forKey: .id)
        at = try container.decode(Date.self, forKey: .at)
        resource = try container.decodeRequiredNullable(JSONValue.self, forKey: .resource)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(op, forKey: .op)
        try container.encode(id, forKey: .id)
        try container.encode(at, forKey: .at)
        try container.encodeRequiredNullable(resource, forKey: .resource)
    }

    /// Re-decodes `resource` into a concrete model.
    ///
    /// Returns nil for a `delete`, which carries no resource. Throws if the payload
    /// does not match the requested type — a mismatch there is a contract failure and
    /// should be loud, not skipped.
    public func decodeResource<T: Decodable>(as type: T.Type) throws -> T? {
        guard let resource else { return nil }
        let data = try SylJSON.encoder().encode(resource)
        return try SylJSON.decoder().decode(T.self, from: data)
    }
}

/// The device's half of "push outbox → pull since cursor → reconcile → ack".
///
/// **This is not the WebSocket `sync` frame.** That one recovers a gap on one socket
/// by sequence number and does not survive a reinstall. This one is durable, covers
/// every resource type, and its parameter is an opaque cursor rather than a sequence
/// — the names differ so the two cannot be conflated.
public struct SyncResponse: Codable, Equatable, Sendable {
    /// Pass as `since` next time. Opaque; do not parse it.
    public let cursor: String
    /// Keep calling while true. A device back from a week away will page.
    public let hasMore: Bool
    public let changes: [SyncChange]
    public let serverTime: Date

    public init(cursor: String, hasMore: Bool, changes: [SyncChange], serverTime: Date) {
        self.cursor = cursor
        self.hasMore = hasMore
        self.changes = changes
        self.serverTime = serverTime
    }
}
