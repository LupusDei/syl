import Foundation
import SwiftUI

/// Turns one inline run — the raw string a `MarkdownBlock` carries — into an
/// `AttributedString` the renderer can hand straight to `Text`.
///
/// This replaces Adjutant's `parseInline`: ~110 lines of hand-rolled delimiter scanning
/// that built an inline tree, which its renderer then folded back into a single `Text`
/// with `+`. That fold is why Adjutant's links were never tappable. Foundation parses the
/// same syntax correctly and returns a real `.link` attribute, so the whole thing becomes
/// a call plus a sanitiser.
///
/// `.inlineOnlyPreservingWhitespace` is the load-bearing option. The block scanner has
/// already decided where paragraphs end, so block interpretation here would fight it —
/// and whitespace preservation is what keeps a soft newline the Commander meant.
enum MarkdownInline {

    private static let options = AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace,
        // A half-typed message is a malformed document, and once streaming lands it is
        // malformed on every keystroke (R5). Salvage what parsed; never throw the words
        // away.
        failurePolicy: .returnPartiallyParsedIfPossible
    )

    /// Renders an inline run. Never throws and never returns less than the source text:
    /// if parsing fails outright, the raw string is the answer.
    ///
    /// `LinkPolicy` runs **inside** this function rather than beside it, so no call site
    /// can render a run and forget to sanitise it.
    ///
    /// ## Memoised, and this is the freeze
    ///
    /// Every call site is inside a SwiftUI `body` — `MarkdownView` renders paragraphs,
    /// headings, list rows (twice, the second time for the VoiceOver label) and table
    /// cells — and `ChatView.body` re-runs on every presence frame.
    ///
    /// **Two multipliers this comment used to name are gone, and both were measured
    /// rather than argued** (`syl-025`, iOS 26.2, 2026-08-14):
    ///
    /// - *"every keystroke"* was true until `syl-025.2.3`. The draft now lives on its own
    ///   observable (`ChatDraft`), held by the view model as a plain `let`, so typing
    ///   invalidates the composer and nothing else. Measured at twenty transcript rows
    ///   rebuilt per nine keystrokes, then zero.
    /// - *"sizes every row in the window"* was never re-measured after it was written, and
    ///   on this OS it is false. `.defaultScrollAnchor(.bottom)` builds a bounded region of
    ///   about forty rows whether the window holds fifty or four hundred. Still worth
    ///   memoising — forty rows where six are visible is 6.7x, re-paid per body pass — but
    ///   it is a fixed multiplier, not one that grows as he reaches back.
    ///
    /// Unmemoised, that makes one body pass a full parse of everything built, on the main
    /// thread. Enough of it is enough to stop the main thread answering, and a main thread
    /// that stops answering long enough is a watchdog termination rather than a slow
    /// screen — which is exactly what the Commander
    /// reported, three times.
    ///
    /// **The two earlier fixes were real and were not this one.** `ChatSnapshotLoader`
    /// moved *block* scanning off the main actor and `ChatSnapshot.blocksByGroup` stopped
    /// every row deep-comparing the whole transcript. Inline parsing was never in either,
    /// and the doc comment on `MarkdownView` has claimed "it never parses" the whole time.
    ///
    /// Caching the finished `AttributedString` is safe across appearance changes because
    /// the only colour applied is `SylTheme.Colour.luminance`, which is a *dynamic*
    /// `Color` — it carries its light and dark values and resolves against the trait
    /// collection at draw time, not here.
    static func render(_ source: String) -> AttributedString {
        if let hit = memo.value(for: source) { return hit }
        let rendered = parse(source)
        memo.store(rendered, for: source)
        return rendered
    }

    private static func parse(_ source: String) -> AttributedString {
        guard let parsed = try? AttributedString(markdown: source, options: options) else {
            return AttributedString(source)
        }
        return style(LinkPolicy.sanitize(parsed))
    }

    // MARK: - The memo

    /// How many rendered runs are kept.
    ///
    /// Comfortably more than one window of `ChatPaging.pageSize`, so an ordinary
    /// transcript never evicts anything it is about to be asked for again, and
    /// bounded so a session that reaches back through months of history cannot grow one.
    /// A cache that only ever grows is a leak with a good reputation — and the key here is
    /// message text, which is the largest thing this app holds.
    static let memoLimit = 512

    private static let memo = Memo(limit: memoLimit)

    /// Lock-guarded rather than an actor, for the reason `MarkdownCache` gives: every
    /// caller is a synchronous `body`, and an actor would force each of them to become
    /// asynchronous — which is the opposite of the point.
    private final class Memo: @unchecked Sendable {
        private let lock = NSLock()
        private let limit: Int
        private var entries: [String: AttributedString] = [:]

        init(limit: Int) {
            self.limit = limit
        }

        func value(for source: String) -> AttributedString? {
            lock.lock()
            defer { lock.unlock() }
            return entries[source]
        }

        func store(_ rendered: AttributedString, for source: String) {
            lock.lock()
            defer { lock.unlock() }
            // Cleared wholesale rather than evicted one at a time. There is no recency
            // information to evict *by* — tracking it would cost a write on every read,
            // which is the hot path this exists to keep cheap — and the next pass over a
            // live transcript refills only what that transcript actually uses.
            if entries.count >= limit { entries.removeAll(keepingCapacity: true) }
            entries[source] = rendered
        }

        func count() -> Int {
            lock.lock()
            defer { lock.unlock() }
            return entries.count
        }

        func reset() {
            lock.lock()
            defer { lock.unlock() }
            entries.removeAll()
        }
    }

    static func memoCountForTesting() -> Int { memo.count() }

    static func resetMemoForTesting() { memo.reset() }

    /// Give surviving links Syl's colour.
    ///
    /// Without this a link renders in the ambient tint, which resolves to stock system
    /// blue — the single most conspicuous violation of "no stock system colours remain",
    /// and it lands in the middle of her sentences where it is impossible to miss. It
    /// was the first thing visible in the render once markdown started working.
    ///
    /// Styling runs **after** `LinkPolicy`, deliberately. A refused link has already had
    /// its attribute stripped by then, so it stays ordinary text and is never painted to
    /// look tappable. Colouring first would advertise a `javascript:` link as a link and
    /// then quietly fail to open it, which is worse than either outcome alone.
    private static func style(_ attributed: AttributedString) -> AttributedString {
        var styled = attributed
        for run in styled.runs where run.link != nil {
            styled[run.range].foregroundColor = SylTheme.Colour.luminance
            styled[run.range].underlineStyle = .single
        }
        return styled
    }
}
