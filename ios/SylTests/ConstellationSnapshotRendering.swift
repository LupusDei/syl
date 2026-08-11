import SwiftUI
import XCTest

@testable import Syl

/// Renders the sky to PNGs so a human can look at it.
///
/// **On this feature the render is not a supplement to the tests. It is the check.** The
/// Commander decided the constellation personally and set the bar himself — *"What I want
/// for the app is beauty"* — and beauty cannot be settled by a green suite. Everything the
/// suite can settle is in `ConstellationLayoutTests` and `ConstellationMotionTests`; what
/// is left is whether it is worth looking at, and the only way to know is to look.
///
/// Same contract as the other harnesses: this only ever *produces* images and never fails
/// on them, because pinning rendered pixels is how a design system acquires a hundred
/// uninformative failures the first time somebody nudges a radius.
///
/// **A shell variable will not work, and neither will `TEST_RUNNER_`.** Both were tried and
/// both silently skip. Tick `SYL_RENDER_SNAPSHOTS` in the shared scheme
/// (`Syl.xcscheme` ▸ LaunchAction ▸ EnvironmentVariables ▸ `isEnabled = "YES"`), run, then
///
/// ```sh
/// open "$(xcrun simctl get_app_container booted com.jmm.syl data)/Documents/design-snapshots"
/// ```
@MainActor
final class ConstellationSnapshotRendering: XCTestCase {
    private var enabled: Bool {
        ProcessInfo.processInfo.environment["SYL_RENDER_SNAPSHOTS"] != nil
    }

    private var outputDirectory: URL? {
        FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("design-snapshots", isDirectory: true)
    }

    private let phone = CGSize(width: 393, height: 852)

    func testRenderTheSky() throws {
        try XCTSkipUnless(enabled, "set SYL_RENDER_SNAPSHOTS=1 to produce design images")
        let directory = try XCTUnwrap(outputDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        print("SYL_SNAPSHOTS_AT \(directory.path)")

        let sky = SkyPreparer(now: ConstellationFixture.now).prepare(.fixture, size: phone)

        for scheme in [ColorScheme.dark, .light] {
            let suffix = scheme == .dark ? "night" : "day"

            // The sky as it is, a few seconds into the hover.
            try render(
                ConstellationView(sky: sky, time: .frozen(6.4)),
                named: "sky-\(suffix)", scheme: scheme, in: directory)

            // **Reduce Motion, and this is the one to compare against the one above.** If
            // the still reads as a broken version of the sky rather than as the same sky,
            // the motion was carrying meaning it should not have been.
            try render(
                ConstellationView(sky: sky, time: .pinned),
                named: "sky-still-\(suffix)", scheme: scheme, in: directory)

            // Nothing learned yet. It has to read as a statement, not as a failed load.
            try render(
                ConstellationView(sky: .empty),
                named: "sky-nothing-\(suffix)", scheme: scheme, in: directory)
        }

        // Two frames a long way apart in time, at night. Flick between them and the drift
        // should be a hover — a couple of points, not a rearrangement. If a star has
        // travelled somewhere between these two images, the bound is a lie.
        for (name, t) in [("sky-drift-a", 0.0), ("sky-drift-b", 137.5)] {
            try render(
                ConstellationView(sky: sky, time: .frozen(t)),
                named: name, scheme: .dark, in: directory)
        }
    }

    // MARK: - Rendering

    private func render(
        _ view: some View,
        named name: String,
        scheme: ColorScheme,
        in directory: URL
    ) throws {
        // **No `NavigationStack`.** `ImageRenderer` has no navigation host and renders one
        // as SwiftUI's yellow "cannot draw this" placeholder — recorded by
        // `GoalSnapshotRendering` after every image in its first run came back yellow. The
        // toolbar title is therefore absent from these images and present on the device;
        // what is being looked at here is the sky.
        let hosted = view
            .frame(width: phone.width, height: phone.height)
            .environment(\.colorScheme, scheme)

        let renderer = ImageRenderer(content: hosted)
        renderer.scale = 2

        guard let image = renderer.uiImage, let data = image.pngData() else {
            XCTFail("could not render \(name)")
            return
        }

        try data.write(to: directory.appendingPathComponent("\(name).png"))
    }
}
