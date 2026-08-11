import Foundation

/// Liveness and dependency status. The one endpoint that takes no bearer token.
public struct HealthStatus: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Equatable, Sendable, CaseIterable {
        case ok, degraded, down
    }

    public let status: Status
    public let version: String
    public let startedAt: Date
    public let now: Date
    public let checks: [HealthCheck]
    /// What the answering process was BUILT FROM.
    ///
    /// `nil` when the service is running from source rather than from a build,
    /// which is a real answer and not a missing one. Read leniently and always
    /// written back with an explicit null, matching what the service emits —
    /// an absent field is indistinguishable from an older service that never
    /// had one, and "which build is answering" is exactly the question that
    /// must not be ambiguous.
    public let build: BuildInfo?
    /// How many turns are running or queued. Absent from a service with no
    /// conversation surface, so it is read and written as genuinely optional.
    public let turnsInFlight: Int?

    public init(
        status: Status,
        version: String,
        startedAt: Date,
        now: Date,
        checks: [HealthCheck],
        build: BuildInfo? = nil,
        turnsInFlight: Int? = nil
    ) {
        self.status = status
        self.version = version
        self.startedAt = startedAt
        self.now = now
        self.checks = checks
        self.build = build
        self.turnsInFlight = turnsInFlight
    }

    private enum CodingKeys: String, CodingKey {
        case status, version, startedAt, now, checks, build, turnsInFlight
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(Status.self, forKey: .status)
        version = try container.decode(String.self, forKey: .version)
        startedAt = try container.decode(Date.self, forKey: .startedAt)
        now = try container.decode(Date.self, forKey: .now)
        checks = try container.decode([HealthCheck].self, forKey: .checks)
        build = try container.decodeIfPresent(BuildInfo.self, forKey: .build)
        turnsInFlight = try container.decodeIfPresent(Int.self, forKey: .turnsInFlight)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(status, forKey: .status)
        try container.encode(version, forKey: .version)
        try container.encode(startedAt, forKey: .startedAt)
        try container.encode(now, forKey: .now)
        try container.encode(checks, forKey: .checks)
        try container.encodeRequiredNullable(build, forKey: .build)
        try container.encodeIfPresent(turnsInFlight, forKey: .turnsInFlight)
    }
}

/// Provenance for the artifact that is answering, stamped at build time.
///
/// The reason this exists at all: a stale build is invisible by construction.
/// Every health check passes, because the old build is perfectly healthy. It
/// cost three hours once — the service ran from 19:58 while a fix landed at
/// 20:18 — and it was noticed only because the Commander thought something read
/// oddly and asked.
public struct BuildInfo: Codable, Equatable, Sendable {
    /// The full SHA the build was made from, or `nil` when it was made outside
    /// a checkout — worth reporting rather than hiding.
    public let commit: String?
    public let builtAt: Date
    /// Whether the tree had uncommitted changes at build time. A dirty build
    /// cannot be reproduced from `commit`.
    public let dirty: Bool
    public let branch: String?

    public init(commit: String?, builtAt: Date, dirty: Bool, branch: String?) {
        self.commit = commit
        self.builtAt = builtAt
        self.dirty = dirty
        self.branch = branch
    }

    private enum CodingKeys: String, CodingKey {
        case commit, builtAt, dirty, branch
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        commit = try container.decodeIfPresent(String.self, forKey: .commit)
        builtAt = try container.decode(Date.self, forKey: .builtAt)
        dirty = try container.decode(Bool.self, forKey: .dirty)
        branch = try container.decodeIfPresent(String.self, forKey: .branch)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeRequiredNullable(commit, forKey: .commit)
        try container.encode(builtAt, forKey: .builtAt)
        try container.encode(dirty, forKey: .dirty)
        try container.encodeRequiredNullable(branch, forKey: .branch)
    }
}

public struct HealthCheck: Codable, Equatable, Sendable {
    public let name: String
    public let status: HealthStatus.Status
    /// Optional in the contract, not required-and-nullable — so it is read
    /// leniently and always written back with an explicit null, which is the
    /// shape the service actually emits.
    public let detail: String?

    public init(name: String, status: HealthStatus.Status, detail: String?) {
        self.name = name
        self.status = status
        self.detail = detail
    }

    private enum CodingKeys: String, CodingKey {
        case name, status, detail
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        status = try container.decode(HealthStatus.Status.self, forKey: .status)
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(status, forKey: .status)
        try container.encodeRequiredNullable(detail, forKey: .detail)
    }
}
