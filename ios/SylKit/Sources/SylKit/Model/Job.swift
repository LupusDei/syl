import Foundation

/// A closed catalogue. The model may enqueue a job; it may never invent a kind —
/// otherwise a prompt injection inside an article becomes a job that speaks to him
/// every morning.
public enum JobKind: String, Codable, Equatable, Sendable, CaseIterable {
    case reminderDelivery = "reminder_delivery"
    case morningAgenda = "morning_agenda"
    case eveningReview = "evening_review"
    case heartbeat
    case nightlyConsolidation = "nightly_consolidation"
    case researchBrief = "research_brief"
    case contentIngestion = "content_ingestion"
    case maintenance
}

public enum JobState: String, Codable, Equatable, Sendable, CaseIterable {
    case pending, leased, running, done, failed, abandoned, suspended
}

/// Background never starts while interactive work is pending.
public enum JobPriority: String, Codable, Equatable, Sendable, CaseIterable {
    case interactive, reminder, scheduled, background
}

public enum JobDeliveryClass: String, Codable, Equatable, Sendable, CaseIterable {
    case atLeastOnce = "at_least_once"
    case atLeastOnceResumable = "at_least_once_resumable"
    case atMostOnce = "at_most_once"
    case oncePerWindow = "once_per_window"
}

/// What to do about an instant that passed while we were down.
public enum CatchUpPolicy: String, Codable, Equatable, Sendable, CaseIterable {
    case neverExpires = "never_expires"
    case graceWindow = "grace_window"
    case skip
    case oncePerWindow = "once_per_window"
}

public struct JobCatchUp: Codable, Equatable, Sendable {
    public let policy: CatchUpPolicy
    public let graceMs: Int?
    public let windowStart: WallTime?
    public let windowEnd: WallTime?

    public init(
        policy: CatchUpPolicy,
        graceMs: Int? = nil,
        windowStart: WallTime? = nil,
        windowEnd: WallTime? = nil
    ) {
        self.policy = policy
        self.graceMs = graceMs
        self.windowStart = windowStart
        self.windowEnd = windowEnd
    }

    private enum CodingKeys: String, CodingKey {
        case policy, graceMs, windowStart, windowEnd
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        policy = try container.decode(CatchUpPolicy.self, forKey: .policy)
        graceMs = try container.decodeIfPresent(Int.self, forKey: .graceMs)
        windowStart = try container.decodeIfPresent(WallTime.self, forKey: .windowStart)
        windowEnd = try container.decodeIfPresent(WallTime.self, forKey: .windowEnd)
    }

    /// The only fields written are the ones the policy actually uses — the service
    /// omits them rather than sending nulls, and a round-trip has to match.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(policy, forKey: .policy)
        try container.encodeIfPresent(graceMs, forKey: .graceMs)
        try container.encodeIfPresent(windowStart, forKey: .windowStart)
        try container.encodeIfPresent(windowEnd, forKey: .windowEnd)
    }
}

public enum JobTriggerType: String, Codable, Equatable, Sendable, CaseIterable {
    case wallClock = "wall_clock"
    case interval, event, manual
}

public struct JobTrigger: Codable, Equatable, Sendable {
    public let type: JobTriggerType
    public let wallTime: WallTime?
    public let tz: Timezone?
    public let rrule: String?
    public let intervalMs: Int?
    public let event: String?

    public init(
        type: JobTriggerType,
        wallTime: WallTime? = nil,
        tz: Timezone? = nil,
        rrule: String? = nil,
        intervalMs: Int? = nil,
        event: String? = nil
    ) {
        self.type = type
        self.wallTime = wallTime
        self.tz = tz
        self.rrule = rrule
        self.intervalMs = intervalMs
        self.event = event
    }

    private enum CodingKeys: String, CodingKey {
        case type, wallTime, tz, rrule, intervalMs, event
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(JobTriggerType.self, forKey: .type)
        wallTime = try container.decodeIfPresent(WallTime.self, forKey: .wallTime)
        tz = try container.decodeIfPresent(Timezone.self, forKey: .tz)
        rrule = try container.decodeIfPresent(String.self, forKey: .rrule)
        intervalMs = try container.decodeIfPresent(Int.self, forKey: .intervalMs)
        event = try container.decodeIfPresent(String.self, forKey: .event)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encodeIfPresent(wallTime, forKey: .wallTime)
        try container.encodeIfPresent(tz, forKey: .tz)
        try container.encodeIfPresent(rrule, forKey: .rrule)
        try container.encodeIfPresent(intervalMs, forKey: .intervalMs)
        try container.encodeIfPresent(event, forKey: .event)
    }
}

/// `maxTurns: 0` is the strongest statement in the catalogue: a job that cannot spawn
/// a turn cannot be delayed by a rate limit or broken by a model declining to act.
public struct JobBudget: Codable, Equatable, Sendable {
    public let maxTurns: Int
    public let maxWallClockMs: Int
    public let allowedTools: [String]

    public init(maxTurns: Int, maxWallClockMs: Int, allowedTools: [String]) {
        self.maxTurns = maxTurns
        self.maxWallClockMs = maxWallClockMs
        self.allowedTools = allowedTools
    }
}

/// What makes reboot recovery possible. Recovery runs before scheduling.
public struct JobLease: Codable, Equatable, Sendable {
    public let owner: String
    public let expiresAt: Date

    public init(owner: String, expiresAt: Date) {
        self.owner = owner
        self.expiresAt = expiresAt
    }
}

public enum CircuitBreakerState: String, Codable, Equatable, Sendable, CaseIterable {
    case closed
    case open
    case halfOpen = "half_open"
}

/// N consecutive failures disables the kind and reports once. Nothing retries forever.
public struct CircuitBreaker: Codable, Equatable, Sendable {
    public let state: CircuitBreakerState
    public let consecutiveFailures: Int
    public let openedAt: Date?

    public init(state: CircuitBreakerState, consecutiveFailures: Int, openedAt: Date?) {
        self.state = state
        self.consecutiveFailures = consecutiveFailures
        self.openedAt = openedAt
    }

    private enum CodingKeys: String, CodingKey {
        case state, consecutiveFailures, openedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decode(CircuitBreakerState.self, forKey: .state)
        consecutiveFailures = try container.decode(Int.self, forKey: .consecutiveFailures)
        openedAt = try container.decodeRequiredNullable(Date.self, forKey: .openedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(state, forKey: .state)
        try container.encode(consecutiveFailures, forKey: .consecutiveFailures)
        try container.encodeRequiredNullable(openedAt, forKey: .openedAt)
    }
}

public struct Job: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    public let kind: JobKind
    public let state: JobState
    public let priority: JobPriority
    public let trigger: JobTrigger
    public let deliveryClass: JobDeliveryClass
    public let catchUp: JobCatchUp
    public let budget: JobBudget
    public let lease: JobLease?
    public let circuitBreaker: CircuitBreaker
    public let nextRunAt: Date?
    public let lastRunId: SylID?
    /// Whether this kind may produce a proactive message.
    public let speaks: Bool
    public let createdAt: Date
    public let updatedAt: Date

    public init(
        id: SylID,
        kind: JobKind,
        state: JobState,
        priority: JobPriority,
        trigger: JobTrigger,
        deliveryClass: JobDeliveryClass,
        catchUp: JobCatchUp,
        budget: JobBudget,
        lease: JobLease?,
        circuitBreaker: CircuitBreaker,
        nextRunAt: Date?,
        lastRunId: SylID?,
        speaks: Bool,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.kind = kind
        self.state = state
        self.priority = priority
        self.trigger = trigger
        self.deliveryClass = deliveryClass
        self.catchUp = catchUp
        self.budget = budget
        self.lease = lease
        self.circuitBreaker = circuitBreaker
        self.nextRunAt = nextRunAt
        self.lastRunId = lastRunId
        self.speaks = speaks
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, state, priority, trigger, deliveryClass, catchUp, budget
        case lease, circuitBreaker, nextRunAt, lastRunId, speaks, createdAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(SylID.self, forKey: .id)
        kind = try container.decode(JobKind.self, forKey: .kind)
        state = try container.decode(JobState.self, forKey: .state)
        priority = try container.decode(JobPriority.self, forKey: .priority)
        trigger = try container.decode(JobTrigger.self, forKey: .trigger)
        deliveryClass = try container.decode(JobDeliveryClass.self, forKey: .deliveryClass)
        catchUp = try container.decode(JobCatchUp.self, forKey: .catchUp)
        budget = try container.decode(JobBudget.self, forKey: .budget)
        lease = try container.decodeRequiredNullable(JobLease.self, forKey: .lease)
        circuitBreaker = try container.decode(CircuitBreaker.self, forKey: .circuitBreaker)
        nextRunAt = try container.decodeRequiredNullable(Date.self, forKey: .nextRunAt)
        lastRunId = try container.decodeRequiredNullable(SylID.self, forKey: .lastRunId)
        speaks = try container.decode(Bool.self, forKey: .speaks)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(kind, forKey: .kind)
        try container.encode(state, forKey: .state)
        try container.encode(priority, forKey: .priority)
        try container.encode(trigger, forKey: .trigger)
        try container.encode(deliveryClass, forKey: .deliveryClass)
        try container.encode(catchUp, forKey: .catchUp)
        try container.encode(budget, forKey: .budget)
        try container.encodeRequiredNullable(lease, forKey: .lease)
        try container.encode(circuitBreaker, forKey: .circuitBreaker)
        try container.encodeRequiredNullable(nextRunAt, forKey: .nextRunAt)
        try container.encodeRequiredNullable(lastRunId, forKey: .lastRunId)
        try container.encode(speaks, forKey: .speaks)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
    }
}

public typealias JobPage = Page<Job>

public enum RunOutcome: String, Codable, Equatable, Sendable, CaseIterable {
    case success, failure, skipped, suspended, abandoned
}

/// Persisted after every turn and before the next one starts, because a turn is
/// atomic from the outside. Resume is `--resume` against the stored session id.
public struct RunStep: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    public let index: Int
    public let sessionId: String?
    public let numTurns: Int
    public let costUsd: Double
    public let outcome: RunOutcome
    public let summary: String?
    public let startedAt: Date
    public let finishedAt: Date?

    public init(
        id: SylID,
        index: Int,
        sessionId: String?,
        numTurns: Int,
        costUsd: Double,
        outcome: RunOutcome,
        summary: String?,
        startedAt: Date,
        finishedAt: Date?
    ) {
        self.id = id
        self.index = index
        self.sessionId = sessionId
        self.numTurns = numTurns
        self.costUsd = costUsd
        self.outcome = outcome
        self.summary = summary
        self.startedAt = startedAt
        self.finishedAt = finishedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, index, sessionId, numTurns, costUsd, outcome, summary
        case startedAt, finishedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(SylID.self, forKey: .id)
        index = try container.decode(Int.self, forKey: .index)
        sessionId = try container.decodeRequiredNullable(String.self, forKey: .sessionId)
        numTurns = try container.decode(Int.self, forKey: .numTurns)
        costUsd = try container.decode(Double.self, forKey: .costUsd)
        outcome = try container.decode(RunOutcome.self, forKey: .outcome)
        summary = try container.decodeRequiredNullable(String.self, forKey: .summary)
        startedAt = try container.decode(Date.self, forKey: .startedAt)
        finishedAt = try container.decodeRequiredNullable(Date.self, forKey: .finishedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(index, forKey: .index)
        try container.encodeRequiredNullable(sessionId, forKey: .sessionId)
        try container.encode(numTurns, forKey: .numTurns)
        try container.encode(costUsd, forKey: .costUsd)
        try container.encode(outcome, forKey: .outcome)
        try container.encodeRequiredNullable(summary, forKey: .summary)
        try container.encode(startedAt, forKey: .startedAt)
        try container.encodeRequiredNullable(finishedAt, forKey: .finishedAt)
    }
}

/// Every run records the gap between *scheduled* and *actual*. That gap is the whole
/// point — a reminder that fired late is a nuisance, and one that pretended to be on
/// time is a lie.
public struct Run: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    public let jobId: SylID
    public let kind: JobKind
    public let triggerInstant: Date
    public let actualInstant: Date?
    public let latenessMs: Int
    public let outcome: RunOutcome
    public let spoke: Bool
    public let turns: Int
    public let costUsd: Double
    /// The model's own one line about what it did. Absent for zero-turn runs.
    public let summary: String?
    public let error: String?
    public let attempts: Int
    public let startedAt: Date
    public let finishedAt: Date?
    public let steps: [RunStep]

    public init(
        id: SylID,
        jobId: SylID,
        kind: JobKind,
        triggerInstant: Date,
        actualInstant: Date?,
        latenessMs: Int,
        outcome: RunOutcome,
        spoke: Bool,
        turns: Int,
        costUsd: Double,
        summary: String?,
        error: String?,
        attempts: Int,
        startedAt: Date,
        finishedAt: Date?,
        steps: [RunStep]
    ) {
        self.id = id
        self.jobId = jobId
        self.kind = kind
        self.triggerInstant = triggerInstant
        self.actualInstant = actualInstant
        self.latenessMs = latenessMs
        self.outcome = outcome
        self.spoke = spoke
        self.turns = turns
        self.costUsd = costUsd
        self.summary = summary
        self.error = error
        self.attempts = attempts
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.steps = steps
    }

    private enum CodingKeys: String, CodingKey {
        case id, jobId, kind, triggerInstant, actualInstant, latenessMs, outcome
        case spoke, turns, costUsd, summary, error, attempts, startedAt, finishedAt, steps
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(SylID.self, forKey: .id)
        jobId = try container.decode(SylID.self, forKey: .jobId)
        kind = try container.decode(JobKind.self, forKey: .kind)
        triggerInstant = try container.decode(Date.self, forKey: .triggerInstant)
        actualInstant = try container.decodeRequiredNullable(Date.self, forKey: .actualInstant)
        latenessMs = try container.decode(Int.self, forKey: .latenessMs)
        outcome = try container.decode(RunOutcome.self, forKey: .outcome)
        spoke = try container.decode(Bool.self, forKey: .spoke)
        turns = try container.decode(Int.self, forKey: .turns)
        costUsd = try container.decode(Double.self, forKey: .costUsd)
        summary = try container.decodeRequiredNullable(String.self, forKey: .summary)
        error = try container.decodeRequiredNullable(String.self, forKey: .error)
        attempts = try container.decode(Int.self, forKey: .attempts)
        startedAt = try container.decode(Date.self, forKey: .startedAt)
        finishedAt = try container.decodeRequiredNullable(Date.self, forKey: .finishedAt)
        steps = try container.decode([RunStep].self, forKey: .steps)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(jobId, forKey: .jobId)
        try container.encode(kind, forKey: .kind)
        try container.encode(triggerInstant, forKey: .triggerInstant)
        try container.encodeRequiredNullable(actualInstant, forKey: .actualInstant)
        try container.encode(latenessMs, forKey: .latenessMs)
        try container.encode(outcome, forKey: .outcome)
        try container.encode(spoke, forKey: .spoke)
        try container.encode(turns, forKey: .turns)
        try container.encode(costUsd, forKey: .costUsd)
        try container.encodeRequiredNullable(summary, forKey: .summary)
        try container.encodeRequiredNullable(error, forKey: .error)
        try container.encode(attempts, forKey: .attempts)
        try container.encode(startedAt, forKey: .startedAt)
        try container.encodeRequiredNullable(finishedAt, forKey: .finishedAt)
        try container.encode(steps, forKey: .steps)
    }
}

public typealias RunPage = Page<Run>
