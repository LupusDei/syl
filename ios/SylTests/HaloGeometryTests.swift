import XCTest
import SwiftUI
import UIKit
import SylKit

@testable import Syl

/// The halo's shape, checked against text that was actually measured.
///
/// ## Why the sizes here are measured rather than written down
///
/// ``SylHalo`` sizes its ring from the phrase it orbits, and the phrase is whatever
/// ``HomeSnapshot/phrase(for:)`` returns for the state Syl is in — eight different
/// sentences, at every Dynamic Type size the Commander might have chosen. A ring tuned
/// to one of them crops or floats around another, and the failure is invisible to any
/// assertion written against a constant.
///
/// So these tests measure the real strings in the real font, through UIKit, and assert
/// the ring encloses what came back. The numbers are therefore never stated here, which
/// is the point: a font metric change moves the input and the assertion still means what
/// it said.
///
/// ## The bug this is really guarding
///
/// **An ellipse around a rectangle is not the rectangle inflated by a margin.** The
/// obvious implementation — `a = halfWidth + margin`, `b = halfHeight + margin` — puts
/// the rectangle's *corners* outside the ellipse, because an ellipse pulls in between
/// its axes. On one short line it happens to survive, since the margin is large next to
/// the line's height; at accessibility sizes, where the phrase wraps to three lines and
/// is nearly as tall as it is wide, it fails by a wide margin and clips the words.
///
/// That is why every containment assertion below is repeated at an accessibility size,
/// and why the accessibility one is the assertion that actually bites.
final class HaloGeometryTests: XCTestCase {
    /// The width of the iPhone this app is designed against, in points.
    private let screenWidth: CGFloat = 393

    // MARK: - Containment

    func testShouldEncloseEveryPhraseWithItsMarginWhenTypeIsAtItsDefaultSize() {
        for (phrase, size) in measuredPhrases(at: .large) {
            let margin = Self.margin(at: .large)
            let geometry = HaloGeometry.around(
                phrase: size,
                margin: margin,
                availableWidth: screenWidth
            )

            XCTAssertEqual(
                geometry.clearance,
                margin,
                accuracy: 0.001,
                "there is room for the whole margin at the default size; \"\(phrase)\" gave some up"
            )
            XCTAssertTrue(
                geometry.encloses(halfWidth: size.width / 2 + margin, halfHeight: size.height / 2 + margin),
                "the ring crops \"\(phrase)\" at the default size: phrase \(size), ring \(geometry)"
            )
        }
    }

    /// The same assertion where it actually bites — and asserted against the clearance the
    /// halo *kept*, not the one it was asked for.
    ///
    /// At the largest sizes there is genuinely not room for both the margin and the ring,
    /// and the halo gives the margin back rather than running off the screen. The two
    /// things worth holding are that it never gives back all of it, and that whatever it
    /// keeps, the words are inside.
    func testShouldEncloseEveryPhraseWithItsMarginWhenTypeIsAtAnAccessibilitySize() {
        for typeSize in [DynamicTypeSize.accessibility1, .accessibility3, .accessibility5] {
            for phrase in Self.everyPhrase {
                let lines = Self.lines(phrase, at: typeSize)
                let geometry = HaloGeometry.around(
                    lines: lines,
                    margin: Self.margin(at: typeSize),
                    availableWidth: screenWidth
                )

                XCTAssertGreaterThan(
                    geometry.clearance,
                    4,
                    "the ring is sitting on the words of \"\(phrase)\" at \(typeSize)"
                )
                assertEncloses(lines, in: geometry, phrase: phrase, typeSize: typeSize)
            }
        }
    }

    /// Every line of a phrase, held with its clearance.
    ///
    /// **Not the box around them** — the box's corners are deliberately outside the
    /// ellipse for a wrapped phrase, which is the entire trick that makes the largest type
    /// sizes possible. Asserting on the box here would demand the geometry the renders
    /// proved impossible.
    private func assertEncloses(
        _ lines: [CGSize],
        in geometry: HaloGeometry,
        phrase: String,
        typeSize: DynamicTypeSize,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let total = lines.reduce(0) { $0 + $1.height }
        var top = -total / 2

        for measured in lines {
            let bottom = top + measured.height
            let corner = CGPoint(
                x: measured.width / 2 + geometry.clearance,
                y: max(abs(top), abs(bottom)) + geometry.clearance
            )
            top = bottom

            XCTAssertTrue(
                geometry.contains(corner),
                "the ring crops a line of \"\(phrase)\" at \(typeSize): corner \(corner), ring \(geometry)",
                file: file,
                line: line
            )
        }
    }

    /// The halo fits the screen for every phrase at every type size, with its glow.
    ///
    /// This is the assertion the first accessibility render produced. Before the geometry
    /// was solved line by line, *"Thinking about your week."* at `accessibility5` came back
    /// 437 points tall on an 852-point screen, ran over the title above it and crossed her
    /// face — and nothing in the suite noticed, because every test then in the file was
    /// about containment, and a ring far too large contains beautifully.
    func testShouldFitEveryPhraseOnTheScreenAtEveryTypeSize() {
        let sizes: [DynamicTypeSize] = [.xSmall, .large, .xxxLarge, .accessibility1, .accessibility3, .accessibility5]

        for width in [CGFloat(320), 393, 430] {
            for typeSize in sizes {
                for phrase in Self.everyPhrase {
                    let geometry = HaloGeometry.around(
                        lines: PhraseMetrics.lines(
                            of: phrase,
                            within: HaloGeometry.textMeasure(in: width),
                            typeSize: typeSize
                        ),
                        margin: Self.margin(at: typeSize),
                        availableWidth: width
                    )

                    // Either it fits, or it has said it does not and will not be drawn.
                    // What is forbidden is a halo that overflows *and* claims to fit —
                    // that one gets drawn, cropped by the screen edge.
                    guard geometry.fits else { continue }
                    XCTAssertLessThanOrEqual(
                        geometry.footprint.width,
                        width + 0.001,
                        "\"\(phrase)\" at \(typeSize) on \(width): halo \(geometry.footprint)"
                    )
                    XCTAssertGreaterThanOrEqual(
                        geometry.clearance,
                        SylTheme.Metric.snug,
                        "\"\(phrase)\" at \(typeSize) on \(width) drew a ring sitting on the words"
                    )
                }
            }
        }
    }

    /// Containing the *lines* rather than the box around them is what made the largest
    /// sizes possible at all, so it is worth an assertion of its own: the two answers must
    /// genuinely differ, and in the direction claimed.
    func testShouldDrawATighterRingFromTheLinesThanFromTheBoxAroundThem() {
        let typeSize = DynamicTypeSize.accessibility5
        let lines = Self.lines("Thinking about your week.", at: typeSize)
        XCTAssertGreaterThan(lines.count, 1, "this case is only interesting once the phrase wraps")

        // On a width where nothing else is binding, so the two answers differ by the
        // geometry alone. Pinned at the cap they are both circles of the same radius and
        // the comparison says nothing — which is how this first passed while measuring
        // nothing at all.
        let margin = Self.margin(at: typeSize)
        let generous: CGFloat = 900
        let fromLines = HaloGeometry.around(lines: lines, margin: margin, availableWidth: generous)
        let fromBox = HaloGeometry.around(
            phrase: Self.measure(
                "Thinking about your week.",
                at: typeSize,
                within: HaloGeometry.textMeasure(in: screenWidth)
            ),
            margin: margin,
            availableWidth: generous
        )

        XCTAssertTrue(fromLines.fits && fromBox.fits, "neither answer should be at the cap here")
        XCTAssertLessThan(fromLines.size.height, fromBox.size.height)
        XCTAssertLessThan(fromLines.size.width, fromBox.size.width)
    }

    /// The corner is the only place containment can fail, so assert on the corner
    /// specifically rather than trusting the four-corner helper to be looking at it.
    func testShouldHoldTheCornerOfAWrappedPhraseInsideTheEllipse() {
        let size = CGSize(width: 262, height: 148)   // three wrapped lines, ax5-ish
        let geometry = HaloGeometry.around(phrase: size, margin: 24, availableWidth: screenWidth)

        let corner = CGPoint(
            x: size.width / 2 + geometry.clearance,
            y: size.height / 2 + geometry.clearance
        )
        XCTAssertTrue(geometry.contains(corner), "corner \(corner) fell outside \(geometry)")
    }

    // MARK: - Shape

    func testShouldOrbitOneLineAsAnEllipseAndAWrappedPhraseAsSomethingRounder() {
        let oneLine = HaloGeometry.around(
            phrase: CGSize(width: 242, height: 19),
            margin: 14,
            availableWidth: screenWidth
        )
        let wrapped = HaloGeometry.around(
            phrase: CGSize(width: 250, height: 96),
            margin: 14,
            availableWidth: screenWidth
        )

        XCTAssertGreaterThan(oneLine.aspect, 2.0, "a single line should read as an orbit, not a circle")
        XCTAssertLessThan(
            wrapped.aspect,
            oneLine.aspect,
            "a phrase that wraps should pull the ring toward round"
        )
    }

    func testShouldNeverExceedTheAspectCeilingHoweverLongThePhraseIs() {
        // On a screen wide enough that nothing else is binding: a long single line asks
        // for an ellipse nine times wider than it is tall, and without the ceiling it gets
        // one — a slit rather than a halo. The width has to be generous or the *fit* limit
        // does the clamping instead and the ceiling is never exercised, which is exactly
        // how this test first passed against an implementation that had no ceiling at all.
        let geometry = HaloGeometry.around(
            phrase: CGSize(width: 400, height: 16),
            margin: 14,
            availableWidth: 1200
        )

        XCTAssertGreaterThanOrEqual(geometry.aspect, 1)
        XCTAssertLessThanOrEqual(
            geometry.aspect,
            HaloGeometry.maxAspect + 0.001,
            "the ring flattened into a slit: \(geometry)"
        )
    }

    func testShouldNeverBeWiderThanTheScreenItIsDrawnOn() {
        for width in [CGFloat(320), 375, 393, 430] {
            let measure = HaloGeometry.textMeasure(in: width)
            for phraseWidth in [CGFloat(40), measure * 0.5, measure] {
                for phraseHeight in [CGFloat(19), 96, 220] {
                    let geometry = HaloGeometry.around(
                        phrase: CGSize(width: phraseWidth, height: phraseHeight),
                        margin: HaloGeometry.margin(scaled: 40),
                        availableWidth: width
                    )
                    // The footprint, not the ring: a ring that fits while its glow is cut
                    // off square by the screen edge is not a ring that fits.
                    guard geometry.fits else { continue }
                    XCTAssertLessThanOrEqual(
                        geometry.footprint.width,
                        width + 0.001,
                        "a halo \(geometry.footprint.width) wide bleeds off a \(width) screen"
                    )
                }
            }
        }
    }

    /// Asked for something impossible — a phrase far wider than the screen — the ring
    /// still holds the words, and says it does not fit.
    ///
    /// Written down because the opposite choice is the one that suggests itself and it is
    /// wrong: a ring cropped down until it fits is a ring drawn *through* the sentence it
    /// exists to serve, and the caller has no way to tell that apart from a bug. Reporting
    /// `fits == false` lets the halo stand down instead, which is what ``SylHalo`` does.
    func testShouldKeepTheWordsAndReportItDoesNotFitWhenAskedTheImpossible() {
        let phrase = CGSize(width: 900, height: 16)
        let geometry = HaloGeometry.around(phrase: phrase, margin: 14, availableWidth: screenWidth)

        XCTAssertFalse(geometry.fits)
        XCTAssertTrue(
            geometry.encloses(
                halfWidth: phrase.width / 2 + geometry.clearance,
                halfHeight: phrase.height / 2 + geometry.clearance
            ),
            "containment was traded away to fit the screen"
        )
        XCTAssertGreaterThan(geometry.size.width, screenWidth)
    }

    /// Standing down is not a thing the halo may do quietly while there was room.
    ///
    /// Without this, every other assertion in the file is satisfiable by never drawing a
    /// halo at all — `fits == false` skips them. The accessibility sizes are deliberately
    /// **not** here: at those the ring genuinely cannot be had, and that is the subject of
    /// its own test.
    func testShouldFitEveryPhraseTheModelProducesAtOrdinaryTypeSizes() {
        for width in [CGFloat(320), 375, 393, 430] {
            for typeSize in [DynamicTypeSize.large, .xLarge, .xxLarge, .xxxLarge] {
                for phrase in Self.everyPhrase {
                    let geometry = HaloGeometry.around(
                        lines: PhraseMetrics.lines(
                            of: phrase,
                            within: HaloGeometry.textMeasure(in: width),
                            typeSize: typeSize
                        ),
                        margin: Self.margin(at: typeSize),
                        availableWidth: width
                    )
                    XCTAssertTrue(
                        geometry.fits,
                        "\"\(phrase)\" at \(typeSize) on \(width) has no halo, and should"
                    )
                }
            }
        }
    }

    /// The width cap must not be allowed to break containment: when the ellipse is
    /// squeezed horizontally it has to grow vertically or it starts cutting the words.
    func testShouldGrowTallerRatherThanCropWhenTheWidthIsCapped() {
        let margin = HaloGeometry.margin(scaled: 34)
        // A wrapped phrase at the full measure: the case where the ellipse the aspect
        // asks for is wider than the screen allows.
        let phrase = CGSize(width: HaloGeometry.textMeasure(in: screenWidth), height: 110)
        let geometry = HaloGeometry.around(phrase: phrase, margin: margin, availableWidth: screenWidth)

        // Pinned at the cap, which is the screen less the ring's own inset from the edge.
        // Written from the constants rather than as a number, so a change to either one
        // moves the expectation with it instead of failing here.
        XCTAssertEqual(
            geometry.footprint.width,
            screenWidth - 2 * (SylTheme.Metric.chapter - HaloGeometry.glowAllowance),
            accuracy: 0.001,
            "this case is only interesting while the width cap is what is binding"
        )
        XCTAssertTrue(
            geometry.encloses(
                halfWidth: phrase.width / 2 + geometry.clearance,
                halfHeight: phrase.height / 2 + geometry.clearance
            ),
            "the width cap cropped the phrase: \(geometry)"
        )
    }

    // MARK: - Layout

    /// The halo reserves its own space, in both axes, so nothing above or below it can be
    /// overlapped. A ring drawn outside the layout would have to be kept clear by
    /// remembering to keep it clear.
    func testShouldReserveTheRingAndTheRoomItsGlowNeeds() {
        let phrase = CGSize(width: 200, height: 19)
        let geometry = HaloGeometry.around(phrase: phrase, margin: 14, availableWidth: screenWidth)

        XCTAssertEqual(
            geometry.footprint.width,
            geometry.size.width + HaloGeometry.glowAllowance * 2,
            accuracy: 0.001
        )
        XCTAssertEqual(
            geometry.footprint.height,
            geometry.size.height + HaloGeometry.glowAllowance * 2,
            accuracy: 0.001
        )
        XCTAssertGreaterThan(geometry.footprint.height, phrase.height)
    }

    /// The ring hugs the phrase rather than stretching to the width it was allowed.
    ///
    /// Her shortest line is two syllables; her longest is a sentence. If the ring took its
    /// width from the space available rather than from the words, both would be orbited by
    /// the same ellipse and it would only be *about* one of them.
    func testShouldHugAShortPhraseInsteadOfStretchingToTheMeasure() {
        let measure = HaloGeometry.textMeasure(in: screenWidth)
        let short = Self.measure("Here.", at: .large, within: measure)
        let long = Self.measure("Thinking about your week.", at: .large, within: measure)

        let aroundShort = HaloGeometry.around(phrase: short, margin: 15, availableWidth: screenWidth)
        let aroundLong = HaloGeometry.around(phrase: long, margin: 15, availableWidth: screenWidth)

        XCTAssertLessThan(aroundShort.size.width, aroundLong.size.width * 0.7)
        XCTAssertLessThan(aroundShort.size.width, measure)
    }

    func testShouldLeaveTheTextMeasureNarrowEnoughForTheRingToFitBesideIt() {
        for width in [CGFloat(320), 375, 393, 430] {
            let measure = HaloGeometry.textMeasure(in: width)
            XCTAssertGreaterThan(measure, 0)
            XCTAssertLessThan(
                measure,
                width,
                "a phrase measured at the full width leaves the ring nowhere to go"
            )
        }
    }

    // MARK: - Degenerate input

    func testShouldSurviveAPhraseOfNoSizeWithoutProducingNonsense() {
        let geometry = HaloGeometry.around(phrase: .zero, margin: 14, availableWidth: screenWidth)

        XCTAssertTrue(geometry.semiMajor.isFinite)
        XCTAssertTrue(geometry.semiMinor.isFinite)
        XCTAssertGreaterThan(geometry.semiMajor, 0)
        XCTAssertGreaterThan(geometry.semiMinor, 0)
    }

    func testShouldSurviveANegativeWidthWithoutProducingNonsense() {
        let geometry = HaloGeometry.around(
            phrase: CGSize(width: -10, height: -10),
            margin: 14,
            availableWidth: 0
        )

        XCTAssertTrue(geometry.semiMajor.isFinite && geometry.semiMinor.isFinite)
        XCTAssertGreaterThan(geometry.semiMajor, 0)
        XCTAssertGreaterThan(geometry.semiMinor, 0)
    }

    // MARK: - Helpers

    /// Every sentence the home screen can put under her name, measured for real.
    ///
    /// The greeting is included because ``HomeSnapshot/phrase(for:)`` returns nil while
    /// she is speaking and ``HomeView`` falls back to it — so the greeting is a phrase
    /// this ring has to orbit, and it is the one nobody thinks of.
    private func measuredPhrases(at typeSize: DynamicTypeSize) -> [(String, CGSize)] {
        let measure = HaloGeometry.textMeasure(in: screenWidth)
        return Self.everyPhrase.map { ($0, Self.measure($0, at: typeSize, within: measure)) }
    }

    /// Every sentence that can land under her name.
    fileprivate static let everyPhrase: [String] =
        PresenceState.allCases.compactMap { HomeSnapshot.phrase(for: $0) }
            + ["Still awake", "Good morning", "Good afternoon", "Good evening", "Good night"]

    private static func lines(_ phrase: String, at typeSize: DynamicTypeSize) -> [CGSize] {
        PhraseMetrics.lines(of: phrase, within: HaloGeometry.textMeasure(in: 393), typeSize: typeSize)
    }

    /// The phrase's rendered bounds — asked of the same measurement the view uses.
    ///
    /// Deliberately not a second implementation. The interesting question here is whether
    /// the *ring* holds the phrase, and a private copy of the font arithmetic would let
    /// the test agree with itself while disagreeing with the device. What the measurement
    /// itself is worth is asserted separately, below.
    private static func measure(_ phrase: String, at typeSize: DynamicTypeSize, within width: CGFloat) -> CGSize {
        PhraseMetrics.bounds(of: phrase, within: width, typeSize: typeSize)
    }

    /// What `@ScaledMetric(relativeTo: .subheadline)` makes of the halo's base margin at a
    /// given type size, run through the same cap the view applies. Two steps, both taken
    /// from the implementation rather than restated, so the test asks the question the
    /// device asks.
    private static func margin(at typeSize: DynamicTypeSize) -> CGFloat {
        let traits = UITraitCollection(
            preferredContentSizeCategory: PhraseMetrics.contentSize(for: typeSize)
        )
        let scaled = UIFontMetrics(forTextStyle: .subheadline)
            .scaledValue(for: HaloGeometry.baseMargin, compatibleWith: traits)
        return HaloGeometry.margin(scaled: scaled)
    }
}

/// The measurement the ring is sized from.
///
/// Split out from the geometry's own tests because the two can fail for entirely
/// different reasons: the geometry can be wrong about ellipses, and the measurement can be
/// wrong about type. A containment test that used a private copy of this arithmetic would
/// be blind to the second, which is the half that talks to the device.
final class PhraseMetricsTests: XCTestCase {
    private let measure = HaloGeometry.textMeasure(in: 393)

    func testShouldGrowThePhraseWithTheTypeSize() {
        let ordinary = PhraseMetrics.bounds(of: "Thinking about your week.", within: measure, typeSize: .large)
        let large = PhraseMetrics.bounds(
            of: "Thinking about your week.",
            within: measure,
            typeSize: .accessibility3
        )

        XCTAssertGreaterThan(large.height, ordinary.height)
    }

    func testShouldWrapRatherThanOverrunTheMeasureItWasGiven() {
        for typeSize in [DynamicTypeSize.large, .xxxLarge, .accessibility3, .accessibility5] {
            for phrase in PresenceState.allCases.compactMap({ HomeSnapshot.phrase(for: $0) }) {
                let bounds = PhraseMetrics.bounds(of: phrase, within: measure, typeSize: typeSize)
                // Plus one character of tracking: the letter-spacing is applied *after* the
                // last glyph as well as between them — by CoreText here and by SwiftUI on
                // screen — so a line may legitimately end that much past where it broke.
                // Anything more is a line that did not wrap, or trailing whitespace being
                // counted as ink, and both of those move the ring.
                XCTAssertLessThanOrEqual(
                    bounds.width,
                    measure + PhraseMetrics.tracking,
                    "\"\(phrase)\" ran past its measure at \(typeSize)"
                )
                XCTAssertGreaterThan(bounds.height, 0, "\"\(phrase)\" measured as nothing at \(typeSize)")
            }
        }
    }

    func testShouldKeepHerShortestPhraseOnOneLineAtTheDefaultSize() {
        let short = PhraseMetrics.bounds(of: "Here.", within: measure, typeSize: .large)
        let line = PhraseMetrics.font(for: .large).lineHeight

        // Under one and a half lines, rather than exactly one: `.usesFontLeading` adds the
        // font's own leading on top of its line height, so a single line measures a point
        // or two taller than `lineHeight`. Two lines cannot hide under this bound.
        XCTAssertLessThan(short.height, line * 1.6, "her shortest line should not be wrapping")
        XCTAssertLessThan(short.width, measure / 2)
    }

    func testShouldMeasureAnEmptyPhraseAsNothingRatherThanAsALine() {
        XCTAssertEqual(PhraseMetrics.bounds(of: "", within: measure, typeSize: .large), .zero)
    }

    func testShouldReserveEnoughRoomForTheWidestGlowAnyStateProduces() {
        // The feather's outermost pass is six times the core width, so it spills three
        // times the core width outside the ring. Derived from the states rather than
        // eyeballed, so a state tuned wider later fails here instead of clipping quietly.
        let widest = PresenceState.allCases
            .map { HaloLight.forState($0, intensity: 1).width }
            .max() ?? 0

        XCTAssertGreaterThanOrEqual(
            Double(HaloGeometry.glowAllowance),
            widest * 3,
            "the glow will be clipped square by the edge of its own box"
        )
    }
}
