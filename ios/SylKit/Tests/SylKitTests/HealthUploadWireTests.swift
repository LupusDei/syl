import XCTest

@testable import SylKit

/// The wire half of `syl-t9tj`: that a health upload leaves this client in the shape
/// `backend/src/health/contract.ts` pins, and that the authorisation report survives the
/// trip as an object rather than as the array Swift would otherwise write.
final class HealthUploadWireTests: XCTestCase {
    // MARK: - The trap that would have shipped

    func testShouldEncodeTheAuthorisationReportAsAnObjectAndNotAsAFlatArray() throws {
        // `JSONEncoder` writes a dictionary keyed by a non-String type as an ARRAY of
        // alternating keys and values. It round-trips through Swift perfectly and is
        // unreadable to the server — the same family as the four traps in FourTrapsTests.
        // `CodingKeyRepresentable` on HealthType is the whole fix and this is its guard.
        let upload = HealthUpload(
            authorisation: report(steps: .denied, otherwise: .authorised),
            samples: []
        )

        let json = try object(from: upload)
        let authorisation = try XCTUnwrap(json["authorisation"] as? [String: Any])

        XCTAssertEqual(authorisation["steps"] as? String, "denied")
        XCTAssertEqual(authorisation["sleep"] as? String, "authorised")
        XCTAssertEqual(authorisation.count, HealthType.allCases.count)
    }

    func testShouldEncodeTheWatermarkMapAsAnObjectToo() throws {
        let result = HealthUploadResult(
            written: 3,
            duplicates: 1,
            watermarks: [.steps: Date(timeIntervalSince1970: 1_786_000_000)]
        )

        let json = try object(from: result)
        let watermarks = try XCTUnwrap(json["watermarks"] as? [String: Any])

        XCTAssertEqual(watermarks["steps"] as? String, "2026-08-06T07:06:40.000Z")
    }

    // MARK: - The contract's field names, exactly

    func testShouldNameEverySampleFieldTheWayTheContractDoes() throws {
        let sample = HealthSampleInput(
            type: .heartRateVariability,
            startedAt: Date(timeIntervalSince1970: 1_786_000_000),
            endedAt: Date(timeIntervalSince1970: 1_786_000_060),
            value: 42.5,
            source: "Justin's Apple Watch"
        )

        let json = try object(from: HealthUpload(authorisation: report(), samples: [sample]))
        let encoded = try XCTUnwrap((json["samples"] as? [[String: Any]])?.first)

        XCTAssertEqual(Set(encoded.keys), ["type", "startedAt", "endedAt", "value", "source"])
        XCTAssertEqual(encoded["type"] as? String, "heartRateVariability")
        XCTAssertEqual(encoded["startedAt"] as? String, "2026-08-06T07:06:40.000Z")
        XCTAssertEqual(encoded["endedAt"] as? String, "2026-08-06T07:07:40.000Z")
        XCTAssertEqual(encoded["value"] as? Double, 42.5)
        XCTAssertEqual(encoded["source"] as? String, "Justin's Apple Watch")
    }

    func testShouldRoundTripAnUploadResultTheServiceWouldSend() throws {
        let wire = """
            {
              "written": 12,
              "duplicates": 4,
              "watermarks": { "steps": "2026-08-06T07:06:40.000Z" }
            }
            """
        let decoded = try SylJSON.decoder().decode(
            HealthUploadResult.self,
            from: Data(wire.utf8)
        )

        XCTAssertEqual(decoded.written, 12)
        XCTAssertEqual(decoded.duplicates, 4)
        XCTAssertEqual(decoded.watermarks[.steps], Date(timeIntervalSince1970: 1_786_000_000))
        XCTAssertNil(decoded.watermarks[.sleep], "partial, so an absent type stays absent")
    }

    // MARK: - The seven types

    func testShouldCarryExactlyTheSevenTypesTheContractPins() {
        XCTAssertEqual(
            HealthType.allCases.map(\.rawValue),
            [
                "heartRate", "restingHeartRate", "heartRateVariability",
                "sleep", "steps", "workout", "bodyMass",
            ]
        )
    }

    func testShouldFixOneUnitPerTypeMatchingTheContractsUnitTable() {
        XCTAssertEqual(HealthType.heartRate.unit, "count/min")
        XCTAssertEqual(HealthType.restingHeartRate.unit, "count/min")
        XCTAssertEqual(HealthType.heartRateVariability.unit, "ms")
        XCTAssertEqual(HealthType.sleep.unit, "min")
        XCTAssertEqual(HealthType.steps.unit, "count")
        XCTAssertEqual(HealthType.workout.unit, "min")
        XCTAssertEqual(HealthType.bodyMass.unit, "lb")
    }

    func testShouldSpellTheThreeAuthorisationStatesTheContractsWay() {
        XCTAssertEqual(
            HealthAuthorisationState.allCases.map(\.rawValue),
            ["authorised", "denied", "notDetermined"]
        )
    }

    // MARK: - Completeness is the client's business too

    func testShouldNameTheMissingTypesWhenAReportIsIncomplete() {
        var partial = report()
        partial[.workout] = nil
        partial[.bodyMass] = nil

        let upload = HealthUpload(authorisation: partial, samples: [])

        XCTAssertFalse(upload.isComplete)
        XCTAssertEqual(Set(upload.unreportedTypes), [.workout, .bodyMass])
    }

    func testShouldTreatAFullReportAsComplete() {
        XCTAssertTrue(HealthUpload(authorisation: report(), samples: []).isComplete)
    }

    // MARK: - The one function the whole feature turns on

    func testShouldTreatSilenceAsEvidenceOnlyForAnAuthorisedType() {
        // "He walked nowhere" is a conclusion; "we were never allowed to look" is not.
        XCTAssertTrue(HealthUpload.silenceIsEvidence(.authorised))
        XCTAssertFalse(HealthUpload.silenceIsEvidence(.denied))
        XCTAssertFalse(HealthUpload.silenceIsEvidence(.notDetermined))
    }

    // MARK: - The endpoint

    func testShouldPostToHealthSamplesWithAnIdempotencyKey() throws {
        let endpoint = try SylAPI.uploadHealthSamples(
            HealthUpload(authorisation: report(), samples: []),
            idempotencyKey: "key-1"
        )

        XCTAssertEqual(endpoint.method, .post)
        XCTAssertEqual(endpoint.path, "/health/samples")
        XCTAssertEqual(endpoint.idempotencyKey, "key-1")
        XCTAssertTrue(endpoint.requiresAuthentication)
        XCTAssertNotNil(endpoint.body)
    }

    func testShouldSendAnEmptyBatchRatherThanSkipIt() throws {
        // An empty batch is how a denied type reaches the server at all. A client that
        // optimised it away would leave the server unable to attribute the silence, which
        // is the entire defect this feature exists to close.
        let endpoint = try SylAPI.uploadHealthSamples(
            HealthUpload(authorisation: report(steps: .denied, otherwise: .authorised), samples: []),
            idempotencyKey: "key-2"
        )

        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: XCTUnwrap(endpoint.body)) as? [String: Any]
        )
        XCTAssertEqual((json["samples"] as? [Any])?.count, 0)
        XCTAssertEqual((json["authorisation"] as? [String: Any])?["steps"] as? String, "denied")
    }

    // MARK: - Helpers

    private func report(
        steps: HealthAuthorisationState? = nil,
        otherwise fallback: HealthAuthorisationState = .authorised
    ) -> [HealthType: HealthAuthorisationState] {
        var report: [HealthType: HealthAuthorisationState] = [:]
        for type in HealthType.allCases {
            report[type] = type == .steps ? (steps ?? fallback) : fallback
        }
        return report
    }

    private func object(from value: some Encodable) throws -> [String: Any] {
        let data = try SylJSON.encoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
