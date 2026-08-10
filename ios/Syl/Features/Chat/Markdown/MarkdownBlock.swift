import Foundation

/// The block model, ported from Adjutant's `MarkdownParser.swift`.
///
/// Two deliberate departures from the original:
///
/// 1. **Inline content is a raw `String`, not `[MarkdownInline]`.** Adjutant hand-rolled
///    ~110 lines of delimiter scanning to build an inline tree; we hand the raw run to
///    `MarkdownInline.render(_:)`, which uses Foundation's own markdown parser. That
///    deletes the fiddliest, least-tested code in the file and makes links tappable,
///    which Adjutant's renderer never managed.
/// 2. **Everything is `Sendable`.** These values are produced on the detached task inside
///    `ChatSnapshotLoader.load()` and consumed on the main actor, so they cross an actor
///    boundary by design. Swift 6 will not let that compile otherwise.
///
/// Column alignment for a GFM table column.
enum TableAlignment: Equatable, Sendable {
    case left
    case center
    case right
}

/// A block-level markdown element.
///
/// The associated `String` values are **unrendered inline markdown** — `**bold**` is
/// still `**bold**` here. Rendering is `MarkdownInline`'s job, and any link inside is
/// still subject to `LinkPolicy`.
enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case codeBlock(language: String?, code: String)
    /// Nested blocks, in full. A renderer **must** recurse through its ordinary block
    /// switch here: Adjutant's `blockquoteContent` special-cased paragraphs and headings
    /// and returned `EmptyView()` for everything else, so a list, a table or a code block
    /// inside a quote silently disappeared. That is data loss, not a limitation (R2).
    case blockquote([MarkdownBlock])
    case unorderedList([String])
    /// `start` is the ordinal the source actually wrote. Adjutant rendered the loop index,
    /// so a list beginning at `3.` came out as `1.` (R3).
    case orderedList(start: Int, items: [String])
    case horizontalRule
    case table(headers: [String], alignments: [TableAlignment], rows: [[String]])
    case taskList([TaskItem])

    /// One `- [ ]` / `- [x]` row. A struct rather than Adjutant's tuple: tuples are
    /// neither `Equatable` nor `Sendable` for free, which is why the original carried a
    /// 25-line hand-written `==`.
    struct TaskItem: Equatable, Sendable {
        var checked: Bool
        var text: String

        init(checked: Bool, text: String) {
            self.checked = checked
            self.text = text
        }
    }
}
