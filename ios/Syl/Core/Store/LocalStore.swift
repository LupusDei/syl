import Foundation
import GRDB
import SylKit

/// Reads and writes the device's copy of Syl.
///
/// Everything the UI renders comes from here. Nothing in this type waits on the
/// network — that is the definition of local-first, and it is what makes a cold launch
/// show his conversation rather than a spinner.
struct LocalStore: Sendable {
    let database: SylDatabase

    init(database: SylDatabase) {
        self.database = database
    }

    // MARK: - Conversations

    func upsert(_ conversation: Conversation) throws {
        try database.queue.write { db in
            try ConversationRecord(conversation).save(db)
        }
    }

    func conversation(id: SylID) throws -> Conversation? {
        try database.queue.read { db in
            try ConversationRecord.fetchOne(db, key: id)?.model()
        }
    }

    // MARK: - Messages

    /// History, oldest first — which is the order a chat view renders in, so the read
    /// does the sorting rather than every caller.
    /// The most recent `limit` messages, returned oldest-first.
    ///
    /// **The window has to be taken from the recent end, and it was not.** This ordered
    /// ascending and took the first `limit`, which returns the *oldest* `limit`. Under
    /// the window that is invisible — every message fits, so the result is identical.
    /// Past it the screen freezes: chat shows the first 200 messages ever exchanged and
    /// nothing arriving after that is ever visible, no matter how long you scroll. The
    /// bug is silent, gets worse with use, and would have looked like sync failing
    /// rather than like a query being wrong.
    ///
    /// So: order descending to let SQLite pick the newest rows, then reverse in memory
    /// to hand back the reading order a transcript renders in. The reverse is over at
    /// most `limit` rows and costs nothing next to the read.
    func messages(conversationId: SylID, limit: Int = 200) throws -> [Message] {
        try database.queue.read { db in
            try MessageRecord
                .filter(Column("conversationId") == conversationId)
                .order(Column("createdAt").desc, Column("seq").desc)
                .limit(limit)
                .fetchAll(db)
                .reversed()
                .map { try $0.model() }
        }
    }

    /// The highest conversation sequence held for a thread. **Not** the frame-stream
    /// sequence — that lives in `SyncStateRecord.lastFrameSeq` and is a different
    /// number in a different space.
    func highestMessageSeq(conversationId: SylID) throws -> Int {
        try database.queue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT COALESCE(MAX(seq), 0) FROM message WHERE conversationId = ?",
                arguments: [conversationId]
            ) ?? 0
        }
    }

    /// Writes the server's copy of a message, retiring any optimistic row it replaces.
    ///
    /// The retirement is not optional. `message_on_clientId` is a partial UNIQUE index,
    /// so writing the server's copy of a message the Commander sent — same `clientId`,
    /// new `id` — while the pending row is still there violates it and the write
    /// throws. The message would then simply never appear, which is the worst outcome
    /// available: he watched himself type it.
    ///
    /// This is the same reconciliation `reconcile(_:)` performs, arriving by the other
    /// door. A `chat_message` frame and a `delivery_confirmation` frame race, and
    /// either may land first.
    func upsert(_ messages: [Message]) throws {
        guard !messages.isEmpty else { return }
        try database.queue.write { db in
            for message in messages {
                if let clientId = message.clientId {
                    try db.execute(
                        sql: "DELETE FROM message WHERE clientId = ? AND id <> ?",
                        arguments: [clientId, message.id]
                    )
                }
                try MessageRecord(message).save(db)
            }
        }
    }

    // MARK: - Optimistic send

    /// Renders the bubble immediately and queues the intent, in one transaction.
    ///
    /// One transaction because the two halves are the same fact. A pending bubble with
    /// no outbox row is a message that will never be sent; an outbox row with no bubble
    /// is a message he cannot see he sent.
    ///
    /// The pending row's id **is** the `clientId`. There is no server id yet, and
    /// inventing one would mean two ids to reconcile instead of one.
    func enqueueSend(
        conversationId: SylID,
        clientId: String,
        idempotencyKey: String,
        text: String,
        now: Date,
        attachments: [Attachment] = []
    ) throws -> Message {
        let optimistic = Message(
            id: clientId,
            conversationId: conversationId,
            clientId: clientId,
            role: .user,
            text: text,
            createdAt: now,
            // Zero: the server has not given this message a position in the
            // conversation yet, and pretending otherwise would sort it wrongly.
            seq: 0,
            // The LOCAL attachments, with locally-minted ids. The bubble renders from
            // these against bytes already primed into `AttachmentLoader`'s cache, so a
            // just-sent picture appears with no round trip and no spinner. They are
            // swapped for the server's rows by ``attachUploaded(clientId:idempotencyKey:attachments:)``.
            attachments: attachments
        )

        try database.queue.write { db in
            try MessageRecord(optimistic, pending: true).save(db)

            let body = SendMessageRequest(
                clientId: clientId,
                text: text,
                conversationId: conversationId
                // No `attachmentIds` yet, on purpose. The ids that exist right now are
                // local, and a send naming them would be `VALIDATION_FAILED` forever.
            )
            var outboxRow = OutboxRecord(
                idempotencyKey: idempotencyKey,
                kind: .sendMessage,
                targetId: conversationId,
                payload: try SylJSON.encoder().encode(body),
                createdAt: now,
                // Parked until the bytes are up.
                //
                // **This is the disk-first rule applied to attachments (D7).** The
                // bubble and the intent are written together, in one transaction, before
                // a single byte leaves the device — so a crash mid-upload loses neither.
                // What it must not do is let the outbox flush a message whose pictures
                // do not exist on the server yet: sending it anyway would deliver the
                // words without the picture, which is the silent drop this project
                // forbids in a different costume.
                //
                // `blockedReason` is the existing machinery for exactly this shape of
                // problem — neither retried nor discarded, waiting visibly. A crash here
                // leaves the row in `Outbox.blocked()`, which is a state someone can see
                // and act on, rather than a queue entry that would fail forever.
                blockedReason: attachments.isEmpty ? nil : Self.awaitingAttachmentUpload
            )
            // The unique index makes a repeat a no-op; catching it here keeps a double
            // tap from failing the whole transaction and losing the bubble.
            if try OutboxRecord
                .filter(Column("idempotencyKey") == idempotencyKey)
                .fetchCount(db) == 0
            {
                try outboxRow.insert(db)
            }
        }

        return optimistic
    }

    /// Why a send is parked. Compared as a value, so nothing has to spell it twice.
    static let awaitingAttachmentUpload = "Waiting for its attachments to upload"

    /// The uploads landed. Swap the local rows for the server's and release the send.
    ///
    /// One transaction, because the three facts are the same fact: the message now
    /// refers to attachments that exist, the queued intent now names them, and the
    /// intent may now go. Doing any of them separately would leave a window in which the
    /// outbox could flush a send naming ids the message does not carry.
    ///
    /// - Returns: whether anything was found to update. False after a reconcile has
    ///   already swapped the optimistic row out — which is possible, if unlikely, and is
    ///   not an error.
    @discardableResult
    func attachUploaded(
        clientId: String,
        idempotencyKey: String,
        attachments: [Attachment]
    ) throws -> Bool {
        try database.queue.write { db in
            guard let pending = try MessageRecord
                .filter(Column("clientId") == clientId)
                .filter(Column("pending") == true)
                .fetchOne(db)
            else {
                return false
            }

            let stored = try pending.model()
            let updated = Message(
                id: stored.id,
                conversationId: stored.conversationId,
                clientId: stored.clientId,
                role: stored.role,
                text: stored.text,
                createdAt: stored.createdAt,
                seq: stored.seq,
                attachments: attachments
            )
            try MessageRecord(updated, pending: true).save(db)

            guard let row = try OutboxRecord
                .filter(Column("idempotencyKey") == idempotencyKey)
                .fetchOne(db)
            else {
                return false
            }

            let body = SendMessageRequest(
                clientId: clientId,
                text: stored.text,
                conversationId: stored.conversationId,
                attachmentIds: attachments.map(\.id)
            )
            try db.execute(
                sql: "UPDATE outbox SET payload = ?, blockedReason = NULL WHERE id = ?",
                arguments: [try SylJSON.encoder().encode(body), row.id]
            )
            return true
        }
    }

    /// Swaps the optimistic row for the server's copy.
    ///
    /// Matched on `clientId`, which is the only thing the two have in common — the ids
    /// differ by construction. Without it every retry looks like a fresh send and the
    /// bubble either duplicates or hangs pending forever.
    ///
    /// Returns false when there was no pending row: the confirmation arrived on a
    /// device that never sent it, or after a reinstall.
    @discardableResult
    func reconcile(_ confirmation: DeliveryConfirmation) throws -> Bool {
        try database.queue.write { db in
            guard let pending = try MessageRecord
                .filter(Column("clientId") == confirmation.clientId)
                .filter(Column("pending") == true)
                .fetchOne(db)
            else {
                return false
            }

            var message = try pending.model()
            message = Message(
                id: confirmation.serverId,
                conversationId: message.conversationId,
                clientId: confirmation.clientId,
                role: message.role,
                text: message.text,
                createdAt: message.createdAt,
                seq: confirmation.seq
            )

            // The primary key changes, so this is a delete and an insert rather than an
            // update. Same transaction, so the bubble never blinks out.
            try MessageRecord.deleteOne(db, key: pending.id)
            try MessageRecord(message, pending: false).save(db)
            return true
        }
    }

    func pendingMessages() throws -> [Message] {
        try database.queue.read { db in
            try MessageRecord
                .filter(Column("pending") == true)
                .order(Column("createdAt"))
                .fetchAll(db)
                .map { try $0.model() }
        }
    }

    // MARK: - Reminders and to-dos

    func upsert(_ reminders: [Reminder]) throws {
        guard !reminders.isEmpty else { return }
        try database.queue.write { db in
            for reminder in reminders {
                try ReminderRecord(reminder).save(db)
            }
        }
    }

    /// What is coming, soonest first. The agenda's ordering is the server's business;
    /// this is the "what's due" list the app opens on.
    func upcomingReminders(after instant: Date, limit: Int = 50) throws -> [Reminder] {
        try database.queue.read { db in
            try ReminderRecord
                .filter(Column("nextFireAt") >= instant)
                .filter(!["completed", "cancelled"].contains(Column("deliveryState")))
                .order(Column("nextFireAt"))
                .limit(limit)
                .fetchAll(db)
                .map { try $0.model() }
        }
    }

    func reminder(id: SylID) throws -> Reminder? {
        try database.queue.read { db in
            try ReminderRecord.fetchOne(db, key: id)?.model()
        }
    }

    func upsert(_ todos: [Todo]) throws {
        guard !todos.isEmpty else { return }
        try database.queue.write { db in
            for todo in todos {
                try TodoRecord(todo).save(db)
            }
        }
    }

    func openTodos(limit: Int = 100) throws -> [Todo] {
        try database.queue.read { db in
            try TodoRecord
                .filter(Column("status") == TodoStatus.open.rawValue)
                // Pinned first — the one durable bit of "this one matters".
                .order(Column("pinned").desc, Column("dueAt"), Column("updatedAt").desc)
                .limit(limit)
                .fetchAll(db)
                .map { try $0.model() }
        }
    }

    // MARK: - Deletes

    func delete(type: SyncResourceType, id: SylID) throws {
        guard let table = Self.tableName(for: type) else { return }
        _ = try database.queue.write { db in
            try db.execute(sql: "DELETE FROM \(table) WHERE id = ?", arguments: [id])
        }
    }

    /// Only the types the device stores. A change for a resource the app does not keep
    /// locally — a job, a run — is skipped rather than treated as an error: the admin
    /// surface reads those live, and the phone has no use for them.
    static func tableName(for type: SyncResourceType) -> String? {
        switch type {
        case .conversation: return "conversation"
        case .message: return "message"
        case .reminder: return "reminder"
        case .todo: return "todo"
        case .goal, .device, .delivery, .job, .run: return nil
        }
    }

    // MARK: - Sync position

    func syncState() throws -> SyncStateRecord {
        try database.queue.read { db in
            try SyncStateRecord.fetchOne(db, key: SyncStateRecord.singletonID)
                ?? SyncStateRecord()
        }
    }

    /// Writes the HTTP cursor, and **only** the cursor.
    ///
    /// A read-then-write-the-whole-row would race: the sync engine sets the cursor
    /// from its own actor while the socket pump sets the frame sequence from the main
    /// actor, and whichever wrote second would roll the other one back. One targeted
    /// UPDATE in one transaction cannot.
    func setCursor(_ cursor: String?) throws {
        try database.queue.write { db in
            try SyncStateRecord().insert(db, onConflict: .ignore)
            try db.execute(
                sql: "UPDATE syncState SET cursor = ? WHERE id = ?",
                arguments: [cursor, SyncStateRecord.singletonID]
            )
        }
    }

    /// Writes the frame-stream sequence **and the server run it belongs to**, and only
    /// those two. See `setCursor` for why it is a targeted UPDATE.
    ///
    /// One statement, deliberately. A sequence and the run that issued it are a single
    /// fact (`syl-47j`); written separately there is a window in which the row claims
    /// a position in a stream it does not name, and a crash inside that window
    /// restores exactly the state this column exists to prevent.
    func setLastFrameSeq(_ seq: Int, serverEpoch: String?) throws {
        try database.queue.write { db in
            try SyncStateRecord().insert(db, onConflict: .ignore)
            try db.execute(
                sql: "UPDATE syncState SET lastFrameSeq = ?, serverEpoch = ? WHERE id = ?",
                arguments: [seq, serverEpoch, SyncStateRecord.singletonID]
            )
        }
    }
}
