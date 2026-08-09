import Foundation
import GRDB
import SylKit

/// One queued intent.
///
/// The outbox stores what the Commander *meant*, not an HTTP request. That is what
/// lets it survive a relaunch, a server that was down when he acted, and a schema the
/// app did not have yet — and it is why the idempotency key is minted once, here, and
/// reused across every attempt. A key regenerated per attempt is the same as having no
/// key at all.
struct OutboxRecord: Codable, FetchableRecord, MutablePersistableRecord, Equatable, Sendable {
    static let databaseTableName = "outbox"

    /// What the Commander did. A closed catalogue: the outbox may replay an intent, it
    /// may never invent one.
    enum Kind: String, Codable, Sendable, CaseIterable {
        case sendMessage
        case acknowledgeDelivery
        /// The authority for this one is the server's. The device only ever asks.
        case snoozeReminder
        case completeReminder
        case completeTodo
        case createTodo
        case createReminder
    }

    var id: Int64?
    var idempotencyKey: String
    var kind: Kind
    /// The conversation, delivery, reminder or to-do this acts on. Nil for a create.
    var targetId: SylID?
    /// The encoded request body, or nil for the intents that have none.
    var payload: Data?
    var createdAt: Date
    var attempts: Int
    var lastError: String?

    init(
        id: Int64? = nil,
        idempotencyKey: String,
        kind: Kind,
        targetId: SylID? = nil,
        payload: Data? = nil,
        createdAt: Date,
        attempts: Int = 0,
        lastError: String? = nil
    ) {
        self.id = id
        self.idempotencyKey = idempotencyKey
        self.kind = kind
        self.targetId = targetId
        self.payload = payload
        self.createdAt = createdAt
        self.attempts = attempts
        self.lastError = lastError
    }

    mutating func didInsert(_ inserted: InsertionSuccess) {
        id = inserted.rowID
    }

    func decodePayload<T: Decodable>(as type: T.Type) throws -> T {
        guard let payload else {
            throw OutboxError.missingPayload(kind: kind)
        }
        return try SylJSON.decoder().decode(T.self, from: payload)
    }
}

enum OutboxError: Error, Equatable, CustomStringConvertible {
    case missingPayload(kind: OutboxRecord.Kind)

    var description: String {
        switch self {
        case .missingPayload(let kind):
            return "outbox row of kind \(kind.rawValue) has no payload to send"
        }
    }
}

/// The queue of intents waiting to reach the service.
///
/// Enqueueing is idempotent by construction: `idempotencyKey` is `UNIQUE` in the
/// schema, so the same intent queued twice — a double tap, a retried notification
/// action, a replayed launch path — is one row. That is a database constraint rather
/// than a code path anyone can forget.
struct Outbox: Sendable {
    let database: SylDatabase

    init(database: SylDatabase) {
        self.database = database
    }

    /// Adds an intent, or returns the existing one if this key is already queued.
    @discardableResult
    func enqueue(_ record: OutboxRecord) throws -> OutboxRecord {
        try database.queue.write { db in
            if let existing = try OutboxRecord
                .filter(Column("idempotencyKey") == record.idempotencyKey)
                .fetchOne(db)
            {
                return existing
            }
            var record = record
            try record.insert(db)
            return record
        }
    }

    /// The queue, oldest first. Order matters: a message sent before a snooze should
    /// reach the server in that order, because the Commander did them in that order.
    func pending(limit: Int = 100) throws -> [OutboxRecord] {
        try database.queue.read { db in
            try OutboxRecord
                .order(Column("createdAt"), Column("id"))
                .limit(limit)
                .fetchAll(db)
        }
    }

    func count() throws -> Int {
        try database.queue.read { db in try OutboxRecord.fetchCount(db) }
    }

    /// The intent reached the server. The row goes away — and only here.
    func complete(_ record: OutboxRecord) throws {
        guard let id = record.id else { return }
        _ = try database.queue.write { db in
            try OutboxRecord.deleteOne(db, key: id)
        }
    }

    /// The attempt failed. The row stays, because a dropped intent is the failure this
    /// whole mechanism exists to prevent — the count and the reason are recorded so the
    /// app can say what is stuck rather than pretending everything is fine.
    func recordFailure(_ record: OutboxRecord, error: String) throws {
        guard let id = record.id else { return }
        try database.queue.write { db in
            try db.execute(
                sql: "UPDATE outbox SET attempts = attempts + 1, lastError = ? WHERE id = ?",
                arguments: [error, id]
            )
        }
    }

    /// Drops an intent that can never succeed — a validation failure will fail
    /// identically forever, and retrying it blocks everything behind it.
    func abandon(_ record: OutboxRecord) throws {
        try complete(record)
    }
}
