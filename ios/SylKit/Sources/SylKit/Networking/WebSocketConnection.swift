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

/// The real one.
public struct URLSessionWebSocketConnector: WebSocketConnecting {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func connect(to url: URL) async throws -> any WebSocketConnection {
        let task = session.webSocketTask(with: url)
        task.resume()
        return URLSessionWebSocketConnection(task: task)
    }
}

/// Wraps `URLSessionWebSocketTask`.
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
