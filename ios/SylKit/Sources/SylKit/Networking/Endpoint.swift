import Foundation

/// One query parameter. A tiny type rather than `URLQueryItem` so the whole
/// `Endpoint` is unambiguously `Sendable` and its ordering is stable enough to
/// assert on in a test.
public struct QueryItem: Equatable, Sendable {
    public let name: String
    public let value: String

    public init(_ name: String, _ value: String) {
        self.name = name
        self.value = value
    }
}

public enum HTTPMethod: String, Equatable, Sendable {
    case get = "GET"
    case post = "POST"
    case patch = "PATCH"
    case delete = "DELETE"

    /// Whether this method mutates state, and therefore must carry an idempotency key.
    var isWrite: Bool { self != .get }
}

/// A request, described rather than performed.
///
/// Keeping the description separate from the sending is what lets the outbox in the
/// app queue an intent to disk and replay it later against the same client, and what
/// lets a test assert on the exact bytes without a server.
///
/// **Every write carries an idempotency key**, and the initialiser enforces it. The
/// mobile client retries by design, so a write without a key is a duplicated reminder
/// waiting to happen — that is a compile-time and precondition-level rule here rather
/// than a convention anyone has to remember.
public struct Endpoint<Response: Codable & Equatable & Sendable>: Sendable {
    public let method: HTTPMethod
    public let path: String
    public let query: [QueryItem]
    public let body: Data?
    public let idempotencyKey: String?
    public let requiresAuthentication: Bool

    init(
        method: HTTPMethod,
        path: String,
        query: [QueryItem] = [],
        body: Data? = nil,
        idempotencyKey: String? = nil,
        requiresAuthentication: Bool = true
    ) {
        precondition(
            !method.isWrite || idempotencyKey != nil,
            """
            \(method.rawValue) \(path) has no idempotency key. Every write takes one: \
            the outbox retries by design and will duplicate without it.
            """
        )
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.idempotencyKey = idempotencyKey
        self.requiresAuthentication = requiresAuthentication
    }

    /// A read.
    static func get(
        _ path: String,
        query: [QueryItem] = [],
        requiresAuthentication: Bool = true
    ) -> Endpoint {
        Endpoint(
            method: .get,
            path: path,
            query: query,
            requiresAuthentication: requiresAuthentication
        )
    }

    /// A write with a JSON body.
    static func write(
        _ method: HTTPMethod,
        _ path: String,
        body: some Encodable,
        idempotencyKey: String,
        requiresAuthentication: Bool = true
    ) throws -> Endpoint {
        Endpoint(
            method: method,
            path: path,
            body: try SylJSON.encoder().encode(body),
            idempotencyKey: idempotencyKey,
            requiresAuthentication: requiresAuthentication
        )
    }

    /// A write with no body — `POST /reminders/{id}/complete` and friends.
    static func write(
        _ method: HTTPMethod,
        _ path: String,
        idempotencyKey: String,
        requiresAuthentication: Bool = true
    ) -> Endpoint {
        Endpoint(
            method: method,
            path: path,
            idempotencyKey: idempotencyKey,
            requiresAuthentication: requiresAuthentication
        )
    }
}

/// A response with the bits of protocol metadata a caller may need.
///
/// `replayed` is the outbox's friend: it means the server recognised the idempotency
/// key and returned the stored response rather than doing the work twice. A client
/// that sees it knows its retry was harmless.
public struct APIResponse<Value: Sendable>: Sendable {
    public let value: Value
    public let status: Int
    public let replayed: Bool

    public init(value: Value, status: Int, replayed: Bool) {
        self.value = value
        self.status = status
        self.replayed = replayed
    }
}
