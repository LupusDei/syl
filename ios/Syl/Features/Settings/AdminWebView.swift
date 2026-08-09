import SwiftUI
import SylKit
import WebKit

/// The `WKWebView` itself, and the four things that make it safe to put a credential
/// into one.
///
/// 1. **A non-persistent data store.** The injected token lives in the WebView's
///    `localStorage`, and a persistent store would write it to a second place on disk
///    — outside the Keychain, with none of its protections — where it would outlive
///    the screen and survive into the next launch. This store dies with the view.
/// 2. **The credential goes in at document start, main frame only.** Before the
///    admin's bundle reads storage, so no login gate ever appears; never in a
///    subframe, so no embedded document is handed the token.
/// 3. **Every navigation is checked against the paired origin** and refused otherwise.
///    This is the condition the credential injection is acceptable under, and the two
///    are in the same file so nobody removes one and keeps the other.
/// 4. **No new windows.** `target="_blank"` and `window.open` return nothing.
struct AdminWebView: UIViewRepresentable {
    let url: URL
    let credential: String
    let policy: AdminNavigationPolicy
    /// The status of the main-frame document response. Anything from 400 up is
    /// reported and the response is cancelled, so the screen says what happened
    /// instead of rendering the service's error page.
    let onHTTPStatus: (Int) -> Void
    let onFailure: (Error) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(policy: policy, onHTTPStatus: onHTTPStatus, onFailure: onFailure)
    }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        if let script = AdminConsole.credentialScript(token: credential) {
            controller.addUserScript(
                WKUserScript(
                    source: script,
                    injectionTime: .atDocumentStart,
                    // NOT `false`. Injecting into every frame would hand the token to
                    // any subframe the admin ever embeds.
                    forMainFrameOnly: true
                )
            )
        }

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        // See (1) above. Ephemeral, so nothing about this session outlives the screen.
        configuration.websiteDataStore = .nonPersistent()

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        // A development instrument: the Commander is here to debug, so let him.
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private let policy: AdminNavigationPolicy
        private let onHTTPStatus: (Int) -> Void
        private let onFailure: (Error) -> Void

        init(
            policy: AdminNavigationPolicy,
            onHTTPStatus: @escaping (Int) -> Void,
            onFailure: @escaping (Error) -> Void
        ) {
            self.policy = policy
            self.onHTTPStatus = onHTTPStatus
            self.onFailure = onFailure
        }

        /// **The restriction.** Consulted for every navigation including each hop of a
        /// server redirect, which is the case that matters: the first hop of an
        /// exfiltration looks exactly like a normal link.
        ///
        /// The rule itself is `AdminNavigationPolicy` and is tested without a WebView.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
        ) {
            switch policy.decide(
                url: navigationAction.request.url,
                // WebKit reports `target="_blank"` and `window.open` as a navigation
                // with no target frame.
                opensNewWindow: navigationAction.targetFrame == nil
            ) {
            case .allow:
                decisionHandler(.allow)
            case .refuse(let reason):
                // Logged rather than shown. A refusal here is either the admin doing
                // something it should not, or somebody trying something — and either
                // way the answer on screen is that nothing happened.
                print("[syl] admin WebView refused a navigation: \(reason.rawValue)")
                decisionHandler(.cancel)
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
        ) {
            guard navigationResponse.isForMainFrame,
                  let http = navigationResponse.response as? HTTPURLResponse,
                  http.statusCode >= 400
            else {
                decisionHandler(.allow)
                return
            }
            onHTTPStatus(http.statusCode)
            decisionHandler(.cancel)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            // A cancellation is this class doing its job, not a failure to report.
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            onFailure(error)
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            onFailure(error)
        }

        /// See (4). Returning `nil` is what stops a new window existing at all — the
        /// navigation delegate never runs for one this method created.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            nil
        }
    }
}
