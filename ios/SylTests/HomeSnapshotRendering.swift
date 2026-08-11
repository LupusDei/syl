import XCTest
import SwiftUI
import SylKit

@testable import Syl

/// Renders the home screen to PNGs so a human can look at it.
///
/// ## Why this exists
///
/// A design that has only been reasoned about has not been checked. `xcodebuild` will
/// happily report a green suite for a screen whose type is illegible, whose contrast
/// fails, or whose glass renders as a grey slab — none of those are assertions anyone
/// writes, and all of them are obvious in one glance at an image.
///
/// This is deliberately **not** a snapshot-comparison test. Pinning rendered pixels
/// against a stored reference is how a design system acquires a hundred failing tests
/// the first time someone nudges a corner radius, and the failures carry no
/// information. This only ever *produces* images; it never fails on them.
///
/// ## Opt-in, and how to actually turn it on
///
/// Gated on `SYL_RENDER_SNAPSHOTS`, so a normal run neither writes files nor pays the
/// render cost.
///
/// **A shell variable will not work.** `SYL_RENDER_SNAPSHOTS=1 xcodebuild test …` sets
/// it on `xcodebuild`, which is a different process on a different machine from the
/// test, and the simulator does not inherit it. Verified: the test skipped. Set it in
/// the scheme instead — *Product ▸ Scheme ▸ Edit Scheme ▸ Test ▸ Arguments ▸
/// Environment Variables* — or flip ``enabled`` to `true` for a one-off run from the
/// command line.
///
/// Images are written to the app's Documents directory in the simulator. Retrieve them
/// with:
///
/// ```sh
/// open "$(xcrun simctl get_app_container booted com.jmm.syl data)/Documents/design-snapshots"
/// ```
@MainActor
final class HomeSnapshotRendering: XCTestCase {
    private var enabled: Bool {
        ProcessInfo.processInfo.environment["SYL_RENDER_SNAPSHOTS"] != nil
    }

    /// The app's own Documents directory.
    ///
    /// Not a repository path: a simulator process is sandboxed to its container and
    /// cannot write into the checkout. Retrieve the images afterwards with
    /// `xcrun simctl get_app_container booted com.jmm.syl data`.
    private var outputDirectory: URL? {
        FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("design-snapshots", isDirectory: true)
    }

    func testRenderTheHomeScreen() throws {
        try XCTSkipUnless(enabled, "set SYL_RENDER_SNAPSHOTS=1 to produce design images")
        let directory = try XCTUnwrap(outputDirectory)

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        print("SYL_SNAPSHOTS_AT \(directory.path)")

        // The fourth column is what *iOS* says; the fifth is what the Commander chose.
        // Both are needed, and the pairs that disagree are the interesting ones: with
        // clips bundled, System renders night whatever iOS says, and an explicit Day has
        // to beat both. `appearance-day-*` is the render US5 exists to make correct —
        // look at it for a starfield in a bright frame.
        let cases: [(String, HomeSnapshot, PresenceState, ColorScheme, AppearanceChoice)] = [
            ("full-day-thinking", .preview(remaining: 5), .thinking, .light, .system),
            ("clear-day-idle", clear, .idle, .light, .system),
            ("late-alert", .preview(remaining: 2, late: true), .alert, .light, .system),
            ("clear-day-night", clear, .idle, .dark, .system),
            ("full-day-night", .preview(remaining: 5), .concerned, .dark, .system),
            ("appearance-day", .preview(remaining: 5), .thinking, .dark, .day),
            ("appearance-day-clear", clear, .idle, .light, .day),
            ("appearance-night", .preview(remaining: 5), .thinking, .light, .night),
        ]

        for (name, snapshot, presence, scheme, appearance) in cases {
            let view = HomeView(
                snapshot: snapshot,
                presence: presence,
                presenceIntensity: 0.8,
                now: fixedNoon,
                scrolls: false
            )
            .frame(width: 393, height: 852)   // iPhone 17 logical size
            .environment(\.colorScheme, scheme)
            .environment(\.sylAppearance, appearance)

            let renderer = ImageRenderer(content: view)
            renderer.scale = 2

            guard let image = renderer.uiImage, let data = image.pngData() else {
                XCTFail("could not render \(name)")
                continue
            }

            try data.write(to: directory.appendingPathComponent("\(name).png"))
        }
    }

    /// The day's spine on its own, in every state a tap can put a row into.
    ///
    /// Rendered apart from `HomeView` on purpose. The hero is sized to one whole screen,
    /// so in an 852pt frame the day begins exactly at the bottom edge and the full-screen
    /// renders show none of it — which is fine for judging *her* and useless for judging
    /// a row. This frames the thing that changed.
    ///
    /// What to look for: the deferred row must show its **original** time and no new one;
    /// the refused row must be the only warm thing in the frame; and the completed row
    /// must still be legible while it is struck through, in both appearances.
    func testRenderTheDayStates() throws {
        try XCTSkipUnless(enabled, "set SYL_RENDER_SNAPSHOTS=1 to produce design images")
        let directory = try XCTUnwrap(outputDirectory)

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let cases: [(String, ColorScheme, DynamicTypeSize)] = [
            ("day-states-light", .light, .large),
            ("day-states-night", .dark, .large),
            ("day-states-night-ax3", .dark, .accessibility3),
        ]

        for (name, scheme, typeSize) in cases {
            // Top-aligned. A row's thread segment is greedy (`maxHeight: .infinity`) so
            // in a frame taller than the content every row stretches and the spacing
            // reads as a design decision it is not. On the device the spine is inside a
            // scroll view and takes its natural height; this reproduces that.
            let view = ZStack {
                SylTheme.Veil()
                VStack(spacing: 0) {
                    DaySpine(moments: actedOn, now: fixedNoon)
                    Spacer(minLength: 0)
                }
                .padding(SylTheme.Metric.gutter)
            }
            // Tall enough that nothing is compressed. `ImageRenderer` has no scroll view,
            // so a frame shorter than the content does not clip — the stack squeezes and
            // rows draw over one another, which looks like a layout defect and is not one.
            .frame(width: 393, height: typeSize.isAccessibilitySize ? 2400 : 620)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, typeSize)

            let renderer = ImageRenderer(content: view)
            renderer.scale = 2

            guard let image = renderer.uiImage, let data = image.pngData() else {
                XCTFail("could not render \(name)")
                continue
            }
            try data.write(to: directory.appendingPathComponent("\(name).png"))
        }
    }

    /// One of each: settled, in flight, refused, and two ordinary rows for contrast.
    private var actedOn: [DayMoment] {
        func at(_ hour: Int, _ minute: Int) -> Date {
            Calendar(identifier: .gregorian)
                .date(from: DateComponents(year: 2026, month: 8, day: 10, hour: hour, minute: minute))
                ?? .now
        }

        return [
            DayMoment(
                id: "done", title: "Morning light — gratitude and breath", at: at(7, 0),
                standing: .done, origin: .reminder, urgent: false, late: false, pinned: false
            ),
            // A reminder with nothing asked of it yet: the only row that shows both
            // controls, and the reason it is here. Every other row hides one of them for
            // a different reason, so without this the render would never show Later.
            DayMoment(
                id: "open", title: "Call the roofer back about the north valley flashing",
                at: at(9, 30), standing: .due, origin: .reminder,
                urgent: true, late: false, pinned: false
            ),
            DayMoment(
                id: "deferred", title: "Collect the prescription",
                at: at(11, 0), standing: .upcoming, origin: .reminder,
                urgent: false, late: false, pinned: false,
                deferralAskedAt: at(9, 41)
            ),
            DayMoment(
                id: "refused", title: "Book the dentist", at: nil,
                standing: .upcoming, origin: .todo, urgent: false, late: false, pinned: true,
                refusal: "Already finished"
            ),
            DayMoment(
                id: "plain", title: "Create and flow — art, writing or music", at: at(14, 0),
                standing: .upcoming, origin: .todo, urgent: false, late: false, pinned: false
            ),
        ]
    }

    private var clear: HomeSnapshot {
        HomeSnapshot(moments: [], remaining: 0, note: nil, prominence: 1, greeting: "Good evening")
    }

    /// A fixed instant so the header never renders a different date between runs.
    private var fixedNoon: Date {
        var components = DateComponents()
        components.year = 2026
        components.month = 8
        components.day = 10
        components.hour = 9
        components.minute = 41
        return Calendar(identifier: .gregorian).date(from: components) ?? Date()
    }
}
