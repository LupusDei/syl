import XCTest
@testable import SylKit

/// These tests exist to prove the harness itself, before anything depends on it.
/// Every later networking test in SylKit runs through `MockURLProtocol`, so a bug
/// here would show up as a mysterious failure in some unrelated client test.
final class MockURLProtocolTests: XCTestCase {
    private let url = URL(string: "http://syl.test/v1/ping")!

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    // MARK: - Stubbing a request

    func testShouldReturnTheStubbedBodyAndStatusWhenARequestIsMadeThroughTheMockSession() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(
            statusCode: 201,
            data: Data("pong".utf8),
            headers: ["X-Syl": "yes"]
        )

        let (data, response) = try await MockURLProtocol.session().data(from: url)

        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 201)
        XCTAssertEqual(http.value(forHTTPHeaderField: "X-Syl"), "yes")
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "pong")
    }

    func testShouldSerialiseAJSONObjectAndSetTheContentTypeWhenRespondingWithJSON() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(json: ["ok": true])

        let (data, response) = try await MockURLProtocol.session().data(from: url)

        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 200)
        XCTAssertEqual(http.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let decoded = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Bool])
        XCTAssertEqual(decoded, ["ok": true])
    }

    func testShouldGiveTheHandlerTheRequestItWasCalledWith() async throws {
        var seen: URLRequest?
        MockURLProtocol.handler = { request in
            seen = request
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data())
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("abc", forHTTPHeaderField: "Idempotency-Key")
        _ = try await MockURLProtocol.session().data(for: request)

        XCTAssertEqual(seen?.url, url)
        XCTAssertEqual(seen?.httpMethod, "POST")
        XCTAssertEqual(seen?.value(forHTTPHeaderField: "Idempotency-Key"), "abc")
    }

    // MARK: - Failure paths

    func testShouldSurfaceAThrownURLErrorToTheCallerWhenTheHandlerThrows() async {
        MockURLProtocol.handler = MockURLProtocol.fail(with: .notConnectedToInternet)

        do {
            _ = try await MockURLProtocol.session().data(from: url)
            XCTFail("expected the request to fail")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .notConnectedToInternet)
        } catch {
            XCTFail("expected a URLError, got \(error)")
        }
    }

    func testShouldFailTheRequestRatherThanCrashWhenNoHandlerIsInstalled() async {
        // Adjutant's version calls fatalError here, which kills the whole test
        // process and reports as a crash rather than as the one failing test.
        // Failing the request keeps the signal attached to the test that caused it.
        do {
            _ = try await MockURLProtocol.session().data(from: url)
            XCTFail("expected the request to fail")
        } catch {
            XCTAssertTrue(
                MockURLProtocolError.matches(error, .noHandlerInstalled),
                "expected .noHandlerInstalled, got \(error)"
            )
            XCTAssertTrue(
                (error as NSError).localizedDescription.contains("no handler installed"),
                "the failure message should say what to do about it"
            )
        }
    }

    // MARK: - Recording

    func testShouldRecordEveryRequestItHandlesInOrder() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(json: [:])
        let session = MockURLProtocol.session()

        _ = try await session.data(from: url)
        _ = try await session.data(from: URL(string: "http://syl.test/v1/reminders")!)

        XCTAssertEqual(MockURLProtocol.recordedRequests.count, 2)
        XCTAssertEqual(MockURLProtocol.recordedRequests.first?.url, url)
        XCTAssertEqual(MockURLProtocol.recordedRequests.last?.url?.path, "/v1/reminders")
    }

    func testShouldRecordTheRequestBodyEvenThoughURLSessionDeliversItAsAStream() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(json: [:])

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data(#"{"text":"stand up"}"#.utf8)
        _ = try await MockURLProtocol.session().data(for: request)

        // By the time URLProtocol sees a request, URLSession has moved the body to
        // `httpBodyStream` and left `httpBody` nil. Every project that writes this
        // harness discovers that the hard way, via an assertion on a body that is
        // always nil. Normalising it once, here, is why later tests never have to.
        let recorded = try XCTUnwrap(MockURLProtocol.recordedRequests.first)
        let body = try XCTUnwrap(recorded.httpBody)
        XCTAssertEqual(String(decoding: body, as: UTF8.self), #"{"text":"stand up"}"#)
    }

    func testShouldGiveTheHandlerAReadableBodyOnARequestThatCarriesOne() async throws {
        var seenBody: Data?
        MockURLProtocol.handler = { request in
            seenBody = request.httpBody
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data())
        }

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.httpBody = Data("hello".utf8)
        _ = try await MockURLProtocol.session().data(for: request)

        XCTAssertEqual(seenBody.map { String(decoding: $0, as: UTF8.self) }, "hello")
    }

    func testShouldLeaveHTTPBodyNilOnARequestThatCarriesNoBody() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(json: [:])

        _ = try await MockURLProtocol.session().data(from: url)

        XCTAssertNil(MockURLProtocol.recordedRequests.first?.httpBody)
    }

    // MARK: - Body normalisation, directly

    func testShouldLeaveARequestAloneWhenItsBodyIsAlreadyReadable() {
        var request = URLRequest(url: url)
        request.httpBody = Data("already here".utf8)

        let normalized = MockURLProtocol.normalized(request)

        XCTAssertEqual(normalized.httpBody, request.httpBody)
        XCTAssertNil(normalized.httpBodyStream)
    }

    func testShouldDrainAStreamedBodyLargerThanTheReadBuffer() throws {
        // The drain loop reads in 4 KiB chunks. A body that fits in one chunk would
        // pass even if the loop appended only the first read, so size this well past
        // the buffer — a sync payload or a long reply will be.
        let large = Data((0..<20_000).map { UInt8($0 % 251) })
        var request = URLRequest(url: url)
        request.httpBodyStream = InputStream(data: large)

        let normalized = MockURLProtocol.normalized(request)

        XCTAssertEqual(normalized.httpBody?.count, large.count)
        XCTAssertEqual(normalized.httpBody, large)
        XCTAssertNil(normalized.httpBodyStream)
    }

    func testShouldReportNoBodyWhenTheStreamIsEmpty() {
        var request = URLRequest(url: url)
        request.httpBodyStream = InputStream(data: Data())

        let normalized = MockURLProtocol.normalized(request)

        XCTAssertNil(normalized.httpBody)
    }

    // MARK: - Reset

    func testShouldClearBothTheHandlerAndTheRecordedRequestsOnReset() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(json: [:])
        _ = try await MockURLProtocol.session().data(from: url)
        XCTAssertFalse(MockURLProtocol.recordedRequests.isEmpty)

        MockURLProtocol.reset()

        XCTAssertNil(MockURLProtocol.handler)
        XCTAssertTrue(MockURLProtocol.recordedRequests.isEmpty)
    }

    // MARK: - Session wiring

    func testShouldInstallItselfAsTheOnlyProtocolOnTheSessionItVends() throws {
        let session = MockURLProtocol.session()

        let classes = try XCTUnwrap(session.configuration.protocolClasses)
        XCTAssertEqual(classes.count, 1)
        XCTAssertTrue(classes.first === MockURLProtocol.self)
    }
}
