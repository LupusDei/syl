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
    case unorderedList([ListItem])
    /// `start` is the ordinal the source actually wrote. Adjutant rendered the loop index,
    /// so a list beginning at `3.` came out as `1.` (R3).
    ///
    /// It seeds only the level the **first** item sits at. A nested run inside the same
    /// block restarts at `1.` — see ``orderedNumbers(start:items:)``.
    case orderedList(start: Int, items: [ListItem])
    case horizontalRule
    case table(headers: [String], alignments: [TableAlignment], rows: [[String]])
    case taskList([TaskItem])

    /// One row of a list, and how deeply it is nested (R1).
    ///
    /// `depth` is `0` for a top-level row and rises by one per level. It is a **tree**
    /// depth, not a source indent width: `- a\n  - b` and `- a\n    - b` produce the same
    /// value, because real markdown uses two-space and four-space nesting interchangeably
    /// and Claude emits both. ``MarkdownParser/maximumListDepth`` bounds it.
    struct ListItem: Equatable, Sendable {
        var depth: Int
        var text: String

        init(depth: Int = 0, text: String) {
            self.depth = depth
            self.text = text
        }
    }

    /// One `- [ ]` / `- [x]` row. A struct rather than Adjutant's tuple: tuples are
    /// neither `Equatable` nor `Sendable` for free, which is why the original carried a
    /// 25-line hand-written `==`.
    struct TaskItem: Equatable, Sendable {
        var depth: Int
        var checked: Bool
        var text: String

        init(depth: Int = 0, checked: Bool, text: String) {
            self.depth = depth
            self.checked = checked
            self.text = text
        }
    }

    /// The number each row of an ordered list displays.
    ///
    /// Lives here rather than in the renderer because it is markdown semantics, not
    /// styling — and because a rule this fiddly has to be testable without a view.
    ///
    /// Three things it gets right that `start + index` does not:
    ///
    /// - **A nested run restarts at `1.`** Two sub-steps under step 3 are `1.` and `2.`,
    ///   not `4.` and `5.`. Rendering the parent's ordinal into a child asserts a
    ///   structure the author did not write, which is the whole reason R1 was fixed.
    /// - **Coming back out resumes the parent's count.** Step 3, two sub-steps, then
    ///   step 4 — not step 6.
    /// - **`start` seeds exactly one level**: the one the first item sits at. A list whose
    ///   first row is already indented still honours the ordinal it was written with.
    static func orderedNumbers(start: Int, items: [ListItem]) -> [Int] {
        // `counters[d]` is the ordinal most recently used at depth `d`. Everything deeper
        // than the current row is dropped, which is what makes a sub-list restart.
        var counters: [Int] = []
        var numbers: [Int] = []
        numbers.reserveCapacity(items.count)

        for item in items {
            let depth = max(0, item.depth)
            if depth < counters.count {
                counters.removeLast(counters.count - depth - 1)
                counters[depth] += 1
            } else {
                while counters.count <= depth {
                    counters.append(numbers.isEmpty && counters.count == depth ? start : 1)
                }
            }
            numbers.append(counters[depth])
        }
        return numbers
    }
}
