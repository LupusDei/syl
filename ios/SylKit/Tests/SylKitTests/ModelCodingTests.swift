import XCTest

@testable import SylKit

/// Model behaviour the shared fixtures do not pin, because no fixture exercises it:
/// PATCH bodies, identifier shape, and the helpers the app will lean on.
final class ModelCodingTests: XCTestCase {
    // MARK: - Identifiers

    func testShouldAcceptAWellFormedTypePrefixedIdentifier() {
        XCTAssertTrue(SylIDs.isWellFormed("syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f"))
        XCTAssertTrue(SylIDs.isWellFormed("syl:run_step:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f"))
    }

    func testShouldRejectAnIdentifierThatIsNotTypePrefixed() {
        XCTAssertFalse(SylIDs.isWellFormed("0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f"))
        XCTAssertFalse(SylIDs.isWellFormed("adj:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f"))
        XCTAssertFalse(SylIDs.isWellFormed("syl:Reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f"))
    }

    func testShouldRejectAnIdentifierWithoutAUUID() {
        XCTAssertFalse(SylIDs.isWellFormed("syl:reminder:not-a-uuid"))
        XCTAssertFalse(SylIDs.isWellFormed("syl:reminder:"))
    }

    func testShouldTreatTwoCasesOfTheSameIdentifierAsTheSameResource() {
        // The contract's pattern permits either hex case and the service accepts both,
        // though it only ever mints lower case. Comparing bare strings would produce a
        // duplicated row rather than an error.
        let lower = "syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f"
        let upper = "syl:reminder:0198F2C1-4A3B-7D21-9F00-1A2B3C4D5E6F"

        XCTAssertTrue(SylIDs.areEqual(lower, upper))
        XCTAssertNotEqual(lower, upper, "which is exactly why areEqual exists")
        XCTAssertEqual(SylIDs.canonical(upper), lower)
    }

    func testShouldAcceptEitherHexCaseAsWellFormed() {
        XCTAssertTrue(
            SylIDs.isWellFormed("syl:reminder:0198F2C1-4A3B-7D21-9F00-1A2B3C4D5E6F")
        )
    }

    func testShouldNotTreatDifferentIdentifiersAsEqual() {
        XCTAssertFalse(
            SylIDs.areEqual(
                "syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f",
                "syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e70"
            )
        )
    }

    func testShouldReadTheResourceTypeOutOfAnIdentifier() {
        XCTAssertEqual(
            SylIDs.type(of: "syl:conversation:00000000-0000-7000-8000-000000000001"),
            "conversation"
        )
        XCTAssertNil(SylIDs.type(of: "nonsense"))
    }

    func testShouldPinTheInteractiveConversationToTheWellKnownConstant() {
        // A client and a server that both use a constant cannot disagree about which
        // thread a message belongs to. Adjutant derived it from sender and recipient
        // and paid for the fix twice.
        XCTAssertEqual(
            SylIDs.interactiveConversation,
            "syl:conversation:00000000-0000-7000-8000-000000000001"
        )
    }

    // MARK: - PATCH bodies

    func testShouldOmitAnUnchangedPatchFieldEntirely() throws {
        let body = UpdateTodoRequest(pinned: true)

        let object = try encodeToObject(body)

        XCTAssertEqual(object["pinned"] as? Bool, true)
        XCTAssertFalse(object.keys.contains("dueAt"), "omitted means leave it alone")
        XCTAssertFalse(object.keys.contains("goalId"))
    }

    func testShouldSendAnExplicitNullForAClearedPatchField() throws {
        // Dropping a due date and leaving it alone are different operations, and `T?`
        // cannot express the difference.
        let body = UpdateTodoRequest(dueAt: .clear)

        let object = try encodeToObject(body)

        XCTAssertTrue(object.keys.contains("dueAt"))
        XCTAssertTrue(object["dueAt"] is NSNull)
    }

    func testShouldSendTheValueForASetPatchField() throws {
        let instant = try Instant.parse("2026-08-12T14:00:00.000Z")
        let body = UpdateTodoRequest(dueAt: .set(instant))

        let object = try encodeToObject(body)

        XCTAssertEqual(object["dueAt"] as? String, "2026-08-12T14:00:00.000Z")
    }

    func testShouldRoundTripAPatchThroughDiskSoAQueuedIntentSurvives() throws {
        // The outbox writes intents to disk and replays them. A patch that lost its
        // three-way distinction on the way through would turn a clear into a no-op.
        let original = UpdateReminderRequest(text: "New wording", rrule: .clear)

        let data = try SylJSON.encoder().encode(original)
        let restored = try SylJSON.decoder().decode(UpdateReminderRequest.self, from: data)

        XCTAssertEqual(restored, original)
        XCTAssertEqual(restored.rrule, .clear)
    }

    // MARK: - Snooze

    func testShouldSendExactlyOneOfUntilOrMinutes() throws {
        let byMinutes = try encodeToObject(SnoozeReminderRequest.minutes(15))
        let byInstant = try encodeToObject(
            SnoozeReminderRequest.until(try Instant.parse("2026-08-09T22:00:00.000Z"))
        )

        XCTAssertEqual(byMinutes["minutes"] as? Int, 15)
        XCTAssertTrue(byMinutes["until"] is NSNull)
        XCTAssertEqual(byInstant["until"] as? String, "2026-08-09T22:00:00.000Z")
        XCTAssertTrue(byInstant["minutes"] is NSNull)
    }

    // MARK: - Presence expiry

    func testShouldExpirePresenceAfterItsTTL() throws {
        let received = try Instant.parse("2026-08-09T07:00:03.114Z")
        let presence = WsPresence(state: .thinking, intensity: 0.55, since: received, ttlMs: 15_000)

        XCTAssertEqual(presence.ttl, 15)
        XCTAssertEqual(
            Instant.format(presence.expiry(from: received)),
            "2026-08-09T07:00:18.114Z"
        )
    }

    func testShouldExpireAZeroTTLPresenceImmediately() throws {
        // `absent` carries ttl_ms 0. The failure mode has to be quiet, not stuck.
        let now = try Instant.parse("2026-08-09T04:00:00.000Z")
        let presence = WsPresence(state: .absent, intensity: 0, since: now, ttlMs: 0)

        XCTAssertEqual(presence.expiry(from: now), now)
    }

    // MARK: - Sync change payloads

    func testShouldRedecodeASyncChangeResourceIntoItsNamedModel() throws {
        let json = """
            {"type":"todo","op":"upsert","id":"syl:todo:0198f2c2-0001-7000-8000-00000000c001",
             "at":"2026-08-09T06:59:48.300Z",
             "resource":{"id":"syl:todo:0198f2c2-0001-7000-8000-00000000c001",
             "text":"Call the pharmacy about the refill","goalId":null,
             "dueAt":"2026-08-09T21:00:00.000Z","pinned":false,"status":"open",
             "source":"commander","delegatedJobId":null,
             "createdAt":"2026-08-09T06:59:48.300Z","updatedAt":"2026-08-09T06:59:48.300Z",
             "completedAt":null}}
            """

        let change = try SylJSON.decoder().decode(SyncChange.self, from: Data(json.utf8))
        let todo = try change.decodeResource(as: Todo.self)

        XCTAssertEqual(todo?.text, "Call the pharmacy about the refill")
        XCTAssertEqual(todo?.status, .open)
    }

    func testShouldReturnNoResourceForADeleteChange() throws {
        let json = """
            {"type":"todo","op":"delete","id":"syl:todo:0198f2c2-0002-7000-8000-00000000c002",
             "at":"2026-08-09T06:30:00.000Z","resource":null}
            """

        let change = try SylJSON.decoder().decode(SyncChange.self, from: Data(json.utf8))

        XCTAssertNil(try change.decodeResource(as: Todo.self))
    }

    func testShouldThrowWhenASyncChangeResourceDoesNotMatchTheRequestedModel() throws {
        let json = """
            {"type":"todo","op":"upsert","id":"syl:todo:0198f2c2-0001-7000-8000-00000000c001",
             "at":"2026-08-09T06:59:48.300Z","resource":{"nonsense":true}}
            """
        let change = try SylJSON.decoder().decode(SyncChange.self, from: Data(json.utf8))

        XCTAssertThrowsError(try change.decodeResource(as: Todo.self))
    }

    // MARK: - Frame unions

    func testShouldDecodeAServerFrameByItsTypeDiscriminator() throws {
        let json = """
            {"type":"presence","state":"speaking","intensity":0.4,
             "since":"2026-08-09T07:00:03.114Z","ttl_ms":4000}
            """

        let frame = try SylJSON.decoder().decode(WsServerFrame.self, from: Data(json.utf8))

        guard case .presence(let presence) = frame else {
            return XCTFail("expected a presence frame, got \(frame)")
        }
        XCTAssertEqual(presence.state, .speaking)
    }

    func testShouldReportNoSequenceForAPresenceFrame() throws {
        // Presence carries no seq by design: numbering it would either force a replay
        // the rules forbid or punch a hole in the sequence space, and holes are how
        // gap detection works.
        let json = """
            {"type":"presence","state":"thinking","intensity":0.55,
             "since":"2026-08-09T06:59:48.300Z","ttl_ms":15000}
            """

        let frame = try SylJSON.decoder().decode(WsServerFrame.self, from: Data(json.utf8))

        XCTAssertNil(frame.seq)
    }

    func testShouldRefuseAClientFrameThatOnlyAServerMaySend() throws {
        let json = """
            {"type":"presence","state":"idle","intensity":0,
             "since":"2026-08-09T06:59:48.300Z","ttl_ms":0}
            """

        XCTAssertThrowsError(
            try SylJSON.decoder().decode(WsClientFrame.self, from: Data(json.utf8))
        )
    }

    func testShouldRefuseAFrameWhoseTypeDoesNotMatchTheModel() throws {
        // `chat_message` exists in both directions with different shapes. Without the
        // discriminator check, the wrong one decodes from whatever happens to fit.
        let serverShaped = """
            {"type":"chat_message","seq":4488,"ts":"2026-08-09T07:00:03.140Z",
             "message":{"id":"syl:message:0198f2c0-0002-7000-8000-00000000b002",
             "conversationId":"syl:conversation:00000000-0000-7000-8000-000000000001",
             "clientId":null,"role":"assistant","text":"Done.",
             "createdAt":"2026-08-09T07:00:03.114Z","seq":1284}}
            """

        XCTAssertThrowsError(
            try SylJSON.decoder().decode(WsPong.self, from: Data(serverShaped.utf8))
        )
    }

    // MARK: - Helpers

    private func encodeToObject(_ value: some Encodable) throws -> [String: Any] {
        let data = try SylJSON.encoder().encode(value)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
