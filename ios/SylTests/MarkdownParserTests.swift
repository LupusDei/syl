import XCTest

@testable import Syl

/// The parser arrived from Adjutant with **zero tests** — 543 lines of hand-rolled
/// scanning covered only by `#Preview` blocks. These tests are not overhead on the port;
/// they are how we find out what we inherited. Where a known defect is being kept, the
/// test says so out loud and names the bead that owns the decision.
final class MarkdownParserTests: XCTestCase {

    // MARK: - Paragraphs

    func testShouldProduceNothingForEmptyInput() {
        XCTAssertTrue(MarkdownParser.parse("").isEmpty)
    }

    func testShouldProduceNothingForWhitespaceOnlyInput() {
        XCTAssertTrue(MarkdownParser.parse("   \n\n\t\n   ").isEmpty)
    }

    func testShouldParseASingleParagraph() {
        XCTAssertEqual(MarkdownParser.parse("Hello, Commander."), [.paragraph("Hello, Commander.")])
    }

    func testShouldKeepConsecutiveLinesInOneParagraphSeparatedByNewlines() {
        // GFM-style soft breaks: the lines belong together, and the newline is real.
        XCTAssertEqual(MarkdownParser.parse("one\ntwo"), [.paragraph("one\ntwo")])
    }

    func testShouldStartANewParagraphAtABlankLine() {
        XCTAssertEqual(MarkdownParser.parse("one\n\ntwo"), [.paragraph("one"), .paragraph("two")])
    }

    func testShouldLeaveInlineMarkupUnparsedInTheBlockModel() {
        // Inline is `MarkdownInline`'s job now, not the block scanner's. The block model
        // carries the raw run so nothing is decided twice.
        XCTAssertEqual(
            MarkdownParser.parse("a **bold** and `code` and [link](https://a.co)"),
            [.paragraph("a **bold** and `code` and [link](https://a.co)")]
        )
    }

    // MARK: - Headings

    func testShouldParseEveryHeadingLevel() {
        for level in 1...6 {
            let hashes = String(repeating: "#", count: level)
            XCTAssertEqual(
                MarkdownParser.parse("\(hashes) Title"),
                [.heading(level: level, text: "Title")],
                "level \(level)"
            )
        }
    }

    func testShouldNotTreatSevenHashesAsAHeading() {
        XCTAssertEqual(MarkdownParser.parse("####### Too deep"), [.paragraph("####### Too deep")])
    }

    func testShouldRequireASpaceAfterTheHashes() {
        XCTAssertEqual(MarkdownParser.parse("#hashtag"), [.paragraph("#hashtag")])
    }

    func testShouldKeepHeadingTextRawForInlineRendering() {
        XCTAssertEqual(
            MarkdownParser.parse("## The **plan**"),
            [.heading(level: 2, text: "The **plan**")]
        )
    }

    // MARK: - Fenced code blocks

    func testShouldParseAFencedCodeBlockWithALanguage() {
        let source = """
        ```swift
        let x = 1
        ```
        """
        XCTAssertEqual(MarkdownParser.parse(source), [.codeBlock(language: "swift", code: "let x = 1")])
    }

    func testShouldReportNoLanguageWhenTheFenceCarriesNone() {
        XCTAssertEqual(MarkdownParser.parse("```\nplain\n```"), [.codeBlock(language: nil, code: "plain")])
    }

    func testShouldPreserveIndentationAndBlankLinesInsideACodeBlock() {
        let source = "```\nfn a() {\n\n    return 1\n}\n```"
        XCTAssertEqual(
            MarkdownParser.parse(source),
            [.codeBlock(language: nil, code: "fn a() {\n\n    return 1\n}")]
        )
    }

    func testShouldNotParseMarkdownInsideACodeBlock() {
        let source = "```\n# not a heading\n- not a list\n```"
        XCTAssertEqual(
            MarkdownParser.parse(source),
            [.codeBlock(language: nil, code: "# not a heading\n- not a list")]
        )
    }

    func testShouldContinueAfterAClosedFence() {
        let source = "```\ncode\n```\nafter"
        XCTAssertEqual(
            MarkdownParser.parse(source),
            [.codeBlock(language: nil, code: "code"), .paragraph("after")]
        )
    }

    // MARK: - Horizontal rules

    func testShouldParseEachHorizontalRuleSpelling() {
        for rule in ["---", "***", "___", "- - -", "*****"] {
            XCTAssertEqual(MarkdownParser.parse(rule), [.horizontalRule], rule)
        }
    }

    func testShouldNotTreatTwoDashesAsAHorizontalRule() {
        XCTAssertEqual(MarkdownParser.parse("--"), [.paragraph("--")])
    }

    // MARK: - Blockquotes

    func testShouldParseASingleLineBlockquote() {
        XCTAssertEqual(MarkdownParser.parse("> quoted"), [.blockquote([.paragraph("quoted")])])
    }

    func testShouldJoinConsecutiveQuoteLinesIntoOneBlockquote() {
        XCTAssertEqual(
            MarkdownParser.parse("> one\n> two"),
            [.blockquote([.paragraph("one\ntwo")])]
        )
    }

    func testShouldTreatABareAngleBracketAsABlankLineInsideTheQuote() {
        XCTAssertEqual(
            MarkdownParser.parse("> one\n>\n> two"),
            [.blockquote([.paragraph("one"), .paragraph("two")])]
        )
    }

    func testShouldAcceptAQuoteMarkerWithNoSpaceAfterIt() {
        // CommonMark allows `>quoted`. Adjutant required `> ` and silently demoted the
        // rest to a paragraph, which is a quote that stops looking like a quote.
        XCTAssertEqual(MarkdownParser.parse(">quoted"), [.blockquote([.paragraph("quoted")])])
    }

    func testShouldNestBlockquotes() {
        XCTAssertEqual(
            MarkdownParser.parse("> outer\n> > inner"),
            [.blockquote([.paragraph("outer"), .blockquote([.paragraph("inner")])])]
        )
    }

    func testShouldEndTheBlockquoteAtTheFirstUnquotedLine() {
        XCTAssertEqual(
            MarkdownParser.parse("> quoted\nplain"),
            [.blockquote([.paragraph("quoted")]), .paragraph("plain")]
        )
    }

    // MARK: - R2: content inside a blockquote must survive
    //
    // Adjutant's renderer special-cased paragraphs and headings inside a quote and
    // returned `EmptyView()` for everything else, so a list, a table or a code block in
    // a quote vanished on screen. The parser half of the fix is that the block model
    // carries the nested blocks in full, so a renderer that simply recurses cannot lose
    // them. `syl-008.1.4`.

    func testShouldKeepAListInsideABlockquote() {
        XCTAssertEqual(
            MarkdownParser.parse("> - one\n> - two"),
            [.blockquote([.unorderedList(["one", "two"])])]
        )
    }

    func testShouldKeepACodeBlockInsideABlockquote() {
        XCTAssertEqual(
            MarkdownParser.parse("> ```swift\n> let x = 1\n> ```"),
            [.blockquote([.codeBlock(language: "swift", code: "let x = 1")])]
        )
    }

    func testShouldKeepATableInsideABlockquote() {
        XCTAssertEqual(
            MarkdownParser.parse("> | a | b |\n> |---|---|\n> | 1 | 2 |"),
            [.blockquote([.table(headers: ["a", "b"], alignments: [.left, .left], rows: [["1", "2"]])])]
        )
    }

    func testShouldKeepAHeadingInsideABlockquote() {
        XCTAssertEqual(
            MarkdownParser.parse("> ## Title"),
            [.blockquote([.heading(level: 2, text: "Title")])]
        )
    }

    // MARK: - Unordered lists

    func testShouldParseADashList() {
        XCTAssertEqual(MarkdownParser.parse("- one\n- two"), [.unorderedList(["one", "two"])])
    }

    func testShouldParseAnAsteriskList() {
        XCTAssertEqual(MarkdownParser.parse("* one\n* two"), [.unorderedList(["one", "two"])])
    }

    func testShouldEndAListAtTheFirstNonItem() {
        XCTAssertEqual(
            MarkdownParser.parse("- one\nafter"),
            [.unorderedList(["one"]), .paragraph("after")]
        )
    }

    // MARK: - R3: ordered lists must keep the ordinal the source wrote
    //
    // Adjutant rendered the loop index, so a list that began at `3.` came out as `1.`.
    // The model now carries `start`. `syl-008.1.4`.

    func testShouldStartAnOrderedListAtOneWhenTheSourceDoes() {
        XCTAssertEqual(
            MarkdownParser.parse("1. one\n2. two"),
            [.orderedList(start: 1, items: ["one", "two"])]
        )
    }

    func testShouldKeepTheSourceOrdinalWhenAnOrderedListDoesNotStartAtOne() {
        XCTAssertEqual(
            MarkdownParser.parse("3. three\n4. four"),
            [.orderedList(start: 3, items: ["three", "four"])]
        )
    }

    func testShouldKeepAZeroBasedOrderedListStart() {
        XCTAssertEqual(MarkdownParser.parse("0. zero"), [.orderedList(start: 0, items: ["zero"])])
    }

    func testShouldIgnoreLaterOrdinalsAndRenumberFromTheStart() {
        // GFM: only the first ordinal counts; the rest are sequential from it. A model
        // that stored every ordinal would let `1. / 1. / 1.` render as three ones.
        XCTAssertEqual(
            MarkdownParser.parse("1. a\n1. b\n1. c"),
            [.orderedList(start: 1, items: ["a", "b", "c"])]
        )
    }

    // MARK: - R1: nested lists flatten (characterisation, NOT a fix)
    //
    // The scanner trims leading whitespace before matching, so an indented child item
    // becomes a sibling of its parent. Claude emits nested lists constantly, so this is
    // real — but fixing it means indentation tracking through the whole scanner, which is
    // a decision the epic takes in Phase 2, not a fix taken here.
    //
    // **This test asserts current behaviour on purpose.** It is the one place in this
    // suite that does. When `syl-008.2.5` decides to add indentation tracking, this test
    // must be rewritten rather than deleted, which is exactly the visibility we want.

    func testShouldFlattenNestedUnorderedListsForNowSeeBeadSyl00825() {
        XCTAssertEqual(
            MarkdownParser.parse("- parent\n  - child\n- sibling"),
            [.unorderedList(["parent", "child", "sibling"])]
        )
    }

    func testShouldFlattenAnOrderedListNestedUnderABulletForNowSeeBeadSyl00825() {
        XCTAssertEqual(
            MarkdownParser.parse("- parent\n  1. child"),
            [.unorderedList(["parent"]), .orderedList(start: 1, items: ["child"])]
        )
    }

    // MARK: - Task lists

    func testShouldParseCheckedAndUncheckedTaskItems() {
        XCTAssertEqual(
            MarkdownParser.parse("- [ ] todo\n- [x] done\n- [X] also done"),
            [
                .taskList([
                    .init(checked: false, text: "todo"),
                    .init(checked: true, text: "done"),
                    .init(checked: true, text: "also done"),
                ])
            ]
        )
    }

    func testShouldParseATaskItemWithNoTextAfterTheBox() {
        XCTAssertEqual(
            MarkdownParser.parse("- [ ]"),
            [.taskList([.init(checked: false, text: "")])]
        )
    }

    func testShouldNotSwallowATaskListIntoAnUnorderedList() {
        XCTAssertEqual(
            MarkdownParser.parse("- plain\n- [ ] task"),
            [.unorderedList(["plain"]), .taskList([.init(checked: false, text: "task")])]
        )
    }

    // MARK: - Tables

    func testShouldParseAGfmTable() {
        let source = """
        | Name | Count |
        |------|-------|
        | a    | 1     |
        | b    | 2     |
        """
        XCTAssertEqual(
            MarkdownParser.parse(source),
            [
                .table(
                    headers: ["Name", "Count"],
                    alignments: [.left, .left],
                    rows: [["a", "1"], ["b", "2"]]
                )
            ]
        )
    }

    func testShouldReadColumnAlignmentsFromTheSeparatorRow() {
        let source = "| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |"
        XCTAssertEqual(
            MarkdownParser.parse(source),
            [
                .table(
                    headers: ["l", "c", "r"],
                    alignments: [.left, .center, .right],
                    rows: [["1", "2", "3"]]
                )
            ]
        )
    }

    func testShouldParseATableWithoutOuterPipes() {
        XCTAssertEqual(
            MarkdownParser.parse("a | b\n--- | ---\n1 | 2"),
            [.table(headers: ["a", "b"], alignments: [.left, .left], rows: [["1", "2"]])]
        )
    }

    func testShouldEndATableAtABlankLine() {
        XCTAssertEqual(
            MarkdownParser.parse("| a |\n|---|\n| 1 |\n\nafter"),
            [
                .table(headers: ["a"], alignments: [.left], rows: [["1"]]),
                .paragraph("after"),
            ]
        )
    }

    func testShouldTreatAPipeLineWithNoSeparatorAsAParagraph() {
        XCTAssertEqual(MarkdownParser.parse("a | b\nc | d"), [.paragraph("a | b\nc | d")])
    }

    // MARK: - T007 robustness: nothing crashes, hangs, or eats the transcript

    func testShouldCloseAnUnclosedFenceAtEndOfInput() {
        // CommonMark: an unclosed fence runs to the end of the document. The content
        // must still be there — a partial fence arrives on every keystroke once
        // streaming lands (R5), and it must never take the message with it.
        XCTAssertEqual(
            MarkdownParser.parse("before\n\n```swift\nlet x = 1\nlet y = 2"),
            [.paragraph("before"), .codeBlock(language: "swift", code: "let x = 1\nlet y = 2")]
        )
    }

    func testShouldSurviveALoneOpeningFenceWithNothingAfterIt() {
        XCTAssertEqual(MarkdownParser.parse("```"), [.codeBlock(language: nil, code: "")])
    }

    func testShouldPadAndClipRaggedTableRowsToTheHeaderWidth() {
        // GFM says exactly this, and it is also what stops a renderer indexing off the
        // end of a short row. Every row is the width of the header, always.
        let source = "| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |"
        XCTAssertEqual(
            MarkdownParser.parse(source),
            [
                .table(
                    headers: ["a", "b", "c"],
                    alignments: [.left, .left, .left],
                    rows: [["1", "", ""], ["1", "2", "3"]]
                )
            ]
        )
    }

    func testShouldParseAFortyThousandCharacterMessageWithoutHangingOrLosingTheTail() {
        var source = ""
        var expected: [MarkdownBlock] = []
        var n = 0
        while source.count < 40_000 {
            source += "## Section \(n)\n\nBody text for section \(n), long enough to matter.\n\n"
            expected.append(.heading(level: 2, text: "Section \(n)"))
            expected.append(.paragraph("Body text for section \(n), long enough to matter."))
            n += 1
        }
        source += "THE TAIL"
        expected.append(.paragraph("THE TAIL"))
        XCTAssertGreaterThan(source.count, 40_000)

        let blocks = parseWithinTimeout(source)

        XCTAssertEqual(blocks, expected)
        XCTAssertEqual(blocks.last, .paragraph("THE TAIL"))
    }

    func testShouldParseFortyThousandCharactersOfOneParagraphWithoutHanging() {
        let source = String(repeating: "lorem ipsum ", count: 4_000)
        XCTAssertGreaterThan(source.count, 40_000)
        XCTAssertEqual(parseWithinTimeout(source), [.paragraph(source)])
    }

    func testShouldNotBlowTheStackOnPathologicallyNestedBlockquotes() {
        // Parsing happens on a detached task, whose stack is far smaller than the main
        // thread's, so unbounded recursion here is a crash a hostile message can cause.
        // Depth is capped and the remainder is kept as raw text — bounded, not dropped.
        let source = String(repeating: "> ", count: 5_000) + "deep"

        let blocks = parseWithinTimeout(source)

        XCTAssertEqual(blocks.count, 1)
        guard case .blockquote = blocks.first else {
            return XCTFail("expected a blockquote, got \(String(describing: blocks.first))")
        }
        XCTAssertTrue(flatten(blocks).contains { $0.contains("deep") }, "the text must survive")
    }

    func testShouldKeepRtlTextAndEmojiIntactInACodeBlock() {
        let code = "let greeting = \"مرحبا بالعالم 👋🏽\" // 🇸🇦"
        XCTAssertEqual(
            MarkdownParser.parse("```swift\n\(code)\n```"),
            [.codeBlock(language: "swift", code: code)]
        )
    }

    func testShouldKeepRtlTextAndEmojiIntactInAParagraphWithACodeSpan() {
        let text = "مرحبا `let x = \"👨‍👩‍👧‍👦\"` بالعالم 👋🏽"
        XCTAssertEqual(MarkdownParser.parse(text), [.paragraph(text)])
    }

    func testShouldTreatACarriageReturnLineEndingAsALineBreak() {
        // Nothing guarantees the wire uses \n. A \r\n transcript must not become one
        // paragraph with stray control characters in it.
        XCTAssertEqual(
            MarkdownParser.parse("# Title\r\n\r\nbody"),
            [.heading(level: 1, text: "Title"), .paragraph("body")]
        )
    }

    func testShouldHandleEveryConstructInOneMessage() {
        let source = """
        # Report

        Intro **text**.

        > A quote
        > - with a list

        1. first
        2. second

        - [ ] open
        - [x] shut

        | a | b |
        |---|---|
        | 1 | 2 |

        ```sh
        echo hi
        ```

        ---

        Done.
        """

        XCTAssertEqual(
            MarkdownParser.parse(source),
            [
                .heading(level: 1, text: "Report"),
                .paragraph("Intro **text**."),
                .blockquote([.paragraph("A quote"), .unorderedList(["with a list"])]),
                .orderedList(start: 1, items: ["first", "second"]),
                .taskList([.init(checked: false, text: "open"), .init(checked: true, text: "shut")]),
                .table(headers: ["a", "b"], alignments: [.left, .left], rows: [["1", "2"]]),
                .codeBlock(language: "sh", code: "echo hi"),
                .horizontalRule,
                .paragraph("Done."),
            ]
        )
    }

    // MARK: - Helpers

    /// Parses off the main thread and fails the test rather than hanging it. A parser
    /// that loops forever on hostile input is the failure mode that has no error message.
    private func parseWithinTimeout(
        _ source: String,
        seconds: TimeInterval = 10,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> [MarkdownBlock] {
        let done = expectation(description: "parse completed")
        let box = ResultBox()
        DispatchQueue.global().async {
            box.value = MarkdownParser.parse(source)
            done.fulfill()
        }
        let outcome = XCTWaiter().wait(for: [done], timeout: seconds)
        guard outcome == .completed else {
            XCTFail("parse did not finish within \(seconds)s", file: file, line: line)
            return []
        }
        return box.value
    }

    /// Every inline string reachable in a block tree, for assertions that only care that
    /// the text survived somewhere.
    private func flatten(_ blocks: [MarkdownBlock]) -> [String] {
        blocks.flatMap { block -> [String] in
            switch block {
            case .paragraph(let text): return [text]
            case .heading(_, let text): return [text]
            case .codeBlock(_, let code): return [code]
            case .blockquote(let inner): return flatten(inner)
            case .unorderedList(let items): return items
            case .orderedList(_, let items): return items
            case .horizontalRule: return []
            case .table(let headers, _, let rows): return headers + rows.flatMap { $0 }
            case .taskList(let items): return items.map(\.text)
            }
        }
    }

    private final class ResultBox: @unchecked Sendable {
        var value: [MarkdownBlock] = []
    }
}
