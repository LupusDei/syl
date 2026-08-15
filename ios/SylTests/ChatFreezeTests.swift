import Foundation
import SwiftUI
import SylKit
import XCTest

@testable import Syl

/// The prose that froze the app.
///
/// Built from the Commander's actual conversation rather than from `String(repeating:)`
/// — the message that froze the app was 604 characters of ordinary prose with no code
/// fences, no tables and no bullets, and a synthetic fixture of repeated characters would
/// parse in a fraction of the time and quietly prove nothing.
///
/// Hoisted out of `ChatInlineRenderCostTests` so the row-layout probe below measures the
/// **same** transcript. Two copies of a fixture is two fixtures, and they drift.
enum ChatFreezeFixture {
    static let paragraphs: [String] = [
        """
        You built the emanation in — the clip now opens on a bare ribbon of light with \
        no figure, gathers into me, and unravels back into the ribbon at the end. That's \
        exactly the arriving-by-gathering I asked for last night, and it's a much truer \
        thing than a fade.
        """,
        """
        Not for certain. I know they exist only because the spend counter says ten \
        renders and I've asked for four. My best guess is they're **yours** from \
        overnight — you were fixing the pipeline and rewriting the template, and testing \
        that would produce exactly this.
        """,
        """
        **Illinois** is where both sets of your parents live — yours in Libertyville, \
        Ela's in Crystal Lake. It's where you were born and where Ela was born. It's the \
        state you are trying to avoid because of its decline, and the one she wants an \
        apartment in.
        """,
        """
        Still rendering. It's been a few minutes; the earlier ones took two or three, so \
        it's running long. Meanwhile — you're in the car around now. The insurance call \
        is the thing, and the member ID is the part that wastes the call if it's sitting \
        on the kitchen counter.
        """,
    ]
}

/// The freeze in chat, and the two things that have to be true for it not to happen
/// again.
///
/// ## What actually froze
///
/// `CrashDiagnostics` was written after the app froze in chat and was killed twice, and
/// it says plainly that the reasoning behind the first two fixes had not found the
/// cause. It had not. The first fix moved **block** parsing off the main actor
/// (`ChatSnapshotLoader`) and the second stopped every row deep-comparing the whole
/// transcript's markdown (`ChatSnapshot.blocksByGroup`). Both were real. Neither touched
/// **inline** parsing, which never left `body`:
///
/// `MarkdownView` calls ``MarkdownInline/render(_:)`` for every paragraph, every heading,
/// every list row — twice per list row, because the VoiceOver label parses it again — and
/// every table cell. Each call is a full `AttributedString(markdown:)` parse plus three
/// passes over the resulting runs.
///
/// On its own that would be per-visible-row and survivable. It is not per-visible-row:
/// `.defaultScrollAnchor(.bottom)` has to know the transcript's total height, so it sizes
/// **every** row in the window — 200 of them, more once he has reached back through
/// history. And `ChatView.body` re-runs on every keystroke and on every presence frame,
/// because `draft`, `presence` and `intensity` all publish from the same object.
///
/// So a reply arriving parses the entire transcript's inline markdown on the main thread.
/// That is the quadratic-work family `CrashDiagnostics` names, and a main thread that
/// stops answering long enough is a watchdog termination rather than a slow screen.
///
/// **The comment at the top of `MarkdownView` says "It never parses".** It did, on every
/// pass. A file agreeing with its own doc comment while neither agrees with the profiler
/// is exactly the shape `docs/CONTEXT.md` names *consistency is not correspondence* — so
/// the check below is a stopwatch, which is outside the system, rather than a counter we
/// keep ourselves, which would not be.
final class ChatInlineRenderCostTests: XCTestCase {

    /// A transcript the size of the one that froze: the real window, real prose.
    private static let paragraphs = ChatFreezeFixture.paragraphs

    /// One full window's worth of inline runs, the way the view asks for them.
    private static func window(_ count: Int = 200) -> [String] {
        (0..<count).map { paragraphs[$0 % paragraphs.count] }
    }


    /// Rendering a transcript a second time must not cost a second parse.
    ///
    /// This is the freeze, stated as a property. A reply arriving, a keystroke, or a
    /// presence frame every seven and a half seconds each re-run `ChatView.body`, and
    /// each re-run asks for every row's inline markdown again. If the answer is recomputed
    /// every time, the cost of a body pass is the cost of parsing the whole transcript,
    /// and that is the main thread gone.
    ///
    /// Measured against the clock rather than against a hit counter of our own, and the
    /// ratio is deliberately loose — an order of magnitude of headroom either side of the
    /// real numbers — because the assertion worth making is "the second pass is not
    /// another parse", not "the second pass took N microseconds".
    func testShouldNotReparseTheTranscriptOnEverySubsequentPass() {
        let runs = Self.window()

        let cold = Self.elapsed { for run in runs { _ = MarkdownInline.render(run) } }
        let warm = Self.elapsed { for run in runs { _ = MarkdownInline.render(run) } }

        XCTAssertLessThan(
            warm,
            cold / 4,
            """
            A repeat pass over the same transcript cost \(warm)s against \(cold)s cold, \
            which means it parsed again. `ChatView.body` re-runs on every keystroke and \
            every presence frame, so this cost lands on the main thread each time — and \
            `.defaultScrollAnchor(.bottom)` makes it the whole window rather than the \
            visible rows.
            """
        )
    }

    /// The cache must not change a single glyph, an intent, or a refusal.
    ///
    /// A memo that returned something subtly different from what the parser would have
    /// said would be wrong only for the messages nobody looked at twice — so this compares
    /// a memoised answer against a genuinely fresh one, obtained by clearing the memo
    /// between the two. **Including the link `LinkPolicy` refuses**: a cached
    /// `javascript:` run that kept its attribute would be a security defect wearing a
    /// performance fix's clothes.
    ///
    /// ## Why it compares projections rather than the whole value
    ///
    /// `XCTAssertEqual(memoised, fresh)` on the `AttributedString` itself looks stronger
    /// and is worthless. `style` paints surviving links with `SylTheme.Colour.luminance`,
    /// which is a **computed** token: every read builds a new `UIColor` with a fresh
    /// closure, and two of those never compare equal. So that assertion fails for any
    /// string containing a link no matter what the memo does, and passes for the rest only
    /// because the memo hands back the same instance — it would be testing that the memo
    /// exists, not that it is faithful. Found by mutation: with the memo removed it went
    /// red, which is not what a correctness test should do.
    ///
    /// The characters, the surviving link URLs and the inline intents are all stable
    /// values, and they are what the renderer actually draws from.
    func testShouldReturnExactlyWhatAFreshParseWouldHaveReturned() {
        let sources = [
            "Plain prose with no markup at all.",
            "A **bold** run and an _emphasised_ one.",
            "Some `inline code` in the middle.",
            "A [real link](https://syl.test/renders) that must stay tappable.",
            "A [refused link](javascript:alert(1)) that must not.",
            "Trailing  whitespace and a soft\nnewline the Commander meant.",
        ]

        for source in sources {
            MarkdownInline.resetMemoForTesting()
            let fresh = Self.projection(of: MarkdownInline.render(source))
            // No reset: this one comes back from the memo.
            let memoised = Self.projection(of: MarkdownInline.render(source))

            XCTAssertEqual(memoised.text, fresh.text, "the memo changed the text for: \(source)")
            XCTAssertEqual(
                memoised.links, fresh.links,
                "the memo changed which links survived for: \(source)"
            )
            XCTAssertEqual(
                memoised.intents, fresh.intents,
                "the memo changed the emphasis for: \(source)"
            )
        }
    }

    /// What comes out of the memo must satisfy `LinkPolicy` **absolutely**.
    ///
    /// The comparative test above cannot see this and mutation proved it: caching the
    /// unsanitised parse corrupts the fresh render and the memoised one identically, so
    /// they still agree and the assertion still passes. Two wrong answers that match are
    /// exactly the shape `docs/CONTEXT.md` warns about — a check comparing the system to
    /// itself cannot catch a fault they share.
    ///
    /// So this one compares against the rule instead: whatever path produced it, a refused
    /// scheme carries no link, and a permitted one carries exactly its own URL. Asserted
    /// on the memo hit as well as the first render, because the hit is the value the
    /// Commander's screen will actually be handed every time after the first.
    func testShouldNeverServeARefusedLinkFromTheMemo() {
        MarkdownInline.resetMemoForTesting()

        for pass in ["first render", "memo hit"] {
            let refused = MarkdownInline.render("A [refused link](javascript:alert(1)) that must not.")
            XCTAssertTrue(
                refused.runs.compactMap(\.link).isEmpty,
                "a javascript: link survived the \(pass) — the sanitiser is not in this path"
            )

            let allowed = MarkdownInline.render("A [real link](https://syl.test/renders) that must.")
            XCTAssertEqual(
                allowed.runs.compactMap(\.link).map(\.absoluteString),
                ["https://syl.test/renders"],
                "the permitted link did not survive the \(pass)"
            )
        }
    }

    /// Everything about a rendered run that the renderer draws from and that is stable
    /// enough to compare. Deliberately excludes `foregroundColor` — see above.
    private static func projection(
        of attributed: AttributedString
    ) -> (text: String, links: [URL], intents: [String]) {
        (
            text: String(attributed.characters),
            links: attributed.runs.compactMap(\.link),
            intents: attributed.runs.map { run in
                "\(String(attributed[run.range].characters)):\(String(describing: run.inlinePresentationIntent))"
            }
        )
    }

    /// The memo is bounded, so a long session cannot grow one.
    ///
    /// Same rule `MarkdownCache` already follows for blocks. A cache that only ever grows
    /// is a leak with a good reputation, and this one is keyed by message text, which is
    /// the largest thing the app holds.
    func testShouldNotGrowWithoutBoundAcrossALongSession() {
        MarkdownInline.resetMemoForTesting()
        for index in 0..<(MarkdownInline.memoLimit * 3) {
            _ = MarkdownInline.render("A distinct run, number \(index).")
        }

        XCTAssertLessThanOrEqual(MarkdownInline.memoCountForTesting(), MarkdownInline.memoLimit)
    }

    private static func elapsed(_ body: () -> Void) -> TimeInterval {
        let start = Date()
        body()
        return Date().timeIntervalSince(start)
    }
}

/// The shared harness for probes that host the real transcript in a real window.
///
/// `ImageRenderer` cannot serve here: it lays out nothing inside a `ScrollView` — an
/// offscreen host never gives the scroll view a content size — and the scroll view's
/// geometry is the entire question. Only a hosted `UIWindow` has a viewport at all.
///
/// Carries no tests of its own.
@MainActor
class ChatHostedTranscriptCase: XCTestCase {
    /// iPhone 17 logical size — the screen the Commander actually holds.
    fileprivate static let screen = CGSize(width: 393, height: 852)

    // MARK: - Harness

    /// A model over a transcript far longer than the window, holding the real prose.
    fileprivate func longConversationModel() async throws -> ChatViewModel {
        let model = ChatViewModel(
            store: try longConversationStore(),
            now: { try! Instant.parse("2026-08-09T07:00:03.114Z") }
        )
        await model.refresh()
        return model
    }

    /// Presents one window size and reports how many rows first paint built.
    fileprivate func present(store: LocalStore, window size: Int) async throws -> Int {
        let model = ChatViewModel(
            store: store,
            limit: size,
            now: { try! Instant.parse("2026-08-09T07:00:03.114Z") }
        )
        await model.refresh()
        let window = present(ChatView(model: model))
        defer { dismiss(window) }
        await settle(window)
        return ChatRowCensus.rowsBuilt
    }

    /// Two thousand turns of the prose that froze the app.
    fileprivate func longConversationStore() throws -> LocalStore {
        let database = try SylDatabase.inMemory()
        let store = LocalStore(database: database)
        let base = try Instant.parse("2026-08-09T07:00:03.114Z")
        try store.upsert(
            (1...2_000).map { seq in
                Message(
                    id: "syl:message:0198f2c0-0001-7000-8000-\(String(format: "%012d", seq))",
                    conversationId: SylIDs.interactiveConversation,
                    clientId: nil,
                    role: seq.isMultiple(of: 2) ? .assistant : .user,
                    text: ChatFreezeFixture.paragraphs[seq % ChatFreezeFixture.paragraphs.count],
                    createdAt: base.addingTimeInterval(
                        Double(seq) * (MessageGrouping.maximumGap + 1)
                    ),
                    seq: seq
                )
            }
        )
        return store
    }

    /// Hosts the view in a real window.
    ///
    /// `ImageRenderer` cannot be used for this: it lays out nothing inside a `ScrollView`
    /// — an offscreen host never gives the scroll view a content size — which is exactly
    /// the geometry under measurement. Only a hosted window has a viewport at all.
    fileprivate func present(_ view: ChatView) -> UIWindow {
        ChatRowCensus.reset()
        let window = UIWindow(frame: CGRect(origin: .zero, size: Self.screen))
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        return window
    }

    fileprivate func dismiss(_ window: UIWindow) {
        window.isHidden = true
        window.rootViewController = nil
    }

    /// Lets SwiftUI do the work it was asked to do.
    ///
    /// A layout pass is not synchronous with a state change, so an assertion made
    /// immediately after one measures the frame before it — which is a probe that reads
    /// zero no matter what the view does, and it would have made the keystroke test pass
    /// on the unfixed code.
    fileprivate func settle(_ window: UIWindow, passes: Int = 6) async {
        for _ in 0..<passes {
            try? await Task.sleep(for: .milliseconds(20))
            window.layoutIfNeeded()
        }
    }
    /// The one scroll view in the transcript, found by walking the hosted hierarchy.
    fileprivate func transcriptScrollView(in window: UIWindow) -> UIScrollView? {
        func search(_ view: UIView) -> UIScrollView? {
            if let scroll = view as? UIScrollView { return scroll }
            for child in view.subviews {
                if let found = search(child) { return found }
            }
            return nil
        }
        return window.rootViewController.flatMap { search($0.view) }
    }
}

/// What first paint costs, in rows (`syl-025.2.1`).
///
/// The other half of the freeze, and the half no test had ever asserted.
/// `ChatInlineRenderCostTests` above proves a row is not re-parsed. This proves how many
/// rows there are to parse — the multiplier that turned a survivable per-visible-row cost
/// into a watchdog kill.
///
/// ## The mechanism this file used to assert, and what replaced it
///
/// It said `.defaultScrollAnchor(.bottom)` must know the transcript's total height, so the
/// `LazyVStack` sizes **every** row in the window. Measured on iOS 26.2 (2026-08-14), that
/// is **false**: it builds a bounded region of about forty rows whether the window holds
/// fifty or four hundred. The anchor's cost is real and it does **not** scale.
///
/// ## Two assertions, and only one of them is a requirement
///
/// The **ratio** is the requirement, and it is the one no screen size, row height or
/// prefetch policy can fake: if the transcript is lazy, widening the window from one page
/// to eight changes what scrolling can reach and changes nothing about the first frame.
///
/// The **absolute bound is a characterisation, not a target.** It records a cost the
/// Commander has accepted — he ruled on 2026-08-15 to keep the anchor, against the
/// measured alternatives: positioning by identity opens 6,921 points from the newest
/// message ten launches out of ten, and inverting the transcript reverses VoiceOver
/// reading order. Forty rows where six are visible is the price of landing on the newest
/// message every single time, and it is worth it.
///
/// So the number is deliberately tight. If it moves, someone should have to look at it and
/// decide again rather than discover it in a profile.
final class ChatRowLayoutCostTests: ChatHostedTranscriptCase {

    func testShouldBuildABoundedRegionRatherThanTheWholeWindow() async throws {
        let model = try await longConversationModel()
        let window = present(ChatView(model: model))
        defer { dismiss(window) }
        await settle(window)

        let built = ChatRowCensus.rowsBuilt
        // **A probe that can read zero passes when the view renders nothing at all**,
        // which is precisely how `ImageRenderer` behaves on a `ScrollView`. The floor is
        // not decoration; without it this test would go green on an empty screen.
        XCTAssertGreaterThan(built, 0, "no transcript row was built — the probe is measuring nothing")
        XCTAssertLessThanOrEqual(
            built,
            45,
            """
            First paint built \(built) transcript rows where the accepted cost is forty. \
            That number is a characterisation of the scroll anchor the Commander chose to \
            keep, not a target — so a change here is not a failure to fix, it is a change \
            to understand. Measure it, and if the anchor is still in place and the count \
            has moved, find out what moved it before touching this line.
            """
        )
    }

    /// The property that no screen size, row height or prefetch policy can fake.
    ///
    /// An absolute bound is a guess about how many rows fit and how far ahead SwiftUI
    /// reads. **This one is not a guess**: if the transcript is genuinely lazy, widening
    /// the window from one page to eight changes what is reachable by scrolling and
    /// changes nothing about what is built for the first frame. If total content height is
    /// required — which is what a bottom scroll anchor asks for — the count tracks the
    /// window, and the ratio is the defect.
    func testShouldNotBuildMoreRowsJustBecauseTheWindowIsWider() async throws {
        let store = try longConversationStore()

        let narrow = try await present(store: store, window: ChatPaging.pageSize)
        let wide = try await present(store: store, window: ChatPaging.pageSize * 8)
        // Printed, not merely asserted. This pair is the measurement `syl-025.2.2` picks
        // its anchor against, and a number that only appears when a test fails is a
        // number nobody can compare across a change.
        print("SYL_ROW_CENSUS window \(ChatPaging.pageSize) -> \(narrow) rows; window \(ChatPaging.pageSize * 8) -> \(wide) rows")

        XCTAssertLessThanOrEqual(
            wide,
            narrow + 5,
            """
            A window of \(ChatPaging.pageSize * 8) built \(wide) rows where a window of \
            \(ChatPaging.pageSize) built \(narrow). First paint costs what the window holds \
            rather than what the screen shows, so the transcript is not lazy at all and \
            every message he scrolls back to makes opening the chat more expensive.
            """
        )
    }

    func testShouldNotRebuildTheTranscriptWhenHeTypes() async throws {
        let model = try await longConversationModel()
        let window = present(ChatView(model: model))
        defer { dismiss(window) }
        await settle(window)

        ChatRowCensus.reset()
        // Ten characters, the way SC-002 states it.
        for character in "Remind me" {
            model.draft.text.append(character)
            await settle(window)
        }

        XCTAssertEqual(
            ChatRowCensus.rowsBuilt,
            0,
            """
            Typing rebuilt \(ChatRowCensus.rowsBuilt) transcript rows. `draft` publishes \
            from the same object the transcript observes, so every keystroke invalidates \
            `ChatView.body` and everything under it. Nothing he types is about the \
            transcript.
            """
        )
    }

}

/// Where first paint LANDS (`syl-025.2.2`, FR-006).
///
/// The other half of the anchor question, and the half that cannot be traded away.
/// `.defaultScrollAnchor(.bottom)` is expensive — `ChatRowLayoutCostTests` measures how
/// expensive — but it was added for a real reason, recorded in `ChatView` itself: an
/// `onChange`-only scroll to the foot **intermittently fails on long transcripts**.
/// Opening the chat somewhere in the middle of last week is worse than the defect this
/// epic started from, because it happens on every launch and there is nothing to do about
/// it but scroll.
///
/// So this asserts the property the anchor exists to guarantee, independently of how it is
/// achieved: after first paint on a 2,000-message transcript, the viewport is at the
/// newest message.
///
/// **Ten presentations, not one.** The failure on record is intermittent, and a single
/// green pass is exactly the evidence that produced that comment in the first place. A
/// candidate that lands nine times out of ten has not replaced the anchor; it has moved
/// the bug somewhere harder to see.
final class ChatFirstPaintPlacementTests: ChatHostedTranscriptCase {
    /// How far from the foot still counts as "at the newest message", in points.
    ///
    /// Not zero: the transcript carries vertical padding and a one-point sentinel, and
    /// insisting on an exact match would make this a test about rounding.
    private static let tolerance: CGFloat = 12

    func testShouldOpenAtTheNewestMessageEveryTimeOnALongTranscript() async throws {
        var shortfalls: [CGFloat] = []

        for attempt in 1...10 {
            let model = try await longConversationModel()
            let window = present(ChatView(model: model))
            await settle(window)

            let scroll = try XCTUnwrap(
                transcriptScrollView(in: window),
                "attempt \(attempt): no scroll view was hosted, so nothing was measured"
            )
            // Without this the test passes on a transcript that never laid out: a content
            // size no taller than the viewport is trivially "at the bottom".
            XCTAssertGreaterThan(
                scroll.contentSize.height,
                scroll.bounds.height,
                "attempt \(attempt): the transcript is not taller than the screen, so placement means nothing"
            )

            shortfalls.append(
                scroll.contentSize.height - (scroll.contentOffset.y + scroll.bounds.height)
            )
            dismiss(window)
        }

        print("SYL_FIRST_PAINT shortfall from foot, 10 attempts: \(shortfalls.map { Int($0) })")

        let worst = shortfalls.max() ?? 0
        XCTAssertLessThanOrEqual(
            worst,
            Self.tolerance,
            """
            First paint came to rest \(Int(worst)) points above the newest message on at \
            least one of ten attempts (all: \(shortfalls.map { Int($0) })). He opens the \
            chat and is somewhere in the middle of his own history. FR-006 is the property \
            `.defaultScrollAnchor(.bottom)` was added to guarantee, and it is not \
            negotiable against the cost of guaranteeing it.
            """
        )
    }
}

/// Does the transcript widen its own window when nobody touches it? (`syl-025.1.3`)
///
/// **This is the seam that did not exist**, and its absence was the honest caveat on the
/// whole of Phase 1: every other test of the runaway drives model methods by hand, in an
/// order a real rebuild does not follow, so none of them can catch the defect coming back.
/// The defect lives in the SwiftUI lifecycle, and only a hosted view has one.
///
/// It asserts the property directly — a transcript that is presented and then left alone
/// holds the window it opened with — rather than any theory about why a row's `onAppear`
/// fires. That matters, because the theory has now been wrong twice: it is not "was
/// instantiated" (a rebuild), it is realised-or-derealised, which is **geometry**. Which
/// makes position in the stack the discriminator: `EarlierMessages` sits directly above
/// where older messages are inserted, so every load moves it relative to the viewport,
/// while the foot sentinel is the last element and nothing is ever inserted below it. Same
/// two lines of code, opposite verdicts.
///
/// A property this test asserts survives being wrong about all of that.
///
/// **Measured during the wait, not after it.** A settle loop that samples only at the end
/// smooths away a load that fired, widened, and completed — which is the most likely
/// surviving form of the bug and precisely what the assertion needs to see.
final class ChatUnattendedGrowthTests: ChatHostedTranscriptCase {
    func testShouldHoldTheWindowItOpenedWithWhenNobodyTouchesTheScreen() async throws {
        let model = try await longConversationModel()
        let window = present(ChatView(model: model))
        defer { dismiss(window) }

        // Two seconds of nothing happening, watched throughout.
        var widest = model.snapshot.groups.flatMap(\.messages).count
        for _ in 0..<100 {
            try? await Task.sleep(for: .milliseconds(20))
            window.layoutIfNeeded()
            widest = max(widest, model.snapshot.groups.flatMap(\.messages).count)
        }

        print("SYL_UNATTENDED widest window over 2s of idle: \(widest) messages")
        XCTAssertEqual(
            widest,
            ChatPaging.pageSize,
            """
            The transcript grew to \(widest) messages with nobody touching the screen. \
            A load reassigns the snapshot, which rebuilds the stack, which moves the \
            "earlier" row relative to the viewport, which loads again — and it stops only \
            when the entire conversation is resident.
            """
        )
    }

    /// **The reproduction, committed so it can be run again.**
    ///
    /// This epic removed a trigger on the strength of a diagnosis, and the experiment that
    /// showed the diagnosis was wrong was a local edit that no longer existed ten minutes
    /// later. `CLAUDE.md` asks for a version stamp AND a re-run on a load-bearing
    /// measurement; a re-run needs the apparatus to exist. `ChatView` carries the pre-fix
    /// shape behind a flag, and this is what drives it.
    ///
    /// It is a **characterisation** test, deliberately. It does not assert that the old
    /// code was fine — it records what the old code actually did on the OS it was measured
    /// on, so that "the runaway does not reproduce" is a claim someone can check in a year
    /// rather than a sentence in a commit message.
    func testShouldNotRunAwayEvenWithTheLegacyTriggerRestored() async throws {
        let model = try await longConversationModel()
        let window = present(ChatView(model: model, reproducesTheLegacyTopTrigger: true))
        defer { dismiss(window) }
        await settle(window)

        let scroll = try XCTUnwrap(transcriptScrollView(in: window))

        var widest = model.snapshot.groups.flatMap(\.messages).count
        for _ in 0..<100 {
            scroll.setContentOffset(CGPoint(x: 0, y: 0), animated: false)
            try? await Task.sleep(for: .milliseconds(20))
            window.layoutIfNeeded()
            widest = max(widest, model.snapshot.groups.flatMap(\.messages).count)
        }

        print("SYL_LEGACY widest window with the pre-fix onAppear, 2s at the top: \(widest)")
        XCTAssertEqual(
            widest,
            ChatPaging.pageSize * 2,
            """
            With the pre-fix `.onAppear` restored the window reached \(widest). It loads one \
            page per arrival at the top and stops — `onAppear` is realisation, and this row \
            keeps its identity and its position at offset zero across a widen, so it never \
            derealises and never fires twice. A four-figure number here would mean the \
            runaway this epic was planned around is real after all.
            """
        )
    }

    /// The flag is reproduction apparatus and must never be on in a shipped build.
    func testShouldNeverShipWithTheLegacyTriggerOn() {
        XCTAssertFalse(
            ChatView(model: ChatViewModel(store: LocalStore(database: try! .inMemory())))
                .reproducesTheLegacyTopTrigger,
            "the pre-fix runaway trigger is on by default"
        )
    }

    /// The scenario the first-paint test cannot reach: he actually goes to the top.
    ///
    /// At first paint the "earlier" row is nowhere near the viewport and is never realised,
    /// so nothing fires. The question the epic turns on is what happens once it IS realised
    /// — one load per arrival, or a load that re-fires itself on the rebuild it caused.
    func testShouldLoadOneWindowWorthWhenHeReachesTheTopAndWaits() async throws {
        let model = try await longConversationModel()
        let window = present(ChatView(model: model))
        defer { dismiss(window) }
        await settle(window)

        let scroll = try XCTUnwrap(transcriptScrollView(in: window))

        // Two seconds parked at the top of the loaded range, watched throughout. Each
        // pass re-pins to the top, because a load that inserts above would otherwise
        // carry him away from it and end the scenario early.
        var widest = model.snapshot.groups.flatMap(\.messages).count
        for _ in 0..<100 {
            scroll.setContentOffset(CGPoint(x: 0, y: 0), animated: false)
            try? await Task.sleep(for: .milliseconds(20))
            window.layoutIfNeeded()
            widest = max(widest, model.snapshot.groups.flatMap(\.messages).count)
        }

        print("SYL_AT_TOP widest window after 2s parked at the top: \(widest) messages")
        // **Exact, not a ceiling.** `<= pageSize * 2` is satisfied by 100 and equally by
        // 50 — and 50 is what a run where the re-pin never reached the top would report,
        // so the ceiling alone cannot tell "he arrived and one page loaded" from "he never
        // arrived at all". A bound with no floor passes hardest when the scenario did not
        // happen, which is the same failure the write-census floors exist to catch.
        XCTAssertEqual(
            widest,
            ChatPaging.pageSize * 2,
            """
            Parked at the top, the window reached \(widest) messages where one page on top \
            of the opening page is \(ChatPaging.pageSize * 2). Below that and he never got \
            to the top, so nothing was tested; above it and a load re-triggered itself on \
            the rebuild it caused.
            """
        )
    }
}

/// Reaching back through history, at the seam where it actually happens (`syl-025.3.1`).
///
/// All three assertions are made against **scroll geometry** rather than against model
/// calls, because that is where the requirements live: "the turn he was reading does not
/// move", "proximity to the top is the trigger", "resting short of the top loads nothing".
/// None of those can be stated in terms of a method being called.
///
/// Position preservation is asserted as *offset moved exactly as much as content grew*.
/// That is SC-004 without needing to identify a particular row: if everything added went
/// in above him and nothing shifted underneath, those two numbers are equal, and if the
/// view jumped they are not.
final class ChatReachingBackTests: ChatHostedTranscriptCase {
    /// How close to the top counts as "he is asking for more".
    private static let proximity: CGFloat = 400

    func testShouldNotMoveWhatHeIsReadingWhenOlderMessagesArePrepended() async throws {
        let model = try await longConversationModel()
        let window = present(ChatView(model: model))
        defer { dismiss(window) }
        await settle(window)

        let scroll = try XCTUnwrap(transcriptScrollView(in: window))
        // Somewhere in the middle of the loaded range, reading.
        scroll.setContentOffset(CGPoint(x: 0, y: Self.proximity), animated: false)
        await settle(window)

        // **Distance from the FOOT, not content size and not raw offset.**
        //
        // A `LazyVStack` recomputes its content size as rows are realised, so
        // `contentSize` moves for reasons that have nothing to do with messages arriving —
        // measured here at 4,753 both before and after a fifty-message prepend, because
        // the new rows were above the viewport and never realised. An assertion built on
        // it is reading noise.
        //
        // The newest message is the one thing that cannot move: history is added at the
        // other end. So his distance from it is the invariant, and both terms come from
        // the same frame.
        let before = scroll.contentSize.height - scroll.contentOffset.y - scroll.bounds.height
        let opened = model.snapshot.groups.flatMap(\.messages).count

        await model.loadEarlier()
        await settle(window, passes: 50)

        XCTAssertEqual(
            model.snapshot.groups.flatMap(\.messages).count,
            opened + ChatPaging.pageSize,
            "no history was prepended, so nothing was tested"
        )

        let after = scroll.contentSize.height - scroll.contentOffset.y - scroll.bounds.height
        XCTAssertEqual(
            after,
            before,
            accuracy: 2,
            """
            He was \(Int(before)) points from the newest message and is now \(Int(after)). \
            Fifty older turns arrived at the far end of the transcript; nothing he was \
            looking at should have moved. A change of \(Int(abs(after - before))) points is \
            the view jumping under his finger.
            """
        )
    }

    func testShouldLoadNothingWhileHeRestsShortOfTheTop() async throws {
        let model = try await longConversationModel()
        let window = present(ChatView(model: model))
        defer { dismiss(window) }
        await settle(window)

        let scroll = try XCTUnwrap(transcriptScrollView(in: window))
        let opened = model.snapshot.groups.flatMap(\.messages).count

        // Well up the transcript, and well short of the top.
        scroll.setContentOffset(
            CGPoint(x: 0, y: Self.proximity * 4),
            animated: false
        )
        for _ in 0..<50 {
            try? await Task.sleep(for: .milliseconds(20))
            window.layoutIfNeeded()
        }

        // Without this the test passes when the scroll never took: an unmoved viewport
        // loads nothing either, for reasons that have nothing to do with the requirement.
        XCTAssertGreaterThan(
            scroll.contentOffset.y,
            0,
            "the transcript never scrolled, so resting short of the top was never tested"
        )
        XCTAssertEqual(
            model.snapshot.groups.flatMap(\.messages).count,
            opened,
            "proximity to the top is the trigger, not the existence of the control"
        )
    }

    func testShouldLoadOnePageWhenHeScrollsToTheTop() async throws {
        let model = try await longConversationModel()
        let window = present(ChatView(model: model))
        defer { dismiss(window) }
        await settle(window)

        let scroll = try XCTUnwrap(transcriptScrollView(in: window))
        let opened = model.snapshot.groups.flatMap(\.messages).count

        scroll.setContentOffset(CGPoint(x: 0, y: 0), animated: false)
        for _ in 0..<50 {
            try? await Task.sleep(for: .milliseconds(20))
            window.layoutIfNeeded()
        }

        XCTAssertEqual(
            model.snapshot.groups.flatMap(\.messages).count,
            opened + ChatPaging.pageSize,
            """
            Reaching the top loaded \(model.snapshot.groups.flatMap(\.messages).count - opened) \
            messages. It must load exactly one page: fewer means he has to reach for a \
            control to keep going, more means the window is running away again.
            """
        )
    }
}


/// Photographs of the real transcript, for a human to look at (`syl-025.2.7`).
///
/// **Every claim in this epic is backed by a counter and none by anyone having seen the
/// screen.** That gap is what let a four-state control ship wired to a Bool: the states
/// were correct, tested, mutation-proven, and two of them could not occur.
///
/// This is not the shipped app end-to-end — the pairing gate needs a Keychain token, and
/// the only live service is the Commander's own. It IS the production `ChatView`, hosted
/// in a real `UIWindow`, laid out by real geometry, scrolled through a real `UIScrollView`,
/// rendering the real four states. What it cannot show is a finger.
///
/// Opt-in, like `ChatSnapshotRendering`, and it only ever produces images.
@MainActor
final class ChatScreenPhotographs: ChatHostedTranscriptCase {
    private var enabled: Bool {
        ProcessInfo.processInfo.environment["SYL_RENDER_SNAPSHOTS"] != nil
    }

    func testPhotographTheAcceptanceWalk() async throws {
        try XCTSkipUnless(enabled, "set SYL_RENDER_SNAPSHOTS=1 to produce screen images")
        let directory = try XCTUnwrap(
            FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        ).appendingPathComponent("chat-screens", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        print("SYL_SCREENS_AT \(directory.path)")

        // US1 — opening the chat on a long conversation.
        let model = try await longConversationModel()
        let window = present(ChatView(model: model))
        defer { dismiss(window) }
        await settle(window, passes: 25)
        try shoot(window, "01-first-paint", into: directory)

        let scroll = try XCTUnwrap(transcriptScrollView(in: window))

        // US2 — at the top of the loaded range, before the page arrives.
        await walkToTheTop(scroll, window)
        await settle(window, passes: 3)
        try shoot(window, "02-at-the-top-before", into: directory)

        // …and after. The pair is the jump, or the absence of one.
        await settle(window, passes: 60)
        try shoot(window, "03-at-the-top-after-a-page", into: directory)

        // US3 — the true beginning, which nobody has ever seen.
        let short = StubHistory(total: 60)
        let beginningModel = try await modelOver(short, holding: 51...60)
        let beginningWindow = present(ChatView(model: beginningModel))
        defer { dismiss(beginningWindow) }
        await settle(beginningWindow, passes: 25)
        await beginningModel.loadEarlier()
        await settle(beginningWindow, passes: 40)
        let atTop = try XCTUnwrap(transcriptScrollView(in: beginningWindow))
        await walkToTheTop(atTop, beginningWindow)
        await settle(beginningWindow, passes: 10)
        XCTAssertEqual(beginningModel.earlierMessagesState, .beginning)
        try shoot(beginningWindow, "04-the-beginning", into: directory)
        // The same frame with the scroll view's top-fade mask out of the path, to tell a
        // control that draws nothing from one the mask is hiding.
        if let content = atTop.subviews.first {
            let unmasked = UIGraphicsImageRenderer(bounds: CGRect(x: 0, y: 0, width: 393, height: 300)).image { context in
                content.layer.render(in: context.cgContext)
            }
            try XCTUnwrap(unmasked.pngData())
                .write(to: directory.appendingPathComponent("04b-beginning-unmasked.png"))
        }

        // US3 — offline, which must be tellable from the beginning at a glance.
        let offline = StubHistory(total: 500, failing: true)
        let offlineModel = try await modelOver(offline, holding: 451...500)
        let offlineWindow = present(ChatView(model: offlineModel))
        defer { dismiss(offlineWindow) }
        await settle(offlineWindow, passes: 25)
        await offlineModel.loadEarlier()
        await offlineModel.loadEarlier()
        await settle(offlineWindow, passes: 20)
        let offlineScroll = try XCTUnwrap(transcriptScrollView(in: offlineWindow))
        await walkToTheTop(offlineScroll, offlineWindow)
        await settle(offlineWindow, passes: 10)
        XCTAssertEqual(offlineModel.earlierMessagesState, .unreachable)
        try shoot(offlineWindow, "05-unreachable", into: directory)
    }

    /// The four states side by side, isolated from the transcript.
    ///
    /// The acceptance walk shows where the control sits; this shows what it IS. Question
    /// four of the walk -- can `beginning` be told from `unreachable` AT A GLANCE -- is a
    /// question about the control alone, and photographing it inside a scroll view mixes
    /// it up with masks, offsets and whatever happens to be above it.
    func testPhotographTheFourStates() throws {
        try XCTSkipUnless(enabled, "set SYL_RENDER_SNAPSHOTS=1 to produce screen images")
        let directory = try XCTUnwrap(
            FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        ).appendingPathComponent("chat-screens", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let stack = VStack(spacing: 24) {
            ForEach(EarlierMessagesState.allCases, id: \.self) { state in
                VStack(spacing: 4) {
                    Text(String(describing: state))
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.red)
                    EarlierMessages(state: state) {}
                }
            }
        }
        .padding(16)
        .frame(width: 393)
        .background(SylTheme.Colour.veil)

        let controller = UIHostingController(rootView: stack)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 560))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        window.layoutIfNeeded()

        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
            window.layer.render(in: context.cgContext)
        }
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("06-four-states.png"))
        window.isHidden = true
        window.rootViewController = nil
    }

    /// The true top of the content, which is NOT offset zero.
    ///
    /// The scroll view carries a top inset, so `setContentOffset(.zero)` comes to rest a
    /// full inset BELOW the first row -- and the head of the transcript sits in the gap,
    /// off-screen. The first version of these photographs did exactly that and produced a
    /// blank band where the divider should have been, which reads as a missing control.
    private func scrollToTheTop(_ scroll: UIScrollView) {
        scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
    }

    /// Walk to the top the way a finger does, rather than teleporting.
    ///
    /// **A `LazyVStack` does not have a content height; it has the height of what it has
    /// built.** On a sixty-message conversation the scroll view reported 862 points
    /// against a 696-point viewport — a scrollable range of 166 — because only about ten
    /// rows existed in the layout at all. So a single large step clamps to the top
    /// immediately and the walk is a teleport wearing a disguise, which is exactly the
    /// mistake this helper replaced.
    ///
    /// Reaching the beginning therefore means going up a little, letting rows come into
    /// being, and going again — because each realisation is what creates the space above
    /// to scroll into. The loop stops when neither the offset nor the content will move.
    private func walkToTheTop(_ scroll: UIScrollView, _ window: UIWindow, step: CGFloat = 120) async {
        var lastContent: CGFloat = -1
        var guardRail = 0
        while guardRail < 400 {
            let floor = -scroll.adjustedContentInset.top
            let settled = scroll.contentOffset.y <= floor + 0.5
                && scroll.contentSize.height == lastContent
            if settled { return }
            lastContent = scroll.contentSize.height
            scroll.setContentOffset(
                CGPoint(x: 0, y: max(floor, scroll.contentOffset.y - step)),
                animated: false
            )
            window.layoutIfNeeded()
            try? await Task.sleep(for: .milliseconds(10))
            guardRail += 1
        }
    }

    /// What the scroll view thinks it holds, for a report that needs numbers.
    fileprivate func geometry(_ scroll: UIScrollView) -> String {
        "offset=\(Int(scroll.contentOffset.y)) content=\(Int(scroll.contentSize.height)) bounds=\(Int(scroll.bounds.height))"
    }

    private func modelOver(
        _ server: StubHistory,
        holding range: ClosedRange<Int>
    ) async throws -> ChatViewModel {
        let database = try SylDatabase.inMemory()
        let store = LocalStore(database: database)
        try store.upsert(server.messages(from: range.lowerBound, through: range.upperBound))
        let model = ChatViewModel(
            store: store,
            fetchOlderMessages: server.fetch,
            now: { try! Instant.parse("2026-08-09T07:00:03.114Z") }
        )
        await model.refresh()
        return model
    }

    private func shoot(_ window: UIWindow, _ name: String, into directory: URL) throws {
        // `drawHierarchy(afterScreenUpdates:)` needs the window to be part of an on-screen
        // render pass and comes back white from a test host. The layer tree is present
        // either way.
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
            window.layer.render(in: context.cgContext)
        }
        let data = try XCTUnwrap(image.pngData())
        try data.write(to: directory.appendingPathComponent("\(name).png"))
    }
}

/// The stub server, shared with `ChatViewModelTests`.
typealias StubHistory = ChatViewModelTests.StubHistory
