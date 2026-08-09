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

    init(_ reminder: Reminder) throws {
        self.id = reminder.id
        self.nextFireAt = reminder.nextFireAt
        self.deliveryState = reminder.deliveryState.rawValue
        self.urgent = reminder.urgent
        self.updatedAt = reminder.updatedAt
        self.payload = try SylJSON.encoder().encode(reminder)
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

    init(_ todo: Todo) throws {
        self.id = todo.id
        self.status = todo.status.rawValue
        self.dueAt = todo.dueAt
        self.pinned = todo.pinned
        self.updatedAt = todo.updatedAt
        self.payload = try SylJSON.encoder().encode(todo)
    }

    typealias Model = Todo
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
}
