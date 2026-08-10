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

    private func message(index: Int, role: MessageRole, at iso: String, text: String) -> Message {
        Message(
            id: "syl:message:0198f2c0-0001-7000-8000-\(String(format: "%012d", index))",
            conversationId: SylIDs.interactiveConversation,
            clientId: nil,
            role: role,
            text: text,
            createdAt: try! Instant.parse(iso),
            seq: index
        )
    }

    /// Fixed, so the day rules render "Today"/"Yesterday" identically on every run.
    private var fixedNow: Date { try! Instant.parse("2026-08-10T14:30:00Z") }
}
