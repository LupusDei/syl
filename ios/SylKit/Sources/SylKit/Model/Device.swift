import Foundation

/// Carried **per token**, not as a server-wide setting.
///
/// TestFlight and App Store builds always produce `production` tokens; Xcode-installed
/// builds always produce `sandbox`. Both exist during development, so a global setting
/// breaks one of them and the only symptom is `BadDeviceToken` on every send.
public enum PushEnvironment: String, Codable, Equatable, Sendable, CaseIterable {
    case sandbox, production
}

public enum DevicePlatform: String, Codable, Equatable, Sendable, CaseIterable {
    case ios
}

public struct Device: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    public let platform: DevicePlatform
    public let environment: PushEnvironment
    /// The last 8 hex characters of the APNs token. The full token is never returned —
    /// it is a credential for pushing to his phone.
    public let tokenSuffix: String
    public let name: String
    public let appVersion: String
    public let osVersion: String
    /// Set false on APNs `410` or `BadDeviceToken`. Dead tokens are unregistered
    /// reactively rather than accumulating.
    public let active: Bool
    public let registeredAt: Date
    public let lastSeenAt: Date

    public init(
        id: SylID,
        platform: DevicePlatform,
        environment: PushEnvironment,
        tokenSuffix: String,
        name: String,
        appVersion: String,
        osVersion: String,
        active: Bool,
        registeredAt: Date,
        lastSeenAt: Date
    ) {
        self.id = id
        self.platform = platform
        self.environment = environment
        self.tokenSuffix = tokenSuffix
        self.name = name
        self.appVersion = appVersion
        self.osVersion = osVersion
        self.active = active
        self.registeredAt = registeredAt
        self.lastSeenAt = lastSeenAt
    }
}

public typealias DevicePage = Page<Device>

public struct RegisterDeviceRequest: Codable, Equatable, Sendable {
    /// Hex APNs device token.
    public let token: String
    public let environment: PushEnvironment
    public let platform: DevicePlatform
    public let name: String
    public let appVersion: String
    public let osVersion: String

    public init(
        token: String,
        environment: PushEnvironment,
        platform: DevicePlatform = .ios,
        name: String,
        appVersion: String,
        osVersion: String
    ) {
        self.token = token
        self.environment = environment
        self.platform = platform
        self.name = name
        self.appVersion = appVersion
        self.osVersion = osVersion
    }
}
