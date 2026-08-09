import Foundation

/// Raised by the harness itself, never by code under test.
enum MockURLProtocolError: Int, Error, Equatable, CustomNSError {
    /// A request reached the harness with no stub installed. Almost always a
    /// missing `MockURLProtocol.handler = ...` in the test, or a `reset()` in
    /// `tearDown` that ran between the arrange and the act.
    case noHandlerInstalled = 1

    static let errorDomain = "SylKit.MockURLProtocol"

    var errorCode: Int { rawValue }

    var errorUserInfo: [String: Any] {
        switch self {
        case .noHandlerInstalled:
            return [NSLocalizedDescriptionKey: """
                MockURLProtocol received a request with no handler installed. \
                Set MockURLProtocol.handler before the request is made.
                """]
        }
    }

    /// `URLSession` rebuilds the `NSError` a `URLProtocol` hands it rather than
    /// forwarding the original, so the Swift error the harness threw cannot be
    /// recovered with `as?` on the far side — it always comes back nil. Match on
    /// domain and code instead.
    static func matches(_ error: Error, _ expected: MockURLProtocolError) -> Bool {
        let error = error as NSError
        return error.domain == errorDomain && error.code == expected.errorCode
    }
}

/// The stubbing harness every networking test in SylKit runs through.
///
/// It intercepts requests below `URLSession`, so the client under test is exercised
/// exactly as it will run in the app — real `URLRequest` construction, real header
/// and body encoding, real response decoding — with nothing on the wire and no
/// simulator involved. That is what keeps SylKit's tests fast enough to run on every
/// save, and it is the reason the package is allowed no dependencies.
///
/// ```swift
/// MockURLProtocol.handler = MockURLProtocol.respond(json: ["ok": true])
/// let (data, response) = try await MockURLProtocol.session().data(from: url)
/// ```
///
/// Call `MockURLProtocol.reset()` in `tearDown`. The state is static — it has to be,
/// because `URLSession` instantiates the protocol class itself and gives us no seam
/// to inject through — so a stub left installed leaks into the next test.
final class MockURLProtocol: URLProtocol {
    /// Given the request, return the response and body to reply with. Throw to fail
    /// the request; a thrown `URLError` reaches the caller as a `URLError`, which is
    /// how transport failures (timeouts, a dropped tailnet) are simulated.
    typealias Handler = (URLRequest) throws -> (HTTPURLResponse, Data)

    // MARK: - Stub state

    /// `@unchecked Sendable` is load-bearing and deliberate. The stub is written on the
    /// test thread and read on the `URLSession` delegate thread, so the state genuinely
    /// crosses isolation domains; the `NSLock` is what makes that safe. The compiler
    /// cannot verify it because `Handler` is a plain (non-`Sendable`) closure, and
    /// requiring `@Sendable` stubs would forbid the ordinary `var seen: URLRequest?`
    /// capture that assertion-in-the-handler tests rely on. Locked access is the trade.
    private final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var handler: Handler?
        private var recorded: [URLRequest] = []

        var currentHandler: Handler? {
            get { lock.withLock { handler } }
            set { lock.withLock { handler = newValue } }
        }

        var recordedRequests: [URLRequest] {
            lock.withLock { recorded }
        }

        func record(_ request: URLRequest) {
            lock.withLock { recorded.append(request) }
        }

        func reset() {
            lock.withLock {
                handler = nil
                recorded = []
            }
        }
    }

    private static let state = State()

    /// The stub in force. `nil` means any request fails with `.noHandlerInstalled`.
    static var handler: Handler? {
        get { state.currentHandler }
        set { state.currentHandler = newValue }
    }

    /// Every request the harness has handled since the last `reset()`, in order, with
    /// `httpBody` populated (see `normalized(_:)`).
    static var recordedRequests: [URLRequest] {
        state.recordedRequests
    }

    /// Clears the stub and the recorded requests. Call this in `tearDown`.
    static func reset() {
        state.reset()
    }

    // MARK: - Session

    /// A `URLSession` with this protocol installed as its only handler.
    ///
    /// Ephemeral by default so no on-disk cache or cookie store survives between
    /// tests — a cached 200 answering a request the test expected to reach the stub
    /// is a genuinely confusing failure.
    static func session(configuration: URLSessionConfiguration = .ephemeral) -> URLSession {
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    // MARK: - Canned responses

    /// Reply with raw bytes.
    static func respond(
        statusCode: Int = 200,
        data: Data = Data(),
        headers: [String: String] = [:]
    ) -> Handler {
        { request in
            (try makeResponse(for: request, statusCode: statusCode, headers: headers), data)
        }
    }

    /// Reply with a JSON body, serialised from a Foundation object so the fixture is
    /// written in the shape the wire actually carries rather than in our own types.
    /// Encoding a Swift model here would test the encoder against itself.
    static func respond(
        statusCode: Int = 200,
        json: Any,
        headers: [String: String] = [:]
    ) -> Handler {
        { request in
            let data = try JSONSerialization.data(withJSONObject: json)
            var headers = headers
            headers["Content-Type"] = headers["Content-Type"] ?? "application/json"
            return (try makeResponse(for: request, statusCode: statusCode, headers: headers), data)
        }
    }

    /// Fail the request at the transport layer, the way an unreachable server does.
    static func fail(with code: URLError.Code) -> Handler {
        { _ in throw URLError(code) }
    }

    private static func makeResponse(
        for request: URLRequest,
        statusCode: Int,
        headers: [String: String]
    ) throws -> HTTPURLResponse {
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: statusCode,
                  httpVersion: "HTTP/1.1",
                  headerFields: headers
              )
        else {
            throw URLError(.badURL)
        }
        return response
    }

    // MARK: - Body normalisation

    /// Returns the request with its body readable from `httpBody`.
    ///
    /// `URLSession` moves a request body into `httpBodyStream` before a `URLProtocol`
    /// ever sees it and leaves `httpBody` nil. Reading the stream is also one-shot, so
    /// a handler and a later assertion cannot both have it. Draining it once here and
    /// writing it back means neither the stub nor the test has to know any of that.
    static func normalized(_ request: URLRequest) -> URLRequest {
        guard request.httpBody == nil, let stream = request.httpBodyStream else {
            return request
        }

        var buffer = [UInt8](repeating: 0, count: 4096)
        var body = Data()
        stream.open()
        defer { stream.close() }
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            body.append(contentsOf: buffer[0..<read])
        }

        var normalized = request
        normalized.httpBodyStream = nil
        normalized.httpBody = body.isEmpty ? nil : body
        return normalized
    }

    // MARK: - URLProtocol

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let request = MockURLProtocol.normalized(request)
        MockURLProtocol.state.record(request)

        guard let handler = MockURLProtocol.handler else {
            // Deliberately not `fatalError`: that takes down the whole test process
            // and reports as a crash rather than as the one test that forgot a stub.
            client?.urlProtocol(self, didFailWithError: MockURLProtocolError.noHandlerInstalled)
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
