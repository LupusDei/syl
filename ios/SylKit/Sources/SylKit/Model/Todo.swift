import Foundation

/// `proposed` is inferred structure, not an explicit ask — provisional, visible, and
/// it expires if unresolved. An explicit ask is never provisional; it lands as `open`.
public enum TodoStatus: String, Codable, Equatable, Sendable, CaseIterable {
    case proposed, open, done, dropped
}

public enum TodoSource: String, Codable, Equatable, Sendable, CaseIterable {
    case commander, inferred, imported
}

public struct Todo: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    public let text: String
    public let goalId: SylID?
    public let dueAt: Date?
    /// The one durable bit of "this one matters". There is no priority ladder:
    /// priority is a property of a moment, not of a task.
    public let pinned: Bool
    public let status: TodoStatus
    public let source: TodoSource
    /// The seam between the life model and the job system. A to-do is something *he*
    /// must do; a job is something *Syl* must do. One nullable column joins them.
    public let delegatedJobId: SylID?
    public let createdAt: Date
    public let updatedAt: Date
    public let completedAt: Date?

    public init(
        id: SylID,
        text: String,
        goalId: SylID?,
        dueAt: Date?,
        pinned: Bool,
        status: TodoStatus,
        source: TodoSource,
        delegatedJobId: SylID?,
        createdAt: Date,
        updatedAt: Date,
        completedAt: Date?
    ) {
        self.id = id
        self.text = text
        self.goalId = goalId
        self.dueAt = dueAt
        self.pinned = pinned
        self.status = status
        self.source = source
        self.delegatedJobId = delegatedJobId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, text, goalId, dueAt, pinned, status, source, delegatedJobId
        case createdAt, updatedAt, completedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(SylID.self, forKey: .id)
        text = try container.decode(String.self, forKey: .text)
        goalId = try container.decodeRequiredNullable(SylID.self, forKey: .goalId)
        dueAt = try container.decodeRequiredNullable(Date.self, forKey: .dueAt)
        pinned = try container.decode(Bool.self, forKey: .pinned)
        status = try container.decode(TodoStatus.self, forKey: .status)
        source = try container.decode(TodoSource.self, forKey: .source)
        delegatedJobId = try container.decodeRequiredNullable(SylID.self, forKey: .delegatedJobId)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        completedAt = try container.decodeRequiredNullable(Date.self, forKey: .completedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(text, forKey: .text)
        try container.encodeRequiredNullable(goalId, forKey: .goalId)
        try container.encodeRequiredNullable(dueAt, forKey: .dueAt)
        try container.encode(pinned, forKey: .pinned)
        try container.encode(status, forKey: .status)
        try container.encode(source, forKey: .source)
        try container.encodeRequiredNullable(delegatedJobId, forKey: .delegatedJobId)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
        try container.encodeRequiredNullable(completedAt, forKey: .completedAt)
    }
}

public typealias TodoPage = Page<Todo>

/// `text` is the only required field. Every query must behave sanely when the rest
/// are null — "a to-do with only text appears in the right places" is a unit test,
/// not an aspiration.
public struct CreateTodoRequest: Codable, Equatable, Sendable {
    public let text: String
    public let goalId: SylID?
    public let dueAt: Date?
    public let pinned: Bool

    public init(text: String, goalId: SylID? = nil, dueAt: Date? = nil, pinned: Bool = false) {
        self.text = text
        self.goalId = goalId
        self.dueAt = dueAt
        self.pinned = pinned
    }

    private enum CodingKeys: String, CodingKey {
        case text, goalId, dueAt, pinned
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decode(String.self, forKey: .text)
        goalId = try container.decodeIfPresent(SylID.self, forKey: .goalId)
        dueAt = try container.decodeIfPresent(Date.self, forKey: .dueAt)
        pinned = try container.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(text, forKey: .text)
        try container.encodeRequiredNullable(goalId, forKey: .goalId)
        try container.encodeRequiredNullable(dueAt, forKey: .dueAt)
        try container.encode(pinned, forKey: .pinned)
    }
}

public struct UpdateTodoRequest: Codable, Equatable, Sendable {
    public let text: String?
    public let goalId: Patch<SylID>
    public let dueAt: Patch<Date>
    public let pinned: Bool?
    public let status: TodoStatus?

    public init(
        text: String? = nil,
        goalId: Patch<SylID> = .unchanged,
        dueAt: Patch<Date> = .unchanged,
        pinned: Bool? = nil,
        status: TodoStatus? = nil
    ) {
        self.text = text
        self.goalId = goalId
        self.dueAt = dueAt
        self.pinned = pinned
        self.status = status
    }

    private enum CodingKeys: String, CodingKey {
        case text, goalId, dueAt, pinned, status
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        goalId = try container.decodePatch(SylID.self, forKey: .goalId)
        dueAt = try container.decodePatch(Date.self, forKey: .dueAt)
        pinned = try container.decodeIfPresent(Bool.self, forKey: .pinned)
        status = try container.decodeIfPresent(TodoStatus.self, forKey: .status)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(text, forKey: .text)
        try container.encodePatch(goalId, forKey: .goalId)
        try container.encodePatch(dueAt, forKey: .dueAt)
        try container.encodeIfPresent(pinned, forKey: .pinned)
        try container.encodeIfPresent(status, forKey: .status)
    }
}
