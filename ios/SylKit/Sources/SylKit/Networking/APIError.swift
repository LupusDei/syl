import Foundation

/// Everything that can go wrong between the app and the Mac at home.
///
/// The distinction that earns its keep is `malformedResponse` versus `api`. Every
/// Syl response body is one of two envelope shapes; a body that is neither has not
/// come from Syl at all — it is a proxy, a captive portal, or a Tailscale error page
/// — and it is a transport failure to be retried, not an API error to be shown.
public enum APIError: Error, Equatable, Sendable {
    /// The request never reached Syl. Under Tailscale this is routine rather than
    /// exceptional: since 1.48 the iOS network extension does not stay resident, so
    /// the first request after a wake can fail while the tunnel establishes.
    case transport(code: URLError.Code, description: String)

    /// Syl answered with a structured error. `status` is advisory; `error.code` is
    /// the contract.
    case api(ApiError, status: Int)

    /// The response was not a Syl envelope. Something in the middle answered.
    case malformedResponse(status: Int, preview: String)

    /// The body was envelope-shaped but disagreed with our model. This is the one
    /// case a contract test exists to make impossible in production.
    case decoding(String)

    /// The task was cancelled. Never retried.
    case cancelled

    /// Whether a retry could plausibly succeed.
    ///
    /// Auth failures halt: retrying an auth failure fifty times is the worst possible
    /// response to a token having expired. Validation failures halt because the same
    /// bytes will fail the same way. Everything transport-shaped retries.
    public var isRetryable: Bool {
        switch self {
        case .transport(let code, _):
            return Self.retryableTransportCodes.contains(code)
        case .api(let error, let status):
            // The server's own judgement wins; a 5xx with no opinion is retryable.
            return error.retryable || (status >= 500 && status != 501)
        case .malformedResponse:
            return true
        case .decoding, .cancelled:
            return false
        }
    }

    /// Whether the request may have reached the server despite the failure.
    ///
    /// The distinction matters because `Idempotency-Key` is specified across the whole
    /// contract but, today, only message sends actually deduplicate on it (tracked as
    /// `syl-1mz`). For every other write, a retry after an *ambiguous* failure risks a
    /// second snooze or a duplicated to-do — so the outbox needs to tell "it never
    /// left" from "it may have landed".
    ///
    /// A connection that was never established is unambiguous: nothing was sent. A
    /// timeout, a connection dropped mid-flight, or a 5xx are all "we do not know".
    public var mayHaveReachedTheServer: Bool {
        switch self {
        case .transport(let code, _):
            return !Self.neverLeftTheDeviceCodes.contains(code)
        case .api, .malformedResponse, .decoding:
            // Something answered, so something received the request.
            return true
        case .cancelled:
            return true
        }
    }

    /// Transport failures where the request provably never reached anything.
    static let neverLeftTheDeviceCodes: Set<URLError.Code> = [
        .notConnectedToInternet,
        .cannotFindHost,
        .cannotConnectToHost,
        .dnsLookupFailed,
        .internationalRoamingOff,
        .dataNotAllowed,
        .secureConnectionFailed,
        .badURL,
        .unsupportedURL,
    ]

    /// A server-suggested backoff floor, when there is one.
    public var retryAfter: TimeInterval? {
        guard case .api(let error, _) = self, let ms = error.retryAfterMs else { return nil }
        return TimeInterval(ms) / 1000
    }

    /// The typed code, when Syl answered.
    public var code: ErrorCode? {
        guard case .api(let error, _) = self else { return nil }
        return error.code
    }

    /// Whether the client should stop and re-pair rather than keep trying.
    public var requiresReauthentication: Bool {
        code == .unauthorized || code == .forbidden
    }

    /// Transport failures that are worth another attempt.
    ///
    /// Deliberately a list rather than "anything that is a URLError": a bad URL or an
    /// unsupported scheme is a programming error, and retrying it three times only
    /// delays finding out.
    static let retryableTransportCodes: Set<URLError.Code> = [
        .timedOut,
        .cannotFindHost,
        .cannotConnectToHost,
        .networkConnectionLost,
        .dnsLookupFailed,
        .notConnectedToInternet,
        .resourceUnavailable,
        .secureConnectionFailed,
        .internationalRoamingOff,
        .callIsActive,
        .dataNotAllowed,
    ]

    /// Wraps a `URLError` from `URLSession`, mapping cancellation to its own case so
    /// nothing tries to retry a task the caller deliberately stopped.
    public static func from(_ error: URLError) -> APIError {
        if error.code == .cancelled { return .cancelled }
        return .transport(code: error.code, description: error.localizedDescription)
    }
}

extension APIError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .transport(_, let description):
            return "Could not reach Syl: \(description)"
        case .api(let error, _):
            return error.message
        case .malformedResponse(let status, let preview):
            return """
                Something answered instead of Syl (HTTP \(status)). \
                It replied with: \(preview)
                """
        case .decoding(let detail):
            return "Syl's answer did not match the contract: \(detail)"
        case .cancelled:
            return "Cancelled."
        }
    }
}
