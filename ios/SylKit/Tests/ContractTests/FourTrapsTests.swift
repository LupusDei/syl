import XCTest

import SylKit

/// The four places Swift was predicted to get this contract wrong, written down in
/// `shared/contract-tests.md` before any Swift existed.
///
/// They are tests rather than discoveries on purpose: each one is a debugging session
/// somebody has already paid for once, and each fails silently in production if it is
/// only handled by accident.
final class FourTrapsTests: XCTestCase {
    // MARK: - Trap 1 — `ttl_ms` is the only snake_case field on the wire

    func testShouldDecodeTtlMsWithoutAKeyConversionStrategy() throws {
        let data = try fixture("ws/presence_speaking.json")

        let presence = try SylJSON.decoder().decode(WsPresence.self, from: data)

        XCTAssertEqual(presence.ttlMs, 4000)
        XCTAssertEqual(presence.state, .speaking)
        XCTAssertEqual(presence.intensity, 0.4, accuracy: 0.0001)
    }

    func testShouldBreakOnCamelCaseFieldsIfABlanketSnakeCaseStrategyWereUsed() throws {
        // The trap, demonstrated rather than asserted in prose. `.convertFromSnakeCase`
        // would indeed turn `ttl_ms` into `ttlMs` — and it is applied to *every* key,
        // so `messageSeq` becomes `messageSeq` unchanged but `conversationId` and the
        // rest are only safe by luck. The frame that proves it is one that mixes both:
        // presence has `ttl_ms` next to camelCase-free names, so the clean
        // demonstration is a frame with a genuinely camelCase key.
        let data = try fixture("ws/delivery_confirmation.json")

        let lenient = JSONDecoder()
        lenient.keyDecodingStrategy = .convertFromSnakeCase
        lenient.dateDecodingStrategy = .iso8601

        XCTAssertThrowsError(
            try lenient.decode(WsDeliveryConfirmation.self, from: data),
            "a blanket snake_case strategy must not be able to decode this contract"
        )
    }

    func testShouldNotRewriteACamelCaseFieldWhenEncoding() throws {
        let presence = WsPresence(state: .thinking, intensity: 0.55, since: Date(), ttlMs: 15_000)

        let encoded = try SylJSON.encoder().encode(presence)
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )

        XCTAssertNotNil(object["ttl_ms"], "the wire spelling is ttl_ms, in both directions")
        XCTAssertNil(object["ttlMs"], "ttlMs is the Swift name and must never reach the wire")
    }

    // MARK: - Trap 2 — `.iso8601` cannot parse the fractional seconds every instant carries

    func testShouldFailWithFoundationsISO8601StrategyOnAContractInstant() throws {
        let data = try fixture("http/reminder.commitment.json")

        let builtIn = JSONDecoder()
        builtIn.dateDecodingStrategy = .iso8601

        XCTAssertThrowsError(
            try builtIn.decode(Envelope<Reminder>.self, from: data),
            """
            .iso8601 does not parse fractional seconds. If this ever stops throwing, \
            Foundation changed and the custom strategy can be revisited — until then \
            it is the reason every timestamp decodes at all.
            """
        )
    }

    func testShouldRoundTripAnInstantToTheSameStringItCameFrom() throws {
        let original = "2026-08-09T07:00:03.114Z"

        let date = try Instant.parse(original)

        XCTAssertEqual(Instant.format(date), original)
    }

    func testShouldRejectAnInstantCarryingAFixedUTCOffset() {
        // An offset is a property of an instant, not of a place. One that reaches a
        // model survives exactly one DST boundary and then moves every recurring
        // reminder by an hour.
        XCTAssertThrowsError(try Instant.parse("2026-08-09T02:00:03.114-05:00")) { error in
            XCTAssertEqual(
                error as? Instant.Failure,
                .notUTC("2026-08-09T02:00:03.114-05:00")
            )
        }
    }

    /// A fifth trap, found by this suite on its first run rather than predicted.
    ///
    /// `ISO8601FormatStyle(includingFractionalSeconds: true)` truncates instead of
    /// rounding, so every instant in the contract came back one millisecond short.
    /// It is listed here with the other four because it has the same character: it
    /// compiles, it looks right, and it is only visible when the same bytes have to
    /// survive a round trip.
    func testShouldNotLoseAMillisecondToFoundationsTruncatingFormatter() throws {
        let awkward = ["2026-08-09T07:00:03.114Z", "2026-08-09T07:00:03.140Z",
                       "2026-08-09T06:59:48.260Z", "2026-08-08T20:11:52.400Z"]

        for original in awkward {
            XCTAssertEqual(
                Instant.format(try Instant.parse(original)),
                original,
                "the built-in formatter truncates this to one millisecond earlier"
            )
        }
    }

    func testShouldAcceptAWholeSecondInstantButAlwaysEmitMilliseconds() throws {
        let date = try Instant.parse("2026-08-09T07:00:03Z")

        XCTAssertEqual(Instant.format(date), "2026-08-09T07:00:03.000Z")
    }

    // MARK: - Trap 3 — required-and-nullable is not the same as optional

    func testShouldWriteAnExplicitNullForARequiredNullableFieldThatIsNil() throws {
        let data = try fixture("http/reminder.rhythm.json")
        let reminder = try SylJSON.decoder().decode(Envelope<Reminder>.self, from: data).data
        XCTAssertNil(reminder.todoId)

        let encoded = try SylJSON.encoder().encode(reminder)
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )

        XCTAssertTrue(
            object.keys.contains("todoId"),
            """
            the synthesised encoder uses encodeIfPresent for T? and drops the key. \
            Decoding never notices; the difference only shows up on the way out.
            """
        )
        XCTAssertTrue(object["todoId"] is NSNull)
    }

    func testShouldRefuseAResponseThatOmitsARequiredNullableFieldEntirely() throws {
        let complete = try fixture("http/reminder.commitment.json")
        let stripped = try removingKey("todoId", fromDataAt: complete)

        XCTAssertThrowsError(
            try SylJSON.decoder().decode(Envelope<Reminder>.self, from: stripped)
        ) { error in
            guard case DecodingError.keyNotFound = error else {
                return XCTFail("expected keyNotFound, got \(error)")
            }
        }
    }

    func testShouldStillAcceptAnExplicitNullForARequiredNullableField() throws {
        let data = try fixture("http/reminder.commitment.json")

        let reminder = try SylJSON.decoder().decode(Envelope<Reminder>.self, from: data).data

        XCTAssertNil(reminder.eventId, "null is a legitimate value; absence is not")
    }

    // MARK: - Trap 4 — the two sequence spaces compile fine when confused

    func testShouldKeepTheFrameSequenceAndTheMessageSequenceApart() throws {
        let data = try fixture("ws/delivery_confirmation.json")

        let frame = try SylJSON.decoder().decode(WsDeliveryConfirmation.self, from: data)

        XCTAssertEqual(frame.seq, 4487, "seq is this frame's position in the frame stream")
        XCTAssertEqual(frame.messageSeq, 1283, "messageSeq is the message's position in its thread")
        XCTAssertNotEqual(
            frame.seq,
            frame.messageSeq,
            "modelling one and reusing it for the other compiles fine and desynchronises the socket"
        )
    }

    func testShouldMapTheFrameOntoTheHTTPConfirmationUsingTheMessageSequence() throws {
        let frame = try SylJSON.decoder().decode(
            WsDeliveryConfirmation.self,
            from: try fixture("ws/delivery_confirmation.json")
        )
        let overHTTP = try SylJSON.decoder().decode(
            Envelope<DeliveryConfirmation>.self,
            from: try fixture("http/message.sent.json")
        ).data

        // The HTTP body's bare `seq` is the MESSAGE sequence — the one place the bare
        // name means that space, because an HTTP response has no frame stream to have
        // a position in. Both paths must reconcile to the same row.
        XCTAssertEqual(frame.asDeliveryConfirmation, overHTTP)
    }

    func testShouldReadTheFrameSequenceFromAServerChatMessageAndTheThreadSequenceFromItsMessage()
        throws
    {
        let frame = try SylJSON.decoder().decode(
            WsServerChatMessage.self,
            from: try fixture("ws/server_chat_message.json")
        )

        XCTAssertEqual(frame.seq, 4488)
        XCTAssertEqual(frame.message.seq, 1284)
    }

    // MARK: - The one open enum

    func testShouldDecodeAnUnrecognisedPresenceStateAsIdleRatherThanThrowing() throws {
        // The enum is open on purpose so the service can add a state without shipping
        // an app update. A client that rejects the frame instead is a client that
        // breaks on a server deploy.
        let json = """
            {"type":"presence","state":"brooding","intensity":0.5,\
            "since":"2026-08-09T07:00:03.114Z","ttl_ms":4000}
            """

        let presence = try SylJSON.decoder().decode(WsPresence.self, from: Data(json.utf8))

        XCTAssertEqual(presence.state, .idle)
    }

    func testShouldClampAnOutOfRangeIntensityWithoutRejectingTheFrame() throws {
        let json = """
            {"type":"presence","state":"alert","intensity":1.4,\
            "since":"2026-08-09T07:00:03.114Z","ttl_ms":8000}
            """

        let presence = try SylJSON.decoder().decode(WsPresence.self, from: Data(json.utf8))

        XCTAssertEqual(presence.intensity, 1.4, accuracy: 0.0001, "the raw value is preserved")
        XCTAssertEqual(presence.clampedIntensity, 1.0, "a server sending 1.4 is wrong, not fatal")
    }

    func testShouldRefuseAReplayBufferThatContainsAPresenceFrame() throws {
        // `frames` never contains a presence frame. A client that accepted one would
        // be rendering a state from four minutes ago as though it were now.
        let json = """
            {"type":"sync_response","fromSeq":1,"toSeq":2,"complete":true,"frames":[\
            {"type":"presence","state":"thinking","intensity":0.5,\
            "since":"2026-08-09T07:00:03.114Z","ttl_ms":4000}]}
            """

        XCTAssertThrowsError(
            try SylJSON.decoder().decode(WsSyncResponse.self, from: Data(json.utf8))
        )
    }

    // MARK: - Helpers

    private func fixture(_ relativePath: String) throws -> Data {
        try Data(contentsOf: FixtureLoader.fixturesDirectory().appendingPathComponent(relativePath))
    }

    /// Removes a key from the `data` member of a success envelope, so a test can prove
    /// the decoder notices an omission the fixtures never contain.
    private func removingKey(_ key: String, fromDataAt data: Data) throws -> Data {
        var root = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        var payload = try XCTUnwrap(root["data"] as? [String: Any])
        payload.removeValue(forKey: key)
        root["data"] = payload
        return try JSONSerialization.data(withJSONObject: root)
    }
}
