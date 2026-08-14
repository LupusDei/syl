import HealthKit
import SylKit
import XCTest

@testable import Syl

/// `syl-t9tj.1.2`. The distinction the whole health feature rests on, tested at the two
/// places it can actually be got wrong: the pure judgement about one type's permission,
/// and the translation of the four states the phone can prove onto the contract's five.
///
/// None of this needs a device, a grant, or a body. `HealthReader.authorisation` takes the
/// two facts the platform will give up and returns what may be claimed from them; the
/// HealthKit calls that produce those facts are the part no test can reach, which is
/// exactly why the judgement is not left inside them.
final class HealthReaderTests: XCTestCase {
    // MARK: - Empty is not denied. The one guarantee.

    func testShouldTellAnUnprovenTypeApartFromAnAuthorisedTypeWithNothingInIt() {
        // Steps: iOS has been asked and will not say what he answered, and the query comes
        // back empty — the same zero samples an authorised type produces on a quiet day.
        let unproven = HealthReader.authorisation(
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

        XCTAssertNotEqual(unproven, quiet, "the two situations HealthKit refuses to separate")
        XCTAssertEqual(unproven.wireState, .undisclosed)
        XCTAssertEqual(quiet.wireState, .authorised)
        XCTAssertFalse(
            HealthUpload.silenceIsEvidence(unproven.wireState),
            "so the server never reads 'we were not allowed to look' as 'nothing happened'"
        )
        XCTAssertTrue(HealthUpload.silenceIsEvidence(quiet.wireState))
    }

    func testShouldNotReportDeniedForATypeItOnlyFailedToProve() {
        // The 0.9.12 regression, pinned. Build 0.9.12 uploaded 61,030 real samples and
        // reported `denied` for restingHeartRate, heartRateVariability and bodyMass —
        // exactly the three types with no data in them — because the contract had three
        // states and `undisclosed` had nowhere to go. `denied` is a claim about an answer
        // the Commander gave, and this app cannot prove he gave one.
        XCTAssertFalse(
            HealthReadAuthorisation.allCases.contains { $0.wireState == .denied },
            "no state the phone can prove is 'he said no'"
        )
    }

    func testShouldTellAPromptHeHasNotSeenApartFromAnAnswerItCannotRead() {
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
        XCTAssertEqual(
            asked.wireState,
            .undisclosed,
            "asked, and the platform will not say — not 'he declined'"
        )
        XCTAssertNotEqual(neverAsked, asked)
    }

    func testShouldTellAnUndisclosedTypeApartFromAnUnavailableOne() {
        // Three distinct facts, three distinct words, none of them `denied`: a type nobody
        // could confirm, a device with no HealthKit at all, and a type proven readable and
        // quiet. The admin can act on each differently; it could act on none of them when
        // all three arrived as `denied`.
        XCTAssertEqual(HealthReadAuthorisation.undisclosed.wireState, .undisclosed)
        XCTAssertEqual(HealthReadAuthorisation.unavailable.wireState, .unavailable)
        XCTAssertNotEqual(
            HealthReadAuthorisation.undisclosed.wireState,
            HealthReadAuthorisation.unavailable.wireState
        )
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

    // MARK: - The translation onto the contract

    func testShouldGiveEveryProvableStateItsOwnNameOnTheWire() {
        // A translation, not a narrowing — the contract gained `undisclosed` and
        // `unavailable`, so nothing is collapsed on the way out any more.
        XCTAssertEqual(HealthReadAuthorisation.notDetermined.wireState, .notDetermined)
        XCTAssertEqual(HealthReadAuthorisation.readable.wireState, .authorised)
        XCTAssertEqual(HealthReadAuthorisation.undisclosed.wireState, .undisclosed)
        XCTAssertEqual(HealthReadAuthorisation.unavailable.wireState, .unavailable)
    }

    func testShouldMapEveryProvableStateToADistinctWireState() {
        // The property behind the four assertions above: the mapping is injective, so no
        // future case can be folded onto an existing word without this failing. Folding is
        // exactly how `undisclosed` became `denied` on a real phone.
        let wire = HealthReadAuthorisation.allCases.map(\.wireState)

        XCTAssertEqual(Set(wire).count, HealthReadAuthorisation.allCases.count)
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

    func testShouldReportEveryTypeEvenWhenTheReadSaidNothingAboutThem() {
        // The server refuses an upload that omits a type, and it is right to: the default
        // would have to be a guess about permission. A page that somehow lost a type
        // reports the conservative state rather than dropping the key.
        let page = HealthReadPage(authorisation: [.steps: .readable], samples: [])

        let report = page.wireAuthorisation

        XCTAssertEqual(report.count, HealthType.allCases.count)
        XCTAssertEqual(report[.steps], .authorised)
        XCTAssertEqual(report[.sleep], .undisclosed, "absent means unproven, never assumed fine")
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

    func testShouldDeclareAUnitHealthKitWillActuallyConvertEachTypeThrough() {
        // The hole the comparison above cannot see. That one asks "does the contract name
        // the same unit we convert through" — both sides of it are our own strings, so a
        // pound declared for `respiratoryRate` satisfies it perfectly and then throws at
        // `doubleValue(for:)` on his phone, at the one moment nobody is watching. This
        // asks HEALTHKIT whether the pairing is legal.
        for type in HealthType.allCases where type != .sleep && type != .workout {
            guard let quantityType = type.healthKitObjectType as? HKQuantityType else {
                continue
            }
            XCTAssertTrue(
                quantityType.is(compatibleWith: type.healthKitUnit),
                "\(type.rawValue) cannot be read in \(type.healthKitUnit.unitString)"
            )
        }
    }

    func testShouldResolveEveryTypeToAHealthKitObject() {
        for type in HealthType.allCases {
            XCTAssertNotNil(
                type.healthKitObjectType,
                "\(type.rawValue) has no HealthKit type, so it would read as empty forever"
            )
        }
    }

    func testShouldReadEveryTypeThatIsNotSleepOrWorkoutAsAPlainQuantityType() {
        // `syl-8ys9.1` added seven types on the assumption that all seven are plain
        // quantity samples. They are — but the epic's own list contains three things
        // that are NOT (date of birth and sex are characteristics; blood pressure is a
        // correlation of two values), so the assumption is worth asserting rather than
        // remembering. A characteristic forced into this shape gets a fabricated
        // `startedAt` and a baseline computed from one row.
        for type in HealthType.allCases where type != .sleep && type != .workout {
            XCTAssertTrue(
                type.healthKitObjectType is HKQuantityType,
                "\(type.rawValue) is not a quantity sample and cannot be read as one"
            )
        }
    }

    // MARK: - The one conversion that is not the identity

    func testShouldScaleNothingButBodyFatWhereTheUnitNameHidesAFactorOfAHundred() {
        // The gap the unit comparison above cannot see. HealthKit's `%` is a FRACTION
        // and the contract's `%` is percentage points; both spell themselves `%`, so
        // `unitString == unit` passes while the wire carries `0.18 %` for an eighteen
        // percent reading. That number is not obviously wrong to anything downstream —
        // a chart normalises it away and a baseline over it is internally consistent.
        for type in HealthType.allCases where type != .bodyFatPercentage {
            XCTAssertEqual(type.wireScale, 1, "\(type.rawValue) must convert as itself")
        }

        XCTAssertEqual(HealthType.bodyFatPercentage.wireScale, 100)
    }

    func testShouldPutEighteenPercentBodyFatOnTheWireAsEighteenAndNotAsPointOneEight() {
        // The same statement measured through the real conversion rather than through
        // the constant, because the constant is only correct if `wireValue` applies it.
        let eighteenPercent = HKQuantity(unit: .percent(), doubleValue: 0.18)

        XCTAssertEqual(HealthType.bodyFatPercentage.wireValue(of: eighteenPercent), 18, accuracy: 1e-9)
    }

    func testShouldConvertAQuantityThroughTheContractsUnitForEveryOtherType() {
        // Two of the seven new types whose HKUnit was read off a running simulator
        // rather than copied from documentation. A pound is not a kilogram and
        // `mL/min·kg` is not `ml/kg/min`; both would have been silently wrong numbers.
        let seventyKilos = HKQuantity(unit: .gramUnit(with: .kilo), doubleValue: 70)
        XCTAssertEqual(
            HealthType.leanBodyMass.wireValue(of: seventyKilos),
            154.3235835,
            accuracy: 1e-4
        )

        let twoMetres = HKQuantity(unit: .meter(), doubleValue: 1.8)
        XCTAssertEqual(HealthType.height.wireValue(of: twoMetres), 180, accuracy: 1e-9)
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
