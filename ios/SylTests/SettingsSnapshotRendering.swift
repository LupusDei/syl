import SwiftUI
import XCTest

@testable import Syl

/// Renders the appearance control to PNGs so a human can look at it.
///
/// Same contract as ``HomeSnapshotRendering``: gated on `SYL_RENDER_SNAPSHOTS`, never
/// asserts on pixels, only ever produces images. See that file for how to turn it on and
/// where the files land.
///
/// The control gets its own harness because the one thing that cannot be reasoned about
/// is whether the *unselected* segments stay legible next to the selected one, in both
/// appearances, against a list row whose background this control does not own. That is a
/// contrast judgement, and a contrast judgement is made by looking.
///
/// It renders the control rather than the whole Settings screen deliberately. The harness
/// lays out nothing inside a `ScrollView` or a `NavigationStack`, and `ContentView` is
/// both — rendering it produces an empty page that proves nothing.
@MainActor
final class SettingsSnapshotRendering: XCTestCase {
    private var enabled: Bool {
        ProcessInfo.processInfo.environment["SYL_RENDER_SNAPSHOTS"] != nil
    }

    private var outputDirectory: URL? {
        FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("design-snapshots", isDirectory: true)
    }

    func testRenderTheAppearanceControl() throws {
        try XCTSkipUnless(enabled, "set SYL_RENDER_SNAPSHOTS=1 to produce design images")
        let directory = try XCTUnwrap(outputDirectory)

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        print("SYL_SNAPSHOTS_AT \(directory.path)")

        // Every state in both appearances, because "legible in all three states" is six
        // pictures, not three — an unselected segment that vanishes at night is exactly
        // the failure a single render would miss.
        for scheme in [ColorScheme.light, .dark] {
            for choice in AppearanceChoice.allCases {
                let view = VStack(alignment: .leading, spacing: SylTheme.Metric.step) {
                    Text("Appearance")
                        .sylLabelStyle()
                        .foregroundStyle(SylTheme.Colour.inkFaint)

                    AppearanceControl(choice: .constant(choice))

                    Text(choice.explanation)
                        .font(SylTheme.Typeface.detail)
                        .foregroundStyle(SylTheme.Colour.inkFaint)
                }
                .padding(SylTheme.Metric.gutter)
                .frame(width: 393, alignment: .leading)
                // A plain veil stands in for the list row: it is the ground every other
                // Syl surface sits on, and the control has to hold up against it.
                .background(SylTheme.Colour.veil)
                .environment(\.colorScheme, scheme)

                let renderer = ImageRenderer(content: view)
                renderer.scale = 2

                let name = "appearance-control-\(choice.rawValue)-\(scheme == .dark ? "night" : "day")"
                guard let image = renderer.uiImage, let data = image.pngData() else {
                    XCTFail("could not render \(name)")
                    continue
                }

                try data.write(to: directory.appendingPathComponent("\(name).png"))
            }
        }
    }
}
