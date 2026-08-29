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
    /// The same queue, split by what kind of act each row is.
    ///
    /// **`waiting` and `kind` together cannot answer the question this is for.** `kind`
    /// names the head of the blockage, and the head is very often something else — a
    /// chat message, a delivery ack — so a card built on those two says *"something is
    /// stuck"* when the question actually being asked of it is *"are the things he
    /// finished still in there?"*. Those are different facts, and only one of them tells
    /// him his work is safe rather than telling him to do it again.
    ///
    /// **Best-effort, and never the source of `waiting`.** A row whose stored `kind` this
    /// build cannot decode is absent here and still counted in the total, because a
    /// total summed from a breakdown would silently shrink on a downgrade — and a number
    /// that under-reports what is stuck is the same lie as showing no notice at all.
    var waitingByKind: [OutboxRecord.Kind: Int]
    /// How many rows this build cannot name, and therefore cannot send (`syl-e213`).
    ///
    /// **A stall condition in its own right, not a footnote.** The push now walks past
    /// such a row rather than dying on it, which means it is never attempted — so it
    /// never records a `lastError`, and a card triggered only by "something failed" would
    /// never mention it. The queue would move again and one of his intents would sit
    /// there forever with nothing anywhere saying so, which is the silent discard this
    /// whole area exists to prevent, arriving by a slower road.
    var unreadable: Int
    /// When he did the oldest thing that has not reached Syl.
    ///
    /// The oldest *intent*, never the last attempt. The last attempt is thirty seconds
    /// ago on every reading, and dating the stall from it would make a three-day outage
    /// read as a momentary one — which is exactly how three days passed.
    var since: Date
    /// What kind of act is at the head of the blockage, when this build can name it.
    ///
    /// `nil` for a stored `kind` with no case in the enum — a downgrade, a row written
    /// by a newer build. The notice still appears and still counts the queue, because
    /// "I cannot name what I am stuck on" is a far better answer than no card at all.
    var kind: OutboxRecord.Kind?
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

    /// Every `kind` this build can turn back into a request.
    ///
    /// **Derived from the enum rather than written down**, so it cannot drift: adding a
    /// case makes that kind readable here in the same commit. The same "when two things
    /// must agree, make one a function of the other" rule the rest of this project runs
    /// on.
    private static let readableKinds: [String] = OutboxRecord.Kind.allCases.map(\.rawValue)

    /// The queue, oldest first. Order matters: a message sent before a snooze should
    /// reach the server in that order, because the Commander did them in that order.
    ///
    /// Blocked rows are excluded — they are not gone, they are waiting for a decision.
    ///
    /// **So are rows whose `kind` this build cannot name, and that filter is a bug fix
    /// rather than a nicety (`syl-e213`).** `OutboxRecord` is `Codable` and `kind` is an
    /// enum, so decoding an unknown string throws `dataCorrupted` — **for the fetch, not
    /// for the row.** One unnameable row therefore made this whole read throw,
    /// `SyncEngine.pushOutbox` caught it at "could not read the outbox" and returned, and
    /// every intent behind it was stuck for good. Filtering in SQL means no unknown
    /// string ever reaches the decoder, so the queue walks past it instead of dying on
    /// it.
    ///
    /// **Skipped is not discarded.** The row stays, with its payload — which for a
    /// message is the only surviving copy of what he said — and `stall` counts it and
    /// says so, because a row silently stepped over forever is the discard this project
    /// forbids arriving by a slower road.
    func pending(limit: Int = 100) throws -> [OutboxRecord] {
        try database.queue.read { db in
            try OutboxRecord
                .filter(Column("blockedReason") == nil)
                .filter(Self.readableKinds.contains(Column("kind")))
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
            try OutboxRecord
                .filter(Column("idempotencyKey") == idempotencyKey)
                .filter(Self.readableKinds.contains(Column("kind")))
                .fetchOne(db)
        }
    }

    /// Rows that may already have taken effect and cannot be replayed safely. Shown to
    /// the Commander rather than silently retried or silently dropped.
    func blocked() throws -> [OutboxRecord] {
        try database.queue.read { db in
            try OutboxRecord
                .filter(Column("blockedReason") != nil)
                .filter(Self.readableKinds.contains(Column("kind")))
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
            // **Raw columns, never a decoded `OutboxRecord`.** `kind` is an enum, and
            // decoding a row whose stored string has no case THROWS — so a queue holding
            // one unnameable row would make the notice ABOUT that queue fail to appear
            // at all. An instrument that breaks on exactly the data indicating trouble
            // is worse than no instrument, and this file exists because a report nobody
            // could read is the same as no report. Nothing below decodes anything that
            // can fail.
            //
            // Four narrow reads rather than loading the table and folding it in Swift,
            // so this stays cheap however long the queue is — and a queue that has
            // genuinely stalled is precisely the one that grows.
            guard
                let oldest = try Row.fetchOne(
                    db, sql: "SELECT createdAt FROM outbox ORDER BY createdAt, id LIMIT 1"),
                let since = oldest["createdAt"] as Date?
            else { return nil }

            // Blocked rows are looked at as well as failed ones, and this is not belt
            // and braces: `pending` excludes a blocked row, so it is invisible to the
            // push AND — before this — to every surface. Parked forever, with nothing
            // anywhere saying so, is the same defect this whole file is about.
            let culprit = try Row.fetchOne(
                db,
                sql: """
                    SELECT kind, lastError, blockedReason FROM outbox
                     WHERE blockedReason IS NOT NULL OR lastError IS NOT NULL
                     ORDER BY createdAt, id LIMIT 1
                    """)
            let failure = culprit.flatMap {
                ($0["blockedReason"] as String?) ?? ($0["lastError"] as String?)
            }

            // A row this build cannot name is skipped by the push, so it never fails and
            // never records an error. It is therefore its own trigger — see
            // `OutboxStall.unreadable`.
            //
            // `NOT IN` is safe here and is not safe in general: over a set containing a
            // NULL it evaluates to NULL rather than true, which is why
            // `LocalStore.settleOptimisticMarkers` had to use `NOT EXISTS` instead. The
            // set here is a literal list of non-null enum raw values and `kind` is
            // `NOT NULL` in the schema, so neither side can be NULL.
            let unreadable = try Int.fetchOne(
                db,
                sql: """
                    SELECT COUNT(*) FROM outbox
                     WHERE kind NOT IN (\(Self.readableKinds.map { _ in "?" }.joined(separator: ", ")))
                    """,
                arguments: StatementArguments(Self.readableKinds)
            ) ?? 0

            guard failure != nil || unreadable > 0 else { return nil }

            // Grouped in SQL. A `kind` with no case in the enum is dropped here and is
            // still in `waiting` — see the field's own note for why that asymmetry is
            // deliberate rather than an oversight.
            var byKind: [OutboxRecord.Kind: Int] = [:]
            for row in try Row.fetchAll(
                db, sql: "SELECT kind, COUNT(*) AS n FROM outbox GROUP BY kind")
            {
                guard
                    let raw = row["kind"] as String?,
                    let kind = OutboxRecord.Kind(rawValue: raw),
                    let count = row["n"] as Int?
                else { continue }
                byKind[kind] = count
            }

            return OutboxStall(
                waiting: try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM outbox") ?? 0,
                waitingByKind: byKind,
                unreadable: unreadable,
                since: since,
                kind: (culprit?["kind"] as String?).flatMap(OutboxRecord.Kind.init(rawValue:)),
                // Synthesised only when there is genuinely no error to quote — a row that
                // was skipped rather than attempted. That is not a friendly stand-in for
                // a real failure, which this file forbids; it is the actual reason, and
                // the only one there is.
                reason: failure ?? "This version of the app does not recognise it.",
                blocked: culprit?["blockedReason"] as String? != nil
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
