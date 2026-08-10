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
                    .padding(.top, index == 0 ? 0 : spaceBefore(block))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Vertical rhythm, decided by what the block *is*.
    ///
    /// A heading needs room above it to read as the start of something; a paragraph
    /// following a paragraph needs only a line's worth. Uniform spacing is what makes a
    /// rendered document read as a list of fragments.
    private func spaceBefore(_ block: MarkdownBlock) -> CGFloat {
        switch block {
        case .heading(let level, _):
            return level <= 2 ? SylTheme.Metric.loose : SylTheme.Metric.step
        case .horizontalRule:
            return SylTheme.Metric.gutter
        default:
            return SylTheme.Metric.step
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
                    ListRow(marker: "•", markerFont: SylTheme.Typeface.Prose.body, text: item)
                }
            }

        case .orderedList(let start, let items):
            VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    ListRow(
                        // `start + index`, not `index + 1`. A list that begins at 3.
                        // begins at 3.
                        marker: "\(start + index).",
                        markerFont: SylTheme.Typeface.Prose.marker,
                        text: item
                    )
                }
            }

        case .taskList(let items):
            VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    ListRow(
                        marker: item.checked ? "☑" : "☐",
                        markerFont: SylTheme.Typeface.Prose.body,
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
}

/// A list row with a hanging indent.
///
/// The marker sits in its own column so wrapped lines align with the text rather than
/// with the bullet. Without it, a two-line item reads as two items.
private struct ListRow: View {
    let marker: String
    let markerFont: Font
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

            Text(MarkdownInline.render(text))
                .font(SylTheme.Typeface.Prose.body)
                .lineSpacing(SylTheme.Metric.proseLineSpacing)
                .foregroundStyle(SylTheme.Colour.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
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
