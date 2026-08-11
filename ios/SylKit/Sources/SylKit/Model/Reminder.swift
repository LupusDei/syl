import Foundation

/// Drives the catch-up policy, which is why it is stored on the row.
///
/// A `commitment` never collapses: it fires late and says it is late. A `rhythm`
/// message does the opposite — yesterday's morning agenda is worthless today.
public enum ReminderKind: String, Codable, Equatable, Sendable, CaseIterable {
    case commitment
    case rhythm
}

/// `delivered` means APNs accepted the push. `acknowledged` means the device
/// confirmed it. Only the second one satisfies the guarantee.
public enum ReminderDeliveryState: String, Codable, Equatable, Sendable, CaseIterable {
    case scheduled
    case due
    case delivered
    case acknowledged
    case deferred
    case completed
    case cancelled
    case failed
}

public struct Reminder: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    public let kind: ReminderKind
    /// Composed at creation time, in Syl's voice. Delivery is a zero-turn path and
    /// reads this verbatim — no model is in the way to improve it later.
    public let text: String
    public let todoId: SylID?
    public let eventId: SylID?
    public let wallTime: WallTime
    public let tz: Timezone
    /// RFC 5545 RRULE text, restricted to a deliberate subset.
    public let rrule: String?
    /// The instant this occurrence was originally due. Survives deferral and
    /// lateness, so the client can render "this was due Tuesday at 09:00".
    public let scheduledFor: Date
    /// The materialised instant of the next occurrence.
    public let nextFireAt: Date
    /// Maps one-to-one onto APNs `interruption-level: time-sensitive`.
    public let urgent: Bool
    /// Fired after `scheduledFor` because the machine was down. A late reminder says
    /// it is late; it is never silently dropped and never pretends to be on time.
    public let late: Bool
    /// The previous `nextFireAt` in the deferral chain.
    public let deferredFrom: Date?
    public let supersedesPrevious: Bool
    public let deliveryState: ReminderDeliveryState
    public let createdAt: Date
    public let updatedAt: Date
    public let completedAt: Date?

    public init(
        id: SylID,
        kind: ReminderKind,
        text: String,
        todoId: SylID?,
        eventId: SylID?,
        wallTime: WallTime,
        tz: Timezone,
        rrule: String?,
        scheduledFor: Date,
        nextFireAt: Date,
        urgent: Bool,
        late: Bool,
        deferredFrom: Date?,
        supersedesPrevious: Bool,
        deliveryState: ReminderDeliveryState,
        createdAt: Date,
        updatedAt: Date,
        completedAt: Date?
    ) {
        self.id = id
        self.kind = kind
        self.text = text
        self.todoId = todoId
        self.eventId = eventId
        self.wallTime = wallTime
        self.tz = tz
        self.rrule = rrule
        self.scheduledFor = scheduledFor
        self.nextFireAt = nextFireAt
        self.urgent = urgent
        self.late = late
        self.deferredFrom = deferredFrom
        self.supersedesPrevious = supersedesPrevious
        self.deliveryState = deliveryState
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, text, todoId, eventId, wallTime, tz, rrule, scheduledFor
        case nextFireAt, urgent, late, deferredFrom, supersedesPrevious
        case deliveryState, createdAt, updatedAt, completedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(SylID.self, forKey: .id)
        kind = try container.decode(ReminderKind.self, forKey: .kind)
        text = try container.decode(String.self, forKey: .text)
        todoId = try container.decodeRequiredNullable(SylID.self, forKey: .todoId)
        eventId = try container.decodeRequiredNullable(SylID.self, forKey: .eventId)
        wallTime = try container.decode(WallTime.self, forKey: .wallTime)
        tz = try container.decode(Timezone.self, forKey: .tz)
        rrule = try container.decodeRequiredNullable(String.self, forKey: .rrule)
        scheduledFor = try container.decode(Date.self, forKey: .scheduledFor)
        nextFireAt = try container.decode(Date.self, forKey: .nextFireAt)
        urgent = try container.decode(Bool.self, forKey: .urgent)
        late = try container.decode(Bool.self, forKey: .late)
        deferredFrom = try container.decodeRequiredNullable(Date.self, forKey: .deferredFrom)
        supersedesPrevious = try container.decode(Bool.self, forKey: .supersedesPrevious)
        deliveryState = try container.decode(ReminderDeliveryState.self, forKey: .deliveryState)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        completedAt = try container.decodeRequiredNullable(Date.self, forKey: .completedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(kind, forKey: .kind)
        try container.encode(text, forKey: .text)
        try container.encodeRequiredNullable(todoId, forKey: .todoId)
        try container.encodeRequiredNullable(eventId, forKey: .eventId)
        try container.encode(wallTime, forKey: .wallTime)
        try container.encode(tz, forKey: .tz)
        try container.encodeRequiredNullable(rrule, forKey: .rrule)
        try container.encode(scheduledFor, forKey: .scheduledFor)
        try container.encode(nextFireAt, forKey: .nextFireAt)
        try container.encode(urgent, forKey: .urgent)
        try container.encode(late, forKey: .late)
        try container.encodeRequiredNullable(deferredFrom, forKey: .deferredFrom)
        try container.encode(supersedesPrevious, forKey: .supersedesPrevious)
        try container.encode(deliveryState, forKey: .deliveryState)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
        try container.encodeRequiredNullable(completedAt, forKey: .completedAt)
    }
}

public typealias ReminderPage = Page<Reminder>

public struct CreateReminderRequest: Codable, Equatable, Sendable {
    public let text: String
    public let kind: ReminderKind?
    public let wallTime: WallTime
    public let tz: Timezone
    /// `YYYY-MM-DD` local date for a one-shot. Null with an `rrule`.
    public let date: LocalDate?
    public let rrule: String?
    public let todoId: SylID?
    public let urgent: Bool

    public init(
        text: String,
        kind: ReminderKind? = nil,
        wallTime: WallTime,
        tz: Timezone,
        date: LocalDate? = nil,
        rrule: String? = nil,
        todoId: SylID? = nil,
        urgent: Bool = false
    ) {
        self.text = text
        self.kind = kind
        self.wallTime = wallTime
        self.tz = tz
        self.date = date
        self.rrule = rrule
        self.todoId = todoId
        self.urgent = urgent
    }

    private enum CodingKeys: String, CodingKey {
        case text, kind, wallTime, tz, date, rrule, todoId, urgent
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decode(String.self, forKey: .text)
        kind = try container.decodeIfPresent(ReminderKind.self, forKey: .kind)
        wallTime = try container.decode(WallTime.self, forKey: .wallTime)
        tz = try container.decode(Timezone.self, forKey: .tz)
        date = try container.decodeIfPresent(LocalDate.self, forKey: .date)
        rrule = try container.decodeIfPresent(String.self, forKey: .rrule)
        todoId = try container.decodeIfPresent(SylID.self, forKey: .todoId)
        urgent = try container.decodeIfPresent(Bool.self, forKey: .urgent) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(text, forKey: .text)
        try container.encodeIfPresent(kind, forKey: .kind)
        try container.encode(wallTime, forKey: .wallTime)
        try container.encode(tz, forKey: .tz)
        try container.encodeRequiredNullable(date, forKey: .date)
        try container.encodeRequiredNullable(rrule, forKey: .rrule)
        try container.encodeRequiredNullable(todoId, forKey: .todoId)
        try container.encode(urgent, forKey: .urgent)
    }
}

/// Every field optional; omitted fields are left alone. `rrule` uses `Patch` because
/// clearing a recurrence and leaving it alone are different operations.
public struct UpdateReminderRequest: Codable, Equatable, Sendable {
    public let text: String?
    public let wallTime: WallTime?
    public let tz: Timezone?
    public let rrule: Patch<String>
    public let urgent: Bool?

    public init(
        text: String? = nil,
        wallTime: WallTime? = nil,
        tz: Timezone? = nil,
        rrule: Patch<String> = .unchanged,
        urgent: Bool? = nil
    ) {
        self.text = text
        self.wallTime = wallTime
        self.tz = tz
        self.rrule = rrule
        self.urgent = urgent
    }

    private enum CodingKeys: String, CodingKey {
        case text, wallTime, tz, rrule, urgent
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        wallTime = try container.decodeIfPresent(WallTime.self, forKey: .wallTime)
        tz = try container.decodeIfPresent(Timezone.self, forKey: .tz)
        rrule = try container.decodePatch(String.self, forKey: .rrule)
        urgent = try container.decodeIfPresent(Bool.self, forKey: .urgent)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(text, forKey: .text)
        try container.encodeIfPresent(wallTime, forKey: .wallTime)
        try container.encodeIfPresent(tz, forKey: .tz)
        try container.encodePatch(rrule, forKey: .rrule)
        try container.encodeIfPresent(urgent, forKey: .urgent)
    }
}

/// Supply exactly one of `until` or `minutes`.
///
/// Whichever is used, the resulting instant must be strictly later than the current
/// `nextFireAt` or the call fails with `DEFERRAL_NOT_LATER`. Authority is
/// server-side, always: a phone that is wiped, restored or replaced would take
/// device-local deferrals with it, and a deferral that vanishes is the one outcome
/// this project forbids.
public struct SnoozeReminderRequest: Codable, Equatable, Sendable {
    public let until: Date?
    public let minutes: Int?

    private init(until: Date?, minutes: Int?) {
        self.until = until
        self.minutes = minutes
    }

    /// Defer to a specific instant.
    public static func until(_ instant: Date) -> SnoozeReminderRequest {
        SnoozeReminderRequest(until: instant, minutes: nil)
    }

    /// Defer by a number of minutes. This is what the notification action sends.
    public static func minutes(_ minutes: Int) -> SnoozeReminderRequest {
        SnoozeReminderRequest(until: nil, minutes: minutes)
    }

    private enum CodingKeys: String, CodingKey {
        case until, minutes
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        until = try container.decodeIfPresent(Date.self, forKey: .until)
        minutes = try container.decodeIfPresent(Int.self, forKey: .minutes)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeRequiredNullable(until, forKey: .until)
        try container.encodeRequiredNullable(minutes, forKey: .minutes)
    }
}
