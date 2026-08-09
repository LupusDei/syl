import Foundation

/// Supplies the bearer token. An `async` read because the real implementation reads
/// the Keychain, and because a token refresh must be able to happen behind it without
/// every call site learning about it.
public protocol TokenProviding: Sendable {
    func token() async -> String?
}

/// A fixed token. Enough for tests and for a paired device that has not been asked to
/// re-pair.
public struct StaticTokenProvider: TokenProviding {
    private let value: String?

    public init(_ value: String?) {
        self.value = value
    }

    public func token() async -> String? { value }
}

/// Where the service lives.
///
/// The base URL includes the `/api/v1` prefix, exactly as it appears in the contract's
/// `servers` block, so an endpoint path is the path from the spec and nothing has to
/// remember to add a version.
///
/// Note what is *not* here: no ngrok header, no tunnel bypass. Adjutant carried those
/// and they are obsolete under Tailscale, where the tailnet name resolves to a real
/// host with a real publicly-trusted certificate.
public struct ServerConfiguration: Equatable, Sendable {
    public let baseURL: URL

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }

    /// The mock server, `npm run mock`.
    public static let mock = ServerConfiguration(baseURL: URL(string: "http://127.0.0.1:4210/api/v1")!)
}

/// The HTTP client.
///
/// An actor because the retry loop, the token read and the request build all touch
/// shared state, and because the app will call it from a view model, a background
/// task and a notification handler at the same time.
public actor APIClient {
    /// Waits before a retry. Injected so tests exercise the backoff schedule without
    /// spending the wall-clock time it describes.
    public typealias Sleeper = @Sendable (TimeInterval) async throws -> Void
    /// Samples jitter in `0...1`. Injected so a test can assert on an exact delay.
    public typealias RandomSampler = @Sendable () -> Double

    private let configuration: ServerConfiguration
    private let session: URLSession
    private let retryPolicy: RetryPolicy
    private let tokenProvider: TokenProviding
    private let sleeper: Sleeper
    private let randomSampler: RandomSampler

    public init(
        configuration: ServerConfiguration,
        session: URLSession = .shared,
        retryPolicy: RetryPolicy = .default,
        tokenProvider: TokenProviding = StaticTokenProvider(nil),
        sleeper: @escaping Sleeper = { seconds in
            try await Task.sleep(nanoseconds: UInt64(max(seconds, 0) * 1_000_000_000))
        },
        randomSampler: @escaping RandomSampler = { Double.random(in: 0...1) }
    ) {
        self.configuration = configuration
        self.session = session
        self.retryPolicy = retryPolicy
        self.tokenProvider = tokenProvider
        self.sleeper = sleeper
        self.randomSampler = randomSampler
    }

    /// Performs the request, retrying per the policy, and returns the envelope's data.
    public func send<Response>(_ endpoint: Endpoint<Response>) async throws -> Response {
        try await sendDetailed(endpoint).value
    }

    /// Performs the request and returns the protocol metadata alongside the value.
    public func sendDetailed<Response>(
        _ endpoint: Endpoint<Response>
    ) async throws -> APIResponse<Response> {
        var attempt = 1
        while true {
            do {
                return try await perform(endpoint)
            } catch let error as APIError {
                guard retryPolicy.shouldRetry(after: error, attempt: attempt) else { throw error }
                let delay = retryPolicy.delay(
                    beforeAttempt: attempt + 1,
                    randomSample: randomSampler(),
                    serverFloor: error.retryAfter
                )
                try await sleeper(delay)
                attempt += 1
            }
        }
    }

    // MARK: - One attempt

    private func perform<Response>(
        _ endpoint: Endpoint<Response>
    ) async throws -> APIResponse<Response> {
        let request = try await makeRequest(for: endpoint)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw APIError.from(error)
        } catch is CancellationError {
            throw APIError.cancelled
        } catch {
            // A URLProtocol can fail a request with any error; anything that is not a
            // URLError still means the bytes never made it, so it is transport.
            throw APIError.transport(code: .unknown, description: error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.malformedResponse(status: 0, preview: Self.preview(of: data))
        }

        return try Self.decode(data: data, http: http)
    }

    /// Turns an endpoint into a `URLRequest`.
    ///
    /// Kept separate and non-private-to-the-attempt so the retry loop rebuilds it
    /// every time: a token can be refreshed between attempts, and a request built once
    /// and replayed would carry the stale one.
    func makeRequest<Response>(for endpoint: Endpoint<Response>) async throws -> URLRequest {
        guard
            var components = URLComponents(
                url: configuration.baseURL,
                resolvingAgainstBaseURL: false
            )
        else {
            throw APIError.transport(code: .badURL, description: "bad base URL")
        }

        components.path = components.path + endpoint.path
        if !endpoint.query.isEmpty {
            components.queryItems = endpoint.query.map { URLQueryItem(name: $0.name, value: $0.value) }
        }

        guard let url = components.url else {
            throw APIError.transport(code: .badURL, description: "could not build \(endpoint.path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let body = endpoint.body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let key = endpoint.idempotencyKey {
            request.setValue(key, forHTTPHeaderField: "Idempotency-Key")
        }
        if endpoint.requiresAuthentication, let token = await tokenProvider.token() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    // MARK: - Decoding

    /// The envelope discriminator, read before committing to either shape.
    private struct EnvelopePeek: Decodable {
        let success: Bool
    }

    static func decode<Response: Codable & Equatable & Sendable>(
        data: Data,
        http: HTTPURLResponse
    ) throws -> APIResponse<Response> {
        let decoder = SylJSON.decoder()

        guard let peek = try? decoder.decode(EnvelopePeek.self, from: data) else {
            // Not an envelope at all. A proxy, a captive portal, or a Tailscale error
            // page — a transport problem wearing an HTTP status, not an API error.
            throw APIError.malformedResponse(status: http.statusCode, preview: preview(of: data))
        }

        guard peek.success else {
            do {
                let envelope = try decoder.decode(ErrorEnvelope.self, from: data)
                throw APIError.api(envelope.error, status: http.statusCode)
            } catch let error as APIError {
                throw error
            } catch {
                throw APIError.decoding(String(describing: error))
            }
        }

        do {
            let envelope = try decoder.decode(Envelope<Response>.self, from: data)
            return APIResponse(
                value: envelope.data,
                status: http.statusCode,
                replayed: http.value(forHTTPHeaderField: "Idempotency-Replayed") == "true"
            )
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    /// A short, safe excerpt of a body that is not ours, for the error message. Long
    /// enough to recognise an HTML error page, short enough not to fill a log.
    static func preview(of data: Data) -> String {
        let text = String(decoding: data.prefix(200), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "<empty body>" : text
    }
}
