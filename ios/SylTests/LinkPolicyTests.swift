import Foundation
import XCTest

@testable import Syl

/// The one new security control in `syl-008`.
///
/// The backend's SSRF guard (`safeFetch`, `classifyAddress`) is thorough and covers
/// **outbound fetches**. It does nothing about what the phone renders. `Message.text` is
/// an unfiltered `String`; nothing between the model and the bubble strips a hostile
/// scheme out of it, and the hole opens the moment links become tappable.
///
/// So the rule is an allowlist, not a blocklist: `https` and `mailto` are admitted and
/// **everything else is inert text**, including every scheme nobody has thought of yet.
final class LinkPolicyTests: XCTestCase {

    // MARK: - What is admitted

    func testShouldAdmitAnHttpsUrl() {
        XCTAssertEqual(
            LinkPolicy.sanitized(rawURL: "https://example.com/a?b=c#d")?.absoluteString,
            "https://example.com/a?b=c#d"
        )
    }

    func testShouldAdmitAMailtoUrl() {
        XCTAssertEqual(
            LinkPolicy.sanitized(rawURL: "mailto:commander@example.com")?.absoluteString,
            "mailto:commander@example.com"
        )
    }

    func testShouldAdmitASchemeInAnyCaseBecauseSchemesAreCaseInsensitive() {
        // Case-insensitivity is the *rule*, not a loophole — rejecting `HTTPS:` would be
        // wrong. It is the same normalisation that makes `JaVaScRiPt:` inert below.
        for raw in ["HTTPS://example.com", "HtTpS://example.com", "MAILTO:a@example.com"] {
            XCTAssertNotNil(LinkPolicy.sanitized(rawURL: raw), raw)
        }
    }

    func testShouldTrimSurroundingWhitespaceFromAnOtherwiseGoodUrl() {
        XCTAssertEqual(
            LinkPolicy.sanitized(rawURL: "  https://example.com \n")?.absoluteString,
            "https://example.com"
        )
    }

    // MARK: - What is refused

    func testShouldRefuseJavascript() {
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "javascript:alert(1)"))
    }

    func testShouldRefuseJavascriptInMixedCase() {
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "JaVaScRiPt:alert(1)"))
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "JAVASCRIPT:alert(1)"))
    }

    func testShouldRefuseASchemeHiddenBehindLeadingWhitespace() {
        for raw in [" javascript:alert(1)", "\tjavascript:alert(1)", "\njavascript:alert(1)"] {
            XCTAssertNil(LinkPolicy.sanitized(rawURL: raw), raw)
        }
    }

    func testShouldRefuseASchemeBrokenUpByInteriorWhitespaceOrControlCharacters() {
        // Browsers strip tabs and newlines from a URL before resolving it, so
        // `java<TAB>script:` runs. We do not normalise it into a decision — a URL with a
        // control character inside is refused outright, which is a shorter argument.
        for raw in [
            "java\tscript:alert(1)",
            "java\nscript:alert(1)",
            "java\r\nscript:alert(1)",
            "java\u{0000}script:alert(1)",
            "java\u{200B}script:alert(1)",  // zero-width space
            "java\u{200E}script:alert(1)",  // left-to-right mark
        ] {
            XCTAssertNil(LinkPolicy.sanitized(rawURL: raw), raw.debugDescription)
        }
    }

    func testShouldRefuseAPercentEncodedScheme() {
        // `javascript%3Aalert(1)` has no scheme at all as far as the URL grammar is
        // concerned — it is a relative path. Refusing every relative URL is what closes
        // this, which is why the allowlist tests schemes rather than prefixes.
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "javascript%3Aalert(1)"))
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "javascript%3aalert(1)"))
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "%6Aavascript:alert(1)"))
    }

    func testShouldRefuseAProtocolRelativeUrl() {
        // `//evil.com` inherits whatever scheme it is resolved against. There is no base
        // URL here, and a link whose scheme depends on context is never admitted.
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "//evil.com"))
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "//evil.com/steal"))
    }

    func testShouldRefuseDataUrls() {
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "data:text/html;base64,PHNjcmlwdD4="))
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "DATA:text/html,<script>"))
    }

    func testShouldRefuseFileUrls() {
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "file:///etc/passwd"))
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "file://localhost/Users/Reason/.ssh/id_ed25519"))
    }

    func testShouldRefusePlainHttp() {
        // Not on the list. Every server the phone talks to is reached over the tailnet
        // with TLS, so a bare http link is either a mistake or a downgrade.
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "http://example.com"))
    }

    func testShouldRefuseEverySchemeNobodyThoughtOf() {
        // The point of an allowlist: this list is illustrative, not exhaustive, and it
        // does not have to be complete to be correct.
        for raw in [
            "vbscript:msgbox(1)",
            "about:blank",
            "tel:+15555550123",
            "sms:+15555550123&body=hi",
            "facetime:someone@example.com",
            "itms-services://?action=download-manifest&url=https://evil.com/m.plist",
            "intent://evil#Intent;scheme=https;end",
            "shortcuts://run-shortcut?name=Wipe",
            "syl://pair?token=stolen",
            "ftp://example.com/x",
            "ws://example.com",
            "blob:https://example.com/1234",
            "view-source:https://example.com",
        ] {
            XCTAssertNil(LinkPolicy.sanitized(rawURL: raw), raw)
        }
    }

    func testShouldRefuseRelativeAndFragmentOnlyLinks() {
        for raw in ["/settings", "../up", "#anchor", "?q=1", "example.com"] {
            XCTAssertNil(LinkPolicy.sanitized(rawURL: raw), raw)
        }
    }

    func testShouldRefuseEmptyAndWhitespaceOnlyUrls() {
        XCTAssertNil(LinkPolicy.sanitized(rawURL: ""))
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "   \n\t "))
    }

    func testShouldRefuseAnHttpsUrlWithNoHost() {
        // Scheme is necessary, not sufficient. `https://` opens nothing, and a hostless
        // https URL is a shape only a generator produces.
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "https://"))
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "https:///path"))
    }

    func testShouldRefuseAMailtoWithNoRecipient() {
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "mailto:"))
    }

    func testShouldRefuseASchemeThatOnlyLooksLikeHttpsAsAPrefix() {
        // A blocklist or a `hasPrefix("https")` check waves all of these through.
        for raw in ["httpsx://example.com", "https-evil://example.com", "xhttps://example.com"] {
            XCTAssertNil(LinkPolicy.sanitized(rawURL: raw), raw)
        }
    }

    func testShouldRefuseANestedSchemeSmuggledAfterAnAllowedOne() {
        // `mailto:javascript:alert(1)` parses as mailto with a hostile-looking body, but
        // the recipient is empty of an `@`, and more to the point what would be handed to
        // the system is a mailto. Kept as an explicit case so a future relaxation of the
        // mailto rule has to argue with a test.
        XCTAssertNil(LinkPolicy.sanitized(rawURL: "mailto:javascript:alert(1)"))
    }

    // MARK: - URL-valued entry point

    func testShouldRefuseAHostileUrlValue() throws {
        let url = try XCTUnwrap(URL(string: "javascript:alert(1)"))
        XCTAssertNil(LinkPolicy.sanitized(url))
    }

    func testShouldAdmitAnAllowedUrlValueUnchanged() throws {
        let url = try XCTUnwrap(URL(string: "https://example.com/x"))
        XCTAssertEqual(LinkPolicy.sanitized(url), url)
    }

    // MARK: - Sanitising an attributed string

    func testShouldStripTheLinkAttributeFromAHostileRunAndKeepTheText() throws {
        let attributed = try AttributedString(
            markdown: "tap [here](javascript:alert(1)) now",
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )
        XCTAssertTrue(attributed.runs.contains { $0.link != nil }, "precondition: the link parsed")

        let safe = LinkPolicy.sanitize(attributed)

        XCTAssertFalse(safe.runs.contains { $0.link != nil }, "no run may remain tappable")
        XCTAssertEqual(String(safe.characters), "tap here now", "the words must survive")
    }

    func testShouldLeaveAnAllowedLinkTappable() throws {
        let attributed = try AttributedString(
            markdown: "see [docs](https://example.com/docs)",
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )

        let safe = LinkPolicy.sanitize(attributed)

        XCTAssertEqual(
            safe.runs.compactMap { $0.link?.absoluteString },
            ["https://example.com/docs"]
        )
    }

    func testShouldStripOnlyTheHostileLinkWhenAMessageMixesBoth() throws {
        let attributed = try AttributedString(
            markdown: "[good](https://example.com) and [bad](javascript:alert(1))",
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )

        let safe = LinkPolicy.sanitize(attributed)

        XCTAssertEqual(safe.runs.compactMap { $0.link?.absoluteString }, ["https://example.com"])
        XCTAssertEqual(String(safe.characters), "good and bad")
    }

    func testShouldStripAHostileImageUrlToo() throws {
        // `![alt](url)` lands in a different attribute from `[text](url)`. A control that
        // only guards `.link` leaves the second channel open.
        let attributed = try AttributedString(
            markdown: "![x](javascript:alert(1))",
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )

        let safe = LinkPolicy.sanitize(attributed)

        XCTAssertFalse(safe.runs.contains { $0.imageURL != nil })
    }

    func testShouldLeaveAStringWithNoLinksAlone() {
        let attributed = AttributedString("just words")
        XCTAssertEqual(String(LinkPolicy.sanitize(attributed).characters), "just words")
    }
}
