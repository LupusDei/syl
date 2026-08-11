import SwiftUI
import UIKit
import XCTest

@testable import Syl

/// **The sky must reach a size and stay there.**
///
/// The Commander, twice, a day apart: *"whenever I click on a node the screen starts kind of
/// zooming in and moving up on its own and is hard to stop"*, and then *"if I tap the base
/// node I get the memory to pop up, but if I tap another node no memory pops up and the whole
/// thing starts zooming in without end."*
///
/// ``ConstellationSteadinessTests`` fixed one cause — `resize(to:)` compared `CGSize` with
/// `==`, so a third of a point re-laid every star — and it was not the only one. This file is
/// about the ring that survived it, and it is written the only way that ring can be seen:
/// **through SwiftUI's real layout**, in a real window, with real safe-area insets.
///
/// A pure test cannot see this. Every function in the ring is correct; the defect is the
/// cycle, and the cycle runs through `GeometryReader`, `ZStack` sizing and `ignoresSafeArea`
/// — three things only the layout system can answer for. Modelling them here would be a
/// consistency check against my own idea of SwiftUI, which is precisely the shape this
/// project has been bitten by six times.
@MainActor
final class ConstellationRunawayTests: XCTestCase {

    /// An iPhone 16, in points.
    private let phone = CGSize(width: 393, height: 852)

    /// What a tab-bar app with a navigation bar actually leaves. The numbers matter less than
    /// their being non-zero: the whole class of defect here is a view laid out for the glass
    /// and measured against the safe area, and insets of zero make the two agree by accident.
    private let insets = UIEdgeInsets(top: 44, left: 0, bottom: 83, right: 0)

    // MARK: - The ring

    /// One turn of the loop the device runs.
    ///
    /// `MemoryScreen` reads a size out of the sky's own `GeometryReader`, prepares a sky for
    /// it, and hands that sky back to the view — which lays itself out and reports a size
    /// again. This runs exactly that, through a real hosting controller, and returns what the
    /// second half reported.
    private func glassReported(
        forSkyOf glass: ConstellationGlass, selecting hit: ConstellationHit?
    ) -> ConstellationGlass {
        let sky = SkyPreparer(now: ConstellationFixture.now)
            .prepare(.hubAndSpokes, size: glass.size, chrome: glass.chrome)

        var reported = ConstellationGlass.none
        let view = ConstellationView(
            sky: sky,
            time: .pinned,
            opensWith: hit,
            onGlass: { reported = $0 })

        let host = UIHostingController(rootView: view)
        host.additionalSafeAreaInsets = insets

        let window = UIWindow(frame: CGRect(origin: .zero, size: phone))
        window.rootViewController = host
        window.isHidden = false
        // Twice, because the card's measured height arrives on the first pass and is acted on
        // in the second — which is the pass the device is actually living in.
        window.layoutIfNeeded()
        host.view.setNeedsLayout()
        window.layoutIfNeeded()

        return reported
    }

    /// The sequence of sizes the ring produces, starting from the glass itself.
    private func ringSizes(selecting hit: ConstellationHit?, turns: Int = 6) -> [CGSize] {
        var sizes: [CGSize] = []
        var glass = ConstellationGlass(size: phone, chrome: .phone)
        for _ in 0..<turns {
            glass = glassReported(forSkyOf: glass, selecting: hit)
            sizes.append(glass.size)
        }
        return sizes
    }

    // MARK: - The invariant

    /// **The size the sky is laid out for must reach a fixed point.**
    ///
    /// This is the invariant the Commander described from the outside. `ConstellationLayout`'s
    /// field is `(height − insets) / 2`, so a size that grows spreads every star apart — which
    /// is what "zooming in without end" actually was. It is not the transform: `maximumScale`
    /// is four, and what he sent is a sky spread far wider than four times.
    ///
    /// Two turns is the allowance, because the card's height genuinely does arrive after the
    /// first layout. A third different size is a loop.
    func testShouldSettleOnASizeWhileNothingIsSelected() {
        let sizes = ringSizes(selecting: nil)

        XCTAssertEqual(
            sizes.last?.height ?? 0, sizes.first?.height ?? 0, accuracy: 1,
            "an untouched sky must be laid out for the same size every time it is measured: \(sizes)")
    }

    /// The same, with a card up — which is the state he is in when it starts.
    ///
    /// This is the one that reproduced. With the card's top padding derived from the sky's own
    /// height, opening a card made the screen taller than the glass, the `GeometryReader`
    /// reported the taller number, the sky was laid out for it, and the padding grew again.
    func testShouldSettleOnASizeWithACardUp() {
        let sizes = ringSizes(selecting: .star("person.father"))

        XCTAssertEqual(
            sizes.last?.height ?? 0, sizes[1].height, accuracy: 1,
            "opening a card must not make the sky it sits on grow: \(sizes)")
    }

    /// **And the stars must not move, which is the other half of what he reported.**
    ///
    /// > *"If I tap the base node I get the memory to pop up. But if I tap another node, no
    /// > memory pops up."*
    ///
    /// It is tempting to read that as a hit-testing bug, and it is not one: the drawing and
    /// the hit test read the same ``PreparedSky``, so they cannot disagree about where a star
    /// is. What they *can* both be is **wrong about where it was a moment ago**. The sky's
    /// placement is a function of its size, and the size was growing fifty-two points a pass —
    /// so every star was in motion, and a finger aimed at a star arrived where the star had
    /// been. The first tap of a session landed because nothing had started yet; every tap
    /// after it chased.
    ///
    /// This measures exactly that: run the ring with a card up, and no star may move.
    ///
    /// The reference is **the sky he was looking at when he aimed**: the resting sky, settled
    /// with nothing selected. Not a size this test guessed at — the view discovers the real
    /// chrome on its first layout, and a reference chosen here rather than measured would be
    /// this file agreeing with itself.
    func testShouldNotMoveASingleStarWhenACardOpens() {
        var resting = ConstellationGlass(size: phone, chrome: .phone)
        for _ in 0..<2 { resting = glassReported(forSkyOf: resting, selecting: nil) }
        let atRest = SkyPreparer(now: ConstellationFixture.now)
            .prepare(.hubAndSpokes, size: resting.size, chrome: resting.chrome)

        var glass = resting
        for turn in 1...4 {
            glass = glassReported(forSkyOf: glass, selecting: .star("person.father"))
            let now = SkyPreparer(now: ConstellationFixture.now)
                .prepare(.hubAndSpokes, size: glass.size, chrome: glass.chrome)

            for (before, after) in zip(atRest.stars, now.stars) {
                let moved = hypot(
                    Double(after.anchor.x - before.anchor.x),
                    Double(after.anchor.y - before.anchor.y))
                XCTAssertLessThan(
                    moved, 1,
                    "\(before.id) travelled \(moved)pt by turn \(turn) — a finger aimed at it "
                        + "would arrive where it used to be")
            }
        }
    }

    /// And it must settle at **the glass**, not merely settle.
    ///
    /// A loop with a gain below one converges too — to somewhere larger than the screen, with
    /// every star pushed off the edges of a sky nobody can see the whole of. Converging is not
    /// the property that matters; converging *to the size of the screen* is.
    func testShouldLayTheSkyOutForTheScreenItIsDrawnOn() {
        let withCard = ringSizes(selecting: .star("person.father")).last ?? .zero
        let without = ringSizes(selecting: nil).last ?? .zero

        XCTAssertEqual(
            without.height, phone.height, accuracy: 1,
            "the sky is drawn edge to edge, so it is laid out for the whole glass")
        XCTAssertEqual(
            withCard.height, without.height, accuracy: 1,
            "a card is drawn over the sky, not added to it")
    }

    // MARK: - The arithmetic the structure is standing in for

    /// **A card never comes back taller than the ceiling it was given.**
    ///
    /// The unit-sized statement of the same defect, and the half the overlay does *not* fix.
    /// ``ConstellationBand/tallestCard(in:chrome:)`` is a budget for the **whole** card, and
    /// the screen reserves room by subtracting it from the glass — so a card that answers
    /// with a ceiling of scrolling content *plus* a gutter at each end is forty points into
    /// space nobody set aside.
    ///
    /// Since ``ConstellationView`` made the card an overlay in a fixed band, that overrun can
    /// no longer grow the sky — the ring is broken structurally and stays broken. But it is
    /// still wrong twice over: the card overhangs its band on the glass, and the height it
    /// reports through `onHeight` is the number ``ConstellationBand/skyline(forCardOf:in:chrome:)``
    /// pans against, so the sky lifts a selection forty points further than it needs to.
    ///
    /// Keeping this assertion separate from the structure is deliberate. The overlay means a
    /// future padding change cannot bring the runaway back; this means the arithmetic is not
    /// quietly allowed to drift just because nothing catastrophic happens when it does.
    @MainActor
    func testShouldNeverComeBackTallerThanItsCeiling() {
        let sky = SkyPreparer(now: ConstellationFixture.now)
            .prepare(.fixture, size: phone, chrome: .phone)
        let wordiest = sky.stars.first { $0.id == "memory.dad.workshop" }!

        let window = UIWindow(frame: CGRect(origin: .zero, size: phone))

        for ceiling in [200.0, 300.0, ConstellationBand.tallestCard(in: phone, chrome: .phone)] {
            var measured: CGFloat = 0
            let host = UIHostingController(
                rootView: ConstellationCard(
                    subject: .star(wordiest),
                    ceiling: ceiling,
                    onHeight: { measured = $0 }
                )
                // Bounded the way the screen bounds it, and then offered a whole screen to
                // grow into — so a card that ignores its ceiling has somewhere to do it and
                // this measures the card rather than the clamp around it.
                .frame(maxHeight: ceiling, alignment: .bottom)
                .frame(width: 369, height: phone.height, alignment: .bottom)
                .environment(\.colorScheme, .dark))

            window.rootViewController = host
            window.isHidden = false
            window.layoutIfNeeded()
            host.view.setNeedsLayout()
            window.layoutIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))

            XCTAssertGreaterThan(measured, 0, "the card was never measured at \(ceiling)")
            XCTAssertLessThanOrEqual(
                measured, ceiling,
                "a card given a ceiling of \(ceiling) came back \(measured) tall")
        }

        window.rootViewController = nil
        window.isHidden = true
    }
}
