import XCTest

@testable import SylKit

/// The client, exercised through `MockURLProtocol` so real `URLRequest` construction,
/// header and body encoding and response decoding all run — with nothing on the wire.
final class APIClientTests: XCTestCase {
    private let baseURL = URL(string: "http://syl.test/api/v1")!

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    /// A client whose retries are instantaneous and whose jitter is fixed, so a test
    /// asserts on the schedule rather than waiting for it.
    private func makeClient(
        retryPolicy: RetryPolicy = .default,
        token: String? = nil,
        recordSleeps: SleepRecorder? = nil
    ) -> APIClient {
        APIClient(
            configuration: ServerConfiguration(baseURL: baseURL),
            session: MockURLProtocol.session(),
            retryPolicy: retryPolicy,
            tokenProvider: StaticTokenProvider(token),
            sleeper: { seconds in recordSleeps?.record(seconds) },
            randomSampler: { 1.0 }
        )
    }

    /// Collects the delays the client asked for. A class because the sleeper closure
    /// crosses into the actor and has to be able to write somewhere shared.
    final class SleepRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [TimeInterval] = []

        func record(_ seconds: TimeInterval) {
            lock.withLock { values.append(seconds) }
        }

        var recorded: [TimeInterval] {
            lock.withLock { values }
        }
    }

    // MARK: - Request construction

    func testShouldBuildTheURLFromTheBaseURLAndTheEndpointPath() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(json: okEnvelope(principal))

        _ = try await makeClient().send(SylAPI.whoami())

        XCTAssertEqual(
            MockURLProtocol.recordedRequests.first?.url?.absoluteString,
            "http://syl.test/api/v1/auth/whoami"
        )
    }

    func testShouldLeaveTheColonsInAResourceIdAlone() async throws {
        // `syl:reminder:<uuid>` goes in a path segment. Colons are legal there, and a
        // client that percent-encodes them produces a 404 that looks like a missing row.
        MockURLProtocol.handler = MockURLProtocol.respond(json: okEnvelope(reminder))
        let id = "syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f"

        _ = try await makeClient().send(SylAPI.reminder(id))

        XCTAssertEqual(
            MockURLProtocol.recordedRequests.first?.url?.absoluteString,
            "http://syl.test/api/v1/reminders/\(id)"
        )
    }

    func testShouldAppendQueryParametersThatWereSupplied() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(json: okEnvelope(emptyReminderPage))

        _ = try await makeClient().send(SylAPI.reminders(limit: 25, state: .scheduled))

        let query = try XCTUnwrap(MockURLProtocol.recordedRequests.first?.url?.query)
        XCTAssertTrue(query.contains("limit=25"), query)
        XCTAssertTrue(query.contains("state=scheduled"), query)
    }

    func testShouldOmitQueryParametersThatWereNotSupplied() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(json: okEnvelope(emptyReminderPage))

        _ = try await makeClient().send(SylAPI.reminders())

        XCTAssertNil(MockURLProtocol.recordedRequests.first?.url?.query)
    }

    func testShouldSendTheBearerTokenWhenTheEndpointNeedsOne() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(json: okEnvelope(principal))

        _ = try await makeClient(token: "syl_pat_abc").send(SylAPI.whoami())

        XCTAssertEqual(
            MockURLProtocol.recordedRequests.first?.value(forHTTPHeaderField: "Authorization"),
            "Bearer syl_pat_abc"
        )
    }

    func testShouldNotSendATokenToHealthWhichIsTheOneUnauthenticatedEndpoint() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(json: okEnvelope(health))

        _ = try await makeClient(token: "syl_pat_abc").send(SylAPI.health())

        XCTAssertNil(
            MockURLProtocol.recordedRequests.first?.value(forHTTPHeaderField: "Authorization")
        )
    }

    func testShouldSendTheIdempotencyKeyOnEveryWrite() async throws {
        // The outbox retries by design. Without a key it duplicates.
        MockURLProtocol.handler = MockURLProtocol.respond(json: okEnvelope(reminder))

        _ = try await makeClient().send(
            SylAPI.completeReminder("syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f",
                                    idempotencyKey: "key-12345678")
        )

        XCTAssertEqual(
            MockURLProtocol.recordedRequests.first?.value(forHTTPHeaderField: "Idempotency-Key"),
            "key-12345678"
        )
    }

    func testShouldEncodeAWriteBodyAsContractShapedJSON() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(json: okEnvelope(reminder))

        _ = try await makeClient().send(
            try SylAPI.createReminder(
                CreateReminderRequest(
                    text: "Call the pharmacy — the refill lapses today.",
                    kind: .commitment,
                    wallTime: "16:00",
                    tz: "America/Chicago",
                    date: "2026-08-09",
                    urgent: true
                ),
                idempotencyKey: "key-12345678"
            )
        )

        let body = try XCTUnwrap(MockURLProtocol.recordedRequests.first?.httpBody)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["wallTime"] as? String, "16:00")
        XCTAssertEqual(object["tz"] as? String, "America/Chicago")
        XCTAssertEqual(object["urgent"] as? Bool, true)
        XCTAssertTrue(object["rrule"] is NSNull, "a required-nullable field is sent, not omitted")
    }

    // MARK: - Response decoding

    func testShouldUnwrapTheSuccessEnvelopeAndReturnTheData() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(json: okEnvelope(principal))

        let result = try await makeClient().send(SylAPI.whoami())

        XCTAssertEqual(result.name, "The Commander")
    }

    func testShouldRaiseATypedAPIErrorWhenSylAnswersWithAnErrorEnvelope() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(
            statusCode: 422,
            json: [
                "success": false,
                "error": [
                    "code": "DEFERRAL_NOT_LATER",
                    "message": "That snooze is not after the current fire time.",
                    "retryable": false,
                    "details": NSNull(),
                    "retryAfterMs": NSNull(),
                ],
            ]
        )

        await assertThrows(
            try await makeClient(retryPolicy: .none)
                .send(SylAPI.reminder("syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f"))
        ) { error in
            XCTAssertEqual(error.code, .deferralNotLater)
            XCTAssertFalse(error.isRetryable)
        }
    }

    func testShouldTreatANonEnvelopeBodyAsATransportProblemRatherThanAnAPIError() async throws {
        // A captive portal answering 200 with HTML is not Syl saying anything.
        MockURLProtocol.handler = MockURLProtocol.respond(
            data: Data("<html>Sign in to continue</html>".utf8)
        )

        await assertThrows(try await makeClient(retryPolicy: .none).send(SylAPI.whoami())) { error in
            guard case .malformedResponse(_, let preview) = error else {
                return XCTFail("expected malformedResponse, got \(error)")
            }
            XCTAssertTrue(preview.contains("Sign in to continue"))
        }
    }

    func testShouldReportADecodingFailureWhenTheBodyIsAnEnvelopeThatDisagreesWithTheModel()
        async throws
    {
        MockURLProtocol.handler = MockURLProtocol.respond(
            json: ["success": true, "data": ["id": "syl:principal:x"]]
        )

        await assertThrows(try await makeClient(retryPolicy: .none).send(SylAPI.whoami())) { error in
            guard case .decoding = error else {
                return XCTFail("expected a decoding failure, got \(error)")
            }
        }
    }

    func testShouldReportWhenTheServerReplayedAStoredResponseForTheSameKey() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(
            json: okEnvelope(reminder),
            headers: ["Idempotency-Replayed": "true"]
        )

        let response = try await makeClient().sendDetailed(
            SylAPI.completeReminder("syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f",
                                    idempotencyKey: "key-12345678")
        )

        XCTAssertTrue(response.replayed, "the retry was harmless and the client can say so")
    }

    // MARK: - Retry

    func testShouldRetryATransportFailureAndSucceedOnTheSecondAttempt() async throws {
        // The Tailscale case: the extension is not resident, the first request fails
        // while the tunnel establishes, and the app must not call that "server down".
        let attempts = Counter()
        MockURLProtocol.handler = { request in
            if attempts.next() == 1 { throw URLError(.cannotConnectToHost) }
            return (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                try JSONSerialization.data(withJSONObject: self.okEnvelope(self.principal))
            )
        }

        let result = try await makeClient().send(SylAPI.whoami())

        XCTAssertEqual(result.name, "The Commander")
        XCTAssertEqual(attempts.value, 2)
    }

    func testShouldStopAfterTheConfiguredNumberOfAttempts() async {
        let attempts = Counter()
        MockURLProtocol.handler = { _ in
            _ = attempts.next()
            throw URLError(.timedOut)
        }

        await assertThrows(
            try await makeClient(retryPolicy: RetryPolicy(maxAttempts: 3, baseDelay: 0))
                .send(SylAPI.whoami())
        ) { _ in }

        XCTAssertEqual(attempts.value, 3)
    }

    func testShouldNotRetryAnErrorTheServerCallsUnretryable() async {
        let attempts = Counter()
        MockURLProtocol.handler = { request in
            _ = attempts.next()
            return (
                HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!,
                try JSONSerialization.data(withJSONObject: [
                    "success": false,
                    "error": [
                        "code": "UNAUTHORIZED", "message": "Token expired.",
                        "retryable": false, "details": NSNull(), "retryAfterMs": NSNull(),
                    ],
                ])
            )
        }

        await assertThrows(try await makeClient().send(SylAPI.whoami())) { error in
            XCTAssertTrue(error.requiresReauthentication)
        }

        XCTAssertEqual(attempts.value, 1, "retrying an auth failure is the worst possible response")
    }

    func testShouldBackOffExponentiallyBetweenAttempts() async {
        let sleeps = SleepRecorder()
        MockURLProtocol.handler = MockURLProtocol.fail(with: .cannotConnectToHost)

        await assertThrows(
            try await makeClient(
                retryPolicy: RetryPolicy(maxAttempts: 4, baseDelay: 0.5, maxDelay: 8, multiplier: 2),
                recordSleeps: sleeps
            ).send(SylAPI.whoami())
        ) { _ in }

        // randomSampler is pinned to 1.0, so jitter is the identity here.
        XCTAssertEqual(sleeps.recorded, [0.5, 1.0, 2.0])
    }

    func testShouldWaitAtLeastAsLongAsTheServerAskedWhenRateLimited() async {
        let sleeps = SleepRecorder()
        MockURLProtocol.handler = { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 429, httpVersion: nil, headerFields: nil)!,
                try JSONSerialization.data(withJSONObject: [
                    "success": false,
                    "error": [
                        "code": "RATE_LIMITED", "message": "Too many writes. Back off.",
                        "retryable": true, "details": NSNull(), "retryAfterMs": 2000,
                    ],
                ])
            )
        }

        await assertThrows(
            try await makeClient(
                retryPolicy: RetryPolicy(maxAttempts: 2, baseDelay: 0.5),
                recordSleeps: sleeps
            ).send(SylAPI.whoami())
        ) { _ in }

        XCTAssertEqual(sleeps.recorded, [2.0], "the server's floor wins over the local schedule")
    }

    /// **A retry the app actually ships**, default arguments and all.
    ///
    /// `makeClient` injects a sleeper into every other case here — correctly, since
    /// the schedule is arithmetic and waiting it out would make the suite slower than
    /// the thing it tests — which meant the default sleeper had never once run. Written
    /// as an async closure in a *default argument* it is built in the caller's module,
    /// and calling it from inside the actor aborts the process: "freed pointer was not
    /// the last allocation", SIGABRT. Built inside `init` from the same source text it
    /// is fine.
    ///
    /// Found on the socket's first real reconnect (`syl-w40`); this is the same defect
    /// on the HTTP side, where it would have fired on the first 503 the app ever saw.
    func testShouldSurviveARetryUsingTheWaitItShipsWith() async throws {
        let attempts = Counter()
        let body = try JSONSerialization.data(withJSONObject: okEnvelope(principal))
        MockURLProtocol.handler = { request in
            // A timeout on the first attempt: the ordinary shape of a tunnel that has
            // not come up yet, and the reason the app retries at all.
            if attempts.next() == 1 {
                throw URLError(.timedOut)
            }
            return (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                body
            )
        }

        // No `sleeper:` and no `randomSampler:`, which is the entire point. Zero delay,
        // so the wait the app ships is executed rather than waited on.
        let client = APIClient(
            configuration: ServerConfiguration(baseURL: baseURL),
            session: MockURLProtocol.session(),
            retryPolicy: RetryPolicy(maxAttempts: 3, baseDelay: 0, maxDelay: 0)
        )

        let principal = try await client.send(SylAPI.whoami())

        XCTAssertEqual(attempts.value, 2, "the transport failure must have been retried")
        XCTAssertFalse(principal.name.isEmpty)
    }

    // MARK: - Fixtures

    private var principal: [String: Any] {
        ["id": "syl:principal:0198f100-0000-7000-8000-000000000001", "name": "The Commander"]
    }

    private var health: [String: Any] {
        [
            "status": "ok", "version": "0.1.0",
            "startedAt": "2026-08-09T05:12:44.001Z", "now": "2026-08-09T07:00:03.114Z",
            "checks": [],
        ]
    }

    private var reminder: [String: Any] {
        [
            "id": "syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f",
            "kind": "commitment",
            "text": "Call the pharmacy — the refill lapses today.",
            "because": "you asked me to chase it after you said the refill lapses today",
            "origin": "he_asked",
            "todoId": NSNull(), "eventId": NSNull(),
            "wallTime": "16:00", "tz": "America/Chicago", "rrule": NSNull(),
            "scheduledFor": "2026-08-09T21:00:00.000Z",
            "nextFireAt": "2026-08-09T21:00:00.000Z",
            "urgent": true, "late": false, "deferredFrom": NSNull(),
            "supersedesPrevious": false, "deliveryState": "scheduled",
            "createdAt": "2026-08-09T06:59:48.400Z", "updatedAt": "2026-08-09T06:59:48.400Z",
            "completedAt": NSNull(),
        ]
    }

    private var emptyReminderPage: [String: Any] {
        ["items": [], "nextCursor": NSNull(), "hasMore": false]
    }

    private func okEnvelope(_ data: Any) -> [String: Any] {
        ["success": true, "data": data]
    }

    // MARK: - Helpers

    /// Counts handler invocations across the `URLSession` delegate thread.
    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0

        @discardableResult
        func next() -> Int {
            lock.withLock {
                count += 1
                return count
            }
        }

        var value: Int { lock.withLock { count } }
    }

    private func assertThrows(
        _ expression: @autoclosure () async throws -> some Any,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ inspect: (APIError) -> Void
    ) async {
        do {
            _ = try await expression()
            XCTFail("expected the call to throw", file: file, line: line)
        } catch let error as APIError {
            inspect(error)
        } catch {
            XCTFail("expected an APIError, got \(error)", file: file, line: line)
        }
    }
}
