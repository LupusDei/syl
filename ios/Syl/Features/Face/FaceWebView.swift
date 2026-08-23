import AVFoundation
import SwiftUI
import SylKit
import WebKit

/// The audio route a two-way face needs, so she cannot hear herself.
///
/// ## THIS WAS NEVER SET. It was not set WRONGLY.
///
/// Worth stating plainly, because it tells the next reader how freely to change it:
/// until `syl-chzl.4.9` the iOS target configured **no** audio session for the face.
/// There is no measurement behind these values that you would be overturning, only an
/// absence. The only `AVAudioSession` call anywhere in the app was — and still is —
/// `AttachmentView`'s unrelated `.ambient`.
///
/// ## What the absence cost
///
/// Her voice played out of whatever route WebKit happened to choose, centimetres from an
/// open microphone with no processing on it. Runway keeps a verbatim transcript of every
/// realtime session, and session `b547219a` records her own sentence arriving back in the
/// **user** channel, mangled by speech recognition into an assertion about who she is —
/// which she then answered, four times over. The Commander saw a generic identity
/// replacing everything she knows; it was a feedback loop.
///
/// ## Why these three
///
/// - `.playAndRecord` — both directions are live at once. Anything else makes one of them
///   a second-class citizen, and `.ambient` (the app's other call site) cannot record.
/// - `.voiceChat` — **the load-bearing one.** iOS engages the hardware voice-processing
///   I/O unit, which subtracts what the speaker is playing from what the microphone
///   hears, only for this mode. Without it the category alone buys nothing.
/// - `.defaultToSpeaker` — a face held at arm's length is useless on the earpiece, and
///   the earpiece is what `.playAndRecord` picks by default.
///
/// ## The honest limit
///
/// WebKit manages its own audio session while a capture is active and may override this.
/// That is precisely why the page asks for `echoCancellation` on the track as well: two
/// independent requests for the same property, because neither can be proven sufficient
/// from here. See `withAudioProcessing` in `backend/src/routes/face-page.ts`.
enum FaceAudioSession {
    static let category: AVAudioSession.Category = .playAndRecord
    static let mode: AVAudioSession.Mode = .voiceChat
    static let options: AVAudioSession.CategoryOptions = [
        .defaultToSpeaker,
        .allowBluetooth,
        .allowBluetoothA2DP,
    ]

    /// Apply it. **Never throws outward**: a face that draws and sounds imperfect beats a
    /// face that refuses to open, and she is already billing by the time this runs.
    static func begin(_ session: AVAudioSession = .sharedInstance()) {
        do {
            try session.setCategory(category, mode: mode, options: options)
            try session.setActive(true)
        } catch {
            // Nothing to say to the user about this, and nowhere on this surface to say
            // it. The page's own constraints are the other half and are unaffected.
        }
    }

    /// Hand the route back when the face goes away, so the rest of the app is not left
    /// recording. Deliberately non-throwing for the same reason as ``begin(_:)``.
    static func end(_ session: AVAudioSession = .sharedInstance()) {
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
    }
}

/// What actually draws her, and why it is a web page (`syl-chzl.7.5`, T025).
///
/// ## The dependency this avoids is the whole point
///
/// Rendering a realtime avatar means WebRTC. The native route is a LiveKit Swift
/// package, and `SylKit` is under a standing **zero-dependency** rule while the app
/// target carries exactly two dependencies. Adding a realtime SDK was a build-graph
/// decision, which is why `syl-chzl.7.2` left ``FaceRenderer/notInThisBuild`` in place
/// rather than guessing at it.
///
/// The Commander's ruling, 2026-08-22: **do it the way the Bridge already does it.**
/// Syl's backend serves `/face/live`; this opens a full-screen `WKWebView` over that
/// page; the live render *and the audio* happen inside the web view. The phone gains no
/// realtime SDK at all. `SylKit` gains nothing, the app target gains nothing, and the
/// only new symbol on this side is `WebKit`, which is part of the system.
///
/// ## The credential never touches a URL
///
/// The session key is injected as a document-start user script, so it appears in no
/// address bar, no access log, no proxy log and no `Referer` header. The page also
/// accepts it in the URL *fragment* for a browser opened by hand — see
/// `backend/src/routes/face-page.ts` — but this host does not use that path, because it
/// does not have to.
enum LiveFacePage {
    /// Where the page lives, derived from whatever the API base URL is right now.
    ///
    /// The base URL carries the contract's prefix (`…/api/v1`) and the page deliberately
    /// does not live under it: it is a document, not a contract route. So the path is
    /// replaced rather than appended, which is also what makes this a pure function of
    /// the origin and therefore assertable without a server.
    ///
    /// Same origin as `/api/v1`, which is the entire reason there is no CORS to
    /// configure, no second certificate and no App Transport Security exception — the
    /// argument that already put the web admin here.
    static func url(apiBaseURL: URL) -> URL? {
        guard var parts = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: false),
              parts.scheme != nil, parts.host != nil
        else { return nil }
        parts.path = "/face/live"
        parts.query = nil
        parts.fragment = nil
        return parts.url
    }

    /// The handoff, as JavaScript the page reads before its own script runs.
    ///
    /// **Built with `JSONSerialization`, never with string interpolation.** A session id
    /// is a value from the network, and a value from the network pasted into a script
    /// literal is script injection with extra steps — into the one document on this
    /// phone that holds a live credential. Encoding it as JSON is what makes a hostile
    /// id an inert string rather than a statement.
    ///
    /// Returns nil rather than a broken script when the value cannot be encoded: a page
    /// that gets no session says so in words, and a page handed half a statement throws
    /// a syntax error and shows him nothing.
    static func handoff(for session: FaceSession) -> String? {
        var payload: [String: String] = [
            "sessionId": session.sessionId,
            "sessionKey": session.sessionKey
        ]
        if let avatarId = session.avatarId { payload["avatarId"] = avatarId }

        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else { return nil }
        return "window.__sylFaceSession = \(json);"
    }

    /// The name the page posts its state back on. One handler, one name.
    static let hostChannel = "sylFace"

    /// The call that leaves the room.
    ///
    /// **Not decoration.** Unmounting the page's React root is what drops the LiveKit
    /// connection; a web view thrown away without it can leave the room joined behind a
    /// screen he has already left — the idle leak wearing its third hat. The page guards
    /// it so calling it twice is free, and it also runs itself on `pagehide`, so the
    /// `about:blank` navigation below is a second, independent trigger.
    static let leaveScript = "window.sylFaceLeave && window.sylFaceLeave();"
}

/// Her face, in a web view.
///
/// A `UIViewRepresentable` rather than a SwiftUI wrapper, because the interesting part
/// is the teardown and the teardown is a `UIView` lifecycle event.
struct FaceWebPage: UIViewRepresentable {
    let session: FaceSession
    let pageURL: URL
    /// What the page says about itself: `booting`, `connected`, `playing`, `failed`, …
    ///
    /// **Not defaulted.** A defaulted sink is a sink a call site forgets, and this one is
    /// what decides whether she is ever presented at all.
    var onState: @MainActor (String, String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onState: onState)
    }

    func makeUIView(context: Context) -> WKWebView {
        // **Before the web view exists, not after.** WebKit configures its own audio
        // session when a capture starts; setting ours first means the mode is already
        // `.voiceChat` when it does, rather than a change fought over mid-call.
        FaceAudioSession.begin()

        let configuration = WKWebViewConfiguration()
        // Her video plays in place and starts on its own. Without both of these the
        // stream waits for a tap that this surface has no control for — a face that
        // arrived and will not start.
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: configuration)

        // **On the web view's OWN configuration, not the one above.** `WKWebView` COPIES
        // the configuration at init, so anything registered on the original afterwards is
        // silently dropped. Adjutant lost time to exactly this; it is written here rather
        // than remembered.
        let controller = webView.configuration.userContentController
        if let handoff = LiveFacePage.handoff(for: session) {
            controller.addUserScript(
                WKUserScript(
                    source: handoff,
                    injectionTime: .atDocumentStart,
                    forMainFrameOnly: true
                )
            )
        }
        controller.add(context.coordinator, name: LiveFacePage.hostChannel)

        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.bounces = false
        webView.scrollView.isScrollEnabled = false

        webView.load(URLRequest(url: pageURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onState = onState
    }

    /// **Rule 2, on this side of the seam.** The screen going away must leave the room,
    /// not merely stop showing it.
    ///
    /// Two triggers, deliberately, because they fail in different ways: the explicit
    /// `sylFaceLeave()` is immediate but asynchronous, and the `about:blank` navigation
    /// destroys the document, which fires the page's own `pagehide` handler. Neither is
    /// allowed to be the only one.
    ///
    /// The script message handler is removed as well — a `WKUserContentController` holds
    /// its handler strongly, and a coordinator kept alive by a discarded web view is a
    /// retain cycle around a live session.
    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.evaluateJavaScript(LiveFacePage.leaveScript, completionHandler: nil)
        webView.stopLoading()
        webView.configuration.userContentController
            .removeScriptMessageHandler(forName: LiveFacePage.hostChannel)
        webView.uiDelegate = nil
        if let blank = URL(string: "about:blank") { webView.load(URLRequest(url: blank)) }

        // Give the route back. Leaving the app in `.playAndRecord` after the face is gone
        // would follow her out of the screen and into everything else it plays.
        FaceAudioSession.end()
    }

    /// The page's voice, and the microphone's gate.
    ///
    /// `@MainActor` because `WKUIDelegate` and `WKScriptMessageHandler` both are, and
    /// because everything it touches is a view.
    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler {
        var onState: @MainActor (String, String) -> Void

        init(onState: @escaping @MainActor (String, String) -> Void) {
            self.onState = onState
        }

        /// The microphone, and **only** the microphone.
        ///
        /// Split out from the delegate method so the rule can be asserted without a
        /// running web view — `WKSecurityOrigin` and `WKFrameInfo` have no public
        /// initialisers, so the delegate signature itself is not callable from a test.
        nonisolated static func decision(for type: WKMediaCaptureType) -> WKPermissionDecision {
            type == .microphone ? .grant : .deny
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == LiveFacePage.hostChannel else { return }
            let body = message.body as? [String: Any]
            receive(
                state: body?["state"] as? String ?? "",
                detail: body?["detail"] as? String ?? ""
            )
        }

        /// The testable core of the router, for the same reason: `WKScriptMessage` cannot
        /// be constructed outside WebKit.
        func receive(state: String, detail: String) {
            guard !state.isEmpty else { return }
            onState(state, detail)
        }
    }
}

/// The capture prompt, answered.
///
/// In an extension rather than on the class body because Swift warns — and this project
/// builds with `-warnings-as-errors` — that a member "nearly matching" an optional
/// protocol requirement is probably a typo. The signature below is the requirement
/// exactly, `@MainActor @Sendable` handler included; getting one attribute wrong makes
/// this a method nothing ever calls, and a capture prompt nothing answers is a
/// microphone that never turns on.
extension FaceWebPage.Coordinator: WKUIDelegate {
    /// He talks to her; he is not on camera. Granting the camera as well would mean a
    /// permission prompt for a capability this surface never uses, on a screen he reached
    /// by holding down her face. The page asks for no video track, so a camera request
    /// here means something has changed and the answer is no.
    ///
    /// This answers the WebKit-layer prompt. The OS-level permission is separate, and a
    /// denial surfaces in the page rather than as silence.
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
    ) {
        decisionHandler(FaceWebPage.Coordinator.decision(for: type))
    }
}

extension FaceRenderer {
    /// Draw her in a web view over the page Syl serves.
    ///
    /// The origin is a closure, not a value, for the same reason `SylBackend` re-reads
    /// its base URL on every access: a server-profile change must move this too, and a
    /// URL captured when the home screen was built is the previous server's.
    ///
    /// ``FaceRenderer/canDraw`` is false when there is no usable origin — a renderer that
    /// cannot resolve where the page lives says so, rather than presenting a web view
    /// that will fail to load over a session that is already billing.
    ///
    /// **There is no `onState` parameter and there must not be one.** It used to be a
    /// defaulted argument, `AppDelegate` built this renderer without it, and so every
    /// word the page said about itself — `connected`, `playing`, `sdk_failed`, the entire
    /// closed vocabulary in `face/client-report.ts` — arrived at an empty closure. The
    /// page was reporting perfectly and the phone was deaf, which is why the surface had
    /// nothing better than a spinner to show. The sink is now an argument of
    /// ``FaceRenderer/view``, supplied by whoever is drawing, so it cannot be defaulted
    /// away at a call site that has nothing to report to.
    static func web(origin: @escaping @Sendable () -> URL?) -> FaceRenderer {
        FaceRenderer(
            canDraw: { session in
                !session.sessionKey.isEmpty && origin() != nil
            },
            view: { session, onState in
                guard let pageURL = origin().flatMap({ LiveFacePage.url(apiBaseURL: $0) }) else {
                    // Unreachable while `canDraw` gates it, and still not a spinner: a
                    // renderer that cannot say where she is must say so.
                    return AnyView(FaceRenderer.unreachablePage)
                }
                return AnyView(
                    FaceWebPage(session: session, pageURL: pageURL, onState: onState)
                        .ignoresSafeArea()
                )
            }
        )
    }

    /// There is no origin to draw from. Words, not a spinner.
    private static var unreachablePage: some View {
        VStack(spacing: SylTheme.Metric.step) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 34, weight: .ultraLight))
                .foregroundStyle(SylTheme.Colour.inkFaint)
            Text("I cannot work out where to draw myself from")
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}
