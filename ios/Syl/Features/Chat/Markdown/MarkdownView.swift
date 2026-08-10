import SwiftUI

/// Renders parsed markdown blocks.
///
/// The *structure* of the block switch is ported from Adjutant's `MarkdownTextView`;
/// every style line is written against ``SylTheme/Typeface/Prose`` instead of Adjutant's
/// CRT theme, because a skin bound to twelve points of another app's palette does not
/// transfer.
///
/// ## It never parses
///
/// This view takes finished `[MarkdownBlock]`. Parsing happens once, off the main actor,
/// in `ChatSnapshotLoader`. Adjutant parses in `init` — on the main thread, on every body
/// re-evaluation — and `LazyVStack` re-evaluates a row's body every time it returns to
/// screen, so doing that here would undo the exact jank fix `ChatSnapshotLoader` exists
/// for, and it would fail silently as stutter on a phone rather than loudly as a test.
struct MarkdownView: View {
    let blocks: [MarkdownBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                MarkdownBlockView(block: block)
                    .padding(.top, index == 0 ? 0 : spaceBefore(block, after: blocks[index - 1]))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Vertical rhythm, decided by what the block *is*.
    ///
    /// A heading needs room above it to read as the start of something; a paragraph
    /// following a paragraph needs only a line's worth. Uniform spacing is what makes a
    /// rendered document read as a list of fragments.
    ///
    /// The `previous` block matters in exactly one case, and R1 created it: a bulleted
    /// list with an ordered sub-list is two adjacent blocks, because the flat block model
    /// cannot nest one case inside another. A full paragraph gap between them would undo
    /// the nesting the indent just established — the sub-list would read as a separate
    /// list that happens to sit further right. Adjacent lists get a row's worth instead.
    private func spaceBefore(_ block: MarkdownBlock, after previous: MarkdownBlock) -> CGFloat {
        switch block {
        case .heading(let level, _):
            return level <= 2 ? SylTheme.Metric.loose : SylTheme.Metric.step
        case .horizontalRule:
            return SylTheme.Metric.gutter
        case .unorderedList, .orderedList, .taskList:
            return isList(previous) ? SylTheme.Metric.tight : SylTheme.Metric.step
        default:
            return SylTheme.Metric.step
        }
    }

    private func isList(_ block: MarkdownBlock) -> Bool {
        switch block {
        case .unorderedList, .orderedList, .taskList: return true
        default: return false
        }
    }
}

/// One block. Split out so `blockquote` can recurse into it.
private struct MarkdownBlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .paragraph(let text):
            inline(text)
                .font(SylTheme.Typeface.Prose.body)
                .lineSpacing(SylTheme.Metric.proseLineSpacing)
                .foregroundStyle(SylTheme.Colour.ink)

        case .heading(let level, let text):
            heading(level: level, text: text)

        case .codeBlock(let language, let code):
            CodeBlockView(language: language, code: code)

        case .blockquote(let blocks):
            BlockquoteView(blocks: blocks)

        case .unorderedList(let items):
            VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    ListRow(
                        depth: item.depth,
                        marker: bullet(forDepth: item.depth),
                        markerFont: SylTheme.Typeface.Prose.body,
                        spokenMarker: nil,
                        text: item.text
                    )
                }
            }

        case .orderedList(let start, let items):
            OrderedListView(start: start, items: items)

        case .taskList(let items):
            VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    ListRow(
                        depth: item.depth,
                        marker: item.checked ? "☑" : "☐",
                        markerFont: SylTheme.Typeface.Prose.body,
                        spokenMarker: item.checked ? "Done" : "Not done",
                        text: item.text
                    )
                }
            }

        case .horizontalRule:
            Rectangle()
                .fill(SylTheme.Colour.hairline)
                .frame(height: SylTheme.Metric.hair)
                .accessibilityHidden(true)

        case .table(let headers, let alignments, let rows):
            TableView(headers: headers, alignments: alignments, rows: rows)
        }
    }

    /// Headings.
    ///
    /// Levels 1 and 2 are the serif, at the same size as a section heading on the home
    /// screen — a heading inside a message is not more important than a heading on the
    /// day. Level 3 and below become the letterspaced caps label instead of another size
    /// of dark text, so deep structure reads as a *section marker* rather than as
    /// shouting. It also stops the scale needing five heading sizes on a 390pt screen.
    @ViewBuilder
    private func heading(level: Int, text: String) -> some View {
        if level <= 1 {
            inline(text)
                .font(SylTheme.Typeface.Prose.heading)
                .foregroundStyle(SylTheme.Colour.ink)
        } else if level == 2 {
            inline(text)
                .font(SylTheme.Typeface.Prose.subheading)
                .foregroundStyle(SylTheme.Colour.ink)
        } else {
            inline(text)
                .sylLabelStyle()
                .foregroundStyle(SylTheme.Colour.inkSoft)
        }
    }

    private func inline(_ source: String) -> Text {
        Text(MarkdownInline.render(source))
    }

    /// The bullet for a nesting level.
    ///
    /// The glyph changes with depth so a sub-point is legible as a sub-point even when
    /// the indentation is not doing the work — which is most of the time at the largest
    /// Dynamic Type sizes, where twenty points of indent is a fraction of a line.
    ///
    /// There is one shape per level up to ``MarkdownParser/maximumListDepth``, which is
    /// where the parser clamps, so the wrap never happens on parsed input. It is there so
    /// a hand-built block cannot index off the end of the array.
    private func bullet(forDepth depth: Int) -> String {
        let shapes = ["•", "◦", "–", "▪", "‣"]
        let index = max(0, depth) % shapes.count
        return shapes[index]
    }
}

/// An ordered list, numbered by structure.
///
/// A view of its own rather than a case body, because the numbers have to be worked out
/// for the whole list before the first row is drawn — a sub-list restarts at `1.` and the
/// parent resumes where it left off, neither of which `start + index` can express.
private struct OrderedListView: View {
    let start: Int
    let items: [MarkdownBlock.ListItem]

    var body: some View {
        let numbers = MarkdownBlock.orderedNumbers(start: start, items: items)
        VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                let marker = "\(index < numbers.count ? numbers[index] : index + 1)."
                ListRow(
                    depth: item.depth,
                    marker: marker,
                    markerFont: SylTheme.Typeface.Prose.marker,
                    spokenMarker: marker,
                    text: item.text
                )
            }
        }
    }
}

/// A list row with a hanging indent.
///
/// The marker sits in its own column so wrapped lines align with the text rather than
/// with the bullet. Without it, a two-line item reads as two items.
///
/// ## Nesting has to survive VoiceOver
///
/// Indentation is invisible to a screen reader and the bullet shapes are read
/// inconsistently — `◦` may come out as "white bullet", or as nothing at all. So the
/// glyph is hidden from accessibility entirely and depth is stated in words instead: the
/// row is a single element whose label opens with "Level 2" and carries the marker's
/// *meaning* — the ordinal, or whether a task is done — rather than its shape. Without
/// this, a nested plan is read aloud as a flat one, which is the same defect R1 was
/// about, on the one surface nobody screenshots.
private struct ListRow: View {
    let depth: Int
    let marker: String
    let markerFont: Font
    /// What the marker *means*, for a screen reader. `nil` for a plain bullet, which
    /// carries no information worth saying out loud.
    let spokenMarker: String?
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: SylTheme.Metric.snug) {
            Text(marker)
                .font(markerFont)
                .foregroundStyle(SylTheme.Colour.luminance)
                // A fixed column, so markers line up down the list and the text column
                // is straight. `@ScaledMetric` so it grows with Dynamic Type instead of
                // clipping `10.` at the largest sizes.
                .frame(minWidth: markerColumn, alignment: .leading)
                .accessibilityHidden(true)

            Text(MarkdownInline.render(text))
                .font(SylTheme.Typeface.Prose.body)
                .lineSpacing(SylTheme.Metric.proseLineSpacing)
                .foregroundStyle(SylTheme.Colour.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel(Text(spokenLabel))
        }
        .padding(.leading, CGFloat(max(0, depth)) * SylTheme.Metric.gutter)
    }

    private var spokenLabel: String {
        var parts: [String] = []
        if depth > 0 { parts.append("Level \(depth + 1)") }
        if let spokenMarker, !spokenMarker.isEmpty { parts.append(spokenMarker) }
        parts.append(String(MarkdownInline.render(text).characters))
        return parts.joined(separator: ", ")
    }

    @ScaledMetric(relativeTo: .body) private var markerColumn: CGFloat = 22
}

/// A quoted passage.
///
/// **Recurses through the ordinary block switch.** Adjutant's `blockquoteContent`
/// special-cased paragraphs and headings and returned `EmptyView()` for everything else,
/// so a list, a table or a code block inside a quote silently vanished. That is data
/// loss, not a limitation (R2), and the parser now preserves those blocks specifically
/// so this view can render them.
private struct BlockquoteView: View {
    let blocks: [MarkdownBlock]

    var body: some View {
        HStack(alignment: .top, spacing: SylTheme.Metric.step) {
            Rectangle()
                .fill(SylTheme.Colour.hairline)
                .frame(width: 2)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                    MarkdownBlockView(block: block)
                }
            }
        }
        // Quoted material is something she is relaying rather than saying, so it is
        // quieter than her own voice — which is what the softer ink is for.
        .foregroundStyle(SylTheme.Colour.inkSoft)
    }
}

/// A fenced code block.
///
/// Scrolls horizontally rather than wrapping. Wrapping a command or a line of JSON at an
/// arbitrary column makes it unreadable *and* uncopyable, and it is the one place where
/// preserving the author's line breaks matters more than fitting the screen. Critically,
/// the slab must never force the bubble wider than the viewport — hence the scroll view
/// rather than a wide `Text`.
private struct CodeBlockView: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                // Adjutant captures the language and throws it away. It is free
                // information about what you are looking at.
                Text(language)
                    .sylLabelStyle()
                    .foregroundStyle(SylTheme.Colour.inkFaint)
                    .padding(.horizontal, SylTheme.Metric.step)
                    .padding(.top, SylTheme.Metric.snug)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(SylTheme.Typeface.Prose.code)
                    .foregroundStyle(SylTheme.Colour.ink)
                    .textSelection(.enabled)
                    .padding(SylTheme.Metric.step)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: SylTheme.Metric.codeRadius, style: .continuous)
                .fill(SylTheme.Colour.card.opacity(0.5))
                .overlay {
                    RoundedRectangle(cornerRadius: SylTheme.Metric.codeRadius, style: .continuous)
                        .strokeBorder(SylTheme.Colour.hairline, lineWidth: SylTheme.Metric.hair)
                }
        }
    }
}

/// A GFM table.
///
/// Scrolls horizontally as one unit, so the columns stay aligned with their headers. The
/// parser has already padded and clipped every row to the header width, so this can index
/// safely — a ragged row would otherwise run off the end of the array.
private struct TableView: View {
    let headers: [String]
    let alignments: [TableAlignment]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                row(headers, isHeader: true)

                Rectangle()
                    .fill(SylTheme.Colour.hairline)
                    .frame(height: SylTheme.Metric.hair)

                ForEach(Array(rows.enumerated()), id: \.offset) { _, cells in
                    row(cells, isHeader: false)
                }
            }
        }
    }

    private func row(_ cells: [String], isHeader: Bool) -> some View {
        HStack(alignment: .top, spacing: SylTheme.Metric.step) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                Group {
                    if isHeader {
                        Text(cell).sylLabelStyle()
                    } else {
                        Text(MarkdownInline.render(cell))
                            .font(SylTheme.Typeface.Prose.table)
                    }
                }
                .foregroundStyle(isHeader ? SylTheme.Colour.inkFaint : SylTheme.Colour.ink)
                .frame(minWidth: 64, alignment: alignment(at: index))
            }
        }
        .padding(.vertical, SylTheme.Metric.snug)
    }

    private func alignment(at index: Int) -> Alignment {
        guard index < alignments.count else { return .leading }
        switch alignments[index] {
        case .left: return .leading
        case .center: return .center
        case .right: return .trailing
        }
    }
}
