import UIKit
import WebKit
import XCTest

@testable import Syl

/// **Does hiding her stop her arriving?** (`syl-chzl.7.7`)
///
/// ## The question, and why it had to be measured
///
/// `HomeScreen.faceLayer` puts a live `WKWebView` into the window and then draws the home
/// screen on top of it, so the page can import an SDK and join a room while he carries on
/// reading his day. Presenting her is a change of `zIndex` — the layer is full size,
/// `alpha` 1, in the window, and simply *behind* something opaque.
///
/// That rests on a claim about WebKit that nobody had checked: **an occluded web view is
/// still a live web view.** If it were not — if WebKit throttled the page's timers or
/// suspended its media because something was drawn over it — then the mechanism that hides
/// her until she is ready would be the very thing stopping her becoming ready, and the
/// feature would be deadlocked on itself. That would explain the whole symptom: a page
/// that reports `camera_blocked` at two seconds and then never speaks again.
///
/// **It is not the cause.** Measured on the iOS 26.2 simulator, Xcode 26.3, and the
/// numbers are in the assertions below. An occluded page runs at full speed. So does one
/// with `isHidden = true`, one at `alpha = 0`, and one in a hidden window.
///
/// The one thing that does stop it dead is **leaving the window** — see
/// ``testShouldStopThePageDeadWhenItLeavesTheWindow``, which is both this file's control
/// and a real requirement, because SwiftUI removing the layer from the tree is exactly
/// that. `LiveFaceModel.needsSurface` is what keeps it in.
///
/// ## How the probe works
///
/// A page that reports on itself in the three ways WebKit could betray it:
///
/// 1. `document.visibilityState` — the Page Visibility API, driven by WebKit's own idea
///    of whether the view is visible.
/// 2. A `setTimeout` chain and a `requestAnimationFrame` loop — the two clocks a throttled
///    page loses.
/// 3. A `<video>` playing a `MediaStream` from `canvas.captureStream()` — the same shape
///    as a LiveKit track (a live stream in a media element, autoplaying inline) with no
///    network, no codec and no provider in the way.
///
/// ## Where this does and does not reach
///
/// It covers a foreground app on a simulator runtime, which is the case the design
/// depends on. It says nothing about a **backgrounded** app — WebKit suspends everything
/// then, and `LiveFaceModel.scenePhaseChanged(to:)` closes the session rather than
/// relying on it — and nothing about a device under memory pressure killing the web
/// content process. Both of those are loud failures; the one this file exists to rule out
/// was the silent one.
@MainActor
final class OccludedWebViewTests: XCTestCase {
    /// How the web view sits in the window for one run of the probe.
    private enum Placement {
        /// Nothing over it. The baseline everything else is read against.
        case exposed
        /// Full-size, opaque, drawn on top of it — what `zIndex(-1)` produces.
        case occluded
        /// `isHidden = true`.
        case hidden
        /// `alpha = 0` — the first frame of any cross-fade.
        case transparent
        /// The whole window is hidden.
        case windowHidden
        /// Not in a window at all. **The control**: WebKit really does stop this one.
        case detached
    }

    /// What the page managed to do while it was placed like that.
    private struct Reading {
        var visibility: String
        var timeouts: Int
        var frames: Int
        var playing: Bool
        var currentTime: Double
        var error: String
    }

    /// The page, which does nothing but describe its own liveness.
    ///
    /// `muted` is deliberately absent. The real page carries audio and relies on
    /// ``FaceWebPage``'s `mediaTypesRequiringUserActionForPlayback = []`, so the probe
    /// configures its web view the same way rather than buying itself an easier autoplay
    /// than the thing it stands in for.
    private static let probe = """
        <!doctype html>
        <html><body style="margin:0;background:#000">
        <video id="v" autoplay playsinline style="width:100%;height:100%"></video>
        <script>
        window.__timeouts = 0; window.__frames = 0; window.__playing = false; window.__error = "";
        (function beat() { window.__timeouts++; setTimeout(beat, 16); })();
        (function paint() { window.__frames++; requestAnimationFrame(paint); })();
        try {
          var canvas = document.createElement("canvas");
          canvas.width = 64; canvas.height = 64;
          var ink = canvas.getContext("2d");
          var n = 0;
          setInterval(function () {
            n++; ink.fillStyle = n % 2 ? "#fff" : "#123"; ink.fillRect(0, 0, 64, 64);
          }, 16);
          var video = document.getElementById("v");
          video.srcObject = canvas.captureStream(30);
          video.addEventListener("playing", function () { window.__playing = true; });
          var started = video.play();
          if (started) { started.catch(function (e) { window.__error = String(e); }); }
        } catch (e) { window.__error = String(e); }
        </script>
        </body></html>
        """

    // MARK: - The finding

    /// **An occluded web view is a live web view.** The assertion the whole
    /// warm-behind-the-home-screen design rests on, and it holds.
    ///
    /// Observed: an occluded page reached `playing`, advanced `currentTime` past a quarter
    /// of a second, and ran its `requestAnimationFrame` loop within a frame or two of an
    /// exposed one. If this ever goes red, `HomeScreen.faceLayer` IS the silence and the
    /// fix is to stop hiding her, not to add another fallback on top.
    func testShouldKeepThePageFullyAliveBehindAnOpaqueScreen() async throws {
        let exposed = try await read(.exposed)
        let occluded = try await read(.occluded)

        XCTAssertEqual(
            occluded.visibility, "visible",
            "WebKit must still consider a merely-covered page visible; if it does not, "
                + "warming her behind the home screen cannot work at all")
        XCTAssertGreaterThan(
            occluded.timeouts, 1,
            "a throttled page loses setTimeout, and the page Syl serves waits on it")
        XCTAssertGreaterThan(
            occluded.frames, 1,
            "requestAnimationFrame is the other clock a suspended page loses")
        XCTAssertTrue(
            occluded.playing,
            "a media element behind an opaque layer must still reach `playing` — that "
                + "event IS the signal the whole surface waits for. Error: \(occluded.error)")
        XCTAssertGreaterThan(
            occluded.currentTime, 0,
            "and the frames must actually advance, not merely be promised")

        // Read against the exposed case rather than against a number: a simulator under
        // fleet load is slow at everything, and an absolute threshold would be measuring
        // the machine rather than WebKit's opinion of the layer.
        XCTAssertGreaterThan(
            Double(occluded.frames), Double(exposed.frames) * 0.25,
            "an occluded page must not be running at a fraction of an exposed one")
    }

    /// **The control, and the thing that actually kills a page: leaving the window.**
    ///
    /// Without this the good news above is unfalsifiable — a probe that reports "fine" for
    /// every placement it is given is a probe measuring nothing. Detaching the view is a
    /// state WebKit unambiguously treats as invisible, and the probe sees it: the
    /// animation loop stops at its first frame, `play()` rejects with `AbortError`, and
    /// `document.visibilityState` finally says `hidden`.
    ///
    /// It is also a requirement in its own right. SwiftUI dropping the layer out of the
    /// view tree is precisely this, so a `needsSurface` that ever went false mid-warm-up
    /// would not hide her — it would kill the page over a session that is still billing.
    func testShouldStopThePageDeadWhenItLeavesTheWindow() async throws {
        let detached = try await read(.detached)

        XCTAssertEqual(
            detached.visibility, "hidden",
            "a view with no window is the one placement WebKit calls hidden")
        XCTAssertFalse(
            detached.playing, "and nothing plays in it, which is what makes this a control")
        XCTAssertLessThan(
            detached.frames, 3,
            "requestAnimationFrame stops at the first frame, so the probe can see a "
                + "stopped page when there is one to see")
    }

    /// **Every view-level way of hiding it is irrelevant to WebKit**, which is worth
    /// writing down because the obvious next edit is to argue about which one to use.
    ///
    /// `HomeScreen` hides her with `zIndex` and used to justify that by saying `opacity(0)`
    /// and `.hidden()` would get the page throttled. They do not: measured here, a hidden
    /// view, a fully transparent view and a hidden *window* all run the page at full speed
    /// and all still report `visible`. iOS derives page visibility from window membership
    /// and application state, not from whether anything can actually see the pixels.
    ///
    /// So `zIndex` is kept because it is the clearest expression of the intent, not
    /// because it is load-bearing — and a cross-fade, which the same comment ruled out for
    /// fear of a zero-opacity frame, would in fact be safe.
    func testShouldNotThrottleForAnyViewLevelHiding() async throws {
        for placement in [Placement.hidden, .transparent, .windowHidden] {
            let reading = try await read(placement)

            XCTAssertEqual(
                reading.visibility, "visible",
                "\(placement): iOS does not read view-level hiding as page invisibility")
            XCTAssertTrue(
                reading.playing,
                "\(placement): media still plays. Error: \(reading.error)")
            XCTAssertGreaterThan(reading.frames, 1, "\(placement): the page still animates")
        }
    }

    // MARK: - Running the probe

    /// Load the page under one placement, let it run, and read what it managed.
    ///
    /// The wait is a poll rather than a fixed sleep: the live cases settle in a few hundred
    /// milliseconds and a loaded simulator can take seconds, so it waits for `playing` and
    /// then reads. The detached case never reaches it — that is the point — so it gets a
    /// bounded wait and is read anyway.
    private func read(_ placement: Placement) async throws -> Reading {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let webView = WKWebView(frame: window.bounds, configuration: configuration)
        window.addSubview(webView)

        switch placement {
        case .exposed:
            break
        case .occluded:
            // Added AFTER, so it is later in the sibling order and paints over the whole
            // of it — the same arrangement `zIndex(-1)` produces in SwiftUI.
            let lid = UIView(frame: window.bounds)
            lid.backgroundColor = .black
            lid.isOpaque = true
            window.addSubview(lid)
        case .hidden:
            webView.isHidden = true
        case .transparent:
            webView.alpha = 0
        case .windowHidden:
            window.isHidden = true
        case .detached:
            webView.removeFromSuperview()
        }

        webView.loadHTMLString(OccludedWebViewTests.probe, baseURL: nil)

        // Up to five seconds, checked twenty times a second. A fixed sleep long enough for
        // a loaded simulator would make every case in this file take that long.
        for _ in 0..<100 {
            try? await Task.sleep(for: .milliseconds(50))
            if (try? await flag(webView, "window.__playing")) == true { break }
        }
        // A beat past `playing`, so `currentTime` has somewhere to have moved to.
        try? await Task.sleep(for: .milliseconds(250))

        let reading = Reading(
            visibility: (try? await text(webView, "document.visibilityState")) ?? "",
            timeouts: (try? await number(webView, "window.__timeouts")) ?? -1,
            frames: (try? await number(webView, "window.__frames")) ?? -1,
            playing: (try? await flag(webView, "window.__playing")) ?? false,
            currentTime: (try? await double(webView, "document.getElementById('v').currentTime"))
                ?? -1,
            error: (try? await text(webView, "window.__error")) ?? ""
        )

        webView.removeFromSuperview()
        return reading
    }

    private func evaluate(_ webView: WKWebView, _ script: String) async throws -> Any? {
        try await webView.evaluateJavaScript(script)
    }

    private func text(_ webView: WKWebView, _ script: String) async throws -> String {
        (try await evaluate(webView, script)) as? String ?? ""
    }

    private func number(_ webView: WKWebView, _ script: String) async throws -> Int {
        (try await evaluate(webView, script)) as? Int ?? 0
    }

    private func double(_ webView: WKWebView, _ script: String) async throws -> Double {
        ((try await evaluate(webView, script)) as? NSNumber)?.doubleValue ?? 0
    }

    private func flag(_ webView: WKWebView, _ script: String) async throws -> Bool {
        (try await evaluate(webView, script)) as? Bool ?? false
    }
}
