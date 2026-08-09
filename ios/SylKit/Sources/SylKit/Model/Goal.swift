import Foundation

/// `abandoned` is a first-class, non-shameful outcome. `dormant` is a real state and
/// reactivating a dormant goal restores its history intact. The three answers Syl
/// offers — still mine / not now / done with it — map to active / dormant / abandoned.
public enum GoalStatus: String, Codable, Equatable, Sendable, CaseIterable {
    case proposed, active, dormant, achieved, abandoned
}

/// Goals self-nest through `parentId`; there is no separate objective entity, and no
/// percent-complete field — self-reported percentages are fiction and they decay.
public struct Goal: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    public let parentId: SylID?
    public let title: String
    /// The only optional field Syl should ever push for.
    public let why: String?
    /// `YYYY-MM-DD`. The horizon is derived from it, not stored.
    public let targetDate: LocalDate?
    public let metricKey: String?
    public let targetValue: Double?
    /// Drives the silence signal — nothing linked for longer than this is a risk.
    public let cadenceDays: Int?
    public let status: GoalStatus
    public let statusReason: String?
    public let createdAt: Date
    public let updatedAt: Date

    public init(
        id: SylID,
        parentId: SylID?,
        title: String,
        why: String?,
        targetDate: LocalDate?,
        metricKey: String?,
        targetValue: Double?,
        cadenceDays: Int?,
        status: GoalStatus,
        statusReason: String?,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.parentId = parentId
        self.title = title
        self.why = why
        self.targetDate = targetDate
        self.metricKey = metricKey
        self.targetValue = targetValue
        self.cadenceDays = cadenceDays
        self.status = status
        self.statusReason = statusReason
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, parentId, title, why, targetDate, metricKey, targetValue
        case cadenceDays, status, statusReason, createdAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(SylID.self, forKey: .id)
        parentId = try container.decodeRequiredNullable(SylID.self, forKey: .parentId)
        title = try container.decode(String.self, forKey: .title)
        why = try container.decodeRequiredNullable(String.self, forKey: .why)
        targetDate = try container.decodeRequiredNullable(LocalDate.self, forKey: .targetDate)
        metricKey = try container.decodeRequiredNullable(String.self, forKey: .metricKey)
        targetValue = try container.decodeRequiredNullable(Double.self, forKey: .targetValue)
        cadenceDays = try container.decodeRequiredNullable(Int.self, forKey: .cadenceDays)
        status = try container.decode(GoalStatus.self, forKey: .status)
        statusReason = try container.decodeRequiredNullable(String.self, forKey: .statusReason)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encodeRequiredNullable(parentId, forKey: .parentId)
        try container.encode(title, forKey: .title)
        try container.encodeRequiredNullable(why, forKey: .why)
        try container.encodeRequiredNullable(targetDate, forKey: .targetDate)
        try container.encodeRequiredNullable(metricKey, forKey: .metricKey)
        try container.encodeRequiredNullable(targetValue, forKey: .targetValue)
        try container.encodeRequiredNullable(cadenceDays, forKey: .cadenceDays)
        try container.encode(status, forKey: .status)
        try container.encodeRequiredNullable(statusReason, forKey: .statusReason)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
    }
}

public typealias GoalPage = Page<Goal>

public struct CreateGoalRequest: Codable, Equatable, Sendable {
    public let title: String
    public let parentId: SylID?
    public let why: String?
    public let targetDate: LocalDate?
    public let cadenceDays: Int?

    public init(
        title: String,
        parentId: SylID? = nil,
        why: String? = nil,
        targetDate: LocalDate? = nil,
        cadenceDays: Int? = nil
    ) {
        self.title = title
        self.parentId = parentId
        self.why = why
        self.targetDate = targetDate
        self.cadenceDays = cadenceDays
    }

    private enum CodingKeys: String, CodingKey {
        case title, parentId, why, targetDate, cadenceDays
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try container.decode(String.self, forKey: .title)
        parentId = try container.decodeIfPresent(SylID.self, forKey: .parentId)
        why = try container.decodeIfPresent(String.self, forKey: .why)
        targetDate = try container.decodeIfPresent(LocalDate.self, forKey: .targetDate)
        cadenceDays = try container.decodeIfPresent(Int.self, forKey: .cadenceDays)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(title, forKey: .title)
        try container.encodeRequiredNullable(parentId, forKey: .parentId)
        try container.encodeRequiredNullable(why, forKey: .why)
        try container.encodeRequiredNullable(targetDate, forKey: .targetDate)
        try container.encodeRequiredNullable(cadenceDays, forKey: .cadenceDays)
    }
}
