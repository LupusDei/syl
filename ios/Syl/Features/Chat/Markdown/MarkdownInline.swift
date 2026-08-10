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
    static func render(_ source: String) -> AttributedString {
        guard let parsed = try? AttributedString(markdown: source, options: options) else {
            return AttributedString(source)
        }
        return style(LinkPolicy.sanitize(parsed))
    }

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
