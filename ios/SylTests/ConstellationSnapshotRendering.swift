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

    /// **The chrome the device really has.** A render without it is a picture of a pleasanter
    /// rectangle than the one he is holding — and the two defects he photographed on
    /// 2026-08-11, a star under the tab bar and a card over the star it described, were both
    /// invisible in every image this harness had produced until it was told about the bars.
    private let chrome = ConstellationChrome.phone

    func testRenderTheSky() throws {
        try XCTSkipUnless(enabled, "set SYL_RENDER_SNAPSHOTS=1 to produce design images")
        let directory = try XCTUnwrap(outputDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        print("SYL_SNAPSHOTS_AT \(directory.path)")

        try renderHisSky(into: directory)

        let sky = SkyPreparer(now: ConstellationFixture.now)
            .prepare(.fixture, size: phone, chrome: chrome)

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

        // MARK: - Touched

        // **The two pictures phase 4 is accepted on.**
        //
        // A card is not a state a render can tap its way into, so the selection is handed
        // in — and the transform that pans it clear is computed by the *same* pure function
        // the device calls when the card reports its height. What comes out is therefore
        // the picture the phone draws, not an approximation of it: if the sky here has not
        // moved the selection out from under the card, it does not on the device either.
        for scheme in [ColorScheme.dark, .light] {
            let suffix = scheme == .dark ? "night" : "day"

            if let star = sky.stars.first(where: { $0.id == "memory.dad.workshop" }) {
                try render(
                    ConstellationView(
                        sky: sky, time: .frozen(6.4),
                        opensWith: .star(star.id),
                        opensAt: clearing(star.anchor, in: sky)),
                    named: "sky-star-\(suffix)", scheme: scheme, in: directory)
            }

            if let filament = sky.filaments.first(where: { $0.id == "e.kate.mandarin" }) {
                try render(
                    ConstellationView(
                        sky: sky, time: .frozen(6.4),
                        opensWith: .filament(filament.id),
                        opensAt: clearing(lowestPoint(of: filament), in: sky)),
                    named: "sky-filament-\(suffix)", scheme: scheme, in: directory)
            }
        }

        // An observed thread, for the comparison that matters: she was told this one, and
        // it has no reasoning to show.
        if let filament = sky.filaments.first(where: { $0.id == "e.kate.dad" }) {
            try render(
                ConstellationView(
                    sky: sky, time: .frozen(6.4),
                    opensWith: .filament(filament.id),
                    opensAt: clearing(lowestPoint(of: filament), in: sky)),
                named: "sky-filament-observed-night", scheme: .dark, in: directory)
        }

        // MARK: - Wandered

        // Zoomed in on a cluster, and pushed as far as the bound allows. The first says
        // whether magnification is worth having; the second says what the edge of the sky
        // looks like — which is the one place "he can never lose it" is checked by eye.
        let close = ConstellationTransform.identity
            .zoomed(by: 2.6, about: CGPoint(x: phone.width / 2, y: phone.height / 2))
            .clamped(within: sky.contentBounds, viewSize: sky.size)
        try render(
            ConstellationView(sky: sky, time: .frozen(6.4), opensAt: close),
            named: "sky-close-night", scheme: .dark, in: directory)

        let edge = ConstellationTransform.identity
            .panned(by: CGSize(width: 4_000, height: 4_000))
            .clamped(within: sky.contentBounds, viewSize: sky.size)
        try render(
            ConstellationView(sky: sky, time: .frozen(6.4), opensAt: edge),
            named: "sky-edge-night", scheme: .dark, in: directory)
    }

    // MARK: - His own sky

    /// **The pictures that matter, because this is the graph he actually has.**
    ///
    /// Thirty-three stars, one hub, thirty-two identical threads, and not one relation between
    /// two things she knows. Everything this feature was accepted on was looked at through
    /// ``ConstellationSnapshot/fixture``, which has seven anchors and six clusters — a shape
    /// his data does not have and may not have for months. See
    /// ``ConstellationSnapshot/hubAndSpokes``.
    private func renderHisSky(into directory: URL) throws {
        let sky = SkyPreparer(now: ConstellationFixture.now)
            .prepare(.hubAndSpokes, size: phone, chrome: chrome)

        for scheme in [ColorScheme.dark, .light] {
            let suffix = scheme == .dark ? "night" : "day"

            try render(
                ConstellationView(sky: sky, time: .frozen(6.4)),
                named: "his-sky-\(suffix)", scheme: scheme, in: directory)

            // The hub, touched. Two things to look at: the card must not be over the star it
            // describes, and it must not say "Conversation with the Commander said so."
            if let hub = sky.stars.first(where: { $0.id == "source.conversation" }) {
                try render(
                    ConstellationView(
                        sky: sky, time: .frozen(6.4),
                        opensWith: .star(hub.id),
                        opensAt: clearing(hub.anchor, in: sky)),
                    named: "his-hub-\(suffix)", scheme: scheme, in: directory)
            }

            // And an ordinary spoke — the case he says does nothing at all.
            if let star = sky.stars.first(where: { $0.id == "person.father" }) {
                try render(
                    ConstellationView(
                        sky: sky, time: .frozen(6.4),
                        opensWith: .star(star.id),
                        opensAt: clearing(star.anchor, in: sky)),
                    named: "his-star-\(suffix)", scheme: scheme, in: directory)
            }
        }
    }

    /// The transform the device arrives at when a card of the height this one settles at
    /// rises over a selection. Same function, same numbers.
    /// The point the screen clears for a thread: the lowest of its two ends and its middle,
    /// so the card shows both things it relates rather than only the line.
    private func lowestPoint(of filament: PreparedFilament) -> CGPoint {
        let apex = ConstellationHitTest.apex(of: filament)
        return [filament.from, filament.to, apex].max(by: { $0.y < $1.y }) ?? apex
    }

    private func clearing(_ point: CGPoint, in sky: PreparedSky) -> ConstellationTransform {
        ConstellationTransform.identity.revealing(
            point,
            between: ConstellationBand.headroom(sky.chrome),
            and: ConstellationBand.skyline(
                forCardOf: Self.typicalCardHeight, in: sky.size, chrome: sky.chrome),
            within: sky.contentBounds,
            viewSize: sky.size)
    }

    /// What a card with a paragraph of her reasoning on it measures at, on this phone.
    ///
    /// Only the render needs a number — the app measures the real one and hands it to the
    /// same ``ConstellationCard/skyline(forCardOf:in:)``. If this drifts from what a card
    /// really is, the images stop being the picture the device draws, which on a feature
    /// accepted by eye is the whole game.
    private static let typicalCardHeight: CGFloat = 370

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
        // **The bars are in the picture, and that is the whole point of this harness now.**
        //
        // `safeAreaInset` gives the hosted view real safe-area insets, so `ConstellationView`
        // measures the same chrome the device has and lays the card out above the same line.
        // The translucent fills are drawn on top so a human looking at the image can see what
        // the tab bar covers — which is how the clipped star was found, and it was invisible
        // in every earlier render because every earlier render had no bars in it.
        let hosted = view
            .safeAreaInset(edge: .top, spacing: 0) {
                Color.clear.frame(height: chrome.top)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Color.clear.frame(height: chrome.bottom)
            }
            .overlay(alignment: .top) {
                bar(height: chrome.top, scheme: scheme)
            }
            .overlay(alignment: .bottom) {
                bar(height: chrome.bottom, scheme: scheme)
            }
            .frame(width: phone.width, height: phone.height)
            .environment(\.colorScheme, scheme)

        let renderer = ImageRenderer(content: hosted.ignoresSafeArea())
        renderer.scale = 2

        guard let image = renderer.uiImage, let data = image.pngData() else {
            XCTFail("could not render \(name)")
            return
        }

        try data.write(to: directory.appendingPathComponent("\(name).png"))
    }

    /// A stand-in for a navigation bar or a tab bar: translucent, so what is behind it is
    /// still visible in the image and can be judged rather than merely inferred.
    private func bar(height: CGFloat, scheme: ColorScheme) -> some View {
        Rectangle()
            .fill((scheme == .dark ? Color.white : Color.black).opacity(0.10))
            .frame(height: height)
            .allowsHitTesting(false)
    }
}
