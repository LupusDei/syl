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

        // `syl-011.1`. Three things the device could not previously hold: a goal at
        // all, the link from a to-do to the goal it serves, and the fact that a write
        // has been asked for but not yet answered.
        migrator.registerMigration("v3-goals-and-the-optimistic-half") { db in
            // Mirrors `backend/src/migrations/0009_todos_goals.sql`, whose header states
            // the two refusals this table is built around. **There is no
            // percent-complete column and no priority column**, and neither is an
            // omission: self-reported percentages are fiction and they decay, and
            // priority is a property of a moment rather than of a task. Progress is
            // evidenced — by `todo.goalId` below — and never asserted.
            try db.create(table: "goal") { table in
                table.primaryKey("id", .text).collate(.nocase)

                // Goals self-nest. A NULL parent is a root goal, and nothing enforces
                // the depth because a life does not have a fixed number of levels in it.
                //
                // Deliberately **not** a foreign key, which is where this diverges from
                // the server's schema on purpose. `GET /sync` pages by `updatedAt` and
                // knows nothing about the hierarchy, so a child routinely arrives before
                // its parent; with `PRAGMA foreign_keys = ON` that upsert would throw,
                // `SyncEngine.apply` would file it as an unreadable change, and the goal
                // would simply never appear. The server can afford the constraint
                // because it writes parents first. A client cannot choose its order.
                table.column("parentId", .text).collate(.nocase)

                table.column("title", .text).notNull()

                // `YYYY-MM-DD`, stored as the contract's text rather than a date, so
                // lexicographic order IS chronological order and the read needs no
                // conversion. The horizon — life / year / season / month — is DERIVED
                // from this and never stored: a stored horizon and a stored date
                // disagree the moment one of them is edited.
                table.column("targetDate", .text)

                table.column("status", .text).notNull()
                table.column("updatedAt", .datetime).notNull()
                table.column("payload", .blob).notNull()
            }
            try db.create(index: "goal_on_parentId", on: "goal", columns: ["parentId"])
            // The list's order, materialised: target date, then title.
            try db.create(index: "goal_on_targetDate", on: "goal", columns: ["targetDate", "title"])

            try db.alter(table: "todo") { table in
                // The link that makes a goal's progress evidenced rather than asserted.
                // It has always been in the payload; it was never queryable.
                table.add(column: "goalId", .text).collate(.nocase)

                // The idempotency key of the capture that created this row, or NULL for
                // a row the server sent. It is what makes an optimistic to-do
                // retirable: the contract has no `clientId` for a to-do, so the key is
                // the only thing tying the row he sees to the intent that will create
                // the server's copy of it. See `LocalStore.settleOptimisticMarkers`.
                table.add(column: "pendingKey", .text)
            }
            try db.create(index: "todo_on_goalId", on: "todo", columns: ["goalId"])
            try SylDatabase.backfillTodoGoalLinks(db)

            try db.alter(table: "reminder") { table in
                // **The instant he ASKED, and never a new fire time** (`syl-011.1.5`).
                //
                // The server owns a deferral's new instant — constraint 4 and proposal E
                // both say so, and a phone that is wiped, restored or replaced would
                // otherwise take his deferrals with it. So the device stores the one
                // fact it actually knows: that a deferral was requested, and when. The
                // row settles the moment the server's copy of the reminder arrives,
                // because that copy replaces this column with NULL.
                table.add(column: "deferralRequestedAt", .datetime)
            }
        }

        migrator.registerMigration("v4-goals-missed-while-the-cursor-moved-on") { db in
            // **A one-time backfill flag, and the reason it has to exist.**
            //
            // `SyncEngine.pullChanges` writes the cursor after every page whether or not
            // anything in that page was applied. While `.goal` was in the ignore list,
            // every goal that came down a page was dropped AND the cursor advanced past
            // it — and `GET /sync` only ever returns changes since the cursor, so those
            // rows are never sent again.
            //
            // The Commander hit it immediately: three goals on the server, one on the
            // phone. Not a display bug and not a stale cache — the device had genuinely
            // never been told, and had recorded that it was up to date.
            //
            // Turning `.goal` on fixes it for every goal touched from now on and cannot
            // recover one that is simply sitting there unchanged. So the device fetches
            // the list once, directly, and records that it has.
            try db.alter(table: "syncState") { table in
                table.add(column: "goalsBackfilledAt", .datetime)
            }
        }

        // `syl-ryp.1`. The sky, held whole.
        migrator.registerMigration("v5-the-constellation-is-a-snapshot-not-a-row-set") { db in
            // **One row holding the whole payload, and that is the decision worth
            // reading before changing it.**
            //
            // Every other table here is rows keyed by server id, upserted one at a
            // time from the sync feed, because every other resource IS a row: a
            // to-do exists, changes and is deleted, and the device's copy tracks
            // those events. `GET /memory/constellation` is not that. It returns a
            // bounded REGION of the graph — the anchors, what orbits them, and the
            // most connected of what is left — and membership changes wholesale as
            // salience shifts, with no event saying so.
            //
            // Store it as rows and the honest-looking `upsert` is a slow leak: a
            // star that drops out of the region is not deleted server-side, so
            // nothing ever tells the device to remove it. The local sky would only
            // ever grow, diverging further from what the server would draw, and it
            // would look right the whole time.
            //
            // A whole-snapshot replace also makes the read atomic. The phone draws
            // the last complete sky it was given or it draws nothing — never half
            // of one sky and half of another, which is the one failure a
            // constellation cannot survive: a filament whose star is from a
            // different fetch is a line into nothing.
            //
            // `bound` travels inside the payload for the same reason. It is the
            // response's own statement about what it left out, and a device that
            // kept the stars while discarding `mayHaveMore` would be free to imply
            // it holds everything she remembers.
            try db.create(table: "constellation") { table in
                table.primaryKey("id", .text)
                // When the SERVER generated this sky, from `generatedAt` — not when
                // the device wrote it. The two differ by the length of a request and
                // by any time spent queued, and the age of a memory view is a
                // property of the answer rather than of its delivery.
                table.column("generatedAt", .datetime).notNull()
                table.column("payload", .blob).notNull()
            }
        }

        // `syl-015.4.2`. What she sent him, kept.
        migrator.registerMigration("v6-a-sending-is-kept-not-cached") { db in
            // **Rows, not one snapshot — and the constellation's reasoning is why.**
            //
            // The sky is stored whole because it is a bounded REGION whose membership
            // changes silently: a star that drops out produces no event, so an upsert
            // would grow a local sky the server would never draw. None of that is true
            // here. A sending is an immutable row with a server id that is created and
            // then only ever completed — `video`, `state`, `reason` filled in when the
            // render lands — and one that is not on the newest page has not left any
            // region, it is simply older.
            //
            // **So nothing on this device deletes one either.** Acceptance item 6 is a
            // property of the whole system rather than of the service's triggers, and a
            // store that mirrored a page by removing what the page did not mention
            // would throw away the oldest thing she gave him every time she sent a new
            // one. Rows are written and replaced by id; there is no path here that
            // removes one, and `LocalStore.tableName(for:)` answers nil for `.sending`
            // so the sync feed's delete path has no table to reach either.
            try db.create(table: "sending") { table in
                table.primaryKey("id", .text).collate(.nocase)
                // The list's whole order, and the service's own: newest first, ties
                // broken on the id. Indexed because it is the only query this table has.
                table.column("createdAt", .datetime).notNull()
                // `pending` is the one state that has to be found again cheaply: the
                // video lands minutes later and the device learns of it by asking.
                table.column("state", .text).notNull()
                table.column("payload", .blob).notNull()
            }
            try db.create(
                index: "sending_on_createdAt",
                on: "sending",
                columns: ["createdAt"]
            )
        }

        return migrator
    }

    /// Copies each to-do's `goalId` out of its stored payload and into the column.
    ///
    /// Every row written before the column existed has the link in its JSON and nothing
    /// in its index, so without this the first goal screen after an upgrade says nothing
    /// has ever happened — for every goal, convincingly, and wrongly.
    ///
    /// A row the current decoder cannot read costs its own link and nothing else. A
    /// migration that throws leaves the app unable to open at all, which is a far worse
    /// answer to one bad payload than a goal that is missing one piece of evidence.
    static func backfillTodoGoalLinks(_ db: Database) throws {
        for row in try Row.fetchAll(db, sql: "SELECT id, payload FROM todo") {
            guard
                let id = row["id"] as String?,
                let payload = row["payload"] as Data?,
                let todo = try? SylJSON.decoder().decode(Todo.self, from: payload),
                let goalId = todo.goalId
            else { continue }
            try db.execute(
                sql: "UPDATE todo SET goalId = ? WHERE id = ?",
                arguments: [goalId, id]
            )
        }
    }
}
