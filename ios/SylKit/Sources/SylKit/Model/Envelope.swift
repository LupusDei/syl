import Foundation

/// Every response body — success or failure — is one of two shapes. A body that is
/// neither has not come from Syl: it is a proxy, a captive portal, or a Tailscale
/// error page, and the client treats it as a transport failure rather than an API
/// error. See `APIError.malformedResponse`.
public struct Envelope<Data: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public let data: Data

    public init(data: Data) {
        self.data = data
    }

    private enum CodingKeys: String, CodingKey {
        case success
        case data
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let success = try container.decode(Bool.self, forKey: .success)
        guard success else {
            throw DecodingError.dataCorruptedError(
                forKey: .success,
                in: container,
                debugDescription: "expected a success envelope; got success: false"
            )
        }
        self.data = try container.decode(Data.self, forKey: .data)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(true, forKey: .success)
        try container.encode(data, forKey: .data)
    }
}

/// The failure half of the envelope.
public struct ErrorEnvelope: Codable, Equatable, Sendable {
    public let error: ApiError

    public init(error: ApiError) {
        self.error = error
    }

    private enum CodingKeys: String, CodingKey {
        case success
        case error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let success = try container.decode(Bool.self, forKey: .success)
        guard !success else {
            throw DecodingError.dataCorruptedError(
                forKey: .success,
                in: container,
                debugDescription: "expected an error envelope; got success: true"
            )
        }
        self.error = try container.decode(ApiError.self, forKey: .error)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(false, forKey: .success)
        try container.encode(error, forKey: .error)
    }
}

/// The typed error code is the contract; the HTTP status is advisory. Clients
/// branch on this, never on the status line.
///
/// Closed on purpose. `PresenceState` is the one open enum in this contract, and it
/// is open because a frozen character is worse than an unknown one — an unknown
/// *error code* has no such safe rendering, and silently mapping it to something
/// familiar would be worse than failing loudly.
public enum ErrorCode: String, Codable, Equatable, Sendable, CaseIterable {
    case validationFailed = "VALIDATION_FAILED"
    case unauthorized = "UNAUTHORIZED"
    /// The pairing code was right ten minutes ago, or another one superseded it.
    ///
    /// These two are the only place the service tells one authentication failure from
    /// another, and they are safe for the same reason they are useful: **both are
    /// reachable only by presenting a code that matches a stored one.** A wrong guess
    /// and an attempt made while no code is live are the same `unauthorized`, so
    /// nothing here narrows a search — it only tells the person who already holds the
    /// code which of the four things went wrong, which is the difference between a
    /// pairing screen and a shrug.
    case pairingCodeExpired = "PAIRING_CODE_EXPIRED"
    /// The code was right, and a device has already spent it.
    case pairingCodeAlreadyUsed = "PAIRING_CODE_ALREADY_USED"
    case forbidden = "FORBIDDEN"
    case notFound = "NOT_FOUND"
    case conflict = "CONFLICT"
    case idempotencyKeyReuse = "IDEMPOTENCY_KEY_REUSE"
    case idempotencyKeyRequired = "IDEMPOTENCY_KEY_REQUIRED"
    case deferralNotLater = "DEFERRAL_NOT_LATER"
    case rruleUnsupported = "RRULE_UNSUPPORTED"
    case unknownJobKind = "UNKNOWN_JOB_KIND"
    case deviceTokenInvalid = "DEVICE_TOKEN_INVALID"
    case quietHours = "QUIET_HOURS"
    case rateLimited = "RATE_LIMITED"
    case upstreamUnavailable = "UPSTREAM_UNAVAILABLE"
    case internalError = "INTERNAL"
}

/// The structured error every transport carries — HTTP responses and the WebSocket
/// `error` frame both. One error renderer serves both.
public struct ApiError: Codable, Equatable, Sendable {
    public let code: ErrorCode
    /// Human-readable, for a log line or an admin screen. Never parsed.
    public let message: String
    /// Whether the client's backoff should try again.
    ///
    /// Auth failures halt rather than retry: retrying an auth failure fifty times is
    /// the worst possible response to a key having shadowed the subscription login.
    public let retryable: Bool
    /// Structured context. `VALIDATION_FAILED` carries `{ field, reason }[]`.
    public let details: JSONValue?
    /// Server-suggested backoff floor, when it knows one.
    public let retryAfterMs: Int?

    public init(
        code: ErrorCode,
        message: String,
        retryable: Bool,
        details: JSONValue? = nil,
        retryAfterMs: Int? = nil
    ) {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details = details
        self.retryAfterMs = retryAfterMs
    }

    private enum CodingKeys: String, CodingKey {
        case code, message, retryable, details, retryAfterMs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        code = try container.decode(ErrorCode.self, forKey: .code)
        message = try container.decode(String.self, forKey: .message)
        retryable = try container.decode(Bool.self, forKey: .retryable)
        details = try container.decodeRequiredNullable(JSONValue.self, forKey: .details)
        retryAfterMs = try container.decodeRequiredNullable(Int.self, forKey: .retryAfterMs)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(code, forKey: .code)
        try container.encode(message, forKey: .message)
        try container.encode(retryable, forKey: .retryable)
        try container.encodeRequiredNullable(details, forKey: .details)
        try container.encodeRequiredNullable(retryAfterMs, forKey: .retryAfterMs)
    }
}

/// A cursor-paginated page. Every list endpoint returns this shape, so it is one
/// generic rather than nine identical structs.
public struct Page<Item: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public let items: [Item]
    /// Pass as `cursor` for the next page. Null on the last page.
    public let nextCursor: String?
    public let hasMore: Bool

    public init(items: [Item], nextCursor: String?, hasMore: Bool) {
        self.items = items
        self.nextCursor = nextCursor
        self.hasMore = hasMore
    }

    private enum CodingKeys: String, CodingKey {
        case items, nextCursor, hasMore
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([Item].self, forKey: .items)
        nextCursor = try container.decodeRequiredNullable(String.self, forKey: .nextCursor)
        hasMore = try container.decode(Bool.self, forKey: .hasMore)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(items, forKey: .items)
        try container.encodeRequiredNullable(nextCursor, forKey: .nextCursor)
        try container.encode(hasMore, forKey: .hasMore)
    }
}
