import SylKit
import WebKit
import XCTest

@testable import Syl

/// The state machine behind the admin WebView.
///
/// Everything security-shaped about this screen — where it may point, where it may go
/// — is pure and lives in `SylKitTests`, where it runs without a simulator. What is
/// left here is the one thing that genuinely needs the app: deciding what the
/// Commander is shown when the credential does not work.
///
/// **That decision is the whole reason this file exists.** A WebView that renders an
/// empty admin on a rejected token is indistinguishable from a broken admin, and the
/// Commander would go and debug the wrong thing.
@MainActor
final class AdminConsoleScreenTests: XCTestCase {
    private let adminURL = URL(string: "https://reason-2.tail714e0e.ts.net/admin")!

    private func model(
        credential: String? = "a-live-token",
        preflight: AdminConsoleViewModel.Preflight = .authenticated
    ) throws -> AdminConsoleViewModel {
        try XCTUnwrap(
            AdminConsoleViewModel(
                adminURL: adminURL,
                access: AdminConsoleAccess(
                    readCredential: { credential },
                    verify: { preflight }
                )
            )
        )
    }

    // MARK: - load()

    func testShouldBeReadyToLoadWhenTheCredentialStillVerifies() async throws {
        let model = try model(preflight: .authenticated)

        await model.load()

        XCTAssertEqual(model.state, .ready)
        XCTAssertEqual(model.credential, "a-live-token")
    }

    /// The 401 answer, and the point of the preflight. The admin's own code would
    /// respond to a rejected key by clearing it and showing its login gate, which on a
    /// phone means a keyboard and a key the Commander does not have. Saying so natively
    /// is both faster and true.
    func testShouldSayTheCredentialWasRejectedRatherThanShowAnEmptyAdmin() async throws {
        let model = try model(preflight: .rejected)

        await model.load()

        XCTAssertEqual(model.state, .unauthenticated)
    }

    /// Under Tailscale the first request after a wake genuinely fails while the tunnel
    /// comes up. That is not a rejected credential and must not be rendered as one —
    /// the same distinction `PairingViewModel` is built around.
    func testShouldTellAnUnreachableServerApartFromARejectedCredential() async throws {
        let model = try model(preflight: .unreachable("The network connection was lost."))

        await model.load()

        XCTAssertEqual(model.state, .unreachable("The network connection was lost."))
    }

    /// Edge: nothing in the Keychain. There is no point asking the server, and no
    /// point loading a page that will only show its own gate.
    func testShouldRefuseToLoadWithNoCredentialAtAllAndNotAskTheServer() async throws {
        var asked = false
        let model = try XCTUnwrap(
            AdminConsoleViewModel(
                adminURL: adminURL,
                access: AdminConsoleAccess(
                    readCredential: { nil },
                    verify: {
                        asked = true
                        return .authenticated
                    }
                )
            )
        )

        await model.load()

        XCTAssertEqual(model.state, .noCredential)
        XCTAssertFalse(asked, "a device with no token has nothing to verify")
    }

    /// Edge: a token that is only whitespace is not a credential either, and would
    /// otherwise be injected as an empty string and produce a 401 from inside the page.
    func testShouldTreatABlankCredentialAsNoCredential() async throws {
        let model = try model(credential: "   ")

        await model.load()

        XCTAssertEqual(model.state, .noCredential)
        XCTAssertNil(model.credential)
    }

    // MARK: - What the response itself says

    /// The preflight can pass and the document request still be rejected — a token
    /// revoked in between, or a service that authenticates the bundle route too.
    func testShouldSurfaceARejectedDocumentRequestAsNotAuthenticated() async throws {
        let model = try model()
        await model.load()

        model.handle(httpStatus: 401)

        XCTAssertEqual(model.state, .unauthenticated)
    }

    func testShouldAlsoTreat403AsNotAuthenticated() async throws {
        let model = try model()
        await model.load()

        model.handle(httpStatus: 403)

        XCTAssertEqual(model.state, .unauthenticated)
    }

    /// The state this build is most likely to hit today: the app half shipped, the
    /// service half (`syl-6vt`) not yet. Syl's own 404 rendered as a blank page would
    /// read as "the admin is broken".
    func testShouldSayTheAdminIsNotServedWhenTheRouteIsMissing() async throws {
        let model = try model()
        await model.load()

        model.handle(httpStatus: 404)

        XCTAssertEqual(model.state, .notServed)
    }

    func testShouldReportAServerErrorWithItsStatus() async throws {
        let model = try model()
        await model.load()

        model.handle(httpStatus: 502)

        XCTAssertEqual(model.state, .failed("The server answered 502."))
    }

    func testShouldLeaveASuccessfulResponseAlone() async throws {
        let model = try model()
        await model.load()

        model.handle(httpStatus: 200)

        XCTAssertEqual(model.state, .ready)
    }

    func testShouldReportANavigationFailureAsUnreachable() async throws {
        let model = try model()
        await model.load()

        model.handleNavigationFailure(URLError(.cannotFindHost))

        guard case .unreachable = model.state else {
            return XCTFail("expected .unreachable, got \(model.state)")
        }
    }

    /// Retrying re-asks rather than re-rendering whatever it concluded last time: the
    /// tunnel coming up is the common reason to press it.
    func testShouldReCheckOnRetry() async throws {
        var answers: [AdminConsoleViewModel.Preflight] = [.authenticated, .unreachable("down")]
        let model = try XCTUnwrap(
            AdminConsoleViewModel(
                adminURL: adminURL,
                access: AdminConsoleAccess(
                    readCredential: { "a-live-token" },
                    verify: { answers.removeLast() }
                )
            )
        )

        await model.load()
        XCTAssertEqual(model.state, .unreachable("down"))

        await model.load()
        XCTAssertEqual(model.state, .ready)
    }

    // MARK: - The two beads are one change

    /// The credential and the restriction ship together, so the model that hands out
    /// the token is the same object that owns the policy refusing everything off the
    /// paired origin. There is no way to construct one without the other.
    func testShouldCarryANavigationPolicyLockedToThePairedOrigin() throws {
        let model = try model()

        XCTAssertEqual(model.policy.decide(url: adminURL), .allow)
        XCTAssertEqual(
            model.policy.decide(url: URL(string: "https://reason-2.tail714e0e.ts.net.evil.com/x")),
            .refuse(.differentOrigin)
        )
    }

    /// And there is no way to build the screen around a URL that has no origin to lock
    /// to — which would be a WebView holding a token and allowing everything.
    func testShouldRefuseToBuildAroundAURLWithNoOrigin() {
        XCTAssertNil(
            AdminConsoleViewModel(
                adminURL: URL(string: "file:///admin")!,
                access: AdminConsoleAccess(readCredential: { "t" }, verify: { .authenticated })
            )
        )
    }

    /// **The way this restriction would fail silently.**
    ///
    /// `WKNavigationDelegate`'s methods are Objective-C *optional* requirements, so a
    /// signature that drifts by one annotation is not an unimplemented protocol — it is
    /// a method WebKit never calls, and WebKit's own default is to allow the
    /// navigation. The screen would keep working perfectly while the origin lock did
    /// nothing at all, and nothing anywhere would say so.
    ///
    /// It already happened once while writing this: the completion handlers need
    /// `@MainActor @Sendable` on the current SDK and the compiler reported it as a
    /// warning. This asserts against the selectors so a future SDK cannot turn the lock
    /// off quietly.
    func testShouldActuallyBeWiredIntoWebKitsDelegateSelectors() throws {
        let policy = try XCTUnwrap(AdminNavigationPolicy(adminURL: adminURL))
        let coordinator = AdminWebView.Coordinator(
            policy: policy,
            onHTTPStatus: { _ in },
            onFailure: { _ in }
        )

        for selector in [
            "webView:decidePolicyForNavigationAction:decisionHandler:",
            "webView:decidePolicyForNavigationResponse:decisionHandler:",
            "webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:",
        ] {
            XCTAssertTrue(
                coordinator.responds(to: NSSelectorFromString(selector)),
                "\(selector) is not implemented, so WebKit will use its own default — which allows"
            )
        }
    }
}
