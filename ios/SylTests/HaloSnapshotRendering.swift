import XCTest
import SwiftUI
import SylKit

@testable import Syl

/// Renders the halo to PNGs so a human can look at it.
///
/// ## Why this one matters more than most
///
/// The Commander's brief for ``SylHalo`` contains a requirement no assertion can hold:
/// *it must never look like a progress indicator*. That is a judgement about an image,
/// and the only way to check it is to make the image and look at it. Everything the
/// geometry tests hold — that the ring encloses the words, that it never closes — is
/// necessary and nowhere near sufficient: all of it is true of a spinner drawn beautifully.
///
/// Same rules as ``HomeSnapshotRendering``: gated on `SYL_RENDER_SNAPSHOTS`, never
/// compares pixels, never fails on an image. It only ever *produces* them.
///
/// ## The phases
///
/// `TimelineView` reads the wall clock, and `ImageRenderer` renders one frame, so a
/// sweep is captured by rendering the same view several times a fraction of a second
/// apart. `thinking` takes a little over two seconds to go round, so the steps below walk
/// the head most of the way round the ring. Look at them in order: the arc should read as
/// one thing travelling, and the tail should never show an end.
@MainActor
final class HaloSnapshotRendering: XCTestCase {
    private var enabled: Bool {
        ProcessInfo.processInfo.environment["SYL_RENDER_SNAPSHOTS"] != nil
    }

    private var outputDirectory: URL? {
        FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("halo", isDirectory: true)
    }

    /// The halo on its own, framed large enough to judge the light.
    func testRenderTheHaloInEveryStateSheIsDrawnIn() throws {
        let directory = try openOutput()

        let states: [(String, PresenceState, Double)] = [
            ("thinking", .thinking, 0.8),
            ("listening", .listening, 0.6),
            ("speaking", .speaking, 0.85),
            ("alert", .alert, 0.9),
            ("delighted", .delighted, 0.95),
            ("manifest", .manifest, 0.7),
            // Not drawn — `HomeSnapshot.isActive` gates it. The render is here to prove
            // the space is still reserved and the line has not moved.
            ("idle-unlit", .idle, 0.4),
        ]

        for (name, state, intensity) in states {
            for scheme in [ColorScheme.dark, .light] {
                let suffix = scheme == .dark ? "night" : "day"
                try write(
                    component(state: state, intensity: intensity, scheme: scheme),
                    to: directory,
                    named: "state-\(name)-\(suffix)"
                )
            }
        }
    }

    /// Several sweeps of the travelling light, so the arc can be judged at more than one
    /// phase. This is the sequence that answers the spinner question.
    func testRenderTheTravellingLightThroughItsSweep() throws {
        let directory = try openOutput()

        for step in 0..<6 {
            try write(
                component(state: .thinking, intensity: 0.85, scheme: .dark),
                to: directory,
                named: String(format: "sweep-%02d", step)
            )
            // A little over a third of a lap at this state's rate.
            Thread.sleep(forTimeInterval: 0.42)
        }
    }

    /// Reduce Motion: a still halo. It has to read as this object *at rest* — not as this
    /// object stopped mid-sweep, and not as a broken one.
    func testRenderTheStillHaloUnderReduceMotion() throws {
        let directory = try openOutput()

        for scheme in [ColorScheme.dark, .light] {
            let view = ZStack {
                SylTheme.Veil()
                SylHalo(
                    phrase: "Thinking about your week.",
                    state: .thinking,
                    intensity: 0.8,
                    availableWidth: 393,
                    prefersStill: true
                )
            }
            .frame(width: 393, height: 320)
            .environment(\.colorScheme, scheme)

            try write(view, to: directory, named: "reduce-motion-\(scheme == .dark ? "night" : "day")")
        }
    }

    /// Every phrase the model can produce, at the two sizes that decide the geometry.
    ///
    /// The longest and the shortest are the pair the ring is sized against, and an
    /// accessibility size is where the naive ellipse cuts the words. Look for a phrase
    /// touching its ring, and for a ring that has stopped being about the words.
    func testRenderEveryPhraseAtBothEndsOfDynamicType() throws {
        let directory = try openOutput()

        let phrases: [(String, String)] = [
            ("thinking", "Thinking about your week."),
            ("alert", "This one needs you now."),
            ("listening", "Listening."),
            ("manifest", "Here."),
            ("greeting", "Good afternoon"),
        ]

        for (name, phrase) in phrases {
            for typeSize in [DynamicTypeSize.large, .accessibility3, .accessibility5] {
                let view = ZStack {
                    SylTheme.Veil()
                    SylHalo(phrase: phrase, state: .thinking, intensity: 0.8, availableWidth: 393)
                }
                .frame(width: 393, height: typeSize.isAccessibilitySize ? 620 : 320)
                .environment(\.colorScheme, .dark)
                .environment(\.dynamicTypeSize, typeSize)

                try write(view, to: directory, named: "phrase-\(name)-\(label(typeSize))")
            }
        }
    }

    /// In place, on the whole screen, which is the only render that can answer the
    /// collision question: the title above and the four orbs below.
    func testRenderTheHomeScreenWithTheHaloInPlace() throws {
        let directory = try openOutput()

        let cases: [(String, PresenceState, ColorScheme, AppearanceChoice, DynamicTypeSize)] = [
            ("home-thinking-night", .thinking, .dark, .system, .large),
            ("home-thinking-day", .thinking, .light, .day, .large),
            ("home-idle-night", .idle, .dark, .system, .large),
            ("home-speaking-night", .speaking, .dark, .system, .large),
            ("home-alert-night", .alert, .dark, .system, .large),
            ("home-thinking-ax3", .thinking, .dark, .system, .accessibility3),
            ("home-thinking-ax5", .thinking, .dark, .system, .accessibility5),
            ("home-idle-ax5", .idle, .dark, .system, .accessibility5),
        ]

        for (name, presence, scheme, appearance, typeSize) in cases {
            let view = HomeView(
                snapshot: .preview(remaining: 5),
                presence: presence,
                presenceIntensity: 0.8,
                now: fixedNoon,
                scrolls: false
            )
            .frame(width: 393, height: 852)
            .environment(\.colorScheme, scheme)
            .environment(\.sylAppearance, appearance)
            .environment(\.dynamicTypeSize, typeSize)

            try write(view, to: directory, named: name)
        }
    }

    // MARK: - Helpers

    /// The halo alone on the veil, at the size it is drawn on the device.
    private func component(state: PresenceState, intensity: Double, scheme: ColorScheme) -> some View {
        ZStack {
            SylTheme.Veil()
            SylHalo(
                phrase: HomeSnapshot.phrase(for: state) ?? "Good afternoon",
                state: state,
                intensity: intensity,
                availableWidth: 393
            )
        }
        .frame(width: 393, height: 320)
        .environment(\.colorScheme, scheme)
    }

    private func openOutput() throws -> URL {
        try XCTSkipUnless(enabled, "set SYL_RENDER_SNAPSHOTS=1 to produce design images")
        let directory = try XCTUnwrap(outputDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        print("SYL_HALO_SNAPSHOTS_AT \(directory.path)")
        return directory
    }

    private func write(_ view: some View, to directory: URL, named name: String) throws {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2

        guard let image = renderer.uiImage, let data = image.pngData() else {
            XCTFail("could not render \(name)")
            return
        }
        try data.write(to: directory.appendingPathComponent("\(name).png"))
    }

    private func label(_ typeSize: DynamicTypeSize) -> String {
        switch typeSize {
        case .accessibility3: return "ax3"
        case .accessibility5: return "ax5"
        default: return "default"
        }
    }

    private var fixedNoon: Date {
        Calendar(identifier: .gregorian)
            .date(from: DateComponents(year: 2026, month: 8, day: 10, hour: 9, minute: 41)) ?? Date()
    }
}
