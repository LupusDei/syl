import Foundation

/// Every resource `GET /sync` can name.
///
/// **A value this enum does not know must never fail the page.** ``SyncChange/type`` is
/// non-optional, so an unrecognised string used to fail the decode of the change, which
/// failed the decode of the array, which failed the whole page — every pass, for as long
/// as the row existed. Not a change skipped: sync stopped.
///
/// The old answer was "keep this list complete". That is not achievable, because **the
/// app and the server ship separately in both directions**. A server ahead of the phone
/// sends a type this build has never heard of; a phone ahead of the server still
/// receives types the server has stopped writing but has not yet finished draining.
/// `syl-020` produced the second case exactly: `job` and `run` left the contract, and
/// between this build reaching a device and the migration reaching the service, every
/// page would have carried a `job` row this enum could not name — and sync would have
/// died completely, silently, for anyone who updated first.
///
/// So an unknown value decodes to ``unrecognised`` and is ignored like any other type
/// the device does not store. Completeness is now a nicety rather than a load-bearing
/// promise, which is the only version of this that survives contact with deploys.
public enum SyncResourceType: String, Codable, Equatable, Sendable, CaseIterable {
    // `job` and `run` were here until `syl-020`. They were 98% of the change log and
    // no client stored one — the admin reads `/jobs` and `/runs` directly and the phone
    // discarded them on arrival — so they are no longer synced resources at all. Listing
    // a type that is never logged would rebuild the trap the sync service warns about:
    // an endpoint answering 200 with an empty page, forever, for a resource that
    // silently never arrives.
    case conversation, message, reminder, todo, goal, device, delivery, sending

    /// A type this build has never heard of. Never sent, only received.
    case unrecognised

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SyncResourceType(rawValue: raw) ?? .unrecognised
    }
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
