import SwiftUI
import UIKit
import XCTest

@testable import Syl

/// The appearance control: `System | Day | Night`, and what each one means.
///
/// ## Why this is tested at all, given it is "just a setting"
///
/// The defect it fixes was invisible to every test in the suite and obvious the moment
/// the Commander set iOS to Light: chat went bright, Home stayed black, and the app
/// stopped being one product. Nothing asserted the relationship between the two, because
/// the two screens resolved their appearance by different routes — chat from the
/// environment, Home from a hard-coded `.dark`.
///
/// So what is pinned here is the *resolution rule*, not the pixels. Every case below is
/// a pure function of (choice, is a scene bundled, what iOS says), which is exactly the
/// triple that produced the bug.
final class AppearanceTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "syl.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    // MARK: - What each choice resolves to

    /// `nil` is the whole of "System". Anything else — including guessing the current
    /// trait and passing it back — pins the window and stops it following iOS.
    @MainActor
    func testShouldAskForNoParticularSchemeWhenTheChoiceIsSystem() {
        XCTAssertNil(AppearanceChoice.system.preferredColorScheme)
    }

    @MainActor
    func testShouldResolveDayToLight() {
        XCTAssertEqual(AppearanceChoice.day.preferredColorScheme, .light)
    }

    @MainActor
    func testShouldResolveNightToDark() {
        XCTAssertEqual(AppearanceChoice.night.preferredColorScheme, .dark)
    }

    /// Three choices, three distinct spoken names. VoiceOver reads the title, so a
    /// duplicate or an empty one is an unusable control rather than a cosmetic slip.
    @MainActor
    func testShouldGiveEveryChoiceItsOwnSpokenName() {
        let titles = AppearanceChoice.allCases.map(\.title)

        XCTAssertEqual(AppearanceChoice.allCases.count, 3)
        XCTAssertEqual(Set(titles).count, titles.count)
        XCTAssertFalse(titles.contains(where: \.isEmpty))
    }

    // MARK: - Persistence

    /// The default has to be System. A view that never receives the injection, or a
    /// first launch, must follow iOS rather than force anything.
    @MainActor
    func testShouldStartOnSystemWhenNothingHasEverBeenChosen() {
        let store = AppearanceStore(defaults: defaults)

        XCTAssertEqual(store.choice, .system)
    }

    @MainActor
    func testShouldPersistTheChoiceAcrossARelaunch() {
        let first = AppearanceStore(defaults: defaults)
        first.choice = .day

        let second = AppearanceStore(defaults: defaults)

        XCTAssertEqual(second.choice, .day)
    }

    /// A value written by a future build, or a corrupted plist, must not brick the
    /// screen. Falling back to System is the one answer that is never wrong.
    @MainActor
    func testShouldFallBackToSystemWhenTheStoredValueIsNotAChoice() {
        defaults.set("twilight", forKey: AppearanceStore.choiceKey)

        XCTAssertEqual(AppearanceStore(defaults: defaults).choice, .system)
    }

    /// Nothing else in the app reads this key, so the test exists to stop it being
    /// renamed silently — a renamed key is a preference that quietly resets itself.
    @MainActor
    func testShouldWriteTheChoiceThroughUnderAStableKey() {
        let store = AppearanceStore(defaults: defaults)

        store.choice = .night

        XCTAssertEqual(defaults.string(forKey: AppearanceStore.choiceKey), "night")
    }

    /// The environment default. A view that is rendered without `RootView` above it —
    /// a preview, the snapshot harness, a test — sees System.
    @MainActor
    func testShouldDefaultTheEnvironmentToSystem() {
        XCTAssertEqual(EnvironmentValues().sylAppearance, .system)
    }

    // MARK: - What the home screen does with it

    /// The original rule, kept intact: the scene is painted on a starfield, so with
    /// clips bundled and no explicit choice, Home is night in both system appearances.
    @MainActor
    func testShouldKeepHomeAtNightWhenTheChoiceIsSystemAndASceneIsBundled() {
        XCTAssertEqual(
            HomeView.scheme(for: .system, sceneIsPresent: true, system: .light),
            .dark
        )
        XCTAssertEqual(
            HomeView.scheme(for: .system, sceneIsPresent: true, system: .dark),
            .dark
        )
    }

    /// With no scene bundled there is no starfield to protect, so System means System.
    @MainActor
    func testShouldLetHomeFollowTheSystemWhenNoSceneIsBundled() {
        XCTAssertEqual(
            HomeView.scheme(for: .system, sceneIsPresent: false, system: .light),
            .light
        )
        XCTAssertEqual(
            HomeView.scheme(for: .system, sceneIsPresent: false, system: .dark),
            .dark
        )
    }

    /// The defect, stated as a test. An explicit Day beats the scene — otherwise Home
    /// is the one screen in the app that ignores him.
    @MainActor
    func testShouldHonourAnExplicitDayOnHomeEvenWithASceneBundled() {
        XCTAssertEqual(
            HomeView.scheme(for: .day, sceneIsPresent: true, system: .dark),
            .light
        )
    }

    /// And the mirror: an explicit Night while iOS is light.
    @MainActor
    func testShouldHonourAnExplicitNightOnHomeWhileIOSIsLight() {
        XCTAssertEqual(
            HomeView.scheme(for: .night, sceneIsPresent: false, system: .light),
            .dark
        )
    }

    // MARK: - The scene follows the resolved appearance, not the setting

    /// The acceptance scenario in the spec: in Day the scene falls back to the still,
    /// rather than putting a starfield in a bright frame.
    ///
    /// Expressed against the *resolved* appearance rather than the choice, because that
    /// is the quantity that is actually true of the frame the clip would be drawn in —
    /// and it stays correct if the appearance ever arrives by some other route.
    @MainActor
    func testShouldShowTheStillRatherThanAStarfieldInADayFrame() {
        XCTAssertFalse(SceneCatalogue.shouldPlay(reduceMotion: false, appearance: .light))
    }

    @MainActor
    func testShouldPlayTheSceneWhenTheFrameIsNight() throws {
        try XCTSkipIf(
            ProcessInfo.processInfo.isLowPowerModeEnabled,
            "Low Power Mode legitimately suppresses the scene"
        )
        XCTAssertFalse(SceneCatalogue.clips.isEmpty, "no scene clips are bundled")

        XCTAssertTrue(SceneCatalogue.shouldPlay(reduceMotion: false, appearance: .dark))
    }

    /// Reduce Motion still wins over the appearance. Adding a second reason to fall back
    /// must not remove the first one.
    @MainActor
    func testShouldStillHonourReduceMotionAtNight() {
        XCTAssertFalse(SceneCatalogue.shouldPlay(reduceMotion: true, appearance: .dark))
    }

    // MARK: - The control itself

    /// 44pt is a floor, and a segmented control is exactly where it gets lost: three
    /// short words in a row will happily lay out at 20pt tall and look completely fine
    /// in a screenshot.
    ///
    /// Measured through a real host rather than by reading the modifier back, so a
    /// padding change or a nested frame that shrinks the segments is caught.
    @MainActor
    func testShouldGiveEverySegmentAtLeastTheMinimumTouchTarget() {
        let width: CGFloat = 320
        let host = UIHostingController(rootView: AppearanceControl(choice: .constant(.system)))
        let size = host.sizeThatFits(
            in: CGSize(width: width, height: .greatestFiniteMagnitude)
        )

        // The control pads its track around the segments, so the segments themselves are
        // the measured height less that padding on each side. That is the number the
        // finger actually gets.
        let segmentHeight = size.height - 2 * SylTheme.Metric.tight

        XCTAssertGreaterThanOrEqual(
            segmentHeight,
            SylTheme.Metric.minimumTouchTarget,
            "a segment measured \(segmentHeight)pt, under the 44pt floor"
        )
    }
}
