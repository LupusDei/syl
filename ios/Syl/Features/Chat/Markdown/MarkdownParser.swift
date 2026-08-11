import Foundation

/// Scans markdown into `[MarkdownBlock]`.
///
/// Ported from Adjutant's `MarkdownParser.swift`, which was 543 lines of pure Foundation
/// with zero tests. What came across is the **block scanner**. What deliberately did not
/// is `parseInline` — ~110 lines of hand-rolled delimiter scanning, the fiddliest and
/// least-covered code in the original. Inline runs are carried through raw and rendered
/// by `MarkdownInline`, which hands them to Foundation's own markdown parser and gets
/// tappable links for free.
///
/// **Pure and free of I/O**, so it runs on the detached task inside
/// `ChatSnapshotLoader.load()` and the main actor only ever receives finished blocks.
/// Parse **per message, never per group**: `MessageGroup.text` joins with `"\n\n"`, and
/// parsing the join would let an unclosed fence in one message swallow the next.
enum MarkdownParser {

    /// How deep blockquote nesting is followed before the remainder is kept as raw text.
    ///
    /// Parsing runs on a detached task, whose stack is a fraction of the main thread's,
    /// so `parse` recursing once per `>` is a crash any message can cause — a few
    /// thousand markers is a handful of bytes to send. Beyond the cap the rest of the
    /// quote is preserved verbatim as a paragraph: bounded, never dropped.
    static let maximumBlockquoteDepth = 16

    /// The deepest ``MarkdownBlock/ListItem/depth`` this parser will report.
    ///
    /// Four levels below the top is more structure than any answer worth reading has, and
    /// past it the indent alone would eat the width of a phone. Deeper items **clamp** to
    /// this depth — they are still there, still in order, just no longer distinguished
    /// from their parent. Same instinct as ``maximumBlockquoteDepth``: bounded, never
    /// dropped. Depth is derived with a stack rather than recursion, so this is a
    /// legibility bound rather than a safety one.
    static let maximumListDepth = 4

    static func parse(_ input: String) -> [MarkdownBlock] {
        parse(input, depth: 0)
    }

    // MARK: - Block scanning

    private static func parse(_ input: String, depth: Int) -> [MarkdownBlock] {
        let lines = splitLines(input)
        var blocks: [MarkdownBlock] = []
        var index = 0

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                index += 1
                continue
            }

            // Fenced code block. An unclosed fence runs to the end of the input, which is
            // what CommonMark says and what keeps a half-streamed message readable.
            if trimmed.hasPrefix("```") {
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var codeLines: [String] = []
                index += 1
                while index < lines.count {
                    if lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                        index += 1
                        break
                    }
                    codeLines.append(lines[index])
                    index += 1
                }
                blocks.append(
                    .codeBlock(
                        language: language.isEmpty ? nil : language,
                        code: codeLines.joined(separator: "\n")
                    )
                )
                continue
            }

            if let heading = parseHeading(trimmed) {
                blocks.append(.heading(level: heading.level, text: heading.text))
                index += 1
                continue
            }

            // Before the unordered list, or `- - -` becomes a bullet.
            if isHorizontalRule(trimmed) {
                blocks.append(.horizontalRule)
                index += 1
                continue
            }

            if isBlockquote(trimmed) {
                var quoteLines: [String] = []
                while index < lines.count {
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    guard isBlockquote(candidate) else { break }
                    quoteLines.append(stripQuoteMarker(candidate))
                    index += 1
                }
                let inner = quoteLines.joined(separator: "\n")
                if depth >= maximumBlockquoteDepth {
                    blocks.append(.blockquote([.paragraph(inner)]))
                } else {
                    blocks.append(.blockquote(parse(inner, depth: depth + 1)))
                }
                continue
            }

            // A table is a line with a pipe whose successor is a separator row.
            if trimmed.contains("|"), index + 1 < lines.count,
                isTableSeparator(lines[index + 1].trimmingCharacters(in: .whitespaces))
            {
                let headers = parseTableRow(trimmed)
                let alignments = parseTableAlignments(
                    lines[index + 1].trimmingCharacters(in: .whitespaces),
                    columnCount: headers.count
                )
                index += 2
                var rows: [[String]] = []
                while index < lines.count {
                    let rowLine = lines[index].trimmingCharacters(in: .whitespaces)
                    guard rowLine.contains("|"), !isTableSeparator(rowLine) else { break }
                    rows.append(normalise(parseTableRow(rowLine), to: headers.count))
                    index += 1
                }
                blocks.append(.table(headers: headers, alignments: alignments, rows: rows))
                continue
            }

            // Every kind of list is scanned as **one run**, because nesting crosses the
            // kinds: `- parent` with `1. child` under it is one structure, and measuring
            // the child's depth needs the parent in the same pass. The run is split back
            // into blocks by kind afterwards.
            if listKind(trimmed) != nil {
                var rows: [ListRow] = []
                while index < lines.count {
                    let candidate = lines[index]
                    let candidateTrimmed = candidate.trimmingCharacters(in: .whitespaces)
                    guard let kind = listKind(candidateTrimmed) else { break }
                    rows.append(
                        ListRow(kind: kind, indent: indentWidth(candidate), content: candidateTrimmed)
                    )
                    index += 1
                }
                blocks.append(contentsOf: listBlocks(rows))
                continue
            }

            // Paragraph: every consecutive line that starts no other block.
            var paragraphLines: [String] = []
            while index < lines.count {
                let candidate = lines[index]
                let candidateTrimmed = candidate.trimmingCharacters(in: .whitespaces)
                if candidateTrimmed.isEmpty || candidateTrimmed.hasPrefix("```")
                    || parseHeading(candidateTrimmed) != nil
                    || isHorizontalRule(candidateTrimmed) || isBlockquote(candidateTrimmed)
                    || listKind(candidateTrimmed) != nil
                {
                    break
                }
                if candidateTrimmed.contains("|"), index + 1 < lines.count,
                    isTableSeparator(lines[index + 1].trimmingCharacters(in: .whitespaces))
                {
                    break
                }
                paragraphLines.append(candidate)
                index += 1
            }
            if paragraphLines.isEmpty {
                // Defensive: every branch above either consumes a line or falls through
                // to a paragraph that consumes one. If that ever stops being true this
                // stops the loop spinning forever on a message we cannot see.
                index += 1
            } else {
                blocks.append(.paragraph(paragraphLines.joined(separator: "\n")))
            }
        }

        return blocks
    }

    /// Splits on `\n`, `\r\n` and a lone `\r`. Nothing guarantees the wire uses one of
    /// them, and a stray `\r` inside a paragraph is an invisible control character in a
    /// bubble.
    private static func splitLines(_ input: String) -> [String] {
        input
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
    }

    // MARK: - Block helpers

    private static func parseHeading(_ line: String) -> (level: Int, text: String)? {
        guard line.hasPrefix("#") else { return nil }
        var level = 0
        for character in line {
            guard character == "#" else { break }
            level += 1
        }
        guard (1...6).contains(level) else { return nil }
        let rest = line.dropFirst(level)
        guard rest.first == " " else { return nil }
        return (level, String(rest.dropFirst()).trimmingCharacters(in: .whitespaces))
    }

    private static func isHorizontalRule(_ line: String) -> Bool {
        let stripped = line.filter { !$0.isWhitespace }
        guard stripped.count >= 3, let first = stripped.first else { return false }
        guard first == "-" || first == "*" || first == "_" else { return false }
        return stripped.allSatisfy { $0 == first }
    }

    /// CommonMark permits `>quoted` with no space. Adjutant required `> ` and quietly
    /// demoted everything else to a paragraph — a quote that stops looking like a quote.
    private static func isBlockquote(_ line: String) -> Bool {
        line.hasPrefix(">")
    }

    private static func stripQuoteMarker(_ line: String) -> String {
        var rest = Substring(line).dropFirst()
        if rest.first == " " { rest = rest.dropFirst() }
        return String(rest)
    }

    private static func isUnorderedListItem(_ line: String) -> Bool {
        if isTaskListItem(line) { return false }
        return line.hasPrefix("- ") || line.hasPrefix("* ")
    }

    private static func stripBullet(_ line: String) -> String {
        guard line.hasPrefix("- ") || line.hasPrefix("* ") else { return line }
        return String(line.dropFirst(2))
    }

    private static func isOrderedListItem(_ line: String) -> Bool {
        orderedListOrdinal(line) != nil
    }

    /// The number an ordered-list line opens with, or `nil` if it is not one.
    private static func orderedListOrdinal(_ line: String) -> Int? {
        guard let dot = line.firstIndex(of: ".") else { return nil }
        let digits = line[line.startIndex..<dot]
        guard !digits.isEmpty, digits.allSatisfy(\.isNumber) else { return nil }
        let afterDot = line.index(after: dot)
        guard afterDot < line.endIndex, line[afterDot] == " " else { return nil }
        return Int(digits)
    }

    private static func stripOrderedPrefix(_ line: String) -> String {
        guard let dot = line.firstIndex(of: ".") else { return line }
        let afterDot = line.index(after: dot)
        guard afterDot < line.endIndex, line[afterDot] == " " else { return line }
        return String(line[line.index(after: afterDot)...])
    }

    // MARK: - Lists and nesting (R1)
    //
    // The defect this section exists for: `parse` trimmed each line before matching, so
    // the indentation that says "this item belongs to the one above" was destroyed before
    // anything looked at it, and every nested item came out a sibling. Claude emits nested
    // lists constantly, and a plan whose sub-steps render as top-level steps does not
    // merely look worse — it asserts a different plan than the one she wrote.

    private enum ListKind {
        case unordered
        case ordered
        case task
    }

    /// One source line of a list run, before its depth is known.
    private struct ListRow {
        var kind: ListKind
        /// Leading whitespace measured in columns.
        var indent: Int
        /// The line with surrounding whitespace removed — still carrying its marker.
        var content: String
    }

    private static func listKind(_ trimmed: String) -> ListKind? {
        if isTaskListItem(trimmed) { return .task }
        if isUnorderedListItem(trimmed) { return .unordered }
        if isOrderedListItem(trimmed) { return .ordered }
        return nil
    }

    /// Leading whitespace in columns, with a tab advancing to the next four-column stop.
    ///
    /// Columns rather than characters because a tab and four spaces mean the same nesting
    /// to whoever wrote them, and a message can contain both.
    private static func indentWidth(_ line: String) -> Int {
        var width = 0
        for character in line {
            if character == " " {
                width += 1
            } else if character == "\t" {
                width += 4 - (width % 4)
            } else {
                break
            }
        }
        return width
    }

    /// Depth for each row of a run, from the *shape* of the indentation rather than its
    /// size.
    ///
    /// A stack of open indent widths: a wider indent than the one on top opens a level, a
    /// narrower one closes levels until it fits, and an equal one is a sibling. Nothing is
    /// divided by a fixed number, which matters because two-space and four-space nesting
    /// are both ordinary markdown and a constant divisor gets one of them wrong. It also
    /// means a run that jumps two levels at once — `- a` then six spaces — nests by one,
    /// which is both what CommonMark says and the only reading that cannot invent a level
    /// nobody wrote.
    ///
    /// Iterative on purpose. The blockquote scanner above recurses and had to be capped at
    /// 16 because parsing runs on a detached task with a small stack; a stack in an array
    /// cannot have that problem at all.
    private static func depths(for rows: [ListRow]) -> [Int] {
        var open: [Int] = []
        var result: [Int] = []
        result.reserveCapacity(rows.count)

        for row in rows {
            while let innermost = open.last, row.indent < innermost {
                open.removeLast()
            }
            if let innermost = open.last {
                if row.indent > innermost { open.append(row.indent) }
            } else {
                open.append(row.indent)
            }
            result.append(min(open.count - 1, maximumListDepth))
        }
        return result
    }

    /// Splits a scanned run into blocks, one per stretch of the same kind.
    ///
    /// The block model is flat by design — a bulleted list containing an ordered sub-list
    /// cannot be one `case` — so the run becomes `.unorderedList` then `.orderedList` and
    /// the relationship survives in each item's `depth`. Depth is computed across the
    /// **whole** run before the split, so a sub-list that changes marker still knows it is
    /// a sub-list.
    private static func listBlocks(_ rows: [ListRow]) -> [MarkdownBlock] {
        let depths = depths(for: rows)
        var blocks: [MarkdownBlock] = []
        var start = 0

        while start < rows.count {
            let kind = rows[start].kind
            var end = start
            while end < rows.count, rows[end].kind == kind { end += 1 }
            let run = start..<end

            switch kind {
            case .unordered:
                blocks.append(
                    .unorderedList(
                        run.map { .init(depth: depths[$0], text: stripBullet(rows[$0].content)) }
                    )
                )
            case .task:
                blocks.append(
                    .taskList(run.map { parseTaskItem(rows[$0].content, depth: depths[$0]) })
                )
            case .ordered:
                // R3: the ordinal the source wrote, not the loop index. Adjutant rendered
                // the index, so a list beginning at `3.` came out as `1.`.
                let ordinal = orderedListOrdinal(rows[start].content) ?? 1
                blocks.append(
                    .orderedList(
                        start: ordinal,
                        items: run.map {
                            .init(depth: depths[$0], text: stripOrderedPrefix(rows[$0].content))
                        }
                    )
                )
            }
            start = end
        }
        return blocks
    }

    // MARK: - Task lists

    private static let taskMarkers = ["- [ ]", "- [x]", "- [X]"]

    private static func isTaskListItem(_ line: String) -> Bool {
        taskMarkers.contains { line.hasPrefix($0) }
    }

    private static func parseTaskItem(_ line: String, depth: Int) -> MarkdownBlock.TaskItem {
        let checked = line.hasPrefix("- [x]") || line.hasPrefix("- [X]")
        var text = Substring(line).dropFirst(5)
        if text.first == " " { text = text.dropFirst() }
        return .init(depth: depth, checked: checked, text: String(text))
    }

    // MARK: - Tables

    /// A GFM separator row: `|---|:--:|--:|`.
    private static func isTableSeparator(_ line: String) -> Bool {
        let stripped = line.trimmingCharacters(in: .whitespaces)
        guard stripped.contains("|"), stripped.contains("-") else { return false }
        let cells = splitTableCells(stripped)
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { cell in
            let trimmed = cell.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return true }
            guard trimmed.allSatisfy({ $0 == ":" || $0 == "-" }) else { return false }
            return trimmed.contains("-")
        }
    }

    private static func parseTableAlignments(_ line: String, columnCount: Int) -> [TableAlignment] {
        let cells = splitTableCells(line).map { $0.trimmingCharacters(in: .whitespaces) }
        return (0..<max(columnCount, 0)).map { column in
            guard column < cells.count else { return .left }
            let cell = cells[column]
            switch (cell.hasPrefix(":"), cell.hasSuffix(":")) {
            case (true, true): return .center
            case (false, true): return .right
            default: return .left
            }
        }
    }

    private static func parseTableRow(_ line: String) -> [String] {
        splitTableCells(line).map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func splitTableCells(_ line: String) -> [String] {
        var cells = line.components(separatedBy: "|")
        if let first = cells.first, first.trimmingCharacters(in: .whitespaces).isEmpty {
            cells.removeFirst()
        }
        if let last = cells.last, last.trimmingCharacters(in: .whitespaces).isEmpty {
            cells.removeLast()
        }
        return cells
    }

    /// Every row is exactly as wide as the header — GFM says so, and it is also what
    /// stops a renderer indexing off the end of a short row.
    private static func normalise(_ row: [String], to width: Int) -> [String] {
        guard row.count != width else { return row }
        if row.count > width { return Array(row.prefix(width)) }
        return row + Array(repeating: "", count: width - row.count)
    }
}
