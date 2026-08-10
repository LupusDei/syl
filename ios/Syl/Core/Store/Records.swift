import Foundation
import GRDB
import SylKit

/// The row types.
///
/// Each carries the contract model as a JSON payload plus the columns the UI filters
/// and sorts on. `model` is the only way to read one back, so a row that cannot be
/// decoded is a loud failure rather than a partially-rendered screen.
protocol PayloadRecord: FetchableRecord, PersistableRecord {
    associatedtype Model: Codable & Sendable
    var payload: Data { get }
}

extension PayloadRecord {
    func model() throws -> Model {
        try SylJSON.decoder().decode(Model.self, from: payload)
    }
}

struct ConversationRecord: Codable, PayloadRecord, Equatable {
    static let databaseTableName = "conversation"

    var id: SylID
    var lane: String
    var lastMessageAt: Date?
    var updatedAt: Date
    var payload: Data

    init(_ conversation: Conversation) throws {
        self.id = conversation.id
        self.lane = conversation.lane.rawValue
        self.lastMessageAt = conversation.lastMessageAt
        self.updatedAt = conversation.updatedAt
        self.payload = try SylJSON.encoder().encode(conversation)
    }

    typealias Model = Conversation
}

struct MessageRecord: Codable, PayloadRecord, Equatable {
    static let databaseTableName = "message"

    var id: SylID
    var conversationId: SylID
    var seq: Int
    var createdAt: Date
    var clientId: String?
    var pending: Bool
    var payload: Data

    init(_ message: Message, pending: Bool = false) throws {
        self.id = message.id
        self.conversationId = message.conversationId
        self.seq = message.seq
        self.createdAt = message.createdAt
        self.clientId = message.clientId
        self.pending = pending
        self.payload = try SylJSON.encoder().encode(message)
    }

    typealias Model = Message
}

struct ReminderRecord: Codable, PayloadRecord, Equatable {
    static let databaseTableName = "reminder"

    var id: SylID
    var nextFireAt: Date
    var deliveryState: String
    var urgent: Bool
    var updatedAt: Date
    var payload: Data
    /// **When he asked for a deferral — never the instant he asked for it.**
    ///
    /// The only field on this row that is not the server's, and the one place in the
    /// app where the optimistic render is deliberately weaker than it could be: a
    /// deferred reminder has no new time yet, because the server has not issued one.
    /// It shows that a deferral was *asked for* and settles when the answer lands.
    ///
    /// Nil here on purpose whenever a `Reminder` is written from the wire — the
    /// server's copy IS the answer, so writing it retires the ask in the same
    /// statement rather than in a second one someone could forget.
    var deferralRequestedAt: Date?

    init(_ reminder: Reminder) throws {
        self.id = reminder.id
        self.nextFireAt = reminder.nextFireAt
        self.deliveryState = reminder.deliveryState.rawValue
        self.urgent = reminder.urgent
        self.updatedAt = reminder.updatedAt
        self.payload = try SylJSON.encoder().encode(reminder)
        self.deferralRequestedAt = nil
    }

    typealias Model = Reminder
}

struct TodoRecord: Codable, PayloadRecord, Equatable {
    static let databaseTableName = "todo"

    var id: SylID
    var status: String
    var dueAt: Date?
    var pinned: Bool
    var updatedAt: Date
    var payload: Data
    /// Denormalised out of the payload so a goal's evidence is an indexed read rather
    /// than a decode of every to-do on the device.
    var goalId: SylID?
    /// The idempotency key of the capture that created this row, or nil for a row the
    /// server sent.
    ///
    /// The contract gives a to-do no `clientId`, so — unlike a message — there is
    /// nothing the server echoes that would match its copy to this one. The key is the
    /// only link, and it is what lets `LocalStore.settleOptimisticMarkers` retire the
    /// optimistic row once the intent behind it has left the queue. Without it the
    /// server's copy arrives under a different id and he sees the same to-do twice,
    /// permanently.
    var pendingKey: String?

    init(_ todo: Todo, pendingKey: String? = nil) throws {
        self.id = todo.id
        self.status = todo.status.rawValue
        self.dueAt = todo.dueAt
        self.pinned = todo.pinned
        self.updatedAt = todo.updatedAt
        self.payload = try SylJSON.encoder().encode(todo)
        self.goalId = todo.goalId
        self.pendingKey = pendingKey
    }

    typealias Model = Todo
}

/// A goal, and what it deliberately does not carry.
///
/// There is no percent-complete and no priority, here or in the table behind it.
/// Self-reported percentages are fiction and they decay; priority is a property of a
/// moment rather than of a task. What a goal's progress is made of is the to-dos linked
/// to it — evidence, which is why `TodoRecord.goalId` exists.
struct GoalRecord: Codable, PayloadRecord, Equatable {
    static let databaseTableName = "goal"

    var id: SylID
    /// Goals self-nest. Nil is a root goal.
    var parentId: SylID?
    var title: String
    /// `YYYY-MM-DD`. The horizon is derived from it, never stored.
    var targetDate: LocalDate?
    var status: String
    var updatedAt: Date
    var payload: Data

    init(_ goal: Goal) throws {
        self.id = goal.id
        self.parentId = goal.parentId
        self.title = goal.title
        self.targetDate = goal.targetDate
        self.status = goal.status.rawValue
        self.updatedAt = goal.updatedAt
        self.payload = try SylJSON.encoder().encode(goal)
    }

    typealias Model = Goal
}

/// The device's position in both sync mechanisms.
///
/// They are kept side by side precisely because they are **not interchangeable**:
/// `cursor` is the opaque `GET /sync` position that survives a reinstall, and
/// `lastFrameSeq` is the WebSocket frame-stream sequence that survives one reconnect.
/// Feeding one to the other makes the client either replay everything or silently
/// believe it is caught up.
struct SyncStateRecord: Codable, FetchableRecord, PersistableRecord, Equatable {
    static let databaseTableName = "syncState"
    /// There is one row, ever.
    static let singletonID = "singleton"

    var id: String = SyncStateRecord.singletonID
    var cursor: String?
    var lastFrameSeq: Int = 0
    /// **Which run of the server `lastFrameSeq` came from** (`syl-47j`).
    ///
    /// The frame sequence is held in the server's memory and begins again at zero on
    /// every restart, so the number alone does not survive one — and this row is
    /// exactly the thing that carries it across. Nil on a database written before this
    /// column existed, and on one that has never held a socket connection.
    var serverEpoch: String?

    /// When the one-time goal backfill ran, or nil if it has not.
    ///
    /// Goals were ignored by `SyncEngine` while the cursor still advanced past them, so
    /// a device upgraded into goal support believes it is up to date and is missing
    /// every goal that has not changed since. Nil means the recovery has not run.
    var goalsBackfilledAt: Date?
}
