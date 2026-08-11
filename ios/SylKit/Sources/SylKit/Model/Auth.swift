import Foundation

/// Exchanged once per device for a bearer token. The pairing code is shown on the
/// server console, single use, short lived.
public struct PairRequest: Codable, Equatable, Sendable {
    public let pairingCode: String
    public let deviceName: String

    public init(pairingCode: String, deviceName: String) {
        self.pairingCode = pairingCode
        self.deviceName = deviceName
    }
}

/// A paired device's bearer token.
public struct TokenGrant: Codable, Equatable, Sendable {
    public let token: String
    /// Always `"Bearer"`; the contract pins it as a constant.
    public let tokenType: String
    public let expiresAt: Date
    public let principal: Principal

    public init(token: String, tokenType: String = "Bearer", expiresAt: Date, principal: Principal) {
        self.token = token
        self.tokenType = tokenType
        self.expiresAt = expiresAt
        self.principal = principal
    }
}

/// There is exactly one. Syl answers to the Commander and to nobody else — that
/// allowlist is the trust boundary, not a placeholder for a user table.
public struct Principal: Codable, Equatable, Sendable {
    public let id: SylID
    public let name: String

    public init(id: SylID, name: String) {
        self.id = id
        self.name = name
    }
}
