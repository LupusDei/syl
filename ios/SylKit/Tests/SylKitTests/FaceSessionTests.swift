import XCTest

@testable import SylKit

/// Asking Syl for a face (`syl-chzl.7.1`, T021).
///
/// ## What is actually being protected
///
/// Two things, and only one of them is about JSON.
///
/// The first is the **boundary**: the avatar secret stays on the Mac at home and the
/// device gets a short-lived session key. That is not a property of a decoder, so it is
/// asserted structurally — over the encoded bytes and over the type's own surface — and
/// it is the assertion that must never be softened.
///
/// The second is that a **refusal is legible**. The gesture that reaches this route is a
/// long press on her face, and a long press that cannot open a session has to say so on
/// the spot. `RATE_LIMITED` rendered verbatim is a shrug in the shape of a sentence.
///
/// **The route does not exist yet.** `syl-chzl.3.5` (T011) is building it in parallel, so
/// every test here runs against `MockURLProtocol` and the shapes below are the client's
/// half of an agreed contract rather than a capture of a live server. When the route
/// lands, `shared/fixtures` and the contract suite become the authority and these become
/// what they should be — tests of the client, not of the shape.
final class FaceSessionTests: XCTestCase {
    private let baseURL = URL(string: "http://syl.test/api/v1")!

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    private func makeClient() -> APIClient {
        APIClient(
            configuration: ServerConfiguration(baseURL: baseURL),
            session: MockURLProtocol.session(),
            retryPolicy: .default,
            tokenProvider: StaticTokenProvider("a-device-token"),
            sleeper: { _ in },
            randomSampler: { 1.0 }
        )
    }

    /// A fixed instant. A test that reads the clock is a test that fails at midnight.
    private let expiry = try! Instant.parse("2026-08-22T18:05:00.000Z")

    private func openedSession(
        native: Bool = true,
        capped: Bool = true
    ) -> [String: Any] {
        var body: [String: Any] = [
            "sessionId": "3f2c9a10-1b8e-4a3d-9f21-77c0d1a4b900",
            "sessionKey": "sk_live_short_and_scoped",
        ]
        if capped { body["expiresAt"] = "2026-08-22T18:05:00.000Z" }
        if native {
            body["roomName"] = "syl-face-3f2c9a10"
            body["serverURL"] = "wss://realtime.example.test"
            body["token"] = "a.room.scoped.jwt"
            body["avatarId"] = "48cbc73d-f47f-41de-bed8-58a532b3b84b"
        }
        return body
    }

    /// One ledger row, exactly as `sessionView()` in `backend/src/routes/face.ts`
    /// writes it — `id` renamed to `sessionId`, and no credential material anywhere.
    private func sessionRowBody(ended: String? = nil) -> [String: Any] {
        [
            "sessionId": "s1",
            "avatarId": "48cbc73d-f47f-41de-bed8-58a532b3b84b",
            "openedAt": "2026-08-22T18:00:00.000Z",
            "closedAt": ended == nil ? NSNull() : "2026-08-22T18:02:00.000Z",
            "ended": ended ?? NSNull(),
            "credits": 12.0,
            "dollars": 0.4,
            "lastActivityAt": "2026-08-22T18:01:30.000Z",
        ] as [String: Any]
    }

    private func reportBody(ended: String? = nil) -> [String: Any] {
        [
            "session": sessionRowBody(ended: ended),
            "meter": [
                "elapsedSeconds": 94.5,
                "blocks": 16,
                "credits": 9.0,
                "dollars": 0.31,
            ] as [String: Any],
            "budget": [
                "creditsSpentToday": 36.8,
                "creditCeiling": 100.0,
                "creditsRemaining": 63.2,
                "dollarsSpentToday": 1.84,
            ] as [String: Any],
        ] as [String: Any]
    }

    // MARK: - The boundary

    /// **The one assertion this whole feature is built around.**
    ///
    /// The vendor API key never crosses to the phone. There is nowhere in `FaceSession`
    /// to put one, and this is what keeps it that way: it walks the encoded form and
    /// fails on any key that reads like a durable credential. A future field called
    /// `apiKey` — however innocently added — turns this red rather than shipping.
    func testShouldCarryNoDurableSecretIntoTheClientAtAll() throws {
        let session = FaceSession(
            sessionId: "s1",
            sessionKey: "sk_short_lived",
            expiresAt: expiry,
            roomName: "r",
            serverURL: URL(string: "wss://realtime.example.test"),
            token: "t",
            avatarId: "a"
        )

        let encoded = try SylJSON.encoder().encode(session)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        let forbidden = ["apiKey", "api_key", "secret", "runwayKey", "authorization", "password"]
        for key in forbidden {
            XCTAssertNil(
                object[key],
                """
                FaceSession gained a field called \"\(key)\". The device gets a \
                short-lived session key and nothing else — the secret stays on the Mac.
                """
            )
        }
        XCTAssertEqual(object["sessionKey"] as? String, "sk_short_lived")
    }

    // MARK: - Opening

    func testShouldOpenASessionAtTheContractsPathWithAKey() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(
            json: ["success": true, "data": openedSession()])

        _ = try await makeClient().send(
            SylAPI.openFaceSession(idempotencyKey: "one-press"))

        let request = try XCTUnwrap(MockURLProtocol.recordedRequests.first)
        XCTAssertEqual(request.url?.path, "/api/v1/face/sessions")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "one-press")
    }

    /// A press that succeeds hands back everything and only what T011 promises.
    func testShouldDecodeTheSessionIdKeyAndExpiry() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(
            json: ["success": true, "data": openedSession(native: false)])

        let session = try await makeClient().send(
            SylAPI.openFaceSession(idempotencyKey: "k"))

        XCTAssertEqual(session.sessionId, "3f2c9a10-1b8e-4a3d-9f21-77c0d1a4b900")
        XCTAssertEqual(session.sessionKey, "sk_live_short_and_scoped")
        XCTAssertEqual(session.expiresAt, expiry)
    }

    /// The forward-compatible half. A broker that mints native join credentials is
    /// decoded, and one that does not is decoded too — the client must not require a
    /// coordinated landing to keep compiling against a server that is being built
    /// alongside it.
    func testShouldDecodeNativeJoinCredentialsWhenTheBrokerMintsThem() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(
            json: ["success": true, "data": openedSession()])

        let session = try await makeClient().send(
            SylAPI.openFaceSession(idempotencyKey: "k"))

        XCTAssertEqual(session.roomName, "syl-face-3f2c9a10")
        XCTAssertEqual(session.serverURL?.absoluteString, "wss://realtime.example.test")
        XCTAssertEqual(session.token, "a.room.scoped.jwt")
        XCTAssertTrue(session.canJoin)
    }

    /// And says so honestly when it does not. A browser can turn a session key into a
    /// room; a phone cannot, so this is a session that exists and cannot be rendered —
    /// which the surface has to be able to tell apart from a failure.
    func testShouldReportThatItCannotJoinASessionWithNoRoom() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(
            json: ["success": true, "data": openedSession(native: false)])

        let session = try await makeClient().send(
            SylAPI.openFaceSession(idempotencyKey: "k"))

        XCTAssertFalse(session.canJoin)
    }

    // MARK: - The cap

    func testShouldKnowWhenTheCapIsCloseEnoughToRenewAgainst() throws {
        let session = FaceSession(sessionId: "s", sessionKey: "k", expiresAt: expiry)
        let comfortable = expiry.addingTimeInterval(-120)
        let nearly = expiry.addingTimeInterval(-10)

        XCTAssertFalse(session.isExpiring(at: comfortable))
        XCTAssertTrue(session.isExpiring(at: nearly))
        XCTAssertEqual(
            try XCTUnwrap(session.secondsRemaining(at: comfortable)), 120, accuracy: 0.001)
    }

    /// **The broker does not always publish a cap** — `FaceSessionCredentials` omits the
    /// key when the provider did not report one. A client that decoded that as "expired"
    /// would renew on the first tick and again on the next: a loop, at twenty cents a
    /// minute per lap.
    func testShouldDecodeASessionWithNoPublishedCapAndNeverTryToRenewIt() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(
            json: ["success": true, "data": openedSession(capped: false)])

        let session = try await makeClient().send(
            SylAPI.openFaceSession(idempotencyKey: "k"))

        XCTAssertNil(session.expiresAt)
        XCTAssertNil(session.secondsRemaining(at: expiry))
        XCTAssertFalse(
            session.isExpiring(at: expiry.addingTimeInterval(86_400)),
            "no cap is not an expired cap")
    }

    /// Past the cap is still expiring, not "fine again". An off-by-a-sign here reads as
    /// a session that renews until it drops and then stops trying.
    func testShouldStillCountAnAlreadyExpiredSessionAsExpiring() {
        let session = FaceSession(sessionId: "s", sessionKey: "k", expiresAt: expiry)

        XCTAssertTrue(session.isExpiring(at: expiry.addingTimeInterval(60)))
    }

    // MARK: - Refusals

    /// **The ceiling is not a generic failure.** It arrives as a structured error and it
    /// has to come out the other side as the sentence the broker wrote, so the screen can
    /// tell him his day's budget is gone rather than showing him "rate limited".
    func testShouldReadACeilingRefusalAsTheCeilingAndKeepItsReason() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(
            statusCode: 429,
            json: [
                "success": false,
                "error": [
                    "code": "RATE_LIMITED",
                    "message": "rate limited",
                    "retryable": false,
                    "details": ["reason": "That is today's face budget spent. Tomorrow."] as [String: Any],
                    "retryAfterMs": NSNull(),
                ] as [String: Any],
            ] as [String: Any])

        do {
            _ = try await makeClient().send(SylAPI.openFaceSession(idempotencyKey: "k"))
            XCTFail("a spent ceiling must refuse")
        } catch let error as APIError {
            let refusal = FaceRefusal.from(error)
            XCTAssertEqual(
                refusal, .ceilingReached("That is today's face budget spent. Tomorrow."))
            XCTAssertFalse(
                refusal.isWorthAnotherPress,
                "offering a retry against a spent budget invites him to be refused twice")
        }
    }

    /// A cold lane is *her* not being ready, which is a different sentence and a
    /// different answer to "should I press again".
    func testShouldReadAColdLaneAsNotReadyAndWorthAnotherPress() {
        let refusal = FaceRefusal.from(.api(
            ApiError(
                code: .conflict,
                message: "conflict",
                retryable: true,
                details: .object(["reason": .string("Give me a moment — I am not warm yet.")])
            ),
            status: 409
        ))

        XCTAssertEqual(refusal, .notReady("Give me a moment — I am not warm yet."))
        XCTAssertTrue(refusal.isWorthAnotherPress)
    }

    /// The tailnet being down is not the avatar service being down, and reading them the
    /// same way sends him looking in the wrong place.
    func testShouldReadAnUnreachableMacAsUnreachable() {
        let refusal = FaceRefusal.from(
            .transport(code: .notConnectedToInternet, description: "offline"))

        guard case .unreachable = refusal else {
            return XCTFail("expected unreachable, got \(refusal)")
        }
        XCTAssertFalse(refusal.sentence.isEmpty)
    }

    /// **The requirement that has no exceptions.** Whatever went wrong, there is
    /// something to show — a gesture that silently does nothing reads as a broken app.
    func testShouldAlwaysProduceSomethingToSayWhateverWentWrong() {
        let everything: [APIError] = [
            .transport(code: .timedOut, description: "timed out"),
            .cancelled,
            .malformedResponse(status: 502, preview: "<html>"),
            .decoding("expiresAt"),
        ] + ErrorCode.allCases.map {
            .api(ApiError(code: $0, message: "m", retryable: false), status: 500)
        }

        for error in everything {
            let refusal = FaceRefusal.from(error)
            XCTAssertFalse(
                refusal.sentence.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                "\(error) produced nothing to say")
        }
    }

    // MARK: - State and the meter

    func testShouldReadTheStateAndTheMeterFromTheSessionsOwnPath() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(
            json: ["success": true, "data": reportBody()])

        let report = try await makeClient().send(SylAPI.faceSession("s1"))

        XCTAssertEqual(MockURLProtocol.recordedRequests.first?.url?.path, "/api/v1/face/sessions/s1")
        XCTAssertTrue(report.session.isLive)
        XCTAssertEqual(report.meter.dollars, 0.31, accuracy: 0.0001)
        XCTAssertEqual(report.budget.dollarsSpentToday, 1.84, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(report.budget.fractionSpent()), 0.368, accuracy: 0.0001)
    }

    /// **A reaped session is a different fact from a closed one** and the client must be
    /// able to tell them apart: `reaped` means the server found a face nobody was
    /// watching, which is exactly the leak the phone exists to prevent.
    func testShouldTellAReapedSessionFromAClosedOne() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(
            json: ["success": true, "data": reportBody(ended: "reaped")])

        let report = try await makeClient().send(SylAPI.faceSession("s1"))

        XCTAssertEqual(report.session.ended, .reaped)
        XCTAssertFalse(report.session.isLive)
    }

    /// No usable ceiling renders as *unknown*, never as *unlimited* and never as
    /// *nothing spent*. Dividing by a missing number is how a meter reports "0% of your
    /// budget" on a day with no budget at all.
    func testShouldRefuseToInventAFractionWithNoUsableCeiling() {
        let budget = FaceBudget(
            creditsSpentToday: 40, creditCeiling: 0, creditsRemaining: 0, dollarsSpentToday: 1)

        XCTAssertNil(budget.fractionSpent())
    }

    // MARK: - Closing

    func testShouldCloseWithADeleteAndAnIdempotencyKey() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(
            json: ["success": true, "data": sessionRowBody(ended: "closed")])

        let row = try await makeClient().send(
            SylAPI.closeFaceSession("s1", idempotencyKey: "close-s1"))

        let request = try XCTUnwrap(MockURLProtocol.recordedRequests.first)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/api/v1/face/sessions/s1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "close-s1")
        XCTAssertEqual(row.ended, .closed)
        XCTAssertFalse(row.isLive)
    }

    /// **Closing twice is not an error the client may surface.** Two things both mean
    /// "he has left" — the screen disappearing and the app backgrounding — and they can
    /// race. A second close that reads as a failure would put an error on screen for a
    /// session that shut down exactly as intended.
    func testShouldTreatASecondCloseAsHavingWorked() async throws {
        MockURLProtocol.handler = MockURLProtocol.respond(
            json: ["success": true, "data": sessionRowBody(ended: "closed")])

        let client = makeClient()
        let first = try await client.send(SylAPI.closeFaceSession("s1", idempotencyKey: "c"))
        let second = try await client.send(SylAPI.closeFaceSession("s1", idempotencyKey: "c"))

        XCTAssertEqual(first, second)
        XCTAssertEqual(second.ended, .closed)
    }

    // MARK: - The catalogue's own rules

    func testShouldNotPutAnIdempotencyKeyOnTheMeterRead() {
        XCTAssertNil(SylAPI.faceSession("s1").idempotencyKey)
        XCTAssertEqual(SylAPI.faceSession("s1").method, .get)
    }
}
