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

    /// **A resource type this enum does not know takes the whole page down with it.**
    ///
    /// `SyncChange.type` is a non-optional enum, so one unknown value fails the decode
    /// of the array, which fails the decode of `SyncResponse`, which fails the sync —
    /// not the one change, all of it, on every pass, for as long as the row exists. The
    /// contract added `sending` to `SyncResourceType` when the sendings backend landed,
    /// and until this test the phone would simply have stopped synchronising the first
    /// time she sent him something.
    func testShouldDecodeEveryResourceTypeTheContractCanPutOnTheSyncFeed() throws {
        // Straight from `SyncResourceType` in `shared/openapi.yaml`, PLUS the two the
        // contract has since dropped and a string no contract ever had.
        //
        // `job` and `run` left the contract in `syl-020` and belong in this list more
        // than ever: the app and the server ship separately, so a phone carrying this
        // build still receives rows the service wrote before its migration ran. If an
        // unknown type could fail the page, updating first would kill sync outright.
        // `flibbertigibbet` stands for every type not invented yet.
        let contractTypes = [
            "conversation", "message", "reminder", "todo", "goal",
            "device", "delivery", "sending",
            "job", "run", "flibbertigibbet",
        ]

        for type in contractTypes {
            let json = """
                {"type":"\(type)","op":"delete","id":"syl:\(type):0198f2c2-0002-7000-8000-00000000c002",
                 "at":"2026-08-09T06:30:00.000Z","resource":null}
                """
            XCTAssertNoThrow(
                try SylJSON.decoder().decode(SyncChange.self, from: Data(json.utf8)),
                "a \(type) change on the feed must not fail the whole page")
        }
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

    // MARK: - Attachments

    /// `[]` and absent are different, and only absent is legal.
    ///
    /// The contract admits `attachmentIds` as optional but forbids it present-and-empty:
    /// an empty array is a client that meant to omit the field and is worth saying so
    /// about. That is exactly the kind of mistake that round-trips perfectly on the
    /// device and comes back `VALIDATION_FAILED` from the server, on the one write path
    /// that retries by design — so the normalisation lives in the initialiser rather
    /// than in whichever call site remembers.
    func testShouldOmitAttachmentIdsRatherThanSendAnEmptyArray() throws {
        let request = SendMessageRequest(
            clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
            text: "Nothing attached.",
            conversationId: SylIDs.interactiveConversation,
            attachmentIds: []
        )

        XCTAssertNil(request.attachmentIds, "an empty array normalises to absent")
        XCTAssertNil(
            try encodeToObject(request)["attachmentIds"],
            "and the key does not appear on the wire at all"
        )
    }

    func testShouldCarryAttachmentIdsWhenThereActuallyAreSome() throws {
        let ids: [SylID] = ["syl:attachment:019feb2f-e654-7000-ac0e-3f825d6a318c"]
        let request = SendMessageRequest(
            clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
            text: "Here is the shelf, after.",
            conversationId: SylIDs.interactiveConversation,
            attachmentIds: ids
        )

        XCTAssertEqual(try encodeToObject(request)["attachmentIds"] as? [String], ids)
    }

    /// `durationMs` is null on an image and the key is still written.
    ///
    /// Nullable-and-present rather than optional, for the same reason as everything else
    /// in this contract: "this image has no duration" and "this server does not report
    /// durations" look identical when a field is merely absent.
    func testShouldWriteANullDurationForAnImageRatherThanDropTheKey() throws {
        let object = try encodeToObject(
            Attachment(
                id: "syl:attachment:019feb2f-e654-7000-ac0e-3f825d6a318c",
                kind: .image,
                mimeType: "image/png",
                bytes: 144_559,
                width: 1600,
                height: 1200,
                durationMs: nil,
                sha256: String(repeating: "a", count: 64),
                createdAt: try Instant.parse("2026-08-10T10:20:12.757Z"),
                hasThumbnail: true
            )
        )

        XCTAssertTrue(object.keys.contains("durationMs"))
        XCTAssertTrue(object["durationMs"] is NSNull)
    }

    /// The layout hint that stops a bubble jumping when its bytes arrive, kept inside
    /// the range a bubble can actually reserve.
    func testShouldClampAnAbsurdAspectRatioRatherThanHandTheLayoutANaN() {
        XCTAssertEqual(attachment(width: 1600, height: 1200).aspectRatio, 4.0 / 3.0, accuracy: 0.0001)
        XCTAssertEqual(attachment(width: 10_000, height: 100).aspectRatio, 5)
        XCTAssertEqual(attachment(width: 100, height: 10_000).aspectRatio, 0.2)
    }

    private func attachment(width: Int, height: Int) -> Attachment {
        Attachment(
            id: "syl:attachment:019feb2f-e654-7000-ac0e-3f825d6a318c",
            kind: .image,
            mimeType: "image/png",
            bytes: 1,
            width: width,
            height: height,
            durationMs: nil,
            sha256: String(repeating: "a", count: 64),
            createdAt: Date(timeIntervalSince1970: 0),
            hasThumbnail: false
        )
    }

    // MARK: - Sendings

    /// A sending whose video never arrived is a complete sending, and the model has to
    /// be able to hold one. `video` and `reason` are nullable-and-present rather than
    /// optional, so a decoder that treats a missing key as null would hide a server that
    /// had stopped sending the field at all.
    func testShouldDecodeASendingWhoseRenderFailedWithNoVideoAndAReason() throws {
        let json = """
        {
          "id": "syl:sending:019feb2f-e654-7000-ac0e-3f825d6a3180",
          "words": "I found a version of me I actually like today.",
          "because": "He said he wanted to see what I look like.",
          "messageId": "syl:message:019feb2f-e654-7000-ac0e-3f825d6a3181",
          "state": "failed",
          "renderName": "syl-2026-08-11-a",
          "video": null,
          "reason": "The render finished but the file was empty.",
          "createdAt": "2026-08-11T04:20:00.000Z",
          "updatedAt": "2026-08-11T04:21:00.000Z"
        }
        """

        let sending = try SylJSON.decoder().decode(Sending.self, from: Data(json.utf8))

        XCTAssertEqual(sending.state, .failed)
        XCTAssertNil(sending.video)
        XCTAssertEqual(sending.reason, "The render finished but the file was empty.")
        XCTAssertFalse(sending.words.isEmpty, "the words are never contingent on the video")
    }

    /// The one place in the contract a video carries a thumbnail. The poster is what
    /// makes the From Syl list show her face rather than a play triangle, and a client
    /// that reads `hasThumbnail` as false for every video pulls the whole clip instead.
    func testShouldDecodeAReadySendingWhoseVideoCarriesAPoster() throws {
        let json = """
        {
          "id": "syl:sending:019feb2f-e654-7000-ac0e-3f825d6a3182",
          "words": "Good morning.",
          "because": "It is his first morning back.",
          "messageId": "syl:message:019feb2f-e654-7000-ac0e-3f825d6a3183",
          "state": "ready",
          "renderName": "syl-2026-08-11-b",
          "video": {
            "id": "syl:attachment:019feb2f-e654-7000-ac0e-3f825d6a3184",
            "kind": "video",
            "mimeType": "video/mp4",
            "bytes": 1743210,
            "width": 720,
            "height": 1280,
            "durationMs": 9000,
            "sha256": "\(String(repeating: "b", count: 64))",
            "createdAt": "2026-08-11T04:22:00.000Z",
            "hasThumbnail": true
          },
          "reason": null,
          "createdAt": "2026-08-11T04:20:00.000Z",
          "updatedAt": "2026-08-11T04:22:00.000Z"
        }
        """

        let sending = try SylJSON.decoder().decode(Sending.self, from: Data(json.utf8))

        XCTAssertEqual(sending.state, .ready)
        XCTAssertEqual(sending.video?.kind, .video)
        XCTAssertEqual(sending.video?.hasThumbnail, true)
        XCTAssertNil(sending.reason)
    }

    /// Null rather than absent, in the write direction too. A `Sending` re-encoded with
    /// its nulls dropped is a body the contract does not describe, and the round trip in
    /// `ContractTests` is what would otherwise catch it one layer later.
    func testShouldEncodeASendingsAbsentVideoAsAnExplicitNull() throws {
        let json = """
        {
          "id": "syl:sending:019feb2f-e654-7000-ac0e-3f825d6a3185",
          "words": "Still working on this one.",
          "because": "He asked what I was up to.",
          "messageId": "syl:message:019feb2f-e654-7000-ac0e-3f825d6a3186",
          "state": "pending",
          "renderName": null,
          "video": null,
          "reason": null,
          "createdAt": "2026-08-11T04:20:00.000Z",
          "updatedAt": "2026-08-11T04:20:00.000Z"
        }
        """
        let sending = try SylJSON.decoder().decode(Sending.self, from: Data(json.utf8))

        let object = try encodeToObject(sending)

        XCTAssertTrue(object["video"] is NSNull)
        XCTAssertTrue(object["reason"] is NSNull)
        XCTAssertTrue(object["renderName"] is NSNull)
    }

    // MARK: - Helpers

    private func encodeToObject(_ value: some Encodable) throws -> [String: Any] {
        let data = try SylJSON.encoder().encode(value)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
