import SwiftUI
import SylKit
import XCTest

@testable import Syl

/// Renders the goal screens to PNGs so a human can look at them.
///
/// Same contract as `HomeSnapshotRendering`: this only ever *produces* images and never
/// fails on them, because pinning rendered pixels is how a design system acquires a
/// hundred uninformative failures the first time somebody nudges a corner radius.
///
/// ## The case that matters most here
///
/// `goal-nothing-*`. A goal with no evidence is the honest state, and an honest state
/// that looks like a failed load teaches him to distrust the one screen that is not lying
/// to him. It has to read as a **statement**. That cannot be asserted; it can only be
/// looked at.
///
/// **A shell variable will not work.** `SYL_RENDER_SNAPSHOTS=1 xcodebuild test …` sets it
/// on `xcodebuild`, which is a different process on a different machine from the test.
/// Use `TEST_RUNNER_SYL_RENDER_SNAPSHOTS=1`, which `xcodebuild` forwards into the runner,
/// or set it in the scheme.
///
/// ```sh
/// open "$(xcrun simctl get_app_container booted com.jmm.syl data)/Documents/design-snapshots"
/// ```
@MainActor
final class GoalSnapshotRendering: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!

    private let calendar = GoalFixtures.calendar
    private let now = GoalFixtures.day("2026-06-01")

    private var enabled: Bool {
        ProcessInfo.processInfo.environment["SYL_RENDER_SNAPSHOTS"] != nil
    }

    private var outputDirectory: URL? {
        FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("design-snapshots", isDirectory: true)
    }

    func testRenderTheGoalScreens() throws {
        try XCTSkipUnless(enabled, "set SYL_RENDER_SNAPSHOTS=1 to produce design images")
        let directory = try XCTUnwrap(outputDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        print("SYL_SNAPSHOTS_AT \(directory.path)")

        // Built here rather than in `setUp`: this class is `@MainActor` so the renderer can
        // touch `ImageRenderer`, and an override of `setUpWithError` is nonisolated, which
        // makes assigning to a main-actor property from it a concurrency error.
        database = try SylDatabase.inMemory()
        store = LocalStore(database: database)
        defer {
            store = nil
            database = nil
        }

        try seed()
        let snapshot = try GoalSnapshotLoader(store: store, now: now, calendar: calendar).load()

        for scheme in [ColorScheme.light, .dark] {
            let suffix = scheme == .light ? "day" : "night"

            try render(
                GoalListView(snapshot: snapshot, scrolls: false),
                named: "goals-list-\(suffix)", scheme: scheme, in: directory)

            try render(
                GoalListView(snapshot: GoalListSnapshot(), scrolls: false),
                named: "goals-none-\(suffix)", scheme: scheme, in: directory)

            for (name, id) in [
                ("goal-rich", GoalFixtures.goalID(1)),
                ("goal-nothing", GoalFixtures.goalID(2)),
                ("goal-risk", GoalFixtures.goalID(3)),
                ("goal-setdown", GoalFixtures.goalID(4)),
                ("goal-child", GoalFixtures.goalID(5)),
            ] {
                let row = try XCTUnwrap(snapshot.row(id: id))
                // Taller than a phone on purpose. A goal with a year of evidence is well
                // over one screen, and an offscreen host has no scroll view to page it —
                // so at 852 the overflow centred itself and clipped the title off the top,
                // which is the one part of the screen most worth looking at.
                try render(
                    GoalDetailView(snapshot: row, scrolls: false),
                    named: "\(name)-\(suffix)", scheme: scheme, height: 1_500, in: directory)
            }
        }

        // The largest accessibility size, on both screens. NFR3 asks for it and it is not
        // assertable — the failure mode is a line of two words, a truncated sentence, or a
        // number that has wrapped away from the noun it belongs to. All three are obvious
        // in one glance and invisible to every assertion in the suite.
        try render(
            GoalListView(snapshot: snapshot, scrolls: false),
            named: "goals-list-ax5", scheme: .dark, height: 2_600, size: .accessibility5,
            in: directory)
        try render(
            GoalDetailView(snapshot: try XCTUnwrap(snapshot.row(id: GoalFixtures.goalID(3))),
                           scrolls: false),
            named: "goal-risk-ax5", scheme: .dark, height: 2_600, size: .accessibility5,
            in: directory)
    }

    // MARK: - The cast

    private func seed() throws {
        try store.upsert([
            // 1 — a goal with a year of real evidence behind it, and a parent below it.
            GoalFixtures.goal(
                id: GoalFixtures.goalID(1),
                title: "Be strong at fifty",
                why: "Because the version of me who is fifty gets whatever the version of me "
                    + "who is forty-one decides to send him.",
                targetDate: "2026-11-30",
                cadenceDays: 14,
                createdAt: GoalFixtures.day("2026-01-01")
            ),

            // 2 — nothing linked at all. The render this file exists for.
            GoalFixtures.goal(
                id: GoalFixtures.goalID(2),
                title: "Learn to sail",
                why: "Dad taught me and I have not been out since.",
                targetDate: nil,
                cadenceDays: nil,
                createdAt: GoalFixtures.day("2026-05-20")
            ),

            // 3 — both signals at once: long silence, and arithmetic that is not flattering.
            GoalFixtures.goal(
                id: GoalFixtures.goalID(3),
                title: "Finish the novel",
                why: "It has been four years. That is the whole reason.",
                targetDate: "2026-12-31",
                targetValue: 40,
                cadenceDays: 7,
                createdAt: GoalFixtures.day("2026-01-01")
            ),

            // 4 — set down, with its history intact. It must not read as a failure.
            GoalFixtures.goal(
                id: GoalFixtures.goalID(4),
                title: "Learn Mandarin",
                why: "For the trip we ended up not taking.",
                targetDate: "2026-09-01",
                cadenceDays: 7,
                status: .abandoned,
                statusReason: "The trip is off, and I would rather spend the hour on the cello.",
                createdAt: GoalFixtures.day("2026-01-15")
            ),

            // 5 — nested under 1, so the parent link and the child list both render.
            GoalFixtures.goal(
                id: GoalFixtures.goalID(5),
                parentId: GoalFixtures.goalID(1),
                title: "Run a marathon",
                why: "Because I said I would, out loud, to someone who remembers.",
                targetDate: "2026-10-11",
                cadenceDays: 7,
                createdAt: GoalFixtures.day("2026-02-01")
            ),

            // 6 — parked. "Not now" is a real answer and it gets its own heading.
            GoalFixtures.goal(
                id: GoalFixtures.goalID(6),
                title: "Rebuild the workshop bench",
                why: nil,
                targetDate: "2027-06-01",
                cadenceDays: nil,
                status: .dormant,
                createdAt: GoalFixtures.day("2026-03-01")
            ),
        ])

        // Rich evidence for goal 1: eleven closed sessions, so the window fills and the
        // "and N more before that" line renders too.
        let sessions = [
            "Deadlift 5×5 at 140", "Swim 1,500m", "Twelve miles, easy pace",
            "Deadlift 5×3 at 150", "Hill repeats", "Swim 2,000m",
            "Long run — eighteen miles", "Deadlift 5×5 at 145", "Rowing 10k",
            "Swim 1,800m", "Nine miles before work",
        ]
        try store.upsert(
            sessions.enumerated().map { index, text in
                GoalFixtures.todo(
                    id: GoalFixtures.todoID(100 + index),
                    text: text,
                    goalId: GoalFixtures.goalID(1),
                    completedAt: GoalFixtures.day("2026-03-01")
                        .addingTimeInterval(Double(index) * 7 * 86_400)
                )
            })

        // Two still open on goal 1 — listed, never counted against what happened.
        try store.upsert([
            GoalFixtures.todo(
                id: GoalFixtures.todoID(200), text: "Book the physio", goalId: GoalFixtures.goalID(1),
                status: .open, dueAt: GoalFixtures.day("2026-06-09")),
            GoalFixtures.todo(
                id: GoalFixtures.todoID(201), text: "Replace the running shoes",
                goalId: GoalFixtures.goalID(1), status: .open, pinned: true),
        ])

        // Goal 3 has moved three times, months ago. Both signals fire.
        try store.upsert(
            ["Chapter one", "Chapter two", "Cut the second act"].enumerated().map { index, text in
                GoalFixtures.todo(
                    id: GoalFixtures.todoID(300 + index),
                    text: text,
                    goalId: GoalFixtures.goalID(3),
                    completedAt: GoalFixtures.day("2026-01-10")
                        .addingTimeInterval(Double(index) * 10 * 86_400)
                )
            })

        // Goal 4 was really worked at before it was set down. That history is the point.
        try store.upsert(
            ["Finished HSK 1", "Thirty days of characters", "First conversation lesson"]
                .enumerated().map { index, text in
                    GoalFixtures.todo(
                        id: GoalFixtures.todoID(400 + index),
                        text: text,
                        goalId: GoalFixtures.goalID(4),
                        completedAt: GoalFixtures.day("2026-02-01")
                            .addingTimeInterval(Double(index) * 14 * 86_400)
                    )
                })

        // Goal 5: one thing done, one still open.
        try store.upsert([
            GoalFixtures.todo(
                id: GoalFixtures.todoID(500), text: "Sign up for the October race",
                goalId: GoalFixtures.goalID(5),
                completedAt: GoalFixtures.day("2026-05-28")),
            GoalFixtures.todo(
                id: GoalFixtures.todoID(501), text: "Twenty-mile long run",
                goalId: GoalFixtures.goalID(5), status: .open),
        ])
    }

    // MARK: - Rendering

    private func render(
        _ view: some View,
        named name: String,
        scheme: ColorScheme,
        height: CGFloat = 852,
        size: DynamicTypeSize = .large,
        in directory: URL
    ) throws {
        // **No `NavigationStack` here, and that is not an omission.**
        //
        // The first version of this file wrapped each screen in one, reasoning that both
        // use `NavigationLink`. Every render came back as SwiftUI's yellow "cannot draw
        // this" placeholder: `ImageRenderer` has no navigation host, so a stack renders as
        // nothing at all. It is the same class of defect as `HomeView.scrolls` — an
        // offscreen host is not a window — and it is exactly what this harness is for. A
        // `NavigationLink` outside a stack still draws its label, which is the part being
        // looked at.
        let hosted = view
            .frame(width: 393, height: height)  // 393 is the iPhone 17 logical width
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size)

        let renderer = ImageRenderer(content: hosted)
        renderer.scale = 2

        guard let image = renderer.uiImage, let data = image.pngData() else {
            XCTFail("could not render \(name)")
            return
        }

        try data.write(to: directory.appendingPathComponent("\(name).png"))
    }
}
