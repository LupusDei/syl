import Foundation
import SwiftUI
import SylKit
import XCTest

@testable import Syl

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
    ///
    /// Built from the Commander's actual conversation rather than from `String(repeating:)`
    /// — the message that froze the app was 604 characters of ordinary prose with no code
    /// fences, no tables and no bullets, and a synthetic fixture of repeated characters
    /// would parse in a fraction of the time and quietly prove nothing.
    private static let paragraphs: [String] = [
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
