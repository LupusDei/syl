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

    /// One page of history strictly OLDER than `seq`, oldest-first (`syl-025.4.2`).
    ///
    /// `messages(conversationId:limit:)` above takes the newest page and is what a cold
    /// launch renders. This is how the Commander reaches back past it: hand it the
    /// oldest seq on screen and it returns the page immediately before that.
    ///
    /// **Which end this comes from is the whole question, and getting it wrong is
    /// silent.** The page wanted is the one *adjacent* to the cursor — the newest rows
    /// among those older than it — so this orders `seq DESC`, takes `limit`, and
    /// reverses into reading order. Ordering ascending would return the oldest rows in
    /// the entire conversation instead, which under a short history is the identical
    /// result and past it means every "load earlier" hands back the same first page
    /// forever. That is the defect recorded above `messages(conversationId:limit:)`,
    /// which was found the expensive way; this is the same mistake one query along.
    ///
    /// **`seq > 0` is not tidiness, it is correctness.** An optimistic row carries seq 0
    /// until the server gives it a position, so it satisfies `seq < ?` for *every*
    /// cursor. Without the guard the message he just typed would be dragged into every
    /// page he loads while still sitting at the foot of the transcript — the same bubble
    /// rendered twice, once where he sent it and once at the top of history, and again
    /// on each further page.
    ///
    /// Ordering is by `seq` alone rather than by `createdAt` as the head read does,
    /// because the cursor is a seq and a page must be contiguous in the space its cursor
    /// lives in. The two agree for confirmed rows; they disagree exactly for the pending
    /// rows this excludes, which carry the newest `createdAt` and the lowest `seq`.
    func messages(conversationId: SylID, olderThan seq: Int, limit: Int = 50) throws
        -> [Message]
    {
        try database.queue.read { db in
            try MessageRecord
                .filter(Column("conversationId") == conversationId)
                .filter(Column("seq") > 0 && Column("seq") < seq)
                .order(Column("seq").desc)
                .limit(limit)
                .fetchAll(db)
                .reversed()
                .map { try $0.model() }
        }
    }

    /// Confirmed messages that have arrived since `seq`, oldest-first (`syl-025.2.6`).
    ///
    /// The mirror of ``messages(conversationId:olderThan:limit:)`` and the read that lets
    /// a refresh stop re-decoding a window it already holds. `ChatSnapshotLoader` was
    /// reading and JSON-decoding the entire window on every arriving message — measured
    /// at **93ms of a 127ms load at a window of two thousand, three quarters of the
    /// whole cost** — to learn about one new row.
    ///
    /// `seq > 0` for the same reason the backward read has it: an optimistic row has no
    /// position yet, so it is newer than nothing and older than nothing. Pending rows are
    /// read wholesale by ``pendingMessages()`` on every load instead, which is what makes
    /// reconciliation safe here **by construction rather than by care** — a row that
    /// changes from a local id to a server id is a new id at a new seq, so it arrives
    /// through this read, while its predecessor leaves through the pending set.
    func messages(conversationId: SylID, newerThan seq: Int, limit: Int) throws -> [Message] {
        try database.queue.read { db in
            try MessageRecord
                .filter(Column("conversationId") == conversationId)
                .filter(Column("seq") > max(seq, 0))
                .order(Column("seq").asc)
                .limit(limit)
                .fetchAll(db)
                .map { try $0.model() }
        }
    }

    /// The lowest CONFIRMED seq held for a thread, or `nil` when it holds none.
    ///
    /// The cursor `messages(conversationId:olderThan:)` is asked for. Pending rows are
    /// excluded for the reason given there: seq 0 is the absence of a position, not the
    /// beginning of one, and treating it as a floor would ask the server for everything
    /// before the message he is still sending.
    func oldestMessageSeq(conversationId: SylID) throws -> Int? {
        try database.queue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT MIN(seq) FROM message WHERE conversationId = ? AND seq > 0",
                arguments: [conversationId]
            )
        }
    }

    /// Record that the server has confirmed this conversation begins at `seq`.
    ///
    /// Called when a page of history comes back saying there is nothing before it. The
    /// row's existence is the confirmation; see the `v8` migration for why that is a
    /// table rather than a nullable column.
    ///
    /// Idempotent, and it only ever moves the floor DOWN. Two devices, or one device on
    /// two runs, can confirm different depths — and a later confirmation that reported a
    /// *higher* floor than one already held would claim history had been lost. The
    /// system does not get to quietly discard things; the lowest answer anyone has ever
    /// had is kept.
    func confirmHistoryBegins(at seq: Int, conversationId: SylID, now: Date = Date()) throws {
        guard seq > 0 else { return }
        try database.queue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO conversationHistory (conversationId, floorSeq, confirmedAt)
                    VALUES (?, ?, ?)
                    ON CONFLICT(conversationId) DO UPDATE SET
                        floorSeq = MIN(floorSeq, excluded.floorSeq),
                        confirmedAt = excluded.confirmedAt
                    """,
                arguments: [conversationId, seq, now]
            )
        }
    }

    /// The seq the server said this conversation begins at, or `nil` if never asked.
    ///
    /// `nil` and a value are the two states this whole mechanism exists to separate.
    /// Do not collapse them into a Bool at the call site without saying which you mean.
    func historyFloor(conversationId: SylID) throws -> Int? {
        try database.queue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT floorSeq FROM conversationHistory WHERE conversationId = ?",
                arguments: [conversationId]
            )
        }
    }

    /// Whether the device holds this conversation all the way back to its beginning.
    ///
    /// True only when the server has confirmed a floor AND the device still holds a row
    /// at or below it. Both halves are load-bearing: a confirmation alone says where the
    /// beginning is, not that we have reached it, and a device that has been cleared
    /// since the confirmation holds nothing while the marker still stands.
    ///
    /// This is what tells "there is genuinely nothing older" apart from "the local
    /// window has run out", and it is the difference between an ending and a spinner.
    func hasWholeHistory(conversationId: SylID) throws -> Bool {
        guard let floor = try historyFloor(conversationId: conversationId) else { return false }
        guard let oldest = try oldestMessageSeq(conversationId: conversationId) else {
            return false
        }
        return oldest <= floor
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
            let owed = try Self.owedCompletions(db, kind: .completeReminder)
            for reminder in reminders {
                // He finished it and the intent has not left the queue. See
                // `upsert(_ todos:)` for the argument; it is the same one, and a
                // reminder put back on his spine by the very sweep that is failing to
                // deliver its completion is the same failure wearing a different noun.
                if reminder.deliveryState != .completed,
                    owed.contains(SylIDs.canonical(reminder.id)),
                    try ReminderRecord.fetchOne(db, key: reminder.id)?.deliveryState
                        == ReminderDeliveryState.completed.rawValue
                {
                    continue
                }
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

    /// Write the server's copies down — **except where doing so would undo him.**
    ///
    /// A plain `save` per row is what this was, and it is half of the three-day defect.
    /// The Commander finished a to-do, `completeTodo` wrote `done` and queued the
    /// intent, the push stalled at the head of the queue, and then the pull in the same
    /// pass brought back the server's copy — still `open`, because the server had not
    /// been told — and wrote it straight over him. The completion reverted itself with
    /// nothing said, which is the ending `completeTodo`'s own comment already describes
    /// for the unsynced-capture case; it was reachable by a second route nobody had
    /// closed.
    ///
    /// **The local row wins, rather than the revert being surfaced**, and the choice is
    /// not close. A local `done` with a queued `completeTodo` is his authenticated act;
    /// the server's `open` is only the server not having heard yet, so deferring to it
    /// discards the newer fact in favour of the older one and makes him do the work
    /// twice. Telling him instead would be telling him about something that fixes itself
    /// the moment the queue drains — noise that still loses the act. What he does need
    /// to be told is that the queue has stopped, and that is `OutboxStall`'s job.
    ///
    /// **It is the optimistic-marker rule, not an exception to it.** This file already
    /// holds that "an optimistic marker is a claim that lives exactly as long as the
    /// intent behind it"; a local `done` with its completion still queued IS such a
    /// claim. So the guard is self-limiting by construction — the moment the intent
    /// leaves the queue, however it left, the server is authoritative again and an
    /// `open` copy is written normally. Nothing has to remember to switch it off.
    ///
    /// Nothing is permanently lost by holding a page's copy back. When the completion
    /// lands, the server writes the row and logs a change for it, so the next pull
    /// delivers the row again carrying whatever else the server had changed meanwhile.
    func upsert(_ todos: [Todo]) throws {
        guard !todos.isEmpty else { return }
        try database.queue.write { db in
            // Read once for the batch rather than once per row: a page is five hundred
            // to-dos and the queue is usually empty.
            let owed = try Self.owedCompletions(db, kind: .completeTodo)
            for todo in todos {
                if todo.status != .done,
                    owed.contains(SylIDs.canonical(todo.id)),
                    try TodoRecord.fetchOne(db, key: todo.id)?.status == TodoStatus.done.rawValue
                {
                    continue
                }
                try TodoRecord(todo).save(db)
            }
        }
    }

    /// The ids of rows he has finished and the server has not been told about.
    ///
    /// **Every queued row of that kind counts, blocked ones included.** `Outbox.pending`
    /// filters a blocked row out, so a check written against the pending queue would
    /// leave exactly the intents that are stuck hardest unprotected — the ones parked
    /// indefinitely because they may already have taken effect. Unresolved is the
    /// condition that matters here, not retriable.
    ///
    /// Canonical ids, because the contract permits either hex case for one and this is
    /// a comparison between a row the device wrote and a row the server sent.
    private static func owedCompletions(
        _ db: Database,
        kind: OutboxRecord.Kind
    ) throws -> Set<SylID> {
        Set(
            try String.fetchAll(
                db,
                sql: "SELECT targetId FROM outbox WHERE kind = ? AND targetId IS NOT NULL",
                arguments: [kind.rawValue]
            )
            .map(SylIDs.canonical)
        )
    }

    /// One to-do, by id. The counterpart of ``reminder(id:)``.
    func todo(id: SylID) throws -> Todo? {
        try database.queue.read { db in
            try TodoRecord.fetchOne(db, key: id)?.model()
        }
    }

    /// Open to-dos: pinned first, then the soonest deadline, then the most recently
    /// touched.
    ///
    /// **`dueAt IS NULL` sorts last, and leaving that out was a real bug.** SQLite
    /// orders NULLs first by default, which put every undated to-do above the one due in
    /// an hour — exactly backwards for this question, and precisely what the server's
    /// `todos_agenda_idx` says in its own comment. It was invisible in the suite because
    /// the only ordering test had two undated rows.
    /// Open to-dos, in the order he should meet them.
    ///
    /// **Deadline first. `pinned` is an elevator, not an override** (`syl-011`, decided
    /// 2026-08-10 when the SQL and `TodoOrdering` were found to disagree).
    ///
    /// This ordered `pinned DESC` first, which sounds right and is wrong in the case
    /// that matters: pin "call the roofer", which has no date, and it outranks "submit
    /// the taxes" due in two hours. That is not the list saying *this one matters*, it
    /// is the list lying about what is urgent. Proposal B calls `pinned` **durable**; it
    /// never calls it more important than a deadline, and its entire argument for
    /// computing order rather than storing it is that urgency belongs to the moment.
    ///
    /// So a pinned undated to-do ranks above other *undated* ones, and below anything
    /// actually due.
    ///
    /// `dueAt IS NULL` stays, and is separate: SQLite sorts NULLs **first**, so ordering
    /// on `dueAt` alone put every undated to-do above every dated one — the day spine
    /// has been wrong about this for as long as it has existed.
    ///
    /// This must agree with `TodoOrdering`, which is the pure, tested statement of the
    /// same rule. A function and an `ORDER BY` that quietly disagree read as correct in
    /// both files and wrong on screen.
    func openTodos(limit: Int = 100) throws -> [Todo] {
        try database.queue.read { db in
            try TodoRecord
                .order(literal: "dueAt IS NULL, dueAt, pinned DESC, updatedAt DESC")
                .filter(Column("status") == TodoStatus.open.rawValue)
                .limit(limit)
                .fetchAll(db)
                .map { try $0.model() }
        }
    }

    /// How many open to-dos there are, in total.
    ///
    /// Separate from `openTodos` because that read is **windowed**, and deriving a count
    /// from a window means the day would say "100 open" forever once he passed a
    /// hundred — a number that stops being true exactly when it starts mattering.
    func openTodoCount() throws -> Int {
        try database.queue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT COUNT(*) FROM todo WHERE status = ?",
                arguments: [TodoStatus.open.rawValue]
            ) ?? 0
        }
    }

    /// To-dos the server has not acknowledged yet.
    ///
    /// A captured to-do has **no `clientId` in the contract** — unlike a message, there
    /// is nothing the server echoes back that would let the device match its copy to the
    /// optimistic row. So a capture is tied to its outbox entry by `pendingKey` until
    /// the server's own row arrives and replaces it (`syl-011.1.8`).
    ///
    /// While that is true, `completeTodo` refuses the row: completing something the
    /// server has never heard of would return `NOT_FOUND`, abandon the intent, and let
    /// the next sync reinstate the server's still-open copy — a completion that silently
    /// undoes itself, which is the worst available outcome.
    ///
    /// This exists so a view can say so *before* he taps, rather than presenting a
    /// control that refuses. A disabled affordance with a reason is an explanation; one
    /// that fails on contact is a bug he has to interpret.
    func unsyncedTodoIDs() throws -> Set<SylID> {
        try database.queue.read { db in
            Set(
                try String.fetchAll(
                    db,
                    sql: "SELECT id FROM todo WHERE pendingKey IS NOT NULL"
                )
            )
        }
    }

    // MARK: - Goals

    func upsert(_ goals: [Goal]) throws {
        guard !goals.isEmpty else { return }
        try database.queue.write { db in
            for goal in goals {
                try GoalRecord(goal).save(db)
            }
        }
    }

    /// Every goal, in the order a list of goals reads in: soonest target date, then
    /// title.
    ///
    /// Two deliberate choices. **Nothing is filtered out** — `abandoned` is a
    /// first-class, non-shameful outcome and `dormant` is a real state rather than a
    /// soft delete, so a read that hid either would be the accumulated-guilt design
    /// proposal B exists to prevent. And **a goal with no target date sorts last**,
    /// because SQLite's default puts NULLs first and a goal with no date is not more
    /// urgent than one due this month.
    func goals(limit: Int = 200) throws -> [Goal] {
        try database.queue.read { db in
            try GoalRecord
                .order(literal: "targetDate IS NULL, targetDate, title COLLATE NOCASE")
                .limit(limit)
                .fetchAll(db)
                .map { try $0.model() }
        }
    }

    /// How many goals there are, as opposed to how many a window held (`syl-o319`).
    ///
    /// Same argument as ``openTodoCount()``, which this deliberately mirrors: a count
    /// derived from a windowed read stops being true exactly when it starts mattering.
    func goalCount() throws -> Int {
        try database.queue.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM goal") ?? 0
        }
    }

    func goal(id: SylID) throws -> Goal? {
        try database.queue.read { db in
            try GoalRecord.fetchOne(db, key: id)?.model()
        }
    }

    // MARK: - The constellation

    /// Replace the stored sky with a newly fetched one.
    ///
    /// **Replaces, never merges.** The payload is a bounded region rather than a
    /// row set, and a star leaving that region produces no event — so an upsert
    /// would accumulate a local sky the server would never draw, growing quietly
    /// and looking correct throughout. See the `v5` migration.
    func replaceConstellation(_ constellation: MemoryConstellation) throws {
        try database.queue.write { db in
            try ConstellationRecord(constellation).save(db)
        }
    }

    /// The last sky the server drew, or nil if it has never been fetched.
    ///
    /// **Nil is not an empty sky**, and the difference is the whole reason this
    /// returns an optional. An empty `MemoryConstellation` renders as "she
    /// remembers nothing about you", which is a confident false statement to make
    /// on a first launch that simply has not reached the network yet. The caller
    /// shows nothing until it has an answer — the same distinction
    /// `GoalsViewModel` draws with a nil snapshot.
    func constellation() throws -> MemoryConstellation? {
        try database.queue.read { db in
            try ConstellationRecord
                .fetchOne(db, key: ConstellationRecord.singletonID)?
                .model()
        }
    }

    // MARK: - Sendings

    /// Store a fetched page of sendings.
    ///
    /// **Replaces each row it names, and removes none that it does not.** The page is
    /// the newest few, so a sending missing from it has scrolled off rather than gone —
    /// nothing in this system deletes a sending, and a store that mirrored the page by
    /// deleting the difference would be the one thing acceptance item 6 forbids, dressed
    /// as a cache.
    ///
    /// Replacing by id is what carries the one write the service permits: a `pending`
    /// row becomes `ready` when the render lands, and the device finds out by asking.
    func replaceSendings(_ page: SendingPage) throws {
        guard !page.items.isEmpty else { return }
        try database.queue.write { db in
            for sending in page.items {
                try SendingRecord(sending).save(db)
            }
        }
    }

    /// What she has sent him, **newest first**.
    ///
    /// The order is the service's own — `createdAt DESC`, ties broken on the id — and it
    /// is asserted here rather than inherited from the order a page happened to arrive
    /// in. The mock served this list unsorted for a while and was schema-conformant the
    /// whole time, because ordering is not something a schema can say.
    ///
    /// Every state is returned. A `pending` or `failed` sending is a complete row: the
    /// words reached him whatever became of the video, and filtering those out would
    /// hide the half of the feature that is guaranteed to have arrived.
    func sendings(limit: Int = 200) throws -> [Sending] {
        try database.queue.read { db in
            try SendingRecord
                .order(literal: "createdAt DESC, id DESC")
                .limit(limit)
                .fetchAll(db)
                .map { try $0.model() }
        }
    }

    /// The ids of every sending still waiting on its video.
    ///
    /// The video lands minutes after the words, and no frame arrives to say so — the
    /// phone learns by asking. This is what tells a foreground pass whether there is
    /// anything to ask about.
    func pendingSendingIDs() throws -> [SylID] {
        try database.queue.read { db in
            try SylID.fetchAll(
                db,
                sql: "SELECT id FROM sending WHERE state = ?",
                arguments: [SendingState.pending.rawValue]
            )
        }
    }

    /// The to-dos linked to a goal — **every one of them, closed included**.
    ///
    /// This is the read a goal's progress is evidenced from, and most evidence is
    /// finished work. Returning only what is still open would show an active goal as
    /// though nothing had ever moved on it.
    func todos(goalId: SylID, limit: Int = 200) throws -> [Todo] {
        try database.queue.read { db in
            try TodoRecord
                // The same four terms as `openTodos`, and for the same reason. A goal
                // that ordered its to-dos differently from the list they also appear in
                // would be two answers to one question.
                .order(literal: "dueAt IS NULL, dueAt, pinned DESC, updatedAt DESC")
                .filter(Column("goalId") == goalId)
                .limit(limit)
                .fetchAll(db)
                .map { try $0.model() }
        }
    }

    // MARK: - Optimistic writes

    /// Marks a to-do done and queues the intent, in one transaction.
    ///
    /// The same rule `enqueueSend` states for a message applies to every one of these:
    /// **the two halves are the same fact.** A to-do that renders done with no outbox
    /// row is a lie — finished here, open everywhere else, and invisible because it
    /// looks finished. An outbox row with no local change is a tap that did nothing.
    ///
    /// The row is read before it is written, and an already-finished to-do is
    /// **refused** rather than completed a second time (`docs/CONTEXT.md` §7). The
    /// server's `complete` is idempotent and would answer happily, reporting an act
    /// nobody performed. The refusal names the to-do in his own words, because him
    /// hearing the wrong title is the only place a wrong id is still catchable.
    @discardableResult
    func completeTodo(id: SylID, idempotencyKey: String, now: Date) throws -> Todo {
        try database.queue.write { db in
            guard let record = try TodoRecord.fetchOne(db, key: id) else {
                throw LocalStoreError.noSuchTodo(id: id)
            }
            let stored = try record.model()
            guard stored.status != .done else {
                throw LocalStoreError.todoAlreadyFinished(text: stored.text)
            }
            // A capture the server has never heard of has only a locally minted id, and
            // `POST /todos/{id}/complete` against it can only ever be `NOT_FOUND` —
            // permanent, so the intent is abandoned, and the sweep then replaces the row
            // with the server's copy, which is still open. The completion would revert
            // itself with nothing said. Refusing is the same act as refusing an
            // already-finished one: say so, name it, and do not report work nobody did.
            guard record.pendingKey == nil else {
                throw LocalStoreError.todoHasNotReachedSylYet(text: stored.text)
            }

            let completed = Todo(
                id: stored.id,
                text: stored.text,
                goalId: stored.goalId,
                dueAt: stored.dueAt,
                pinned: stored.pinned,
                status: .done,
                source: stored.source,
                delegatedJobId: stored.delegatedJobId,
                createdAt: stored.createdAt,
                updatedAt: now,
                completedAt: now
            )
            try TodoRecord(completed).save(db)

            try Self.enqueueIntent(
                db,
                OutboxRecord(
                    idempotencyKey: idempotencyKey,
                    kind: .completeTodo,
                    targetId: stored.id,
                    createdAt: now
                )
            )
            return completed
        }
    }

    /// Completes a reminder and queues the intent, in one transaction.
    ///
    /// Refuses one that is already completed, and names it — the same rule as a to-do,
    /// for the same reason.
    @discardableResult
    func completeReminder(id: SylID, idempotencyKey: String, now: Date) throws -> Reminder {
        try database.queue.write { db in
            guard let record = try ReminderRecord.fetchOne(db, key: id) else {
                throw LocalStoreError.noSuchReminder(id: id)
            }
            let stored = try record.model()
            guard stored.deliveryState != .completed else {
                throw LocalStoreError.reminderAlreadyFinished(text: stored.text)
            }

            let completed = Self.reminder(stored, deliveryState: .completed, at: now)
            try ReminderRecord(completed).save(db)

            try Self.enqueueIntent(
                db,
                OutboxRecord(
                    idempotencyKey: idempotencyKey,
                    kind: .completeReminder,
                    targetId: stored.id,
                    createdAt: now
                )
            )
            return completed
        }
    }

    /// Asks the server to defer a reminder. **It does not move it.**
    ///
    /// This is the one place in the app where the optimistic render is deliberately
    /// weaker than it could be, and getting it wrong invents a time that does not exist.
    /// Constraint 4 and proposal E agree that the server owns a deferral's new instant:
    /// a phone that is wiped, restored or replaced would take device-local deferrals
    /// with it, and a deferral that vanishes is the one outcome this project forbids.
    ///
    /// So nothing here computes an instant, and the signature makes that structural
    /// rather than a rule to remember — it takes **minutes**, a duration, and there is
    /// no way to hand it a time. `nextFireAt` is left exactly as the server last stated
    /// it; what changes is `deferralRequestedAt`, which records only that he asked and
    /// when. The row settles the moment the server's copy of the reminder arrives,
    /// because writing that copy clears the column in the same statement.
    func snoozeReminder(id: SylID, minutes: Int, idempotencyKey: String, now: Date) throws {
        try database.queue.write { db in
            guard let record = try ReminderRecord.fetchOne(db, key: id) else {
                throw LocalStoreError.noSuchReminder(id: id)
            }
            // Deferring something already finished is the same refusal as completing it
            // twice, wearing a different verb.
            let stored = try record.model()
            guard stored.deliveryState != .completed else {
                throw LocalStoreError.reminderAlreadyFinished(text: stored.text)
            }
            try db.execute(
                sql: "UPDATE reminder SET deferralRequestedAt = ? WHERE id = ?",
                arguments: [now, id]
            )
            try Self.enqueueIntent(
                db,
                OutboxRecord(
                    idempotencyKey: idempotencyKey,
                    kind: .snoozeReminder,
                    targetId: id,
                    // A duration, which is what the notification action already sends.
                    // `SnoozeReminderRequest.until` exists and this must never use it.
                    payload: try SylJSON.encoder().encode(SnoozeReminderRequest.minutes(minutes)),
                    createdAt: now
                )
            )
        }
    }

    /// Writes a captured to-do and queues the intent, in one transaction.
    ///
    /// Text and a timestamp, and **every other column null**. No due date, no goal, no
    /// pin: every field a human must fill in is a tax collected at the moment of lowest
    /// motivation, and they die at capture rather than at review. It lands as `open`
    /// rather than `proposed`, because an explicit ask is never provisional.
    ///
    /// The id is minted here because the contract gives a to-do no `clientId` — there is
    /// nothing for the server to echo back. `pendingKey` is what ties this row to the
    /// intent that will create the server's copy; see `settleOptimisticMarkers`.
    @discardableResult
    func createTodo(
        text: String,
        idempotencyKey: String,
        now: Date,
        id: SylID = LocalStore.mintTodoID()
    ) throws -> Todo {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw LocalStoreError.emptyCapture }

        let captured = Todo(
            id: id,
            text: trimmed,
            goalId: nil,
            dueAt: nil,
            pinned: false,
            status: .open,
            source: .commander,
            delegatedJobId: nil,
            createdAt: now,
            updatedAt: now,
            completedAt: nil
        )

        try database.queue.write { db in
            try TodoRecord(captured, pendingKey: idempotencyKey).save(db)
            try Self.enqueueIntent(
                db,
                OutboxRecord(
                    idempotencyKey: idempotencyKey,
                    kind: .createTodo,
                    payload: try SylJSON.encoder().encode(CreateTodoRequest(text: trimmed)),
                    createdAt: now
                )
            )
        }
        return captured
    }

    /// An id in the shape the service mints them. Local, and only ever temporary.
    static func mintTodoID() -> SylID {
        "syl:todo:\(UUID().uuidString.lowercased())"
    }

    /// Reminders with a deferral asked for and not yet answered, and when he asked.
    ///
    /// Handed to a snapshot loader whole and sliced there, rather than queried per row —
    /// `syl-008` shipped a quadratic comparison into a transcript by doing the opposite.
    /// Keys are canonical, because the contract permits either hex case for an id.
    func deferralRequests() throws -> [SylID: Date] {
        try database.queue.read { db in
            var asked: [SylID: Date] = [:]
            let rows = try Row.fetchAll(
                db,
                sql: """
                    SELECT id, deferralRequestedAt FROM reminder
                    WHERE deferralRequestedAt IS NOT NULL
                    """
            )
            for row in rows {
                guard
                    let id = row["id"] as String?,
                    let at = row["deferralRequestedAt"] as Date?
                else { continue }
                asked[SylIDs.canonical(id)] = at
            }
            return asked
        }
    }

    /// Retires the optimistic markers whose intent has left the queue.
    ///
    /// **An optimistic marker is a claim that lives exactly as long as the intent behind
    /// it**, and this is the one rule that settles both of them — whether the intent
    /// succeeded or was refused outright, the queue is the thing that knows it is over.
    ///
    ///   * A captured to-do is removed once its `createTodo` intent is gone, because the
    ///     server's copy of it arrived in the same pass under the server's id. Left
    ///     alone it would be a permanent duplicate.
    ///   * A deferral's ask is cleared once its `snoozeReminder` intent is gone. The
    ///     usual settlement is the server's copy of the reminder replacing the row; this
    ///     is what catches the other ending, a `DEFERRAL_NOT_LATER` the server refused,
    ///     where no new copy is ever coming and the row would otherwise say "asked"
    ///     forever.
    ///
    /// Call it **only after a pull has actually landed** — see `SyncEngine`. Run against
    /// a push that succeeded and a pull that did not, it would take a to-do off his
    /// screen before its replacement had arrived.
    func settleOptimisticMarkers() throws {
        try database.queue.write { db in
            try db.execute(
                sql: """
                    UPDATE reminder SET deferralRequestedAt = NULL
                     WHERE deferralRequestedAt IS NOT NULL
                       AND NOT EXISTS (
                             SELECT 1 FROM outbox
                              WHERE outbox.kind = ? AND outbox.targetId = reminder.id
                           )
                    """,
                arguments: [OutboxRecord.Kind.snoozeReminder.rawValue]
            )
            // `NOT EXISTS` rather than `NOT IN`, deliberately: `NOT IN` over a set
            // containing a NULL is NULL rather than true, so a single null key in the
            // queue would silently stop retiring anything at all.
            try db.execute(
                sql: """
                    DELETE FROM todo
                     WHERE pendingKey IS NOT NULL
                       AND NOT EXISTS (
                             SELECT 1 FROM outbox WHERE outbox.idempotencyKey = todo.pendingKey
                           )
                    """
            )
        }
    }

    /// Adds an intent unless this key is already queued.
    ///
    /// The unique index makes a repeat a no-op at the schema level; catching it here
    /// keeps a double tap from failing the whole transaction and rolling back the change
    /// he can already see.
    private static func enqueueIntent(_ db: Database, _ record: OutboxRecord) throws {
        guard
            try OutboxRecord
                .filter(Column("idempotencyKey") == record.idempotencyKey)
                .fetchCount(db) == 0
        else { return }
        var row = record
        try row.insert(db)
    }

    /// A reminder with its delivery state moved and nothing else invented.
    private static func reminder(
        _ stored: Reminder,
        deliveryState: ReminderDeliveryState,
        at now: Date
    ) -> Reminder {
        Reminder(
            id: stored.id,
            kind: stored.kind,
            text: stored.text,
            todoId: stored.todoId,
            eventId: stored.eventId,
            wallTime: stored.wallTime,
            tz: stored.tz,
            rrule: stored.rrule,
            scheduledFor: stored.scheduledFor,
            nextFireAt: stored.nextFireAt,
            urgent: stored.urgent,
            late: stored.late,
            deferredFrom: stored.deferredFrom,
            supersedesPrevious: stored.supersedesPrevious,
            deliveryState: deliveryState,
            createdAt: stored.createdAt,
            updatedAt: now,
            completedAt: deliveryState == .completed ? now : stored.completedAt
        )
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
    ///
    /// `.goal` was in that skipped list until `syl-011.1.2`. See `SyncEngine.upsert` for
    /// what changed and why.
    static func tableName(for type: SyncResourceType) -> String? {
        switch type {
        case .conversation: return "conversation"
        case .message: return "message"
        case .reminder: return "reminder"
        case .todo: return "todo"
        case .goal: return "goal"
        // **`.sending` is nil on purpose, and it is not the same "nil" as the two
        // below.** Those are resources the phone does not keep. A sending it does keep —
        // this is the delete path, and a sending is never deleted, by the service or by
        // anything here. Naming the table would make acceptance item 6 true only for as
        // long as no `op: "delete"` ever arrived for one.
        case .sending: return nil
        case .device, .delivery, .unrecognised: return nil
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

    /// Records that the one-time goal recovery has run.
    ///
    /// A targeted UPDATE for the same reason `setCursor` is one: this row is written from
    /// two actors, and a read-then-write-the-whole-row would roll the other one back.
    func markGoalsBackfilled(at instant: Date) throws {
        try database.queue.write { db in
            try SyncStateRecord().insert(db, onConflict: .ignore)
            try db.execute(
                sql: "UPDATE syncState SET goalsBackfilledAt = ? WHERE id = ?",
                arguments: [instant, SyncStateRecord.singletonID]
            )
        }
    }

    /// Records that the one-time to-do recovery has run. `syl-020`.
    ///
    /// Targeted UPDATE for the reason `setCursor` states — this row has several writers
    /// and a whole-row write would roll one of them back. Writing the whole record here
    /// would be worse than usual: the column next to it is the sync cursor, and rolling
    /// THAT back would re-page thousands of rows.
    func markTodosBackfilled(at instant: Date) throws {
        try database.queue.write { db in
            try SyncStateRecord().insert(db, onConflict: .ignore)
            try db.execute(
                sql: "UPDATE syncState SET todosBackfilledAt = ? WHERE id = ?",
                arguments: [instant, SyncStateRecord.singletonID]
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

/// Why a write was refused before it was written.
///
/// **Every case that can name the thing does**, and that is the load-bearing part rather
/// than a nicety. `docs/CONTEXT.md` §7: a completion that answers "done" gives him
/// nothing to contradict, and hearing the wrong title is the only place a wrong id is
/// still catchable. The messages are `LocalizedError` too, so a view that shows
/// `localizedDescription` — the lazy path, and therefore the one that will be taken —
/// names it as well.
enum LocalStoreError: Error, Equatable, LocalizedError, CustomStringConvertible {
    /// Read the row before writing: a stale id costs a read, never an item.
    case noSuchTodo(id: SylID)
    case noSuchReminder(id: SylID)
    /// The store's complete is idempotent and would answer happily, reporting an act
    /// nobody performed.
    case todoAlreadyFinished(text: String)
    case reminderAlreadyFinished(text: String)
    /// Captured on this device and not yet acknowledged by the server, so the only id it
    /// has is one the server has never seen. `syl-011.1.8` is the proper fix.
    case todoHasNotReachedSylYet(text: String)
    /// A capture with nothing in it writes nothing at all.
    case emptyCapture

    var description: String {
        switch self {
        case .noSuchTodo(let id):
            return "there is no to-do \(id) on this device"
        case .noSuchReminder(let id):
            return "there is no reminder \(id) on this device"
        case .todoAlreadyFinished(let text):
            return "\u{201C}\(text)\u{201D} is already finished"
        case .reminderAlreadyFinished(let text):
            return "\u{201C}\(text)\u{201D} is already finished"
        case .todoHasNotReachedSylYet(let text):
            return "\u{201C}\(text)\u{201D} has not reached Syl yet"
        case .emptyCapture:
            return "there was nothing to write down"
        }
    }

    var errorDescription: String? { description }
}
