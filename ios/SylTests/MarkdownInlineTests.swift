import Foundation
import XCTest

@testable import Syl

/// Inline markup is Foundation's job, not ours.
///
/// Adjutant hand-rolled ~110 lines of delimiter scanning to build an inline tree, then
/// folded the pieces back into one SwiftUI `Text` with `+`. That is why its links were
/// never tappable. `AttributedString(markdown:)` does the parsing correctly and returns a
/// real `.link` attribute, so the whole thing collapses to a call and a sanitiser.
///
/// These tests deliberately assert *our* seam — that the run reaches the renderer with
/// the intent attached, and that `LinkPolicy` has already run on it — rather than
/// re-testing Foundation's parser.
final class MarkdownInlineTests: XCTestCase {

    // MARK: - The constructs

    func testShouldRenderPlainTextUnchanged() {
        XCTAssertEqual(text(of: MarkdownInline.render("just words")), "just words")
    }

    func testShouldRenderBold() {
        let rendered = MarkdownInline.render("a **bold** word")
        XCTAssertEqual(text(of: rendered), "a bold word")
        XCTAssertEqual(runs(of: rendered, matching: .stronglyEmphasized), ["bold"])
    }

    func testShouldRenderItalic() {
        let rendered = MarkdownInline.render("a *soft* word")
        XCTAssertEqual(text(of: rendered), "a soft word")
        XCTAssertEqual(runs(of: rendered, matching: .emphasized), ["soft"])
    }

    func testShouldRenderInlineCode() {
        let rendered = MarkdownInline.render("run `npm test` now")
        XCTAssertEqual(text(of: rendered), "run npm test now")
        XCTAssertEqual(runs(of: rendered, matching: .code), ["npm test"])
    }

    func testShouldRenderStrikethrough() {
        let rendered = MarkdownInline.render("~~gone~~ kept")
        XCTAssertEqual(text(of: rendered), "gone kept")
        XCTAssertEqual(runs(of: rendered, matching: .strikethrough), ["gone"])
    }

    func testShouldRenderBoldAndItalicTogether() {
        let rendered = MarkdownInline.render("***loud***")
        XCTAssertEqual(text(of: rendered), "loud")
        XCTAssertEqual(runs(of: rendered, matching: .stronglyEmphasized), ["loud"])
        XCTAssertEqual(runs(of: rendered, matching: .emphasized), ["loud"])
    }

    func testShouldRenderALinkAsATappableRun() {
        let rendered = MarkdownInline.render("see [docs](https://example.com/docs)")
        XCTAssertEqual(text(of: rendered), "see docs")
        XCTAssertEqual(
            rendered.runs.compactMap { $0.link?.absoluteString },
            ["https://example.com/docs"]
        )
    }

    func testShouldRenderAnAutolink() {
        let rendered = MarkdownInline.render("<https://example.com>")
        XCTAssertEqual(rendered.runs.compactMap { $0.link?.absoluteString }, ["https://example.com"])
    }

    // MARK: - Whitespace

    func testShouldPreserveASoftNewlineWithinARun() {
        // `.inlineOnlyPreservingWhitespace` is chosen precisely for this: the block
        // scanner already decided where paragraphs end, so a newline that reaches here is
        // one the Commander meant.
        XCTAssertEqual(text(of: MarkdownInline.render("one\ntwo")), "one\ntwo")
    }

    func testShouldPreserveRunsOfSpacesAndTabs() {
        XCTAssertEqual(text(of: MarkdownInline.render("a    b\tc")), "a    b\tc")
    }

    // MARK: - The security seam

    func testShouldRenderAHostileLinkAsInertText() {
        // The whole reason `LinkPolicy` runs inside `render` rather than beside it: a
        // caller cannot forget to apply it.
        let rendered = MarkdownInline.render("tap [here](javascript:alert(1)) now")
        XCTAssertEqual(text(of: rendered), "tap here now")
        XCTAssertFalse(rendered.runs.contains { $0.link != nil })
    }

    func testShouldRenderAProtocolRelativeLinkAsInertText() {
        let rendered = MarkdownInline.render("[go](//evil.com)")
        XCTAssertEqual(text(of: rendered), "go")
        XCTAssertFalse(rendered.runs.contains { $0.link != nil })
    }

    // MARK: - Robustness

    func testShouldNotLoseTextWhenInlineMarkupIsUnclosed() {
        // A dangling delimiter arrives on every keystroke once streaming lands (R5).
        // Whatever Foundation makes of it, the words must still reach the bubble.
        XCTAssertTrue(text(of: MarkdownInline.render("a [broken link")).contains("broken link"))
        XCTAssertTrue(text(of: MarkdownInline.render("unclosed **bold")).contains("bold"))
        XCTAssertTrue(text(of: MarkdownInline.render("trailing `code")).contains("code"))
        XCTAssertTrue(text(of: MarkdownInline.render("[half](")).contains("half"))
    }

    func testShouldKeepEmojiAndRtlTextIntact() {
        let source = "مرحبا `let x = 1` 👨‍👩‍👧‍👦 👋🏽"
        XCTAssertEqual(text(of: MarkdownInline.render(source)), "مرحبا let x = 1 👨‍👩‍👧‍👦 👋🏽")
    }

    func testShouldRenderAFortyThousandCharacterRunWithoutHanging() {
        let source = String(repeating: "lorem **ipsum** ", count: 3_000)
        XCTAssertGreaterThan(source.count, 40_000)

        let done = expectation(description: "render completed")
        let box = TextBox()
        DispatchQueue.global().async {
            box.value = String(MarkdownInline.render(source).characters)
            done.fulfill()
        }
        guard XCTWaiter().wait(for: [done], timeout: 20) == .completed else {
            return XCTFail("inline rendering did not finish within 20s")
        }
        XCTAssertFalse(box.value.contains("**"), "the delimiters must have been consumed")
        XCTAssertTrue(box.value.hasPrefix("lorem ipsum "))
    }

    func testShouldRenderAnEmptyRunWithoutFailing() {
        XCTAssertEqual(text(of: MarkdownInline.render("")), "")
    }

    // MARK: - Helpers

    private func text(of attributed: AttributedString) -> String {
        String(attributed.characters)
    }

    private func runs(
        of attributed: AttributedString,
        matching intent: InlinePresentationIntent
    ) -> [String] {
        attributed.runs.compactMap { run in
            guard run.inlinePresentationIntent?.contains(intent) == true else { return nil }
            return String(attributed[run.range].characters)
        }
    }

    private final class TextBox: @unchecked Sendable {
        var value = ""
    }
}
