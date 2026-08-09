import Foundation
import GRDB
import SylKit

/// The device's database.
///
/// **The device is the source of truth for the UI.** Conversation, reminders and
/// to-dos render from disk, instantly, on launch; the network is an optimisation that
/// brings the disk up to date. Adjutant has no client database and shows a spinner on
/// every cold start — defensible for a dashboard on WiFi watching a server that is
/// usually up, wrong for a phone-first assistant on cellular talking to a home Mac
/// that reboots. Something checked a dozen times a day cannot open on a spinner.
///
/// ## Why the rows are JSON with indexed columns beside them
///
/// Each table stores the contract model as a JSON payload plus the handful of columns
/// the UI actually filters and sorts on. The alternative — a column per field —
/// duplicates `openapi.yaml` in a third place and turns every additive contract change
/// into a migration.
///
/// The shape of a payload is already pinned by the contract gate in `SylKitTests`, so
/// a column-per-field schema would buy no additional safety here; it would only add a
/// second definition to keep in step. Indexes go on the columns queries need, and
/// nothing else does.
///
/// ## Why every id column is `COLLATE NOCASE`
///
/// The contract's `Id` pattern permits either hex case and the service accepts both,
/// though it only ever mints lower case. That asymmetry is a trap: two spellings the
/// contract says are the same resource would compare unequal in SQLite's default
/// binary collation, and the symptom is a duplicated row rather than an error. Putting
/// the rule in the schema means no query has to remember it.
struct SylDatabase: Sendable {
    let queue: DatabaseQueue

    private init(queue: DatabaseQueue) {
        self.queue = queue
    }

    /// The on-disk database, in Application Support.
    ///
    /// Not in Caches: the whole point is that it survives, and the system reclaims
    /// Caches under pressure. Excluded from iCloud backup would be wrong too — a
    /// restored phone should open on his conversation, not a spinner.
    static func onDisk(
        at url: URL? = nil,
        fileManager: FileManager = .default
    ) throws -> SylDatabase {
        let url = try url ?? defaultURL(fileManager: fileManager)
        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        var configuration = Configuration()
        // Reads never block writes and writes never block reads. The chat view reads
        // on every frame of a scroll; the sync engine writes a page at a time.
        configuration.prepareDatabase { db in
            try db.execute(sql: "PRAGMA journal_mode = WAL")
            try db.execute(sql: "PRAGMA foreign_keys = ON")
        }

        let queue = try DatabaseQueue(path: url.path, configuration: configuration)
        try migrator.migrate(queue)
        return SylDatabase(queue: queue)
    }

    /// An empty database that never touches disk. Every store test uses one.
    static func inMemory() throws -> SylDatabase {
        let queue = try DatabaseQueue()
        try migrator.migrate(queue)
        return SylDatabase(queue: queue)
    }

    static func defaultURL(fileManager: FileManager = .default) throws -> URL {
        let support = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return support.appendingPathComponent("Syl/syl.sqlite")
    }

    // MARK: - Migrations

    static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()

        migrator.registerMigration("v1") { db in
            try db.create(table: "conversation") { table in
                table.primaryKey("id", .text).collate(.nocase)
                table.column("lane", .text).notNull()
                table.column("lastMessageAt", .datetime)
                table.column("updatedAt", .datetime).notNull()
                table.column("payload", .blob).notNull()
            }

            try db.create(table: "message") { table in
                table.primaryKey("id", .text).collate(.nocase)
                table.column("conversationId", .text).notNull().collate(.nocase)
                // Zero until the server confirms. A pending message has no position in
                // the conversation yet, because the server has not given it one.
                table.column("seq", .integer).notNull()
                table.column("createdAt", .datetime).notNull()
                table.column("clientId", .text)
                // The optimistic bubble. Rendered immediately, reconciled by clientId.
                table.column("pending", .boolean).notNull().defaults(to: false)
                table.column("payload", .blob).notNull()
            }
            try db.create(
                index: "message_on_conversation",
                on: "message",
                columns: ["conversationId", "createdAt"]
            )
            // Reconciliation looks the row up by clientId, and there can only be one.
            try db.create(
                index: "message_on_clientId",
                on: "message",
                columns: ["clientId"],
                options: .unique,
                condition: Column("clientId") != nil
            )

            try db.create(table: "reminder") { table in
                table.primaryKey("id", .text).collate(.nocase)
                table.column("nextFireAt", .datetime).notNull()
                table.column("deliveryState", .text).notNull()
                table.column("urgent", .boolean).notNull()
                table.column("updatedAt", .datetime).notNull()
                table.column("payload", .blob).notNull()
            }
            try db.create(
                index: "reminder_on_nextFireAt",
                on: "reminder",
                columns: ["nextFireAt"]
            )

            try db.create(table: "todo") { table in
                table.primaryKey("id", .text).collate(.nocase)
                table.column("status", .text).notNull()
                table.column("dueAt", .datetime)
                table.column("pinned", .boolean).notNull()
                table.column("updatedAt", .datetime).notNull()
                table.column("payload", .blob).notNull()
            }

            try db.create(table: "outbox") { table in
                table.autoIncrementedPrimaryKey("id")
                // The structural guarantee. Enqueueing the same intent twice is a
                // no-op at the schema level rather than a rule someone has to
                // remember, because this design retries by intent and will duplicate
                // without it.
                table.column("idempotencyKey", .text).notNull().unique()
                table.column("kind", .text).notNull()
                table.column("targetId", .text).collate(.nocase)
                table.column("payload", .blob)
                table.column("createdAt", .datetime).notNull()
                table.column("attempts", .integer).notNull().defaults(to: 0)
                table.column("lastError", .text)
                // Set when an intent may already have taken effect and the service
                // does not deduplicate that kind. Neither retried nor discarded.
                table.column("blockedReason", .text)
            }
            try db.create(index: "outbox_on_createdAt", on: "outbox", columns: ["createdAt"])

            try db.create(table: "syncState") { table in
                // One row, ever. The primary key is a constant so a second row cannot
                // exist to disagree with the first.
                table.primaryKey("id", .text).collate(.nocase)
                table.column("cursor", .text)
                table.column("lastFrameSeq", .integer).notNull().defaults(to: 0)
            }
        }

        // `syl-47j`. A frame sequence only means anything inside one run of the
        // server; restored on the next launch without the run it came from, it is a
        // position in a stream that no longer exists, and the app goes deaf holding
        // it. Nullable and separately migrated because a device upgrading into this
        // has a mark whose run genuinely is unknown, and saying so is what lets the
        // socket take the safe branch once.
        migrator.registerMigration("v2-frame-sequence-knows-its-server-run") { db in
            try db.alter(table: "syncState") { table in
                table.add(column: "serverEpoch", .text)
            }
        }

        return migrator
    }
}
