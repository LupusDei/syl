import Foundation

/// One open socket, reduced to the three things the protocol needs from it.
///
/// The seam exists because `URLSessionWebSocketTask` cannot be stubbed:
/// `MockURLProtocol` intercepts data tasks and never sees a WebSocket upgrade. Without
/// a transport protocol the only way to test sequence tracking and gap recovery would
/// be against a live server, which is precisely the kind of test that gets deleted.
public protocol WebSocketConnection: Sendable {
    func send(_ text: String) async throws
    /// The next text frame. Throws when the socket closes, which is how the client
    /// learns to reconnect.
    func receive() async throws -> String
    func close()
}

/// Opens sockets.
public protocol WebSocketConnecting: Sendable {
    func connect(to url: URL) async throws -> any WebSocketConnection
}

/// Why a server URL cannot be turned into a socket URL.
///
/// A Swift error rather than whatever `URLSession` does about it, which is the whole
/// point — see `URLSessionWebSocketConnector.connect`.
public enum SocketURLError: Error, Equatable, CustomStringConvertible {
    /// A scheme that is not `http`, `https`, `ws` or `wss` — including none at all.
    case unsupportedScheme(String?)
    /// A URL that cannot be taken apart and put back together.
    case malformedServerURL(URL)

    public var description: String {
        switch self {
        case .unsupportedScheme(let scheme):
            let named = scheme.map { "\"\($0)\"" } ?? "no scheme"
            return """
                the server URL has \(named); a socket needs http, https, ws or wss
                """
        case .malformedServerURL(let url):
            return "the server URL cannot be parsed: \(url.absoluteString)"
        }
    }
}

extension ServerConfiguration {
    /// The `/ws` endpoint: same origin, same path prefix, same token — and the scheme
    /// the WebSocket API insists on.
    ///
    /// **`http` is not a scheme a socket can be opened on**, and getting that wrong is
    /// not a failed connection. `URLSession.webSocketTask(with:)` raises an
    /// Objective-C `NSGenericException` for any scheme but `ws`/`wss`, and an
    /// `NSException` is not a Swift `Error`: no `do`/`catch` in this package can see
    /// it, so the process aborts with SIGABRT. In the app that is a hard crash on the
    /// first socket connect (`syl-w40`). Everything here exists so that a bad scheme
    /// is a value the caller can handle instead.
    ///
    /// A base that already speaks `ws`/`wss` is passed through, so a caller that has
    /// already done this conversion is not punished for it.
    public func socketURL() throws -> URL {
        let endpoint = baseURL.appendingPathComponent("ws")
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw SocketURLError.malformedServerURL(baseURL)
        }

        // Lowercased to compare, because schemes are case-insensitive by RFC and
        // `URLSession` compares this one literally. Reported in the case it was
        // written in, because that is what the Commander typed and will go looking for.
        switch components.scheme?.lowercased() {
        case "http", "ws":
            components.scheme = "ws"
        case "https", "wss":
            components.scheme = "wss"
        default:
            throw SocketURLError.unsupportedScheme(components.scheme)
        }

        guard let url = components.url else {
            throw SocketURLError.malformedServerURL(baseURL)
        }
        return url
    }
}

/// The real one.
public struct URLSessionWebSocketConnector: WebSocketConnecting {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func connect(to url: URL) async throws -> any WebSocketConnection {
        // **The guard has to be here, not only at the call site.** This is a public
        // type; anything can hand it a URL. `webSocketTask(with:)` answers an `http`
        // one by raising `NSGenericException`, which is not a Swift `Error` and so
        // cannot be caught anywhere in this package — the process aborts. A throw is
        // a failed connection; an `NSException` is a dead app (`syl-w40`).
        let scheme = url.scheme?.lowercased()
        guard scheme == "ws" || scheme == "wss" else {
            throw SocketURLError.unsupportedScheme(url.scheme)
        }
        let task = session.webSocketTask(with: url)
        task.resume()
        return URLSessionWebSocketConnection(task: task)
    }
}

/// Wraps `URLSessionWebSocketTask`.
///
/// **The server speaks first, and this API is pull-based, which is why that is safe.**
/// `auth_challenge` is sent the instant the connection opens. A client built on an
/// event-subscription API that awaits `open` and only *then* attaches a message
/// listener misses the challenge entirely — and a lost first frame looks exactly like
/// a server that never sent one, so the hour goes into reading the server's code and
/// finding it plainly correct.
///
/// `URLSessionWebSocketTask` buffers received frames until `receive()` asks for them,
/// so nothing arrives before someone is listening. Do not "modernise" this into a
/// delegate or a callback registered after the open event.
///
/// Note what is *not* here: no `Authorization` header. Authentication is a frame, not
/// a header — the browser WebSocket API cannot set one, and the iOS client
/// deliberately uses the same handshake so there is one code path across two
/// platforms.
final class URLSessionWebSocketConnection: WebSocketConnection {
    private let task: URLSessionWebSocketTask

    init(task: URLSessionWebSocketTask) {
        self.task = task
    }

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text):
            return text
        case .data(let data):
            // The protocol is JSON text. A binary frame is something else's idea of
            // this endpoint, so decode it rather than drop it silently.
            return String(decoding: data, as: UTF8.self)
        @unknown default:
            throw URLError(.cannotParseResponse)
        }
    }

    func close() {
        task.cancel(with: .goingAway, reason: nil)
    }
}

/// Application-level keepalive bookkeeping.
///
/// Ping and pong ride above any transport-level ping frame, because intermediaries
/// terminate and forge those and the client learns nothing from one coming back.
public struct Keepalive: Equatable, Sendable {
    public let interval: TimeInterval
    /// Two, by protocol. One missed pong is a hiccup; two is a socket that is gone
    /// without having told anyone.
    public let missedPongsBeforeDead: Int

    public private(set) var outstandingPings = 0

    public init(interval: TimeInterval = 30, missedPongsBeforeDead: Int = 2) {
        self.interval = interval
        self.missedPongsBeforeDead = missedPongsBeforeDead
    }

    /// Records a ping. Returns false when the socket should be declared dead.
    public mutating func pingSent() -> Bool {
        outstandingPings += 1
        return outstandingPings <= missedPongsBeforeDead
    }

    public mutating func pongReceived() {
        outstandingPings = 0
    }

    /// A fresh connection starts even.
    public mutating func reset() {
        outstandingPings = 0
    }
}
