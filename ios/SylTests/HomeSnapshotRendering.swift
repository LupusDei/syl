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

        let cases: [(String, HomeSnapshot, PresenceState, ColorScheme)] = [
            ("full-day-thinking", .preview(remaining: 5), .thinking, .light),
            ("clear-day-idle", clear, .idle, .light),
            ("late-alert", .preview(remaining: 2, late: true), .alert, .light),
            ("clear-day-night", clear, .idle, .dark),
            ("full-day-night", .preview(remaining: 5), .concerned, .dark),
        ]

        for (name, snapshot, presence, scheme) in cases {
            let view = HomeView(
                snapshot: snapshot,
                presence: presence,
                presenceIntensity: 0.8,
                now: fixedNoon,
                scrolls: false
            )
            .frame(width: 393, height: 852)   // iPhone 17 logical size
            .environment(\.colorScheme, scheme)

            let renderer = ImageRenderer(content: view)
            renderer.scale = 2

            guard let image = renderer.uiImage, let data = image.pngData() else {
                XCTFail("could not render \(name)")
                continue
            }

            try data.write(to: directory.appendingPathComponent("\(name).png"))
        }
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
