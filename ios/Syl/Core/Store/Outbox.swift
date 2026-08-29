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

        /// Whether replaying this intent is safe when we cannot tell whether the first
        /// attempt landed.
        ///
        /// **True for every kind, and that is a recent change.** `Idempotency-Key` has
        /// always been in the contract for every write, but for a long time only
        /// message sends actually deduplicated on it — via a `clientId` unique index —
        /// so this predicate described what the service *did* rather than what the
        /// contract said. `syl-ux1` closed the gap: every implemented write now runs
        /// through the server's idempotency ledger, and the key travels from the row
        /// rather than being minted per attempt.
        ///
        /// The case that made this worth having was `snoozeReminder`. A blind retry
        /// used to defer the reminder by another fifteen minutes, turning one deferral
        /// into two and landing the reminder half an hour late — the quiet kind of
        /// wrong this project cares most about. A retry now replays the server's
        /// stored answer instead of deferring again.
        ///
        /// The parking machinery it guards is deliberately **not** deleted. It is the
        /// honest response if this ever stops being true — a new write that forgets
        /// the ledger, or a retry that arrives after the ledger's 24-hour retention has
        /// dropped the key. Nothing is silently retried that cannot be; the predicate
        /// simply has nothing left to catch.
        var isSafeToReplayBlind: Bool {
            switch self {
            case .sendMessage, .acknowledgeDelivery, .completeReminder, .completeTodo,
                 .snoozeReminder, .createTodo, .createReminder:
                return true
            }
        }
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
    /// Set when the row must not be retried automatically because the first attempt
    /// may have landed and the service does not deduplicate this kind. The row stays —
    /// nothing is ever dropped — but it waits for the Commander rather than risking a
    /// second deferral.
    var blockedReason: String?

    init(
        id: Int64? = nil,
        idempotencyKey: String,
        kind: Kind,
        targetId: SylID? = nil,
        payload: Data? = nil,
        createdAt: Date,
        attempts: Int = 0,
        lastError: String? = nil,
        blockedReason: String? = nil
    ) {
        self.id = id
        self.idempotencyKey = idempotencyKey
        self.kind = kind
        self.targetId = targetId
        self.payload = payload
        self.createdAt = createdAt
        self.attempts = attempts
        self.lastError = lastError
        self.blockedReason = blockedReason
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

/// The queue has stopped moving, and this is what it is stuck on.
///
/// **Derived from the rows on disk, not from a `SyncReport`.** That distinction is the
/// whole fix. `SyncReport.failures` already recorded every one of these and was read by
/// nobody — the report exists only for the duration of a `synchronise()` call, so a
/// screen built on it could answer the question only in the instant it stopped being
/// urgent. This is answerable at any moment, from disk, with the network down and after
/// a relaunch, which is how everything else in this app reads.
///
/// `nil` — not a zeroed value — is what "nothing is stuck" looks like, so a caller
/// cannot render an empty stall as a quiet alarm.
struct OutboxStall: Equatable, Sendable {
    /// Everything still queued, including the blocked rows the push steps over.
    ///
    /// The **whole** queue rather than the number of rows that have themselves failed:
    /// `SyncEngine.pushOutbox` returns at the first recoverable failure, so every row
    /// behind the stuck one is equally undelivered and has simply not been tried yet.
    /// Counting only the failures would report "1 change waiting" while thirty of his
    /// acts sat behind it.
    var waiting: Int
    /// When he did the oldest thing that has not reached Syl.
    ///
    /// The oldest *intent*, never the last attempt. The last attempt is thirty seconds
    /// ago on every reading, and dating the stall from it would make a three-day outage
    /// read as a momentary one — which is exactly how three days passed.
    var since: Date
    /// What kind of act is at the head of the blockage.
    var kind: OutboxRecord.Kind
    /// Why, in the error's own words.
    ///
    /// Unprettified, for the reason `HomeViewModel.loadFailure` gives: the cause of this
    /// class of failure is not known, the device is the only place it happens, and a
    /// tidy stand-in sentence would throw away the only evidence anyone has.
    var reason: String
    /// True when that intent will not be retried automatically at all — it is parked,
    /// waiting for a decision nobody has yet asked him to make.
    var blocked: Bool
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
    ///
    /// Blocked rows are excluded — they are not gone, they are waiting for a decision.
    func pending(limit: Int = 100) throws -> [OutboxRecord] {
        try database.queue.read { db in
            try OutboxRecord
                .filter(Column("blockedReason") == nil)
                .order(Column("createdAt"), Column("id"))
                .limit(limit)
                .fetchAll(db)
        }
    }

    /// The queued intent carrying this key, or nil.
    ///
    /// Used by the delivery reconcile as its own memory: an `ack-<deliveryId>` row is
    /// the durable local evidence that this delivery has already been surfaced to the
    /// Commander. Without it a reconcile that ran twice before the ack reached the
    /// server would show him the same reminder twice.
    func queued(idempotencyKey: String) throws -> OutboxRecord? {
        try database.queue.read { db in
            try OutboxRecord.filter(Column("idempotencyKey") == idempotencyKey).fetchOne(db)
        }
    }

    /// Rows that may already have taken effect and cannot be replayed safely. Shown to
    /// the Commander rather than silently retried or silently dropped.
    func blocked() throws -> [OutboxRecord] {
        try database.queue.read { db in
            try OutboxRecord
                .filter(Column("blockedReason") != nil)
                .order(Column("createdAt"), Column("id"))
                .fetchAll(db)
        }
    }

    func count() throws -> Int {
        try database.queue.read { db in try OutboxRecord.fetchCount(db) }
    }

    /// What is not getting through, or `nil` because everything is.
    ///
    /// **A queue that has simply not been tried yet is not stuck, it is new.** He tapped
    /// two seconds ago and the sync has not run; saying so would train him to ignore the
    /// one notice that matters. So the test is that something has *failed* — an attempt
    /// that recorded an error, or a row parked as blocked — rather than that something
    /// is merely queued.
    ///
    /// There is no age threshold beside that, deliberately. A threshold is another
    /// silence: under it, nothing is said, and "under it" is where every stall begins.
    /// The age is carried out in `since` instead, so a four-second blip and a three-day
    /// outage produce the same notice wearing very different words.
    func stall() throws -> OutboxStall? {
        try database.queue.read { db in
            // Three narrow reads rather than loading the table and folding it in Swift.
            // This runs on every home refresh, once a minute, for the whole life of the
            // app; a queue that has genuinely stalled is exactly the one that grows.
            guard
                let oldest = try OutboxRecord.order(Column("createdAt"), Column("id")).fetchOne(db)
            else { return nil }
            // Blocked rows are looked at as well as failed ones, and this is not belt
            // and braces: `pending` excludes a blocked row, so it is invisible to the
            // push AND — before this — to every surface. Parked forever, with nothing
            // anywhere saying so, is the same defect this whole file is about.
            guard
                let culprit = try OutboxRecord
                    .filter(Column("blockedReason") != nil || Column("lastError") != nil)
                    .order(Column("createdAt"), Column("id"))
                    .fetchOne(db),
                let reason = culprit.blockedReason ?? culprit.lastError
            else { return nil }

            return OutboxStall(
                waiting: try OutboxRecord.fetchCount(db),
                since: oldest.createdAt,
                kind: culprit.kind,
                reason: reason,
                blocked: culprit.blockedReason != nil
            )
        }
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

    /// Parks an intent that may already have taken effect.
    ///
    /// Neither retried nor discarded: retrying risks a second deferral, and discarding
    /// would be the silent drop this project forbids. It waits, visibly, until someone
    /// says which it was.
    func block(_ record: OutboxRecord, reason: String) throws {
        guard let id = record.id else { return }
        try database.queue.write { db in
            try db.execute(
                sql: """
                    UPDATE outbox SET attempts = attempts + 1, lastError = ?, blockedReason = ?
                    WHERE id = ?
                    """,
                arguments: [reason, reason, id]
            )
        }
    }
}
