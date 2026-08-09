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

    public init(
        status: Status,
        version: String,
        startedAt: Date,
        now: Date,
        checks: [HealthCheck]
    ) {
        self.status = status
        self.version = version
        self.startedAt = startedAt
        self.now = now
        self.checks = checks
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
