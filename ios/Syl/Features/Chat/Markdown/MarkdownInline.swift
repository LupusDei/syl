import Foundation

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
        return LinkPolicy.sanitize(parsed)
    }
}
