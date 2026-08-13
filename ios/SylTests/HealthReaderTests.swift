import HealthKit
import SylKit
import XCTest

@testable import Syl

/// `syl-t9tj.1.2`. The distinction the whole health feature rests on, tested at the two
/// places it can actually be got wrong: the pure judgement about one type's permission,
/// and the narrowing of four honest states onto the contract's three.
///
/// None of this needs a device, a grant, or a body. `HealthReader.authorisation` takes the
/// two facts the platform will give up and returns what may be claimed from them; the
/// HealthKit calls that produce those facts are the part no test can reach, which is
/// exactly why the judgement is not left inside them.
final class HealthReaderTests: XCTestCase {
    // MARK: - Empty is not denied. The one guarantee.

    func testShouldTellADeniedTypeApartFromAnAuthorisedTypeWithNothingInIt() {
        // He has denied steps. iOS has been asked and will not say what he answered, and
        // the query comes back empty — the same zero samples an authorised type produces
        // on a quiet day.
        let denied = HealthReader.authorisation(
            sawSamples: false,
            provenReadableBefore: false,
            requestStatus: .unnecessary
        )

        // He has granted workouts and simply did none this week. The proof that we may
        // look is already held, so the emptiness is his and not ours.
        let quiet = HealthReader.authorisation(
            sawSamples: false,
            provenReadableBefore: true,
            requestStatus: .unnecessary
        )

        XCTAssertNotEqual(denied, quiet, "the two situations HealthKit refuses to separate")
        XCTAssertEqual(denied.wireState, .denied)
        XCTAssertEqual(quiet.wireState, .authorised)
        XCTAssertFalse(
            HealthUpload.silenceIsEvidence(denied.wireState),
            "so the server never reads 'we were not allowed to look' as 'nothing happened'"
        )
        XCTAssertTrue(HealthUpload.silenceIsEvidence(quiet.wireState))
    }

    func testShouldTellAPromptHeHasNotSeenApartFromAnAnswerHeGave() {
        let neverAsked = HealthReader.authorisation(
            sawSamples: false,
            provenReadableBefore: false,
            requestStatus: .shouldRequest
        )
        let asked = HealthReader.authorisation(
            sawSamples: false,
            provenReadableBefore: false,
            requestStatus: .unnecessary
        )

        XCTAssertEqual(neverAsked.wireState, .notDetermined, "so he can still be asked")
        XCTAssertEqual(asked.wireState, .denied, "so he is not re-asked for something he declined")
        XCTAssertNotEqual(neverAsked, asked)
    }

    // MARK: - A sample in hand outranks everything

    func testShouldTreatASampleAsProofRegardlessOfWhatTheRequestStatusSays() {
        // A later build that adds a type to the request set makes the status
        // `.shouldRequest` for a type this app has been reading happily for months. The
        // sample is the fact; the status is a question about a prompt.
        XCTAssertEqual(
            HealthReader.authorisation(
                sawSamples: true,
                provenReadableBefore: false,
                requestStatus: .shouldRequest
            ),
            .readable
        )
    }

    func testShouldNotClaimAnythingItCannotProveWhenHealthKitWillNotAnswer() {
        // `.unknown` is HealthKit failing, not the Commander declining. It lands with
        // everything else we cannot prove, because guessing the other way produces a
        // conclusion about a body nobody looked at.
        XCTAssertEqual(
            HealthReader.authorisation(
                sawSamples: false,
                provenReadableBefore: false,
                requestStatus: .unknown
            ),
            .undisclosed
        )
    }

    // MARK: - The narrowing onto the contract

    func testShouldNarrowTheFourHonestStatesOntoTheContractsThreeFailingSafe() {
        XCTAssertEqual(HealthReadAuthorisation.notDetermined.wireState, .notDetermined)
        XCTAssertEqual(HealthReadAuthorisation.readable.wireState, .authorised)
        XCTAssertEqual(HealthReadAuthorisation.undisclosed.wireState, .denied)
        XCTAssertEqual(HealthReadAuthorisation.unavailable.wireState, .denied)
    }

    func testShouldNeverLetAnUnprovenStateBecomeEvidence() {
        // The property that matters more than any individual mapping: `authorised` is
        // reachable from `readable` and from nothing else, so silence can only ever be
        // read as evidence when a sample proved we were allowed to look.
        for state in HealthReadAuthorisation.allCases where state != .readable {
            XCTAssertFalse(
                HealthUpload.silenceIsEvidence(state.wireState),
                "\(state) is not proof that we were allowed to look"
            )
        }
    }

    // MARK: - The report is complete or it is nothing

    func testShouldReportEverySevenTypesEvenWhenTheReadSaidNothingAboutThem() {
        // The server refuses an upload that omits a type, and it is right to: the default
        // would have to be a guess about permission. A page that somehow lost a type
        // reports the conservative state rather than dropping the key.
        let page = HealthReadPage(authorisation: [.steps: .readable], samples: [])

        let report = page.wireAuthorisation

        XCTAssertEqual(report.count, HealthType.allCases.count)
        XCTAssertEqual(report[.steps], .authorised)
        XCTAssertEqual(report[.sleep], .denied, "absent means unproven, never assumed fine")
        XCTAssertTrue(HealthUpload(authorisation: report, samples: []).isComplete)
    }

    // MARK: - Units, which are fixed per type and must not drift

    func testShouldConvertEveryTypeThroughTheUnitTheContractPins() {
        // The wire's unit table and the HKUnit that feeds it, compared directly. A drift
        // here is a number that means something else with nothing to say so — a resting
        // heart rate in beats per second is 0.9, which is not obviously wrong downstream.
        for type in HealthType.allCases {
            XCTAssertEqual(
                type.healthKitUnit.unitString,
                type.unit,
                "\(type.rawValue) converts through a unit the contract does not name"
            )
        }
    }

    func testShouldResolveEverySevenTypesToAHealthKitObject() {
        for type in HealthType.allCases {
            XCTAssertNotNil(
                type.healthKitObjectType,
                "\(type.rawValue) has no HealthKit type, so it would read as empty forever"
            )
        }
    }

    // MARK: - Where a read starts

    func testShouldReachBackSixtyDaysWhenThereIsNoWatermark() {
        // The cold start, and it is the ordinary path taken more times rather than a
        // branch of its own — a special path is where the untested branch lives.
        let now = Date(timeIntervalSince1970: 1_786_000_000)

        let start = HealthReader.readStart(watermark: nil, readAt: now)

        XCTAssertEqual(start, now.addingTimeInterval(-60 * 24 * 60 * 60))
    }

    func testShouldResumeBehindItsWatermarkSoLateArrivingSamplesAreNotSkipped() {
        // HealthKit data arrives out of order: a watch that syncs at noon inserts samples
        // stamped 03:00, behind a watermark that has already moved past them. Re-reading
        // the overlap costs nothing — the server deduplicates by sample identity.
        let now = Date(timeIntervalSince1970: 1_786_000_000)
        let watermark = now.addingTimeInterval(-3_600)

        let start = HealthReader.readStart(watermark: watermark, readAt: now)

        XCTAssertLessThan(start, watermark)
        XCTAssertEqual(start, watermark.addingTimeInterval(-HealthReader.backfillOverlap))
    }

    func testShouldNeverReachFurtherBackThanTheRetentionWindow() {
        // A watermark older than retention would upload history the server discards on
        // arrival, which is a long cold start that achieves nothing.
        let now = Date(timeIntervalSince1970: 1_786_000_000)
        let ancient = now.addingTimeInterval(-400 * 24 * 60 * 60)

        let start = HealthReader.readStart(watermark: ancient, readAt: now)

        XCTAssertEqual(start, now.addingTimeInterval(-HealthReader.coldStartWindow))
    }

    // MARK: - The proof ledger

    func testShouldRememberAProofAcrossLaunches() {
        let defaults = isolatedDefaults()
        let proven = Date(timeIntervalSince1970: 1_786_000_000)

        UserDefaultsHealthProofLedger(defaults: defaults)
            .recordProvenReadable(.bodyMass, at: proven)

        // A second instance is what the next launch sees.
        let reloaded = UserDefaultsHealthProofLedger(defaults: defaults)
        XCTAssertEqual(reloaded.provenReadableAt(.bodyMass), proven)
        XCTAssertNil(
            reloaded.provenReadableAt(.workout),
            "and proving one type proves nothing about another"
        )
    }

    private func isolatedDefaults() -> UserDefaults {
        let suite = "HealthReaderTests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        // Only the suite NAME crosses into the teardown block: `UserDefaults` is not
        // `Sendable`, and removing a persistent domain works from any instance.
        addTeardownBlock { UserDefaults.standard.removePersistentDomain(forName: suite) }
        return defaults
    }
}
