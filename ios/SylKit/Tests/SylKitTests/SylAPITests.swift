import XCTest

@testable import SylKit

/// The endpoint catalogue, checked without a client.
///
/// Paths and methods are the part of a wire layer that fails silently: a typo yields
/// a 404 that looks like a missing row, and a `POST` where the contract says `PATCH`
/// yields a 405 nobody reads. Asserting them here means the mistake is a red test
/// rather than an afternoon.
final class SylAPITests: XCTestCase {
    // MARK: - Every write carries a key

    func testShouldCarryAnIdempotencyKeyOnEveryWriteInTheCatalogue() throws {
        // Not a spot check: this design retries by intent, and a write that reached the
        // catalogue without a key would duplicate a reminder in production.
        let writes: [(String, HTTPMethod, String?)] = [
            try describe(SylAPI.pair(PairRequest(pairingCode: "1", deviceName: "d"), idempotencyKey: "k")),
            try describe(SylAPI.sendMessage(
                conversationId: "c",
                SendMessageRequest(clientId: "c1", text: "hi", conversationId: nil),
                idempotencyKey: "k"
            )),
            try describe(SylAPI.createReminder(
                CreateReminderRequest(text: "t", wallTime: "07:00", tz: "America/Chicago"),
                idempotencyKey: "k"
            )),
            try describe(SylAPI.updateReminder("r", UpdateReminderRequest(text: "t"), idempotencyKey: "k")),
            describe(SylAPI.cancelReminder("r", idempotencyKey: "k")),
            describe(SylAPI.completeReminder("r", idempotencyKey: "k")),
            try describe(SylAPI.snoozeReminder("r", .minutes(15), idempotencyKey: "k")),
            try describe(SylAPI.createTodo(CreateTodoRequest(text: "t"), idempotencyKey: "k")),
            try describe(SylAPI.updateTodo("t", UpdateTodoRequest(pinned: true), idempotencyKey: "k")),
            describe(SylAPI.completeTodo("t", idempotencyKey: "k")),
            try describe(SylAPI.createGoal(CreateGoalRequest(title: "g"), idempotencyKey: "k")),
            try describe(SylAPI.registerDevice(
                RegisterDeviceRequest(
                    token: "abc", environment: .production, name: "iPhone",
                    appVersion: "0.1.0", osVersion: "26.1"
                ),
                idempotencyKey: "k"
            )),
            describe(SylAPI.unregisterDevice("d", idempotencyKey: "k")),
            try describe(SylAPI.acknowledgeDelivery(
                "d", AcknowledgeDeliveryRequest(ackedAt: Date()), idempotencyKey: "k"
            )),
        ]

        for (path, method, key) in writes {
            XCTAssertNotEqual(method, .get, "\(path) is in the write list but is a GET")
            XCTAssertEqual(key, "k", "\(method.rawValue) \(path) lost its idempotency key")
        }
    }

    func testShouldNotPutAnIdempotencyKeyOnARead() {
        XCTAssertNil(SylAPI.whoami().idempotencyKey)
        XCTAssertNil(SylAPI.reminders().idempotencyKey)
        XCTAssertNil(SylAPI.constellation().idempotencyKey)
    }

    func testShouldReadTheConstellationFromItsOwnPathAndNotTheAdminGraph() {
        // The two are different products on purpose. `/memory/graph` carries node
        // seeds, edge budgets and dream nights — instrument controls for judging
        // the inferred engine — and a typo pointing the phone at it yields a
        // payload the sky cannot draw and a 404 nobody reads.
        XCTAssertEqual(SylAPI.constellation().path, "/memory/constellation")
        XCTAssertEqual(SylAPI.constellation().method, .get)
        XCTAssertTrue(SylAPI.constellation().query.isEmpty)
    }

    func testShouldSendTheStarBoundOnlyWhenTheCallerAsksForOne() {
        // Omitted means "the server's default", which is a different request
        // from one naming a number — and the server refuses an out-of-range
        // `stars` rather than clamping it, so a client that always sends one has
        // to be right about the range.
        XCTAssertEqual(SylAPI.constellation(stars: 24).query.map(\.name), ["stars"])
        XCTAssertEqual(SylAPI.constellation(stars: 24).query.map(\.value), ["24"])
    }

    // MARK: - Paths and methods

    func testShouldUseTheContractPathsForTheReminderLifecycle() throws {
        XCTAssertEqual(SylAPI.reminders().path, "/reminders")
        XCTAssertEqual(SylAPI.reminder("r").path, "/reminders/r")
        XCTAssertEqual(
            try SylAPI.createReminder(
                CreateReminderRequest(text: "t", wallTime: "07:00", tz: "America/Chicago"),
                idempotencyKey: "k"
            ).method,
            .post
        )
        XCTAssertEqual(
            try SylAPI.updateReminder("r", UpdateReminderRequest(), idempotencyKey: "k").method,
            .patch
        )
        XCTAssertEqual(SylAPI.cancelReminder("r", idempotencyKey: "k").method, .delete)
        XCTAssertEqual(
            try SylAPI.snoozeReminder("r", .minutes(15), idempotencyKey: "k").path,
            "/reminders/r/snooze"
        )
    }

    func testShouldPutTheConversationIdInTheMessagePath() {
        XCTAssertEqual(
            SylAPI.messages(conversationId: SylIDs.interactiveConversation).path,
            "/conversations/\(SylIDs.interactiveConversation)/messages"
        )
    }

    func testShouldNotRequireATokenForHealth() {
        // The one endpoint outside the bearer requirement — which is what lets the app
        // tell "unreachable" from "unauthorised" before it has paired.
        XCTAssertFalse(SylAPI.health().requiresAuthentication)
        XCTAssertTrue(SylAPI.whoami().requiresAuthentication)
    }

    func testShouldNotRequireATokenToPair() {
        let endpoint = try? SylAPI.pair(
            PairRequest(pairingCode: "4821-9930", deviceName: "Commander's iPhone"),
            idempotencyKey: "k"
        )

        XCTAssertEqual(endpoint?.requiresAuthentication, false)
    }

    // MARK: - Query construction

    func testShouldUseTheCursorParameterNameForHTTPSyncAndNotASequence() {
        // `since` is an opaque cursor; the WebSocket frame's is `sinceSeq`. The names
        // differ so that no one can conflate the two mechanisms, and a client that
        // sent a sequence here would either replay everything or believe it is caught
        // up when it is not.
        let endpoint = SylAPI.sync(since: "eyJhdCI6…", limit: 100)

        XCTAssertEqual(endpoint.path, "/sync")
        XCTAssertEqual(endpoint.query.first?.name, "since")
        XCTAssertFalse(endpoint.query.contains { $0.name == "sinceSeq" })
    }

    func testShouldRepeatTheTypesParameterOncePerResourceType() {
        let endpoint = SylAPI.sync(types: [.reminder, .message])

        XCTAssertEqual(
            endpoint.query.filter { $0.name == "types" }.map(\.value),
            ["reminder", "message"]
        )
    }

    func testShouldFormatADueBeforeFilterAsAContractInstant() {
        let instant = try? Instant.parse("2026-08-09T21:00:00.000Z")

        let endpoint = SylAPI.reminders(dueBefore: instant)

        XCTAssertEqual(
            endpoint.query.first { $0.name == "dueBefore" }?.value,
            "2026-08-09T21:00:00.000Z"
        )
    }

    // MARK: - Idempotency keys themselves

    func testShouldGenerateADistinctIdempotencyKeyEachTime() {
        XCTAssertNotEqual(IdempotencyKey.generate(), IdempotencyKey.generate())
    }

    func testShouldGenerateAKeyLongEnoughForTheContractsMinimum() {
        // The contract requires 8 to 128 characters.
        let key = IdempotencyKey.generate()

        XCTAssertGreaterThanOrEqual(key.count, 8)
        XCTAssertLessThanOrEqual(key.count, 128)
    }

    // MARK: - Helpers

    private func describe<T>(_ endpoint: Endpoint<T>) -> (String, HTTPMethod, String?) {
        (endpoint.path, endpoint.method, endpoint.idempotencyKey)
    }
}
