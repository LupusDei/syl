import XCTest
import SylKit

@testable import Syl

/// The travelling light's parameters.
///
/// The Commander's hardest constraint on this component is a negative one: **it must
/// never read as a progress indicator.** That is a judgement about an image and it is
/// settled by looking at renders — but two properties underneath it are ordinary
/// arithmetic and can be held here, where they cannot quietly stop being true:
///
/// 1. the bright arc never covers the whole ring, in any state, at any intensity;
/// 2. the two arcs travel at rates that never bring them back into phase.
///
/// A spinner is exactly the thing that fails both.
final class HaloLightTests: XCTestCase {
    private let intensities: [Double] = [0, 0.25, 0.5, 0.75, 1]

    // MARK: - Not a spinner

    func testShouldNeverCoverTheWholeRingInAnyStateAtAnyIntensity() {
        for state in PresenceState.allCases {
            for intensity in intensities {
                let light = HaloLight.forState(state, intensity: intensity)
                // Half the ring, not most of it. The `manifest` render is what set this
                // number: past about a half lap the arc stops reading as a comet and
                // starts reading as a circle with a gap in it.
                XCTAssertLessThanOrEqual(
                    light.arcSpan,
                    0.5,
                    "\(state) at \(intensity) closes the ring into a loading spinner"
                )
                // And both arcs together must still leave the ring open.
                XCTAssertLessThan(
                    light.arcSpan * (1 + HaloLight.companionSpan),
                    1,
                    "\(state) at \(intensity) has the two arcs meeting end to end"
                )
                XCTAssertGreaterThan(light.arcSpan, 0, "\(state) at \(intensity) has no arc at all")
            }
        }
    }

    func testShouldRunTheTwoArcsAtRatesThatNeverComeBackIntoPhase() {
        // A rational ratio with a small denominator closes the figure in a few laps and
        // the eye finds the repeat. 0.61 = 61/100 takes 61 laps, which is longer than
        // anyone looks at a home screen.
        XCTAssertNotEqual(HaloLight.companionRate, 1)
        XCTAssertNotEqual(HaloLight.companionRate, 0)

        let closesAfter = laps(toRepeat: HaloLight.companionRate)
        XCTAssertGreaterThan(
            closesAfter,
            24,
            "the two arcs return to the same relative phase every \(closesAfter) laps"
        )
    }

    func testShouldGiveTheCompanionADifferentLengthFromTheLeadingArc() {
        XCTAssertLessThan(HaloLight.companionSpan, 1)
        XCTAssertGreaterThan(HaloLight.companionSpan, 0)
        XCTAssertLessThan(HaloLight.companionBrightness, 1, "a second arc as bright as the first is two spinners")
    }

    // MARK: - State drives it

    func testShouldDrawNothingAtAllWhenSheIsAbsent() {
        XCTAssertEqual(HaloLight.forState(.absent, intensity: 1).brightness, 0)
    }

    func testShouldLeaveTheRestingStatesToTheGateRatherThanDrawingThemFaintly() {
        // `HomeSnapshot.isActive` is what decides whether the halo exists. Asserted here
        // because the halo's own numbers for these states are perfectly drawable, so
        // nothing in this file would otherwise notice the gate being removed.
        XCTAssertFalse(HomeSnapshot.isActive(.idle))
        XCTAssertFalse(HomeSnapshot.isActive(.concerned))
        XCTAssertFalse(HomeSnapshot.isActive(.absent))
        XCTAssertTrue(HomeSnapshot.isActive(.thinking))
    }

    func testShouldGiveThinkingAShorterQuickerArcThanManifest() {
        let thinking = HaloLight.forState(.thinking, intensity: 0.7)
        let manifest = HaloLight.forState(.manifest, intensity: 0.7)

        XCTAssertLessThan(thinking.arcSpan, manifest.arcSpan, "thinking should be a dash, not a sweep")
        XCTAssertGreaterThan(
            thinking.turnsPerSecond,
            manifest.turnsPerSecond,
            "thinking should travel faster than a manifestation"
        )
    }

    func testShouldCarryTheRibbonsWarmthAndDesaturationUnchanged() {
        // The palette is not re-decided here. If `alert` is warm on the ribbon it is warm
        // on the halo, because it is the same number.
        for state in PresenceState.allCases {
            let ribbon = RibbonAppearance.forState(state)
            let light = HaloLight.forState(state, intensity: 0.8)
            XCTAssertEqual(light.warmth, ribbon.warmth, accuracy: 1e-9, "\(state)")
            XCTAssertEqual(light.desaturation, ribbon.desaturation, accuracy: 1e-9, "\(state)")
            XCTAssertEqual(light.sparks, ribbon.sparks, accuracy: 1e-9, "\(state)")
        }
    }

    // MARK: - Intensity drives it

    func testShouldRaiseLengthSpeedAndBrightnessWithIntensity() {
        let quiet = HaloLight.forState(.thinking, intensity: 0.1)
        let loud = HaloLight.forState(.thinking, intensity: 0.95)

        XCTAssertGreaterThan(loud.arcSpan, quiet.arcSpan)
        XCTAssertGreaterThan(loud.turnsPerSecond, quiet.turnsPerSecond)
        XCTAssertGreaterThan(loud.brightness, quiet.brightness)
    }

    func testShouldStayLitAtZeroIntensityRatherThanVanishing() {
        // Intensity is an amplitude, not an on/off. A state she is genuinely in must be
        // visible even when the signal driving it is at the floor — otherwise the halo
        // blinks out mid-thought and reads as a dropped connection.
        let light = HaloLight.forState(.thinking, intensity: 0)
        XCTAssertGreaterThan(light.brightness, 0.2)
        XCTAssertGreaterThan(light.turnsPerSecond, 0)
    }

    func testShouldClampAnIntensityFromOutsideTheUnitRange() {
        XCTAssertEqual(
            HaloLight.forState(.thinking, intensity: 4).brightness,
            HaloLight.forState(.thinking, intensity: 1).brightness,
            accuracy: 1e-9
        )
        XCTAssertEqual(
            HaloLight.forState(.thinking, intensity: -3).brightness,
            HaloLight.forState(.thinking, intensity: 0).brightness,
            accuracy: 1e-9
        )
    }

    // MARK: - Reduce Motion

    func testShouldParkTheRestingArcWhereALightSourceBelongs() {
        // Upper-left of the ellipse, in the canvas's own coordinates: y grows downward,
        // so a negative sine is above the centre.
        XCTAssertLessThan(sin(HaloLight.restingAngle), 0, "the resting arc should sit above the words")
        XCTAssertLessThan(cos(HaloLight.restingAngle), 0, "the resting arc should sit to the left")
    }

    // MARK: - Helpers

    /// How many laps of the leading arc before the pair returns to the same relative
    /// phase — the denominator of the rate difference, as a fraction in lowest terms.
    private func laps(toRepeat rate: Double) -> Int {
        let difference = abs(1 - rate)
        guard difference > 0 else { return .max }

        // Rational reconstruction over a bounded denominator: the smallest `n` for which
        // `n * difference` is a whole number is the repeat period in laps.
        for n in 1...1000 where abs((Double(n) * difference).rounded() - Double(n) * difference) < 1e-9 {
            return n
        }
        return 1000
    }
}
