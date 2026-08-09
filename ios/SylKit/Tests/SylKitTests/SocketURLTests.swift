import XCTest

@testable import SylKit

/// Turning Syl's address into a socket address.
///
/// `syl-w40`. This is four lines of string handling guarding a hard crash: the
/// WebSocket API answers an `http` URL with an Objective-C `NSGenericException`, which
/// is not a Swift `Error`, which means no `do`/`catch` in this package can see it and
/// the process aborts with SIGABRT. The app died on its first socket connect.
///
/// It survived 1870 tests because every socket test injected a fake
/// `WebSocketConnecting`, so `URLSessionWebSocketConnector` had never once run. The
/// last case here is the one that matters most: it drives the real connector.
final class SocketURLTests: XCTestCase {
    private func socketURL(_ base: String) throws -> String {
        let url = try XCTUnwrap(URL(string: base))
        return try ServerConfiguration(baseURL: url).socketURL().absoluteString
    }

    // MARK: - The schemes the app is handed

    func testShouldOpenAnHTTPServerOverWs() throws {
        // The local and tailnet profiles both look like this.
        XCTAssertEqual(
            try socketURL("http://127.0.0.1:4201/api/v1"),
            "ws://127.0.0.1:4201/api/v1/ws"
        )
    }

    func testShouldOpenAnHTTPSServerOverWss() throws {
        XCTAssertEqual(
            try socketURL("https://syl.tailnet.ts.net/api/v1"),
            "wss://syl.tailnet.ts.net/api/v1/ws"
        )
    }

    func testShouldLeaveASocketSchemeAlone() throws {
        // A caller that has already done the conversion is not punished for it.
        XCTAssertEqual(try socketURL("ws://127.0.0.1:4201/api/v1"), "ws://127.0.0.1:4201/api/v1/ws")
        XCTAssertEqual(try socketURL("wss://syl.example/api/v1"), "wss://syl.example/api/v1/ws")
    }

    func testShouldTreatTheSchemeCaseInsensitively() throws {
        // Schemes are case-insensitive by RFC and `URLSession` compares this one
        // literally, so the mapping has to normalise rather than pass through.
        XCTAssertEqual(try socketURL("HTTPS://syl.example/api/v1"), "wss://syl.example/api/v1/ws")
    }

    func testShouldNotDoubleTheSlashOnABaseThatEndsInOne() throws {
        XCTAssertEqual(try socketURL("http://syl.example/api/v1/"), "ws://syl.example/api/v1/ws")
    }

    func testShouldKeepThePortAndTheWholePathPrefix() throws {
        // A reverse proxy can mount Syl under a prefix. Losing it would connect to
        // something else entirely on the same host.
        XCTAssertEqual(
            try socketURL("https://home.example:8443/syl/api/v1"),
            "wss://home.example:8443/syl/api/v1/ws"
        )
    }

    // MARK: - The schemes it must refuse

    func testShouldRefuseASchemeNoSocketCanBeOpenedOn() throws {
        let configuration = ServerConfiguration(baseURL: try XCTUnwrap(URL(string: "file:///tmp/api/v1")))

        XCTAssertThrowsError(try configuration.socketURL()) { error in
            XCTAssertEqual(error as? SocketURLError, .unsupportedScheme("file"))
            // The message names the offending scheme: this reaches the Commander as
            // "Syl's address cannot carry a socket", and a message that does not say
            // which part is wrong sends him to the wrong setting.
            XCTAssertTrue("\(error)".contains("file"), "\(error)")
        }
    }

    func testShouldRefuseAServerURLWithNoSchemeAtAll() throws {
        // What a typed-in host becomes when the `https://` is missing.
        let configuration = ServerConfiguration(baseURL: try XCTUnwrap(URL(string: "//syl.example/api/v1")))

        XCTAssertThrowsError(try configuration.socketURL()) { error in
            XCTAssertEqual(error as? SocketURLError, .unsupportedScheme(nil))
        }
    }

    // MARK: - The real connector

    /// **The regression test for the crash itself.**
    ///
    /// No fake, no server: `URLSessionWebSocketConnector` is asked for an `http`
    /// socket and must answer with a Swift error. Before the fix this did not fail —
    /// it aborted the whole test process with signal 6, taking every other case in the
    /// suite with it.
    func testShouldThrowRatherThanAbortWhenAskedForAnHTTPSocket() async throws {
        let connector = URLSessionWebSocketConnector()
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:4201/api/v1/ws"))

        do {
            _ = try await connector.connect(to: url)
            XCTFail("URLSession cannot open an http socket; the connector must say so")
        } catch let error as SocketURLError {
            XCTAssertEqual(error, .unsupportedScheme("http"))
        }
    }

    func testShouldOpenARealTaskForAWsURLWithoutReachingAnything() async throws {
        // Port 1 is not listening. `webSocketTask` is lazy — nothing connects until a
        // frame is asked for — so this proves the guard lets a valid scheme through
        // without needing a server to prove it.
        let connector = URLSessionWebSocketConnector()
        let url = try XCTUnwrap(URL(string: "ws://127.0.0.1:1/api/v1/ws"))

        let connection = try await connector.connect(to: url)

        connection.close()
    }
}
