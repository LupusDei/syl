import SwiftUI
import SylKit
import XCTest

@testable import Syl

/// Renders the list to PNGs so a human can look at it.
///
/// ## Why this exists
///
/// A design that has only been reasoned about has not been checked. `xcodebuild` will
/// happily report a green suite for a screen whose type is illegible, whose contrast
/// fails, or whose glass renders as a grey slab. None of those are assertions anyone
/// writes, and all of them are obvious in one glance at an image. The equivalent harness
/// found three real defects in `syl-008`.
///
/// Deliberately **not** a snapshot-comparison test: pinning rendered pixels against a
/// stored reference is how a design system acquires a hundred failing tests the first
/// time someone nudges a corner radius, and the failures carry no information. This only
/// ever *produces* images.
///
/// ## Opt-in, and how to actually turn it on
///
/// A shell variable will not work — `xcodebuild` is a different process on a different
/// machine from the test, and the simulator does not inherit its environment. Pass it
/// through the test runner instead:
///
/// ```sh
/// xcodebuild test -scheme Syl -destination '…' \
///   TEST_RUNNER_SYL_RENDER_SNAPSHOTS=1 \
///   -only-testing:SylTests/TodoListSnapshotRendering
/// open "$(xcrun simctl get_app_container booted com.jmm.syl data)/Documents/design-snapshots"
/// ```
@MainActor
final class TodoListSnapshotRendering: XCTestCase {
    private var enabled: Bool {
        // Both spellings. `xcodebuild test TEST_RUNNER_FOO=1` is meant to forward `FOO` to
        // the runner with the prefix stripped; on this toolchain it forwards nothing at
        // all — verified by printing every SYL-matching key the runner could see, which
        // was an empty list. The scheme is what works; see `Syl.xcscheme`. The unstripped
        // spelling is accepted anyway so that a future Xcode fixing this makes the
        // command line start working rather than silently continuing to skip.
        let environment = ProcessInfo.processInfo.environment
        return environment["SYL_RENDER_SNAPSHOTS"] != nil
            || environment["TEST_RUNNER_SYL_RENDER_SNAPSHOTS"] != nil
    }

    /// The app's own Documents directory. Not a repository path: a simulator process is
    /// sandboxed to its container and cannot write into the checkout.
    private var outputDirectory: URL? {
        FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("design-snapshots", isDirectory: true)
    }

    func testRenderTheList() throws {
        try XCTSkipUnless(enabled, "set SYL_RENDER_SNAPSHOTS=1 to produce design images")
        let directory = try XCTUnwrap(outputDirectory)

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        print("SYL_SNAPSHOTS_AT \(directory.path)")

        // Full and empty, in both appearances. The empty one matters most: it is the
        // state every other to-do app renders as a void with grey text in the middle, and
        // the one this app is supposed to make beautiful.
        let cases: [(String, TodoListSnapshot, ColorScheme)] = [
            ("list-full-day", full, .light),
            ("list-full-night", full, .dark),
            ("list-clear-day", TodoListSnapshot(), .light),
            ("list-clear-night", TodoListSnapshot(), .dark),
            ("list-truncated-night", truncated, .dark),
        ]

        for (name, snapshot, scheme) in cases {
            let view = TodoListView(snapshot: snapshot, onClose: {}, scrolls: false)
                .frame(width: 393, height: 852)   // iPhone 17 logical size
                .environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, .large)

            let renderer = ImageRenderer(content: view)
            renderer.scale = 2

            guard let image = renderer.uiImage, let data = image.pngData() else {
                XCTFail("could not render \(name)")
                continue
            }
            try data.write(to: directory.appendingPathComponent("\(name).png"))
        }

        // The largest accessibility size, which is NFR3 and is where a two-column caption
        // or a fixed column height stops working. Rendered tall so the rows that get
        // pushed off a phone-height frame are still visible in the image — the point is to
        // see whether the layout survives, not to see where it is cut off.
        let huge = TodoListView(snapshot: full, onClose: {}, scrolls: false)
            .frame(width: 393, height: 2000)
            .environment(\.colorScheme, .dark)
            .environment(\.dynamicTypeSize, .accessibility5)

        let hugeRenderer = ImageRenderer(content: huge)
        hugeRenderer.scale = 1
        if let image = hugeRenderer.uiImage, let data = image.pngData() {
            try data.write(to: directory.appendingPathComponent("list-ax5-night.png"))
        } else {
            XCTFail("could not render list-ax5-night")
        }
    }

    /// The foot of the day — the capture field and the door — on its own.
    ///
    /// **Not through `HomeView`, and that was learned the hard way.** The hero is sized to
    /// one whole screen of its container, so an offscreen pass draws the hero at whatever
    /// height it is given and clips the day beneath it. Rendering the home screen at
    /// 852pt produced the hero; rendering it at 1800pt produced a taller hero. The day has
    /// never appeared in a whole-screen render and cannot. `FootOfDay` exists partly so
    /// this image can exist.
    func testRenderTheFootOfTheDay() throws {
        try XCTSkipUnless(enabled, "set SYL_RENDER_SNAPSHOTS=1 to produce design images")
        let directory = try XCTUnwrap(outputDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let cases: [(String, Int, ColorScheme)] = [
            ("foot-of-day-night", 7, .dark),
            ("foot-of-day-day", 7, .light),
            // The quiet case: nothing behind the door, so no number on it.
            ("foot-of-day-empty-night", 0, .dark),
        ]

        for (name, elsewhere, scheme) in cases {
            let view = ZStack {
                SylTheme.Veil()
                FootOfDay(openElsewhere: elsewhere)
                    .padding(SylTheme.Metric.gutter)
            }
            .frame(width: 393, height: 220)
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

    private var full: TodoListSnapshot {
        .preview(now: fixedMorning, calendar: chicago)
    }

    /// The honest end of a windowed page.
    private var truncated: TodoListSnapshot {
        let page = full
        return TodoListSnapshot(sections: page.sections, openCount: 512, hasMore: true)
    }

    private var chicago: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        return calendar
    }

    /// A fixed instant so the rows never render a different date between runs.
    private var fixedMorning: Date {
        (try? Instant.parse("2026-08-10T15:00:00Z")) ?? Date()
    }
}
