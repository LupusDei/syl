import SwiftUI
import XCTest

@testable import Syl
@testable import SylKit

/// Renders the conversation to PNGs so a human can look at it.
///
/// Same rationale as ``HomeSnapshotRendering``, and the same rules: it only ever
/// *produces* images, it never fails on them, and it is opt-in via
/// `SYL_RENDER_SNAPSHOTS` set **in the scheme** — a shell variable does not reach the
/// simulator.
///
/// The acceptance criterion for `syl-008` is "screenshot chat beside home and they read
/// as one product". That is not a claim anyone can settle by reading a diff, so this is
/// how it gets settled.
///
/// Retrieve the images with:
///
/// ```sh
/// open "$(xcrun simctl get_app_container booted com.jmm.syl data)/Documents/design-snapshots"
/// ```
///
/// ## Two things in the output are the renderer, not the design
///
/// - **The composer's field renders as a yellow bar with a red slash.** `TextField`
///   needs a live host and has none offscreen, so `ImageRenderer` substitutes its
///   unavailable placeholder. The surrounding bar, the hairline and the send control are
///   all real; only the field itself is missing. Judge the composer on a device.
/// - **Wrapping this view in a `NavigationStack` renders the *entire* frame as that same
///   placeholder.** The first attempt did, and a whole-screen yellow frame reads as a
///   catastrophic palette bug rather than as an unsupported container. There is no
///   navigation bar in these images for the same reason.
///
/// What the images *are* good for is exactly what caught the first real defect here: on
/// the bare veil, `inkFaint` disappears into a bloom. Nobody would have written that
/// assertion, and it is obvious in one glance.
@MainActor
final class ChatSnapshotRendering: XCTestCase {
    private var enabled: Bool {
        ProcessInfo.processInfo.environment["SYL_RENDER_SNAPSHOTS"] != nil
    }

    private var outputDirectory: URL? {
        FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("design-snapshots", isDirectory: true)
    }

    func testRenderTheConversation() async throws {
        try XCTSkipUnless(enabled, "set SYL_RENDER_SNAPSHOTS=1 to produce design images")
        let directory = try XCTUnwrap(outputDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        print("SYL_SNAPSHOTS_AT \(directory.path)")

        let cases: [(name: String, scheme: ColorScheme, thinking: Bool)] = [
            ("chat-day", .light, false),
            ("chat-night", .dark, false),
            // She is only visible in the transcript while a turn is running, so a
            // render with presence idle cannot show whether that works at all.
            ("chat-thinking", .dark, true),
        ]

        try await renderPlan(into: directory)
        try await renderAttachments(into: directory)

        for (name, scheme, thinking) in cases {
            let database = try SylDatabase.inMemory()
            let store = LocalStore(database: database)
            // A short transcript for the presence case. On the non-scrolling render
            // path the content is not clipped — it simply extends past the frame — so
            // anything bottom-aligned (the ribbon, the composer) lands off-screen when
            // the transcript is tall. The foot of the screen can only be photographed
            // when the conversation is short enough to leave one.
            try store.upsert(thinking ? Array(transcript.suffix(2)) : transcript)

            // Hoisted out of the closure: `now` is `@Sendable`, so it cannot capture
            // this main-actor-isolated test case.
            let now = fixedNow
            let model = ChatViewModel(store: store, now: { now })
            await model.refresh()

            if thinking {
                await model.apply(
                    .presence(
                        WsPresence(state: .thinking, intensity: 0.7, since: now, ttlMs: 15_000)
                    )
                )
            }

            // No `NavigationStack` around it. `ImageRenderer` cannot host one offscreen
            // and renders the whole tree as an unavailable placeholder — a yellow frame
            // with a red slash, which is easy to mistake for a broken palette.
            let view = ChatView(model: model, scrolls: false)
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

    /// The epic's acceptance scenario, on its own.
    ///
    /// > The Commander asks for something structured — a plan, a brief, a comparison —
    /// > and what arrives is legible at a glance.
    ///
    /// Rendered alone rather than at the foot of a conversation, because on the
    /// non-scrolling path a long transcript pushes the interesting part off the top and
    /// the one thing worth judging cannot be seen.
    private func renderPlan(into directory: URL) async throws {
        let database = try SylDatabase.inMemory()
        let store = LocalStore(database: database)
        try store.upsert([
            message(index: 1, role: .user, at: "2026-08-10T13:50:00Z", text: "Plan my morning."),
            message(
                index: 2,
                role: .assistant,
                at: "2026-08-10T13:50:06Z",
                text: """
                    ## Before eleven

                    1. Unstick the deploy gate
                       - Re-run the check on `a91df4c`
                       - If it stays red, look at the runner
                    2. Quarterly review draft
                    3. Reply to Marcus

                    > Nothing has shipped since Friday.

                    | Item | Due |
                    | --- | --- |
                    | Gate | today |
                    | Draft | Thu |
                    """
            ),
        ])

        let now = fixedNow
        let model = ChatViewModel(store: store, now: { now })
        // Awaited directly. An `XCTWaiter` here deadlocks: this test is `@MainActor`,
        // waiting blocks the main thread, and the refresh needs that thread to resume.
        await model.refresh()

        let view = ChatView(model: model, scrolls: false)
            .frame(width: 393, height: 852)
            .environment(\.colorScheme, .dark)

        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.uiImage, let data = image.pngData() else {
            return XCTFail("could not render the plan")
        }
        try data.write(to: directory.appendingPathComponent("chat-plan.png"))
    }

    /// Phase 6's four states, side by side, because they cannot be judged from a diff.
    ///
    /// Every one of these is a state that ships:
    ///
    /// - **His picture**, inside the glass object, capped at 78% of the measure.
    /// - **Hers**, on the page, at full measure.
    /// - **An attachment that is not on this device**, with the tailnet down. This is the
    ///   one worth staring at: it must read as "not here yet" and not as a fault, and it
    ///   must never be a spinner.
    /// - **A video with no poster frame**, which is *every* video today — the service
    ///   generates no poster (`syl-008.5.5`) and reports `hasThumbnail: false` for all of
    ///   them. So this is not an edge case being checked; it is what a video looks like.
    ///
    /// The two loaded cells are primed into `AttachmentLoader`'s cache rather than
    /// fetched, which is also a check on the optimistic-send path: if priming did not
    /// work, these render as placeholders and the image says so immediately.
    private func renderAttachments(into directory: URL) async throws {
        AttachmentLoader.clearCacheForTesting()

        let hers = attachment(index: 1, hasThumbnail: true)
        let his = attachment(index: 2, hasThumbnail: true)
        let missing = attachment(index: 3, hasThumbnail: true)
        let clip = Attachment(
            id: "syl:attachment:019feb2f-e654-7000-ac0e-\(String(format: "%012d", 4))",
            kind: .video,
            mimeType: "video/mp4",
            bytes: 8_400_000,
            width: 1920,
            height: 1080,
            durationMs: 42_000,
            sha256: String(repeating: "d", count: 64),
            createdAt: fixedNow,
            // False for every video, by contract. There is nothing to show but the shape.
            hasThumbnail: false
        )

        AttachmentLoader.prime(attachmentId: hers.id, data: swatch(4, 3, seed: 0), variant: .thumb)
        AttachmentLoader.prime(attachmentId: his.id, data: swatch(3, 4, seed: 1), variant: .thumb)
        // `missing` is deliberately NOT primed, and the context is unwired, so it takes
        // the offline path.

        let database = try SylDatabase.inMemory()
        let store = LocalStore(database: database)
        try store.upsert([
            message(
                index: 1,
                role: .user,
                at: "2026-08-10T13:50:00Z",
                text: "Here's the shelf, after.",
                attachments: [his]
            ),
            message(
                index: 2,
                role: .assistant,
                at: "2026-08-10T13:50:06Z",
                text: "That's the one — the bracket sits flush now.",
                attachments: [hers]
            ),
            message(
                index: 3,
                role: .assistant,
                at: "2026-08-10T13:50:20Z",
                text: "Two more from this morning:",
                attachments: [missing, clip]
            ),
        ])

        let now = fixedNow
        let model = ChatViewModel(store: store, now: { now })
        await model.refresh()

        for (name, scheme) in [("chat-attachments-night", ColorScheme.dark), ("chat-attachments-day", .light)] {
            let view = ChatView(model: model, scrolls: false)
                .frame(width: 393, height: 852)
                .environment(\.colorScheme, scheme)

            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            guard let image = renderer.uiImage, let data = image.pngData() else {
                return XCTFail("could not render \(name)")
            }
            try data.write(to: directory.appendingPathComponent("\(name).png"))
        }

        try renderAttachmentStates(into: directory)
        AttachmentLoader.clearCacheForTesting()
    }

    /// Every state a cell can be in, on one page.
    ///
    /// **This is the only way the offline placeholder ever gets looked at.** A design
    /// harness cannot make a network fail, so the states that matter most — the ones a
    /// tailnet drop produces — are exactly the ones a screen render can never reach.
    /// `AttachmentPlaceholder` is a pure function of `(attachment, state)` for this
    /// reason, and this is the payoff.
    ///
    /// What to check, in order: that "Not downloaded" reads as *not here yet* and not as
    /// a fault; that none of the four is a spinner; and that the labels survive the
    /// veil's blooms, which is the defect this harness caught the first time it was run.
    private func renderAttachmentStates(into directory: URL) throws {
        let picture = attachment(index: 5, hasThumbnail: true)
        let clip = Attachment(
            id: "syl:attachment:019feb2f-e654-7000-ac0e-\(String(format: "%012d", 6))",
            kind: .video,
            mimeType: "video/mp4",
            bytes: 8_400_000,
            width: 1920,
            height: 1080,
            durationMs: 42_000,
            sha256: String(repeating: "e", count: 64),
            createdAt: fixedNow,
            hasThumbnail: false
        )

        let states: [(String, Attachment, AttachmentLoadState)] = [
            ("Waiting", picture, .loading),
            ("Offline", picture, .unavailable(.offline)),
            ("Refused", picture, .unavailable(.refused(.differentOrigin))),
            ("Video, no poster", clip, .idle),
        ]

        for scheme in [ColorScheme.dark, ColorScheme.light] {
            let strip = ZStack {
                SylTheme.Veil().ignoresSafeArea()
                VStack(spacing: SylTheme.Metric.step) {
                    ForEach(Array(states.enumerated()), id: \.offset) { _, entry in
                        VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
                            Text(entry.0)
                                .sylLabelStyle()
                                .foregroundStyle(SylTheme.Colour.inkSoft)
                            Color.clear
                                .aspectRatio(4.0 / 3.0, contentMode: .fit)
                                .overlay {
                                    AttachmentPlaceholder(attachment: entry.1, state: entry.2)
                                }
                                .clipShape(
                                    RoundedRectangle(
                                        cornerRadius: SylTheme.Metric.codeRadius,
                                        style: .continuous
                                    )
                                )
                                .overlay {
                                    RoundedRectangle(
                                        cornerRadius: SylTheme.Metric.codeRadius,
                                        style: .continuous
                                    )
                                    .strokeBorder(SylTheme.Colour.hairline, lineWidth: SylTheme.Metric.hair)
                                }
                        }
                    }
                }
                .padding(SylTheme.Metric.gutter)
            }
            .frame(width: 393, height: 852)
            .environment(\.colorScheme, scheme)

            let renderer = ImageRenderer(content: strip)
            renderer.scale = 2
            guard let image = renderer.uiImage, let data = image.pngData() else {
                return XCTFail("could not render the attachment states")
            }
            let name = scheme == .dark ? "chat-attachment-states-night" : "chat-attachment-states-day"
            try data.write(to: directory.appendingPathComponent("\(name).png"))
        }
    }

    /// A recognisable picture, made rather than bundled.
    ///
    /// It has to be a real decodable PNG — the cell calls `UIImage(data:)` and falls
    /// through to an error plate if that returns nil, so a placeholder byte string would
    /// silently render the wrong state. The bands make the aspect ratio and any cropping
    /// obvious at a glance, which is the entire reason to look at these images.
    private func swatch(_ wide: Int, _ tall: Int, seed: Int) -> Data {
        let size = CGSize(width: wide * 80, height: tall * 80)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { context in
            let hues: [CGFloat] = [0.58, 0.62, 0.55, 0.66]
            for band in 0..<6 {
                let hue = hues[(band + seed) % hues.count]
                UIColor(hue: hue, saturation: 0.45, brightness: 0.35 + 0.1 * CGFloat(band % 3), alpha: 1)
                    .setFill()
                context.fill(
                    CGRect(
                        x: 0,
                        y: size.height / 6 * CGFloat(band),
                        width: size.width,
                        height: size.height / 6
                    )
                )
            }
        }
        return image.pngData() ?? Data()
    }

    private func attachment(index: Int, hasThumbnail: Bool) -> Attachment {
        Attachment(
            id: "syl:attachment:019feb2f-e654-7000-ac0e-\(String(format: "%012d", index))",
            kind: .image,
            mimeType: "image/png",
            bytes: 144_559,
            width: index == 2 ? 1200 : 1600,
            height: index == 2 ? 1600 : 1200,
            durationMs: nil,
            sha256: String(repeating: "\(index)", count: 64),
            createdAt: fixedNow,
            hasThumbnail: hasThumbnail
        )
    }

    // MARK: - Fixtures

    /// A transcript chosen to exercise the layout rather than to look flattering:
    /// a short question against a long structured answer, a day boundary, and a
    /// back-to-back exchange that must NOT print a second timestamp.
    private var transcript: [Message] {
        [
            message(
                index: 1,
                role: .user,
                at: "2026-08-09T14:02:00Z",
                text: "What's left today?"
            ),
            message(
                index: 2,
                role: .assistant,
                at: "2026-08-09T14:02:11Z",
                text: """
                    ## Three things, one time-sensitive

                    The deploy gate is still red on `a91df4c` — the check run never \
                    reported, so **nothing has shipped since Friday**.

                    1. Unstick the deploy gate
                       - Re-run the check on `a91df4c`
                       - If it stays red, look at the runner
                    2. Quarterly review draft
                    3. Reply to Marcus about the contract dates

                    ```sh
                    gh run list --commit a91df4c --json conclusion
                    ```

                    | Item | Due | State |
                    | --- | --- | --- |
                    | Deploy gate | today | blocked |
                    | Review draft | Thu | open |

                    > Nothing has shipped since Friday.

                    ### Worth knowing

                    - The gate treats "no checks" as *do not deploy*
                    - [The run](https://github.com/example/repo) never reported
                    """
            ),
            message(
                index: 3,
                role: .user,
                at: "2026-08-10T13:58:00Z",
                text: "Push the review to Thursday."
            ),
            message(
                index: 4,
                role: .assistant,
                at: "2026-08-10T13:58:09Z",
                text: "Moved to Thursday. That still clears the board before the Friday deadline."
            ),
        ]
    }

    private func message(
        index: Int,
        role: MessageRole,
        at iso: String,
        text: String,
        attachments: [Attachment] = []
    ) -> Message {
        Message(
            id: "syl:message:0198f2c0-0001-7000-8000-\(String(format: "%012d", index))",
            conversationId: SylIDs.interactiveConversation,
            clientId: nil,
            role: role,
            text: text,
            createdAt: try! Instant.parse(iso),
            seq: index,
            attachments: attachments
        )
    }

    /// Fixed, so the day rules render "Today"/"Yesterday" identically on every run.
    private var fixedNow: Date { try! Instant.parse("2026-08-10T14:30:00Z") }
}
