import XCTest

@testable import Syl

/// **The sky must be still when nobody is touching it.**
///
/// The Commander, 2026-08-11: *"Whenever I click on a node, the screen starts kind of
/// zooming in and moving up on its own and is hard to stop."*
///
/// The cause was a layout loop, and it is worth writing down because nothing about it is
/// visible in the code that moves the sky:
///
/// 1. He taps a star, and the card comes up.
/// 2. The card's arrival perturbs the geometry by a fraction of a point.
/// 3. ``ConstellationViewModel/resize(to:)`` compared sizes with `!=` on `CGSize`, so a
///    third of a point counted as a new screen and **the whole sky was laid out again**.
/// 4. A re-laid sky has a different ``PreparedSky/size``, which changes
///    ``ConstellationBand/tallestCard(in:)``, which changes what the card fits into, which
///    changes the geometry — back to step 2.
///
/// Every part of that is a correct-looking line. The loop only exists in the ring, which is
/// exactly the kind of defect a test of any single part passes straight over — so these
/// tests are about *stillness* rather than about any one function's output.
@MainActor
final class ConstellationSteadinessTests: XCTestCase {

    // MARK: - The sky is not re-laid for a fraction of a point

    /// The one that shipped.
    ///
    /// A third of a point is a rounding artefact of a safe-area inset, not a new screen.
    /// Re-laying the sky for it moves every star — placement is a function of the size —
    /// so the whole field visibly shifts and rescales. That is the "zooming in" he saw.
    func testShouldNotRelayTheSkyForASubPointChange() async {
        let model = ConstellationViewModel(source: { .fixture })
        await model.read(size: CGSize(width: 393, height: 852))
        let settled = model.sky

        await model.resize(to: CGSize(width: 393, height: 852.3333))

        XCTAssertEqual(
            model.sky.size,
            settled.size,
            "a third of a point is not a new screen, and re-laying the sky for it moves every star"
        )
    }

    /// The other half, or the guard would simply freeze the sky at its first size.
    ///
    /// A rotation, a split view, a different device: those are real, and the sky must be
    /// laid out again for them.
    func testShouldStillRelayTheSkyForARealChange() async {
        let model = ConstellationViewModel(source: { .fixture })
        await model.read(size: CGSize(width: 393, height: 852))

        await model.resize(to: CGSize(width: 852, height: 393))

        XCTAssertEqual(model.sky.size, CGSize(width: 852, height: 393), "a rotation is a new sky")
    }

    /// The loop's other rung: a change small enough to ignore, arriving over and over.
    ///
    /// Jitter does not oscillate between two values politely — it wanders. So the guard has
    /// to hold against a *sequence* of negligible sizes, not merely against a repeat of the
    /// one it last accepted.
    func testShouldHoldStillAcrossASequenceOfJitter() async {
        let model = ConstellationViewModel(source: { .fixture })
        await model.read(size: CGSize(width: 393, height: 852))
        let settled = model.sky.size

        for wobble in [852.1, 851.9, 852.4, 851.7, 852.2] {
            await model.resize(to: CGSize(width: 393, height: wobble))
            XCTAssertEqual(model.sky.size, settled, "the sky must not chase jitter")
        }
    }

    // MARK: - Making room is a one-shot, not a pursuit

    /// **Panning the selection clear must converge.**
    ///
    /// `revealing` is called once when he taps and again when the card reports the height it
    /// settled at. If a second call with the same inputs moved the sky again, every redraw
    /// would move it a little further — a screen that drifts while he watches it and cannot
    /// be caught, because the thing chasing it is the thing he is looking at.
    func testShouldMoveTheSkyOnceAndThenLeaveItAlone() {
        let sky = CGSize(width: 393, height: 852)
        let bounds = CGRect(x: 0, y: 0, width: 393, height: 852)
        let deep = CGPoint(x: 200, y: 800)

        let once = ConstellationTransform.identity
            .revealing(deep, between: 120, and: 400, within: bounds, viewSize: sky)
        let twice = once
            .revealing(deep, between: 120, and: 400, within: bounds, viewSize: sky)

        XCTAssertEqual(twice, once, "a second reveal of the same point must be a no-op")
    }

    /// And it must converge to the *same place* whether the card's height arrives in one
    /// step or in the several a measurement pass actually delivers.
    ///
    /// This is what makes the intermediate heights harmless rather than cumulative: the sky
    /// ends where the final height says it should, not further up by the sum of the steps.
    func testShouldEndWhereTheFinalHeightSaysRegardlessOfHowItGotThere() {
        let sky = CGSize(width: 393, height: 852)
        let bounds = CGRect(x: 0, y: 0, width: 393, height: 852)
        let deep = CGPoint(x: 200, y: 800)

        let direct = ConstellationTransform.identity
            .revealing(deep, between: 120, and: 380, within: bounds, viewSize: sky)

        var stepped = ConstellationTransform.identity
        for skyline in [700.0, 560.0, 440.0, 380.0] {
            stepped = stepped.revealing(
                deep, between: 120, and: skyline, within: bounds, viewSize: sky)
        }

        XCTAssertEqual(
            stepped.translation.height,
            direct.translation.height,
            accuracy: 0.5,
            "a card measured in steps must not shove the sky further than one measured at once"
        )
    }
}
