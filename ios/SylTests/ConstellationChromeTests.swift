import CoreGraphics
import XCTest

@testable import Syl

/// **Everything he can see must be on the glass, and nothing may hide under the furniture.**
///
/// The screen is drawn edge to edge and lived in inside the safe area, and until 2026-08-11
/// nothing in this feature knew there was a difference. `ConstellationLayout` inset the field
/// by 104 and 72 — a navigation bar and a home indicator, measured before this screen was in
/// a tab bar. A tab bar takes 83 points. So the lowest star in the field was drawn beneath it,
/// and `ConstellationBand` had the mirror image of the same hole: it put the card's top edge
/// at `size.height − cardHeight − step`, measuring from the bottom of the glass, while the
/// card actually sits above the tab bar.
///
/// Both are correspondence checks: they compare the sky to the rectangle it is really drawn
/// on, which is a thing outside the sky. A test that asked the layout where it had put its
/// insets would agree with itself forever.
final class ConstellationChromeTests: XCTestCase {

    private let phone = CGSize(width: 393, height: 852)
    private let chrome = ConstellationChrome.phone

    private var sky: PreparedSky {
        SkyPreparer(now: ConstellationFixture.now)
            .prepare(.hubAndSpokes, size: phone, chrome: chrome)
    }

    // MARK: - Stars

    /// **No star under the tab bar.** The one the Commander could see, in his own screenshot:
    /// a star clipped by the bar at the foot of the screen.
    ///
    /// Measured against the star as *drawn* — its core, plus the furthest its hover can carry
    /// it — rather than against its anchor, because a point of light three points across that
    /// straddles the edge is still clipped.
    func testShouldKeepEveryStarClearOfTheTabBar() {
        let floor = phone.height - chrome.bottom

        for star in sky.stars {
            let reach = star.coreRadius + ConstellationMotion.bound(depth: star.depth)
            XCTAssertLessThan(
                star.anchor.y + reach, floor,
                "\(star.id) is drawn under the tab bar, at \(star.anchor.y) of \(floor)")
        }
    }

    /// And none behind the navigation bar, which is the same defect the other way up.
    func testShouldKeepEveryStarClearOfTheNavigationBar() {
        for star in sky.stars {
            let reach = star.coreRadius + ConstellationMotion.bound(depth: star.depth)
            XCTAssertGreaterThan(
                star.anchor.y - reach, chrome.top,
                "\(star.id) is drawn behind the navigation bar, at \(star.anchor.y)")
        }
    }

    /// And none off the sides. A sky that runs off the glass is a sky he cannot see the whole
    /// of, which is the one thing deterministic layout is for.
    func testShouldKeepEveryStarOnTheGlass() {
        for star in sky.stars {
            XCTAssertTrue(
                (0...phone.width).contains(star.anchor.x)
                    && (0...phone.height).contains(star.anchor.y),
                "\(star.id) is off the glass at \(star.anchor)")
        }
    }

    // MARK: - The card

    /// **The card's top edge is where the card's top edge actually is.**
    ///
    /// It sits a step above the safe area's foot, not a step above the glass's, and those
    /// differ by the whole height of a tab bar. When they disagreed the sky panned a
    /// selection to a line it believed was clear and the card came up over it — which is
    /// exactly the photograph he sent: the card describing the hub, sitting on the hub.
    func testShouldPlaceTheCardsEdgeAboveTheTabBar() {
        let height: CGFloat = 300
        let top = ConstellationBand.cardTop(forCardOf: height, in: phone, chrome: chrome)

        XCTAssertEqual(
            top + height + SylTheme.Metric.step,
            phone.height - chrome.bottom,
            accuracy: 0.01,
            "the card's foot is a step above the tab bar, not a step above the glass")
    }

    /// The whole card is on screen, above the tab bar, at every height up to the ceiling.
    func testShouldKeepTheWholeCardOnScreen() {
        let ceiling = ConstellationBand.tallestCard(in: phone, chrome: chrome)

        for height in stride(from: 120.0, through: Double(ceiling), by: 20) {
            let top = ConstellationBand.cardTop(
                forCardOf: CGFloat(height), in: phone, chrome: chrome)
            XCTAssertGreaterThan(top, chrome.top, "a card of \(height) reaches the title")
            XCTAssertLessThan(
                top + CGFloat(height), phone.height - chrome.bottom,
                "a card of \(height) runs under the tab bar")
        }
    }

    /// **The ceiling still buys what it exists to buy.**
    ///
    /// The bound on wandering means the deepest a star can ever be brought is the middle of
    /// the glass, so a card whose top edge falls below that centre covers memories that can
    /// never be got out from under it however far he drags. The tab bar makes the card *taller
    /// relative to the space above it*, so this had to be re-derived rather than assumed.
    func testShouldNeverAllowACardTallerThanTheSkyCanClear() {
        let ceiling = ConstellationBand.tallestCard(in: phone, chrome: chrome)
        let top = ConstellationBand.cardTop(forCardOf: ceiling, in: phone, chrome: chrome)

        XCTAssertGreaterThanOrEqual(
            top, phone.height / 2,
            "the tallest card must leave its top edge at or above the middle of the glass")
    }

    // MARK: - The reveal

    /// **A card must never cover the thing it describes.** Every star, one at a time.
    ///
    /// Swept rather than sampled: the failure this replaces was invisible at ordinary text
    /// sizes and arrived as *the card covers the star sometimes, for some stars*.
    ///
    /// **The covered line is computed here rather than asked for**, and that is not
    /// duplication. Reading it back out of ``ConstellationBand/cardTop(forCardOf:in:chrome:)``
    /// would compare the sky to the same arithmetic that positioned it — so removing the
    /// chrome from that function moved *both* sides and the test stayed green while the card
    /// sat on the star. Measured against where the card's foot actually is instead: a step
    /// above the tab bar, which is a fact about the screen and not about this file.
    func testShouldClearEveryStarFromUnderTheCard() {
        let sky = self.sky
        let cardHeight: CGFloat = 300
        let covered =
            sky.size.height - ConstellationChrome.phone.bottom - SylTheme.Metric.step - cardHeight

        for star in sky.stars {
            let revealed = ConstellationTransform.identity.revealing(
                star.anchor,
                between: ConstellationBand.headroom(sky.chrome),
                and: ConstellationBand.skyline(
                    forCardOf: cardHeight, in: sky.size, chrome: sky.chrome),
                within: sky.contentBounds,
                viewSize: sky.size)

            XCTAssertLessThan(
                revealed.apply(star.anchor).y, covered,
                "\(star.id) is still under the card after the sky made room for it")
        }
    }
}
